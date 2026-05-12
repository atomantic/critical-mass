# P&L Calculation Architecture

This doc describes how realized and unrealized P&L are computed across the
system, what regressions we've hit, and the invariants that prevent them
from happening again. **Read this before changing anything that touches
`realizedPnL`, `realizedAssetPnL`, `closed-trades.json`, or
`fill-ledger.json`.**

## Single source of truth

```
position.realizedPnL       ← FIFO replay over fill-ledger.json
position.realizedAssetPnL  ← FIFO remainingAssetQty − Σ body.assetQty
```

Both are derived **only** from the fill ledger. The derivation is in
`src/fill-ledger.js:getDerivedRealizedPnL()`, invoked by
`src/regime-engine.js:refreshRealizedFromFifo()` on every state save and
status emit.

### Why FIFO

- **Deterministic**: same ledger → same numbers, every time.
- **Atomic**: a single function with no side effects.
- **Cycle-agnostic**: it doesn't matter which "cycle" a buy or sell is
  tagged with; FIFO consumes lots in arrival order regardless.
- **Body-consolidation safe**: bodies merging/splitting don't change
  the lot queue, so consolidation can't inflate or deflate the total.

### Methodology

For each sell in chronological order:
1. Consume buy lots from the front of the FIFO queue (oldest first).
2. Cost basis = Σ (consumed_qty × lot_unit_cost) including the consumed
   slice of the lot the sell partially exhausts.
3. Sell's realized contribution = `proceeds − cost_basis` (proceeds =
   `quoteAmount − netFee`).

`realizedPnL` = Σ all sells' contributions.
`realizedAssetPnL` = `Σ remaining_lot.qty − Σ active_body.assetQty`
(remainder of buys that haven't been consumed by sells, minus what's
currently allocated to an active body = "reserves" CRO/BTC).

## Subordinate display sources

These all exist for UI/audit purposes. They may briefly diverge from the
source-of-truth values — **that's expected**. Don't "fix" the source of
truth to match them.

| Source | What it is | When it diverges |
|---|---|---|
| `closed-trades.json` | Append-only audit log: one entry per sell, recorded at sell time using `body.avgPrice × qtySold` as cost basis | Body-prorated cost differs from FIFO unit cost when consolidation has run; per-sell pnl is a snapshot of "what the engine thought at sell time" |
| `closedTradesSummary.totalPnl` in API | Σ over `closed-trades.json` entries | Methodology gap above; also may be incomplete during recovery (see "Self-healing") |
| UI per-cycle PnL (sum of `g.sell.pnl`) | Buys grouped under sells via `buy.sellOrderId`, then `proceeds − Σ paired buy cost` | Can wildly diverge when sells span cycles (the canonical case: the black_hole TP draining 3 cycles' worth of buys) — a sell in cycle N may consume buys from cycle N-2. Per-cycle locality breaks |
| `body.avgPrice` | Weighted average of body's recorded buys | Drifts when bodies consolidate; only meaningful for the current snapshot |

**Display rule:** the dashboard shows `position.realizedPnL` as the
authoritative number. Per-cycle and per-sell numbers are presented for
detail, not totals.
(`admin/src/components/RegimeDashboard.jsx` Summary line at line ~2862.)

## What is NOT a source of truth

These all have memory entries documenting incidents — don't relearn them
the hard way.

- **Exchange balance** (`adapter.getAccountBalance()`): includes non-bot
  assets (personal holdings, other bots). Never derive bot metrics from
  it. See `feedback_exchange_balance_danger.md`.
- **State `totalAsset` as an accumulator**: it's a snapshot, sum of
  current body `assetQty`. Mutating it via `+=` during consolidation has
  caused the realizedAssetPnL inflation bug. See
  `project_realizedassetpnl_inflation.md`.
- **Closed-trades sum**: was used as `realizedPnL` source until a
  rectification cleared the file; engine then used a partial sum. Now
  always FIFO. The check `closedCount > 0 ? closedTrades.sum : fifo` is
  removed — `getDerivedRealizedPnL` is the only path.

## Self-healing properties

A correctly-built system survives operator interventions (clearing
files, rebuilding state, manual order placement) without P&L drift.

| Action | Self-heal? | Mechanism |
|---|---|---|
| Delete `closed-trades.json` | ✅ | `closedTrades.load()` returns false → `migrateFromFills()` rebuilds from ledger |
| Truncate to `[]` | ✅ | `load()` returns true but `migrateFromFills()` is **always** called now (gate removed); record() dedups |
| Clear ledger and rebuild from exchange truth | ✅ | `cryptocom-rectify-from-exchange.js` ingests exchange fills; FIFO re-derives realizedPnL on next engine refresh |
| Bodies removed/added | ✅ | FIFO doesn't care; `realizedAssetPnL` re-derives from `remainingAssetQty − bodyAssetSum` |
| WS drops fills | ❌ until ingested | This is the underlying data integrity problem. Rectification scripts pull from exchange API to fix |

## Regression catalog (lessons from incidents)

These all happened. If you're tempted to undo one of these fixes, read the
linked memory or commit first.

### R1: `realizedAssetPnL` cumulative inflation
- **Symptom**: reserves CRO grew to 66,534 when exchange held 38k total.
- **Cause**: body consolidation rolled holdback into a `+=` accumulator
  without deducting the recycled portion.
- **Fix**: derive `realizedAssetPnL` from FIFO (`remainingAssetQty −
  bodyAssetSum`), never from running totals.
- **Don't**: re-introduce any `position.realizedAssetPnL +=` pattern.

### R2: Auto-orphan startup recovery sold $242K of BTC
- **Symptom**: orphan-detection logic on startup created a body for "non-body
  assets" and placed an immediate-fill sell.
- **Cause**: "non-body asset" detection counted actively-managed BTC as
  orphaned.
- **Fix**: removed auto-recovery; engine only logs untracked positions
  now.
- **Don't**: re-introduce automatic order placement based on
  balance-vs-state diffs. Manual review + UI button only.

### R3: Closed-trades preferred over FIFO after clear
- **Symptom**: realizedPnL fell from $2,582 to $120.37 after a
  rectification cleared `closed-trades.json` to `[]`.
- **Cause**: `refreshRealizedFromFifo()` had `closedCount > 0 ?
  closedTrades.sum : fifo`. Once new sells got logged post-rectify, the
  partial closed-trades sum became preferred over FIFO.
- **Fix**: always use FIFO; closed-trades is audit-only.
  `migrateFromFills()` now runs unconditionally (idempotent dedup).
- **Don't**: re-introduce closed-trades as the realizedPnL source.

### R4: UI per-cycle PnL sum shown as totals
- **Symptom**: cycles 6–9 showed negative thousands after over-broad buy
  re-linking; the visible "total" diverged from FIFO.
- **Cause**: per-cycle PnL is a local approximation; in-cycle buys ↔
  sells don't reflect cross-cycle FIFO allocation.
- **Fix**: UI Summary row reads `position.realizedPnL` directly.
  Per-cycle PnL displays remain as informational rows.
- **Don't**: change the Summary calc to sum per-cycle PnL.

### R7: APY math and return-decomposition errors
- **Symptom**: coinbase showed `estimatedApy: 1397%` and `totalLiquidValuePercent: 117%`. CRO showed similarly inflated values.
- **Cause(s)**, all in `src/apy-calculator.js`:
  - Return percentages used `initialCapital` (= `config.maxUsdcDeployed`, the budget cap) as denominator instead of `depositedCapital` (actual user deposit). For coinbase, $157K budget vs $110K deposit = 30% understatement.
  - `totalLiquidValue = realizedPnL + reserves_value_at_current_price` double-counted: it treated the full market value of held BTC as "return" instead of subtracting the cost the bot paid for it. For coinbase, that single mistake added ~$200K of phantom return.
  - APY math compounded a linearly-extrapolated daily rate: `(1 + dailyPct)^365`. The right formula for "return r over y years" is `(1 + r)^(1/y) − 1`. The old form ballooned whenever a short measurement window had a high local rate.
- **Fix**: switch denominator to `depositedCapital`. Decompose into `realizedReturn` (FIFO USD profit), `unrealizedReturn` (held_qty × current_price − FIFO cost basis of held lots), `totalReturn = realized + unrealized`. Use time-weighted APY formula. Persist `heldAssetCostBasis` on `positionState` from `refreshRealizedFromFifo` so APY can correctly compute unrealized even when the engine is stopped (offline-status path re-derives FIFO from the ledger).
- **Don't**: re-introduce `totalLiquidValue = realizedPnL + assetValueUsd` as a return metric (it's still exposed as a legacy alias but is wrong by construction).

### R6: FIFO inflation from uncovered sells
- **Symptom**: coinbase `realizedAssetPnL` showed 2.486 BTC; correct value was 2.054 BTC. Inflation of exactly 0.432 BTC across the fund's lifetime.
- **Cause**: a 1 BTC manual sell on 2026-02-08 happened before bot ledger had 1 BTC of buys (only 0.568 BTC tracked at that moment). The old `computeFifoRealized()` silently:
  - Added full proceeds to `realizedPnL` (without cost basis for the uncovered portion)
  - Kept the lot queue intact (didn't reduce remaining qty)
- This happens any time a ledger contains manual orders, restored-from-recovery sells, or any sell timestamped before its matching buys.
- **Fix**: `computeFifoRealized()` now (a) derives `remainingAssetQty` from `totalBuyQty − totalSellQty` (simple subtraction, robust to chronology), (b) prorates each sell's `realizedPnL` contribution by the covered fraction. Also returns `uncoveredSellQty` for diagnostics.
- **Don't**: re-introduce `lots.reduce(...)` as the source for `remainingAssetQty`. The lot queue is for cost-basis tracking; quantity conservation needs a separate, simpler accumulator.

### R5: Synthetic DCA-convert buys double-counted
- **Symptom**: ledger net +515K CRO when exchange held 38K.
- **Cause**: DCA→regime migration emitted `dca-convert-*` synthetic
  buy fills representing pre-migration position, but the actual exchange
  fills that built that position were ALSO in the ledger.
- **Fix**: rectification rebuilds ledger purely from exchange truth;
  synthetics get dropped.
- **Don't**: insert synthetic position-snapshot fills into the ledger.
  Use a separate state field if you need a starting balance.

## Recovery playbook

When P&L looks wrong, work through these in order:

### Step 1: Compare authoritative numbers
```bash
# What the engine reports
curl -s 'http://localhost:5563/api/<exchange>/regime/status?pair=<PAIR>' \
  | jq '.status.position | {realizedPnL, realizedAssetPnL, totalAsset}'

# What FIFO over the ledger says (should match)
node -e '
const fl = require("./src/fill-ledger").createFillLedger("<exchange>","<PAIR>","<PAIR>");
console.log(fl.getDerivedRealizedPnL(/* bodyAssetSum from state */));'
```
If these disagree → bug in `refreshRealizedFromFifo` or state staleness.

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
re-derives all P&L via FIFO.

## Invariants — code review checklist

When reviewing changes that touch P&L code, verify:

1. **`position.realizedPnL` is set only from FIFO** (`getDerivedRealizedPnL()`).
   No other source. No `closedCount > 0` branching back to it.
2. **`position.realizedAssetPnL` has no `+=` mutations.** It's a derived
   value, reset every `refreshRealizedFromFifo()` call.
3. **Exchange balance is never used to compute bot metrics.** Only used
   for reality-check logging or by manual rectification scripts.
4. **`closed-trades.json` writes are append-only at sell time** (in
   `regime-engine.js:handleOrderFill`-style paths). It's an audit log,
   not a state mutator.
5. **`migrateFromFills()` is callable at every startup** (no
   `trades.length > 0` gate). Dedup happens in `record()`.
6. **UI summary totals don't sum per-cycle PnL**; they read
   `position.realizedPnL` directly.
7. **No synthetic fills in the ledger** (DCA-convert, consolidated,
   dry-run-buy were all sources of bugs). If you need a baseline, store
   it in regime-state, not as ledger entries.
8. **`remainingAssetQty` uses `totalBuys − totalSells`, not `lots.reduce(qty)`.**
   The lot queue is for cost-basis tracking only; quantity conservation
   needs a separate accumulator (R6).
9. **Return percentages use `depositedCapital` as denominator**, not
   `initialCapital`/`maxUsdcDeployed`/`currentCapital` (R7).
10. **`totalReturn = realizedReturn + unrealizedReturn`**, where
    `unrealizedReturn = held_qty × current_price − heldAssetCostBasis`.
    Never `realizedReturn + asset_market_value` (R7).
11. **APY uses time-weighted compounding**: `(1 + totalReturn)^(1/years) − 1`,
    not `(1 + daily_rate)^365` (R7).
