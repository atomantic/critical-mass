// @ts-check
/**
 * Legacy API Routes (backward compatibility for /api/* without exchange prefix)
 */

const stateTracker = require('../state-tracker');
const { getExchangeConfig, getDefaultPair, getFundsForExchange, setExchangeEnabled, setExchangeDryRun, getGlobalConfig } = require('../config-utils');
const { syncFundOrders, runIntervalCycle } = require('../dca-engine');
const { createContextLogger, getLogFile } = require('../logger');
const { validateConfigUpdate, EXCHANGE_CONFIG_SCHEMA } = require('../config-validator');
const { prepareConfigUpdate, persistConfigUpdate } = require('./config-update');
const { asyncRoute, getSafeIPC, tradeResultStatusCode } = require('./route-utils');
const { readBooleanFlag } = require('../shared-utils');

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
 * @param {{exchangeIPCMap: Object, parseTSV: Function, calculateCostBasis: Function, getNextTradeInfo: Function}} deps
 */
module.exports = (app, deps) => {
  const { exchangeIPCMap, parseTSV, calculateCostBasis, getNextTradeInfo } = deps;

  // Every route here is pinned to coinbase's default fund by definition. State
  // and cycle calls name that fund explicitly rather than relying on each
  // callee's argument-omission fallback, so the intent is stated once and a
  // second coinbase fund can never be reached from an unprefixed legacy route.
  const legacyPair = () => getDefaultPair('coinbase') ?? undefined;

  // The fund a config write targets. getDefaultPair returns null for an older
  // flat block with no productId, yet that block still runs a fund (the
  // normalized view and updateExchangeConfig key it by the default product), so
  // fall back to the first normalized fund. Undefined only when no fund exists.
  const legacyWritePair = () => legacyPair() ?? getFundsForExchange('coinbase')[0];

  app.get('/api/config', (req, res) => {
    const config = getExchangeConfig('coinbase');
    res.json(config);
  });

  // Same save boundary as PUT /api/:exchange/config (prepareConfigUpdate +
  // persistConfigUpdate), pinned to coinbase's default fund: the schema allowlist
  // (#146), nested regime sanitize/value validation (#452), the product-identity
  // check, and the regime:update-config IPC so the running engine applies the save.
  app.put('/api/config', asyncRoute(async (req, res) => {
    const pair = legacyWritePair();
    // With no coinbase fund there is nothing to save into; persisting under an
    // undefined pair would create a fund literally named "undefined".
    if (!pair) {
      return res.status(409).json({ success: false, error: 'No coinbase fund exists; add one with POST /api/coinbase/funds before saving its config' });
    }
    const logger = legacyLogger('/api/config');
    const { value: updates, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ success: false, error: errors.join('; ') });

    const prepared = prepareConfigUpdate({
      exchange: 'coinbase', pair, updates, fullConfig: true, rawRegime: req.body?.regime,
      onProductMismatch: ({ productId, incomingBase, pairBase }) => {
        logger.warn(`⚠️ 🛑 [coinbase/${pair}] Rejected legacy config save: productId "${productId}" trades ${incomingBase}, not ${pairBase}`, {
          action: 'update-config', productId, incomingBase, pairBase,
        });
      },
      onDroppedKeys: (droppedKeys) => {
        logger.warn(`⚠️ 🧹 [coinbase] Dropped ${droppedKeys.length} unknown regime key(s) on legacy config save: ${droppedKeys.join(', ')}`, {
          action: 'update-config',
          droppedKeys,
        });
      },
    });
    if (!prepared.valid) return res.status(400).json({ success: false, error: prepared.errors.join('; ') });

    const result = await persistConfigUpdate('coinbase', pair, prepared, getSafeIPC(exchangeIPCMap, 'coinbase'));
    if (!result.applied) {
      logger.error(`❌ 🚨 [coinbase/${pair}] Config persisted but live engine update failed: ${result.error}`, {
        action: 'update-config', channel: 'regime:update-config',
        persisted: true, applied: false, error: result.error,
      });
      return res.status(503).json({
        success: false, persisted: true, applied: false,
        error: `Config was saved but the live engine did not apply it: ${result.error}`,
        config: getExchangeConfig('coinbase'),
      });
    }

    res.json({ success: true, persisted: true, applied: true, config: getExchangeConfig('coinbase') });
  }));

  // Mirrors PATCH /api/:exchange/config: a dryRun toggle is also pushed to the
  // running engine, otherwise it keeps its old mode until a restart.
  app.patch('/api/config', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const enabledFlag = readBooleanFlag(body, 'enabled', undefined);
    if (enabledFlag.error) return res.status(400).json({ success: false, error: enabledFlag.error });
    const dryRunFlag = readBooleanFlag(body, 'dryRun', undefined);
    if (dryRunFlag.error) return res.status(400).json({ success: false, error: dryRunFlag.error });
    let applied = false;
    if (typeof enabledFlag.value === 'boolean') { setExchangeEnabled('coinbase', enabledFlag.value); applied = true; }
    if (typeof dryRunFlag.value === 'boolean') {
      const { value: dryRun } = dryRunFlag;
      const pair = legacyWritePair();
      setExchangeDryRun('coinbase', dryRun);
      applied = true;
      // No coinbase fund means no fund engine is running to notify.
      if (pair) {
        try {
          const engineResult = await getSafeIPC(exchangeIPCMap, 'coinbase').request('regime:update-config', { dryRun }, 'coinbase', pair);
          if (engineResult?.success === false) throw new Error(engineResult.error || engineResult.message || 'Engine rejected config update');
        } catch (err) {
          legacyLogger('/api/config').error(`❌ 🚨 [coinbase/${pair}] Dry-run setting persisted but live engine update failed: ${err.message}`, {
            action: 'toggle-dry-run',
            channel: 'regime:update-config',
            persisted: true,
            applied: false,
            error: err.message,
          });
          return res.status(503).json({
            success: false,
            persisted: true,
            applied: false,
            error: `Dry-run setting was saved but the live engine did not apply it: ${err.message}`,
            config: getExchangeConfig('coinbase'),
          });
        }
      }
    }
    const config = getExchangeConfig('coinbase');
    res.json({ success: true, persisted: true, applied, config });
  }));

  app.get('/api/state', (req, res) => {
    const config = getExchangeConfig('coinbase');
    const state = stateTracker.loadState(config, 'coinbase', legacyPair());
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
    const state = stateTracker.loadState(config, 'coinbase', legacyPair());

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
    const state = stateTracker.loadState(config, 'coinbase', legacyPair());
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

  app.post('/api/sync', asyncRoute(async (req, res) => {
    if (!getGlobalConfig().simpleDcaEnabled) {
      return res.status(400).json({ success: false, error: 'Simple DCA is disabled. Use Regime engine.' });
    }
    const pair = legacyPair();
    const { filledOrders } = await syncFundOrders('coinbase', pair);
    res.json({ success: true, filledOrders: filledOrders.length, lastSyncTime: new Date().toISOString() });
  }));

  app.get('/api/sync', (req, res) => {
    res.json({ lastSyncTime: new Date().toISOString() });
  });

  app.post('/api/trade', asyncRoute(async (req, res) => {
    if (!getGlobalConfig().simpleDcaEnabled) {
      return res.status(400).json({ success: false, error: 'Simple DCA is disabled. Use Regime engine.' });
    }
    legacyLogger('/api/trade').info('ℹ️ Manual trade triggered via API', { action: 'manual-trade' });
    const result = await runIntervalCycle('coinbase', legacyPair());
    res.status(tradeResultStatusCode(result)).json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
  }));

  app.get('/api/trade', (req, res) => {
    res.json({ status: 'no_trades_yet' });
  });
};
