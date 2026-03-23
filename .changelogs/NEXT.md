# Unreleased Changes

## Added

- News Sentinel — RSS feed monitor for market-moving events (Fed decisions, geopolitical, tariffs, etc.) with keyword pre-filter, optional AI classification, Telegram alerts, Socket.IO real-time updates, and full dashboard UI at `/sentinel`
- Inline capital adjustment UI — click "Available" in APY panel to edit deposited & max capital directly from dashboard
- Express wildcard routes updated to named `*splat` syntax for Express v5 compatibility

- Signal annotations (BUY/SELL/NTZ markers) now display on all UpDown timeframe charts, not just the 5m chart
- Signal history seeded from backend on page load — annotations survive refresh
- Signal deduplication — history only records directional transitions (BUY→SELL, SELL→NTZ, etc.), not repeated same-type signals or NEUTRAL noise

- UpDown signal backtest script (`scripts/backtest-updown.js`) — replays 1m BTC candles through signal engine to evaluate BUY/SELL accuracy for Up options day trading; outputs trade log, summary stats, equity curve, and score distribution diagnostics
- Weekly (1w) candle timeframe — derived from 1d candles, served via API, rendered as full-width macro chart banner on UpDown dashboard
- OBV (On-Balance Volume) indicator — volume-confirmed trend direction scoring at 13% weight
- ADX (Average Directional Index) indicator — Wilder's method with +DI/-DI, trend/range regime classification
- Weekly macro trend filter — EMA(4)/EMA(8) on 1w candles with 60% counter-weekly dampening
- ADX regime modulation — +15% composite boost in trending markets, -20% in ranging markets
- Tick momentum confirmation — aligned tick momentum boosts composite score up to +25%, contradicting reduces up to -15%
- UpDown signal history now includes NEUTRAL entries — shows actual BUY→NEUTRAL→BUY pattern instead of hiding the gaps

## Changed

- Indicator weights rebalanced for trend-following dominance (61%): MACD 0.24, OBV 0.20, Momentum 0.17; mean-reversion reduced: RSI 0.12, Stochastic 0.10, Bollinger 0.08
- Signal thresholds lowered — neutral 25→15, strong 45→30, with proportional vol-scaling adjustments
- Soft ceiling raised from 35 to 50 — full linear scoring range before compression
- All dampening multipliers softened — trend filter 0.40→0.65→0.80, weekly 0.40→0.70→0.85, confluence 0.75→0.85, ADX ranging 0.80→0.90→1.0 (neutral), pivots R2/S2 0.50→0.70, R1/S1 0.70→0.85, ToD bounds narrowed to [0.90,1.10]
- Trend + weekly dampeners no longer stack multiplicatively — applies only the stronger dampener when both are counter-signal, preventing 0.455x crush that made BUY signals unreachable in bearish trends

- `npm start` now deletes and restarts all PM2 processes then saves, replacing the old direct `node server.js` invocation
- `npm start` now kills stale processes on app ports (LISTEN only) before starting PM2, preventing EADDRINUSE errors
- 1W chart default range expanded from 8W to 1Y (52 weeks) with range options 12W / 26W / 1Y
- 1d candle history expanded from 60 days to 365 days; Coinbase API fetch now paginates to handle 300-candle limit
- 1d ring buffer increased to 365 candles, 1w ring buffer increased to 52 candles
- Short timeframes (1m, 3m, 5m) now use neutral trend bias for indicator scoring — enables SELL signal generation during short-term reversals even when higher-timeframe trend is bullish
- Signal history debounced — 5-minute minimum between consecutive same-type entries to prevent threshold oscillation flooding

## Fixed

- `calculateCostBasis` now reads asset-generic field names (`buyQuantity`, `holdbackAsset`, `sellQuantity`) instead of BTC-specific ones — fixes cost basis display for CRO and other non-BTC DCA funds
- Overview position double-counting — `totalAssetQty` was summing body assets twice (`position.totalAsset` already equals body sum from `syncPositionState`)
- CRO `realizedAssetPnL` inflation — cumulative holdback counter inflated to 168K CRO when actual reserves were ~28K; added `reconcileAssetReserves` cap that queries exchange balance on startup, every 5min save, and after sells; auto-recalc no longer overwrites corrected values with inflated fill-ledger totals
- Crypto.com partial TP fill handling — body TP orders that partially fill are now detected, body state reduced proportionally, and a new TP placed for the remaining position; previously partial fills were silently ignored because the polling only checked for 100% filled orders
- Crypto.com `getOpenOrders` now returns `size`, `originalSize`, and `price` fields, and correctly reports `PARTIALLY_FILLED` status — fixes orphan detection for partially-filled sell orders
- Legacy `take_profit` orders now normalize to `body_tp` when a celestial body owns the order — fixes "TP" type badge showing instead of the correct tier emoji
- Startup restore now uses `restoreBodyTpOrder` for legacy TPs owned by bodies, clearing stale `activeTpOrderId`
- Partial fill indicator ("PF" badge) on open sell orders — shows when an order has been partially filled on the exchange
- Realized P&L card now shows total liquid value (USD + asset at market price) as the primary number, with USD and asset breakdowns below (RegimeDashboard, Overview, and DCA Dashboard)
- Added missing `asteroid` and `nebula` tiers to open orders tier style map
- Capital adjustment UI now allows reducing available cash — clamps depositedCapital and maxUsdcDeployed to valid server ranges instead of sending out-of-range values
- Signal history now sorted newest-first — API results were displayed in arbitrary order
- Signal panel and banner show "CALCULATING..." loading state until live indicators arrive, preventing false BUY/SELL display from stale cached signals on page load
- NEUTRAL and NTZ (NO_TRADE_ZONE) annotations no longer render on price charts — only BUY/SELL markers shown
- NTZ entries filtered from signal history recording (backend + frontend seed + live tracking)
- Weekly macro chart now receives signal annotations (was the only chart missing them)
- Overview cards: CRO_USD stats (APY, Daily/Annual, Deposited/Max/Avail) now display when engine is running even without saved engineStartTime
- Crypto.com INVALID_ORDERQTY spam — validate order quantity meets exchange minimum before sending to API
- Crypto.com sub-minimum $0.05 orders — remaining budget "last order" logic now requires budget >= minOrderSize
- Crypto.com cash balance showing $0 in UI — exchange status endpoint now extracts quote currency from productId instead of hardcoding USDC
- Expired contract no longer triggers permanent NO_TRADE_ZONE — past-expiry contracts treated as no-contract
- ADX weight drift bug — removed mutating weight shift block that decayed MACD/momentum weights exponentially over cycles
- UpDown SignalBanner crash (`Cannot read properties of null`) when live indicators haven't loaded yet — null-guarded `type.replace()` call
- TP sell POST_ONLY_REJ — retries as taker order when take-profit price is already below current bid
- Capital adjustment no longer capped at $100K — removed upper bound on depositedCapital and maxUsdcDeployed
- Overview P&L calculations — unrealized P&L now includes celestial body positions; realized P&L separates USDC and asset components
- Regime engine reconciliation now preserves engineStartTime, initialCapital, originalCapital, and depositedCapital across position rebuilds
- Capital auto-adjust skipped when depositedCapital is explicitly provided in the same update
- RegimeDashboard P&L total now uses pnlMap (matches server globalRealizedPnL) instead of sell-group sum

## Removed

- Kalshi/hedge references from PLAN.md, docs, IPC modules, and shared utilities (post-removal cleanup)
- STRATEGY-GUIDE.md (Kalshi-specific, no longer applicable)
- Kalshi strategy config warning from CLAUDE.md
- "Live" WebSocket connection indicator from overview page
- Direction (Dir) column from UpDown trade history table — directional stats still shown in Up/Down win rate summary
- ADX dynamic weight shift — replaced by static trend-following-dominant weights (was compounding bug)
