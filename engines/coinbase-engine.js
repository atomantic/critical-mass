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
const { log } = require('../src/logger');
const {
  getExchangeConfig,
  getFundConfig,
  getRegimeConfig,
  getConfiguredExchanges,
  getConfiguredFunds,
  getFundsForExchange,
  getDefaultPair,
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
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createSocketIOProxy } = require('../src/ipc/socket-io-proxy');
const { saveRegimeRunningFlag, shouldAutoResumeRegime, fundKey, fundLabel } = require('../src/shared-utils');
const { migrateExchangeToPairs } = require('../src/migration');
const { LIFECYCLE } = require('../src/state-tracker');

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

/** Resolve pair from IPC arg, falling back to the exchange's default pair. */
const resolvePair = (exchange, pair) => pair || getDefaultPair(exchange);

/** @type {Map<string, Object>} Active regime engines keyed by `${exchange}::${pair}` */
const regimeEngines = new Map();

/** @type {Map<string, Object>} Cached standalone fill ledgers keyed by `${exchange}::${pair}` */
const standaloneLedgers = new Map();

const getStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  if (!standaloneLedgers.has(key)) {
    const fundConfig = getFundConfig(exchange, resolvedPair);
    standaloneLedgers.set(key, createFillLedger(exchange, fundConfig?.productId, resolvedPair));
  }
  return standaloneLedgers.get(key);
};

const invalidateStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  standaloneLedgers.delete(fundKey(exchange, resolvedPair));
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
    log('INFO', `🛑 [${label}] Lifecycle closed — stopping regime engine`);
    const key = fundKey(exchange, pair);
    const engine = regimeEngines.get(key);
    if (!engine) return;
    try {
      await engine.stop();
    } catch (err) {
      log('ERROR', `❌ [${label}] Error stopping engine after lifecycle close: ${err.message}`);
    }
    regimeEngines.delete(key);
    invalidateStandaloneLedger(exchange, pair);
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

// Regime engine control
ipcServer.onRequest('regime:start', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  const label = fundLabel(exchange, resolvedPair);

  if (regimeEngines.has(key)) {
    return { success: false, error: 'Regime engine already running for this fund' };
  }

  // Refuse to start a closed fund — operator must reopen it first.
  const { loadRegimeState } = require('../src/state-tracker');
  const savedState = loadRegimeState(exchange, resolvedPair);
  if (savedState?.position?.lifecycle === LIFECYCLE.CLOSED) {
    return { success: false, error: 'Fund is closed — call regime:reopen before starting' };
  }

  const { getAdapter } = require('../src/adapters');
  const fundConfig = getFundConfig(exchange, resolvedPair);
  const adapter = getAdapter(exchange);

  if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
    return { success: false, error: 'API keys not configured for this exchange' };
  }

  const engine = createRegimeEngine(exchange, resolvedPair, fundConfig, createEngineCallbacks(exchange, resolvedPair));
  regimeEngines.set(key, engine);

  const startResult = await engine.start();

  if (!startResult.success) {
    regimeEngines.delete(key);
    return { success: false, error: startResult.error || 'Failed to start regime engine' };
  }

  // Auto-close: engine detected a drained fund and closed it instead of running
  if (startResult.autoClosed) {
    regimeEngines.delete(key);
    log('INFO', `🛑 [${label}] Fund auto-closed (empty draining position)`);
    return { success: true, exchange, pair: resolvedPair, autoClosed: true };
  }

  stopMarketDataService(exchange, resolvedPair);
  invalidateStandaloneLedger(exchange, resolvedPair);
  saveRegimeRunningFlag(exchange, resolvedPair, true);

  log('INFO', `🚀 [${label}] Regime engine started`);
  return { success: true, exchange, pair: resolvedPair, status: engine.getStatus() };
});

ipcServer.onRequest('regime:stop', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  const label = fundLabel(exchange, resolvedPair);

  const engine = regimeEngines.get(key);
  if (!engine) {
    return { success: false, error: 'Regime engine not running for this fund' };
  }

  log('INFO', `🛑 [${label}] Stopping regime engine...`);

  await startMarketDataService(exchange, resolvedPair);
  wireMarketDataCallbacks(exchange, resolvedPair);

  const stopResult = await engine.stop().catch((err) => {
    log('ERROR', `❌ [${label}] Error stopping engine: ${err.message}`);
    return { error: err.message };
  });

  if (stopResult?.error) {
    return { success: false, error: stopResult.error };
  }

  regimeEngines.delete(key);
  invalidateStandaloneLedger(exchange, resolvedPair);
  saveRegimeRunningFlag(exchange, resolvedPair, false);

  log('INFO', `✅ [${label}] Regime engine stopped successfully`);
  return { success: true, exchange, pair: resolvedPair, stopped: true };
});

ipcServer.onRequest('regime:status', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  const engine = regimeEngines.get(key);

  if (!engine) {
    const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
    const celestialHierarchy = require('../src/celestial-hierarchy');
    const savedState = loadRegimeState(exchange, resolvedPair);
    const position = savedState?.position || null;
    const config = getRegimeConfig(exchange, resolvedPair);
    const marketService = getMarketDataService(exchange, resolvedPair);
    const serviceStatus = marketService ? marketService.getStatus() : null;

    // Auto-close: if fund is draining but position is fully empty, transition to closed
    if (position && position.lifecycle === LIFECYCLE.DRAINING) {
      const bodies = position.celestialBodies || [];
      const hasPosition = (position.totalAsset || 0) > 0 || bodies.length > 0;
      if (!hasPosition) {
        position.lifecycle = LIFECYCLE.CLOSED;
        position.lifecycleChangedAt = Date.now();
        position.lifecycleClosedCycle = position.cyclesCompleted || 0;
        saveRegimeState(position, savedState.regime, exchange, savedState.tpOptimizer, savedState.sizeOptimizer, resolvedPair);
        saveRegimeRunningFlag(exchange, resolvedPair, false);
        log('INFO', `🛑 [${fundLabel(exchange, resolvedPair)}] Draining fund has empty position — auto-closed`);
      }
    }

    const bodies = position?.celestialBodies || [];
    const celestial = {
      enabled: config.celestialEnabled !== false,
      bodies: bodies.map((b) => {
        const tierCfg = celestialHierarchy.getTierConfig(b.tier);
        return {
          id: b.id, tier: b.tier, emoji: tierCfg.emoji,
          assetQty: b.assetQty, costBasis: b.costBasis, avgPrice: b.avgPrice,
          tpOrderId: b.tpOrderId, tpPrice: b.tpPrice,
          tpPercent: b.avgPrice > 0 && b.tpPrice > 0 ? ((b.tpPrice - b.avgPrice) / b.avgPrice * 100).toFixed(2) : null,
          assetOnOrder: b.assetOnOrder, createdAt: b.createdAt,
          lastMergedAt: b.lastMergedAt, mergeCount: b.mergeCount,
          buyOrders: (b.buyOrders || []).map((bo) => ({
            orderId: bo.orderId, price: bo.price, assetQty: bo.assetQty,
            sizeUsdc: bo.sizeUsdc, filledAt: bo.filledAt,
          })),
        };
      }),
      bodiesActive: bodies.length,
      bodiesCompleted: position?.celestialState?.bodiesCompleted || 0,
      bodiesRealizedPnL: position?.celestialState?.bodiesRealizedPnL || 0,
      bodiesRealizedAssetPnL: position?.celestialState?.bodiesRealizedAssetPnL || 0,
      tierSummary: celestialHierarchy.getTierSummary(bodies),
    };

    const { calculateApyMetrics } = require('../src/apy-calculator');
    const lastPrice = serviceStatus?.market?.lastPrice || 0;
    const apy = position ? calculateApyMetrics(position, config, { lastPrice }) : {};

    return {
      success: true, exchange, pair: resolvedPair, running: false,
      status: {
        isRunning: false,
        market: serviceStatus?.market || null,
        regime: serviceStatus?.regime || null,
        position, celestial, apy,
        health: { mode: 'STOPPED' },
        isDryRun: savedState?.isDryRun || false,
        lifecycle: {
          lifecycle: position?.lifecycle || LIFECYCLE.ACTIVE,
          lifecycleChangedAt: position?.lifecycleChangedAt || null,
          lifecycleReason: position?.lifecycleReason || null,
          lifecycleClosedCycle: position?.lifecycleClosedCycle || null,
        },
      },
    };
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
  log('INFO', `🔓 [${fundLabel(exchange, resolvedPair)}] Fund reopened — lifecycle=active`);
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

ipcServer.onRequest('regime:set-body-tp', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.setBodyTpPercent(payload.bodyId, payload.tpPct);
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
    const ledger = getStandaloneLedger(exchange, resolvedPair);
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

// Stop all running regime engines (used by backup restore)
ipcServer.onRequest('regime:stop-all', async () => {
  const stopped = [];
  for (const [key, engine] of regimeEngines) {
    const [stoppedExchange, stoppedPair] = key.split('::');
    log('INFO', `🛑 [${fundLabel(stoppedExchange, stoppedPair)}] Stopping regime engine (stop-all)...`);
    await engine.stop().catch((err) => {
      log('ERROR', `❌ [${fundLabel(stoppedExchange, stoppedPair)}] Error stopping engine: ${err.message}`);
    });
    stopped.push({ exchange: stoppedExchange, pair: stoppedPair });
    saveRegimeRunningFlag(stoppedExchange, stoppedPair, false);
  }
  regimeEngines.clear();
  return { success: true, stopped };
});

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

ipcServer.onRequest('regime:recalculate', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { apply = false } = payload || {};
  const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');

  invalidateStandaloneLedger(exchange, resolvedPair);
  const fillLedger = getStandaloneLedger(exchange, resolvedPair);
  const currentState = loadRegimeState(exchange, resolvedPair);

  const recalcResult = fillLedger.recalculateCycles();
  const currentCycleFills = fillLedger.getCurrentCycleFills();
  const currentPosition = fillLedger.rebuildPositionFromFills(currentCycleFills);

  const totalRealizedPnL = recalcResult.globalRealizedPnL;
  const totalRealizedAssetPnL = recalcResult.globalRealizedAssetPnL;

  const changes = {
    cyclesCompleted: { before: currentState.position?.cyclesCompleted || 0, after: recalcResult.cyclesCompleted },
    realizedPnL: { before: currentState.position?.realizedPnL || 0, after: totalRealizedPnL },
    realizedAssetPnL: { before: currentState.position?.realizedAssetPnL || 0, after: totalRealizedAssetPnL },
    ladderStep: { before: currentState.position?.ladderStep || 0, after: currentPosition.ladderStep },
    totalAsset: { before: currentState.position?.totalAsset || 0, after: currentPosition.totalAsset },
    totalCostBasis: { before: currentState.position?.totalCostBasis || 0, after: currentPosition.totalCostBasis },
  };

  if (apply) {
    const bodyOnlyPnL = totalRealizedPnL - recalcResult.realizedPnL;
    const bodyOnlyBtcPnL = totalRealizedAssetPnL - recalcResult.realizedAssetPnL;
    const celestialState = currentState.position?.celestialState || {};
    const updatedPosition = {
      ...currentState.position,
      ...currentPosition,
      cyclesCompleted: recalcResult.cyclesCompleted,
      realizedPnL: totalRealizedPnL,
      realizedAssetPnL: totalRealizedAssetPnL,
      celestialState: {
        ...celestialState,
        bodiesRealizedPnL: Math.round(bodyOnlyPnL * 100) / 100,
        bodiesRealizedAssetPnL: Math.round(bodyOnlyBtcPnL * 1e8) / 1e8,
      },
    };

    const bodies = updatedPosition.celestialBodies || [];
    if (bodies.length > 0) {
      const { syncPositionState } = require('../src/celestial-hierarchy');
      syncPositionState(updatedPosition, bodies);
    }

    saveRegimeState(updatedPosition, currentState.regime, exchange, currentState.tpOptimizer, currentState.sizeOptimizer, resolvedPair);
    fillLedger.persist();

    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
    if (engine?.updatePosition) {
      engine.updatePosition(updatedPosition);
    }
  }

  return {
    success: true, exchange, pair: resolvedPair, applied: apply, changes,
    cycleDetails: recalcResult.cycleDetails,
    orphansFixed: recalcResult.orphansFixed,
    activeCycleId: recalcResult.activeCycleId,
    currentCycleFills: currentCycleFills.length,
  };
});

ipcServer.onRequest('regime:sync-fills', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { dryRun = false } = payload || {};
  const { syncFills } = require('../src/sync-fills');

  invalidateStandaloneLedger(exchange, resolvedPair);
  const fillLedger = getStandaloneLedger(exchange, resolvedPair);

  const result = await syncFills(exchange, fillLedger, { dryRun });
  return result;
});

ipcServer.onRequest('regime:convert-dca', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  if (regimeEngines.has(fundKey(exchange, resolvedPair))) {
    return { success: false, error: 'Regime engine is running — stop it before converting DCA orders' };
  }
  const { preview = true, merge = false } = payload || {};
  const { previewConversion, executeConversion, mergeToRegime } = require('../src/dca-converter');

  if (preview) {
    return { success: true, preview: true, exchange, pair: resolvedPair, ...previewConversion(exchange) };
  }

  const result = merge ? mergeToRegime(exchange) : executeConversion(exchange);
  invalidateStandaloneLedger(exchange, resolvedPair);
  return { success: true, preview: false, exchange, pair: resolvedPair, ...result };
});

// ============ Startup ============

const startup = async () => {
  const { version } = require('../package.json');
  const label = EXCHANGE_NAME.charAt(0).toUpperCase() + EXCHANGE_NAME.slice(1);
  log('INFO', `\n📡 ${label} Engine v${version}`);
  log('INFO', `   IPC: ws://127.0.0.1:${IPC_PORT}`);

  const exchange = EXCHANGE_NAME;

  // ===== One-time multi-pair migration =====
  // Move legacy data/<exchange>/ files into data/<exchange>/<defaultPair>/.
  // Idempotent: returns no-op if already migrated. See UPGRADE.md.
  const migrationResult = migrateExchangeToPairs(exchange);
  if (migrationResult.migrated) {
    log('INFO', `✅ [${exchange}] Pair migration complete: moved ${migrationResult.movedFiles} files into ${exchange}/${migrationResult.defaultPair}/`);
  } else if (migrationResult.reason && !migrationResult.reason.startsWith('no-op')) {
    log('ERROR', `❌ [${exchange}] Pair migration failed: ${migrationResult.reason}`);
    log('ERROR', `❌ [${exchange}] Refusing to start engine. See UPGRADE.md for instructions.`);
    process.exit(1);
  }

  ipcServer.start();

  // Auto-resume each fund (exchange + pair) that was running before restart
  const fundsForExchange = getFundsForExchange(exchange);
  for (const fundPair of fundsForExchange) {
    const label = fundLabel(exchange, fundPair);
    const key = fundKey(exchange, fundPair);

    if (shouldAutoResumeRegime(exchange, fundPair)) {
      // Skip auto-resume for closed funds — the operator must explicitly reopen.
      const { loadRegimeState } = require('../src/state-tracker');
      const savedState = loadRegimeState(exchange, fundPair);
      if (savedState?.position?.lifecycle === LIFECYCLE.CLOSED) {
        log('INFO', `🛑 [${label}] Skipping auto-resume: fund is closed (call regime:reopen to reactivate)`);
        saveRegimeRunningFlag(exchange, fundPair, false);
        continue;
      }
      log('INFO', `🔄 [${label}] Auto-resuming regime engine from previous session...`);

      const { getAdapter } = require('../src/adapters');
      const fundConfig = getFundConfig(exchange, fundPair);
      const adapter = getAdapter(exchange);

      if (adapter.hasValidKeys && adapter.hasValidKeys()) {
        const engine = createRegimeEngine(exchange, fundPair, fundConfig, createEngineCallbacks(exchange, fundPair));
        regimeEngines.set(key, engine);

        const startResult = await engine.start();
        if (startResult.autoClosed) {
          regimeEngines.delete(key);
          log('INFO', `🛑 [${label}] Fund auto-closed on resume (empty draining position)`);
        } else if (startResult.success) {
          log('INFO', `✅ [${label}] Regime engine auto-resumed successfully`);
        } else {
          log('ERROR', `❌ [${label}] Failed to auto-resume: ${startResult.error}`);
          regimeEngines.delete(key);
          saveRegimeRunningFlag(exchange, fundPair, false);
        }
      } else {
        log('WARN', `⚠️ [${label}] Cannot auto-resume: API keys not configured`);
        saveRegimeRunningFlag(exchange, fundPair, false);
      }
    }

    // Start passive market data service for funds whose engine isn't running
    if (!regimeEngines.has(key)) {
      const regimeConfig = getRegimeConfig(exchange, fundPair);
      if (regimeConfig && Object.keys(regimeConfig).length > 0) {
        log('INFO', `📊 [${label}] Starting market data service...`);
        startMarketDataService(exchange, fundPair)
          .then(() => wireMarketDataCallbacks(exchange, fundPair))
          .catch((err) => {
            log('WARN', `⚠️ [${label}] Failed to start market data service: ${err.message}`);
          });
      }
    }
  }
};

startup().catch((err) => {
  log('ERROR', `Startup failed: ${err.message}`);
  process.exit(1);
});

// ============ Graceful Shutdown ============

const gracefulShutdown = async (signal) => {
  log('INFO', `Received ${signal}, shutting down...`);

  stopAllMarketDataServices();

  const stopPromises = [];
  for (const [key, engine] of regimeEngines) {
    log('INFO', `Stopping regime engine for ${key}...`);
    stopPromises.push(engine.stop());
  }
  await Promise.all(stopPromises);

  shutdownAllBuffers();
  ipcServer.stop();

  log('INFO', `Shutdown complete`);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
