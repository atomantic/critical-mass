// @ts-check
/**
 * Legacy API Routes (backward compatibility for /api/* without exchange prefix)
 */

const stateTracker = require('../state-tracker');
const { getExchangeConfig, updateExchangeConfig, setExchangeEnabled, setExchangeDryRun } = require('../config-utils');
const { syncOrderStatuses, runIntervalCycle } = require('../dca-engine');
const { createContextLogger, getLogFile } = require('../logger');
const { validateConfigUpdate, sanitizeRegimeConfig, EXCHANGE_CONFIG_SCHEMA } = require('../config-validator');

/**
 * Context logger for the unprefixed legacy routes. Every one of them is pinned
 * to coinbase by definition, so the exchange is fixed and `route` distinguishes
 * the endpoint.
 * @param {string} route - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const legacyLogger = (route) => createContextLogger({
  module: 'legacy-routes',
  exchange: 'coinbase',
  route,
});

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
    // Validate against the allowlist schema so the unprefixed legacy path has the
    // same mass-assignment protection as PUT /api/:exchange/config — unknown keys are
    // dropped, out-of-range values are rejected with 400 (issue #146). Without this,
    // req.body was deep-merged into config.json verbatim, letting a client inject
    // arbitrary keys or out-of-range values (e.g. {amount:-1, evilKey:1}).
    const { value: updates, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    // regime is a nested object — sanitize keys against the allowlist before merging.
    // Unknown keys are DROPPED (not rejected), mirroring PUT /api/:exchange/config:
    // the config editor GETs the full stored config and PUTs it back verbatim, so a
    // hard 400 on a stale key (e.g. a field removed from the engine in a later
    // version but still present in a fund's persisted config) would make that fund
    // permanently unsaveable. Dropping keeps the security intent — unknown keys never
    // enter the saved overrides or reach the engine — while letting the save succeed.
    if (req.body?.regime && typeof req.body.regime === 'object' && !Array.isArray(req.body.regime)) {
      const { value: sanitizedRegime, droppedKeys } = sanitizeRegimeConfig(req.body.regime);
      if (droppedKeys.length > 0) {
        legacyLogger('/api/config').warn(`⚠️ 🧹 [coinbase] Dropped ${droppedKeys.length} unknown regime key(s) on legacy config save: ${droppedKeys.join(', ')}`, {
          action: 'update-config',
          droppedKeys,
        });
      }
      if (Object.keys(sanitizedRegime).length > 0) {
        updates.regime = sanitizedRegime;
      }
    }

    updateExchangeConfig('coinbase', updates);
    res.json({ success: true, config: getExchangeConfig('coinbase') });
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
    let assetBalance = { available: 0, hold: 0 };
    let keysConfigured = false;
    let apiError = null;

    const adapter = getAdapter('coinbase');

    if (adapter.hasValidKeys && adapter.hasValidKeys()) {
      keysConfigured = true;
      try {
        currentPrice = await adapter.getCurrentPrice(config.productId);
        usdcBalance = await adapter.getAccountBalance('USDC');
        assetBalance = await adapter.getAccountBalance(config.productId.split(/[-_]/)[0]);
      } catch (err) {
        apiError = err.message || 'API connection failed';
        legacyLogger('/api/status').error(`❌ [coinbase] Status check failed: ${apiError}`, {
          action: 'status',
          pair: config.productId,
          error: apiError,
        });
      }
    }

    res.json({ currentPrice, usdcBalance, assetBalance, keysConfigured, apiError, config, state, lastUpdated: new Date().toISOString() });
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
        assetReserves: state.assetReserves || 0, usdcFundSize: state.usdcFundSize || 0,
        outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0, outstandingOrdersAsset: state.outstandingOrdersAsset || 0,
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
    legacyLogger('/api/trade').info('ℹ️ Manual trade triggered via API', { action: 'manual-trade' });
    const result = await runIntervalCycle('coinbase');
    res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
  });

  app.get('/api/trade', (req, res) => {
    res.json({ status: 'no_trades_yet' });
  });
};
