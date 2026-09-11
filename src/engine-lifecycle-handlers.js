// @ts-check
/**
 * Engine IPC lifecycle handlers: `regime:start` / `regime:stop`.
 *
 * Extracted from engines/coinbase-engine.js (issue #504) so the ownership
 * ordering these two handlers enforce — standalone fill-consumer handover
 * around engine stop, failure teardown, and post-stop retry — can be
 * exercised directly against the real production callbacks instead of only
 * through HTTP-proxy tests (which stub IPC) or isolated service tests
 * (which never invoke these handlers at all). Behavior is unchanged from the
 * inline handlers this replaces; every dependency below is injected so
 * `regime:start`/`regime:stop` for other exchange processes (gemini,
 * cryptocom) keep working unmodified.
 */

/**
 * @typedef {Object} EngineLifecycleDeps
 * @property {Map<string, Object>} regimeEngines - Active regime engines keyed by `${exchange}::${pair}`
 * @property {(exchange: string, pair: string) => string} resolvePair - Resolves an IPC pair to its configured fund pair; throws on an invalid pair
 * @property {(exchange: string, pair: string) => string} fundKey - Composes the `${exchange}::${pair}` registry key
 * @property {(exchange: string, pair: string) => string} fundLabel - Human-readable `exchange/pair` label for logs
 * @property {(exchange: string, pair: string) => {info: Function, warn: Function, error: Function}} logger - Context logger factory
 * @property {(exchange: string, pair: string) => Object} getFundConfig - Loads merged fund configuration
 * @property {(exchange: string) => {hasValidKeys?: () => boolean}} getAdapter - Exchange adapter factory
 * @property {(exchange: string, pair: string) => {position?: {lifecycle?: string}}} loadRegimeState - Loads on-disk regime state for a fund
 * @property {{CLOSED: string}} LIFECYCLE - Fund lifecycle constants
 * @property {(exchange: string, pair: string, fundConfig: Object, callbacks: Object) => Object} createRegimeEngine - Regime engine factory
 * @property {(exchange: string, pair: string) => Object} createEngineCallbacks - Builds the callbacks handed to a new regime engine
 * @property {(exchange: string, pair: string) => Promise<{success: boolean, error?: string, message?: string}>} startMarketDataService - Starts the standalone market-data service for a fund
 * @property {(exchange: string, pair: string) => void} stopMarketDataService - Stops the standalone market-data service for a fund
 * @property {(exchange: string, pair: string) => void} wireMarketDataCallbacks - Wires a running standalone market-data service's callbacks
 * @property {(exchange: string, pair: string) => void} invalidateStandaloneLedger - Drops the cached standalone fill ledger for a fund
 * @property {(exchange: string, pair: string, isRunning: boolean) => void} saveRegimeRunningFlag - Persists the fund's running flag to disk
 */

/**
 * Register the `regime:start` and `regime:stop` IPC request handlers on a
 * registry (the engine's IPC server, or any object exposing the same
 * `onRequest(channel, handler)` surface — e.g. a fake registrar in tests).
 *
 * @param {{onRequest: (channel: string, handler: (payload: any, exchange: string, pair: string) => Promise<any>) => void}} registry
 * @param {EngineLifecycleDeps} deps
 */
const registerEngineLifecycleHandlers = (registry, deps) => {
  const {
    regimeEngines,
    resolvePair,
    fundKey,
    fundLabel,
    logger,
    getFundConfig,
    getAdapter,
    loadRegimeState,
    LIFECYCLE,
    createRegimeEngine,
    createEngineCallbacks,
    startMarketDataService,
    stopMarketDataService,
    wireMarketDataCallbacks,
    invalidateStandaloneLedger,
    saveRegimeRunningFlag,
  } = deps;

  registry.onRequest('regime:start', async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const key = fundKey(exchange, resolvedPair);
    const label = fundLabel(exchange, resolvedPair);
    const fundLogger = logger(exchange, resolvedPair);

    if (regimeEngines.has(key)) {
      return { success: false, error: 'Regime engine already running for this fund' };
    }

    // Refuse to start a closed fund — operator must reopen it first.
    const savedState = loadRegimeState(exchange, resolvedPair);
    if (savedState?.position?.lifecycle === LIFECYCLE.CLOSED) {
      return { success: false, error: 'Fund is closed — call regime:reopen before starting' };
    }

    const fundConfig = getFundConfig(exchange, resolvedPair);
    const adapter = getAdapter(exchange);

    if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
      return { success: false, error: 'API keys not configured for this exchange' };
    }

    // createRegimeEngine builds its fill ledger eagerly in the constructor
    // (regime-engine.js:226). createFillLedger refuses to boot on cold-start
    // corruption, so a corrupt ledger file would otherwise bubble up through
    // the IPC framework. Catch it and return a per-fund failure so other
    // funds in this engine process stay usable. Log full detail server-side
    // and return a sanitized message to the client so we don't leak the
    // absolute ledger path / parser internals across the IPC boundary.
    let engine;
    try {
      engine = createRegimeEngine(exchange, resolvedPair, fundConfig, createEngineCallbacks(exchange, resolvedPair));
    } catch (err) {
      fundLogger.error(`❌ [${label}] Fill ledger init failed on regime:start: ${err.message}`, { error: err.message });
      return { success: false, error: `Fill ledger init failed for ${exchange}/${resolvedPair} — see engine logs for details` };
    }
    regimeEngines.set(key, engine);

    const startResult = await engine.start();

    if (!startResult.success) {
      regimeEngines.delete(key);
      return { success: false, error: startResult.error || 'Failed to start regime engine' };
    }

    // Auto-close: engine detected a drained fund and closed it instead of running
    if (startResult.autoClosed) {
      regimeEngines.delete(key);
      fundLogger.info(`ℹ️ 🛑 [${label}] Fund auto-closed (empty draining position)`);
      return { success: true, exchange, pair: resolvedPair, autoClosed: true };
    }

    stopMarketDataService(exchange, resolvedPair);
    invalidateStandaloneLedger(exchange, resolvedPair);
    saveRegimeRunningFlag(exchange, resolvedPair, true);

    fundLogger.info(`ℹ️ 🚀 [${label}] Regime engine started`);
    return { success: true, exchange, pair: resolvedPair, status: engine.getStatus() };
  });

  registry.onRequest('regime:stop', async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const key = fundKey(exchange, resolvedPair);
    const label = fundLabel(exchange, resolvedPair);
    const fundLogger = logger(exchange, resolvedPair);

    const engine = regimeEngines.get(key);
    if (!engine) {
      return { success: false, error: 'Regime engine not running for this fund' };
    }

    fundLogger.info(`ℹ️ 🛑 [${label}] Stopping regime engine...`);

    // Spin up the standalone market-data-service for fill-handover during
    // shutdown. If the on-disk fill-ledger is corrupt, createFillLedger
    // throws on cold start (refuses to boot empty); startMarketDataService
    // surfaces that as { success: false, error }. Skip wiring callbacks
    // and proceed to engine.stop() anyway — the operator's stop intent
    // takes precedence over the handover, and the running engine still
    // has its own (good) in-memory ledger to flush.
    const mdsResult = await startMarketDataService(exchange, resolvedPair);
    if (mdsResult?.success) {
      wireMarketDataCallbacks(exchange, resolvedPair);
    } else {
      fundLogger.warn(`⚠️ [${label}] Standalone market-data-service did not start (${mdsResult?.error || 'unknown'}); proceeding with engine stop, will retry handover after stop in case its persist repaired a corrupt ledger`, { error: mdsResult?.error || 'unknown' });
    }

    const stopResult = await engine.stop().catch((err) => {
      fundLogger.error(`❌ [${label}] Error stopping engine: ${err.message}`, { error: err.message });
      return { error: err.message };
    });

    if (stopResult?.error) {
      // Engine stop failed but the standalone market-data-service we just
      // started is now running independently. Without tearing it down, the
      // engine remains registered AND the WS service is also processing
      // events for the same fund — two live processors that can double-
      // ingest fills and emit conflicting status until the process is
      // restarted. Stop the standalone service before returning so the
      // operator can retry from a single-processor state.
      if (mdsResult?.success) {
        stopMarketDataService(exchange, resolvedPair);
      }
      return { success: false, error: stopResult.error };
    }

    // Retry the standalone WS handover if the initial start failed —
    // engine.stop()'s force-persist may have replaced an unreadable
    // ledger file with a healthy in-memory snapshot, so a second attempt
    // can now read it. Without this retry, the fund would be left with
    // no stopped-engine WS service even though the underlying corruption
    // is now resolved, and any fills/cancels that arrive while the
    // engine remains stopped would be missed until manual restart.
    if (!mdsResult?.success) {
      const retryResult = await startMarketDataService(exchange, resolvedPair);
      if (retryResult?.success) {
        wireMarketDataCallbacks(exchange, resolvedPair);
        fundLogger.info(`ℹ️ ✅ [${label}] Standalone market-data-service started after engine stop`);
      } else {
        fundLogger.warn(`⚠️ [${label}] Standalone market-data-service still not available after engine stop (${retryResult?.error || 'unknown'}) — fund has no WS service while stopped`, { error: retryResult?.error || 'unknown' });
      }
    }

    regimeEngines.delete(key);
    invalidateStandaloneLedger(exchange, resolvedPair);
    saveRegimeRunningFlag(exchange, resolvedPair, false);

    fundLogger.info(`ℹ️ ✅ [${label}] Regime engine stopped successfully`);
    return { success: true, exchange, pair: resolvedPair, stopped: true };
  });
};

module.exports = { registerEngineLifecycleHandlers };
