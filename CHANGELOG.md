# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **[issue-413] Available Models textarea comma-space stripping bug** — Decoupled textarea input drafting from array parsing by maintaining local `modelsText` state, updated only on keystroke without premature splitting/filtering, and parsing into `formData.models` on blur or form submission, allowing operators to type multi-model comma-separated entries without losing mid-keystroke input.

### Added
- **[issue-405] API key routes integration test suite for credential safety and schema validation** — Add `tests/keys-routes.test.js` covering `GET /api/:exchange/keys/status`, `GET /api/:exchange/keys` (with strict assertions that field-flag responses never leak raw secrets), `POST`/`PUT /api/:exchange/keys` (exchange-specific schema validation: Coinbase requires `name` and `privateKey`; Crypto.com/Gemini require `apiKey` and `apiSecret`), `POST /api/:exchange/test-connection` (adapter error handling and balance reporting), and `DELETE /api/:exchange/keys` (file cleanup); integration tests verify no credentials appear in GET responses across multiple requests, and all validation rejects incomplete payloads consistently.
- **[issue-407] Regime operational control route tests** — Add `tests/regime-routes-control.test.js` covering `GET /api/:exchange/regime/status` (live IPC passthrough, `buildStoppedRegimeStatus` offline fallback with `engineDown:true` on IPC connection failure, and the 503-not-masked-as-offline path on request timeout), `POST /close`/`reopen` IPC command forwarding, `POST /force-regime` regime-name validation, and `POST /set-body-tp`/`set-body-tp-price` bodyId and boundary validation.
- **[issue-404] Backup service disaster-recovery test suite** — Expand `tests/backup-service.test.js` with coverage for `createBackup` excluding top-level and nested `*-keys.json` files and the `backups/` directory from the archive, `restoreBackup` preserving an existing on-disk key file even when a crafted archive contains one, `deleteBackup`/`restoreBackup` rejecting path traversal (`..`, `/`, `\\`, absolute paths), malformed filenames, and symlinked backup entries, and `pruneBackups` deleting only the oldest archives beyond the retention limit.
- **[issue-406] Fund lifecycle route tests for creation defaults, deletion guards, and live toggles** — Add `tests/exchange-routes-lifecycle.test.js` covering `POST /api/:exchange/funds` safe defaults (`enabled:false`, `dryRun:true`, `totalAllocation` mirrored into `regime.depositedCapital`/`maxUsdcDeployed`) and adapter-verification rejections, `DELETE /api/:exchange/funds/:pair` lifecycle/engine-running safety guards, and `PATCH /api/:exchange/config` live `enabled`/`dryRun` toggles including the IPC `regime:update-config` dispatch and 503 engine-rejection path.
- **[issue-403] Risk manager unit test suite** — Add `tests/risk-manager.test.js` covering asset/USDC caps, cycle-buys limit enforcement and time-based auto-reset, drawdown peak tracking, pause activation, 50% recovery resumption, drawdown auto-reset, `canPlaceEntry`/`checkAllCaps` reason aggregation, and `forceResume`, using mocked `Date.now()` for deterministic time-based behavior.

### Changed
- **[issue-409] Route pair validation and safe IPC lookup unified in route-utils** — Removed the duplicated `validatePairParam` in `exchange-routes.js` (now `route-utils.resolvePairParam`) and the duplicated try/catch `getIPC` fallback wrapper in `exchange-routes.js`/`regime-routes.js` (now the shared non-throwing `route-utils.getSafeIPC`); renamed the local `req.fundPair` readers in `regime-routes.js`/`backtest-routes.js` from `getPair` to `getFundPair` so they no longer shadow `route-utils`'s (semantically different) pair resolver, reducing drift risk without changing any route behavior.
- **[issue-410] Exchange registry unified across adapters, market data, and candle routes** — Removed hardcoded `SUPPORTED_EXCHANGES` array from `market-data-service.js` and `VALID_EXCHANGES` Set from `candle-routes.js`; both now import `isSupported` and `getSupportedExchanges` from `src/adapters/index.js`, eliminating the drift hazard of adding/removing exchanges in 3 disconnected places and consolidating to a single canonical source of truth.
- **[issue-411] Remove obsolete internal scoring and context helpers from signal-engine exports** — Removed 17 dead internal functions and constants (`scoreStochastic`, `scoreMACD`, `scoreVWAP`, `scoreMomentum`, `scoreOBV`, `scoreWilliamsR`, `scoreCCI`, `computeWeeklyTrendFilter`, `computeDailySMAContext`, `computeADXRegime`, `computeVolatilityContext`, `computeVolumeSurge`, `computeHorizonPrediction`, `TIMEFRAME_WEIGHTS`, `NO_TRADE_ZONE_MS`, `WARNING_ZONE_MS`, `INDICATOR_WEIGHTS`) from `src/updown/signal-engine.js` exports, eliminating misleading API surface and reducing maintenance confusion while keeping internal definitions intact for `computeSignals`.
- **[issue-408] Admin client formatting/timer utilities consolidated into chartUtils** — Removed duplicated `formatAsset`, `getPriceDecimals`, `formatPrice`, and `formatCurrency` implementations across `CostBasisDCA.jsx`, `CostBasisRegime.jsx`, `Dashboard.jsx`, `TransactionsDCA.jsx`, `TransactionsRegime.jsx`, `RegimeDashboard.jsx`, `CelestialTooltip.jsx`, `updown/Dashboard.jsx`, and `updown/PositionTracker.jsx` in favor of shared exports (`formatAsset`, `getPriceDecimals`, `formatPriceByMagnitude`, `formatCurrency`, `formatCurrencyIntl`) from `admin/src/components/charts/chartUtils.js`, preserving each page's exact prior rendering.
- **[issue-412] Remove obsolete single-process batch loop and legacy alias in dca-engine** — Delete `runAllExchangeCycles` function and `runDailyCycle` legacy alias from `src/dca-engine.js` and their exports; Critical Mass migrated to multi-process PM2 architecture where each exchange engine runs independently, making the batch loop and backward-compatibility alias unreferenced dead code.
- **[issue-369] Historical fill annotation repair extracted from engine startup** — Extract 188-line orphan recovery, size fuzzy-match, and cycle-ID rewriting heuristics from `startImpl` into dedicated `repairHistoricalFillAnnotations` helper, reducing mixed-abstraction cognitive load and enabling isolated testing of self-healing logic.
- **[issue-356] Remove obsolete updateRegimeStateAfterEntry and scoreToSignal methods** — Delete unreferenced functions `updateRegimeStateAfterEntry` (state-tracker.js), `scoreToSignal` (signal-engine.js), and `prefixedTs` (time-utils.js) to eliminate dead code clutter and reduce architectural risk from unused state mutation paths.
- **[issue-365] Fill ledger memoizes derived realized P&L and fill-time stats** — Cache `getDerivedRealizedPnL()`/`computeRealizedFromCyclePairs()` and `getFillTimeStats()` behind a ledger-mutation version counter (bumped on every ingest, annotation, cycle recalc, and reload) so the 1Hz live-engine status tick stops re-scanning and re-aggregating the entire fill history every second, cutting event-loop blocking and GC pressure without changing any P&L number.
- **[issue-357] Stopped/offline regime status synthesis unified under one domain owner** — Extract the "engine not running" status payload (fill-ledger P&L re-derivation, APY, pendingOrders, celestial) into a single `buildStoppedRegimeStatus` helper in `src/regime-status.js`, shared by the engine's IPC handler, the HTTP gateway's offline fallback, and the Socket.IO stream; the socket stream previously skipped P&L re-derivation entirely, so a hard refresh while the engine was stopped could show stale realizedPnL that the other two paths had already corrected.
- **[issue-362] stabilizeSignal decomposed into per-state transition handlers** — Extract BUY, SELL, and NEUTRAL state machines into named pure functions (transitionFromBuyState, transitionFromSellState, transitionFromNeutralState) to reduce cyclomatic complexity from 34 to 6 and improve readability and maintainability of signal stability logic.
- **[issue-363] Extract streak, window, and contract metrics from getMetrics** — Extract consecutive win/loss streak tracking, window-level aggregation, timeframe accuracy, and contract-aware statistics into four pure helper functions (computeOutcomeStreak, computeWindowMetrics, computeTimeframeMetrics, computeContractMetrics), reducing getMetrics cyclomatic complexity from 29 to 5 and improving maintainability without changing any scorecard output.
- **[issue-366] Memoize P&L enrichment and remove redundant sort in TransactionsRegime** — Wrap computeFillsWithPnL with useMemo, eliminate the unused sortedFills pass, and consolidate eight separate summary stat filter/reduce passes into one memoized loop, cutting render-time overhead on large fill sets; folding the dead pass's comparator into the rendered sort also makes non-timestamp column headers (side, size, price, fee) actually sort instead of silently no-op'ing.
- **[issue-361] UpDown signal dampener steps extracted from computeSignals** — Extract confluence filtering, macro trend dampening, daily pivot dampening, and score-ceiling compression into named, independently-tested helpers, cutting `computeSignals` cyclomatic complexity from 45 to reduce the risk of subtle ordering defects in future changes.
- **[issue-360] Scorecard analysis calculation steps extracted from monolithic function** — Decompose buildScorecardAnalysis into focused pure helpers (buildAccuracyOverTime, buildIndicatorAccuracyOverTime, buildFailurePatterns, buildSummaryStats, buildWindowAndContractStats) to reduce cyclomatic complexity from 58 to 5 and improve maintainability.
- **[issue-359] Regime operational modals extracted from monolithic RegimeDashboard** — Extract 6 confirmation dialogs (Collapse All, Reset Cycle, Resume Drawdown, Roll Up, Set TP, DCA Convert) into a dedicated RegimeActionModals component, reducing coupling between presentation/telemetry and operational mutations and enabling independent testing.
- **[issue-358] Fund summary aggregation extracted into domain module** — Extract fill ledger aggregation logic from exchange route handler into pure `buildFundSummary` function in `src/fund-summary.js` with dedicated unit tests, enabling reuse by other components and eliminating transport-domain entanglement.
- **[issue-355] Position state factory unified between state-tracker and regime-engine** — Replace divergent schema definitions with a single canonical factory in state-tracker.js; regime-engine.js now imports and re-exports the unified function, eliminating schema divergence and 30 lines of duplicated initialization code.
- **[issue-353] Cycle summary calculations consolidated in fill-ledger** — Extract the duplicated 40-line cycle statistics derivation into a single module-level helper (computeCycleStats) to fix the high drift risk from manual code duplication and eliminate hidden dependencies between recalculateCycles and rebuildPositionFromFills.
- **[issue-350] UpDown signal action resolution unified across server and client** — Consolidate UpDown action classification logic from two independent implementations into a single shared module, reconciling contracts for null/undefined signals ('CALCULATING...'), action string passthrough (OPEN|ADD|HOLD|CLOSE), and chronological history relabeling.
- **[issue-354] Remove unreferenced legacy admin UI components** — Deleted three unused React components (IndicatorCharts, MiniPriceSparkline, OrbitalRing) totaling 512 lines of dead code, reducing cognitive friction and build overhead.
- **[issue-344] Fibonacci sell completion names uncovered-buy carry** — Isolate placement coverage interpretation and preserve the legacy settlement export, accounting, and cycle-reset ordering.
- **[issue-342] Candle charts reuse timestamp labels** — Bound per-chart label storage to displayed buckets and invalidate on exchange, interval, or browser time-zone changes while preserving live snapshots.
- **[issue-340] UpDown signal cycles name momentum and history steps** — Extract private helpers while preserving tick arithmetic, history debounce, paper fills, and ordered persistence and publication.
- **[issue-331] Buy-merge decisions name body TP cancellation outcomes** — Make execution-bearing cancellations explicit while preserving immediate fill booking, result compatibility, and polling ownership.
- **[issue-329] Filled Orders reuses historical groups across ticker updates** — Memoize cycle accounting by fill snapshot while retaining live reserve valuation, search, and pending-TP orphan visibility.
- **[issue-327] Order consolidation separates cancellation and recovery** — Extract private operational steps while preserving sequential exchange calls, gap-fill exclusions, result shapes, and replacement-order mappings.

### Fixed
- **[issue-419] API Keys tab reads the current keys-routes response contract** — `KeysConfig.jsx` now tracks `configured`/`fields`/`createdAt` from `GET /api/:exchange/keys` instead of a `data.keys` object the route stopped returning in `1f1ef42`; Delete Keys now renders and Test Connection now enables for any exchange with stored credentials without retyping secrets, a "Configured"/"Stored on <date>" indicator and per-field "configured" badges surface server state, and the form refetches after save/delete so the tab stays accurate — no secret values are ever sent back from the server or rendered into the DOM.
- **[issue-414] DCA→Regime conversion honors the requested fund and backs up the files it actually rewrites** — `previewConversion`, `executeConversion`, and `mergeToRegime` now take `(exchange, pair)` and thread it through every `loadState` / `loadRegimeState` / `saveRegimeState` / `createFillLedger` / config lookup, and `engines/coinbase-engine.js` passes `resolvedPair` into all three; previously the `regime:convert-dca` handler resolved the pair, reported it back, then converted the exchange's DEFAULT fund — so converting a stopped `ETH-USDC` fund rewrote the live `BTC-USDC` fill ledger and regime state. `backupConversionFiles(exchange, pair)` now resolves the per-fund directory with the same resolver the writes use (`resolveFundDataDir`) instead of `data/<exchange>/`, where a migrated install has no conversion files left — the advertised safety backup had been silently copying nothing — and it throws before any mutation when nothing was backed up, so a conversion never proceeds without a rollback point.
- **[issue-420] Guard fetch failures on Backups, Notifications, and Gateway pages** — Wrap `fetch` calls in try/catch/finally on BackupRestore, NotificationsConfig, and GatewayAccess components to prevent unhandled rejections and loading-state hangs on network errors; add error state and retry button to BackupRestore and NotificationsConfig (replacing bare "Loading..." gate), ensure clearing/saving/signing flags always reset on GatewayAccess handlers, and treat non-2xx HTTP responses as failures instead of silently succeeding.
- **[issue-398] Guard JSON.parse in adapter hasValidKeys and loadCredentials against corrupt keys files** — Wrap `JSON.parse` and `fs.readFileSync` in try/catch within `hasValidKeys()` for all three adapters (Coinbase, Gemini, Crypto.com), returning `false` instead of throwing on corrupt, empty, or malformed JSON; `loadCredentials()` now throws a descriptive error message instead of raw SyntaxError, preventing process crashes and unhandled 500 errors when keys files are corrupted or truncated.
- **[issue-397] Telegram notifier escapes Markdown reserved characters and iterates all configured funds** — `formatEvent` now escapes `_ * \` [ ]` in trade event messages so brackets/underscores like `[DRY-RUN]` or `usdc_cap_exceeded` no longer trigger a Telegram 400 "can't parse entities" error that silently dropped delivery; `sendDailySummary` now iterates `getConfiguredFunds()` and reads `productId` from `getFundConfig(exchange, pair)` instead of the regime config, fixing non-BTC funds being mislabeled as BTC and secondary funds being silently omitted.
- **[issue-396] Backup service surfaces real spawnSync errors and installs zip/unzip in Docker** — `createBackup`/`restoreBackup` now report `result.error.message` (e.g. `ENOENT`) instead of masking a missing `zip`/`unzip` binary as `"Unknown zip/unzip error"`, the production Dockerfile installs both via `apk add`, and temp-dir cleanup uses `fs.rmSync` instead of shelling out to `/bin/rm`.
- **[issue-393] Prompt stage template routes guarded against path traversal** — `guardPrompts` middleware validates `stageName` (from `req.params.name` or `req.body.name`) against a strict identifier pattern before the `portos-ai-toolkit` prompts router touches the filesystem, closing an arbitrary markdown file read/write/delete via `../` sequences in `GET/PUT/DELETE /api/prompts/stages/:name`.
- **[issue-394] Operator password changes require origin validation and current-password proof** — `PUT/DELETE /api/auth/password` and `DELETE /api/auth/session` now reject cross-origin session-cookie requests with 403, and a session cookie alone no longer exempts a caller from proving the current password before a password change; a bearer token (which already IS the password) still does.
- **[issue-367] Complete legacy offline TP recovery through canonical fills** — Preserve closed-trade audit records while sharing live fill deduplication, capital credits, buy linkage, optimizer metrics, and cycle cleanup; contain legacy lookup failures so subsequent orders still recover.
- **[issue-367] Offline recovery routes full body-TP and entry fills through the canonical fill pipeline** — `checkOfflineOrderFills` no longer duplicates fill accounting inline for a fully-filled celestial body TP or a filled pending entry; both now call `handleOrderFill`, which fixes a real defect where the last body filling while offline never triggered `resetCycle()` (ladder orders were left resting and cycle counters never reset), and makes offline entry fills create/merge a proper celestial body with a dynamic TP instead of mutating flat position fields with no body.
- **[issue-368] Body roll-ups book execution-bearing TP cancellations** — `_mergeBodyImpl` now classifies both source and target TP cancellation outcomes with `classifyBodyTpCancellation`; a TP that executes a tranche while its cancel is in flight is booked immediately and deducted from the still-live body (re-arming a right-sized TP) instead of being folded, un-deducted, into the merge target.
- **[issue-351] Source scorecard indicators and base weights from indicator-config** — Remove hardcoded indicator labels and base weights from ScorecardPanel and ScorecardAnalysis; source from canonical configuration to fix incorrect adaptive-weight deltas and ensure new indicators populate automatically.
- **[issue-352] Adapter health instrumentation unified to resolve auth denial drift** — Market data service REST operations now properly trigger AUTH_DENIED on API key rejection or IP allowlist denial instead of looping on transient errors; centralized instrumentation in health-monitor.js eliminates code duplication.
- **[issue-349] Example config presets align with canonical regime preset contract** — Removed dead `aggressivenessPresets` block from `exchanges.coinbase`, updated `global.aggressivenessPresets` to match the canonical preset with correct `maxCycleBuys` limits (10/15/25/50), added missing fields (`entryOffsetUpBps`, `entryOffsetDownBps`, `orderStaleMs`, `mergeProximityScale`), and removed obsolete `baseSizeUsdc` field to prevent 10x capital exposure on fresh deployments.
- **[issue-348] DCA completion estimates use canonical intervals** — Share backend durations and dashboard/editor/backtest options, correcting 10-minute, 30-minute, and 4-hour projections and adding the missing 30-minute editor option.
- **Native production setup installs PM2 before starting services** — The README now identifies PM2 as a separate prerequisite and includes its installation command; installing project dependencies alone does not provide the required executable.
- **[issue-338] Streaming optimizer winners use domain ranking** — Keep Current Best consistent with completed results by preferring full coverage before total value and retaining the first result on ties.
- **[issue-336] Trade History retains rejected edits** — Reuse dashboard actions for save/delete feedback, preserve the editor on failures, and disable conflicting controls while mutations are pending.
- **[issue-334] TP minimum checks use shared increment rounding** — Preserve valid minimum-size sells and holdback at floating-point boundaries while keeping genuinely sub-minimum bodies eligible for dust consolidation.
- **Generated release notes link to versioned setup instructions** — Replace the broken copy-and-start recipe with the release's README guide for installation, operator enrollment, exchange credentials, and building the dashboard.
- **[issue-325] Daily candle refresh replaces stale prices** — Share incoming-wins merging with backtests and revalidate disk history once per store instance to repair frozen daily snapshots.
- **[issue-323] Aggressiveness presets share field validation with fund application** — Preserve merge proximity through preset saves, reject incompatible ranges before saving, and expose the preset merge proximity control.
- **[issue-321] Live and historical scorecard analytics share outcome interpretation** — Move pure scoring and historical aggregation into one domain owner, restoring legacy perp accuracy while preserving explicit scratches, contract settlement, and paper P&L.
- **[issue-316] Partial sells retain tracking until terminal status is verified** — Reconcile cancellation failures against order status and open orders, wait for complete final fills, and retry partially filled Gemini orders before resizing or placing a replacement.
- **[issue-316] Off-book Gemini orders always resolve to a terminal status** — An order Gemini reports as no longer live, without explicitly flagging it cancelled, previously normalized to `UNKNOWN`. Because the partial-sell freeze only stops tracking an order on terminal evidence, such an order could never be reconciled: the fill was never ingested and the body was never reprotected. It now normalizes to `EXPIRED`, which the engine already treats as a terminal cancellation, and a response missing its size fields no longer reads as a zero-size fill. Startup and reconcile recovery accept `EXPIRED` alongside `CANCELLED`/`FAILED`, and one body whose cancellation stays unresolved no longer aborts offline recovery for the bodies behind it. Coinbase and Gemini status normalization is now covered end-to-end by fixture adapters driven from raw exchange payloads.
- **Large body roll-ups no longer rewrite the fill ledger for every buy** — TP placement persists all buy-to-sell links in one batch, preventing long engine stalls and false gateway timeouts. Roll-up requests also allow time for verified exchange cancellations.
- **UpDown validation and safety** — Expired contracts remain in the no-trade zone; an invalid paper-book close preserves the position for retry. Historical baseline drawdown now reports dollars instead of treating P&L as account equity, and an evaluation beyond available candles no longer replays warmup data.

### Validation
- **Read-only UpDown walk-forward harness** — Explicit input hash, strict candle integrity, complete timeframe buckets, isolated replay clocks, next-minute fills, configurable fees/slippage, non-overlapping direction metrics, chronological threshold selection, and baseline/buy-and-hold/cash comparisons. No automatic strategy promotion or live state changes.

### Security
- **[issue-285] Bounded simulation requests and active jobs** — Backtest and optimizer APIs now validate every caller-provided limit, cap grid-search work, serialize jobs per fund, and return actionable busy or retry responses before expensive market-data work starts.

### Changed
- **[issue-314] Routes, UpDown, Sentinel, IPC, caches, and the notifier now log through the canonical structured logger** — The remaining non-core modules route every line through `createContextLogger` instead of the bare `log(level, message)` helper. Operator-visible message text is unchanged; each event now also carries `module` plus the context that scope genuinely has — `route` and `action` for API handlers, `exchange`/`pair` for fund-scoped endpoints, and `peer`/`channel` for IPC — so a centralized sink can filter without parsing message prefixes.
- **[issue-253] Core trading modules now log through the canonical structured logger** — Order placement and reconciliation, the DCA cycle, and the exchange engine's connectivity, safety-pause, and auto-resume paths route every line through `createContextLogger` instead of the bare `log(level, message)` helper. Operator-visible message text is unchanged; each event now also carries `module`, `exchange`, `pair`, and — on failures — the order id and error, so a centralized sink can filter by fund without parsing message prefixes.
- **[issue-289] Dashboard pages now load on demand** — The admin console keeps route-only charts, backtesting, optimization, and fund pages out of the initial download, then shows one consistent loading state while each destination opens.
- **[issue-284] Removed unreachable legacy price socket hooks** — The admin bundle no longer carries unused Coinbase, composite-price, or generic price-subscription hooks that could invite duplicate Socket.IO connection paths.
- **UpDown now distinguishes signal strength from calibrated confidence** — The dashboard and analysis surfaces label the heuristic composite as signal strength, publish the canonical indicator/timeframe catalog, and identify the historical backtest as a static-strategy baseline rather than evidence for the live adaptive model.
- **Moved off ports 5563-5567 to 5570-5574** — the old block sat inside the range PortOS reserves for its own extensions, where `:5563` is claimed by an on-demand Eidoverse bridge. Because Critical Mass bound `127.0.0.1` and the Tailscale address explicitly while PortOS bound the wildcard, both listeners started without an `EADDRINUSE` and the specific bind silently won every connection — so PortOS's bridge served nothing and its Eidoverse page loaded the Critical Mass admin UI instead. The gateway, admin UI, and the three engine IPC sockets now use 5570-5574, inside the documented user-application range. Anything pinning the old ports (bookmarks, `GATEWAY_URL`, `CORS_ORIGINS`, reverse proxies, the Umbrel manifest) needs updating.

### Security
- **Fund-scoped routes now require configured pair identities** — Gateway and IPC pair resolution rejects traversal, absolute paths, arrays, malformed values, and unconfigured funds before they reach engine state. Per-fund path helpers also refuse paths outside an exchange data directory (#280)
- **[issue-279] Operator setup now requires a trusted bootstrap channel** — An uninitialized gateway keeps APIs locked and binds loopback-only unless a one-time out-of-band bootstrap secret enables remote enrollment; removing the password returns to protected local setup instead of exposing the gateway.
- **Safer local service and automation boundaries** — The gateway now binds to loopback by default, Docker host publishing is loopback-only, state files are atomically replaced with owner-only permissions, CI actions use immutable revisions, and startup refuses foreign port occupants instead of killing them. The vulnerable development dependency chain was also removed.

### Fixed
- **[issue-292] Regime actions now reserve touch-safe mobile targets** — Reset, Close Fund, Stop, Reopen, and Start keep their compact desktop hierarchy while exposing at least 44px-high controls on narrow screens.
- **[issue-291] Operator session checks now show immediate loading feedback** — Slow gateway startup no longer leaves operators staring at a blank screen while the admin console verifies their session.
- **[issue-290] Configuration controls now announce their labels and state** — Form fields expose their visible labels and hints to assistive technology, while custom toggles report their accessible name and on/off state without changing keyboard behavior.
- **[issue-287] UpDown trade amounts now reject malformed numeric input** — Cost and return fields accept finite numbers and documented sums while keeping the form open with a visible field error for values such as `500usd` or `1++2`.
- **[issue-281] Merge-snapshot fills retain live take-profit protection when cancellation fails** — A rejected or unconfirmed resize cancellation now keeps the existing sell order represented and cannot place a second replacement order.
- **UpDown screenshot analysis no longer consumes disk indefinitely** — Uploaded screenshots are processed transiently in memory and are never retained after successful or failed AI analysis (#286).
- **[issue-282] Scorecard retention now reports actual deletion outcomes** — Failed journal deletions include the affected filename and error, successful deletions remain accurately counted, and one failure no longer prevents later expired journals from being pruned.
- **UpDown prediction scoring is causal and fail-closed** — Historical replay uses only candles complete at each prediction time, preserves the original clock, includes weekly inputs, deduplicates reruns, and rejects candle gaps. Live scoring waits for fresh prices, settles contract calls at their actual expiry, ignores legacy one-hour contract outcomes, prevents pre-target recovery leakage, keeps hydration idempotent, and no longer mutates adaptive weights when an operator merely polls metrics.
- **UpDown runtime and dashboard state are honest after stalls and restarts** — Service lifecycle generations prevent late async startup from resurrecting timers, stale marks pause predictions and paper fills, expired contracts are called out explicitly, failed API requests remain visible, and Crypto.com option premium is no longer mistaken for the BTC perpetual entry price.
- **Operator authentication persists across visits** — A successful sign-in now keeps the browser authenticated with a rolling 30-day, signed HttpOnly session. Page-load session checks renew the cookie, while password changes and explicit sign-out still revoke it.
- **UpDown flattens when a BUY clip fades** — NEUTRAL/HOLD while still long was "stay in the trade," so the paper book rode the whole dump without a CLOSE. Losing BUY now prints CLOSE; the next BUY is a fresh OPEN.
- **Gateway is reachable on Tailscale again** — loopback-only bind had dropped `http://100.x:5563` and MagicDNS `http://<machine>.ts.net:5563`. The gateway now listens on 127.0.0.1 plus Tailscale 100.64/10, and CORS/Socket.IO allow `*.ts.net` and 100.x origins. LAN/WAN stay unpublished unless `HOST=0.0.0.0`.
- **UpDown history no longer prints OPEN until after CLOSE** — old BUY rows were labeled OPEN as if the book were always flat. History is walked oldest-first (Open → Hold/Add → Close → Open).
- **UpDown published signals no longer chatter around the ±15 line** - BUY/SELL now require 60s/15s of raw agreement before printing, stay printed through 14.x fade (drop BUY only below score 12, or after 60s of HOLD), and 5s −20 SELL flashes are ignored. Tick-momentum may still boost a live score but cannot create or cancel a type, and cannot shove HOLD across the BUY line. 1h EMA trend filter accepts 199 completed hours (the live steady state with one hour still forming) instead of forcing FLAT/ema=0. Replay of 2026-08-21's journal: 59 raw BUY episodes → 3 stable clips.
- **UpDown scorecard no longer journals a BUY the banner never showed** - the 60s sampler has its own hysteresis clock, so two interval ticks could confirm BUY while the live 5s engine stayed HOLD. Journal type is now aligned to the live published signal.
- **UpDown hysteresis survives process restart** - published BUY/SELL state is persisted with the rest of updown-state.json, so a PM2 bounce no longer dumps a live clip to HOLD.

### Changed
- **Operator sign-in is off until you set a password** — `OPERATOR_TOKEN` is gone. Missing env no longer crashes the gateway. Set or clear a password on the Gateway page; the hash is stored in `data/operator-auth.json`, never as an environment variable.
- **UpDown prints Open / Add / Hold / Close for BTC perp longs** — BUY while flat is OPEN, BUY while already long is ADD, any non-BUY while long is CLOSE (NEUTRAL included — a faded BUY clip flattens so the next BUY is a new OPEN). Flat + SELL is HOLD (never a short). Paper book buys one 0.01 BTC contract on each Open or Add and flattens on Close.
- **Critical trading alerts now carry structured context** — Order failures, WebSocket faults, safety pauses, and recovery/reconciliation events retain their familiar operator messages while adding exchange, pair, order, and error metadata through the centralized logger (#253)
- **Market-data reconciliation and fill-ledger logs now carry structured context** — Fill ingestion, retry, persistence, lifecycle, and cycle-repair messages retain their operator-facing text while adding fund, order, trade, path, and error metadata (#253)
- **Regime decision and analytics logs now carry structured context** — Macro and micro regime transitions, risk controls, APY tracking, and optimizer lifecycle events retain their operator-facing text while adding fund and metric/error metadata (#253)
- **Regime execution and reconciliation logs now carry structured context** — Startup recovery, fill handling, order reconciliation, lifecycle controls, and operator actions retain their familiar messages while adding fund, order, body, status, and error metadata (#253)
- **Order and WebSocket lifecycle logs now carry structured context** — Entry and take-profit placement, cancellation and fill recovery, plus exchange connection, subscription, and retry events retain their familiar messages while adding fund and outcome metadata (#253)
- **Exchange REST adapter logs now carry structured context** — Coinbase retries, Gemini heartbeat and candle/fill failures, and Crypto.com order/fill lifecycle events retain their familiar messages while adding endpoint, pair, order, retry, and error metadata (#253)
- **Persistent trading-state logs now carry structured context** — Regime and dry-run state, chart buffers, and closed/manual trade stores retain their familiar messages while adding fund, file, version, count, order, and error metadata (#253)
- **Dry-run execution and celestial lifecycle logs now carry structured context** — Simulated orders, fills, cycle analytics, state transitions, and body promotions retain their familiar messages while adding fund, order, fill, body, tier, and P&L metadata (#253)
- **Configuration and shared utility warnings now carry structured context** — Last-good config fallback, JSON parse failures, and mutex deadlock auto-release alerts retain their familiar text while adding module, file, timeout, and error metadata (#253)
- **DCA conversion backup preparation is shared across replace and merge modes** - Both paths now use one tested helper while retaining their mode-specific operator logs (#254)
- **UpDown engine is UP-only and tick-to-tick** — 1m/3m/5m now inherit the 1h EMA trend (overbought in an uptrend is confirmation, not a fade). A 15m/1h MACD+OBV / EMA bearish gate caps new BUY signals at NEUTRAL. SELL is EXIT (held long) or STAND ASIDE (flat) — never "BUY DOWN". Scorecard scores only UP calls; 1m/5m are the primary windows; options accuracy treats a no-move as a miss (CDC Up option) while perp accuracy treats it as a scratch (Coinbase flip).

### Added
- **UpDown paper-book P&L monitor** — `scripts/updown-pnl-snapshot.js` snapshots 0.01-BTC-per-contract mark-to-market P&L (`PROFITABLE` / `UNDERWATER` / `FLAT` / `NO_FILLS`). `--reset-book` zeros the live book so a new algorithm is scored from 0 invested (next BUY is OPEN); `--hydrate-state` remains available to replay history. New history rows store `price`. Historical signal badges are labels only — they do not open a position.
- **Authenticated operator gateway** — Every API route and Socket.IO connection now requires an operator session or bearer token. AI provider secrets are redacted, shell-backed CLI providers are blocked, workspaces are confined, and outbound AI endpoints require an explicit allowlist (#251)
- **Multi-pair funds (BREAKING DATA LAYOUT)** — A "fund" is now identified by `(exchange, pair)` instead of just `exchange`. One exchange can host multiple funds (e.g. BTC-USDC and ETH-USDC on Coinbase), each with its own regime config, state, fill ledger, lifecycle, and dashboard. **Requires a one-time on-disk migration** that runs automatically on engine startup. **You must stop the engines before pulling this version** — see `UPGRADE.md` for instructions. Existing single-pair installs continue to work unchanged after migration.
  - New REST endpoints: `GET /api/:exchange/funds`, `POST /api/:exchange/funds`, `DELETE /api/:exchange/funds/:pair`
  - All existing per-exchange routes accept an optional `?pair=` query parameter; default falls back to the exchange's first/legacy pair
  - New "Add Fund" button in the admin Overview opens a modal to create a new fund on an existing exchange
- **Drain-and-Close fund lifecycle** — Each fund has a `lifecycle` field (`active` / `draining` / `closed`). The "Close Fund" button in the admin header marks the fund draining: blocks new entries immediately, leaves the active take-profit order in place, and when the cycle's TP fills the engine auto-stops and the fund transitions to `closed`. Reopening requires an explicit click. New IPC channels: `regime:close`, `regime:reopen`. New REST endpoints: `POST /api/:exchange/regime/close`, `POST /api/:exchange/regime/reopen`.
- **`simpleDcaEnabled` global config flag** - Gates simple DCA strategy behind opt-in flag (default: false); admin UI hides DCA routes/selector when disabled, API guards DCA-only endpoints
- **`onEntryCancelled` callback in order executor** - Regime engine now cleans up pendingEntryOrders when entries are cancelled (stale timeout, refresh, or external cancel)
- **Stale pending-entry purge on engine startup** - Removes saved pending entries that were filled/cancelled while engine was offline

### Fixed
- **[issue-288] Manual UpDown position P&L now fails closed when market data is stale** - The tracker shows an explicit unavailable state for stale, missing, future-dated, or invalid marks and resumes its 0.01-BTC-per-contract calculation only after a fresh price arrives.
- **DCA dashboard mutation controls recover from request failures** - Automation, order sync, consolidation, and regime export actions now re-enable after network or server errors and show actionable operator feedback instead of remaining stuck in a busy state (#283)
- **Crypto.com fill reconciliation** - Manual Trades and ledger sync now retrieve paginated, normalized fills through the same adapter contract as Coinbase and Gemini, so Crypto.com funds can find and import missing exchange fills (#252)
- **Completed trades are filed under the cycle they actually belong to, and dated by when they filled** - A take-profit fill that closes the last position ends the cycle, and the trade was recorded *after* that — so it was stamped with the cycle the fund had already moved on to, and timestamped when the engine booked it rather than when the exchange filled it. A 3.87 BTC sell that filled on Aug 19 was filed three cycles ahead of its own fills, making it look absent from the trade history. Trades now take their cycle and fill time from the sell they close. Existing coinbase records with a mis-stamped cycle have been corrected; P&L figures were never affected
- **Live take-profit orders are no longer orphaned by a false "cancelled" reading** - Coinbase's historical-order endpoint is eventually consistent, so a freshly-placed take-profit could briefly report itself CANCELLED/FAILED while it was genuinely resting on the book. The reconciler trusted that single reading, dropped tracking, and placed a second sell — leaving the original live and the fund double-listed (one order read CANCELLED 6 seconds after placement and stayed open for days). Reconcile now cross-checks the exchange's open-orders list before acting on a terminal status, and treats a failed check as inconclusive rather than as "gone"
- **Legacy `PUT /api/config` validation-parity gap** - The unprefixed legacy route deep-merged `req.body` verbatim into `data/config.json`, letting a client inject arbitrary keys or out-of-range values (e.g. `{amount:-1, holdbackPercent:9999, evilKey:1}`) into the coinbase fund and break the engine. It now runs the same `validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, ...)` allowlist as `PUT /api/:exchange/config` — dropping unknown top-level keys, rejecting out-of-range values with 400, and sanitizing nested `regime` keys against the `REGIME_DEFAULTS` allowlist (unknown regime keys dropped, not rejected, so a stale persisted key can't make a fund unsaveable) (#146)
- **Live candle volume now uses the per-tick delta of the 24h ticker volume, not the raw 24h total** - `candleCache.processTick` was fed `market.volume24h` (the exchange's rolling 24-hour volume) as if it were the increment since the last tick, so `cur.volume += volume` added the entire 24h volume on every tick — ballooning all live (non-seeded) candle volumes and corrupting every volume-derived signal (VWAP, volume surge, OBV). The cache now tracks a per-exchange 24h baseline and feeds `max(0, volume24h - prev)` as the tick's incremental volume (clamped for day-rollover/reconnect window shrink), resets the baseline on reseed, and contributes 0 for exchanges with no usable ticker volume (e.g. Gemini L2 sends `volume24h: 0`) instead of corrupt candles (#161)
- **Dry-run immediate/force state save no longer drops a debounce-queued fund** - `saveState`'s non-debounced branch (and `forceSave`, used on engine shutdown) cancelled/ignored the scheduled debounce timer and wrote only the current fund, discarding any fund queued by an earlier debounced call. Both paths now flush every queued fund before writing (via a shared `flushPendingStates` helper that also backs the debounce timer), so a multi-fund setup can't silently lose a snapshot when one fund saves immediately or force-saves while another is queued (#159)
- **Scorecard reload no longer double-counts neutral predictions** - `loadHistory` set `totalPredictions = predCount` (every `prediction` record, neutrals included), while the live `recordPrediction` path counts neutrals only as skips. After a restart that hydrated from JSONL, `totalPredictions` jumped to include neutrals that were also in `totalSkipped`. Counting is now extracted into a pure `tallyHistory` helper so reload mirrors live counting: `totalPredictions = predCount - skipCount` (#158)
- **`dcaStrategy` config-validator enum matches engine-supported values** - `EXCHANGE_CONFIG_SCHEMA.dcaStrategy.enum` was `['fixed','regime']`, but the engine only branches on `dcaStrategy === 'fibonacci'` ('regime' is never read). Via the validated `PUT /api/:exchange/config` a client could never set the only alternate strategy the engine implements while the inert 'regime' was silently accepted. Enum is now `['fixed','fibonacci']`, aligning with `validateExchangeConfig` (#156)
- **Macro daily-trend slope now measures a real daily trend** - `macro-regime` previously snapshotted the 20-day EMA every ~5-min update cycle and used that as the "previous day's EMA," so the slope term measured a 20-day EMA's movement over 5 minutes (≈0) — silently killing up to 20 points of macro-score range. The slope is now computed statelessly from the daily EMA series (current EMA vs the EMA excluding the still-forming daily candle), making it a true daily-trend signal that's correct from the first update and across engine restarts (#153)
- **Dry-run multi-entry cycle entry price weights by per-cycle volume** - `simulateFill` now tracks each cycle's own accumulated buy quantity (`cycleQty`) and weights the multi-entry average entry price by it, instead of the global cumulative `simulatedTotalBought` (which is never reset on sells). The old basis inflated `entryPrice` on the 2nd+ entry of every cycle after the first, corrupting the operator-facing optimal-TP analytics (`optimalTpPct`/`actualTpPct`/`missedProfitPct`) (#152)
- **UpDown trades reject non-numeric cost/returnAmount** - `POST /api/updown/trades` now returns 400 when `cost` or `returnAmount` isn't a finite number, and `PUT /api/updown/trades/:id` returns 400 for non-numeric `cost`/`returnAmount`/`btcPriceAtExit`, instead of persisting NaN (serialized as null) that misclassified the win/loss filters; mirrors the position route's #108 guard
- **Coinbase getOrderFills size_in_quote handling** - `size_in_quote` is a boolean flag, not a numeric size; fills now convert quote-denominated `size` (e.g. market buys) to base currency and report the quote notional in `sizeInQuote`, mirroring `sync-fills.js` (was `parseFloat(true)` → NaN, corrupting `assetQty`/cost-basis)
- **avgPrice precision for low-priced assets** - Removed premature `roundUSDC` on avgPrice in fill-ledger aggregation so sub-cent assets (e.g. CRO at $0.08) aren't truncated
- **Self-heal body avgPrice on regime startup** - Detects and corrects bodies where avgPrice diverged >0.1% from costBasis/assetQty due to prior rounding
- **Recovery module currency parsing** - Use canonical `getBaseCurrency`/`getQuoteCurrency` helpers instead of fragile string split

### Removed
- **Remove express-rate-limit from admin server** - Single-user local dashboard doesn't need request rate limiting; was causing 429 errors on page load

### Changed
- **Extract shared `isFilledStatus(order)` predicate** - The `status === 'FILLED' || completionPercentage >= 100` fill-detection check was duplicated ~13 times across `regime-engine.js`, `order-executor.js`, and `order-manager.js`. It now lives once in `shared-utils.js` (null-safe, case-insensitive status) with direct unit coverage, replacing every inline occurrence. The `completionPercentage >= 100` arm guards the Coinbase completion-before-status window the reconcile/offline backstops rely on (#107, #155) (#174)
- **Remove baseSizeUsdc from aggressiveness presets** - Base size is now a platform/fund config only, no longer overridden when switching aggressiveness levels

### Fixed
- **Sync test files with btc→asset rename** - Updated 7 test files to match the source code's multi-asset field renames (roundBTC→roundAsset, btcQty→assetQty, totalBTC→totalAsset, etc.), fixing 83 test failures

### Changed
- **Divergence-based liquidity scaling** - Position sizer now scales entry size based on price divergence from average cost basis instead of buy count
  - Old: `1 + (cycleBuys * 0.1)` (scaled with order count, disconnected from market)
  - New: `1 + (divergencePct / divergenceScalePct) * (cap - 1)` (scales when price drops below avg entry)
  - First entry or no avg cost: factor 1.0 (base size)
  - New config param `divergenceScalePct` (default: 5) controls how much divergence reaches the cap
  - Size optimizer simplified to assume factor=1.0 per step (conservative; divergence acts as bonus capacity)

## [2.4.14] - 2026-02-06

### Fixed
- **ATH fetch fails on Coinbase** - Reduced daily candle request from 365 to 349 days to stay under Coinbase API's 350-candle limit

## [2.4.12] - 2026-02-04

### Changed
- **Extended chart windows to 1 hour** - Regime dashboard now shows more history
  - Regime Timeline expanded from 15 minutes to 1 hour
  - Price & ATR Triggers chart expanded from 15 minutes to 1 hour
  - Backend data buffer increased to retain 1 hour of data (4000 points max)

## [2.4.11] - 2026-02-04

### Fixed
- **USDC cap exceeded log spam** - Fixed repeated warning messages when USDC cap is exceeded
  - The warning `Entry blocked: usdc_cap_exceeded` was logging multiple times per second
  - Now logs only once when the cap is first exceeded
  - Resets to log again after cycle completion

## [2.4.8] - 2026-02-04

### Added
- **Enhanced filled orders tables** - More detailed fill information in UI
  - Added "Fill Time" column showing duration from order placement to fill (e.g., "20s", "1m 30s")
  - Added "Net Fee" column for live fills showing fee minus rebate
  - Green highlight when rebate exceeds fee (you earned money!)
  - Tooltip on net fee shows raw fee and rebate breakdown
  - Renamed "Time" column to "Filled" for clarity
  - Full order IDs displayed (removed truncation)
- **Holdback tracking in Transactions page** - Better visibility into BTC reserves
  - Added "Holdback" column showing BTC kept as reserves on sell transactions
  - Tooltip displays holdback value in USD
  - Summary section shows total holdback BTC and value across all filtered transactions
  - Helps explain P&L calculations when holdback value contributes to total returns

### Fixed
- **Polling-detected fills showing 0 BTC @ $0** - Fixed bug where fills detected via polling had missing data
  - Root cause: Coinbase eventual consistency - fills API can lag behind order status API
  - Added 2-second retry when getOrderFills returns empty but order status shows filled
  - Added fallback to create synthetic fill from order status data if retry still empty
  - Ensures fill data is captured even when Coinbase fills API is slow to propagate
- **Fill time not captured for polling-detected fills** - Fixed order placedAt not being passed to fill handler
  - Order was deleted from pendingOrders before callback, losing the placedAt timestamp
  - Now captures and passes placedAt in the callback for fill time tracking
- **Total fees shown in totals row** - Added total net fees to buy/sell summary rows for cost visibility

## [2.4.4] - 2026-02-04

### Changed
- **Regime Dashboard layout reorganization** - Improved UI layout for better information hierarchy
  - Configuration Summary moved into 3rd column under Price & ATR chart
  - Orders section changed from side-by-side to vertically stacked layout
  - Filled Orders tables height doubled (128px → 256px) to show more fills
  - Open Orders stays compact (only 1-2 orders at a time)

### Fixed
- **Ladder limit log spam** - Fixed repeated warning messages when ladder limit is reached
  - The warning `Entry blocked: ladder_limit_reached` was logging multiple times per second
  - Now logs only once when the limit is first reached
  - Resets to log again after ladder auto-reset or cycle completion
- **Fills totals calculated from only displayed rows** - Fixed buy/sell totals in UI using sliced array
  - Totals were calculated from only the 10 displayed fills instead of all fills in the cycle
  - Now calculates totals from all fills, then slices for display
  - Headers now show total count (e.g., "Buys (58, showing 10)")

## [2.4.2] - 2026-02-03

### Added
- **Capital tracking improvements** - Better visibility into capital allocation
  - `originalCapital` - True starting capital that never changes, preserved across restarts
  - `availableCapital` - Current cap minus deployed capital (maxUsdcDeployed - totalCostBasis)
  - Dashboard now shows "Original" and "Available" capital in the APY section
  - Helps track how much capital is currently deployable vs locked in positions

### Fixed
- **Crypto.com dry-run orders causing API errors on restart** - Fixed error when checking pending orders on startup
  - Dry-run orders (with IDs like `dry-run-sell-*`) were being passed to the Crypto.com API
  - API returned 40003 "Invalid order_id" since these orders don't exist on the exchange
  - Now filters out dry-run orders before attempting to check their status
- **Health monitor stuck in SAFE mode** - Fixed critical bug where system would never auto-recover from SAFE mode
  - Root cause: `checkHealth()` was never called in regime-engine, preventing automatic exit from SAFE mode
  - Added periodic health check call in metrics updater (runs every 60 seconds)
  - Also fixed `resume()` to work with SAFE mode (previously only worked for PAUSED mode)
  - This caused entries to be blocked indefinitely after WebSocket disconnects
- **TP order not updated after offline buy fills** - Fixed bug where TP order size wasn't updated when buy orders filled while engine was offline
  - Root cause: `checkOfflineOrderFills()` updated position but didn't call `placeTakeProfitOrder()`
  - This caused the TP to sell at its original size, leaving excess BTC as unintended holdback
  - Now properly places/updates TP order after processing offline buy fills
- **Entry orders preserved across restarts** - Entry orders are now persisted and restored instead of being canceled
  - Pending entry orders are saved to `positionState.pendingEntryOrders` immediately when placed
  - On restart, saved entries are restored to order tracking and allowed to fill naturally
  - Partial fills during offline periods are properly ingested
  - Orders not belonging to the regime engine (e.g., from DCA engine) are ignored, not canceled
  - This prevents lost opportunities when good limit orders were placed before restart
- **Orphaned TP orders from failed cancels** - Fixed silent failure when canceling old TP before placing new one
  - Cancel failures were ignored, causing new TP to be placed while old one remained on exchange
  - Now logs a warning when cancel fails and keeps the existing TP tracked, refusing to place a new one to avoid duplicate sells

## [2.3.47] - 2026-02-03

### Fixed
- **Fills not showing in UI** - Fixed broken filter that was excluding all fills with cycleIds
  - The filter `!f.cycleId.startsWith('cycle-')` incorrectly excluded all fills since all have cycleIds starting with 'cycle-'
  - Now correctly identifies current cycle by finding the most recent cycleId timestamp
- **Holdback display showing cumulative totals** - Changed holdback to show per-cycle BTC profit instead of running total
  - Each sell row now shows `totalBought - totalSold` for that specific cycle
  - Partial fills are aggregated by orderId for cleaner display
- **Position/P&L not calculated on startup** - Engine now auto-recalculates cycles from fill ledger on startup
  - Ensures accurate P&L tracking without requiring manual "Recalculate from Fills" click
- **APY metrics showing 0 after restart** - Backfills engineStartTime from earliest fill in ledger
  - APY calculations now work correctly even after engine restarts

## [2.3.25] - 2026-02-02

### Fixed
- **NaN position state corruption after fill processing** - Fixed critical bug where position state (avgCostBasis, totalCostBasis) became NaN after processing fills
  - Root cause: `aggregateFills()` was called with raw adapter fills (which have `sizeInQuote`) instead of ingested fills (which have `quoteAmount`)
  - Fixed in `handleOrderFill()`, `checkOfflineOrderFills()` for both TP and entry orders
- **Ghost TP orders after restart** - Engine now validates saved TP order exists on Coinbase before restoring
  - If order was cancelled/failed, clears tracking so a new TP order gets placed
  - Prevents UI showing orders that don't exist on exchange
- **Auto-TP placement after recovery** - Engine now places TP order after metrics update when position exists but no active TP order
  - Previously, TP orders were only placed after buy fills, leaving recovered positions without TP protection
- **Recovery now uses all fills** - Changed recovery to use `fillLedger.getAllFills()` instead of just current cycle fills
  - Fixes issue where restored state showed no fills because `currentCycleId` was null

### Added
- **TP order validation on startup** - Validates saved TP order exists on exchange before restoring tracking
- **restorePendingOrder API** - Added to order executor to restore TP order tracking after recovery

## [2.3.24] - 2026-02-02

### Fixed
- **Regime engine dryRun config path** - Regime engine now reads `dryRun` from exchange-level config (same as DCA engine)
  - Previously, UI toggle modified `exchanges.coinbase.dryRun` but regime engine read from `exchanges.coinbase.regime.dryRun`
  - This caused the "Dry Run" toggle to not affect the regime engine
  - Both engines now use the same config path, making the UI toggle work correctly for all strategies
- **Regime Dashboard not reflecting dryRun toggle changes** - Dashboard now receives dryRun from exchange config
  - `/api/:exchange/regime/config` endpoint now includes exchange-level dryRun value
  - UI correctly displays "Dry-Run Mode" or "Live" based on current config
- **Coinbase API endpoint change** - Updated list orders endpoint to use new batch endpoint
  - Old: `/api/v3/brokerage/orders/historical?product_id=X`
  - New: `/api/v3/brokerage/orders/historical/batch?product_ids=X`
  - This fixes 404 errors when starting the regime engine in live mode
- **Recovery no longer absorbs full account balance** - Position only tracks what regime engine traded
  - Previously, recovery would overwrite position with full account BTC balance
  - Now only fills from regime engine trades are tracked
  - Account having extra BTC from other sources is logged but not absorbed into position
- **Stop endpoint error handling** - Added proper error handling and logging for stop requests
- **Duplicate entry orders race condition** - Added lock to prevent concurrent entry evaluations from rapid ticker updates
- **Pending orders not showing in live mode UI** - Added `getPendingOrdersList()` to order executor and updated dashboard to show orders for both live and dry-run modes
- **Unhandled promise in reconciliation interval** - Reconciliation now catches errors and continues operating
  - Added `isRunning` guard to prevent reconciliation after engine stop
  - Errors are logged instead of causing unhandled rejections
- **Unhandled promise in stale order timeout** - Stale order checks now catch errors gracefully
  - Converted async/await to Promise chain with `.catch()` for proper error handling
- **WebSocket malformed JSON crash** - Added safe JSON parsing for WebSocket messages
  - Invalid JSON now logs a warning and is ignored instead of crashing
- **Cancel all entries partial failure** - Cancel loop now continues on individual failures
  - Uses `Promise.allSettled()` to attempt all cancels even if some fail
  - Failed cancels are logged and orders removed from tracking (may have already filled/cancelled)
- **State not persisted immediately after fills** - Added immediate state persistence on order fills
  - Both buy fills and TP fills now trigger immediate state save and fill ledger persist
  - Prevents data loss if process crashes after a fill but before next periodic save
- **Offline fills check failure blocking startup** - Startup continues even if offline fill check fails
  - Error is logged but doesn't prevent engine from starting
  - Fills will be detected on next reconciliation cycle
- **Regime engine showing DCA orders in Open Orders** - Fixed order isolation between engines
  - Regime engine was absorbing ALL open orders from Coinbase during recovery
  - Now only tracks orders it places itself, ignoring orders from DCA engine
  - Orders from other engines (like standard DCA) are no longer displayed or tracked
- **Stop Engine button not updating UI** - UI now properly reflects stopped state
  - Socket status was taking precedence over fetched status after stop
  - Now clears socket status when engine stops so UI shows correct state
- **Ghost orders in UI** - Orders that exist in UI but not on exchange
  - Post-only orders can be immediately cancelled by Coinbase if they would cross the spread
  - Now verifies order status after placement before adding to pending orders
  - If order was immediately cancelled, retries with fresh prices
- **Filled orders not detected** - Orders would fill but engine didn't process them
  - Stale order timeout now detects FILLED status and triggers fill processing
  - Added `checkPendingOrderFills()` method for periodic fill detection backup
  - Reconciliation interval now checks for missed fills every 5 minutes
  - `onFillDetected` callback wired up to handle fills detected via polling
  - Status comparison now case-insensitive to handle varying API response formats

### Added
- **Dynamic entry offset based on momentum** - Entry bid offset now adapts to market direction
  - When momentum is UP: uses smaller offset (`entryOffsetUpBps`, default 5bps) to get fills before price rises
  - When momentum is DOWN: uses larger offset (`entryOffsetDownBps`, default 15bps) to catch falling price
  - When momentum is NEUTRAL: uses default offset (`entryOffsetBps`, default 10bps)
  - Momentum calculated from 1-minute candles (short and long period price returns)
  - Logs now show `momentum=up/down/neutral offset=Xbps` for debugging

### Changed
- Removed redundant `dryRun` field from regime config defaults (now inherited from exchange config)

## [2.3.20] - 2026-02-01

### Added
- **Auto-resume regime engine on server restart** - Engine automatically resumes if it was running before restart
  - Running flag saved when engine starts, removed when manually stopped
  - Server restarts preserve flag to enable auto-resume
- **Total liquid value for APY calculations** - APY now based on combined USDC + BTC (at current price)
  - `totalUsdcReturn` - USDC realized P&L from trading
  - `totalBtcReturn` - BTC holdback accumulated
  - `btcValueUsd` - BTC holdings valued at current market price
  - `totalLiquidValue` - Combined value (USDC + BTC at live price) used for APY projections
  - UI shows breakdown: USDC return, BTC return with USD equivalent, and combined "Live Total"
- **Dynamic TP Auto-Management** - Opt-in feature for automatic take-profit parameter adjustment
  - Records cycle analytics (optimal TP %, actual TP %, volatility context)
  - Compresses historical data into histogram buckets with time-weighted decay
  - Calculates percentiles (p25, p50, p75) from compressed + recent data
  - Periodic evaluation every N cycles (default: 5) or daily (whichever first)
  - Rate-limited adjustments (max 25% change per evaluation)
  - Safety bounds: absolute min (0.05%), absolute max (5.0%)
  - Auto-holdback set to half of tpMinPercent when auto-adjusted
  - State persisted across restarts
  - Dashboard panel shows current settings, observed percentiles, adjustment history
  - Config UI with enable toggle and all adjustment parameters

### Changed
- Performance Metrics UI redesigned to show USDC, BTC, and total liquid value separately
- Est. Daily Return now labeled "(Live Value)" to indicate it's based on combined liquid value
- BTC values now displayed with 8 decimal places for precision

## [2.3.19] - 2026-02-01

### Added
- Estimated daily USDC and BTC returns in APY metrics
  - `estimatedDailyUsdc` - projected daily USD return based on current performance
  - `estimatedDailyBtc` - projected daily BTC return (holdback accumulation rate)
  - UI displays both values alongside daily return percentage (in sats for BTC)

## [2.3.17] - 2026-02-01

### Added
- APY and performance tracking for regime engine
  - Tracks engine start time and initial capital
  - Calculates total return, daily return %, estimated annual return, and compound APY
  - Persists tracking across restarts
  - UI displays performance metrics in Position section with highlighted APY/annual return

### Fixed
- APY tracking now properly persists `engineStartTime` across restarts
- APY backfill logic: if engine started before APY tracking was added, automatically backfills start time from first filled order
- Added `engineStartTime` and `initialCapital` to PositionState typedef for proper type checking

## [2.3.16] - 2026-02-01

### Added
- Live state persistence for regime engine - saves position and regime state to `regime-state.json` for faster recovery on restarts
- Offline order fill detection - checks for TP and entry orders that filled while the engine was offline
- Market re-evaluation on startup - re-anchors volatility triggers after downtime and logs price movement warnings
- `restoreState()` method to regime-detector for restoring regime mode on restart
- `getPendingEntries()` method to both order-executor and dry-run-executor for tracking pending entry orders

### Changed
- Live mode startup now: loads saved state → recovers from exchange → checks offline fills → re-evaluates position
- Periodic state saves every 5 minutes for live mode (dry-run unchanged at 60 seconds)

## [2.3.5] - 2026-02-01

### Added
- Responsive layout for admin dashboard (1280px → 1600px → 1800px breakpoints)
- Live D3.js charts for Regime Dashboard: price sparkline, volatility chart, regime timeline
- `useChartDataBuffer` hook for 15-minute rolling WebSocket data accumulation
- 4-column layout on 3xl screens (1920px+) with dedicated charts column

## [2.3.0] - 2026-01-31

### Added
- Fibonacci DCA strategy - alternative to fixed-amount DCA using Fibonacci sequence for buy amounts (1, 1, 2, 3, 5, 8, 13... × base amount)
- Consolidated sell order per Fibonacci cycle with weighted-average cost basis pricing
- Automatic cycle reset when consolidated sell fills, enabling continuous volatility harvesting
- Fibonacci backtest simulation with cycle tracking and Fibonacci-specific metrics
- Strategy selector in admin UI with detailed risk disclosure about the volatility-harvesting approach

## [2.2.1] - 2026-01-31

### Fixed
- Hardcoded "BTC" in order consolidation logs now dynamically uses actual trading pair currency (e.g., CRO)

## [2.2.0] - 2025-01-31

### Fixed
- Crypto.com API big integer precision loss - order IDs exceeding JavaScript's MAX_SAFE_INTEGER are now preserved as strings
- Crypto.com order status parsing - corrected field access path for nested `order_info` response structure
- Crypto.com order field mappings updated to use `cumulative_quantity`, `cumulative_value`, and `cumulative_fee`

### Added
- Full timestamp support in transaction logs with automatic schema migration for existing data
- Transactions UI now displays full datetime (YYYY-MM-DD HH:MM:SS) when timestamp data is available

### Changed
- Force IPv4-first DNS resolution (`--dns-result-order=ipv4first`) for API stability
- TSV parser preserves Timestamp column as string alongside Date

### Chores
- Added `.playwright-mcp` to .gitignore

## [2.1.1] - 2025-01-25

### Fixed
- Add 1hour interval type to estimated end date calculation

## [2.1.0] - 2025-01-23

### Added
- Crypto.com exchange adapter
- Optimizer enhancements
- UI improvements

## [2.0.0] - 2025-01-22

### Added
- P&L metrics (unrealized $, unrealized %, realized)
