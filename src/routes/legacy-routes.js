// @ts-check
/**
 * Legacy API Routes (backward compatibility for /api/* without exchange prefix)
 */

const stateTracker = require('../state-tracker');
const { getExchangeConfig, updateExchangeConfig, setExchangeEnabled, setExchangeDryRun } = require('../config-utils');
const { syncOrderStatuses, runIntervalCycle } = require('../dca-engine');
const { log, getLogFile } = require('../logger');

/**
 * @param {import('express').Express} app
 * @param {{parseTSV: Function, calculateCostBasis: Function, getNextTradeInfo: Function}} deps
 */
module.exports = (app, deps) => {
  const { parseTSV, calculateCostBasis, getNextTradeInfo } = deps;

  app.get('/api/config', (req, res) => {
    const config = getExchangeConfig('coinbase');
    res.json(config);
  });

  app.put('/api/config', (req, res) => {
    const config = req.body;
    updateExchangeConfig('coinbase', config);
    res.json({ success: true, config });
  });

  app.patch('/api/config', (req, res) => {
    const { enabled, dryRun } = req.body;
    if (typeof enabled === 'boolean') setExchangeEnabled('coinbase', enabled);
    if (typeof dryRun === 'boolean') setExchangeDryRun('coinbase', dryRun);
    const config = getExchangeConfig('coinbase');
    res.json({ success: true, config });
  });

  app.get('/api/state', (req, res) => {
    const config = getExchangeConfig('coinbase');
    const state = stateTracker.loadState(config, 'coinbase');
    res.json(state);
  });

  app.get('/api/transactions', (req, res) => {
    const logFile = getLogFile('coinbase');
    const transactions = parseTSV(logFile);
    res.json(transactions);
  });

  app.get('/api/status', async (req, res) => {
    const { getAdapter } = require('../adapters');
    const config = getExchangeConfig('coinbase');
    const state = stateTracker.loadState(config, 'coinbase');

    let currentPrice = 0;
    let usdcBalance = { available: 0, hold: 0 };
    let btcBalance = { available: 0, hold: 0 };
    let keysConfigured = false;
    let apiError = null;

    const adapter = getAdapter('coinbase');

    if (adapter.hasValidKeys && adapter.hasValidKeys()) {
      keysConfigured = true;
      try {
        currentPrice = await adapter.getCurrentPrice(config.productId);
        usdcBalance = await adapter.getAccountBalance('USDC');
        btcBalance = await adapter.getAccountBalance('BTC');
      } catch (err) {
        apiError = err.message || 'API connection failed';
        log('ERROR', `[coinbase] Status check failed: ${apiError}`);
      }
    }

    res.json({ currentPrice, usdcBalance, btcBalance, keysConfigured, apiError, config, state, lastUpdated: new Date().toISOString() });
  });

  app.get('/api/summary', (req, res) => {
    const config = getExchangeConfig('coinbase');
    const state = stateTracker.loadState(config, 'coinbase');
    const logFile = getLogFile('coinbase');
    const transactions = parseTSV(logFile);

    const buys = transactions.filter(t => t.Type === 'BUY');
    const sells = transactions.filter(t => t.Type === 'SELL_FILLED');

    const totalBought = buys.reduce((sum, t) => sum + Math.abs(t['USDC Amount'] || 0), 0);
    const totalSold = sells.reduce((sum, t) => sum + (t['USDC Amount'] || 0), 0);
    const totalBTCBought = buys.reduce((sum, t) => sum + (t['BTC Amount'] || 0), 0);
    const totalBTCSold = sells.reduce((sum, t) => sum + Math.abs(t['BTC Amount'] || 0), 0);

    const costBasis = calculateCostBasis(state, transactions);
    const nextTrade = getNextTradeInfo(config, state);

    res.json({
      config, state,
      stats: {
        totalBuys: buys.length, totalSells: sells.length,
        pendingOrders: (state.orders || []).filter(o => o.status === 'pending').length,
        totalBought, totalSold, totalBTCBought, totalBTCSold,
        totalFees: state.totalFees || 0, totalRebates: state.totalRebates || 0, netFees: state.netFees || 0,
        btcReserves: state.btcReserves || 0, usdcFundSize: state.usdcFundSize || 0,
        outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0, outstandingOrdersBTC: state.outstandingOrdersBTC || 0,
        allocationUsed: state.totalAllocated || 0, allocationRemaining: (config.totalAllocation || 0) - (state.totalAllocated || 0),
        intervalsRun: state.totalIntervalsRun || 0,
      },
      costBasis, nextTrade, transactions: transactions.slice(-50),
    });
  });

  app.post('/api/sync', async (req, res) => {
    const config = getExchangeConfig('coinbase');
    const state = stateTracker.loadState(config, 'coinbase');
    const filledOrders = await syncOrderStatuses(state, 'coinbase');
    if (filledOrders.length > 0) stateTracker.saveState(state, 'coinbase');
    res.json({ success: true, filledOrders: filledOrders.length, lastSyncTime: new Date().toISOString() });
  });

  app.get('/api/sync', (req, res) => {
    res.json({ lastSyncTime: new Date().toISOString() });
  });

  app.post('/api/trade', async (req, res) => {
    log('INFO', 'Manual trade triggered via API');
    const result = await runIntervalCycle('coinbase');
    res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
  });

  app.get('/api/trade', (req, res) => {
    res.json({ status: 'no_trades_yet' });
  });
};
