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
1. `pm2 stop critical-mass` (stop the engine first)
2. Run the repair script (`node scripts/repair-sell-linkage.js`)
3. `pm2 start critical-mass` (engine loads the repaired file)

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
