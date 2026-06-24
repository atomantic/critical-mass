# Unreleased Changes

## README

- The dashboard screenshot now renders on GitHub. It had been silently excluded from the repo by a blanket `*.png` ignore rule, so the README showed a broken image.

## Added

- `fill-ledger.js:computeRealizedFromCyclePairs` — new source-of-truth derivation that walks the buy↔sell pairing in the ledger and sums per-cycle outcomes. Returns `{realizedPnL, realizedAssetPnL, heldOpenBuyCostBasis, unpairedSellQty}`. Replaces FIFO replay as the engine's source of truth; FIFO retained as a diagnostic.
- `CLAUDE.md` — added P&L model section codifying the buy(n)→sell(1) cycle contract, designed holdback (TP places `body.assetOnOrder = body.assetQty − planned_holdback`), source-of-truth derivation rules, and the don't-list (no FIFO, no `+=` on positionState, dedup `bodyPnl` per orderId, don't conflate `body.assetQty` with planned TP size).
- `docs/pnl-architecture.md` — full rewrite for the cycle-pair model. Single source of truth section now describes annotation-based derivation; R4 marked superseded; new invariants (12-item review checklist) including "dedup `bodyPnl` per orderId" and "don't conflate `body.assetQty` with planned TP size".
- Recovery scripts: `scripts/recover-coinbase-may-orphans.js` (recovers 2,166 verify-race orphan fills + creates a recovery body+TP) and `scripts/recover-gemini-ethusd-2026-05-14.js` (recovers 106 verify-race orphans, replaces dead TP, imputes cost basis on additional ETH via orphan-buy avg).
- `scripts/cryptocom-recover-may-2026-partials.js` — recovers Crypto.com CRO_USD partial-fill leak orphans by merging missing-fills.json into the existing celestial body, growing per-order buyOrders entries (or appending fully-orphan ones), and bumping position totals. Used 2026-05-17 to recover 32 fills (28,195 CRO / $2,189) leaked over May 12–15.
- `position.heldAssetCostBasis` — FIFO cost basis of currently-held BTC, persisted on regime-state and re-derived in offline-status paths. Enables accurate `unrealizedReturn = held_qty × current_price − heldAssetCostBasis` in APY metrics.
- APY return decomposition — `realizedReturn`, `unrealizedReturn`, `totalReturn` (+ matching percentages) split out from the old conflated `totalLiquidValue` field.
- `computeFifoRealized()` now returns `uncoveredSellQty` (diagnostic) and `remainingLotCost`/`remainingLotQty` (for unrealized cost basis).
- Exchange trade history fetchers: `scripts/fetch-coinbase-trades.js` and `scripts/fetch-cryptocom-trades.js` — paginated full-history pulls with cursor/time-window pagination.
- Cryptocom rectification toolkit: `cryptocom-rectify-from-exchange.js` (rebuild ledger + state from exchange truth), `diff-cryptocom-ledger.js`, `cryptocom-resolve-orphans.js` (FIFO-pair orphan buys/sells), `cryptocom-link-buys-to-sells.js`, `cryptocom-flag-orphan-sells.js`.
- Coinbase manual-order cleanup: `scripts/coinbase-remove-manual-1btc.js` — drops the 1 BTC manual triplet (1d90f021/ccbca736/d2147728) that wasn't bot-managed and was inflating FIFO reserves by 0.432 BTC.
- Earlier-session coinbase cleanup utilities now tracked: `scripts/remove-bad-sell-coinbase.js` (drops bad 1.0 BTC sell 7a3c8ef8 + unlinks its annotated buy 4ea191b2), `scripts/cleanup-coinbase-pollution-2.js` (relinks orphan buy 4ea191b2 to its rightful planet sell d62b63e2; deletes unattributed 1.0 BTC orphan sell ef8ad8de), `scripts/rebuild-coinbase-closed-trades.js` (rebuilds closed-trades.json from cleaned ledger via body-grouping + prorated-cost migration logic), `scripts/backfill-fifo-realized.js` (backfills positionState.realizedPnL/realizedAssetPnL across all funds' regime-state.json using FIFO replay).

- Fill sync API (`POST /api/:exchange/regime/sync-fills`) — fetches all trades from exchange, compares with local fill ledger, and ingests any missing fills; supports Gemini and Coinbase
- Sync Fills button on Open Orders card — always-visible UI control to trigger exchange-to-ledger reconciliation with result banner
- `adapter.getAllTrades(symbol, sinceTimestampMs)` method on Gemini adapter — paginated trade history fetch
- `skipPersist` option on `fillLedger.ingestFill()` — enables batch ingestion with a single disk write
- Gemini audit script (`scripts/audit-gemini-fills.js`) — compare Gemini exchange fills vs local ledger

- Unrealized P&L subtext on Overview — "paper value if sold now" label plus expected gain when active cycles close at target sell prices
- Docker containerization — multi-stage Dockerfile, docker-compose, PM2 entrypoint, multi-arch GitHub Actions build workflow
- Umbrel app packaging — app manifest, app_proxy docker-compose, exports.sh for Umbrel App Store submission
- Expected annual yield on Overview Estimated APY header — total liquid $/yr, USD breakdown, and per-asset quantity with USD equivalent
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
- Partial fill visibility on open orders — both Dashboard and Transactions views show filled amount for partially filled sell orders; status badge changes to orange "partial"
- Merge (roll-up) blocked for partially filled orders — server-side guard checks exchange order status before merging; UI hides roll-up button when source or target is partially filled
- Universal manual trade import — Import button on both BUY and SELL orders in unaccounted fills; import as orphan or pair with match
- Buy-first manual trade flow — import a manual buy with optional celestial body creation for TP management (`injectBody` on regime engine)
- Paired manual trade import — match a buy and sell order together with P&L linkage annotations in fill ledger
- Client-side match suggestions — scores opposite-side orders by size similarity, time proximity, price relationship, and spread
- Manual trade data model extended with `buy_recorded`, `tp_pending` statuses, `tradeType` field, `addManualBuy`, `addPairedTrade`, `markTpPlaced` methods
- Analysis scripts for identifying and importing unaccounted exchange fills (`scripts/analyze-unaccounted*.js`, `scripts/import-*.js`)

- Williams %R and CCI indicators added to the UpDown signal engine — overbought/oversold + mean-reversion scoring at 6% and 7% weights, with their own per-timeframe accumulator charts and live value cards on the dashboard
- Daily SMA(50/100/200) macro trend context — golden/death cross detection, price-vs-SMA200 distance, and bullish/bearish/neutral classification surfaced via a new SMA pill in the signal banner and dashed reference lines on the 1d price chart
- `mergeProximityScale` regime config (range 0.25–3.0) for tuning how aggressively celestial bodies merge; included in the four aggressiveness presets (conservative=0.5, moderate=1.0, aggressive=1.5, maximum=2.5) and exposed in the Config Editor
- `TrendBias` JSDoc typedef in `src/types.js` for the `'bullish'|'bearish'|'neutral'` union shared across the signal engine
- Single-source-of-truth indicator config (`src/updown/indicator-config.js`) — `INDICATORS`, `INDICATOR_WEIGHTS`, `INDICATOR_LABELS` consumed by signal-engine, scorecard, and the backfill replay script

## Changed

- **P&L source of truth switched from FIFO replay to cycle-pair derivation.** `position.realizedPnL` and `position.realizedAssetPnL` are now derived from per-sell `bodyPnl` / `bodyHoldbackAsset` annotations on the fill ledger, summed once per `orderId` (annotations are written to every partial-fill row of the same orderId — summing across partials would multiply pnl by N). The new `fill-ledger.js:computeRealizedFromCyclePairs` is invoked by `regime-engine.js:refreshRealizedFromCyclePairs` on every state save and status emit. FIFO replay (`computeFifoRealized`) is retained as a diagnostic only — it ignores cycle boundaries and over-counts when designed holdback exists. Cycles are atomic in this engine (verified 99.8% across all live ledgers); the one cross-cycle exception is the operator-triggered "Collapse All" merge. R4 in `docs/pnl-architecture.md` is marked superseded.
- Filled Orders summary header in `RegimeDashboard.jsx` now sums per-cycle pnl instead of reading `position.realizedPnL` independently — header and per-cycle rows agree by construction. Header also displays reserves valued at live price + grand total (USD profit + reserves × price).
- UI `pnlMap` construction now (a) takes `bodyPnl` annotation ONCE per orderId (was summing across N partial fills), and (b) trusts the annotation when present rather than recomputing from incomplete buy linkage. Mirrors the engine's cycle-pair derivation.
- `getDerivedRealizedPnL()` no longer takes an `activePositionAsset` parameter — reserves are now derived directly from per-sell holdback annotations, independent of current body state. All call sites updated (`regime-engine.js`, `engines/coinbase-engine.js`, both route files).
- `position.heldAssetCostBasis` semantics — now Σ cost over open buys (no `sellOrderId`); reserves are zero-cost in the cycle-pair model. APY's `unrealizedReturn` accounts for body assets only; reserves are valued mark-to-market.
- `reconcileIntervalMs` default lowered from 300000 (5min) to 60000 (1min) in `config-utils.js`, `config.json`, `config.example.json` for faster orphan detection.
- `position.realizedPnL` and `position.realizedAssetPnL` are now ALWAYS derived from the fill ledger via `getDerivedRealizedPnL()`. The old `closedCount > 0 ? closedTrades.getTotalPnL() : derived` branch is removed — closed-trades is an audit log only. This is the single-source-of-truth invariant from `docs/pnl-architecture.md` R3.
- `closedTrades.migrateFromFills()` runs unconditionally at engine startup (no `trades.length === 0` gate); idempotent via `record()` dedup. Self-heals when `closed-trades.json` is cleared to `[]` or partially-repopulated post-rectification.
- APY return percentages use `depositedCapital` as denominator (not `initialCapital`/`maxUsdcDeployed`). For coinbase that's $110K vs $157K — fixes a 30% under-statement of true return rate.
- APY uses time-weighted compounding `(1 + totalReturn)^(1/years) − 1`, not the old `(1 + dailyRate)^365` form which ballooned at any high local rate (coinbase APY 1397% → 134%, cryptocom 1397% → 38%).
- `totalReturn = realizedReturn + unrealizedReturn`, where unrealized is `held_qty × current_price − heldAssetCostBasis` (FIFO cost). Replaces the old `totalLiquidValue = realizedPnL + asset_market_value` which double-counted reserves' market value as return.
- DCA dashboard summary endpoint (`/api/:exchange/summary`) now reads from `regime-state.json` + `fill-ledger.json` instead of frozen DCA-era `state.json` (3+ months stale post-migration) and `transactions.tsv` (9 lines total). Maps regime fields onto the legacy DCA response shape so `Dashboard.jsx` keeps rendering unchanged.
- Stopped-engine regime status path (`buildOfflineStatus` + `coinbase-engine.js` IPC handler) re-derives FIFO from the ledger so dashboards show fresh numbers even when the regime engine isn't actively refreshing state.
- DCA→regime migration (`src/dca-converter.js`) no longer seeds `realizedPnL`/`realizedAssetPnL` from cycle recalc + assetReserves — let FIFO derive them from the migrated fills (aligns with `docs/pnl-architecture.md` invariants 1 & 2).
- RegimeDashboard "Reserves" line displays `position.realizedAssetPnL` (accumulated holdback) instead of `totalAsset − assetOnOrder` (in-body dust). Filled Orders summary reads `position.realizedPnL` instead of summing per-cycle PnL — cycle-local PnL diverges from FIFO when sells span cycles.

- All npm dependencies version-pinned (no `^` ranges) to prevent supply chain attacks from auto-upgrading
- `.npmrc` added with `ignore-scripts=true` to block postinstall/lifecycle scripts from dependencies by default
- Celestial visuals — removed tron-style wireframe/geometric rings from black hole, galaxy, and nebula; enhanced galaxy with denser spiral arms (3×800 particles), Gaussian spread, diffuse dust layer, and layered disc glows
- Black hole relativistic jets — bipolar cyan beams (core + halo cylinders) along the rotation axis with anti-phase pulse animation
- Galaxy per-vertex point sizes — custom ShaderMaterial activates previously-dead `sizes` buffer; core particles render ~3× larger than arm tips
- Sun solar flare rays — 8 individual animated plane-geometry rays (4 major orange + 4 minor yellow) replace the single wireframe ring; each ray flickers independently
- Hypergiant wireframe atmosphere shell opacity doubled (0.08→0.16) with wider pulse range
- Nebula point density increased 1,650→2,700 particles for fuller cloud coverage
- Systems page tier cards — colored top border per tier, range % shown as tier-colored badge, card canvas height increased (h-40→h-48)

- UpDown prediction accuracy improvements — direction threshold aligned to BUY signal threshold (10→15), per-window noise floors prevent 1-tick moves from counting as correct, signal strength weighting in adaptive indicator weights, MACD histogram divergence detection added alongside RSI divergence, RSI mid-range gradient (±12 for RSI 35-65), MACD counter-trend crossovers reduced (±90→±50), multi-factor confidence metric (score + TF agreement + ADX regime), breakout detection on pivot levels, O(n²)→O(n) volatility context computation

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
- DCA fund pages default to "All Cycles" view instead of "Current Cycle"
- Signal history debounced — 5-minute minimum between consecutive same-type entries to prevent threshold oscillation flooding

- `computeDailySMAContext` now memoizes its result by daily-candle length + last close + last timestamp — daily SMAs change once a day but were being recomputed (~350 close ops) on every 5s signal tick
- IndicatorCharts history accumulators (rsi/stoch/macd/williamsR/adx/obv) now skip the append when the latest tracked value is unchanged — eliminates duplicate chart points and avoids needless React re-renders on every server tick
- `cancelBodyTpOrder` accepts an optional `fallbackOrderId` so recovery paths can cancel an order even when executor tracking has been dropped (e.g. after a restart between cancel and re-place)
- Body merges now `saveLiveState()` between cancelling the old TP and placing the merged TP — closes the crash window where a restart could resurrect an orphaned tpOrderId
- New `placeBodyTpWithRetry` helper retries TP placement once after a 1s delay, so merge and roll-up paths don't silently leave a body without a sell order if the first place call fails
- Engine IPC ports reassigned in `ecosystem.config.cjs` (Coinbase 5570→5565, Gemini 5571→5566, Crypto.com 5574→5567) to consolidate into a contiguous 5563–5567 range

## Fixed

- **`critical-mass-ui` PM2 app crash-looped with `npm error could not determine executable to run`.** The `critical-mass-ui` entry in `ecosystem.config.cjs` ran the Vite dev server through a shell-shim/`npx` resolution with a space-delimited `args` string, so npm parsed `--host`/`--port`/`0.0.0.0`/`5564` as unknown CLI config and never resolved an executable → repeated SIGINT until PM2 hit "too many unstable restarts" and marked it `errored`. Now invokes `admin/node_modules/vite/bin/vite.js` directly via the `node` interpreter with `args` as an array (`["--host", "0.0.0.0", "--port", "5564"]`).
- "WS fill for untracked order — likely orphan" warning was firing on every polling-backstop fill and post-restart reconcile fill, not just real orphans. The polling paths (`scheduleStaleOrderTimeout`, `refreshStaleOrders`, `checkPendingOrderFills`, `handleCancelledOrder` partial-fill) delete from `pendingOrders` BEFORE dispatching the fill through the engine; the engine's `handleOrderFill` chain runs `orderExecutor.handleOrderFill(orderId)` at the end and would find no entry, logging a 🚨 even though the fill was handled correctly. Same shape post-restart, where reconcile / offline-fill paths in `regime-engine.js` (offline body TP, offline entry catch-up, reconcile-detected TP/body TP fills, TP-filled-during-cancel-replace) discover saved orders that filled while in-memory `pendingOrders` was empty. New `recentlySettled` TTL Map (5min, 256-entry cap) discriminates real orphans from benign double-cleanup; `orderExecutor.markSettled` is exposed and stamped at all 7 reconcile/offline-recovery dispatch sites in `regime-engine.js`. Warning now fires only for true orphans (WS fill for an order genuinely never tracked).
- **Filled Orders summary diverged from Position card P&L** — UI's `pnlMap` summed `bodyPnl` annotation across every partial-fill row of the same orderId (annotations are written to all partials with the same value, so the sum multiplied by N), and a downstream override recomputed pnl from incomplete buy linkage (most coinbase body sells have only ~half their buys with `sellOrderId` stamped, so subtracting "linked cost" missed half the cost basis and inflated profit). Coinbase summary went from $42,213 (wrong) → $26,495 (matches engine). Fix is `RegimeDashboard.jsx` `pnlMap` construction + `fill-ledger.js:computeRealizedFromCyclePairs`.
- `engines/coinbase-engine.js` offline-status path read `fifo.remainingLotCost` from the new derivation return shape (no longer present), which would have set `position.heldAssetCostBasis = undefined` and broken APY's `unrealizedReturn` calc when the engine was stopped. Now uses `derived.heldOpenBuyCostBasis`.
- **R6 — FIFO inflation from uncovered sells.** `computeFifoRealized()` silently inflated `remainingAssetQty` when a sell had no prior buy lots to consume (manual orders mixed with bot orders, restored-from-recovery sells, etc). The lot queue stayed intact and the full proceeds counted as profit. Fix: derive `remainingAssetQty` from `totalBuyQty − totalSellQty`, prorate `realizedPnL` by covered fraction. Coinbase BTC reserves dropped from 2.486 → 2.054 BTC (then 1.054 after removing the manual triplet); the 0.432 BTC inflation came from a single 1 BTC manual sell on 2026-02-08 that consumed only 0.568 BTC of bot-tracked buys.
- **R7 — APY math errors.** Return % used `initialCapital` (budget cap) not `depositedCapital` (deposit). `totalLiquidValue` double-counted held assets at market value as "return" instead of subtracting cost basis. APY compounded linearly-extrapolated daily rate via `(1 + dailyPct)^365`. All three fixed in `src/apy-calculator.js`; numbers are now defensible (coinbase 76.7% APY at 158d, cryptocom 38% APY at 108d).
- **R3 — closed-trades preferred over FIFO after clear.** `refreshRealizedFromFifo()` had `closedCount > 0 ? closedTrades.getTotalPnL() : fifo`. After a rectification cleared `closed-trades.json` to `[]`, new sells repopulated it partially, and the engine started using the partial sum as `realizedPnL` — the historical FIFO baseline silently vanished from displays. Now always FIFO.
- Dead `updateRegimeStateAfterTP` function and its export removed — had a `state.realizedPnL += pnl` accumulator pattern (the same shape that caused R1) and was exported but never called. Removing it eliminates the latent regression risk.

- `scripts/backfill-scorecard.js` was carrying stale 6-key indicator weights (`rsi: 0.25, stochastic: 0.20, macd: 0.20, bollinger: 0.15, vwap: 0.10, momentum: 0.10`), so re-running the backfill would have produced wrong adaptive-weight outputs once OBV / Williams %R / CCI were added. Script now imports the same `INDICATOR_WEIGHTS` constant as the live engine.

- Gemini ETHUSD orphaned buys — 12 buy orders (0.64 ETH) on exchange missing from fill-ledger; recovery script fetches exchange history, adds fills, creates celestial bodies, and fixes migration closed-trade holdback/PnL
- Aggressiveness Level buttons did nothing on any non-default fund — `AggressivenessControl` referenced `pairQuery` but never received it as a prop, so clicking a level threw `ReferenceError: pairQuery is not defined` and the PUT to `/api/:exchange/regime/config` never fired. Pass `pairQuery` into the child component. Bug introduced by the multi-pair refactor (66fb595)
- Add Fund modal's "Total Allocation" was only saved as legacy `totalAllocation` (which the regime engine ignores), leaving `regime.depositedCapital` and `regime.maxUsdcDeployed` at 0 — the dashboard then showed Deposited as $0. POST `/api/:exchange/funds` now mirrors the entered amount into both regime fields and enables regime by default; modal label updated to "Initial Capital"
- Gemini BTCUSD missing 28 buy fills — synced from exchange and associated with galaxy body, position corrected from 0.04 to 0.069 BTC
- Startup `syncPositionState` gap — celestial body totals were not synced to position after recovery, causing totalAsset=0 despite bodies having correct data

- `calculateCostBasis` now reads asset-generic field names (`buyQuantity`, `holdbackAsset`, `sellQuantity`) instead of BTC-specific ones — fixes cost basis display for CRO and other non-BTC DCA funds
- Overview position double-counting — `totalAssetQty` was summing body assets twice (`position.totalAsset` already equals body sum from `syncPositionState`)
- CRO `realizedAssetPnL` inflation — cumulative holdback counter inflated to 168K CRO when actual reserves were ~28K; added `reconcileAssetReserves` cap that queries exchange balance on startup, every 5min save, and after sells; auto-recalc no longer overwrites corrected values with inflated fill-ledger totals
- Crypto.com partial TP fill handling — body TP orders that partially fill are now detected, body state reduced proportionally, and a new TP placed for the remaining position; previously partial fills were silently ignored because the polling only checked for 100% filled orders
- Crypto.com `getOrderFills` recent-trade window — old code called `private/get-trades` with no params, capping at ~100 trades over an implicit ~24h window. When a partial fill landed after >100 other trades had occurred, the polling backstop's delta-partial path fetched the order's fills, got an empty list, and ingested nothing. New code looks up `instrument_name` + `create_time` + `update_time` via `private/get-order-detail`, then walks `private/get-trades` in 24h buckets across the order's lifetime, scoped by instrument, with span-halving on 100-trade-cap hits, and filters by orderId client-side. Capped at 7d lookback / 50 pages. This was the root cause of the May 2026 CRO_USD partial-fill leak (32 fills, 28,195 CRO).
- Crypto.com `getOpenOrders` now returns `size`, `originalSize`, and `price` fields, and correctly reports `PARTIALLY_FILLED` status — fixes orphan detection for partially-filled sell orders
- Legacy `take_profit` orders now normalize to `body_tp` when a celestial body owns the order — fixes "TP" type badge showing instead of the correct tier emoji
- Startup restore now uses `restoreBodyTpOrder` for legacy TPs owned by bodies, clearing stale `activeTpOrderId`
- Partial fill indicator ("PF" badge) on open sell orders — shows when an order has been partially filled on the exchange
- Realized P&L card now shows total liquid value (USD + asset at market price) as the primary number, with USD and asset breakdowns below (RegimeDashboard, Overview, and DCA Dashboard)
- Added missing `asteroid` and `nebula` tiers to open orders tier style map
- Capital adjustment UI now allows reducing available cash — clamps depositedCapital and maxUsdcDeployed to valid server ranges instead of sending out-of-range values
- Manual TP% override — edit icon on open orders table lets you set an exact take-profit % for any celestial body; takes effect immediately by cancelling and replacing the TP order
- Manual TP limit price editing — edit icon next to limit price opens modal in price mode; percentage and price tabs live-sync with each other; shows avg cost and equivalent % when editing by price
- Persistent manual TP override — `manualTpPct` saved on body state so manual TP targets survive reconciliation loops, bot restarts, and external cancel recovery; startup overpriced-TP check skips bodies with manual overrides
- Merge TP cap — after a body rollup/merge, the merged body's TP% is capped at the pre-merge target's level so the absolute sell price can only decrease, never increase after absorbing cheaper buys
- WebSocket status push after body TP fill — UI now refreshes immediately when a body TP order fills, instead of waiting for the next ticker update

- Cycle completion detection now counts all sells (body TP + core TP) instead of only core TP sells — fixes cycle-11 (body-only) not being recognized as completed on restart
- Cycle display shows current cycle number (completed + 1) instead of completed count
- Dashboard stale after body TP fill — `callbacks.onStatusUpdate` was not called after processing body TP fills, so the UI never received the updated position/cycle state
- Dashboard P&L and APY values truncated with "..." — removed `truncate` from BTC reserves, daily estimate, and annual estimate lines so values wrap instead of being cut off
- Closed trades ledger (`closed-trades.json`) — immutable P&L records written at fill time; migration from existing fills uses bodyId-matched buy costs instead of corrupted bodyPnl annotations; fixes inflated CRO realized P&L from body consolidation bug
- Cycle completion detection counts all sells (body + core) instead of only core — fixes body-only cycles not recognized on restart
- `recalculateCycles` global P&L uses FIFO cost-lot replay as fallback when no closed trades exist
- Cycle auto-linking restricted to completed cycles only — prevents over-linking unsold buys to early sells in active cycles
- Cycle renumbering restricted to orphan-fix scenarios only — prevents stable cycle IDs from being reshuffled by timestamp ordering

- Signal history now sorted newest-first — API results were displayed in arbitrary order
- Signal panel and banner show "CALCULATING..." loading state until live indicators arrive, preventing false BUY/SELL display from stale cached signals on page load
- NEUTRAL and NTZ (NO_TRADE_ZONE) annotations no longer render on price charts — only BUY/SELL markers shown
- NTZ entries filtered from signal history recording (backend + frontend seed + live tracking)
- Weekly macro chart now receives signal annotations (was the only chart missing them)
- DCA Dashboard mobile overflow — truncate/responsive text for price banner, fund assets grid, stat cards, config summary, allocation progress, and pending orders table
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
- Overview/DCA dashboard fund navigation no longer briefly mounts the wrong dashboard (e.g. coinbase/BTC) when clicking another fund — `currentExchange`/`currentStrategy`/`currentPair` are now derived from the URL instead of lagging React state, and the auto-redirect useEffect that navigated using stale state has been removed
- Filled Orders table on RegimeDashboard no longer constrained to a 48rem inner-scroll box; it now expands with the page like Open Orders
- Bump vite 7.3.1 → 7.3.2 in admin to patch 3 advisories: arbitrary file read via dev server WebSocket (high), `server.fs.deny` bypass with queries (high), and path traversal in optimized deps `.map` handling (medium)
- Pin transitive lodash to ^4.18.1 via npm `overrides` in admin (recharts 2.x ships with 4.17.23) — patches code injection via `_.template` (high) and prototype pollution in `_.unset`/`_.omit` (medium)
- Gemini ETHUSD page showed BTC units instead of ETH — frontend `getBaseCurrency`/`getQuoteCurrency` hardcoded BTC for Gemini-style pairs; now parses base/quote by stripping known quote suffixes (matching backend logic). Deduplicated Dashboard.jsx copies to import from App.jsx
- Gemini BTCUSD and ETHUSD funds shared a single flat config — ETHUSD had no config entry, inheriting BTC defaults for regime params, capital limits, and aggressiveness. Converted Gemini to nested multi-pair config with separate BTCUSD and ETHUSD blocks
- Backend `baseCurrency`/`quoteCurrency` parsing broken for Gemini-style pairs (BTCUSD, ETHUSD) in 10 files — inline `split('-')[0]` returned full pair name instead of base currency, causing wrong balance lookups and log labels. Centralized `getBaseCurrency`/`getQuoteCurrency` in config-utils and replaced all inline patterns
- Asset reserves zeroed on restart — auto-recalc guard rejected correct fill-ledger values when saved state was 0 (from prior baseCurrency bug); removed guard and rely on `reconcileAssetReserves` to cap inflation post-startup
- Dashboard stale data when navigating between pairs on same exchange — `fetchData` and `fetchRegimeStatus` effects only depended on `currentExchange`, missing `currentPair`
- Overview aggregate P&L used config pair key (e.g. "BTCUSD") instead of actual productId to derive baseCurrency — misattributed asset reserves when pair key differed from traded instrument
- Overview WebSocket updates replaced full status with partial market-only data — market data service emits only `market`/`regime` fields, wiping `position`/`apy`/`celestial` from the initial API fetch; now merges instead of replacing
- Partial fill body TP incorrectly counted SOLD amount as asset reserves — for partial fills, the sold CRO was added to `realizedAssetPnL` instead of 0; the remaining CRO stays as an active body, not reserves. Also fixed fill annotation `bodyHoldbackAsset` which was set to the remaining body size instead of 0 for partial fills
- Orphan sell reclamation on startup disabled — was adopting ANY untracked sell order on the exchange as engine-owned, which sold non-engine BTC. Now log-only (manual review required)
- Recovery body creation on startup disabled — was creating bodies and placing TP sells for untracked position asset, which could sell user holdings. Now log-only
- `safeCancelOrder` race condition leaving stray sell orders on exchange — when cancel verification `getOrder` call failed (network error/timeout), the function trusted Coinbase's cancel API response and reported success; the rollup proceeded, removed the body, and the exchange order persisted as an orphan. Now retries verification and fails safe (`cancelled: false`) if verification cannot confirm. Also handles Coinbase `PENDING_CANCEL` status and unknown statuses as unverified
- Orphan entry cancellation destroyed partially filled buy orders on restart — if a buy order wasn't in `pendingEntryOrders` (e.g. after crash), startup cancelled it even with 61% fills. Now checks `filledSize > 0` and restores partially filled orphans instead of cancelling, ingesting any missing fills
- Gemini pair validation rejected unseparated pairs (ETHUSD, BTCUSD) — `PAIR_RE` regex in exchange-routes required a `-` or `_` separator, blocking all Gemini fund pages with "Invalid pair format". Made separator optional
- RegimeDashboard dollar values (realized/unrealized P&L, daily/annual estimates, budget, holdback values) now use `formatCurrency` with comma-separated thousands instead of raw `toFixed(2)`

## Removed

- API auth middleware, rate limiting, and WebSocket token validation — unnecessary for single-user local/Tailscale app; caused IPC connection failures and blocked dashboard access
- `express-rate-limit` dependency
- `axios` dependency — replaced with native `fetch` (Node 22) across all 7 files (exchange adapters, notifier, backtest engine, sync-fills, feed-poller) to eliminate supply chain attack surface
- `cors`, `uuid`, `json-bigint` npm dependencies — replaced with built-in Node.js APIs (`crypto.randomUUID()`, inline CORS middleware) or removed as unused
- Stale docs: `docs/cryptofeed-evaluation.md` (rejected dependency eval), `docs/UPDOWN-EVALUATION.md` (obsolete), dead doc links from PLAN.md
- Kalshi references from CHANGELOG.md unreleased section and DONE.md
- "Live" WebSocket connection indicator from overview page
- Direction (Dir) column from UpDown trade history table — directional stats still shown in Up/Down win rate summary
- ADX dynamic weight shift — replaced by static trend-following-dominant weights (was compounding bug)
