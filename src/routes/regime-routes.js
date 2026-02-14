// @ts-check
/**
 * Regime Engine API Routes
 */

const { getRegimeConfig, updateRegimeConfig, validateRegimeConfig, getExchangeConfig } = require('../config-utils');
const { getMarketDataService, startMarketDataService, stopMarketDataService } = require('../market-data-service');
const { getChartDataBuffer, getChartData } = require('../chart-data-buffer');
const { createRegimeEngine } = require('../regime-engine');
const { createFillLedger } = require('../fill-ledger');
const { log } = require('../logger');

// Cached standalone fill ledgers for when engine isn't running (avoids re-creating on every request)
const standaloneLedgers = new Map();

const getStandaloneLedger = (exchange) => {
  if (!standaloneLedgers.has(exchange)) {
    standaloneLedgers.set(exchange, createFillLedger(exchange));
  }
  return standaloneLedgers.get(exchange);
};

/** Invalidate cached standalone ledger (call when engine starts/stops or data changes) */
const invalidateStandaloneLedger = (exchange) => {
  standaloneLedgers.delete(exchange);
};

/**
 * @param {import('express').Express} app
 * @param {{regimeEngines: Map, io: Object, wireMarketDataCallbacks: Function, saveRegimeRunningFlag: Function}} deps
 */
module.exports = (app, deps) => {
  const { regimeEngines, io, wireMarketDataCallbacks, saveRegimeRunningFlag } = deps;

  // Get regime configuration for an exchange
  app.get('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const regimeConfig = getRegimeConfig(exchange);
    const exchangeConfig = getExchangeConfig(exchange);
    const config = { ...regimeConfig, dryRun: exchangeConfig.dryRun, productId: exchangeConfig.productId };
    res.json({ success: true, exchange, config });
  });

  // Update regime configuration for an exchange
  app.put('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const updates = req.body;

    const currentConfig = getRegimeConfig(exchange);
    const keysToValidate = Object.keys(updates);
    const crossFieldPairs = {
      tpMinPercent: 'tpMaxPercent', tpMaxPercent: 'tpMinPercent',
      macroDeclineThreshold: 'macroAccumulationThreshold', macroAccumulationThreshold: 'macroMarkupThreshold',
      macroMarkupThreshold: 'macroAccumulationThreshold',
    };
    const validationSubset = { ...updates };
    for (const key of keysToValidate) {
      const partner = crossFieldPairs[key];
      if (partner && validationSubset[partner] === undefined) {
        validationSubset[partner] = currentConfig[partner];
      }
    }
    const validation = validateRegimeConfig(validationSubset);
    if (!validation.valid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    const config = updateRegimeConfig(exchange, updates);
    log('INFO', `🔧 [${exchange}] Regime config updated`);

    const engine = regimeEngines.get(exchange);
    if (engine) {
      engine.updateConfig(updates);
    }

    res.json({ success: true, exchange, config });
  });

  // Get regime engine status
  app.get('/api/:exchange/regime/status', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      const { loadRegimeState } = require('../state-tracker');
      const celestialHierarchy = require('../celestial-hierarchy');
      const savedState = loadRegimeState(exchange);
      const position = savedState?.position || null;
      const config = getRegimeConfig(exchange);

      const marketService = getMarketDataService(exchange);
      const serviceStatus = marketService ? marketService.getStatus() : null;

      // Build celestial object from saved position (mirrors regime-engine getStatus)
      const bodies = position?.celestialBodies || [];
      const celestial = {
        enabled: config.celestialEnabled !== false,
        bodies: bodies.map(b => {
          const tierCfg = celestialHierarchy.getTierConfig(b.tier);
          return {
            id: b.id,
            tier: b.tier,
            emoji: tierCfg.emoji,
            assetQty: b.assetQty,
            costBasis: b.costBasis,
            avgPrice: b.avgPrice,
            tpOrderId: b.tpOrderId,
            tpPrice: b.tpPrice,
            tpPercent: b.avgPrice > 0 && b.tpPrice > 0 ? ((b.tpPrice - b.avgPrice) / b.avgPrice * 100).toFixed(2) : null,
            assetOnOrder: b.assetOnOrder,
            createdAt: b.createdAt,
            lastMergedAt: b.lastMergedAt,
            mergeCount: b.mergeCount,
            buyOrders: (b.buyOrders || []).map(bo => ({
              orderId: bo.orderId,
              price: bo.price,
              assetQty: bo.assetQty,
              sizeUsdc: bo.sizeUsdc,
              filledAt: bo.filledAt,
            })),
          };
        }),
        bodiesActive: bodies.length,
        bodiesCompleted: position?.celestialState?.bodiesCompleted || 0,
        bodiesRealizedPnL: position?.celestialState?.bodiesRealizedPnL || 0,
        bodiesRealizedAssetPnL: position?.celestialState?.bodiesRealizedAssetPnL || 0,
        tierSummary: celestialHierarchy.getTierSummary(bodies),
      };

      return res.json({
        success: true,
        exchange,
        running: false,
        status: {
          isRunning: false,
          market: serviceStatus?.market || null,
          regime: serviceStatus?.regime || null,
          position,
          celestial,
          health: { mode: 'STOPPED' },
          isDryRun: savedState?.isDryRun || false,
        },
      });
    }

    const status = engine.getStatus();
    res.json({ success: true, exchange, running: true, status });
  });

  // Get cached chart data for regime dashboard
  app.get('/api/:exchange/regime/chart-data', (req, res) => {
    const { exchange } = req.params;
    const chartData = getChartData(exchange);

    if (!chartData) {
      return res.json({
        success: true,
        exchange,
        data: { priceHistory: [], atrHistory: [], regimeHistory: [], exchange, timestamp: Date.now() },
      });
    }

    res.json({ success: true, exchange, data: chartData });
  });

  // Helper: create engine callbacks for an exchange
  const createEngineCallbacks = (exchange) => ({
    onTradeEvent: (event) => io.emit('trade:event', event),
    onRegimeChange: (prevMode, newMode, reason) => io.emit('regime:change', { exchange, prevMode, newMode, reason, message: `${prevMode} -> ${newMode}` }),
    onHealthChange: (mode, reason) => io.emit('regime:health', { exchange, mode, reason, message: reason || `Health: ${mode}` }),
    onPositionUpdate: (data) => io.emit('regime:position', { exchange, ...data }),
    onStatusUpdate: (status) => {
      getChartDataBuffer(exchange).processStatus(status);
      io.emit('regime:status', { exchange, status });
    },
  });

  // Start regime engine for an exchange
  app.post('/api/:exchange/regime/start', async (req, res) => {
    const { exchange } = req.params;
    const { getAdapter } = require('../adapters');

    if (regimeEngines.has(exchange)) {
      return res.status(400).json({ success: false, error: 'Regime engine already running for this exchange' });
    }

    const exchangeConfig = getExchangeConfig(exchange);
    const adapter = getAdapter(exchange);

    if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
      return res.status(400).json({ success: false, error: 'API keys not configured for this exchange' });
    }

    const engine = createRegimeEngine(exchange, exchangeConfig, createEngineCallbacks(exchange));
    regimeEngines.set(exchange, engine);

    const startResult = await engine.start();

    if (!startResult.success) {
      regimeEngines.delete(exchange);
      return res.status(500).json({ success: false, error: startResult.error || 'Failed to start regime engine' });
    }

    stopMarketDataService(exchange);
    invalidateStandaloneLedger(exchange);
    saveRegimeRunningFlag(exchange, true);

    log('INFO', `🚀 [${exchange}] Regime engine started`);
    res.json({ success: true, exchange, status: engine.getStatus() });
  });

  // Stop regime engine for an exchange
  app.post('/api/:exchange/regime/stop', async (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }

    log('INFO', `🛑 [${exchange}] Stopping regime engine...`);

    await startMarketDataService(exchange);
    wireMarketDataCallbacks(exchange);

    const stopResult = await engine.stop().catch(err => {
      log('ERROR', `❌ [${exchange}] Error stopping engine: ${err.message}`);
      return { error: err.message };
    });

    if (stopResult?.error) {
      return res.status(500).json({ success: false, error: stopResult.error });
    }

    regimeEngines.delete(exchange);
    invalidateStandaloneLedger(exchange);
    saveRegimeRunningFlag(exchange, false);

    log('INFO', `✅ [${exchange}] Regime engine stopped successfully`);
    res.json({ success: true, exchange, stopped: true });
  });

  // Pause regime engine
  app.post('/api/:exchange/regime/pause', (req, res) => {
    const { exchange } = req.params;
    const { reason } = req.body;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }

    engine.pause(reason || 'Manual pause via API');
    log('INFO', `⏸️ [${exchange}] Regime engine paused: ${reason || 'manual'}`);
    res.json({ success: true, exchange, paused: true, status: engine.getStatus() });
  });

  // Resume regime engine
  app.post('/api/:exchange/regime/resume', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }

    engine.resume();
    log('INFO', `▶️ [${exchange}] Regime engine resumed`);
    res.json({ success: true, exchange, resumed: true, status: engine.getStatus() });
  });

  // Force regime transition
  app.post('/api/:exchange/regime/force-regime', (req, res) => {
    const { exchange } = req.params;
    const { regime, reason } = req.body;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }

    const validRegimes = ['HARVEST', 'CAUTION', 'TREND'];
    if (!regime || !validRegimes.includes(regime.toUpperCase())) {
      return res.status(400).json({ success: false, error: `Invalid regime. Must be one of: ${validRegimes.join(', ')}` });
    }

    engine.forceRegime(regime.toUpperCase(), reason || 'Forced via API');
    log('INFO', `🔄 [${exchange}] Regime forced to ${regime.toUpperCase()}: ${reason || 'manual'}`);
    res.json({ success: true, exchange, regime: regime.toUpperCase(), status: engine.getStatus() });
  });

  // Force resume from drawdown pause
  app.post('/api/:exchange/regime/resume-drawdown', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }

    const result = engine.forceResumeDrawdown();
    if (result.success) {
      log('INFO', `▶️ [${exchange}] Drawdown pause manually resumed: ${result.message}`);
    }

    res.json({ success: result.success, exchange, message: result.message, status: engine.getStatus() });
  });

  // Manual body roll-up merge
  app.post('/api/:exchange/regime/rollup-body', async (req, res) => {
    const { exchange } = req.params;
    const { bodyId } = req.body || {};
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      return res.status(400).json({ success: false, error: 'Regime engine not running for this exchange' });
    }
    if (!bodyId) {
      return res.status(400).json({ success: false, error: 'bodyId is required' });
    }

    const result = await engine.manualMergeBody(bodyId);
    if (result.success) {
      log('INFO', `🔗 [${exchange}] Body roll-up: ${result.message}`);
    }

    res.json({ success: result.success, exchange, message: result.message, mergedBody: result.mergedBody || null, status: engine.getStatus() });
  });

  // Get regime engine fill ledger
  app.get('/api/:exchange/regime/fills', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) {
      const ledger = getStandaloneLedger(exchange);
      const fills = ledger.getAllFills();
      const stats = ledger.getStats();
      return res.json({ success: true, exchange, running: false, fills, stats });
    }

    const fills = engine.getFills();
    const stats = engine.getFillStats();
    res.json({ success: true, exchange, running: true, fills, stats });
  });

  // Get open orders for regime engine
  app.get('/api/:exchange/regime/open-orders', async (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (engine) {
      const openOrders = engine.getOpenOrders ? engine.getOpenOrders() : [];
      return res.json({ success: true, exchange, running: true, orders: openOrders });
    }

    const marketService = getMarketDataService(exchange);
    const { loadRegimeState } = require('../state-tracker');
    const savedState = loadRegimeState(exchange);

    const orders = [];

    if (marketService?.getOpenOrders) {
      orders.push(...marketService.getOpenOrders());
    }

    if (orders.length === 0 && savedState.position?.activeTpOrderId) {
      const { getAdapter } = require('../adapters');
      const adapter = getAdapter(exchange);

      const orderStatus = await adapter.getOrder(savedState.position.activeTpOrderId).catch(() => null);
      if (orderStatus && orderStatus.status === 'OPEN') {
        orders.push({
          orderId: savedState.position.activeTpOrderId,
          type: 'take_profit',
          side: 'sell',
          price: savedState.position.lastTpPrice || 0,
          size: savedState.position.assetOnOrder || savedState.position.totalAsset || 0,
          status: 'open',
          placedAt: savedState.position.lastEntryTime || null,
        });
      }
    }

    res.json({ success: true, exchange, running: false, orders });
  });

  // Recalculate regime state from fill history
  app.post('/api/:exchange/regime/recalculate', async (req, res) => {
    const { exchange } = req.params;
    const { apply = false } = req.body;

    const { loadRegimeState, saveRegimeState } = require('../state-tracker');

    // Recalculate mutates cycle data, so invalidate cache and get a fresh ledger
    invalidateStandaloneLedger(exchange);
    const fillLedger = getStandaloneLedger(exchange);
    const currentState = loadRegimeState(exchange);

    const recalcResult = fillLedger.recalculateCycles();
    const currentCycleFills = fillLedger.getCurrentCycleFills();
    const currentPosition = fillLedger.rebuildPositionFromFills(currentCycleFills);

    // Use global P&L computed from all fills (matches dashboard Filled Orders computation)
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
      // Compute body-only P&L to keep celestialState counter in sync
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

      saveRegimeState(exchange, { ...currentState, position: updatedPosition });
      fillLedger.persist();

      const engine = regimeEngines.get(exchange);
      if (engine?.updatePosition) {
        engine.updatePosition(updatedPosition);
      }

      console.log(`🔧 [${exchange}] Regime state recalculated: ${recalcResult.cyclesCompleted} cycles, globalPnL=$${totalRealizedPnL.toFixed(2)}, BTC reserves=${totalRealizedAssetPnL.toFixed(8)}`);
    }

    res.json({
      success: true,
      exchange,
      applied: apply,
      changes,
      cycleDetails: recalcResult.cycleDetails,
      orphansFixed: recalcResult.orphansFixed,
      activeCycleId: recalcResult.activeCycleId,
      currentCycleFills: currentCycleFills.length,
    });
  });

  // Convert DCA orders to regime engine state
  app.post('/api/:exchange/regime/convert-dca', (req, res) => {
    const { exchange } = req.params;
    const { preview = true, merge = false } = req.body;

    // Refuse if regime engine is already running
    if (regimeEngines.has(exchange)) {
      return res.status(400).json({ success: false, error: 'Regime engine is running — stop it before converting DCA orders' });
    }

    const { previewConversion, executeConversion, mergeToRegime } = require('../dca-converter');

    if (preview) {
      const summary = previewConversion(exchange);
      return res.json({ success: true, preview: true, exchange, ...summary });
    }

    const result = merge ? mergeToRegime(exchange) : executeConversion(exchange);
    invalidateStandaloneLedger(exchange);
    res.json({ success: true, preview: false, exchange, ...result });
  });

  // Dry-run endpoints
  app.get('/api/:exchange/regime/dry-run/log', (req, res) => {
    const { exchange } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const engine = regimeEngines.get(exchange);

    if (!engine) return res.status(400).json({ success: false, error: 'Regime engine not running' });
    if (!engine.isDryRun) return res.status(400).json({ success: false, error: 'Regime engine is not in dry-run mode' });

    const dryLog = engine.getDryRunLog(limit);
    res.json({ success: true, exchange, isDryRun: true, log: dryLog });
  });

  app.get('/api/:exchange/regime/dry-run/pnl', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) return res.status(400).json({ success: false, error: 'Regime engine not running' });
    if (!engine.isDryRun) return res.status(400).json({ success: false, error: 'Regime engine is not in dry-run mode' });

    const pnl = engine.getDryRunPnL();
    const state = engine.getState();
    res.json({ success: true, exchange, isDryRun: true, pnl, position: state.position, cyclesCompleted: state.position.cyclesCompleted, realizedPnL: state.position.realizedPnL, unrealizedPnL: state.position.unrealizedPnL });
  });

  app.post('/api/:exchange/regime/dry-run/reset', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) return res.status(400).json({ success: false, error: 'Regime engine not running' });
    if (!engine.isDryRun) return res.status(400).json({ success: false, error: 'Regime engine is not in dry-run mode' });

    const reset = engine.resetDryRun();
    res.json({ success: reset, exchange, message: reset ? 'Dry-run state reset successfully' : 'Failed to reset dry-run state', status: engine.getStatus() });
  });

  app.get('/api/:exchange/regime/dry-run/state', (req, res) => {
    const { exchange } = req.params;
    const engine = regimeEngines.get(exchange);

    if (!engine) return res.status(400).json({ success: false, error: 'Regime engine not running' });

    const state = engine.getState();
    if (!state.isDryRun) return res.status(400).json({ success: false, error: 'Regime engine is not in dry-run mode' });

    res.json({ success: true, exchange, isDryRun: true, dryRunState: state.dryRun, position: state.position, regime: state.regime, market: state.market });
  });

  // Expose createEngineCallbacks for auto-resume
  return { createEngineCallbacks };
};
