# Adaptive Entry Stale Timeout

## Problem

Reactive entry bids were cancelled on a single fixed timer (`orderStaleMs`),
regardless of how far below mid the bid rested. The engine deliberately varies
that distance — momentum-based offsets (`entryOffsetUpBps` / `entryOffsetDownBps`),
macro-regime multipliers, and aggressiveness presets (5–25 bps neutral offsets) —
but the timer never followed. The time price needs to reach a bid grows
roughly **quadratically** with its depth, so one timer cannot fit all offsets.

Measured on 30 days of Coinbase BTC-USDC 1-minute candles (June–July 2026,
median 1m true range ≈ 6 bps), probability that price touches a bid X bps
below the close within a window:

| Offset | ≤1m | ≤2m | ≤5m | ≤10m | ≤30m | ≤60m |
|---|---|---|---|---|---|---|
| 5 bps  | 28% | 41% | 58% | 69% | 82% | 87% |
| 12 bps | 6%  | 13% | 27% | 41% | 62% | 72% |
| 18 bps | 2%  | 6%  | 14% | 25% | 48% | 61% |
| 25 bps | 1%  | 2%  | 8%  | 15% | 35% | 49% |

Consequences of the fixed timer:

- **Momentum-down bids never worked.** A 15 bps down-offset bid (×1.2 in
  MARKUP → 18 bps) under a 120s timer had ~6–8% fill probability — ~92% of
  the "catch the falling price" bids were pulled before price could reach
  them, then re-anchored below the new mid. In a slow decline the bid chases
  the price down forever and never fills; only a fast crash outruns the timer.
- **TREND regime halved the timer** (0.5×) exactly when the down-offset bids
  are deepest, dropping fills to ~3%.
- **Presets scaled the offset but not the timer.** A pair on the `moderate`
  preset (18 bps) with the default `orderStaleMs: 30000` fills <3% of its
  resting windows — the engine is a cancel/replace loop that only fills on
  flash moves.

## Fix

`computeAdaptiveStaleMs(offsetBps, atr1m, price, config)` in
`src/volatility-utils.js`, applied per order at entry placement
(`regime-engine.js` → `placeEntryBid(…, entryStaleMs)`):

```
staleMs = clamp( 4min × (offsetBps / ATRbps)²,  orderStaleMs,  maxIntervalMs )
```

- **4min × (offset/ATR)²** — empirical touch-time scale: at median vol a bid
  ≈1×ATR deep reaches ~50–60% fill probability in ~4 minutes, and touch time
  scales quadratically with depth (validated 5→25 bps on the table above).
- **Floor `orderStaleMs`** — the operator's configured repricing cadence.
  High volatility (large ATR) shortens the computed window toward the floor,
  never below it.
- **Cap `maxIntervalMs`** — a resting entry blocks new reactive entries
  (pending-entry guard in `evaluateEntry`), so a longer window would starve
  the buy cadence the preset promises.
- **No regime multiplier on top.** The old HARVEST/CAUTION/TREND multiplier
  (1.0/0.7/0.5×) still applies to orders placed *without* a per-order timeout
  (recovered/restored orders), but not to adaptive ones: regime speed is
  already encoded in the ATR term, and applying both would re-shorten exactly
  the deep bids the fix is meant to protect.
- If ATR/price are unavailable (startup), falls back to `orderStaleMs`
  (previous behavior).

Both executors honor the per-order value: the live executor's `setTimeout`
path and `refreshStaleOrders` sweep (`order.staleMs ?? effectiveStaleMs`), and
the dry-run executor's `checkEntryFills` / `refreshStaleOrders`, so backtests
and dry-run match live behavior.

## Preset changes

`DEFAULT_AGGRESSIVENESS_PRESETS` now pin all three offsets plus the stale
floor per level (previously every level inherited the global 5/15 momentum
offsets, so a conservative fund with up-momentum bid *tighter* than its own
neutral offset — 5 bps vs 25 bps — inverting the intent):

| Level | neutral | up (0.5×) | down (1.5×) | orderStaleMs floor |
|---|---|---|---|---|
| conservative | 25 | 13 | 38 | 300000 |
| moderate     | 18 | 9  | 27 | 180000 |
| aggressive   | 12 | 6  | 18 | 120000 |
| maximum      | 5  | 3  | 8  | 60000  |

Presets are stamped into the pair's regime config when selected on the
dashboard — existing pairs keep their current values until a preset is
re-applied.

## Example (BTC-USDC, `maximum`, ATR ≈ 6 bps)

| Situation | offset | old timeout | adaptive timeout | fill prob (old → new) |
|---|---|---|---|---|
| neutral / up momentum | 6 bps | 120s | ~4min | 41% → ~52% |
| momentum down (×1.2 macro) | 18 bps | 120s (60s in TREND) | 10min (capped) | 6–8% → ~25% |
