## Bug Fixing
When fixing bugs, always verify you're editing the correct code path (e.g., derivatives vs trading funds, server vs client) before making changes. Ask for clarification if the affected module is ambiguous.

## Runtime State
**ALWAYS stop the associated engine (PM2) BEFORE modifying any state or data files** (e.g., `regime-state.json`, `fill-ledger.json`). Running engines periodically save state and will silently overwrite your changes. Sequence: stop engine → edit state → place any exchange orders → restart engine. For Gemini specifically, the API key requires heartbeat — orders placed without a running engine or heartbeat process will be auto-cancelled by Gemini within ~5 minutes.

## Financial Calculations
For P&L and APY calculations, always trace the full data flow from raw fills → aggregation → server calculation → client display. Verify denominator values (day counts, cost basis) are correct before fixing numerator/formatting issues.

## P&L model — read this before changing anything in fill-ledger.js, regime-engine.js, or RegimeDashboard's Filled Orders section

This engine flips buy orders profitably. The accounting unit is the **cycle**, structured as **buy(n) → sell(1)**: many buys accumulate, then one TP sell closes them. **Cycles are atomic** — a sell only consumes its own cycle's buys (the one cross-cycle exception is the operator-triggered "Collapse All" merge action). Do NOT model this as FIFO over the global ledger; the FIFO replay (`computeFifoRealized` in `fill-ledger.js`) is retained only for diagnostics.

**Holdback is the design, not a partial fill.** A body buys X asset, then the engine places a TP for `body.assetOnOrder = X − planned_holdback`. The TP fills 100% of `assetOnOrder` and the remainder (`body.assetQty − summary.totalSize`) is intentionally retained as asset-side profit. This is why `summary.totalSize === body.assetQty` is NEVER true on a healthy fill, and why `regime-engine.js:803-806` prorates cost basis: `proratedCostBasis = body.costBasis × (summary.totalSize / body.assetQty)`. The "partial fill" case worth guarding against is `summary.totalSize < body.assetOnOrder` (TP placed for X, exchange filled <X) — distinct from designed holdback.

**Source of truth (`refreshRealizedFromCyclePairs` in regime-engine.js)** is per-sell `bodyPnl`/`satellitePnl` annotations on the fill ledger, summed once per `orderId` (annotations are written to every partial-fill row of the same orderId — taking the value once, not summing across partials, is essential):
- `realizedPnL` = Σ per-sell `bodyPnl` (= sell proceeds − prorated cost)
- `realizedAssetPnL` = Σ per-sell `bodyHoldbackAsset` (zero-cost reserves)
- `heldOpenBuyCostBasis` = Σ cost over buys whose `sellOrderId` is absent **or has no sell fills in the ledger** (open positions in active bodies — `sellOrderId` is stamped at TP *placement* for crash-resilient linkage, so a stamp alone doesn't mean the buy closed)

**Total P&L display** = `realizedPnL` (USD) + `realizedAssetPnL × current_price` (reserves marked-to-market). Reserves are treated as zero-cost: their cost basis was attributed to the paired sell, and going forward they are pure profit-in-asset. The UI's per-cycle rows and the grand-total header are both derived from this same pairing, so they always agree.

**Don't:** re-introduce FIFO as the source of truth (it ignores cycle boundaries and over-counts), don't sum bodyPnl across an orderId's partial fill rows (it multiplies pnl by N), don't conflate `body.assetQty` with the planned TP size, and don't add `+=` accumulators on `positionState.realizedPnL`/`realizedAssetPnL` (R1 inflation bug — see `docs/pnl-architecture.md`).