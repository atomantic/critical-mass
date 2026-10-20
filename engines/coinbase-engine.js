// @ts-check
/**
 * Crypto Exchange Engine Process
 *
 * Standalone PM2 process that runs a single exchange's:
 * - Regime engine (buy/sell cycle management)
 * - Market data service (WebSocket price feeds, ATR, regime detection)
 * - Chart data buffer
 * - IPC WebSocket server for communication with the gateway
 *
 * Set EXCHANGE_NAME env var to select which exchange this process manages.
 * Thin wrappers (gemini-engine.js, cryptocom-engine.js) set env and require this file.
 *
 * The gateway (server.js) connects as an IPC client and forwards:
 * - Socket.IO events from the engine (regime:status, trade:event, etc.)
 * - Regime control commands from the admin UI (start/stop/pause/resume/etc.)
 */

const path = require('path');
const { createContextLogger } = require('../src/logger');
const {
  getExchangeConfig,
  initializeConfigBase,
  getFundConfig,
  getRegimeConfig,
  getConfiguredExchanges,
  getConfiguredFunds,
  getFundsForExchange,
  resolveConfiguredPair,
} = require('../src/config-utils');
const { createRegimeEngine } = require('../src/regime-engine');
const {
  startMarketDataService,
  getActiveMarketDataFunds,
  drainMarketDataStarts,
  stopAllMarketDataServices,
  getMarketDataService,
  stopMarketDataService,
  fenceMarketDataService,
} = require('../src/market-data-service');
const { getChartDataBuffer, getChartData, removeChartDataBuffer, shutdownAllBuffers, resumeAllBuffers, removeAllChartDataBuffers } = require('../src/chart-data-buffer');
const { createFillLedger } = require('../src/fill-ledger');
const { parseFillsQuery } = require('../src/transactions-regime-query');
const { createManualTradeImporter } = require('../src/manual-trade-import');
const { createUnaccountedFillsJobs } = require('../src/unaccounted-fills-jobs');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createSocketIOProxy, forwardTradeEvents } = require('../src/ipc/socket-io-proxy');
const { saveRegimeRunningFlag, shouldAutoResumeRegime, fundKey, fundLabel, readBooleanFlag } = require('../src/shared-utils');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { drainPendingWrites } = require('../src/pending-writes');
const { createEngineStopAllHandler } = require('../src/engine-stop-all');
const { getEngineMaintenance, setEngineRestoreQuiescing } = require('../src/engine-maintenance');
const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
const { registerEngineRecalculateHandler } = require('../src/engine-recalculate-handler');
const { migrateExchangeToPairs, guardLegacyMigration } = require('../src/migration');
const { guardIncompleteRestore } = require('../src/restore-apply');
const { recoverDcaImport } = require('../src/dca-conversion-transaction');
const { LIFECYCLE, closeDrainedEmptyPosition, loadFundRegimeState, loadRegimeStateSafe, saveFundRegimeState } = require('../src/state-tracker');
const { getAdapter } = require('../src/adapters');
const { registerProcessGuards } = require('../src/process-guard');
const { resolveIpcPort } = require('../src/ipc-port-defaults');
const { lookupStoppedFundTpOrder } = require('../src/stopped-fund-tp-lookup');
const { createEngineShutdown } = require('../src/engine-shutdown');

/**
 * Build a context logger for one engine operation.
 *
 * The engine's handlers are keyed by fund (exchange + pair), so the stable
 * trading context is derived per call site rather than bound once. `pair` is
 * omitted for process-level events (startup banner, shutdown) that belong to
 * no single fund — JSON.stringify drops undefined keys.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Trading pair the event belongs to
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const engineLogger = (exchange, pair) => createContextLogger({
  module: 'coinbase-engine',
  exchange,
  pair,
});

// ============ Configuration ============

const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'coinbase';
// EXCHANGE_IPC_PORT is set by the thin per-exchange wrappers (gemini-engine.js,
// cryptocom-engine.js) before they require this file; falling back to
// resolveIpcPort(EXCHANGE_NAME) covers running this file directly (e.g. `node
// engines/coinbase-engine.js` with no wrapper), using the ecosystem.config.cjs
// PORTS default for whichever exchange is configured instead of a literal that
// could collide with the gateway (5570) or the Vite dev server (5571) — issue #690.
const IPC_PORT = parseInt(process.env.EXCHANGE_IPC_PORT, 10) || resolveIpcPort(EXCHANGE_NAME);
const ENGINE_NAME = `cm-${EXCHANGE_NAME}`;

// ============ IPC Server ============

const ipcServer = createIPCServer(IPC_PORT, ENGINE_NAME);
const ioProxy = createSocketIOProxy(ipcServer);
forwardTradeEvents(ipcServer);

// ============ Engine State ============
//
// Each fund (exchange + pair) has its own regime engine instance and its own
// standalone fill ledger. Maps are keyed by `${exchange}::${pair}` so multiple
// funds can coexist within the same engine process.

/** Resolve IPC pairs to configured funds before they reach engine state or disk. */
const resolvePair = (exchange, pair) => {
  const resolved = resolveConfiguredPair(exchange, pair);
  if (resolved.error) throw new Error(resolved.error);
  return resolved.pair;
};

/** @type {Map<string, Object>} Active regime engines keyed by `${exchange}::${pair}` */
const regimeEngines = new Map();

/** @type {Map<string, Object>} Cached standalone fill ledgers keyed by `${exchange}::${pair}` */
const standaloneLedgers = new Map();

const getStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  if (!standaloneLedgers.has(key)) {
    const fundConfig = getFundConfig(exchange, resolvedPair);
    // createFillLedger throws on cold-start corruption (refuses to boot
    // empty so a subsequent persist can't overwrite a recoverable file).
    // Log full detail (absolute path + parser error) server-side and throw
    // a sanitized message — the IPC framework propagates this back to
    // clients, so we keep filesystem internals out of the API surface.
    let ledger;
    try {
      ledger = createFillLedger(exchange, fundConfig?.productId, resolvedPair);
    } catch (err) {
      engineLogger(exchange, resolvedPair).error(`❌ [${exchange}/${resolvedPair}] Fill ledger init failed: ${err.message}`, { error: err.message });
      throw new Error(`Fill ledger init failed for ${exchange}/${resolvedPair} — see engine logs for details`);
    }
    ledger.load();
    standaloneLedgers.set(key, ledger);
  }
  return standaloneLedgers.get(key);
};

const invalidateStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  standaloneLedgers.delete(fundKey(exchange, resolvedPair));
};

/** Get the best available fill ledger — engine's own if running, standalone otherwise */
const getActiveLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (engine) return engine.getFillLedger();
  invalidateStandaloneLedger(exchange, resolvedPair);
  return getStandaloneLedger(exchange, resolvedPair);
};

// ============ Engine Callbacks ============

const wireMarketDataCallbacks = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const service = getMarketDataService(exchange, resolvedPair);
  if (!service) return;
  service.setOnStatusUpdate((status) => {
    getChartDataBuffer(exchange, resolvedPair).processStatus(status);
    ioProxy.emit('regime:status', { exchange, pair: resolvedPair, status });
  });
};

const createEngineCallbacks = (exchange, pair) => ({
  onRegimeChange: (prevMode, newMode, reason) =>
    ioProxy.emit('regime:change', { exchange, pair, prevMode, newMode, reason, message: `${prevMode} -> ${newMode}` }),
  onHealthChange: (mode, reason) =>
    ioProxy.emit('regime:health', { exchange, pair, mode, reason, message: reason || `Health: ${mode}` }),
  onPositionUpdate: (data) =>
    ioProxy.emit('regime:position', { exchange, pair, ...data }),
  onStatusUpdate: (status) => {
    getChartDataBuffer(exchange, pair).processStatus(status);
    ioProxy.emit('regime:status', { exchange, pair, status });
  },
  // Fired by the regime engine when a draining fund's TP fills and lifecycle
  // transitions to closed. We stop the engine here (rather than from inside
  // the engine itself) to avoid re-entrancy in the cycle-completion path.
  onLifecycleClosed: async () => {
    const label = fundLabel(exchange, pair);
    const fundLogger = engineLogger(exchange, pair);
    fundLogger.info(`ℹ️ 🛑 [${label}] Lifecycle closed — stopping regime engine`);
    const key = fundKey(exchange, pair);
    const engine = regimeEngines.get(key);
    if (!engine) return;
    try {
      await engine.stop();
    } catch (err) {
      fundLogger.error(`❌ [${label}] Error stopping engine after lifecycle close: ${err.message}`, { error: err.message });
    }
    regimeEngines.delete(key);
    invalidateStandaloneLedger(exchange, pair);
    manualTradeStores.delete(fundKey(exchange, pair));
    // Free the chart buffer (with its setInterval) and the market data
    // service so we don't leak memory for dead funds. Operator can reopen
    // and start the fund again later — both will be re-created on demand.
    removeChartDataBuffer(exchange, pair);
    stopMarketDataService(exchange, pair);
    saveRegimeRunningFlag(exchange, pair, false);
    ioProxy.emit('regime:closed', { exchange, pair });
  },
});

// ============ IPC Request Handlers ============

// Regime engine control — regime:start / regime:stop
// Extracted to src/engine-lifecycle-handlers.js (issue #504) so the
// fill-consumer handover ordering around engine stop/start can be tested
// directly against these production callbacks. Ledger ownership transfers
// exclusively between the engine and the standalone service (issue #1008).
const { autoResumeFund, resumeAfterBackup, getStartStatus, cancelStarts, settleStarts } = registerEngineLifecycleHandlers(ipcServer, {
  regimeEngines,
  resolvePair,
  fundKey,
  fundLabel,
  logger: engineLogger,
  getFundConfig,
  getAdapter,
  loadFundRegimeState,
  LIFECYCLE,
  createRegimeEngine,
  createEngineCallbacks,
  startMarketDataService,
  fenceMarketDataService,
  wireMarketDataCallbacks,
  invalidateStandaloneLedger,
  saveRegimeRunningFlag,
  recoverPendingImport: recoverDcaImport,
  drainFundWrites: (exchange, pair) => drainPendingWrites(30_000,
    entry => entry.label.startsWith('engine-') && entry.label.endsWith(`:${fundLabel(exchange, pair)}`)),
});

// The only write in the regime:status path: the engine process owns
// regime-state.json (the gateway must not write it), so a stopped draining
// fund with an empty position is closed here, before status is synthesized.
const autoCloseDrainedFundWhileStopped = (exchange, pair, savedState) => {
  const position = savedState?.position;
  if (!closeDrainedEmptyPosition(position)) return;
  saveFundRegimeState(exchange, pair, { ...savedState, position });
  saveRegimeRunningFlag(exchange, pair, false);
  engineLogger(exchange, pair).info(`ℹ️ 🛑 [${fundLabel(exchange, pair)}] Draining fund has empty position — auto-closed`);
};

ipcServer.onRequest('regime:status', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  const engine = regimeEngines.get(key);
  const startup = getStartStatus(exchange, resolvedPair);

  if (!engine) {
    const { buildStoppedRegimeStatus } = require('../src/regime-status');
    const { state: savedState, error: stateError } = loadRegimeStateSafe(exchange, resolvedPair);
    if (stateError) {
      // Report the descriptive repair instruction instead of throwing out of
      // the handler — this is how an operator sees WHY a fund won't boot (#532).
      engineLogger(exchange, resolvedPair).error(
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
    // in one place shared with the HTTP gateway and the Socket.IO stream.
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

ipcServer.onRequest('regime:pause', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.pause(payload?.reason || 'Manual pause via API');
  return { success: true, exchange, pair: resolvedPair, paused: true, status: engine.getStatus() };
});

ipcServer.onRequest('regime:resume', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.resume();
  return { success: true, exchange, pair: resolvedPair, resumed: true, status: engine.getStatus() };
});

// Mark a fund as draining: blocks new entries, lets the current TP cycle
// fill, then auto-stops the engine via the onLifecycleClosed callback.
ipcServer.onRequest('regime:close', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = engine.close(payload?.reason);
  return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
});

// Reopen a closed fund: transitions lifecycle CLOSED → ACTIVE on disk.
// Does NOT restart the engine — operator must call regime:start afterwards.
ipcServer.onRequest('regime:reopen', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  if (regimeEngines.has(fundKey(exchange, resolvedPair))) {
    return { success: false, error: 'Engine is running — close it first or wait for it to drain' };
  }
  const { loadFundRegimeState, saveFundRegimeState } = require('../src/state-tracker');
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
  engineLogger(exchange, resolvedPair).info(`ℹ️ 🔓 [${fundLabel(exchange, resolvedPair)}] Fund reopened — lifecycle=active`);
  ioProxy.emit('regime:reopened', { exchange, pair: resolvedPair });
  return { success: true, exchange, pair: resolvedPair, lifecycle: LIFECYCLE.ACTIVE };
});

ipcServer.onRequest('regime:force-regime', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.forceRegime(payload.regime, payload.reason || 'Forced via API');
  return { success: true, exchange, pair: resolvedPair, regime: payload.regime, status: engine.getStatus() };
});

ipcServer.onRequest('regime:resume-drawdown', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = engine.forceResumeDrawdown();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:preview-ladder', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.previewLadder();
  return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
});

ipcServer.onRequest('regime:rebuild-ladder', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.rebuildLadder();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:cancel-ladder', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.cancelLadder();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:rollup-body', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.manualMergeBody(payload.bodyId);
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, mergedBody: result.mergedBody || null, status: engine.getStatus() };
});

ipcServer.onRequest('regime:rollup-all', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.rollupAllBodies();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, mergedCount: result.mergedCount || 0, finalBody: result.finalBody || null, status: engine.getStatus() };
});

ipcServer.onRequest('regime:reset-cycle', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.resetCycleBuys();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
});

ipcServer.onRequest('regime:reconcile-placement-intent', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.reconcilePlacementIntent(payload.intentId, payload.action);
  return { ...result, exchange, pair: resolvedPair, status: engine.getStatus() };
});

ipcServer.onRequest('regime:set-body-tp', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.setBodyTpPercent(payload.bodyId, payload.tpPct);
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
});

ipcServer.onRequest('regime:set-body-tp-price', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.setBodyTpPrice(payload.bodyId, payload.limitPrice);
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, status: result.status || engine.getStatus() };
});

ipcServer.onRequest('regime:config', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const regimeConfig = getRegimeConfig(exchange, resolvedPair);
  const fundConfig = getFundConfig(exchange, resolvedPair);
  return { ...regimeConfig, dryRun: fundConfig.dryRun, productId: fundConfig.productId };
});

ipcServer.onRequest('regime:update-config', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (engine) {
    engine.updateConfig(payload);
  }
  return { success: true };
});

ipcServer.onRequest('regime:chart-data', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const chartData = getChartData(exchange, resolvedPair);
  if (!chartData) {
    return { priceHistory: [], atrHistory: [], regimeHistory: [], exchange, pair: resolvedPair, timestamp: Date.now() };
  }
  return chartData;
});

ipcServer.onRequest('regime:fills', async (payload, exchange, pair) => {
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
    if (query.paged) return { running: false, ...ledger.getFillPage(query) };
    return { running: false, fills: ledger.getAllFills(), stats: ledger.getStats() };
  }
  if (query.paged) return { running: true, ...engine.getFillPage(query) };
  return { running: true, fills: engine.getFills(), stats: engine.getFillStats() };
});

ipcServer.onRequest('regime:open-orders', async (payload, exchange, pair) => {
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
    const { getAdapter } = require('../src/adapters');
    const adapter = getAdapter(exchange);
    const lookup = await lookupStoppedFundTpOrder({
      adapter, position: savedState.position, exchange, pair: resolvedPair,
      logger: engineLogger(exchange, resolvedPair),
    });
    if (!lookup.ok) return { running: false, success: false, error: lookup.error };
    if (lookup.order) orders.push(lookup.order);
  }

  return { running: false, orders, exchange, pair: resolvedPair };
});

ipcServer.onRequest('regime:dry-run-log', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  return { success: true, isDryRun: true, log: engine.getDryRunLog(payload?.limit || 100) };
});

ipcServer.onRequest('regime:dry-run-pnl', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  const pnl = engine.getDryRunPnL();
  const state = engine.getState();
  return { success: true, isDryRun: true, pnl, position: state.position, cyclesCompleted: state.position.cyclesCompleted, realizedPnL: state.position.realizedPnL, unrealizedPnL: state.position.unrealizedPnL };
});

ipcServer.onRequest('regime:dry-run-reset', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  const reset = engine.resetDryRun();
  return { success: reset, status: engine.getStatus() };
});

ipcServer.onRequest('regime:dry-run-state', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const state = engine.getState();
  if (!state.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  return { success: true, isDryRun: true, dryRunState: state.dryRun, position: state.position, regime: state.regime, market: state.market };
});

// Stop all running regime engines (used by backup restore). The reply is the
// restore path's proof of writer quiescence, so a fund that failed to stop is
// reported as failed and stays owned by this process (issue #429).
registerEngineBackupHandlers(ipcServer, {
  regimeEngines, getMarketFunds: getActiveMarketDataFunds,
  stopMarketServices: stopAllMarketDataServices, drainMarketStarts: drainMarketDataStarts,
  drainPendingWrites, startMarketService: startMarketDataService,
  resumeFund: resumeAfterBackup, getStartStatus, drainStarts: settleStarts,
  pauseBuffers: shutdownAllBuffers, resumeBuffers: resumeAllBuffers,
  // A gateway that dies mid-backup can never send backup-resume; the window
  // restarts the captured funds itself once its only client is gone.
  onGatewayDisconnect: (listener) => ipcServer.onClientDisconnect((remaining) => { if (remaining === 0) listener(); }),
  isShuttingDown: ipcServer.isShuttingDown,
  logger: engineLogger(EXCHANGE_NAME),
});

ipcServer.onRequest('regime:stop-all', createEngineStopAllHandler({
  regimeEngines, cancelStarts, drainPendingWrites,
  stopMarketServices: stopAllMarketDataServices, drainMarketStarts: drainMarketDataStarts,
  clearCaches: () => { removeAllChartDataBuffers(); standaloneLedgers.clear(); manualTradeStores.clear(); },
  getMaintenance: getEngineMaintenance, setQuiescing: setEngineRestoreQuiescing,
  logger: engineLogger, label: fundLabel, setRunningFlag: saveRegimeRunningFlag,
}));

// Exchange/fund info queries
ipcServer.onRequest('exchanges:list', async () => {
  const configured = getConfiguredExchanges();
  return configured.map((name) => {
    const funds = getFundsForExchange(name);
    const anyRunning = funds.some((p) => regimeEngines.has(fundKey(name, p)));
    return {
      name,
      pairs: funds,
      regimeRunning: anyRunning,
    };
  });
});

// List funds (exchange + pair) configured on a specific exchange
ipcServer.onRequest('funds:list', async (payload, exchange) => {
  const funds = getFundsForExchange(exchange);
  return {
    exchange,
    funds: funds.map((pair) => ({
      pair,
      regimeRunning: regimeEngines.has(fundKey(exchange, pair)),
    })),
  };
});

// regime:recalculate — extracted to src/engine-recalculate-handler.js
// (issue #505) so the preview-vs-apply / live-vs-stopped selection it
// enforces can be tested directly against these production callbacks.
registerEngineRecalculateHandler(ipcServer, {
  regimeEngines,
  resolvePair,
  fundKey,
  readBooleanFlag,
  loadFundRegimeState,
  saveFundRegimeState,
  invalidateStandaloneLedger,
  getStandaloneLedger,
});


// ============ Manual Trade Tracking ============

/** @type {Map<string, Object>} Cached manual trade stores keyed by `${exchange}::${pair}` */
const manualTradeStores = new Map();

const getManualTradeStore = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  if (!manualTradeStores.has(key)) {
    const { createManualTradeStore } = require('../src/manual-trades');
    const store = createManualTradeStore(exchange, resolvedPair);
    store.load();
    manualTradeStores.set(key, store);
  }
  return manualTradeStores.get(key);
};

/**
 * Build the manual-trade importer for one fund. All import behavior lives in
 * src/manual-trade-import.js; this resolves the fund's live dependencies.
 * Throws on cold-start ledger corruption (via getActiveLedger) — callers
 * convert that into the structured {success:false} IPC response.
 * @returns {Object} importSell / importBuy / importPair / checkPendingBuy / retryRecovery / resumeBodyImport
 */
const getManualTradeImporter = (exchange, resolvedPair) => {
  const { getAdapter } = require('../src/adapters');
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  return createManualTradeImporter({
    exchange,
    pair: resolvedPair,
    adapter: getAdapter(exchange),
    fillLedger: getActiveLedger(exchange, resolvedPair),
    store: getManualTradeStore(exchange, resolvedPair),
    fundConfig: getFundConfig(exchange, resolvedPair),
    logger: engineLogger(exchange, resolvedPair),
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

// Manual Trades history reads run as engine-owned jobs (issue #966): a long
// exchange history (e.g. hundreds of paced Crypto.com pages) outlasts the
// gateway's IPC deadline, so start/status answer promptly while the scan runs
// here. A start for a fund+startDate that is already scanning joins that job.
const unaccountedFillsJobs = createUnaccountedFillsJobs({ logger: engineLogger(EXCHANGE_NAME) });

ipcServer.onRequest('regime:unaccounted-fills', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { startDate } = payload || {};
  const { getUnaccountedFills } = require('../src/sync-fills');

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

ipcServer.onRequest('regime:unaccounted-fills-status', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { jobId } = payload || {};
  if (!jobId) return { success: false, error: 'jobId is required' };
  return { exchange, pair: resolvedPair, ...unaccountedFillsJobs.status(jobId) };
});

ipcServer.onRequest('regime:manual-trades', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const store = getManualTradeStore(exchange, resolvedPair);
  return { success: true, exchange, pair: resolvedPair, trades: store.getAll() };
});

// Manual-trade import behavior lives in src/manual-trade-import.js — extracted
// from this module so it can be tested (this file has require-time side
// effects). These handlers only resolve the fund and delegate.
wireManualTradeImport('regime:manual-trade', 'importSell');
wireManualTradeImport('regime:manual-trade-check', 'checkPendingBuy');
wireManualTradeImport('regime:manual-trade-retry', 'retryRecovery');
wireManualTradeImport('regime:manual-trade-resume', 'resumeBodyImport');
wireManualTradeImport('regime:manual-trade-buy', 'importBuy');
wireManualTradeImport('regime:manual-trade-pair', 'importPair');

ipcServer.onRequest('regime:dismiss-fills', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { orderIds } = payload || {};

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { success: false, error: 'orderIds array is required' };
  }

  const store = getManualTradeStore(exchange, resolvedPair);
  store.dismissFills(orderIds);

  return { success: true, exchange, pair: resolvedPair, dismissed: orderIds.length };
});

// ============ DCA Conversion ============

ipcServer.onRequest('regime:convert-dca', async (payload, exchange, pair) => {
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
  const { previewConversion, executeConversion, mergeToRegime } = require('../src/dca-converter');

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

// ============ Startup ============

const startup = async () => {
  const { version } = require('../package.json');
  const label = EXCHANGE_NAME.charAt(0).toUpperCase() + EXCHANGE_NAME.slice(1);
  const startupLogger = engineLogger(EXCHANGE_NAME);
  startupLogger.info(`ℹ️ \n📡 ${label} Engine v${version}`);
  startupLogger.info(`ℹ️    IPC: ws://127.0.0.1:${IPC_PORT}`);

  const exchange = EXCHANGE_NAME;

  // Own the configured local IPC port before any recovery, migration or fund
  // writer can run. A duplicate process must fail without touching fund data.
  ipcServer.setInitializing(true);
  await ipcServer.start();

  // ===== Interrupted-restore recovery =====
  // Runs before the migration and before any fund loads its ledger or regime
  // state: a crash mid-restore leaves data/ a mixed generation, and resuming a
  // fund on one would trade against another era's accounting (issue #431).
  // A rollback that cannot complete exits the process rather than trading blind.
  guardIncompleteRestore({ processLabel: `${exchange} engine`, logger: startupLogger });

  initializeConfigBase();

  // ===== Legacy root → exchange namespace migration =====
  // Same gate as the gateway and CLI (issue #971): an interrupted namespace
  // migration is finished here before the pair migration below resolves the
  // exchange tree, and a conflicting one keeps the engine from starting.
  guardLegacyMigration({ processLabel: `${exchange} engine`, logger: startupLogger });

  // ===== One-time multi-pair migration =====
  // Move legacy data/<exchange>/ files into data/<exchange>/<defaultPair>/.
  // Idempotent: returns no-op if already migrated. See UPGRADE.md.
  const migrationResult = migrateExchangeToPairs(exchange);
  if (migrationResult.migrated) {
    startupLogger.info(`ℹ️ ✅ [${exchange}] Pair migration complete: moved ${migrationResult.movedFiles} files into ${exchange}/${migrationResult.defaultPair}/`);
  } else if (migrationResult.reason && !migrationResult.reason.startsWith('no-op')) {
    startupLogger.error(`❌ [${exchange}] Pair migration failed: ${migrationResult.reason}`, { reason: migrationResult.reason });
    startupLogger.error(`❌ [${exchange}] Refusing to start engine. See UPGRADE.md for instructions.`, { reason: migrationResult.reason });
    process.exit(1);
  }

  // Auto-resume each fund (exchange + pair) that was running before restart
  const fundsForExchange = getFundsForExchange(exchange);
  for (const fundPair of fundsForExchange) {
    const label = fundLabel(exchange, fundPair);
    const fundLogger = engineLogger(exchange, fundPair);
    const key = fundKey(exchange, fundPair);

    // Finish (or discard) an interrupted DCA import before anything reads
    // this fund's files (issue #860). An unrecoverable journal keeps the fund
    // offline — no auto-resume and no stopped-fund fill writer — so nothing
    // trades or ingests on a mixed import generation.
    try {
      const recovery = recoverDcaImport(exchange, fundPair);
      if (recovery.recovered) {
        fundLogger.warn(`⚠️ [${label}] Interrupted DCA import ${recovery.id} ${recovery.action}`, { importId: recovery.id, action: recovery.action });
      }
    } catch (err) {
      fundLogger.error(`❌ [${label}] DCA import recovery failed — fund stays offline: ${err.message}`, { error: err.message });
      continue;
    }

    if (shouldAutoResumeRegime(exchange, fundPair)) {
      await autoResumeFund(exchange, fundPair);
    }

    // Start passive market data service for funds whose engine isn't running
    if (!regimeEngines.has(key) && !getStartStatus(exchange, fundPair)) {
      const regimeConfig = getRegimeConfig(exchange, fundPair);
      if (regimeConfig && Object.keys(regimeConfig).length > 0) {
        fundLogger.info(`ℹ️ 📊 [${label}] Starting market data service...`);
        startMarketDataService(exchange, fundPair)
          .then(() => wireMarketDataCallbacks(exchange, fundPair))
          .catch((err) => {
            fundLogger.warn(`⚠️ [${label}] Failed to start market data service: ${err.message}`, { error: err.message });
          });
      }
    }
  }

  ipcServer.setInitializing(false);
};

startup().catch((err) => {
  engineLogger(EXCHANGE_NAME).error(`❌ Startup failed: ${err.message}`, { error: err.message });
  process.exit(1);
});

// ============ Graceful Shutdown ============

// Install signal handlers with error handling and watchdog
// Must exceed FILL_DRAIN_MS (the bounded in-flight-fill drain in regime-engine
// stop()) plus the state save, and stay below `kill_timeout` for the engines in
// ecosystem.config.cjs. Kept a literal: tests/pm2-kill-timeout.test.js parses it.
const SHUTDOWN_WATCHDOG_MS = 15000;

const engineShutdown = createEngineShutdown({
  ipcServer,
  regimeEngines,
  cancelStarts,
  settleStarts,
  unaccountedFillsJobs,
  stopMarketServices: stopAllMarketDataServices,
  drainMarketStarts: drainMarketDataStarts,
  drainPendingWrites,
  shutdownAllBuffers,
  logger: engineLogger(EXCHANGE_NAME),
  watchdogMs: SHUTDOWN_WATCHDOG_MS,
});

const gracefulShutdown = engineShutdown.shutdown;

const setupShutdownHandlers = () => {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
};

setupShutdownHandlers();

// Last-resort fault reporters (issue #532). The engine process has no notifier
// of its own — trade events reach Telegram through the gateway's IPC
// subscription. Drain the outbound frame before exit so the gateway can send
// the notification even after this process has terminated.
registerProcessGuards({
  logger: engineLogger(EXCHANGE_NAME),
  source: `${EXCHANGE_NAME}-engine`,
  flush: () => ipcServer.flush(),
});
