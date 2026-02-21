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

- [ ] **[CRITICAL]** `src/routes/kalshi-routes.js:341-355` — Unsafe `{ ...config, ...req.body }` spread allows arbitrary field injection into Kalshi config. Fix: Use `validateConfigUpdate(KALSHI_CONFIG_SCHEMA, req.body)` from config-validator.js
- [ ] **[CRITICAL]** `src/routes/kalshi-routes.js:1163-1177` — Unsafe `{ ...config.strategies[name], ...req.body }` spread in strategy update. Fix: Use `validateConfigUpdate(STRATEGY_CONFIG_SCHEMA, req.body)`
- [ ] **[HIGH]** `src/routes/exchange-routes.js:55-65` — Unvalidated nested config spread in PUT `/api/:exchange/config`. Fix: Use `validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, updates)`
- [ ] **[HIGH]** `src/routes/settings-routes.js:25-48` — No range validation on aggressiveness presets (kFactor, minIntervalMs, etc.). Fix: Use `validateConfigUpdate(AGGRESSIVENESS_SCHEMA, req.body)` with range bounds
- [ ] **[MEDIUM]** `src/backup-service.js:102-119,147-159` — No symlink check on backup files before unzip/delete. Fix: Add `fs.lstatSync()` to verify regular file before operating
- [ ] **[MEDIUM]** `src/routes/keys-routes.js:27-47` — Key name/ID returned in plaintext on GET. Fix: Return only `{ configured: true/false }` per exchange

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

- [ ] **[CRITICAL]** `src/notifier.js:183-186` — `batches.reduce()` promise chain not returned from `flushQueue()`. Messages silently fail to send. Fix: `return batches.reduce(...)` to propagate the promise
- [ ] **[CRITICAL]** `server.js:458-464` — `runIntervalCycle(exchange)` called without await in scheduled trade, unhandled rejection. Fix: Add `.catch(err => log('ERROR', ...))` to the call
- [ ] **[CRITICAL]** `src/order-executor.js:378-409` — `.then()` chain in setTimeout callback has no `.catch()`. Errors silently swallowed. Fix: Add `.catch(err => log('ERROR', ...))` at end of chain
- [ ] **[HIGH]** `src/websocket-feed.js` — Reconnect timer not cleared on error, accumulates timers. Fix: Clear `reconnectTimeout` in `handleDisconnect()`
- [ ] **[HIGH]** `src/ipc/ipc-client.js:155` — `ws.send()` without null/readyState guard. Fix: Add `if (!ws || ws.readyState !== WebSocket.OPEN) return` before send
- [ ] **[HIGH]** `src/market-data-service.js:246-257` — Unguarded `productId` access. Fix: Add `if (!productId) return` guard
- [ ] **[HIGH]** `src/routes/backtest-routes.js:123-142` — Optimizer promise chain not awaited. Fix: Add `.catch()` to handle errors from `runOptimizer()`
- [ ] **[MEDIUM]** `server.js:219-234` — `Promise.all()` for exchange health checks; one timeout blocks all. Fix: Use `Promise.allSettled()` instead
- [ ] **[MEDIUM]** `src/market-data-service.js:147` — `setInterval` for metrics without double-start guard. Fix: `if (metricsUpdateInterval) clearInterval(metricsUpdateInterval)` before creating
- [ ] **[MEDIUM]** `src/order-executor.js:400-403` — `adapter.cancelOrder()` in timer without catch. Fix: Add `.catch()` handler

---

### Phase E: Client DRY & Hooks

- [ ] **[HIGH]** `admin/src/hooks/useCoinbaseSocket.js`, `useKrakenSocket.js`, `usePolymarketSocket.js` — 300+ LOC of identical socket subscription logic with only event names varying. Fix: Create `useSocketPrice.js` generic hook; convert each to thin wrapper calling the generic hook
- [ ] **[MEDIUM]** `admin/src/hooks/useCompositeSocket.js:28-67` — Each hook call creates new socket instance; no singleton. Fix: Pass shared socket via React context or implement singleton pattern
- [ ] **[MEDIUM]** `admin/src/hooks/useKalshiSocket.js:76-150` — Missing reconnection resubscription. Fix: Re-emit subscribe on socket reconnect event

---

### Phase F: Client Bugs & React Fixes

- [ ] **[CRITICAL]** `admin/src/components/ai/Providers.jsx:88` — `setInterval` for polling not cleaned up on unmount. Fix: Store interval ID in ref, clear in useEffect cleanup
- [ ] **[CRITICAL]** `admin/src/hooks/useLogStream.js:42` — `logs:subscribe` emitted without checking `socket.connected`. Fix: Guard with `if (socket.connected)` before emit
- [ ] **[CRITICAL]** `admin/src/hooks/useTradeEvents.js:19-66` — Stale closure on `exchange` change; old handlers remain subscribed. Fix: Include `exchange` in effect dependencies, ensure cleanup removes old handlers
- [ ] **[HIGH]** `admin/src/components/kalshi/Dashboard.jsx:751-757` — Multiple intervals accumulate if fetch is slow. Fix: Clear previous interval before setting new one; track with useRef
- [ ] **[HIGH]** `admin/src/components/kalshi/Dashboard.jsx:392-397` — Countdown interval in sub-component lacks cleanup on market change. Fix: Add dependency and cleanup for `activeMarket?.close_time`
- [ ] **[HIGH]** `admin/src/components/Dashboard.jsx:119-136` — `updateCountdown` recreated every render, churns interval. Fix: Wrap in useCallback with stable deps
- [ ] **[HIGH]** `admin/src/components/updown/Dashboard.jsx:46-49` — `fetchStatus` useCallback has empty deps array, stale in setInterval. Fix: Add proper dependencies
- [ ] **[MEDIUM]** `admin/src/hooks/usePolymarketSocket.js:53-59` — Unhandled fetch promise, no abort on unmount. Fix: Add AbortController in useEffect cleanup
- [ ] **[MEDIUM]** `admin/src/components/ConfigEditor.jsx:67-74` — Effect sets `isDirty` in same effect that depends on `isDirty`, potential loop. Fix: Separate sync-from-props and reset-dirty into two effects
- [ ] **[MEDIUM]** `admin/src/components/Toast.jsx:47-51` — Toast timeout fires after manual dismiss. Fix: Clear timeout in dismiss handler

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
