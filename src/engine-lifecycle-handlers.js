// @ts-check
/**
 * Engine IPC lifecycle handlers: `regime:start` / `regime:stop`.
 *
 * Extracted from engines/coinbase-engine.js (issue #504) so the ownership
 * ordering these two handlers enforce can be exercised directly against the
 * real production callbacks instead of only through HTTP-proxy tests (which
 * stub IPC) or isolated service tests (which never invoke these handlers at
 * all). Automatic and manual starts share the same supervision and cleanup.
 * engines/coinbase-engine.js is the only production registration: the gemini
 * and cryptocom engine processes are thin wrappers that set EXCHANGE_NAME and
 * load it, so every exchange gets the same injected dependencies.
 *
 * Fill-ledger ownership is exclusive (issue #1008). Each consumer loads its
 * own in-memory ledger and every persist replaces the whole file, so two
 * live writers silently erase each other's fills. A handover therefore never
 * overlaps owners: stop drains and flushes the engine BEFORE the standalone
 * consumer loads the ledger, and start fences and joins the standalone
 * consumer BEFORE the engine loads it. The consumer that takes over recovers
 * fills from the connection gap via exchange reconciliation.
 */

const { createFundStartSupervisor, isTransientStartError } = require('./fund-start-supervisor');

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
 * @property {(exchange: string, pair: string) => Promise<{drained: boolean}>} fenceMarketDataService - Stops the standalone service and joins its in-flight start and order work; drained:false when it could not confirm. Required: a fence that cannot join would let two ledger writers overlap
 * @property {(exchange: string, pair: string) => void} wireMarketDataCallbacks - Wires a running standalone market-data service's callbacks
 * @property {(exchange: string, pair: string) => void} invalidateStandaloneLedger - Drops the cached standalone fill ledger for a fund
 * @property {(exchange: string, pair: string, isRunning: boolean) => void} saveRegimeRunningFlag - Persists the fund's running flag to disk
 * @property {(exchange: string, pair: string) => {recovered: boolean}} [recoverPendingImport] - Completes/discards an interrupted DCA import; throws when the fund must stay offline (issue #860)
 * @property {(exchange: string, pair: string) => Promise<{drained: boolean}>} [drainFundWrites] - Waits for accepted fund callbacks before releasing ownership
 * @property {Function} [isPaused] - Retry maintenance gate
 * @property {Function} [setTimer] - Injectable retry timer
 * @property {Function} [clearTimer] - Injectable retry cancellation
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
    wireMarketDataCallbacks,
    invalidateStandaloneLedger,
    saveRegimeRunningFlag,
    fenceMarketDataService,
    drainFundWrites = async () => ({ drained: true }),
    recoverPendingImport = () => ({ recovered: false }),
  } = deps;

  /**
   * Hand a stopped fund to the standalone consumer. Callers must already
   * have drained and flushed the previous owner: the service loads the
   * ledger as part of start().
   */
  const startStandaloneConsumer = async (exchange, pair, fundLogger, label) => {
    // A rejected start (e.g. its candle fetch threw) is a missing consumer,
    // not a failed handover: the previous owner has already let go.
    const result = await startMarketDataService(exchange, pair)
      .catch((err) => ({ success: false, error: err.message }));
    if (!result?.success) {
      fundLogger.warn(`⚠️ [${label}] Standalone market-data-service not available (${result?.error || 'unknown'}) — fund has no WS service while stopped`, { error: result?.error || 'unknown' });
      return result;
    }
    wireMarketDataCallbacks(exchange, pair);
    const unrecovered = result.gapRecovery?.failed || [];
    if (unrecovered.length) {
      fundLogger.warn(`⚠️ [${label}] Handover gap recovery could not confirm ${unrecovered.length} order(s); engine startup reconciliation will recheck them`, { orderIds: unrecovered });
    }
    return result;
  };

  const startAttempt = async (payload, exchange, pair, isCurrent) => {
    const resolvedPair = resolvePair(exchange, pair);
    const key = fundKey(exchange, resolvedPair);
    const label = fundLabel(exchange, resolvedPair);
    const fundLogger = logger(exchange, resolvedPair);

    if (regimeEngines.has(key)) {
      return { success: false, error: 'Regime engine already running for this fund' };
    }

    // Never trade on a mixed DCA-import generation (issue #860): complete or
    // discard an interrupted import first, and stay down if that is unsafe.
    try {
      recoverPendingImport(exchange, resolvedPair);
    } catch (err) {
      fundLogger.error(`❌ [${label}] DCA import recovery failed on regime:start: ${err.message}`, { error: err.message });
      return { success: false, error: `An interrupted DCA import for ${exchange}/${resolvedPair} could not be recovered — see engine logs for details`, needsOperator: true };
    }

    // Refuse to start a closed fund — operator must reopen it first.
    const savedState = loadRegimeState(exchange, resolvedPair);
    if (savedState?.position?.lifecycle === LIFECYCLE.CLOSED) {
      saveRegimeRunningFlag(exchange, resolvedPair, false);
      return { success: false, error: 'Fund is closed — call regime:reopen before starting', needsOperator: true };
    }

    const fundConfig = getFundConfig(exchange, resolvedPair);
    const adapter = getAdapter(exchange);

    if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
      return { success: false, error: 'API keys not configured for this exchange', needsOperator: true };
    }

    // The engine loads the ledger in its constructor, so the standalone
    // consumer must be fenced first and its accepted work joined. If that
    // cannot be confirmed, the old writer may still persist: build nothing.
    const fence = await fenceMarketDataService(exchange, resolvedPair);
    if (!fence?.drained) {
      fundLogger.error(`❌ [${label}] Standalone fill consumer did not finish its in-flight work; engine not started`);
      return { success: false, error: 'Standalone fill consumer is still draining — retry the start shortly', retryable: true };
    }
    invalidateStandaloneLedger(exchange, resolvedPair);
    // Any exit that leaves the fund stopped hands it back to passive
    // monitoring; the engine object (if any) has been released by then.
    const restoreStandalone = () => startStandaloneConsumer(exchange, resolvedPair, fundLogger, label);
    if (!isCurrent()) {
      await restoreStandalone();
      return { success: false, error: 'Engine start cancelled' };
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
      await restoreStandalone();
      return { success: false, error: `Fill ledger init failed for ${exchange}/${resolvedPair} — see engine logs for details`, needsOperator: true };
    }
    regimeEngines.set(key, engine);

    // Retain registry ownership until teardown has completed. A failed stop
    // must block replacement: the old object may still own callbacks/writers.
    const releaseAttempt = async () => {
      const stopped = await engine.stop();
      if (stopped?.error) throw new Error(stopped.error);
      const drain = await drainFundWrites(exchange, resolvedPair);
      if (!drain.drained) throw new Error('Fund startup writers are still draining');
      if (regimeEngines.get(key) === engine) regimeEngines.delete(key);
      invalidateStandaloneLedger(exchange, resolvedPair);
    };
    let startResult;
    try {
      startResult = await engine.start();
    } catch (err) {
      fundLogger.error(`❌ [${label}] regime:start threw during engine startup: ${err.message}`, { error: err.message });
      startResult = { success: false, error: `Engine startup failed for ${exchange}/${resolvedPair} — see engine logs for details`, retryable: isTransientStartError(err) };
    }
    if (!startResult?.success || startResult.autoClosed || !isCurrent()) {
      try {
        await releaseAttempt();
      } catch (err) {
        fundLogger.error(`❌ [${label}] Failed startup cleanup: ${err.message}`, { error: err.message });
        return { success: false, error: 'Engine cleanup failed — operator action required', needsOperator: true };
      }
      // A closed fund has nothing left to watch (mirrors onLifecycleClosed).
      if (!startResult?.autoClosed) await restoreStandalone();
      if (!isCurrent()) return { success: false, error: 'Engine start cancelled' };
      if (startResult?.autoClosed) {
        saveRegimeRunningFlag(exchange, resolvedPair, false);
        return { success: true, exchange, pair: resolvedPair, autoClosed: true };
      }
      return { ...startResult, success: false, error: startResult?.error || 'Failed to start regime engine' };
    }

    try {
      invalidateStandaloneLedger(exchange, resolvedPair);
      saveRegimeRunningFlag(exchange, resolvedPair, true);
      fundLogger.info(`ℹ️ 🚀 [${label}] Regime engine started`);
      return { success: true, exchange, pair: resolvedPair, status: engine.getStatus() };
    } catch (err) {
      fundLogger.error(`❌ [${label}] Failed startup handover: ${err.message}`, { error: err.message });
      await releaseAttempt();
      await restoreStandalone();
      return { success: false, error: 'Engine startup handover failed — operator action required', needsOperator: true };
    }
  };
  const supervisor = createFundStartSupervisor({
    startAttempt, fundKey, resolvePair, regimeEngines,
    saveRegimeRunningFlag, logger,
    isPaused: deps.isPaused,
    setTimer: deps.setTimer, clearTimer: deps.clearTimer,
  });
  const { startFund, autoResumeFund } = supervisor;
  registry.onRequest('regime:start', startFund);

  const stopFund = async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const key = fundKey(exchange, resolvedPair);
    const label = fundLabel(exchange, resolvedPair);
    const fundLogger = logger(exchange, resolvedPair);

    const engine = regimeEngines.get(key);
    if (!engine) {
      return { success: false, error: 'Regime engine not running for this fund' };
    }

    fundLogger.info(`ℹ️ 🛑 [${label}] Stopping regime engine...`);

    // Close engine admission, wait for every accepted fund mutation, and let
    // stop() flush the final state + ledger. Until that succeeds the engine
    // remains the fund's only ledger writer and stays registered, so a failed
    // drain or flush returns failure with no second consumer started.
    const stopResult = await engine.stop().then(async (result) => {
      if (result?.error) return result;
      const drain = await drainFundWrites(exchange, resolvedPair);
      if (!drain.drained) throw new Error('Fund writers are still draining');
      return result;
    }).catch((err) => {
      fundLogger.error(`❌ [${label}] Error stopping engine: ${err.message}`, { error: err.message });
      return { error: err.message };
    });

    if (stopResult?.error) {
      return { success: false, error: stopResult.error };
    }

    // Only now may the standalone consumer load the ledger: it reads the
    // engine's final generation (stop's force-persist also repairs a ledger
    // file that became unreadable mid-run) and recovers any fill that landed
    // between the engine's disconnect and its own subscribe. The engine stays
    // registered until this completes, so no replacement start can enter the
    // transfer. A consumer that cannot start is reported, not fatal — the
    // operator's stop intent takes precedence.
    await startStandaloneConsumer(exchange, resolvedPair, fundLogger, label);

    regimeEngines.delete(key);
    invalidateStandaloneLedger(exchange, resolvedPair);
    saveRegimeRunningFlag(exchange, resolvedPair, false);

    fundLogger.info(`ℹ️ ✅ [${label}] Regime engine stopped successfully`);
    return { success: true, exchange, pair: resolvedPair, stopped: true };
  };
  registry.onRequest('regime:stop', supervisor.wrapStop(stopFund));
  return { startFund, autoResumeFund, getStartStatus: supervisor.getStatus, cancelStarts: supervisor.cancelAll };

};

module.exports = { registerEngineLifecycleHandlers };
