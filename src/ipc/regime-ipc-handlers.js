// @ts-check
/**
 * Regime IPC request handlers.
 *
 * Registers the gateway -> engine `regime:*` request channels (status, pause,
 * resume, close, reopen, ladder, rollup, body TP, config, fills, open orders,
 * dry-run, unaccounted fills, manual trades, dismiss fills, convert DCA) on an
 * engine process's IPC server. Extracted verbatim from
 * engines/exchange-engine.js (issue #1325), following the same pattern as
 * registerEngineLifecycleHandlers / registerEngineRecalculateHandler /
 * registerEngineBackupHandlers. The channel names come from IPC_CHANNELS
 * (ipc-protocol.js) so the gateway and engine sides cannot drift.
 */

const { IPC_CHANNELS } = require('./ipc-protocol');

/**
 * @param {Object} ipcServer - IPC server exposing onRequest(channel, handler)
 * @param {Object} deps - Engine-owned state and collaborators (all injected so
 *   the engine process keeps ownership of its maps, caches and logger)
 * @returns {void}
 */
const registerRegimeIpcHandlers = (ipcServer, deps) => {
  const {
    regimeEngines, resolvePair, fundKey, fundLabel, logger, ioProxy,
    getStartStatus, getStandaloneLedger, getActiveLedger, getManualTradeStore,
    invalidateStandaloneLedger, unaccountedFillsJobs,
    getFundConfig, getRegimeConfig, getMarketDataService, getChartData, getAdapter,
    loadRegimeStateSafe, loadFundRegimeState, saveFundRegimeState, closeDrainedEmptyPosition,
    LIFECYCLE, saveRegimeRunningFlag, readBooleanFlag, parseFillsQuery,
    lookupStoppedFundTpOrder, createManualTradeImporter,
  } = deps;

  // The only write in the regime:status path: the engine process owns
  // regime-state.json (the gateway must not write it), so a stopped draining
  // fund with an empty position is closed here, before status is synthesized.
  const autoCloseDrainedFundWhileStopped = (exchange, pair, savedState) => {
    const position = savedState?.position;
    if (!closeDrainedEmptyPosition(position)) return;
    saveFundRegimeState(exchange, pair, { ...savedState, position });
    saveRegimeRunningFlag(exchange, pair, false);
    logger(exchange, pair).info(`ℹ️ 🛑 [${fundLabel(exchange, pair)}] Draining fund has empty position — auto-closed`);
  };

  ipcServer.onRequest(IPC_CHANNELS.REGIME_STATUS, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const key = fundKey(exchange, resolvedPair);
    const engine = regimeEngines.get(key);
    const startup = getStartStatus(exchange, resolvedPair);

    if (!engine) {
      const { buildStoppedRegimeStatus } = require('../regime-status');
      const { state: savedState, error: stateError } = loadRegimeStateSafe(exchange, resolvedPair);
      if (stateError) {
        // Report the descriptive repair instruction instead of throwing out of
        // the handler — this is how an operator sees WHY a fund won't boot (#532).
        logger(exchange, resolvedPair).error(
          `❌ [${fundLabel(exchange, resolvedPair)}] regime:status unavailable — ${stateError}`,
          { action: 'regime:status', error: stateError }
        );
        return { success: false, exchange, pair: resolvedPair, running: false, status: null, error: stateError, startup };
      }
      const marketService = getMarketDataService(exchange, resolvedPair);
      const serviceStatus = marketService ? marketService.getStatus() : null;

      autoCloseDrainedFundWhileStopped(exchange, resolvedPair, savedState);

      // Delegate to the shared stopped/offline status synthesizer (issue #357)
      // so enrichment (P&L re-derivation, APY, pendingOrders, celestial) stays
      // in one place shared with the HTTP gateway and the realtime stream.
      // Uses the read-only cached ledger (issue #183) rather than an uncached
      // instance re-parsed on every stopped status poll.
      const status = buildStoppedRegimeStatus(exchange, resolvedPair, {
        market: serviceStatus?.market || null,
        regime: serviceStatus?.regime || null,
        getOrderStatus: marketService?.getOrderStatus,
        mode: 'STOPPED',
      });

      return { success: true, exchange, pair: resolvedPair, running: false, status, startup };
    }

    return { success: true, exchange, pair: resolvedPair, running: !startup || startup.state === 'running', status: engine.getStatus(), startup };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_PAUSE, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    engine.pause(payload?.reason || 'Manual pause via API');
    return { success: true, exchange, pair: resolvedPair, paused: true, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_RESUME, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    engine.resume();
    return { success: true, exchange, pair: resolvedPair, resumed: true, status: engine.getStatus() };
  });

  // Mark a fund as draining: blocks new entries, lets the current TP cycle
  // fill, then auto-stops the engine via the onLifecycleClosed callback.
  ipcServer.onRequest(IPC_CHANNELS.REGIME_CLOSE, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = engine.close(payload?.reason);
    return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
  });

  // Reopen a closed fund: transitions lifecycle CLOSED → ACTIVE on disk.
  // Does NOT restart the engine — operator must call regime:start afterwards.
  ipcServer.onRequest(IPC_CHANNELS.REGIME_REOPEN, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    if (regimeEngines.has(fundKey(exchange, resolvedPair))) {
      return { success: false, error: 'Engine is running — close it first or wait for it to drain' };
    }
    const saved = loadFundRegimeState(exchange, resolvedPair);
    if (!saved?.position) {
      return { success: false, error: 'No saved regime state found' };
    }
    if (saved.position.lifecycle !== LIFECYCLE.CLOSED) {
      return { success: false, error: `Fund is not closed (lifecycle=${saved.position.lifecycle || LIFECYCLE.ACTIVE})` };
    }
    saved.position.lifecycle = LIFECYCLE.ACTIVE;
    saved.position.lifecycleChangedAt = Date.now();
    saved.position.lifecycleReason = null;
    saveFundRegimeState(exchange, resolvedPair, saved);
    logger(exchange, resolvedPair).info(`ℹ️ 🔓 [${fundLabel(exchange, resolvedPair)}] Fund reopened — lifecycle=active`);
    ioProxy.emit('regime:reopened', { exchange, pair: resolvedPair });
    return { success: true, exchange, pair: resolvedPair, lifecycle: LIFECYCLE.ACTIVE };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_FORCE_REGIME, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    engine.forceRegime(payload.regime, payload.reason || 'Forced via API');
    return { success: true, exchange, pair: resolvedPair, regime: payload.regime, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_RESUME_DRAWDOWN, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = engine.forceResumeDrawdown();
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_PREVIEW_LADDER, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.previewLadder();
    return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_REBUILD_LADDER, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.rebuildLadder();
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_CANCEL_LADDER, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.cancelLadder();
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_ROLLUP_BODY, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.manualMergeBody(payload.bodyId);
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, mergedBody: result.mergedBody || null, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_ROLLUP_ALL, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.rollupAllBodies();
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, mergedCount: result.mergedCount || 0, finalBody: result.finalBody || null, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_RESET_CYCLE, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.resetCycleBuys();
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_RECONCILE_PLACEMENT_INTENT, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.reconcilePlacementIntent(payload.intentId, payload.action);
    return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_SET_BODY_TP, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.setBodyTpPercent(payload.bodyId, payload.tpPct);
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_SET_BODY_TP_PRICE, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const result = await engine.setBodyTpPrice(payload.bodyId, payload.limitPrice);
    return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_CONFIG, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const regimeConfig = getRegimeConfig(exchange, resolvedPair);
    const fundConfig = getFundConfig(exchange, resolvedPair);
    return { ...regimeConfig, dryRun: fundConfig.dryRun, productId: fundConfig.productId };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_UPDATE_CONFIG, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (engine) {
      engine.updateConfig(payload);
    }
    return { success: true };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_CHART_DATA, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const chartData = getChartData(exchange, resolvedPair);
    if (!chartData) {
      return { priceHistory: [], atrHistory: [], regimeHistory: [], exchange, pair: resolvedPair, timestamp: Date.now() };
    }
    return chartData;
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_FILLS, async (payload, exchange, pair) => {
    const query = parseFillsQuery(payload);
    if (query.success === false) return query;
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) {
      // getStandaloneLedger throws on cold-start ledger corruption — catch
      // and return the structured shape clients expect, so a corrupt fund
      // doesn't surface as an unstructured IPC exception.
      let ledger;
      try {
        ledger = getStandaloneLedger(exchange, resolvedPair);
      } catch (err) {
        return { running: false, success: false, error: err.message };
      }
      return { running: false, ...ledger.getFillPage(query) };
    }
    return { running: true, ...engine.getFillPage(query) };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_FILLS_CYCLES, async (_payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (engine) return { running: true, ...engine.getFillAggregates() };
    try {
      return { running: false, ...getStandaloneLedger(exchange, resolvedPair).getFillAggregates() };
    } catch (err) {
      return { running: false, success: false, error: err.message };
    }
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_OPEN_ORDERS, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (engine) {
      // Use engine status pendingOrders which includes filledSize from partialFillTracker
      const status = engine.getStatus();
      return { running: true, orders: status.pendingOrders || [] };
    }

    const marketService = getMarketDataService(exchange, resolvedPair);
    const { state: savedState, error: stateError } = loadRegimeStateSafe(exchange, resolvedPair);
    if (stateError) {
      return { running: false, success: false, error: stateError };
    }
    const orders = [];

    if (marketService?.getOpenOrders) {
      orders.push(...marketService.getOpenOrders());
    }

    if (orders.length === 0 && savedState.position?.activeTpOrderId) {
      const adapter = getAdapter(exchange);
      const lookup = await lookupStoppedFundTpOrder({
        adapter, position: savedState.position, exchange, pair: resolvedPair,
        logger: logger(exchange, resolvedPair),
      });
      if (!lookup.ok) return { running: false, success: false, error: lookup.error };
      if (lookup.order) orders.push(lookup.order);
    }

    return { running: false, orders, exchange, pair: resolvedPair };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_DRY_RUN_LOG, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
    return { success: true, isDryRun: true, log: engine.getDryRunLog(payload?.limit || 100) };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_DRY_RUN_PNL, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
    const pnl = engine.getDryRunPnL();
    const state = engine.getState();
    return { success: true, isDryRun: true, pnl, position: state.position, cyclesCompleted: state.position.cyclesCompleted, realizedPnL: state.position.realizedPnL, unrealizedPnL: state.position.unrealizedPnL };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_DRY_RUN_RESET, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
    const reset = engine.resetDryRun();
    return { success: reset, status: engine.getStatus() };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_DRY_RUN_STATE, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (!engine) return { success: false, error: 'Regime engine not running' };
    const state = engine.getState();
    if (!state.isDryRun) return { success: false, error: 'Not in dry-run mode' };
    return { success: true, isDryRun: true, dryRunState: state.dryRun, position: state.position, regime: state.regime, market: state.market };
  });

  /**
   * Build the manual-trade importer for one fund. All import behavior lives in
   * src/manual-trade-import.js; this resolves the fund's live dependencies.
   * Throws on cold-start ledger corruption (via getActiveLedger) — callers
   * convert that into the structured {success:false} IPC response.
   * @returns {Object} importSell / importBuy / importPair / checkPendingBuy / retryRecovery / resumeBodyImport
   */
  const getManualTradeImporter = (exchange, resolvedPair) => {
    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    return createManualTradeImporter({
      exchange,
      pair: resolvedPair,
      adapter: getAdapter(exchange),
      fillLedger: getActiveLedger(exchange, resolvedPair),
      store: getManualTradeStore(exchange, resolvedPair),
      fundConfig: getFundConfig(exchange, resolvedPair),
      logger: logger(exchange, resolvedPair),
      injectBody: engine?.injectBody ? (body) => engine.injectBody(body) : null,
      extendBody: engine?.extendBody ? (bodyId, totals, buyOrderId) => engine.extendBody(bodyId, totals, buyOrderId) : null,
    });
  };

  /**
   * Wire an IPC manual-trade request to one importer method.
   * @param {string} channel - IPC request channel
   * @param {'importSell'|'importBuy'|'importPair'|'checkPendingBuy'|'retryRecovery'|'resumeBodyImport'} method
   */
  const wireManualTradeImport = (channel, method) => {
    ipcServer.onRequest(channel, async (payload, exchange, pair) => {
      const resolvedPair = resolvePair(exchange, pair);
      let importer;
      try {
        importer = getManualTradeImporter(exchange, resolvedPair);
      } catch (err) {
        return { success: false, error: err.message };
      }
      // A row's Resume action owns only that intent. Do not sweep unrelated
      // imports or require an exchange lookup before returning its outcome.
      if (method === 'resumeBodyImport') return importer.resumeBodyImport(payload || {});
      // Heal body creations a crash or failed publication interrupted (issue
      // #1022) before any new import work. Failures are logged by the importer
      // and leave the intent pending for the next request.
      await importer.recoverPendingBodyIntents();
      // Likewise reconcile recovery buys whose placement outcome a crash or
      // transport error left unrecorded (issue #1058): adopt an order the
      // exchange holds, release one it positively never received. A failed
      // lookup keeps that sell blocked from placing another buy.
      await importer.recoverPendingRecoveryIntents();
      return importer[method](payload || {});
    });
  };

  ipcServer.onRequest(IPC_CHANNELS.REGIME_UNACCOUNTED_FILLS, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const { startDate } = payload || {};
    const { getUnaccountedFills } = require('../sync-fills');

    if (!startDate) return { success: false, error: 'startDate is required' };
    const startTimestampMs = new Date(startDate).getTime();
    if (isNaN(startTimestampMs)) return { success: false, error: 'Invalid startDate format' };

    // getActiveLedger → getStandaloneLedger throws on cold-start ledger
    // corruption. Surface as a structured failure rather than letting it
    // leak through the IPC framework.
    let fillLedger;
    try {
      fillLedger = getActiveLedger(exchange, resolvedPair);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const manualTradeStore = getManualTradeStore(exchange, resolvedPair);

    const jobKey = `${fundKey(exchange, resolvedPair)}::${startTimestampMs}`;
    const status = await unaccountedFillsJobs.start(jobKey, ({ signal, onProgress }) =>
      getUnaccountedFills(exchange, fillLedger, manualTradeStore, { startDate, pair: resolvedPair, signal, onProgress }));
    return { exchange, pair: resolvedPair, ...status };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_UNACCOUNTED_FILLS_STATUS, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const { jobId } = payload || {};
    if (!jobId) return { success: false, error: 'jobId is required' };
    return { exchange, pair: resolvedPair, ...unaccountedFillsJobs.status(jobId) };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_MANUAL_TRADES, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const store = getManualTradeStore(exchange, resolvedPair);
    return { success: true, exchange, pair: resolvedPair, trades: store.getAll() };
  });

  // Manual-trade import behavior lives in src/manual-trade-import.js — extracted
  // from this module so it can be tested (this file has require-time side
  // effects). These handlers only resolve the fund and delegate.
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE, 'importSell');
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE_CHECK, 'checkPendingBuy');
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE_RETRY, 'retryRecovery');
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE_RESUME, 'resumeBodyImport');
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE_BUY, 'importBuy');
  wireManualTradeImport(IPC_CHANNELS.REGIME_MANUAL_TRADE_PAIR, 'importPair');

  ipcServer.onRequest(IPC_CHANNELS.REGIME_DISMISS_FILLS, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    const { orderIds } = payload || {};

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return { success: false, error: 'orderIds array is required' };
    }

    const store = getManualTradeStore(exchange, resolvedPair);
    store.dismissFills(orderIds);

    return { success: true, exchange, pair: resolvedPair, dismissed: orderIds.length };
  });

  ipcServer.onRequest(IPC_CHANNELS.REGIME_CONVERT_DCA, async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    if (regimeEngines.has(fundKey(exchange, resolvedPair))) {
      return { success: false, error: 'Regime engine is running — stop it before converting DCA orders' };
    }
    // Reject before any ledger/adapter read so a direct IPC caller cannot
    // select execution over preview (or the cross-cycle merge path) with a
    // non-boolean value such as the string "false" or a numeric 0.
    const previewFlag = readBooleanFlag(payload, 'preview', true);
    if (previewFlag.error) return { success: false, error: previewFlag.error };
    const mergeFlag = readBooleanFlag(payload, 'merge', false);
    if (mergeFlag.error) return { success: false, error: mergeFlag.error };
    const preview = previewFlag.value;
    const merge = mergeFlag.value;
    const { previewConversion, executeConversion, mergeToRegime } = require('../dca-converter');

    if (preview) {
      return { success: true, preview: true, exchange, pair: resolvedPair, ...previewConversion(exchange, resolvedPair) };
    }

    // Both entrypoints run as one recoverable transaction (issue #860): an
    // abort before publication leaves every file untouched (executeConversion
    // restores the DCA engine's original setting itself); an interruption
    // during publication retains the journal, which keeps this fund from
    // trading until recovery completes it. Either way the error becomes the
    // structured {success:false} response the rest of the IPC API uses.
    let result;
    try {
      result = merge ? mergeToRegime(exchange, resolvedPair) : executeConversion(exchange, resolvedPair);
    } catch (err) {
      // Some files may have been replaced before the interruption — drop the
      // stopped-fund ledger cache so nothing persists a stale copy over them.
      invalidateStandaloneLedger(exchange, resolvedPair);
      return { success: false, exchange, pair: resolvedPair, error: err.message, recoveryPending: err.recoveryPending === true };
    }
    invalidateStandaloneLedger(exchange, resolvedPair);
    return { success: true, preview: false, exchange, pair: resolvedPair, ...result };
  });
};

module.exports = { registerRegimeIpcHandlers };
