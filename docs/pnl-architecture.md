# P&L Calculation Architecture

This doc describes how realized and unrealized P&L are computed, the
historical regressions we've hit, and the invariants that prevent them from
recurring. **Read this before changing anything that touches `realizedPnL`,
`realizedAssetPnL`, `closed-trades.json`, or `fill-ledger.json`.**

See `CLAUDE.md` for the short version. This doc is the long form.

## The model

The engine flips buy orders profitably. The accounting unit is the **cycle**:

```
buy(n) → sell(1)
```

Many buys accumulate inside a body; one TP sell closes them. **Cycles are
atomic** — a sell only consumes its own cycle's buys. The one designed
exception is the operator-triggered "Collapse All" merge, which deliberately
spans cycles.

### Holdback is intentional

A body buys `body.assetQty` of asset, then places a TP for
`body.assetOnOrder = body.assetQty − planned_holdback`. When the TP fills:

- `summary.totalSize` (filled qty) **equals `body.assetOnOrder`** on a
  healthy 100% fill — NEVER `body.assetQty`.
- The remainder, `body.assetQty − summary.totalSize`, is intentionally
  retained as asset-side profit (reserves).
- Cost basis attributed to this sell is prorated:
  `proratedCostBasis = body.costBasis × (summary.totalSize / body.assetQty)`.

The unattributed cost (the cost basis of the held-back portion) is
implicitly written off — reserves carry forward as zero-cost. This is the
design: the bot takes profit in BOTH dollars and asset.

The "partial fill" case worth defending against is
`summary.totalSize < body.assetOnOrder` (TP placed for X, exchange filled <X
before something interrupted) — distinct from designed holdback.

## Single source of truth

```
position.realizedPnL       ← Σ per-sell bodyPnl across the fill ledger
position.realizedAssetPnL  ← Σ per-sell bodyHoldbackAsset
position.heldAssetCostBasis ← Σ cost over buys with no sellOrderId
```

All three are derived in `src/fill-ledger.js:computeRealizedFromCyclePairs()`,
invoked by `src/regime-engine.js:refreshRealizedFromCyclePairs()` on every
state save and status emit. closed-trades.json is an audit log only.

### Why per-sell annotations

`bodyPnl` and `bodyHoldbackAsset` are written by the engine when a TP fills,
using the body's prorated cost basis at sell time. They reflect the engine's
own ledger of "what this cycle netted." Reading them back is a true cycle-pair
derivation.

**Crucial detail:** `annotateFillsByOrderId` writes the same metadata to
**every partial-fill row** of the same `orderId`. The cycle-pair derivation
takes ONE bodyPnl value per orderId — summing across partials would multiply
the pnl by N. See the dedup logic in `computeRealizedFromCyclePairs`.

### Total P&L display

```
total = realizedPnL + (realizedAssetPnL × current_price)
```

Realized USD profit + reserves marked-to-market. Reserves are zero-cost; their
full mark-to-market value is profit. The UI's per-cycle rows and the grand
total header are derived from the same pairing, so they always agree.

## Subordinate display sources

These exist for UI/audit purposes. They may briefly diverge from the
source-of-truth values — that's expected. Don't "fix" the source of truth
to match them.

| Source | What it is | When it diverges |
|---|---|---|
| `closed-trades.json` | Append-only audit log: one entry per closed body | Recorded at close time using body.costBasis snapshot; should match cycle-pair sum within rounding when data is clean |
| `closedTradesSummary.totalPnl` API field | Σ over closed-trades entries | May lag if recovery scripts inserted bodies but didn't backfill closed-trades |
| `body.avgPrice` | Weighted average of body's recorded buys | Drifts when bodies consolidate; only meaningful for the current snapshot |
| FIFO replay (`computeFifoRealized`) | Lot-consumption over the entire ledger by timestamp, ignoring cycle boundaries | RETAINED for diagnostics only. Disagrees with cycle pairing when sells span cycles or when a single body's TP retains designed holdback |

## What is NOT a source of truth

These all have memory entries documenting incidents — don't relearn the hard
way.

- **Exchange balance** (`adapter.getAccountBalance()`): includes non-bot
  assets. Never derive bot metrics from it. See
  `feedback_exchange_balance_danger.md`.
- **State `totalAsset` as an accumulator**: it's a snapshot, sum of current
  body `assetQty`. Mutating via `+=` during consolidation has caused the
  realizedAssetPnL inflation bug. See `project_realizedassetpnl_inflation.md`.
- **Closed-trades sum as `realizedPnL`**: was the source until rectification
  cleared the file; engine then used a partial sum. Now always cycle-pair.
- **FIFO replay**: ignores cycle boundaries; over-counts when designed
  holdback exists. Diagnostic only.

## Self-healing properties

A correctly-built system survives operator interventions (clearing files,
rebuilding state, manual orders) without P&L drift.

| Action | Self-heal? | Mechanism |
|---|---|---|
| Delete `closed-trades.json` | ✅ | `migrateFromFills()` rebuilds from ledger |
| Truncate to `[]` | ✅ | `migrateFromFills()` runs unconditionally; `record()` dedups |
| Clear ledger and rebuild from exchange truth | ✅ | Rectification ingests exchange fills; cycle-pair re-derives on next refresh |
| Bodies removed/added | ✅ | Cycle-pair derivation reads ledger annotations, not body state |
| WS drops fills | ❌ until ingested | Underlying data integrity problem; rectification scripts pull from exchange API |

## Regression catalog

These all happened. If you're tempted to undo one of these fixes, read the
linked memory or commit first.

### R1: `realizedAssetPnL` cumulative inflation
- **Symptom**: reserves CRO grew to 66,534 when exchange held 38k total.
- **Cause**: body consolidation rolled holdback into a `+=` accumulator
  without deducting the recycled portion.
- **Fix**: derive `realizedAssetPnL` from per-sell `bodyHoldbackAsset`
  annotations summed across the ledger. Never from running totals.
- **Don't**: re-introduce any `position.realizedAssetPnL +=` pattern.

### R2: Auto-orphan startup recovery sold $242K of BTC
- **Symptom**: orphan-detection logic on startup created a body for "non-body
  assets" and placed an immediate-fill sell.
- **Cause**: "non-body asset" detection counted actively-managed BTC as
  orphaned.
- **Fix**: removed auto-recovery; engine only logs untracked positions now.
- **Don't**: re-introduce automatic order placement based on
  balance-vs-state diffs. Manual review + UI button only.

### R3: Closed-trades preferred over derived realizedPnL after clear
- **Symptom**: realizedPnL fell from $2,582 to $120.37 after a rectification
  cleared `closed-trades.json` to `[]`.
- **Cause**: refresh logic had `closedCount > 0 ? closedTrades.sum : derived`.
  Once new sells got logged post-rectify, the partial closed-trades sum became
  preferred.
- **Fix**: always use the ledger-derived value; closed-trades is audit-only.
  `migrateFromFills()` runs unconditionally (idempotent dedup).
- **Don't**: re-introduce closed-trades as the realizedPnL source.

### R4 (SUPERSEDED): UI per-cycle PnL sum shown as totals
- **Original symptom**: cycles 6–9 showed negative thousands after over-broad
  buy re-linking; the visible "total" diverged from FIFO.
- **Original fix**: UI Summary read `position.realizedPnL` (FIFO) directly.
- **Why superseded**: the rationale was "sells span cycles; FIFO is the only
  honest answer." The engine actually enforces atomic cycles (verified
  2026-05-14: 99.8% atomicity across all live ledgers; the one cross-cycle
  case is the operator-triggered Collapse All). FIFO actively diverges from
  the cycle-pair sum because of designed holdback, so it's wrong as a
  summary.
- **Current rule**: UI summary sums per-cycle pnl. Engine summary derives
  the same way. They agree by construction.

### R5: Synthetic DCA-convert buys double-counted
- **Symptom**: ledger net +515K CRO when exchange held 38K.
- **Cause**: DCA→regime migration emitted `dca-convert-*` synthetic buy fills
  representing pre-migration position, but the actual exchange fills that
  built that position were ALSO in the ledger.
- **Fix**: rectification rebuilds ledger purely from exchange truth;
  synthetics get dropped.
- **Don't**: insert synthetic position-snapshot fills into the ledger. Use a
  separate state field if you need a starting balance.

### R6: FIFO inflation from uncovered sells (diagnostic-only after R4)
- **Symptom**: coinbase `realizedAssetPnL` showed 2.486 BTC; correct value
  was 2.054 BTC. Inflation of exactly 0.432 BTC.
- **Cause**: a 1 BTC manual sell on 2026-02-08 happened before bot ledger had
  1 BTC of buys. The old `computeFifoRealized()` silently added full
  proceeds without cost basis for the uncovered portion.
- **Fix**: `computeFifoRealized()` now derives `remainingAssetQty` from
  `totalBuyQty − totalSellQty` and prorates each sell's `realizedPnL`
  contribution by the covered fraction.
- **Note**: cycle-pair derivation is immune to this bug because it relies on
  the explicit `sellOrderId` linkage, not chronological ordering. R6 only
  matters for the diagnostic FIFO function.

### R7: APY math and return-decomposition errors
- **Symptom**: coinbase showed `estimatedApy: 1397%` and
  `totalLiquidValuePercent: 117%`.
- **Cause(s)**, all in `src/apy-calculator.js`:
  - Return percentages used `initialCapital` (= `config.maxUsdcDeployed`,
    the budget cap) as denominator instead of `depositedCapital` (actual
    user deposit).
  - `totalLiquidValue = realizedPnL + reserves_value_at_current_price`
    double-counted: it treated the full market value of held BTC as
    "return" instead of subtracting cost.
  - APY math compounded a linearly-extrapolated daily rate:
    `(1 + dailyPct)^365`. Right formula for "return r over y years" is
    `(1 + r)^(1/y) − 1`.
- **Fix**: switch denominator to `depositedCapital`. Decompose into
  `realizedReturn` (USD profit), `unrealizedReturn`
  (`held_qty × current_price − heldAssetCostBasis`), and
  `totalReturn = realized + unrealized`. Use time-weighted APY formula.
- **Don't**: re-introduce
  `totalLiquidValue = realizedPnL + assetValueUsd` as a return metric.

## Recovery playbook

When P&L looks wrong, work through these in order:

### Step 1: Compare authoritative numbers
```bash
# What the engine reports
curl -s 'http://localhost:5563/api/<exchange>/regime/status?pair=<PAIR>' \
  | jq '.status.position | {realizedPnL, realizedAssetPnL, totalAsset}'

# What cycle-pair derivation says (should match)
node -e '
const fl = require("./src/fill-ledger").createFillLedger("<exchange>","<PAIR>","<PAIR>");
console.log(fl.computeRealizedFromCyclePairs());'
```
If these disagree → bug in `refreshRealizedFromCyclePairs` or state staleness.

### Step 2: Check exchange truth
```bash
NODE_OPTIONS="--dns-result-order=ipv4first" node -e '
const a = require("./src/adapters/<exchange>/api").createAdapter();
a.getAccountBalance("<ASSET>").then(b => console.log(b));'
```
If `Σ active_body.assetQty + realizedAssetPnL ≠ exchange.total` → data
integrity issue, run rectification.

### Step 3: Pull exchange trade history and diff
```bash
NODE_OPTIONS="--dns-result-order=ipv4first" node scripts/fetch-cryptocom-trades.js
node scripts/diff-cryptocom-ledger.js
```
Reveals fills the engine missed via WS dropouts.

### Step 4: Rectify
```bash
pm2 stop critical-mass-<exchange>
node scripts/cryptocom-rectify-from-exchange.js          # dry-run
node scripts/cryptocom-rectify-from-exchange.js --apply
pm2 restart critical-mass-<exchange>
```
Rebuilds the ledger purely from exchange truth, drains drained bodies,
re-derives all P&L from cycle pairs.

## Invariants — code review checklist

When reviewing changes that touch P&L code, verify:

1. **`position.realizedPnL` is set only from `computeRealizedFromCyclePairs`**.
   No other source. No `closedCount > 0` branching back to it.
2. **`position.realizedAssetPnL` has no `+=` mutations.** It's a derived
   value, reset every refresh.
3. **bodyPnl/bodyHoldbackAsset are read ONCE per orderId**, not summed across
   partial-fill rows of the same order. Summing multiplies the value by N.
4. **Exchange balance is never used to compute bot metrics.** Only for
   reality-check logging or by rectification scripts.
5. **`closed-trades.json` writes are append-only at sell time** (in the
   `handleOrderFill` path). Audit log, not state mutator.
6. **`migrateFromFills()` is callable at every startup** (no `length > 0`
   gate). Dedup happens in `record()`.
7. **UI summary totals are summed from per-cycle pnl**, not sourced
   independently. Cycle rows and grand total agree by construction.
8. **No synthetic fills in the ledger** (DCA-convert, consolidated, dry-run-buy
   were all sources of bugs). Use a separate state field for baselines.
9. **Return percentages use `depositedCapital` as denominator**, not
   `initialCapital`/`maxUsdcDeployed`/`currentCapital`.
10. **`totalReturn = realizedReturn + unrealizedReturn`**, where
    `unrealizedReturn = held_qty × current_price − heldAssetCostBasis`.
    Never `realizedReturn + asset_market_value`.
11. **APY uses time-weighted compounding**: `(1 + totalReturn)^(1/years) − 1`,
    not `(1 + daily_rate)^365`.
12. **Don't conflate `body.assetQty` with the planned TP size.** The TP is
    placed for `body.assetOnOrder = body.assetQty − planned_holdback`. A
    healthy 100% fill has `summary.totalSize === body.assetOnOrder`, never
    equal to `body.assetQty`.
