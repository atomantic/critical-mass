# Unreleased Changes

## Added

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

## Changed

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
- Signal history debounced — 5-minute minimum between consecutive same-type entries to prevent threshold oscillation flooding

## Fixed

- Aggressiveness Level buttons did nothing on any non-default fund — `AggressivenessControl` referenced `pairQuery` but never received it as a prop, so clicking a level threw `ReferenceError: pairQuery is not defined` and the PUT to `/api/:exchange/regime/config` never fired. Pass `pairQuery` into the child component. Bug introduced by the multi-pair refactor (66fb595)
- Add Fund modal's "Total Allocation" was only saved as legacy `totalAllocation` (which the regime engine ignores), leaving `regime.depositedCapital` and `regime.maxUsdcDeployed` at 0 — the dashboard then showed Deposited as $0. POST `/api/:exchange/funds` now mirrors the entered amount into both regime fields and enables regime by default; modal label updated to "Initial Capital"
- Gemini BTCUSD missing 28 buy fills — synced from exchange and associated with galaxy body, position corrected from 0.04 to 0.069 BTC
- Startup `syncPositionState` gap — celestial body totals were not synced to position after recovery, causing totalAsset=0 despite bodies having correct data

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
- RegimeDashboard dollar values (realized/unrealized P&L, daily/annual estimates, budget, holdback values) now use `formatCurrency` with comma-separated thousands instead of raw `toFixed(2)`

## Removed

- `axios` dependency — replaced with native `fetch` (Node 22) across all 7 files (exchange adapters, notifier, backtest engine, sync-fills, feed-poller) to eliminate supply chain attack surface
- `cors`, `uuid`, `json-bigint` npm dependencies — replaced with built-in Node.js APIs (`crypto.randomUUID()`, inline CORS middleware) or removed as unused
- Stale docs: `docs/cryptofeed-evaluation.md` (rejected dependency eval), `docs/UPDOWN-EVALUATION.md` (obsolete), dead doc links from PLAN.md
- Kalshi references from CHANGELOG.md unreleased section and DONE.md
- "Live" WebSocket connection indicator from overview page
- Direction (Dir) column from UpDown trade history table — directional stats still shown in Up/Down win rate summary
- ADX dynamic weight shift — replaced by static trend-following-dominant weights (was compounding bug)
