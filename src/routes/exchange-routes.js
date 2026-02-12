// @ts-check
/**
 * Exchange Management & Per-Exchange API Routes
 */

const stateTracker = require('../state-tracker');
const { getExchangeConfig, getConfiguredExchanges, getEnabledExchanges, updateExchangeConfig, setExchangeEnabled, setExchangeDryRun } = require('../config-utils');
const { normalizeConfig, getNextExecutionTime, hasRunThisInterval, formatInterval, getTimeUntilNext } = require('../interval-utils');
const { log, loadTransactionHistory, getLogFile } = require('../logger');
const { syncOrderStatuses, runIntervalCycle, loadConfig, executeConsolidation } = require('../dca-engine');

/**
 * @param {import('express').Express} app
 * @param {{regimeEngines: Map, parseTSV: Function, calculateCostBasis: Function, getNextTradeInfo: Function}} deps
 */
module.exports = (app, deps) => {
  const { regimeEngines, parseTSV, calculateCostBasis, getNextTradeInfo } = deps;

  // Get list of all exchanges
  app.get('/api/exchanges', (req, res) => {
    const configured = getConfiguredExchanges();
    const enabled = getEnabledExchanges();

    const exchanges = configured.map(name => {
      const config = getExchangeConfig(name);
      const regimeEngine = regimeEngines.get(name);
      const strategy = config.dcaStrategy || 'fixed';
      const regimeConfig = config.regime || {};
      const hasRegimeConfig = !!(config.regime && Object.keys(config.regime).length > 0);
      return {
        name,
        enabled: config.enabled,
        dryRun: config.dryRun,
        productId: config.productId,
        strategy,
        regimeEnabled: regimeConfig.enabled || false,
        regimeRunning: regimeEngine?.getState?.()?.isRunning || false,
        hasRegimeConfig,
      };
    });

    res.json({ exchanges, enabled });
  });

  // Get config for an exchange
  app.get('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const config = getExchangeConfig(exchange);
    res.json(config);
  });

  // Update config for an exchange
  app.put('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const updates = req.body;
    const config = updateExchangeConfig(exchange, updates);

    if (updates.regime) {
      const engine = regimeEngines.get(exchange);
      if (engine) {
        engine.updateConfig(updates.regime);
      }
    }

    res.json({ success: true, config: config.exchanges[exchange] });
  });

  // Toggle enabled/dryRun for an exchange
  app.patch('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const { enabled, dryRun } = req.body;

    if (typeof enabled === 'boolean') {
      setExchangeEnabled(exchange, enabled);
      log('INFO', `[${exchange}] Trading automation ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    if (typeof dryRun === 'boolean') {
      setExchangeDryRun(exchange, dryRun);
      log('INFO', `[${exchange}] Dry-run mode ${dryRun ? 'ENABLED' : 'DISABLED'}`);
    }

    const config = getExchangeConfig(exchange);
    res.json({ success: true, config });
  });

  // Get state for an exchange
  app.get('/api/:exchange/state', (req, res) => {
    const { exchange } = req.params;
    const config = getExchangeConfig(exchange);
    const state = stateTracker.loadState(config, exchange);
    res.json(state);
  });

  // Get transactions for an exchange
  app.get('/api/:exchange/transactions', (req, res) => {
    const { exchange } = req.params;
    const logFile = getLogFile(exchange);
    const transactions = parseTSV(logFile);
    res.json(transactions);
  });

  // Get live status for an exchange
  app.get('/api/:exchange/status', async (req, res) => {
    const { exchange } = req.params;
    const { getAdapter } = require('../adapters');

    const config = getExchangeConfig(exchange);
    const state = stateTracker.loadState(config, exchange);

    let currentPrice = 0;
    let quoteBalance = { available: 0, hold: 0 };
    let btcBalance = { available: 0, hold: 0 };
    let keysConfigured = false;
    let apiError = null;
    const quoteCurrency = exchange === 'gemini' ? 'USD' : 'USDC';

    const adapter = getAdapter(exchange);

    if (adapter.hasValidKeys && adapter.hasValidKeys()) {
      keysConfigured = true;
      try {
        currentPrice = await adapter.getCurrentPrice(config.productId);
        quoteBalance = await adapter.getAccountBalance(quoteCurrency);
        btcBalance = await adapter.getAccountBalance('BTC');
      } catch (err) {
        apiError = err.message || 'API connection failed';
        log('ERROR', `[${exchange}] Status check failed: ${apiError}`);
      }
    }

    res.json({
      exchange,
      currentPrice,
      quoteBalance,
      btcBalance,
      quoteCurrency,
      keysConfigured,
      apiError,
      config,
      state,
      lastUpdated: new Date().toISOString(),
    });
  });

  // Get summary for an exchange
  app.get('/api/:exchange/summary', (req, res) => {
    const { exchange } = req.params;
    const config = getExchangeConfig(exchange);
    const state = stateTracker.loadState(config, exchange);
    const logFile = getLogFile(exchange);
    const transactions = parseTSV(logFile);

    const buys = transactions.filter(t => t.Type === 'BUY');
    const sells = transactions.filter(t => t.Type === 'SELL_FILLED');

    const totalBought = buys.reduce((sum, t) => sum + Math.abs(t['USDC Amount'] || 0), 0);
    const totalSold = sells.reduce((sum, t) => sum + (t['USDC Amount'] || 0), 0);
    const totalBTCBought = buys.reduce((sum, t) => sum + (t['BTC Amount'] || 0), 0);
    const totalBTCSold = sells.reduce((sum, t) => sum + Math.abs(t['BTC Amount'] || 0), 0);

    const filledOrders = (state.orders || []).filter(o => o.status === 'filled');
    const realizedProfit = filledOrders.reduce((sum, o) => {
      const proceeds = o.netProceeds || (o.sellQuantityBTC * (o.filledPrice || o.sellPrice));
      const cost = o.buyCostBasis || (o.buyQuantityBTC * o.buyPrice);
      const costForSold = o.buyQuantityBTC > 0 ? cost * (o.sellQuantityBTC / o.buyQuantityBTC) : 0;
      return sum + (proceeds - costForSold);
    }, 0);

    const costBasis = calculateCostBasis(state, transactions);
    const nextTrade = getNextTradeInfo(config, state);

    res.json({
      exchange,
      config,
      state,
      stats: {
        totalBuys: buys.length,
        totalSells: sells.length,
        pendingOrders: (state.orders || []).filter(o => o.status === 'pending').length,
        totalBought,
        totalSold,
        totalBTCBought,
        totalBTCSold,
        totalFees: state.totalFees || 0,
        totalRebates: state.totalRebates || 0,
        netFees: state.netFees || 0,
        btcReserves: state.btcReserves || 0,
        usdcFundSize: state.usdcFundSize || 0,
        outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0,
        outstandingOrdersBTC: state.outstandingOrdersBTC || 0,
        allocationUsed: state.totalAllocated || 0,
        allocationRemaining: (config.totalAllocation || 0) - (state.totalAllocated || 0),
        intervalsRun: state.totalIntervalsRun || 0,
        realizedProfit,
      },
      costBasis,
      nextTrade,
      transactions: transactions.slice(-50),
    });
  });

  // Get candles for an exchange (for charts)
  app.get('/api/:exchange/candles', async (req, res) => {
    const { exchange } = req.params;
    const { granularity = 'ONE_MINUTE', limit = 60 } = req.query;
    const config = getExchangeConfig(exchange);
    const { getAdapter } = require('../adapters');
    const adapter = getAdapter(exchange);

    const productId = config.productId || 'BTC-USDC';
    const now = Math.floor(Date.now() / 1000);

    const granularitySeconds = {
      'ONE_MINUTE': 60, 'FIVE_MINUTE': 300, 'FIFTEEN_MINUTE': 900,
      'ONE_HOUR': 3600, 'SIX_HOUR': 21600, 'ONE_DAY': 86400,
    };
    const seconds = granularitySeconds[granularity] || 60;
    const start = now - (parseInt(limit, 10) * seconds);

    const result = await adapter.getCandles(productId, start, now, granularity);
    if (!result || result.error) {
      return res.status(500).json({ success: false, error: result?.error || 'Failed to fetch candles' });
    }

    res.json({ success: true, candles: result });
  });

  // Sync pending orders for an exchange
  app.post('/api/:exchange/sync', async (req, res) => {
    const { exchange } = req.params;
    const config = getExchangeConfig(exchange);
    const state = stateTracker.loadState(config, exchange);

    const filledOrders = await syncOrderStatuses(state, exchange);
    if (filledOrders.length > 0) {
      stateTracker.saveState(state, exchange);
    }

    res.json({
      success: true,
      exchange,
      filledOrders: filledOrders.length,
      lastSyncTime: new Date().toISOString(),
    });
  });

  // Trigger trade for an exchange
  app.post('/api/:exchange/trade', async (req, res) => {
    const { exchange } = req.params;
    log('INFO', `[${exchange}] Manual trade triggered via API`);

    const result = await runIntervalCycle(exchange);
    res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
  });

  // Consolidate pending orders for an exchange
  app.post('/api/:exchange/consolidate', async (req, res) => {
    const { exchange } = req.params;
    const { orderIds } = req.body || {};

    log('INFO', `[${exchange}] Consolidation triggered via API`);

    const config = getExchangeConfig(exchange);
    const state = stateTracker.loadState(config, exchange);
    const pendingOrders = (state.orders || []).filter(o => o.status === 'pending');

    const ordersToConsolidate = orderIds && orderIds.length > 0
      ? pendingOrders.filter(o => orderIds.includes(o.orderId))
      : pendingOrders;

    if (ordersToConsolidate.length < 2) {
      return res.status(400).json({
        success: false,
        error: `Need at least 2 pending orders to consolidate, found ${ordersToConsolidate.length}`,
      });
    }

    const result = await executeConsolidation(exchange, orderIds);
    res.json({
      ...result,
      triggeredAt: new Date().toISOString(),
      trigger: 'manual',
    });
  });
};
