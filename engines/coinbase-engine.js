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
  stopAllMarketDataServices,
  getMarketDataService,
  stopMarketDataService,
} = require('../src/market-data-service');
const { getChartDataBuffer, getChartData, removeChartDataBuffer, shutdownAllBuffers } = require('../src/chart-data-buffer');
const { createFillLedger } = require('../src/fill-ledger');
const { createManualTradeImporter } = require('../src/manual-trade-import');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createSocketIOProxy } = require('../src/ipc/socket-io-proxy');
const { saveRegimeRunningFlag, shouldAutoResumeRegime, fundKey, fundLabel, readBooleanFlag } = require('../src/shared-utils');
const { stopAllRegimeEngines } = require('../src/engine-stop-all');
const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
const { registerEngineRecalculateHandler } = require('../src/engine-recalculate-handler');
const { migrateExchangeToPairs } = require('../src/migration');
const { guardIncompleteRestore } = require('../src/restore-apply');
const { LIFECYCLE, loadRegimeState, saveRegimeState } = require('../src/state-tracker');
const { getAdapter } = require('../src/adapters');

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
const IPC_PORT = parseInt(process.env.EXCHANGE_IPC_PORT || process.env.COINBASE_IPC_PORT) || 5570;
const ENGINE_NAME = `cm-${EXCHANGE_NAME}`;

// ============ IPC Server ============

const ipcServer = createIPCServer(IPC_PORT, ENGINE_NAME);
const ioProxy = createSocketIOProxy(ipcServer);

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
  onTradeEvent: (event) => ioProxy.emit('trade:event', event),
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
// directly against these production callbacks.
registerEngineLifecycleHandlers(ipcServer, {
  regimeEngines,
  resolvePair,
  fundKey,
  fundLabel,
  logger: engineLogger,
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
});

ipcServer.onRequest('regime:status', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  const engine = regimeEngines.get(key);

  if (!engine) {
    const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
    const { buildStoppedRegimeStatus } = require('../src/regime-status');
    const savedState = loadRegimeState(exchange, resolvedPair);
    const position = savedState?.position || null;
    const marketService = getMarketDataService(exchange, resolvedPair);
    const serviceStatus = marketService ? marketService.getStatus() : null;

    // Auto-close: if fund is draining but position is fully empty, transition to closed.
    // This is an engine-owned state mutation (not status synthesis), so it stays
    // here and runs before buildStoppedRegimeStatus re-loads state from disk.
    if (position && position.lifecycle === LIFECYCLE.DRAINING) {
      const bodies = position.celestialBodies || [];
      const hasPosition = (position.totalAsset || 0) > 0 || bodies.length > 0;
      if (!hasPosition) {
        position.lifecycle = LIFECYCLE.CLOSED;
        position.lifecycleChangedAt = Date.now();
        position.lifecycleClosedCycle = position.cyclesCompleted || 0;
        saveRegimeState(position, savedState.regime, exchange, savedState.tpOptimizer, savedState.sizeOptimizer, resolvedPair);
        saveRegimeRunningFlag(exchange, resolvedPair, false);
        engineLogger(exchange, resolvedPair).info(`ℹ️ 🛑 [${fundLabel(exchange, resolvedPair)}] Draining fund has empty position — auto-closed`);
      }
    }

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

    return { success: true, exchange, pair: resolvedPair, running: false, status };
  }

  return { success: true, exchange, pair: resolvedPair, running: true, status: engine.getStatus() };
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
  const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
  const saved = loadRegimeState(exchange, resolvedPair);
  if (!saved?.position) {
    return { success: false, error: 'No saved regime state found' };
  }
  if (saved.position.lifecycle !== LIFECYCLE.CLOSED) {
    return { success: false, error: `Fund is not closed (lifecycle=${saved.position.lifecycle || LIFECYCLE.ACTIVE})` };
  }
  saved.position.lifecycle = LIFECYCLE.ACTIVE;
  saved.position.lifecycleChangedAt = Date.now();
  saved.position.lifecycleReason = null;
  saveRegimeState(saved.position, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, resolvedPair);
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
    return { running: false, fills: ledger.getAllFills(), stats: ledger.getStats() };
  }
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
  const { loadRegimeState } = require('../src/state-tracker');
  const savedState = loadRegimeState(exchange, resolvedPair);
  const orders = [];

  if (marketService?.getOpenOrders) {
    orders.push(...marketService.getOpenOrders());
  }

  if (orders.length === 0 && savedState.position?.activeTpOrderId) {
    const { getAdapter } = require('../src/adapters');
    const adapter = getAdapter(exchange);
    const orderStatus = await adapter.getOrder(savedState.position.activeTpOrderId).catch(() => null);
    if (orderStatus && orderStatus.status === 'OPEN') {
      orders.push({
        orderId: savedState.position.activeTpOrderId,
        type: 'take_profit', side: 'sell',
        price: savedState.position.lastTpPrice || 0,
        size: savedState.position.assetOnOrder || savedState.position.totalAsset || 0,
        status: 'open',
        placedAt: savedState.position.lastEntryTime || null,
      });
    }
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
ipcServer.onRequest('regime:stop-all', async () => stopAllRegimeEngines(regimeEngines, {
  logger: engineLogger,
  label: fundLabel,
  setRunningFlag: saveRegimeRunningFlag,
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
  loadRegimeState,
  saveRegimeState,
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
 * @returns {Object} importSell / importBuy / importPair / checkPendingBuy
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
  });
};

/**
 * Wire an IPC manual-trade request to one importer method.
 * @param {string} channel - IPC request channel
 * @param {'importSell'|'importBuy'|'importPair'|'checkPendingBuy'} method
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
    return importer[method](payload || {});
  });
};

ipcServer.onRequest('regime:unaccounted-fills', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { startDate } = payload || {};
  const { getUnaccountedFills } = require('../src/sync-fills');

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

  const result = await getUnaccountedFills(exchange, fillLedger, manualTradeStore, { startDate, pair: resolvedPair });
  return result;
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

  // executeConversion re-enables the DCA engine on its own throw path
  // (handled inside dca-converter.js). mergeToRegime doesn't disable the
  // engine so it has nothing to roll back — both paths surface a
  // cold-start ledger corruption throw that we convert into the
  // structured {success:false} response the rest of the IPC API uses.
  let result;
  try {
    result = merge ? mergeToRegime(exchange, resolvedPair) : executeConversion(exchange, resolvedPair);
  } catch (err) {
    return { success: false, exchange, pair: resolvedPair, error: err.message };
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

  // ===== Interrupted-restore recovery =====
  // Runs before the migration and before any fund loads its ledger or regime
  // state: a crash mid-restore leaves data/ a mixed generation, and resuming a
  // fund on one would trade against another era's accounting (issue #431).
  // A rollback that cannot complete exits the process rather than trading blind.
  guardIncompleteRestore({ processLabel: `${exchange} engine`, logger: startupLogger });

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

  ipcServer.start();

  // Auto-resume each fund (exchange + pair) that was running before restart
  const fundsForExchange = getFundsForExchange(exchange);
  for (const fundPair of fundsForExchange) {
    const label = fundLabel(exchange, fundPair);
    const fundLogger = engineLogger(exchange, fundPair);
    const key = fundKey(exchange, fundPair);

    if (shouldAutoResumeRegime(exchange, fundPair)) {
      // Skip auto-resume for closed funds — the operator must explicitly reopen.
      const { loadRegimeState } = require('../src/state-tracker');
      const savedState = loadRegimeState(exchange, fundPair);
      if (savedState?.position?.lifecycle === LIFECYCLE.CLOSED) {
        fundLogger.info(`ℹ️ 🛑 [${label}] Skipping auto-resume: fund is closed (call regime:reopen to reactivate)`);
        saveRegimeRunningFlag(exchange, fundPair, false);
        continue;
      }
      fundLogger.info(`ℹ️ 🔄 [${label}] Auto-resuming regime engine from previous session...`);

      const { getAdapter } = require('../src/adapters');
      const fundConfig = getFundConfig(exchange, fundPair);
      const adapter = getAdapter(exchange);

      if (adapter.hasValidKeys && adapter.hasValidKeys()) {
        // createRegimeEngine eagerly creates its fill ledger
        // (regime-engine.js:226), which refuses to boot on cold-start
        // corruption. Without this catch, a single corrupt fund ledger
        // would abort the entire engine process on startup; instead we
        // log per-fund (with full detail) and continue with the rest.
        // Server-side log is the right destination for the absolute
        // ledger path + parser detail — there's no IPC client here, so
        // a sanitized message would just lose information.
        let engine;
        try {
          engine = createRegimeEngine(exchange, fundPair, fundConfig, createEngineCallbacks(exchange, fundPair));
        } catch (err) {
          fundLogger.error(`❌ [${label}] Failed to auto-resume: Fill ledger init failed: ${err.message}`, { error: err.message });
          saveRegimeRunningFlag(exchange, fundPair, false);
          continue;
        }
        regimeEngines.set(key, engine);

        const startResult = await engine.start();
        if (startResult.autoClosed) {
          regimeEngines.delete(key);
          fundLogger.info(`ℹ️ 🛑 [${label}] Fund auto-closed on resume (empty draining position)`);
        } else if (startResult.success) {
          fundLogger.info(`ℹ️ ✅ [${label}] Regime engine auto-resumed successfully`);
        } else {
          fundLogger.error(`❌ [${label}] Failed to auto-resume: ${startResult.error}`, { error: startResult.error });
          regimeEngines.delete(key);
          saveRegimeRunningFlag(exchange, fundPair, false);
        }
      } else {
        fundLogger.warn(`⚠️ [${label}] Cannot auto-resume: API keys not configured`);
        saveRegimeRunningFlag(exchange, fundPair, false);
      }
    }

    // Start passive market data service for funds whose engine isn't running
    if (!regimeEngines.has(key)) {
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
};

startup().catch((err) => {
  engineLogger(EXCHANGE_NAME).error(`❌ Startup failed: ${err.message}`, { error: err.message });
  process.exit(1);
});

// ============ Graceful Shutdown ============

const gracefulShutdown = async (signal) => {
  const shutdownLogger = engineLogger(EXCHANGE_NAME);
  shutdownLogger.info(`ℹ️ Received ${signal}, shutting down...`, { signal });

  stopAllMarketDataServices();

  const stopPromises = [];
  for (const [key, engine] of regimeEngines) {
    shutdownLogger.info(`ℹ️ Stopping regime engine for ${key}...`, { fundKey: key });
    stopPromises.push(engine.stop());
  }

  // Use allSettled to capture rejections without aborting other shutdowns
  const results = await Promise.allSettled(stopPromises);
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const keys = Array.from(regimeEngines.keys());
      const fundKey = keys[i];
      shutdownLogger.error(`❌ Engine stop failed for ${fundKey}: ${results[i].reason.message}`, {
        fundKey,
        error: results[i].reason.message
      });
    }
  }

  // Ensure buffers flush even if engine stop failed
  try {
    shutdownAllBuffers();
  } catch (err) {
    shutdownLogger.error(`❌ Buffer shutdown failed: ${err.message}`, { error: err.message });
  }

  // Ensure IPC server closes even if other shutdowns failed
  try {
    ipcServer.stop();
  } catch (err) {
    shutdownLogger.error(`❌ IPC server stop failed: ${err.message}`, { error: err.message });
  }

  shutdownLogger.info(`ℹ️ Shutdown complete`);
  process.exit(0);
};

// Install signal handlers with error handling and watchdog
const setupShutdownHandlers = () => {
  const shutdownLogger = engineLogger(EXCHANGE_NAME);

  const shutdownWithWatchdog = (signal) => {
    gracefulShutdown(signal).catch((err) => {
      shutdownLogger.error(`❌ Shutdown failed: ${err.message}`, { error: err.message });
      process.exit(1);
    });

    // Force-exit watchdog: if shutdown hangs, kill after 5 seconds
    setTimeout(() => {
      shutdownLogger.error(`❌ Forcing exit after shutdown timeout (5s)`, { timeout: 5000 });
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdownWithWatchdog('SIGTERM'));
  process.on('SIGINT', () => shutdownWithWatchdog('SIGINT'));
};

setupShutdownHandlers();
