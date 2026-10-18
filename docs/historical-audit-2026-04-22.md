# Historical audit notes recovered from April 22, 2026

These notes were drafted against the April 22 checkout and never published.
They are retained as historical planning work, not a current defect inventory
or instructions to replay old fixes. File sizes, line references, dependency
versions and completion states may be obsolete. Check current code and tracker
issues before acting on any item. Newer runtime and accounting contracts in
CLAUDE.md and docs/pnl-architecture.md take precedence.

## Original audit


Summary: 82 findings across 45+ files. 2 shared utilities to extract.

### Foundation — Shared Utilities

1. **`fmtPrice`** — Format price to fixed decimals. Duplicated in `regime-engine.js`, `order-executor.js`, `dry-run-executor.js`, `fill-ledger.js`. Export from `src/shared-utils.js`.
2. **`src/routes/route-utils.js`** — Extract `getPair(req)` and `getIPC(exchange)` helpers duplicated in `exchange-routes.js` and `regime-routes.js`.

### File Ownership Map

| File | Primary Category | Reason |
|------|-----------------|--------|
| `src/regime-engine.js` | bugs-perf | 2 CRITICAL bugs (use-after-null, unhandled rejection) |
| `src/fill-ledger.js` | bugs-perf | HIGH TOCTOU + MEDIUM cycle detection + MEDIUM JSON parse |
| `src/order-executor.js` | bugs-perf | HIGH missing .catch() + MEDIUM atomicReplace |
| `src/state-tracker.js` | bugs-perf | HIGH race condition in saveRegimeState |
| `src/apy-calculator.js` | bugs-perf | MEDIUM silent APY clamping |
| `server.js` | security | HIGH no auth + MEDIUM rate limiting |
| `src/routes/exchange-routes.js` | security | MEDIUM path traversal + MEDIUM regime pass-through |
| `src/routes/updown-routes.js` | security | HIGH PM2 restart DoS + MEDIUM screenshot bypass |
| `src/routes/sentinel-routes.js` | security | MEDIUM mass assignment |
| `src/routes/settings-routes.js` | security | LOW token masking |
| `src/adapters/gemini/auth.js` | security | LOW nonce singleton |
| `src/config-utils.js` | architecture | HIGH SRP violation (1392 lines) |
| `src/routes/regime-routes.js` | architecture | MEDIUM no pagination on fills |
| `src/adapters/coinbase/api.js` | dry | HIGH placeLimitSell/Buy duplication + HIGH incrementToDecimals inconsistency |
| `src/adapters/gemini/api.js` | stack-specific | HIGH no AbortController (overrides DRY MEDIUM) |
| `src/adapters/cryptocom/api.js` | stack-specific | HIGH no AbortController |
| `src/adapters/base-adapter.js` | dry | HIGH retry logic only in Coinbase |
| `src/shared-utils.js` | dry | MEDIUM DATA_DIR dual export |
| `src/backtest-engine.js` | stack-specific | HIGH no fetch timeout + DRY inline API |
| `src/ipc/ipc-server.js` | stack-specific | HIGH async handler rejection |
| `src/notifier.js` | stack-specific | MEDIUM no fetch timeout |
| `src/candle-cache.js` | stack-specific | MEDIUM no fetch abort |
| `src/dca-engine.js` | code-quality | MEDIUM magic fee numbers |
| `src/dca-converter.js` | code-quality | MEDIUM raw console.log |
| `src/routes/async-handler.js` | code-quality | MEDIUM unused module |
| `engines/coinbase-engine.js` | code-quality | LOW hardcoded fee_asset + lazy require |
| `src/dry-run-executor.js` | code-quality | LOW magic literal |
| `admin/src/hooks/useCandleData.js` | stack-specific | HIGH no AbortController |
| `admin/src/hooks/useSentinelSocket.js` | stack-specific | HIGH missing socket.off cleanup |
| `admin/src/components/Dashboard.jsx` | stack-specific | MEDIUM fire-and-forget fetch |
| `admin/src/components/RegimeDashboard.jsx` | stack-specific | MEDIUM stale closure pairQuery |
| `admin/src/App.jsx` | stack-specific | MEDIUM fetchData stale closure |
| `admin/src/components/ChartsRegime.jsx` | stack-specific | MEDIUM no abort on parallel fetches |
| `admin/src/components/KeysConfig.jsx` | stack-specific | MEDIUM label/htmlFor |
| `admin/src/components/updown/SignalPanel.jsx` | stack-specific | LOW unmount fetch |
| `scripts/audit-fills.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/check-orders.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/query-fills.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/restore-state.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/add-recovery-fill.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/recover-btc.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/reconcile-state.js` | dry | CRITICAL duplicated auth + undeclared axios |
| `correct-state.js` (removed, #1157) | dry | CRITICAL duplicated auth + undeclared axios |
| `recover-duplicate-tp-btc.js` (removed, #1157) | dry | CRITICAL duplicated auth + undeclared axios |
| `scripts/audit-gemini-fills.js` | dry | HIGH duplicated fetchAllTrades |
| `src/routes/route-utils.js` | dry | NEW — extract shared route helpers |
| `src/websocket-feed.js` | deps | MEDIUM jsonwebtoken replacement |
| `src/adapters/coinbase/auth.js` | deps | MEDIUM jsonwebtoken replacement |

### Security & Secrets
- [ ] **[CRITICAL]** `keys.json` — Review exchange credential encryption and storage. Fix: rotate affected keys and use a secrets manager if needed. Complexity: Medium
- [ ] **[HIGH]** `server.js:309` — No authentication on any API endpoint including destructive routes (start/stop engine, write keys, restore backups). Fix: add Bearer token auth middleware. Complexity: Simple
- [ ] **[HIGH]** `src/routes/updown-routes.js:173` + `src/sentinel/classifier.js:89` — SSRF via admin-configurable AI provider endpoints and RSS feed URLs. Fix: validate URL scheme, reject private IP ranges. Complexity: Medium
- [ ] **[HIGH]** `src/routes/updown-routes.js:548` — Unauthenticated POST triggers `exec('pm2 restart')` — DoS vector. Fix: require auth (covered by global auth fix). Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/sentinel-routes.js:39` — Mass assignment on PUT /api/sentinel/config. Fix: validate against schema. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/exchange-routes.js:222` — Unvalidated `regime` sub-object pass-through bypasses schema. Fix: add REGIME_SCHEMA validation. Complexity: Medium
- [ ] **[MEDIUM]** `src/routes/updown-routes.js:130` — Screenshot content-type bypass. Fix: verify buffer magic bytes. Complexity: Medium
- [ ] **[MEDIUM]** `src/routes/exchange-routes.js:173` — Path traversal via `?pair=` query param (no regex validation). Fix: add pair param sanitizer regex. Complexity: Simple
- [ ] **[LOW]** `config.json` — Live operational values committed. Fix: `git rm --cached config.json`
- [ ] **[LOW]** `src/routes/settings-routes.js:62` — Telegram token partial masking leaks info. Fix: return `{ configured: true }`
- [ ] **[LOW]** `src/adapters/gemini/auth.js:58` — `lastNonce` module-level singleton
- [ ] **[LOW]** `server.js:335` — WebSocket log streams have no per-client cap

### Code Quality & Style
- [ ] **[HIGH]** `src/regime-engine.js` (161 occurrences) + `src/order-executor.js` (38) + 6 other files — Raw `console.log` bypasses project logger. Fix: replace with `log()`. Complexity: Medium
- [ ] **[HIGH]** `src/regime-engine.js:469` — `reconcileAssetReserves().catch(() => {})` silently swallows all errors. Fix: log at WARN level. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/exchange-routes.js:38` / `src/routes/regime-routes.js:24` — IPC fallback silently routes to Coinbase if exchange not in map. Fix: throw/return error. Complexity: Simple
- [ ] **[MEDIUM]** `src/dca-engine.js:303` — Magic fee numbers (0.00125, 0.00031) duplicated vs optimizer/backtest. Fix: extract to shared constants. Complexity: Simple
- [ ] **[MEDIUM]** `src/regime-engine.js:1263,1273` — Bare `catch {}` on file reads (corrective-buys, manual-trades). Fix: distinguish ENOENT from other errors. Complexity: Simple
- [ ] **[MEDIUM]** `src/dca-converter.js` (9 occurrences) — Raw console.log in irreversible migration code. Fix: use project logger. Complexity: Simple
- [ ] **[MEDIUM]** `server.js:242` — Magic literal 3000 for health check timeout. Fix: extract named constant. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/async-handler.js` — Module exists but is never imported anywhere. Fix: either adopt it in all routes or delete. Complexity: Medium
- [ ] **[LOW]** Multiple magic time literals (300000, 60000, 0.999) across regime-engine, order-executor, dry-run-executor
- [ ] **[LOW]** `engines/coinbase-engine.js:678` — Hardcoded `fee_asset: 'USDC'`
- [ ] **[LOW]** `server.js` — No request/response logging middleware
- [ ] **[LOW]** `src/migration.js` — console.log usage (may be intentional — runs before logger init)

### DRY & YAGNI
- [ ] **[CRITICAL]** `scripts/` (9 files) — `generateJWT` + `preparePrivateKey` + `makeRequest` copy-pasted; also use undeclared `axios`. Fix: import from `src/adapters/coinbase/auth.js`, use native fetch. Complexity: Simple
- [ ] **[HIGH]** `src/adapters/coinbase/api.js:301-395` — `placeLimitSell`/`placeLimitBuy` near-identical (~40 lines each). Fix: parameterize by `side`. Complexity: Simple
- [ ] **[HIGH]** `src/adapters/coinbase/api.js:96` — `isTransientNetworkError` + retry only in Coinbase adapter; Gemini/Crypto.com have none. Fix: move to `base-adapter.js`. Complexity: Medium
- [ ] **[HIGH]** `scripts/audit-gemini-fills.js:48` — `fetchAllTrades` duplicates `adapter.getAllTrades`. Fix: use adapter directly. Complexity: Simple
- [ ] **[HIGH]** `src/adapters/coinbase/api.js:316` — Uses `Math.log10` for precision (wrong for non-power-of-10); Gemini/Crypto.com use `incrementToDecimals` correctly. Fix: switch Coinbase to `incrementToDecimals`. Complexity: Simple
- [ ] **[MEDIUM]** `scripts/` (7 files) — `DATA_DIR` re-declared instead of importing from `src/paths.js`. Complexity: Simple
- [ ] **[MEDIUM]** `src/shared-utils.js:308` — `DATA_DIR` dual-exported from both `paths.js` and `shared-utils.js`. Fix: remove from shared-utils. Complexity: Simple
- [ ] **[MEDIUM]** `src/adapters/gemini/api.js:266-375` + `src/adapters/cryptocom/api.js:353-461` — `placeLimitSell`/`placeLimitBuy` duplication. Fix: parameterize by side. Complexity: Simple
- [ ] **[MEDIUM]** `src/adapters/gemini/api.js:456` — `getOrderFills` hardcoded `symbol: 'btcusd'`. Fix: resolve from order. Complexity: Medium
- [ ] **[LOW]** `place-corrective-buy-2cb8f4c2.js`, `repair-orphan-buy-mm0nf5pn.js` — Deprecated one-off scripts (`repair-orphan-buy-mm0nf5pn.js` removed in #1157)
- [ ] **[LOW]** `src/adapters/cryptocom/api.js` — console.log vs project logger

### Architecture & SOLID
- [ ] **[CRITICAL]** `src/regime-engine.js` — God file at 4,369 lines with 30+ public methods. Fix: extract FillProcessor, StartupRecovery, SchedulerCoordinator. Complexity: Complex
- [ ] **[HIGH]** `src/regime-engine.js:827-1537` — `start()` function is 710 lines. Fix: decompose into RecoveryCoordinator + EngineStartup. Complexity: Complex
- [ ] **[HIGH]** `src/regime-engine.js:1740-2270` — `handleOrderFill()` is 530 lines. Fix: extract handleBuyFill/handleSellFill. Complexity: Medium
- [ ] **[HIGH]** `src/config-utils.js:1-1392` — SRP violation: 1,392 lines, 50 exports, 6 concerns. Fix: split into domain-specific config modules. Complexity: Medium
- [ ] **[HIGH]** `src/regime-engine.js:1257-1273` — Direct `fs.readFileSync` bypasses abstractions. Fix: move to fill-ledger or dedicated store. Complexity: Medium
- [ ] **[HIGH]** `src/state-tracker.js:703` — Lazy circular dependency via `require()`. Fix: extract state-migrator.js. Complexity: Medium
- [ ] **[MEDIUM]** `src/regime-engine.js:42-47` + 3 files — `fmtPrice` duplicated in 4+ files. Fix: export from shared-utils. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/exchange-routes.js` — Inconsistent API response envelope (GETs return raw, mutations return `{ success: true }`). Fix: standardize. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/exchange-routes.js:38` + `src/routes/regime-routes.js:24` — `getPair`/`getIPC` helpers duplicated. Fix: extract to route-utils.js. Complexity: Simple
- [ ] **[MEDIUM]** `src/routes/regime-routes.js:231` — GET /regime/fills has no pagination. Fix: accept limit/offset params. Complexity: Simple
- [ ] **[MEDIUM]** `server.js` — No HTTP rate limiting. Fix: add express-rate-limit. Complexity: Simple
- [ ] **[MEDIUM]** `src/regime-engine.js:297-348` — Config mutation coupled to engine. Fix: emit config:update event. Complexity: Medium
- [ ] **[MEDIUM]** `src/routes/updown-routes.js:119-242` — AI vision endpoint mixes 5 concerns. Fix: extract helpers. Complexity: Medium
- [ ] **[LOW]** `src/regime-engine.js:2463-2615` — Deeply nested .then()/.catch() chains
- [ ] **[LOW]** `src/routes/exchange-routes.js:265` — GET /transactions returns unbounded data
- [ ] **[LOW]** `src/regime-engine.js:131-143` — Overloaded constructor signature

### Bugs, Performance & Error Handling
- [ ] **[CRITICAL]** `src/regime-engine.js:2503-2504` — Use-after-null: `activeTpOrderId` nulled before passed to `handleOrderCancel`. Fix: capture ID first. Complexity: Simple
- [ ] **[CRITICAL]** `src/regime-engine.js:1631` — Fire-and-forget async fill handler: unhandled rejection on every WS fill. Fix: add `.catch()`. Complexity: Simple
- [ ] **[HIGH]** `src/fill-ledger.js:77` — TOCTOU: `load()` called at construction and again by caller. Fix: remove auto-load. Complexity: Simple
- [ ] **[HIGH]** `src/order-executor.js:413-419` — Stale order timeout `adapter.cancelOrder` missing `.catch()`. Fix: append `.catch()`. Complexity: Simple
- [ ] **[HIGH]** `src/regime-engine.js:484` — `reconcileAssetReserves().catch(() => {})` swallows all errors. Fix: log at WARN. Complexity: Simple
- [ ] **[HIGH]** `src/regime-engine.js:2463-2573` — Reconciliation loop launches un-awaited concurrent async. Fix: add reconcileInProgress guard. Complexity: Medium
- [ ] **[MEDIUM]** `src/fill-ledger.js:88-101` — Heuristic `currentCycleId` uses < 0.5 threshold (breaks at exactly 50% sold). Fix: change to < 1.0. Complexity: Simple
- [ ] **[MEDIUM]** `src/fill-ledger.js:159-163` — `netFee` inconsistent between live and import paths. Fix: standardize rebate subtraction. Complexity: Medium
- [ ] **[MEDIUM]** `src/apy-calculator.js:92` — APY silently clamped at 10% daily without indication. Fix: expose `isApyClamped` flag. Complexity: Simple
- [ ] **[MEDIUM]** `src/order-executor.js:536-603` — `atomicReplace` missing `.catch()` and fill detection. Fix: use `safeCancelOrder`. Complexity: Simple
- [ ] **[MEDIUM]** `src/regime-engine.js:2337` — Unbounded ATH fetch loop with no max-page guard. Fix: add `maxPages = 20`. Complexity: Simple
- [ ] **[MEDIUM]** `src/fill-ledger.js:65` — `JSON.parse(fs.readFileSync(...))` with no error handling. Fix: try/catch with ENOENT handling. Complexity: Simple
- [ ] **[LOW]** `src/order-executor.js:386` — Partially-filled orders never re-checked after stale timeout
- [ ] **[LOW]** `engines/coinbase-engine.js:77` — `ledger.load()` called twice
- [ ] **[LOW]** `src/regime-engine.js:1503` — SIGUSR1 listeners accumulate on restart

### Stack-Specific
- [ ] **[HIGH]** `src/ipc/ipc-server.js:62` — Async handler in `ws.on('message')` swallows rejections. Fix: wrap with `.catch()`. Complexity: Simple
- [ ] **[HIGH]** `src/adapters/gemini/api.js:92` + `src/adapters/cryptocom/api.js:94` — REST calls have no AbortController/timeout. Fix: add 30s timeout. Complexity: Simple
- [ ] **[HIGH]** `src/backtest-engine.js:47` — `fetch()` with no timeout. Fix: add AbortController. Complexity: Simple
- [ ] **[HIGH]** `admin/src/hooks/useCandleData.js:396` — fetch inside useEffect has no AbortController + retry setTimeout leak. Fix: add AbortController + track retry timeout. Complexity: Medium
- [ ] **[HIGH]** `admin/src/hooks/useSentinelSocket.js:44` — Cleanup doesn't remove event listeners before disconnect (also useCompositeSocket, useUpDownSocket). Fix: add socket.off() calls. Complexity: Simple
- [ ] **[MEDIUM]** `src/notifier.js:138,368` — Telegram fetch calls with no timeout. Fix: add 10s AbortController. Complexity: Simple
- [ ] **[MEDIUM]** `src/candle-cache.js:52,85` — Candle seed fetches with no timeout. Fix: add 15s AbortController. Complexity: Simple
- [ ] **[MEDIUM]** `server.js:78` — setInterval for KNOWN_EXCHANGES never cleared + monotonic growth. Fix: store ref, clear on shutdown, use `.clear()` + re-add. Complexity: Simple
- [ ] **[MEDIUM]** `admin/src/components/Dashboard.jsx:152` — Fire-and-forget fetch with no AbortController. Fix: add AbortController + cleanup. Complexity: Simple
- [ ] **[MEDIUM]** `admin/src/components/RegimeDashboard.jsx:737` — `pairQuery` missing from useEffect dep array (stale closure). Fix: add to deps + AbortController. Complexity: Simple
- [ ] **[MEDIUM]** `admin/src/App.jsx:339` — `fetchData` not in useCallback, stale closure risk. Fix: wrap in useCallback or use refs. Complexity: Medium
- [ ] **[MEDIUM]** `admin/src/components/ChartsRegime.jsx:31` — 5 parallel fetches with no AbortController. Fix: single AbortController for all. Complexity: Medium
- [ ] **[MEDIUM]** `admin/src/components/KeysConfig.jsx:159` — label elements not connected to inputs via htmlFor/id. Fix: add htmlFor/id. Complexity: Simple
- [ ] **[MEDIUM]** `.env.example` — Missing. Fix: create with all consumed env vars. Complexity: Simple
- [ ] **[LOW]** `admin/src/components/Dashboard.jsx:8` — ToggleSwitch button has no accessible name
- [ ] **[LOW]** `admin/src/components/updown/SignalPanel.jsx:31` — One-time fetch with no AbortController

### Dependency Freedom
- [ ] **[CRITICAL]** `axios` — Undeclared ghost dependency used in 10 scripts. Not installed. Fix: replace with native `fetch()` (covered by DRY scripts fix). Complexity: Trivial
- [ ] **[MEDIUM]** `jsonwebtoken` — Only `jwt.sign()` with ES256 used (2 src files). Fix: replace with `crypto.subtle` (~50 lines). Complexity: Moderate
- [ ] **[MEDIUM]** `fast-xml-parser` — Single-file usage in `src/sentinel/feed-poller.js`. Fix: keep (no stable native XML parser in Node 18). Complexity: N/A
- [ ] **[LOW]** `ws` — Complex replacement (server-side WebSocket.Server has no native equivalent). Keep.
- [ ] **[LOW]** `portos-ai-toolkit` — Feature dependency with graceful degradation. Keep.

### Test Quality & Coverage
- [ ] **[CRITICAL][MISSING]** `src/regime-engine.js` — Zero test coverage on 4,369-line core module
- [ ] **[CRITICAL][MISSING]** `src/order-executor.js` — Only 3 narrow race-condition scenarios tested
- [ ] **[CRITICAL][MISSING]** `src/state-tracker.js` — Only atomicWriteSync and version increment tested
- [ ] **[CRITICAL][MISSING]** `src/order-manager.js` — No test file
- [ ] **[CRITICAL][MISSING]** `src/dca-engine.js` — No test file
- [ ] **[CRITICAL][MISSING]** `server.js` — No route handler tests
- [ ] **[HIGH][MISSING]** All 3 exchange adapters (coinbase/gemini/cryptocom api.js + auth.js) — No tests
- [ ] **[HIGH][MISSING]** `src/risk-manager.js`, `src/tp-optimizer.js`, `src/size-optimizer.js` — No tests
- [ ] **[HIGH][VACUOUS]** `tests/race-conditions.test.js:218-293` — Race 3 tests (merge-snapshot, P&L calc, dedup, TTL) test JS Map/arithmetic, not production code
- [ ] **[HIGH][WEAK]** `tests/race-conditions.test.js:120-143` — Mutex test assertion too loose (allows non-serialized behavior)
- [ ] **[HIGH][WEAK]** `tests/fill-ledger.test.js:386` — Persistence test hard-codes internal path
- [ ] **[HIGH][WEAK]** `tests/config-utils.test.js:524` — Config diff test only checks one omitted field
- [ ] **[MEDIUM][VACUOUS]** `tests/health-monitor.test.js:257` — Directly mutates internal state to simulate time
- [ ] **[MEDIUM][WEAK]** `tests/macro-regime.test.js:407,425` — Score assertions too loose (> 0 / < 0 instead of specific mode)
- [ ] **[MEDIUM][WEAK]** `tests/position-sizer.test.js:266` — TP split uses assert.ok instead of precise values
- [ ] **[MEDIUM][WEAK]** `tests/volatility-utils.test.js:77` — Encodes buggy rounding behavior for negative values
