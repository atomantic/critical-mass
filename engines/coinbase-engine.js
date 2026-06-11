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
    // createFillLedger throws on cold-start corruption (refuses to boot
    // empty so a subsequent persist can't overwrite a recoverable file).
    // Log full detail (absolute path + parser error) server-side and throw
    // a sanitized message — the IPC framework propagates this back to
    // clients, so we keep filesystem internals out of the API surface.
    let ledger;
    try {
      ledger = createFillLedger(exchange, fundConfig?.productId, resolvedPair);
    } catch (err) {
      log('ERROR', `❌ [${exchange}/${resolvedPair}] Fill ledger init failed: ${err.message}`);
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
    log('ERROR', `❌ [${label}] Fill ledger init failed on regime:start: ${err.message}`);
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
    log('WARN', `⚠️ [${label}] Standalone market-data-service did not start (${mdsResult?.error || 'unknown'}); proceeding with engine stop, will retry handover after stop in case its persist repaired a corrupt ledger`);
  }

  const stopResult = await engine.stop().catch((err) => {
    log('ERROR', `❌ [${label}] Error stopping engine: ${err.message}`);
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
      log('INFO', `✅ [${label}] Standalone market-data-service started after engine stop`);
    } else {
      log('WARN', `⚠️ [${label}] Standalone market-data-service still not available after engine stop (${retryResult?.error || 'unknown'}) — fund has no WS service while stopped`);
    }
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
    const celestial = celestialHierarchy.buildCelestialPayload(position, config);

    // Re-derive over the ledger so realizedPnL / realizedAssetPnL /
    // heldAssetCostBasis reflect current state — persisted values can be stale
    // (engine stopped before a bugfix landed, or operator-edited ledger).
    if (position) {
      try {
        const { createFillLedger } = require('../src/fill-ledger');
        const productId = config.productId || resolvedPair;
        const fl = createFillLedger(exchange, productId, resolvedPair);
        const derived = fl.getDerivedRealizedPnL();
        position.realizedPnL = derived.realizedPnL;
        position.realizedAssetPnL = derived.realizedAssetPnL;
        position.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
      } catch (e) {
        log('WARN', `[${fundLabel(exchange, resolvedPair)}] offline cycle-pair derivation failed: ${e.message}`);
      }
    }

    const { calculateApyMetrics } = require('../src/apy-calculator');
    const lastPrice = serviceStatus?.market?.lastPrice || 0;
    const apy = position ? calculateApyMetrics(position, config, { lastPrice }) : {};

    // Surface persisted TPs (bodies + legacy core) as pendingOrders so the
    // dashboard keeps mapping buys to their open sells while the engine is
    // stopped. Pass the market service's live tracker so any TP it's
    // already seen filled/cancelled is dropped (no phantom open rows).
    const pendingOrders = celestialHierarchy.buildPersistedPendingOrders(
      position,
      marketService?.getOrderStatus,
    );

    return {
      success: true, exchange, pair: resolvedPair, running: false,
      status: {
        isRunning: false,
        market: serviceStatus?.market || null,
        regime: serviceStatus?.regime || null,
        position, celestial, apy, pendingOrders,
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

ipcServer.onRequest('regime:rollup-all', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (!engine) return { success: false, error: 'Regime engine not running' };
  const result = await engine.rollupAllBodies();
  return { success: result.success, exchange, pair: resolvedPair, message: result.message, mergedCount: result.mergedCount || 0, finalBody: result.finalBody || null, status: engine.getStatus() };
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

  const currentState = loadRegimeState(exchange, resolvedPair);
  const before = {
    cyclesCompleted: currentState.position?.cyclesCompleted || 0,
    realizedPnL: currentState.position?.realizedPnL || 0,
    realizedAssetPnL: currentState.position?.realizedAssetPnL || 0,
  };

  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));

  // P&L source of truth is the cycle-pair derivation (realizedPnL = Σ per-sell
  // bodyPnl; realizedAssetPnL = Σ bodyHoldbackAsset). NOT FIFO globals and NOT
  // closed-trades — both over-count (closed-trades prorates buy cost by sold
  // qty, leaving holdback cost unattributed; FIFO ignores cycle boundaries).
  // When the engine is running, recompute on ITS ledger and re-derive in place
  // so we never (a) open a second ledger on the same file, (b) write a
  // FIFO/closed-trades number to disk, or (c) blind-merge a rebuilt position
  // that nulls activeTpOrderId / resurrects stale bodies (issue #96).
  let result;
  if (engine?.recalculateAndRefresh) {
    if (!apply) {
      // Preview only: derive P&L read-only via getDerivedRealizedPnL (no
      // mutation). cycleDetails/orphansFixed require recalculateCycles(), which
      // mutates the ledger (stamps orphan cycleIds, sets the dirty flag) — we
      // must NOT run that on the LIVE engine ledger during a preview the
      // operator may cancel (the engine's periodic save could then persist a
      // recalc the operator didn't apply). So the running-engine preview shows
      // the P&L delta but leaves cycleDetails empty / orphansFixed 0; the Apply
      // below runs the real recalc. A read-only recalc variant for full preview
      // fidelity is tracked separately (issue #132).
      const fillLedger = engine.getFillLedger();
      const derived = fillLedger.getDerivedRealizedPnL();
      const cycleFills = fillLedger.getCurrentCycleFills();
      result = {
        cyclesCompleted: before.cyclesCompleted,
        realizedPnL: derived.realizedPnL,
        realizedAssetPnL: derived.realizedAssetPnL,
        cycleDetails: [],
        orphansFixed: 0,
        previewLimited: true, // running-engine preview omits cycleDetails/orphansFixed (see above)
        activeCycleId: fillLedger.getCurrentCycleId(),
        currentCycleFills: cycleFills.length,
      };
    } else {
      const r = engine.recalculateAndRefresh();
      result = { ...r, currentCycleFills: engine.getFillLedger().getCurrentCycleFills().length };
    }
  } else {
    // Engine not running — operate on the standalone ledger directly.
    invalidateStandaloneLedger(exchange, resolvedPair);
    let fillLedger;
    try {
      fillLedger = getStandaloneLedger(exchange, resolvedPair);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const recalc = fillLedger.recalculateCycles();
    const derived = fillLedger.getDerivedRealizedPnL();
    const cycleFills = fillLedger.getCurrentCycleFills();
    result = {
      cyclesCompleted: recalc.cyclesCompleted,
      realizedPnL: derived.realizedPnL,
      realizedAssetPnL: derived.realizedAssetPnL,
      cycleDetails: recalc.cycleDetails,
      orphansFixed: recalc.orphansFixed,
      activeCycleId: recalc.activeCycleId,
      currentCycleFills: cycleFills.length,
    };

    if (apply) {
      // Persist ONLY the cycle-derived P&L fields onto the existing position —
      // do not rebuild/overwrite order tracking, lifecycle, or bodies.
      const position = {
        ...currentState.position,
        cyclesCompleted: recalc.cyclesCompleted,
        realizedPnL: derived.realizedPnL,
        realizedAssetPnL: derived.realizedAssetPnL,
        heldAssetCostBasis: derived.heldOpenBuyCostBasis,
      };
      if (position.celestialState) {
        position.celestialState = {
          ...position.celestialState,
          bodiesRealizedPnL: derived.realizedPnL,
          bodiesRealizedAssetPnL: derived.realizedAssetPnL,
        };
      }
      saveRegimeState(position, currentState.regime, exchange, currentState.tpOptimizer, currentState.sizeOptimizer, resolvedPair);
      fillLedger.persist();
    }
  }

  const changes = {
    cyclesCompleted: { before: before.cyclesCompleted, after: result.cyclesCompleted },
    realizedPnL: { before: before.realizedPnL, after: result.realizedPnL },
    realizedAssetPnL: { before: before.realizedAssetPnL, after: result.realizedAssetPnL },
  };

  return {
    success: true, exchange, pair: resolvedPair, applied: apply, changes,
    cycleDetails: result.cycleDetails,
    orphansFixed: result.orphansFixed,
    activeCycleId: result.activeCycleId,
    currentCycleFills: result.currentCycleFills,
    // Forward the running-engine preview limitation so the dashboard can warn
    // that cycleDetails/orphansFixed are omitted until Apply (issue #132).
    ...(result.previewLimited ? { previewLimited: true } : {}),
  };
});


// ============ Manual Trade Tracking ============

/** @type {Map<string, Object>} Cached manual trade stores keyed by `${exchange}::${pair}` */
const manualTradeStores = new Map();

/**
 * Ingest adapter fills into the fill-ledger, accumulating totals.
 * Avoids duplicated ingestion loops across manual-trade handlers.
 * @returns {{ tradeIds: string[], totalSize: number, totalQuote: number }}
 */
const ingestAdapterFills = (fillLedger, fills, orderId, defaultSide) => {
  const tradeIds = [];
  let totalSize = 0;
  let totalQuote = 0;
  for (const raw of fills) {
    tradeIds.push(raw.tradeId);
    totalSize += raw.size;
    totalQuote += raw.price * raw.size;
    fillLedger.ingestFill({
      tradeId: raw.tradeId,
      orderId,
      side: raw.side?.toLowerCase() || defaultSide,
      price: raw.price,
      size: raw.size,
      totalCommission: raw.totalCommission || raw.commission || 0,
      commission: raw.commission || 0,
      rebate: raw.rebate || 0,
      netFee: raw.netFee || raw.commission || 0,
      liquidityIndicator: raw.liquidityIndicator || 'TAKER',
      tradeTime: raw.tradeTime,
      fee_asset: 'USDC',
      // Manual-trade reconciliation fills can be days old — don't stamp the
      // live cycle (issue #108). recalculateCycles' orphan logic will place
      // them in the correct cycle by buy/sell pattern.
    }, null, { skipPersist: true, cycleId: null });
  }
  return { tradeIds, totalSize, totalQuote };
};

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

  const result = await getUnaccountedFills(exchange, fillLedger, manualTradeStore, { startDate });
  return result;
});

ipcServer.onRequest('regime:manual-trades', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const store = getManualTradeStore(exchange, resolvedPair);
  return { success: true, exchange, pair: resolvedPair, trades: store.getAll() };
});

ipcServer.onRequest('regime:manual-trade', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { sellOrderId, recoveryBuyPrice, existingBuyOrderId, note } = payload || {};

  if (!sellOrderId) {
    return { success: false, error: 'sellOrderId is required' };
  }

  const { getAdapter } = require('../src/adapters');
  const adapter = getAdapter(exchange);
  const store = getManualTradeStore(exchange, resolvedPair);

  let sellFills;
  try {
    sellFills = await adapter.getOrderFills(sellOrderId);
  } catch (err) {
    return { success: false, error: `Failed to fetch sell order fills: ${err.message}` };
  }

  if (!sellFills || sellFills.length === 0) {
    return { success: false, error: `No fills found for order ${sellOrderId}` };
  }

  let fillLedger;
  try {
    fillLedger = getActiveLedger(exchange, resolvedPair);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const { tradeIds: sellFillTradeIds, totalSize: totalSellSize, totalQuote: totalSellQuote } =
    ingestAdapterFills(fillLedger, sellFills, sellOrderId, 'sell');
  fillLedger.persist();

  const avgSellPrice = totalSellSize > 0 ? totalSellQuote / totalSellSize : 0;

  const trade = store.addManualSell({
    sellOrderId,
    sellPrice: avgSellPrice,
    sellSize: totalSellSize,
    sellQuoteAmount: totalSellQuote,
    sellTimestamp: new Date(sellFills[0].tradeTime).getTime(),
    sellFillTradeIds,
    note: note || '',
  });

  if (recoveryBuyPrice && !existingBuyOrderId) {
    const buyPrice = parseFloat(recoveryBuyPrice);
    if (isNaN(buyPrice) || buyPrice <= 0) {
      return { success: false, error: 'Invalid recoveryBuyPrice' };
    }

    const fundConfig = getFundConfig(exchange, resolvedPair);
    const productId = fundConfig?.productId || 'BTC-USDC';
    const buySize = totalSellSize; // Recover same amount

    try {
      const result = await adapter.placeLimitBuy(productId, buySize, buyPrice, { postOnly: false });
      if (result.success) {
        store.recordRecoveryBuy(trade.id, result.orderId, buyPrice, buySize);
        log('INFO', `📝 [${exchange}] Manual trade: placed recovery buy ${buySize} BTC @ $${buyPrice} (orderId=${result.orderId})`);
      } else {
        return { success: false, error: `Failed to place recovery buy: ${result.errorMessage || 'unknown'}` };
      }
    } catch (err) {
      return { success: false, error: `Failed to place recovery buy: ${err.message}` };
    }
  } else if (existingBuyOrderId) {
    store.linkExistingBuy(trade.id, existingBuyOrderId);
    log('INFO', `📝 [${exchange}] Manual trade: linked existing buy order ${existingBuyOrderId}`);
  }

  return { success: true, exchange, pair: resolvedPair, trade: store.getById(trade.id) };
});

ipcServer.onRequest('regime:manual-trade-check', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { tradeId } = payload || {};

  if (!tradeId) {
    return { success: false, error: 'tradeId is required' };
  }

  const store = getManualTradeStore(exchange, resolvedPair);
  const trade = store.getById(tradeId);
  if (!trade) {
    return { success: false, error: `Manual trade ${tradeId} not found` };
  }

  const { STATUS } = require('../src/manual-trades');
  if (trade.status !== STATUS.BUY_PENDING || !trade.buyOrderId) {
    return { success: true, exchange, pair: resolvedPair, trade, message: 'No pending buy to check' };
  }

  const { getAdapter } = require('../src/adapters');
  const adapter = getAdapter(exchange);

  let orderStatus;
  try {
    orderStatus = await adapter.getOrder(trade.buyOrderId);
  } catch (err) {
    return { success: false, error: `Failed to check buy order: ${err.message}` };
  }

  const normalizedStatus = (orderStatus.status || '').toUpperCase();

  if (normalizedStatus === 'FILLED' || orderStatus.completionPercentage >= 100) {
    // Buy filled — fetch fills and complete the trade
    let buyFills;
    try {
      buyFills = await adapter.getOrderFills(trade.buyOrderId);
    } catch (err) {
      return { success: false, error: `Buy order filled but failed to fetch fills: ${err.message}` };
    }

    let fillLedger;
    try {
      fillLedger = getActiveLedger(exchange, resolvedPair);
    } catch (err) {
      return { success: false, error: err.message };
    }

    const { tradeIds: buyFillTradeIds, totalSize: totalBuySize, totalQuote: totalBuyQuote } =
      ingestAdapterFills(fillLedger, buyFills, trade.buyOrderId, 'buy');

    fillLedger.annotateFillsByOrderId(trade.buyOrderId, { sellOrderId: trade.sellOrderId });
    fillLedger.persist();

    const avgBuyPrice = totalBuySize > 0 ? totalBuyQuote / totalBuySize : 0;
    store.markBuyFilled(tradeId, {
      buyPrice: avgBuyPrice,
      buySize: totalBuySize,
      buyFillTradeIds,
    });

    log('INFO', `✅ [${exchange}] Manual trade completed: sold ${trade.sellSize} BTC @ $${trade.sellPrice.toFixed(2)}, bought back ${totalBuySize} BTC @ $${avgBuyPrice.toFixed(2)}`);
    return { success: true, exchange, pair: resolvedPair, trade: store.getById(tradeId), filled: true };
  }

  if (normalizedStatus === 'CANCELLED') {
    return { success: true, exchange, pair: resolvedPair, trade, cancelled: true, message: 'Buy order was cancelled on exchange' };
  }

  return {
    success: true,
    exchange,
    pair: resolvedPair,
    trade,
    orderStatus: normalizedStatus,
    filledPercent: orderStatus.completionPercentage || 0,
    message: `Buy order is ${normalizedStatus}`,
  };
});

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

// ============ Manual Trade: Buy Import ============

ipcServer.onRequest('regime:manual-trade-buy', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { buyOrderId, note, createBody = true } = payload || {};

  if (!buyOrderId) {
    return { success: false, error: 'buyOrderId is required' };
  }

  const { getAdapter } = require('../src/adapters');
  const adapter = getAdapter(exchange);
  const store = getManualTradeStore(exchange, resolvedPair);

  let buyFills;
  try {
    buyFills = await adapter.getOrderFills(buyOrderId);
  } catch (err) {
    return { success: false, error: `Failed to fetch buy order fills: ${err.message}` };
  }

  if (!buyFills || buyFills.length === 0) {
    return { success: false, error: `No fills found for order ${buyOrderId}` };
  }

  let fillLedger;
  try {
    fillLedger = getActiveLedger(exchange, resolvedPair);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const { tradeIds: buyFillTradeIds, totalSize: totalBuySize, totalQuote: totalBuyQuote } =
    ingestAdapterFills(fillLedger, buyFills, buyOrderId, 'buy');
  fillLedger.persist();

  const avgBuyPrice = totalBuySize > 0 ? totalBuyQuote / totalBuySize : 0;

  const trade = store.addManualBuy({
    buyOrderId,
    buyPrice: avgBuyPrice,
    buySize: totalBuySize,
    buyQuoteAmount: totalBuyQuote,
    buyTimestamp: new Date(buyFills[0].tradeTime).getTime(),
    buyFillTradeIds,
    note: note || '',
  });

  if (createBody) {
    const { createNewBody, syncPositionState } = require('../src/celestial-hierarchy');
    const totalFees = buyFills.reduce((s, f) => s + (f.commission || f.totalCommission || 0), 0);
    const body = createNewBody({
      assetQty: totalBuySize,
      costBasis: totalBuyQuote + totalFees,
      avgPrice: avgBuyPrice,
    }, buyOrderId);

    // Annotate fills with body ownership
    fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: body.id, isBodyOwned: true, isSatellite: true, bodyTier: body.tier });
    fillLedger.persist();

    const key = fundKey(exchange, resolvedPair);
    const engine = regimeEngines.get(key);

    if (engine && engine.injectBody) {
      const injectResult = await engine.injectBody(body);
      log('INFO', `📦 [${exchange}] Manual buy import: injected body ${body.id} into running engine (TP placed: ${injectResult.tpPlaced})`);
    } else {
      // Engine not running — persist body to disk state
      const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
      const saved = loadRegimeState(exchange, resolvedPair);
      if (saved.position) {
        saved.position.celestialBodies = saved.position.celestialBodies || [];
        saved.position.celestialBodies.push(body);
        syncPositionState(saved.position, saved.position.celestialBodies);
        saveRegimeState(saved.position, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, resolvedPair);
        log('INFO', `📦 [${exchange}] Manual buy import: saved body ${body.id} to disk (engine not running, TP will be placed on start)`);
      }
    }

    store.markTpPlaced(trade.id, body.id);
  }

  return { success: true, exchange, pair: resolvedPair, trade: store.getById(trade.id) };
});

// ============ Manual Trade: Paired Import ============

ipcServer.onRequest('regime:manual-trade-pair', async (payload, exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const { buyOrderId, sellOrderId, note } = payload || {};

  if (!buyOrderId || !sellOrderId) {
    return { success: false, error: 'Both buyOrderId and sellOrderId are required' };
  }

  const { getAdapter } = require('../src/adapters');
  const adapter = getAdapter(exchange);
  const store = getManualTradeStore(exchange, resolvedPair);
  // getActiveLedger → getStandaloneLedger → createFillLedger throws on
  // cold-start corruption. Convert to the structured {success:false}
  // shape this handler already returns for other failure modes.
  let fillLedger;
  try {
    fillLedger = getActiveLedger(exchange, resolvedPair);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Fetch and ingest buy fills
  let buyFills;
  try {
    buyFills = await adapter.getOrderFills(buyOrderId);
  } catch (err) {
    return { success: false, error: `Failed to fetch buy order fills: ${err.message}` };
  }
  if (!buyFills || buyFills.length === 0) {
    return { success: false, error: `No fills found for buy order ${buyOrderId}` };
  }

  const { tradeIds: buyFillTradeIds, totalSize: totalBuySize, totalQuote: totalBuyQuote } =
    ingestAdapterFills(fillLedger, buyFills, buyOrderId, 'buy');

  // Fetch and ingest sell fills
  let sellFills;
  try {
    sellFills = await adapter.getOrderFills(sellOrderId);
  } catch (err) {
    return { success: false, error: `Failed to fetch sell order fills: ${err.message}` };
  }
  if (!sellFills || sellFills.length === 0) {
    return { success: false, error: `No fills found for sell order ${sellOrderId}` };
  }

  const { tradeIds: sellFillTradeIds, totalSize: totalSellSize, totalQuote: totalSellQuote } =
    ingestAdapterFills(fillLedger, sellFills, sellOrderId, 'sell');

  // Link buy fills to sell order for P&L calculation
  fillLedger.annotateFillsByOrderId(buyOrderId, { sellOrderId });
  fillLedger.persist();

  const avgBuyPrice = totalBuySize > 0 ? totalBuyQuote / totalBuySize : 0;
  const avgSellPrice = totalSellSize > 0 ? totalSellQuote / totalSellSize : 0;

  const trade = store.addPairedTrade(
    {
      buyOrderId,
      buyPrice: avgBuyPrice,
      buySize: totalBuySize,
      buyQuoteAmount: totalBuyQuote,
      buyTimestamp: new Date(buyFills[0].tradeTime).getTime(),
      buyFillTradeIds,
    },
    {
      sellOrderId,
      sellPrice: avgSellPrice,
      sellSize: totalSellSize,
      sellQuoteAmount: totalSellQuote,
      sellTimestamp: new Date(sellFills[0].tradeTime).getTime(),
      sellFillTradeIds,
    },
    note,
  );

  // Dismiss both orders from unaccounted view
  store.dismissFills([buyOrderId, sellOrderId]);

  log('INFO', `📝 [${exchange}] Manual paired import: buy ${totalBuySize} BTC @ $${avgBuyPrice.toFixed(2)} + sell ${totalSellSize} BTC @ $${avgSellPrice.toFixed(2)}`);

  return { success: true, exchange, pair: resolvedPair, trade: store.getById(trade.id) };
});

// ============ DCA Conversion ============

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

  // executeConversion re-enables the DCA engine on its own throw path
  // (handled inside dca-converter.js). mergeToRegime doesn't disable the
  // engine so it has nothing to roll back — both paths surface a
  // cold-start ledger corruption throw that we convert into the
  // structured {success:false} response the rest of the IPC API uses.
  let result;
  try {
    result = merge ? mergeToRegime(exchange) : executeConversion(exchange);
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
          log('ERROR', `❌ [${label}] Failed to auto-resume: Fill ledger init failed: ${err.message}`);
          saveRegimeRunningFlag(exchange, fundPair, false);
          continue;
        }
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
