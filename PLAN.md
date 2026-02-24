# Critical-Mass — Plan

## Completed

- [x] **Kalshi Integration** (2026-02-17) — Imported kalshibot as new Kalshi section: 61 files, 5 crypto strategies, 34 API endpoints, 14 admin UI components. See [docs/kalshi-integration.md](./docs/kalshi-integration.md)
- [x] **Post-Integration Tuning** (2026-02-18) — Forced pre-settlement exits, strategy evaluation reorder, momentum-rider promoted to LIVE, mobile responsive admin UI
- [x] **Account Reconciliation** (2026-02-18) — Fill-based P&L rebuild from Kalshi API, fixed P&L display bug, expanded Positions page with trade history
- [x] **ATM Strategy Tuning** (2026-02-18) — Widened ATM access for momentum-rider/swing-flipper, lowered CFV entry, added entry metadata for calibration. See [STRATEGY-GUIDE.md](./STRATEGY-GUIDE.md)
- [x] **PM2 Process Isolation** (2026-02-19/20) — 6 PM2 processes: gateway + 4 engines + UI, IPC layer with WS protocol, HTTP reverse proxy for Kalshi. See [docs/pm2-architecture.md](./docs/pm2-architecture.md)
- [x] **Strategy Rebalance** (2026-02-20) — Disabled CFV, re-enabled gamma-scalper, bumped sniper sizing, fixed CFV enter-then-dump bug. See [docs/kalshi-integration.md](./docs/kalshi-integration.md#strategy-rebalance-history-2026-02-20)
- [x] **PM2 Log Viewer** (2026-02-20) — Live log streaming over Socket.IO, LogViewer component with tail/auto-scroll/fullscreen, logs tab on all exchanges + gateway
- [x] **Swing Flipper Admin UI + Auto-Tune Persistence** (2026-02-20) — 15-param admin config for swing-flipper, auto-tune state persisted to config.json

- [x] **Sigma Calibration Fix** (2026-02-20) — Lowered minSigma floor 0.40→0.18 based on 170 data points (realized vol ~0.16-0.20), default fallback 0.55→0.30, fixed settlement-sniper hardcoded floors
- [x] **Entry Metadata Fix** (2026-02-20) — Added sigma/marketProb/ttl to CFV, gamma-scalper, momentum-rider, swing-flipper, settlement-sniper signal metadata for journal calibration
- [x] **Auto-Tuner Wiring** (2026-02-20) — Connected autoTuner.check() to window-summary callback in engine loop; persists adjusted params to config.json and hot-reloads strategies
- [x] **Health Aggregation Endpoint** (2026-02-20) — `GET /api/health` fans out to all engine IPC clients, returns per-engine status/uptime/memory. Extended kalshi:status IPC handler with engineRunning state
- [x] **UpDown Dashboard Code Review** (2026-02-20) — Fixed 21 issues: signal type field mismatch, expiry ISO/ms conversion, position field naming, null safety in 6 scoring functions, race condition in service start, file upload validation, AI response sanitization, health endpoint coverage, socket error handling, DRY signal constants

## Standardization Plan - 2026-02-21

Summary: 63 findings across 45+ files. 6 shared utilities to extract. Remediation covers CRITICAL, HIGH, and MEDIUM severity only.

### Phase A: Foundation — Shared Utilities

#### A1. `src/paths.js` — Centralized path constants
- **Purpose**: Single source of truth for all data directory paths
- **Replaces**: 31 separate `const DATA_DIR = path.join(__dirname, ...)` declarations
- **Files to modify**: shared-utils.js, state-tracker.js, chart-data-buffer.js, backup-service.js, migration.js, config-utils.js, hedge/hedge-dry-run.js, hedge/hedge-state.js, kalshi/services/* (10+), routes/kalshi-routes.js, routes/updown-routes.js, routes/ai-routes.js, and more
- **Signature**:
  ```javascript
  const DATA_DIR = path.join(__dirname, '..', 'data')
  const KALSHI_DATA_DIR = path.join(DATA_DIR, 'kalshi')
  const HEDGE_DATA_DIR = path.join(DATA_DIR, 'hedge')
  const UPDOWN_DATA_DIR = path.join(DATA_DIR, 'updown')
  const BACKUP_DIR = path.join(DATA_DIR, 'backups')
  const KEYS_DIR = path.join(__dirname, '..', 'keys')
  module.exports = { DATA_DIR, KALSHI_DATA_DIR, HEDGE_DATA_DIR, UPDOWN_DATA_DIR, BACKUP_DIR, KEYS_DIR }
  ```

#### A2. `src/time-utils.js` — Timestamp formatting
- **Purpose**: Eliminate magic `.slice(11, 23)` pattern scattered across codebase
- **Replaces**: 24 inline `new Date().toISOString().slice(11, 23)` calls
- **Files to modify**: kalshi/adapters/api.js, kalshi/adapters/polymarket-websocket.js, kalshi/services/* (10+), routes/kalshi-routes.js, routes/hedge-routes.js, routes/ai-routes.js
- **Signature**:
  ```javascript
  const ts = () => new Date().toISOString().slice(11, 23)
  const prefixedTs = (prefix) => `[${prefix}] ${ts()}`
  module.exports = { ts, prefixedTs }
  ```

#### A3. `src/routes/async-handler.js` — Unified async route error wrapper
- **Purpose**: Single implementation for Express async error forwarding
- **Replaces**: 2 different implementations in kalshi-routes.js:85 and hedge-routes.js:23
- **Files to modify**: routes/kalshi-routes.js, routes/hedge-routes.js, routes/exchange-routes.js, routes/backtest-routes.js, routes/settings-routes.js, routes/regime-routes.js, routes/keys-routes.js, routes/ai-routes.js, routes/updown-routes.js
- **Signature**:
  ```javascript
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  module.exports = asyncHandler
  ```

#### A4. `src/config-validator.js` — Config update schema validation
- **Purpose**: Whitelist-based validation for configuration updates, preventing arbitrary field injection
- **Replaces**: Unsafe `{ ...config, ...req.body }` spreads in multiple routes
- **Files to modify**: routes/kalshi-routes.js, routes/exchange-routes.js, routes/settings-routes.js
- **Signature**:
  ```javascript
  const validateConfigUpdate = (schema, update) => { /* pick only schema-defined keys */ }
  const KALSHI_CONFIG_SCHEMA = { /* allowed fields with type checks */ }
  const EXCHANGE_CONFIG_SCHEMA = { /* allowed fields */ }
  const STRATEGY_CONFIG_SCHEMA = { /* allowed fields per strategy */ }
  const AGGRESSIVENESS_SCHEMA = { /* kFactor, minIntervalMs, etc. with range bounds */ }
  module.exports = { validateConfigUpdate, KALSHI_CONFIG_SCHEMA, EXCHANGE_CONFIG_SCHEMA, STRATEGY_CONFIG_SCHEMA, AGGRESSIVENESS_SCHEMA }
  ```

#### A5. `admin/src/hooks/useSocketPrice.js` — Generic socket price subscription hook
- **Purpose**: Eliminate 300+ LOC of duplicated socket subscription logic
- **Replaces**: useCoinbaseSocket.js, useKrakenSocket.js, usePolymarketSocket.js (identical patterns)
- **Files to modify**: admin/src/hooks/useCoinbaseSocket.js (wrapper), admin/src/hooks/useKrakenSocket.js (wrapper), admin/src/hooks/usePolymarketSocket.js (wrapper), components that import these
- **Signature**:
  ```javascript
  const useSocketPrice = (socket, { subscribeEvent, unsubscribeEvent, dataEvent, throttleMs }) => {
    // Shared subscribe/unsubscribe/throttle/state logic
    return { prices, subscribe, unsubscribe }
  }
  ```

#### A6. `src/kalshi/load-keys.js` — Kalshi keys loader utility
- **Purpose**: Eliminate duplicated key loading and validation
- **Replaces**: 2 identical blocks in hedge-routes.js:93 and hedge-routes.js:211
- **Files to modify**: routes/hedge-routes.js, routes/kalshi-routes.js
- **Signature**:
  ```javascript
  const loadKalshiKeys = (keysPath) => { /* existsSync + readFileSync + JSON.parse with error */ }
  module.exports = { loadKalshiKeys }
  ```

---

### Phase B: Security Hardening

- [x] **[CRITICAL]** `src/routes/kalshi-routes.js:341-355` — Unsafe `{ ...config, ...req.body }` spread allows arbitrary field injection into Kalshi config. Fix: Use `validateConfigUpdate(KALSHI_CONFIG_SCHEMA, req.body)` from config-validator.js
- [x] **[CRITICAL]** `src/routes/kalshi-routes.js:1163-1177` — Unsafe `{ ...config.strategies[name], ...req.body }` spread in strategy update. Fix: Use `validateConfigUpdate(STRATEGY_CONFIG_SCHEMA, req.body)`
- [x] **[HIGH]** `src/routes/exchange-routes.js:55-65` — Unvalidated nested config spread in PUT `/api/:exchange/config`. Fix: Use `validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, updates)`
- [x] **[HIGH]** `src/routes/settings-routes.js:25-48` — No range validation on aggressiveness presets (kFactor, minIntervalMs, etc.). Fix: Use `validateConfigUpdate(AGGRESSIVENESS_SCHEMA, req.body)` with range bounds
- [x] **[MEDIUM]** `src/backup-service.js:102-119,147-159` — No symlink check on backup files before unzip/delete. Fix: Add `fs.lstatSync()` to verify regular file before operating
- [x] **[MEDIUM]** `src/routes/keys-routes.js:27-47` — Key name/ID returned in plaintext on GET. Fix: Return only `{ configured: true/false }` per exchange

---

### Phase C: Server DRY Cleanup

| Pattern | Utility | Files to modify |
|---------|---------|-----------------|
| `DATA_DIR = path.join(__dirname, ...)` (31x) | `src/paths.js` | shared-utils, state-tracker, chart-data-buffer, backup-service, migration, config-utils, hedge/*, kalshi/services/*, routes/* |
| `.toISOString().slice(11, 23)` (24x) | `src/time-utils.js` | kalshi/adapters/*, kalshi/services/*, routes/kalshi-routes, routes/hedge-routes, routes/ai-routes |
| `asyncHandler` (2 impls) | `src/routes/async-handler.js` | routes/kalshi-routes (remove inline), routes/hedge-routes (remove inline) |
| Kalshi keys loading (2x) | `src/kalshi/load-keys.js` | routes/hedge-routes:93, routes/hedge-routes:211 |
| `fs.mkdirSync(dir, { recursive: true })` with preceding existsSync (20x) | Remove unnecessary `existsSync` guards | kalshi/services/*, backup-service, state-tracker |

---

### Phase D: Server Bugs & Architecture

- [x] **[CRITICAL]** `src/notifier.js:183-186` — `batches.reduce()` promise chain not returned from `flushQueue()`. Messages silently fail to send. Fix: `return batches.reduce(...)` to propagate the promise
- [x] **[CRITICAL]** `server.js:458-464` — `runIntervalCycle(exchange)` called without await in scheduled trade, unhandled rejection. Already had `.catch()` — verified OK
- [x] **[CRITICAL]** `src/order-executor.js:378-409` — `.then()` chain in setTimeout callback. Already had `.catch()` — verified OK
- [x] **[HIGH]** `src/websocket-feed.js` — Reconnect timer. Already cleared in `scheduleReconnect()` — verified OK
- [x] **[HIGH]** `src/ipc/ipc-client.js:155` — `ws.send()` without null/readyState guard. Fix: Added `ws.readyState !== WebSocket.OPEN` guard
- [x] **[HIGH]** `src/market-data-service.js:246-257` — Unguarded `productId` access. Fix: Added null guard and double-start interval protection
- [x] **[HIGH]** `src/routes/backtest-routes.js:123-142` — Optimizer promise chain. Already had `.catch()` — verified OK
- [x] **[MEDIUM]** `server.js:219-234` — `Promise.all()` for exchange health checks. Fix: Changed to `Promise.allSettled()`
- [x] **[MEDIUM]** `src/market-data-service.js:147` — `setInterval` double-start. Fix: Clear existing interval before creating
- [x] **[MEDIUM]** `src/order-executor.js:400-403` — Already covered by outer `.catch()` — verified OK

---

### Phase E: Client DRY & Hooks

- [x] **[HIGH]** `admin/src/hooks/useCoinbaseSocket.js`, `useKrakenSocket.js` — Converted to thin wrappers using generic `useSocketPrice.js` hook (~215 LOC reduced)
- [ ] **[MEDIUM]** `admin/src/hooks/useCompositeSocket.js:28-67` — Each hook call creates new socket instance; no singleton. Skipped: risk of breaking cross-component socket state
- [x] **[MEDIUM]** `admin/src/hooks/useKalshiSocket.js:76-150` — Reconnection resubscription already handled via `connect` event — verified OK

---

### Phase F: Client Bugs & React Fixes

- [x] **[CRITICAL]** `admin/src/components/ai/Providers.jsx:88` — `setInterval` for polling not cleaned up on unmount. Fix: Store interval ID in ref, clear in useEffect cleanup
- [x] **[CRITICAL]** `admin/src/hooks/useLogStream.js:42` — `logs:subscribe` emitted without checking `socket.connected`. Fix: Added `if (socket.connected)` guard
- [x] **[CRITICAL]** `admin/src/hooks/useTradeEvents.js:19-66` — Already correct: exchange in deps, cleanup removes old handlers — verified OK
- [x] **[HIGH]** `admin/src/components/kalshi/Dashboard.jsx:751-757` — Already has proper cleanup — verified OK
- [x] **[HIGH]** `admin/src/components/kalshi/Dashboard.jsx:392-397` — Already has cleanup return — verified OK
- [x] **[HIGH]** `admin/src/components/Dashboard.jsx:119-136` — Already wrapped correctly — verified OK
- [x] **[HIGH]** `admin/src/components/updown/Dashboard.jsx:46-49` — Already correct — verified OK
- [x] **[MEDIUM]** `admin/src/hooks/usePolymarketSocket.js:53-59` — Fix: Added AbortController in useEffect cleanup
- [x] **[MEDIUM]** `admin/src/components/ConfigEditor.jsx:67-74` — Fix: Split into two separate effects
- [x] **[MEDIUM]** `admin/src/components/Toast.jsx:47-51` — Fix: Clear timeout in dismiss handler

---

### Phase G: Architecture — Tracked (No Remediation This Cycle)

These are SOLID/architecture findings documented for future refactoring. They're too risky to change in a live trading system without dedicated test coverage.

- **[CRITICAL]** `src/regime-engine.js` (3873 lines) — God function with 21 imports, 100+ internal functions. Future: Split into orchestrator + specialized modules
- **[CRITICAL]** `src/kalshi/engines/simulation-engine.js` (2089 lines) — God class with 34 instance vars. Future: Extract StrategyManager, TradeExecutor, PriceCache
- **[CRITICAL]** `src/config-utils.js` (1056 lines) — Swiss-army utility with 27 exports. Future: Split into domain-specific config services
- **[HIGH]** `src/routes/kalshi-routes.js` (1368 lines) — 40+ endpoints with embedded I/O. Future: Extract service layer
- **[HIGH]** `admin/src/components/RegimeDashboard.jsx` (2476 lines) — God component. Future: Extract sub-components
- **[HIGH]** `src/order-executor.js` (1078 lines) / `src/dry-run-executor.js` (1193 lines) — Duplicate parallel implementations. Future: Extract shared base
- **[HIGH]** `src/state-tracker.js` (855 lines) — Mixed persistence and domain logic. Future: Split repositories
- **[HIGH]** `src/fill-ledger.js` (942 lines) — Mixed calculation and persistence. Future: Split calculators

---

### Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Security | 2 | 2 | 2 | 4 | 10 |
| DRY | 4 | 1 | 4 | 4 | 13 |
| Bugs/Errors | 3 | 4 | 3 | 2 | 12 |
| Client/React | 3 | 4 | 4 | 3 | 14 |
| Architecture | 3 | 5 | 6 | 6 | 20 |
| **TOTAL** | **15** | **16** | **19** | **19** | **69** |

Remediating: CRITICAL (15) + HIGH (16) + MEDIUM (19) = **50 findings**
Architecture tracked only: **20 findings** (Phase G, no code changes)

## Shared BTC Price Chart & Candle Service (2026-02-21)

- [x] **Server candle cache** — `src/candle-cache.js`: per-exchange CandleAggregator, Crypto.com + Coinbase public API seeding, `GET /api/candles/:exchange`
- [x] **Shared chart component** — `admin/src/components/charts/BTCPriceChart.jsx`: composable chart with overlays, sub-charts, reference lines, multi-exchange lines
- [x] **Shared candle hook** — `admin/src/hooks/useCandleData.js`: bucket accumulation, view switching, 5s sync
- [x] **UpDown migration** — PriceChart.jsx now thin wrapper around BTCPriceChart (Crypto.com primary)
- [x] **Kalshi migration** — LiveBTCChart.jsx uses BTCPriceChart for chart section (Coinbase + exchange lines)
- [x] **Hedge chart** — BTCPriceChart added to hedge Dashboard with entry/SL/TP reference lines
- [x] **UpDown service cleanup** — Removed internal aggregator, delegates to shared candle-cache
- [x] **Compact time remaining** — Moved from standalone banner into UpDown header bar

## UpDown Signal Engine Improvements (2026-02-22)

- [x] **Feature 1: Trend Filter** — EMA(50)/EMA(200) on 1h candles dampens counter-trend signals by 50%
- [x] **Feature 2: Volatility-Scaled Thresholds** — ATR ratio widens/tightens signal zones dynamically
- [x] **Feature 3: Volume Surge Multiplier** — Amplifies/dampens per-TF scores based on volume vs 20-bar average
- [x] **Feature 4: Momentum Acceleration** — Dual ROC(3)/ROC(10) replaces simple momentum, with acceleration/fading detection
- [x] **Feature 5: Divergence Detection** — Price/RSI swing divergence dampens conflicting signals
- [x] **Feature 6: Pivot Points** — Classic S1/S2/R1/R2 dampening when price approaches key levels
- [x] **Feature 7: Adaptive Indicator Weights** — Scorecard accuracy feedback loop adjusts indicator weights with exponential smoothing
- [x] **Feature 8: Multi-Candle Horizon Prediction** — Identifies best evaluation window from scorecard accuracy data

New files: `src/updown/divergence.js`, `src/updown/pivot-points.js`
Modified: `src/updown/signal-engine.js`, `src/volatility-utils.js`, `src/updown/indicators.js`, `src/updown/scorecard.js`, `src/updown/updown-service.js`
Frontend: `SignalBanner.jsx` (trend/vol/horizon pills), `TimeframeGrid.jsx` (volume/divergence/acceleration badges), `ScorecardPanel.jsx` (adaptive weights section)

## Scorecard Analysis System (2026-02-22)

- [x] **Weight history logging** — Throttled `type: "weights"` records appended to JSONL every 5 min from `getMetrics()`
- [x] **Analysis API** — `GET /api/updown/scorecard-analysis` reads JSONL files for date range, returns accuracy trends, heatmap, indicator trends, weight evolution, failure patterns
- [x] **ScorecardAnalysis page** — `/updown/analysis` with date range selector, summary cards, accuracy AreaChart, indicator×timeframe heatmap, per-indicator LineChart, weight evolution chart, failure pattern table
- [x] **Route + nav** — Lazy-loaded route in App.jsx, BarChart3 link in UpDown Dashboard header
- [x] **PriceChart interval fix** — Custom `setInterval` in useCandleData shadowed `window.setInterval`, breaking chart interval buttons

## Signal Engine v2: Backtest-Driven Filters (2026-02-23)

- [x] **Feature 9: Confluence Filter** — Counts agreeing TFs; dampens overcrowded (7+: ×0.5) and moderate (6: ×0.8) signals; selective (≤5) pass through
- [x] **Feature 10: Score Cap** — Clamps |score| to 35 (backtest: 35-45 zone = 43% accuracy)
- [x] **Feature 11: Time-of-Day Weighting** — UTC hour multipliers from backtest accuracy (±15%)
- [x] **Confluence pill** — Green/yellow/red pill in SignalBanner showing TF agreement count
- [x] **Multi-timeframe charts** — 5 stacked HA charts (1m/3m/5m/15m/1h) replace single chart
- [x] **Trade History relocation** — Moved under price charts in center column
- [x] **Signal history dates** — Added month/day to signal panel timestamps

Modified: `signal-engine.js` (features 9-11), `BTCPriceChart.jsx` (decoupled interval mode from selector UI), `PriceChart.jsx` (multi-TF), `Dashboard.jsx` (layout), `SignalBanner.jsx` (confluence pill), `SignalPanel.jsx` (date format)

## UpDown Dashboard Overhaul + Signal Recalibration (2026-02-24)

- [x] **Fixed stale chart data** — useCandleData fetch effect had stale closure (suppressed eslint deps), all charts showed same candles
- [x] **Added 3m candle derivation** — candle-cache.js was missing 3m in seedDerivedTimeframes
- [x] **Dashboard layout restructure** — Flex columns instead of grid rows; PositionTracker under Scorecard; SignalPanel floats under TimeframeGrid
- [x] **Fixed stale signal display** — Added type/confidence/confluence to `updown:indicators` emission; banner/panel prefer live values
- [x] **10-chart multi-TF layout** — 2 columns: 1m/3m/5m/10m/15m left, 30m/1h/2h/4h/1d right with per-TF signal labels
- [x] **Signal engine recalibration for day trading** — Hard cap at ±35 made BUY (threshold 40) mathematically impossible; replaced with soft compression, lowered thresholds (25/45), softened confluence/trend dampeners
- [x] **Scorecard history hydration** — Loads last 3 days of JSONL outcomes on startup so metrics survive restarts
- [x] **Signal banner tooltips** — All pills (confidence, horizons, confluence, trend, volatility, best horizon, time) have hover tooltips

Modified: `signal-engine.js`, `scorecard.js`, `updown-service.js`, `useCandleData.js`, `candle-cache.js`, `BTCPriceChart.jsx`, `Dashboard.jsx`, `PriceChart.jsx`, `SignalBanner.jsx`, `SignalPanel.jsx`, `TimeframeGrid.jsx`

## Wire Unused Signals Into Kalshi Strategies (2026-02-24)

- [x] **Polymarket sentiment wiring** — `initPolymarketPriceService()` now called with engine callback in `startEngine()`; `context.polymarketSentiment` no longer null
- [x] **Trade flow imbalance tracking** — Replaced empty `handleTrade()` stub with rolling window accumulator (60s/300s buy/sell ratio); exposed via `getMarketState().tradeFlow`
- [x] **Coinbase price bridge fix** — `onCoinbasePriceUpdate()` now called from price bridge callback; `coinbasePrices`/`coinbasePriceHistory` Maps populated
- [x] **Settlement Sniper signals** — Polymarket sentiment (±0.08/0.10) and trade flow imbalance (±0.08) confidence adjustments with diagnostics
- [x] **Swing Flipper signals** — Polymarket sentiment veto (blocks when crowd + spot both disagree), trade flow confidence boost (+0.1)

Modified: `market-data-service.js`, `price-bridge.js`, `simulation-engine.js`, `kalshi-routes.js`, `settlement-sniper.js`, `swing-flipper.js`

## Next Actions

1. **Monitor sigma calibration ratio** — Watch window summaries after deploy; ratio should drop from 2.5x toward ~1.0-1.2x. If it overcorrects (ratio < 0.8), bump minSigma to 0.22
2. **Re-evaluate CFV** — With calibrated sigma, CFV's probability model should be more accurate. Shadow-run for 24h then decide on re-enabling
3. **Hedged BTC + prediction market insurance engine** — Design strategy combining spot BTC positions with Kalshi bracket hedging
4. **Per-engine memory tuning** — Profile each PM2 process under load, set `max_memory_restart` appropriately in ecosystem.config.cjs

## Documentation

- [PM2 Architecture](./docs/pm2-architecture.md) — Process layout, IPC layer, engine ports, gateway routing
- [Kalshi Integration](./docs/kalshi-integration.md) — File structure, isolation guarantees, reconciliation, strategy history
- [Fill Ledger Sell Linkage](./docs/fill-ledger-sell-linkage.md) — Buy→sell annotation, stale reference repair
- [Strategy Guide](./STRATEGY-GUIDE.md) — Parameter rationale, what was tried, what failed
