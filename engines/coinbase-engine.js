// @ts-check
/**
 * Coinbase Engine Process
 *
 * Standalone PM2 process that runs:
 * - Coinbase regime engine (buy/sell cycle management)
 * - Market data service (WebSocket price feeds, ATR, regime detection)
 * - Chart data buffer
 * - IPC WebSocket server (:5570) for communication with the gateway
 *
 * The gateway (server.js) connects as an IPC client and forwards:
 * - Socket.IO events from the engine (regime:status, trade:event, etc.)
 * - Regime control commands from the admin UI (start/stop/pause/resume/etc.)
 */

const path = require('path');
const { log } = require('../src/logger');
const {
  getExchangeConfig,
  getRegimeConfig,
  getConfiguredExchanges,
} = require('../src/config-utils');
const { createRegimeEngine } = require('../src/regime-engine');
const {
  startMarketDataService,
  stopAllMarketDataServices,
  getMarketDataService,
  stopMarketDataService,
} = require('../src/market-data-service');
const { getChartDataBuffer, getChartData, shutdownAllBuffers } = require('../src/chart-data-buffer');
const { createFillLedger } = require('../src/fill-ledger');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createSocketIOProxy } = require('../src/ipc/socket-io-proxy');
const { saveRegimeRunningFlag, shouldAutoResumeRegime } = require('../src/shared-utils');

// ============ Configuration ============

const IPC_PORT = parseInt(process.env.COINBASE_IPC_PORT) || 5570;
const ENGINE_NAME = 'cm-coinbase';

// ============ IPC Server ============

const ipcServer = createIPCServer(IPC_PORT, ENGINE_NAME);
const ioProxy = createSocketIOProxy(ipcServer);

// ============ Engine State ============

/** @type {Map<string, Object>} Active regime engines by exchange */
const regimeEngines = new Map();

/** @type {Map<string, Object>} Cached standalone fill ledgers */
const standaloneLedgers = new Map();

const getStandaloneLedger = (exchange) => {
  if (!standaloneLedgers.has(exchange)) {
    const exchConfig = getExchangeConfig(exchange);
    standaloneLedgers.set(exchange, createFillLedger(exchange, exchConfig?.productId));
  }
  return standaloneLedgers.get(exchange);
};

const invalidateStandaloneLedger = (exchange) => {
  standaloneLedgers.delete(exchange);
};

// ============ Engine Callbacks ============

const wireMarketDataCallbacks = (exchange) => {
  const service = getMarketDataService(exchange);
  if (!service) return;
  service.setOnStatusUpdate((status) => {
    getChartDataBuffer(exchange).processStatus(status);
    ioProxy.emit('regime:status', { exchange, status });
  });
};

const createEngineCallbacks = (exchange) => ({
  onTradeEvent: (event) => ioProxy.emit('trade:event', event),
  onRegimeChange: (prevMode, newMode, reason) =>
    ioProxy.emit('regime:change', { exchange, prevMode, newMode, reason, message: `${prevMode} -> ${newMode}` }),
  onHealthChange: (mode, reason) =>
    ioProxy.emit('regime:health', { exchange, mode, reason, message: reason || `Health: ${mode}` }),
  onPositionUpdate: (data) =>
    ioProxy.emit('regime:position', { exchange, ...data }),
  onStatusUpdate: (status) => {
    getChartDataBuffer(exchange).processStatus(status);
    ioProxy.emit('regime:status', { exchange, status });
  },
});

// ============ IPC Request Handlers ============

// Regime engine control
ipcServer.onRequest('regime:start', async (payload, exchange) => {
  if (regimeEngines.has(exchange)) {
    return { success: false, error: 'Regime engine already running for this exchange' };
  }

  const { getAdapter } = require('../src/adapters');
  const exchangeConfig = getExchangeConfig(exchange);
  const adapter = getAdapter(exchange);

  if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
    return { success: false, error: 'API keys not configured for this exchange' };
  }

  const engine = createRegimeEngine(exchange, exchangeConfig, createEngineCallbacks(exchange));
  regimeEngines.set(exchange, engine);

  const startResult = await engine.start();

  if (!startResult.success) {
    regimeEngines.delete(exchange);
    return { success: false, error: startResult.error || 'Failed to start regime engine' };
  }

  stopMarketDataService(exchange);
  invalidateStandaloneLedger(exchange);
  saveRegimeRunningFlag(exchange, true);

  log('INFO', `🚀 [${exchange}] Regime engine started`);
  return { success: true, exchange, status: engine.getStatus() };
});

ipcServer.onRequest('regime:stop', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) {
    return { success: false, error: 'Regime engine not running for this exchange' };
  }

  log('INFO', `🛑 [${exchange}] Stopping regime engine...`);

  await startMarketDataService(exchange);
  wireMarketDataCallbacks(exchange);

  const stopResult = await engine.stop().catch((err) => {
    log('ERROR', `❌ [${exchange}] Error stopping engine: ${err.message}`);
    return { error: err.message };
  });

  if (stopResult?.error) {
    return { success: false, error: stopResult.error };
  }

  regimeEngines.delete(exchange);
  invalidateStandaloneLedger(exchange);
  saveRegimeRunningFlag(exchange, false);

  log('INFO', `✅ [${exchange}] Regime engine stopped successfully`);
  return { success: true, exchange, stopped: true };
});

ipcServer.onRequest('regime:status', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);

  if (!engine) {
    const { loadRegimeState } = require('../src/state-tracker');
    const celestialHierarchy = require('../src/celestial-hierarchy');
    const savedState = loadRegimeState(exchange);
    const position = savedState?.position || null;
    const config = getRegimeConfig(exchange);
    const marketService = getMarketDataService(exchange);
    const serviceStatus = marketService ? marketService.getStatus() : null;

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
      success: true, exchange, running: false,
      status: {
        isRunning: false,
        market: serviceStatus?.market || null,
        regime: serviceStatus?.regime || null,
        position, celestial, apy,
        health: { mode: 'STOPPED' },
        isDryRun: savedState?.isDryRun || false,
      },
    };
  }

  return { success: true, exchange, running: true, status: engine.getStatus() };
});

ipcServer.onRequest('regime:pause', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.pause(payload?.reason || 'Manual pause via API');
  return { success: true, exchange, paused: true, status: engine.getStatus() };
});

ipcServer.onRequest('regime:resume', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.resume();
  return { success: true, exchange, resumed: true, status: engine.getStatus() };
});

ipcServer.onRequest('regime:force-regime', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  engine.forceRegime(payload.regime, payload.reason || 'Forced via API');
  return { success: true, exchange, regime: payload.regime, status: engine.getStatus() };
});

ipcServer.onRequest('regime:resume-drawdown', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = engine.forceResumeDrawdown();
  return { success: result.success, exchange, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:preview-ladder', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.previewLadder();
  return { ...result, exchange, status: engine.getStatus() };
});

ipcServer.onRequest('regime:rebuild-ladder', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.rebuildLadder();
  return { success: result.success, exchange, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:cancel-ladder', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.cancelLadder();
  return { success: result.success, exchange, message: result.message, status: engine.getStatus() };
});

ipcServer.onRequest('regime:rollup-body', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.manualMergeBody(payload.bodyId);
  return { success: result.success, exchange, message: result.message, mergedBody: result.mergedBody || null, status: engine.getStatus() };
});

ipcServer.onRequest('regime:config', async (payload, exchange) => {
  const regimeConfig = getRegimeConfig(exchange);
  const exchangeConfig = getExchangeConfig(exchange);
  return { ...regimeConfig, dryRun: exchangeConfig.dryRun, productId: exchangeConfig.productId };
});

ipcServer.onRequest('regime:update-config', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (engine) {
    engine.updateConfig(payload);
  }
  return { success: true };
});

ipcServer.onRequest('regime:chart-data', async (payload, exchange) => {
  const chartData = getChartData(exchange);
  if (!chartData) {
    return { priceHistory: [], atrHistory: [], regimeHistory: [], exchange, timestamp: Date.now() };
  }
  return chartData;
});

ipcServer.onRequest('regime:fills', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) {
    const ledger = getStandaloneLedger(exchange);
    return { running: false, fills: ledger.getAllFills(), stats: ledger.getStats() };
  }
  return { running: true, fills: engine.getFills(), stats: engine.getFillStats() };
});

ipcServer.onRequest('regime:open-orders', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (engine) {
    return { running: true, orders: engine.getOpenOrders ? engine.getOpenOrders() : [] };
  }

  const marketService = getMarketDataService(exchange);
  const { loadRegimeState } = require('../src/state-tracker');
  const savedState = loadRegimeState(exchange);
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

  return { running: false, orders };
});

ipcServer.onRequest('regime:dry-run-log', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  return { success: true, isDryRun: true, log: engine.getDryRunLog(payload?.limit || 100) };
});

ipcServer.onRequest('regime:dry-run-pnl', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  const pnl = engine.getDryRunPnL();
  const state = engine.getState();
  return { success: true, isDryRun: true, pnl, position: state.position, cyclesCompleted: state.position.cyclesCompleted, realizedPnL: state.position.realizedPnL, unrealizedPnL: state.position.unrealizedPnL };
});

ipcServer.onRequest('regime:dry-run-reset', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  if (!engine.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  const reset = engine.resetDryRun();
  return { success: reset, status: engine.getStatus() };
});

ipcServer.onRequest('regime:dry-run-state', async (payload, exchange) => {
  const engine = regimeEngines.get(exchange);
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const state = engine.getState();
  if (!state.isDryRun) return { success: false, error: 'Not in dry-run mode' };
  return { success: true, isDryRun: true, dryRunState: state.dryRun, position: state.position, regime: state.regime, market: state.market };
});

// Stop all running regime engines (used by backup restore)
ipcServer.onRequest('regime:stop-all', async () => {
  const stopped = [];
  for (const [exchange, engine] of regimeEngines) {
    log('INFO', `🛑 [${exchange}] Stopping regime engine (stop-all)...`);
    await engine.stop().catch((err) => {
      log('ERROR', `❌ [${exchange}] Error stopping engine: ${err.message}`);
    });
    stopped.push(exchange);
    saveRegimeRunningFlag(exchange, false);
  }
  regimeEngines.clear();
  return { success: true, stopped };
});

// Exchange info queries
ipcServer.onRequest('exchanges:list', async () => {
  const configured = getConfiguredExchanges();
  return configured.map((name) => {
    const engine = regimeEngines.get(name);
    return {
      name,
      regimeRunning: engine?.getState?.()?.isRunning || false,
    };
  });
});

ipcServer.onRequest('regime:recalculate', async (payload, exchange) => {
  const { apply = false } = payload || {};
  const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');

  invalidateStandaloneLedger(exchange);
  const fillLedger = getStandaloneLedger(exchange);
  const currentState = loadRegimeState(exchange);

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

    saveRegimeState(updatedPosition, currentState.regime, exchange, currentState.tpOptimizer, currentState.sizeOptimizer);
    fillLedger.persist();

    const engine = regimeEngines.get(exchange);
    if (engine?.updatePosition) {
      engine.updatePosition(updatedPosition);
    }
  }

  return {
    success: true, exchange, applied: apply, changes,
    cycleDetails: recalcResult.cycleDetails,
    orphansFixed: recalcResult.orphansFixed,
    activeCycleId: recalcResult.activeCycleId,
    currentCycleFills: currentCycleFills.length,
  };
});

ipcServer.onRequest('regime:convert-dca', async (payload, exchange) => {
  if (regimeEngines.has(exchange)) {
    return { success: false, error: 'Regime engine is running — stop it before converting DCA orders' };
  }
  const { preview = true, merge = false } = payload || {};
  const { previewConversion, executeConversion, mergeToRegime } = require('../src/dca-converter');

  if (preview) {
    return { success: true, preview: true, exchange, ...previewConversion(exchange) };
  }

  const result = merge ? mergeToRegime(exchange) : executeConversion(exchange);
  invalidateStandaloneLedger(exchange);
  return { success: true, preview: false, exchange, ...result };
});

// ============ Startup ============

const startup = async () => {
  const { version } = require('../package.json');
  log('INFO', `\n📡 Coinbase Engine v${version}`);
  log('INFO', `   IPC: ws://127.0.0.1:${IPC_PORT}`);

  ipcServer.start();

  // Auto-resume regime engines that were running before restart
  const configuredExchanges = getConfiguredExchanges();
  for (const exchange of configuredExchanges) {
    // Kalshi has its own engine process (cm-kalshi)
    if (exchange === 'kalshi') continue;

    if (shouldAutoResumeRegime(exchange)) {
      log('INFO', `🔄 [${exchange}] Auto-resuming regime engine from previous session...`);

      const { getAdapter } = require('../src/adapters');
      const exchangeConfig = getExchangeConfig(exchange);
      const adapter = getAdapter(exchange);

      if (adapter.hasValidKeys && adapter.hasValidKeys()) {
        const engine = createRegimeEngine(exchange, exchangeConfig, createEngineCallbacks(exchange));
        regimeEngines.set(exchange, engine);

        const startResult = await engine.start();
        if (startResult.success) {
          log('INFO', `✅ [${exchange}] Regime engine auto-resumed successfully`);
        } else {
          log('ERROR', `❌ [${exchange}] Failed to auto-resume: ${startResult.error}`);
          regimeEngines.delete(exchange);
          saveRegimeRunningFlag(exchange, false);
        }
      } else {
        log('WARN', `⚠️ [${exchange}] Cannot auto-resume: API keys not configured`);
        saveRegimeRunningFlag(exchange, false);
      }
    }

    // Start market data service for passive streaming
    const regimeConfig = getRegimeConfig(exchange);
    if (regimeConfig && Object.keys(regimeConfig).length > 0 && !regimeEngines.has(exchange)) {
      log('INFO', `📊 [${exchange}] Starting market data service...`);
      startMarketDataService(exchange)
        .then(() => wireMarketDataCallbacks(exchange))
        .catch((err) => {
          log('WARN', `⚠️ [${exchange}] Failed to start market data service: ${err.message}`);
        });
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
  for (const [exchange, engine] of regimeEngines) {
    log('INFO', `Stopping regime engine for ${exchange}...`);
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
