# Fill Ledger: Buy→Sell Linkage

## Overview

The fill ledger tracks all buy and sell fills from the exchange. Each buy fill can be annotated with a `sellOrderId` that links it to the sell order that eventually sold those BTC. This linkage powers the admin dashboard's "filled sells" view, which shows each sell grouped with its source buys.

## How Linkage Works

```
Buy fill (orderId: "abc123")
  → annotated with { sellOrderId: "xyz789" }
  → Dashboard groups this buy under sell "xyz789"
```

### Annotation Fields

| Field | Purpose |
|---|---|
| `sellOrderId` | Links buy to its sell order (set on buy fills) |
| `bodyId` | Links fill to its celestial body (set on both buy and sell fills) |
| `bodyTier` | Celestial tier (satellite, moon, planet, etc.) |
| `isSatellite` | Marks fill as belonging to celestial body system |
| `satelliteAvgPrice` | Source buy's avg price (set on sell fills for matching) |
| `satelliteBtcQty` | Source buy's total BTC (set on sell fills for matching) |

### Annotation Code Paths

1. **Body TP placement** (`regime-engine.js:placeBodyTp`) — When a body's TP order is placed, all source buy fills get `sellOrderId` set to the new TP orderId
2. **Body TP fill** (`regime-engine.js:handleOrderFill` sell path) — When a body's TP fills, source buys get linked to the fill orderId
3. **Retroactive annotation** (`regime-engine.js:startReconciliation`) — On startup, iterates all celestial bodies and annotates their buy fills
4. **Core TP placement** (`regime-engine.js:placeTakeProfitOrder`) — Non-satellite buys get linked to the core TP orderId
5. **Offline fill detection** (`regime-engine.js:recoverFromFills`) — Bodies that filled while bot was offline get annotated
6. **New body creation** (`regime-engine.js:handleOrderFill` buy path) — New buy fills get `bodyId` when their body is created

## Incident: Stale sellOrderId Mismapping (2025-06-10)

### What Happened

14 satellite sells in cycle `cycle-1770195737025-k9ae9wd2v` had incorrect buy→sell linkage:
- **5 mismapped**: Buy's `sellOrderId` pointed to wrong sell
- **3 unmapped**: Buy had no `sellOrderId` at all
- **12 orphaned**: Buys pointed to stale legacy TP `3b5737ff` (already filled, not a real sell)
- **2 pre-existing wrong links**: Buys linked to sells they didn't belong to

### Root Causes

#### 1. `sourceOrderIds: ['core-migration']` doesn't match real fills

When the celestial body system was introduced, existing position buys were migrated into a body with `sourceOrderIds: ['core-migration']`. The annotation code iterated `sourceOrderIds` to find buy fills:

```javascript
for (const srcId of (body.sourceOrderIds || [])) {
  fillLedger.annotateFillsByOrderId(srcId, { sellOrderId: result.orderId });
}
```

Since no fill has `orderId: 'core-migration'`, this matched nothing. All the real buy fills retained their old stale `sellOrderId`.

**Fix**: Also iterate `body.buyOrders` (which contains real exchange orderIds) when annotating. Applied in `placeBodyTp`, body TP fill handler, retroactive annotation, and offline fill detection.

#### 2. Core TP path steals satellite buys

When the core TP order is placed/updated, it annotates ALL non-satellite buys:

```javascript
// Before fix:
if (fill.side === 'buy' && !fill.isSatellite) {
  fillLedger.annotateFillsByOrderId(fill.orderId, { sellOrderId: result.orderId });
}
```

Buys that belong to celestial bodies but haven't been marked `isSatellite` yet get incorrectly claimed by the core TP. This happened when a buy filled and was processed before the body annotation code ran.

**Fix**: Also check `!fill.bodyId` — buys with a `bodyId` belong to a celestial body and should not be claimed by the core TP.

#### 3. TP re-placement creates stale references

When a body's TP order is cancelled and re-placed (e.g., on merge or reprice), the new TP gets a new orderId. If the annotation for the new orderId fails (root cause 1), the buys retain their old `sellOrderId` pointing to the cancelled TP. This TP orderId may later be reused or become an orphan reference.

**Fix**: Root cause 1 fix ensures annotations succeed. The `annotateFillsByOrderId` function uses `Object.assign`, so successful annotation overwrites the stale `sellOrderId`.

### Repair Script

One-time repair script: `scripts/repair-sell-linkage.js`

Strategy:
1. **Price matching**: Each satellite sell has `satelliteAvgPrice` recording the source buy's exact price. Match sells to buys by price (single-buy satellites have exact price match).
2. **Multi-buy body matching**: For bodies with multiple buys (planet+ tier), find buys with stale `sellOrderId` that were placed before the sell, verify BTC sum matches `satelliteBtcQty`.
3. **Orphan cleanup**: Clear stale `sellOrderId` references pointing to non-existent sells.

### Data Repair Procedure

The engine holds the fill ledger in memory and persists it to disk on annotation changes. **Any external disk edits will be overwritten** by the engine's in-memory state.

To safely repair fill ledger data:
1. `pm2 stop critical-mass-coinbase` (stop the associated engine first; `pm2 stop critical-mass` only stops the API gateway, leaving the engine active to overwrite disk changes. Alternatively, `pm2 stop ecosystem.config.cjs` stops all processes)
2. Run the repair script (`node scripts/repair-sell-linkage.js` — for modern multi-pair funds, ensure the script targets `data/<exchange>/<pair>/fill-ledger.json`)
3. `pm2 start critical-mass-coinbase` (engine loads the repaired file; or `pm2 start ecosystem.config.cjs`)

The repair script also sets `isSatellite: true` on all repaired buys. This prevents the engine's core TP annotation path from reclaiming them on subsequent restarts.

### Prevention Checklist

When modifying annotation code, verify:

- [ ] `body.buyOrders` is iterated alongside `sourceOrderIds` (handles core-migration bodies)
- [ ] `'core-migration'` orderIds are skipped (they don't match real fills)
- [ ] Core TP annotation excludes `fill.isSatellite` AND `fill.bodyId` (doesn't steal body-owned buys)
- [ ] Body TP re-placement annotates with new orderId via both `sourceOrderIds` and `buyOrders`
- [ ] Offline fill detection also links source buys to the sell orderId
- [ ] `placeTakeProfitOrder` in celestial mode checks `ownedByBody` before cancelling `activeTpOrderId`
- [ ] Repair scripts always set `isSatellite: true` on affected buys as a defensive measure

## What `sellOrderId` is not (2026-09-20)

`sellOrderId` is a **crash-resilience breadcrumb, not a consumption record.** It is
stamped at TP *placement* over every fill of a buy order, and re-stamped whenever
bodies merge or a TP is cancelled and replaced. It carries no quantity: a buy order
that was only partly sold looks exactly like one that was fully sold.

Two defects followed from reading more into it than that, both found on
gemini/ETHUSD:

**1. Inventory that vanished from the position model.**
`computeRealizedFromCyclePairs` counts a buy as held open only when `sellOrderId` is
absent *or* names a sell with no fills (`fill-ledger.js`). Orders whose TP was sized
from only their first tranche — see the partial-fill leak below — therefore counted
as fully closed, and their unsold remainder left the model: in no body, no
take-profit, absent from the UI. 1.14 ETH sat in that state.

Making the rule quantity-aware does **not** fix it. Because the linkage is
re-stamped, `Σ(buys claiming sell X) − sold − holdback` reported 7.89 ETH against a
true 1.14. The only identity that cannot lie is

```
exchange balance == Σ body.assetQty + realizedAssetPnL (reserves)
```

`sweepLedgerDrift` asserts exactly that (`⚖️ Position coverage gap`), and
`scripts/adopt-untracked-asset.js` repairs a gap by folding the difference into a
body at a FIFO-derived cost basis. Do not re-derive inventory from `sellOrderId`.

**2. The partial-fill leak that created the gap.**
`handleOrderFill`'s buy branch dropped the order from
`positionState.pendingEntryOrders` on *any* fill, partial included. That list is the
only persisted mirror of order-executor's in-memory `pendingOrders` map, and Gemini
has no order-events WebSocket (`adapters/gemini/websocket.js` subscribes `l2` only),
so polling that map is the sole detector of an order completing. Losing the entry
orphaned the unfilled remainder permanently — 61 buy fills / 1.204 ETH between May
and September 2026. Both removals are now gated on `!fillData.isPartialFill`;
`tests/partial-entry-tracking.test.js` pins it.

## Per-buy consumption records (issue #607)

`sellOrderId` still links a buy to its sell for display and for the fallback
P&L of unannotated sells, but it no longer decides whether a buy is *closed*.
Every body sale — full TP fill, partial TP fill, merge-snapshot fill — now
records what it consumed from each buy order:

```
buy fill rows of order "abc123"
  → consumedBy: { "<sellOrderId>": 0.86, ... }   (base quantity per sell)
```

- **What counts as consumed:** sold quantity plus the holdback the sale books
  as reserves (`bodyHoldbackAsset`). A partial books no reserve and consumes
  only what sold. So for sells booked this way,
  `Σ buy size − Σ sell size == heldOpenAssetQty + realizedAssetPnL` holds by
  construction: the coverage identity from the ledger alone.
- **How it is attributed:** each `body.buyOrders` entry is a tranche with its
  own `consumedQty`. A sale is spread over the tranches in proportion to their
  open quantity, the same proration the body applies to its `costBasis`
  (`celestialHierarchy.planBodyConsumption`). A tranche folded in after an
  earlier sale starts at 0, so it never inherits that sale's consumption
  (issue #704). Merge snapshots copy `buyOrders`, so a Race-3 fold-in is not
  charged for a TP it was never part of.
- **Held open:** an order with a `consumedBy` record holds
  `size − Σ consumedBy` open, at `cost × open / size`. The unsold remainder of
  a partly-sold order — including ledger quantity no body ever attributed,
  like the 1.14 ETH above — stays in `heldOpenBuyCostBasis` /
  `heldOpenAssetQty` instead of vanishing.
- **Idempotent:** entries are keyed by sell order, so re-booking the same sell
  (crash replay) overwrites rather than double-consumes.
- **Full close:** a sale that closes the body consumes every tranche it
  covered in full, so an approximate legacy seed can never strand a sliver of
  a closed body open.
- **Legacy:** orders no sell has recorded against keep the boolean rule, and
  `consumedCostFraction` is now only stamped on those (composed per order,
  issue #704). The first record on an order seeds `__legacy__` with what
  earlier sales had already consumed (from `consumedCostFraction`). When a
  body holds quantity no tranche accounts for (an adopted body merged in,
  tranches from before `buyOrders` tracked quantities), that share of each
  sale is left unrecorded rather than loaded onto the other tranches, and the
  engine logs the tranche coverage.

`positionCoverage.ledger` on `getState()` reports the ledger-only reading of
the coverage identity (`unmodelled = net − inBodies − reserves`) and the open
buy inventory no body tracks (`untrackedOpen = heldOpen − inBodies`). The drift
sweep warns on the ledger gap (`⚖️ Ledger coverage gap`) when it cannot read
an account balance for the fund.
