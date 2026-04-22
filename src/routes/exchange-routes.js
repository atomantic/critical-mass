// @ts-check
/**
 * Exchange Management & Per-Exchange API Routes
 */

const stateTracker = require('../state-tracker');
const {
  getExchangeConfig,
  getFundConfig,
  getGlobalConfig,
  getConfiguredExchanges,
  getConfiguredFunds,
  getEnabledExchanges,
  getEnabledFunds,
  getFundsForExchange,
  getDefaultPair,
  updateExchangeConfig,
  updateFundConfig,
  setExchangeEnabled,
  setExchangeDryRun,
  addFund,
  removeFund,
  getBaseCurrency,
  getQuoteCurrency,
  REGIME_DEFAULTS,
} = require('../config-utils');
const { normalizeConfig, getNextExecutionTime, hasRunThisInterval, formatInterval, getTimeUntilNext } = require('../interval-utils');
const { log, loadTransactionHistory, getLogFile } = require('../logger');
const { syncOrderStatuses, runIntervalCycle, loadConfig, executeConsolidation } = require('../dca-engine');
const { shouldAutoResumeRegime } = require('../shared-utils');
const { validateConfigUpdate, EXCHANGE_CONFIG_SCHEMA } = require('../config-validator');

// --- Security: pair validation regex ---
// Pair query param must be of the form AAAA-BBBB or AAAA_BBBB (case-insensitive).
// Requires a dash or underscore separator: bare concatenated tickers like BTCUSDC are rejected.
const PAIR_RE = /^[A-Z0-9]{2,8}[-_][A-Z0-9]{2,8}$/i;

/**
 * Validate and return the trading pair from a request's query param.
 * Falls back to the exchange default if ?pair= is absent.
 * Returns null (without throwing) if the value fails validation.
 *
 * @param {import('express').Request} req
 * @returns {{ pair: string | null, error: string | null }}
 */
const validatePairParam = (req) => {
  const raw = req.query?.pair;
  if (!raw) {
    // No pair supplied — fall back to exchange default (may still be null).
    return { pair: getDefaultPair(req.params.exchange), error: null };
  }
  if (!PAIR_RE.test(String(raw))) {
    return { pair: null, error: `Invalid pair format: "${raw}". Expected e.g. BTC-USDC or BTC_USDC` };
  }
  return { pair: String(raw).toUpperCase(), error: null };
};

// --- Security: regime sub-object allowlist ---
// Derived from REGIME_DEFAULTS so it automatically stays in sync as config-utils evolves.
const REGIME_ALLOWED_KEYS = new Set(Object.keys(REGIME_DEFAULTS));

/**
 * @param {import('express').Express} app
 * @param {{exchangeIPCMap: Object, parseTSV: Function, calculateCostBasis: Function, getNextTradeInfo: Function}} deps
 */
module.exports = (app, deps) => {
  const { exchangeIPCMap, parseTSV, calculateCostBasis, getNextTradeInfo } = deps;
  const getIPC = (exchange) => exchangeIPCMap[exchange] || exchangeIPCMap.coinbase;

  // Get list of all exchanges (with each fund flattened into the array).
  // Returns one entry per (exchange, pair) — the legacy `name` field is the
  // exchange name, and `pair`/`productId` identify the specific fund. The UI
  // groups by exchange when needed but iterates funds 1:1 with this array.
  app.get('/api/exchanges', (req, res) => {
    const funds = getConfiguredFunds();
    const enabled = getEnabledExchanges();

    const exchanges = funds.map(({ exchange, pair }) => {
      const config = getFundConfig(exchange, pair);
      const strategy = config.dcaStrategy || 'fixed';
      const regimeConfig = config.regime || {};
      const hasRegimeConfig = !!(config.regime && Object.keys(config.regime).length > 0);
      // Surface fund lifecycle from saved regime state so the UI can render
      // Draining/Closed badges without an extra round-trip.
      const regimeState = stateTracker.loadRegimeState(exchange, pair);
      const lifecycle = regimeState?.position?.lifecycle || 'active';
      return {
        name: exchange,
        exchange,
        pair,
        enabled: config.enabled,
        dryRun: config.dryRun,
        productId: config.productId,
        strategy,
        regimeEnabled: regimeConfig.enabled || false,
        regimeRunning: shouldAutoResumeRegime(exchange, pair),
        hasRegimeConfig,
        lifecycle,
        lifecycleChangedAt: regimeState?.position?.lifecycleChangedAt || null,
        lifecycleReason: regimeState?.position?.lifecycleReason || null,
      };
    });

    const globalConfig = getGlobalConfig();
    res.json({ exchanges, enabled, simpleDcaEnabled: globalConfig.simpleDcaEnabled ?? false });
  });

  // ========= Fund Management =========

  // List funds (pairs) configured on an exchange
  app.get('/api/:exchange/funds', (req, res) => {
    const { exchange } = req.params;
    const funds = getFundsForExchange(exchange);
    res.json({
      exchange,
      defaultPair: getDefaultPair(exchange),
      funds: funds.map((pair) => {
        const config = getFundConfig(exchange, pair);
        const regimeState = stateTracker.loadRegimeState(exchange, pair);
        return {
          pair,
          productId: config.productId,
          enabled: config.enabled,
          dryRun: config.dryRun,
          strategy: config.dcaStrategy || 'fixed',
          regimeRunning: shouldAutoResumeRegime(exchange, pair),
          lifecycle: regimeState?.position?.lifecycle || 'active',
        };
      }),
    });
  });

  // Add a new fund (exchange + pair). Validates pair format, refuses
  // duplicates, and verifies the productId is supported by the adapter.
  app.post('/api/:exchange/funds', async (req, res) => {
    const { exchange } = req.params;
    const { pair, productId, totalAllocation, dryRun, regime } = req.body || {};

    if (!pair || typeof pair !== 'string') {
      return res.status(400).json({ success: false, error: 'pair is required (e.g. "ETH-USDC")' });
    }

    // Verify the exchange has an adapter (guards against bogus exchange names)
    const { getAdapter } = require('../adapters');
    let adapter;
    try {
      adapter = getAdapter(exchange);
    } catch (err) {
      return res.status(400).json({ success: false, error: `Unknown exchange: ${exchange}` });
    }

    // Verify the productId is valid on this exchange by hitting the API.
    // This catches typos before we persist anything to disk.
    const resolvedProductId = productId || pair;
    if (adapter.hasValidKeys && adapter.hasValidKeys()) {
      try {
        const details = await adapter.getProductDetails(resolvedProductId);
        if (!details) {
          return res.status(400).json({ success: false, error: `Product ${resolvedProductId} not found on ${exchange}` });
        }
      } catch (err) {
        return res.status(400).json({ success: false, error: `Failed to verify ${resolvedProductId} on ${exchange}: ${err.message}` });
      }
    }

    // Persist the new fund
    try {
      const initialConfig = {
        productId: resolvedProductId,
        enabled: false, // Operator must explicitly enable
        dryRun: dryRun !== false, // Default to dry-run for safety
      };
      // The "Total Allocation" entered in the Add Fund modal is the operator's
      // intended budget for this fund. The regime engine (the active engine)
      // does not read `totalAllocation` — it uses `regime.depositedCapital`
      // and `regime.maxUsdcDeployed`. Mirror the value into all three so the
      // dashboard's Deposited field and the engine's risk caps both reflect
      // what the operator entered, instead of leaving regime at 0.
      const seedRegime = { enabled: true, ...(regime && typeof regime === 'object' ? regime : {}) };
      if (typeof totalAllocation === 'number' && totalAllocation > 0) {
        initialConfig.totalAllocation = totalAllocation;
        seedRegime.depositedCapital ??= totalAllocation;
        seedRegime.maxUsdcDeployed ??= totalAllocation;
      }
      initialConfig.regime = seedRegime;
      addFund(exchange, pair, initialConfig);
      log('INFO', `🆕 [${exchange}/${pair}] Fund created (productId=${resolvedProductId}, dryRun=${initialConfig.dryRun})`);
      res.json({
        success: true,
        exchange,
        pair,
        productId: resolvedProductId,
        config: getFundConfig(exchange, pair),
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Remove a fund. Refuses unless the fund is closed (lifecycle === 'closed')
  // and the engine is not running. Does NOT delete on-disk state files —
  // operator must remove data/<exchange>/<pair>/ manually if desired.
  app.delete('/api/:exchange/funds/:pair', (req, res) => {
    const { exchange, pair } = req.params;
    const regimeState = stateTracker.loadRegimeState(exchange, pair);
    const lifecycle = regimeState?.position?.lifecycle || 'active';
    if (lifecycle !== 'closed') {
      return res.status(400).json({
        success: false,
        error: `Refusing to remove fund: lifecycle is '${lifecycle}'. Close the fund first via POST /api/${exchange}/regime/close, then wait for it to drain.`,
      });
    }
    if (shouldAutoResumeRegime(exchange, pair)) {
      return res.status(400).json({
        success: false,
        error: 'Refusing to remove fund: regime engine is still flagged as running. Stop it first.',
      });
    }
    try {
      removeFund(exchange, pair);
      log('INFO', `🗑️  [${exchange}/${pair}] Fund removed from config`);
      res.json({
        success: true,
        exchange,
        pair,
        note: `On-disk state at data/${exchange}/${pair}/ was NOT deleted. Remove manually if no longer needed.`,
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Get config for an exchange/fund (?pair= optional)
  app.get('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const config = getFundConfig(exchange, pair);
    res.json(config);
  });

  // Update config for an exchange/fund (?pair= optional)
  app.put('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const { pair, error: pairError } = validatePairParam(req);
    if (pairError) return res.status(400).json({ success: false, error: pairError });
    const { value: updates, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    // regime is a nested object — validate keys against allowlist before merging
    if (req.body?.regime && typeof req.body.regime === 'object' && !Array.isArray(req.body.regime)) {
      const sanitizedRegime = {};
      const rejectedKeys = [];
      for (const key of Object.keys(req.body.regime)) {
        if (REGIME_ALLOWED_KEYS.has(key)) {
          sanitizedRegime[key] = req.body.regime[key];
        } else {
          rejectedKeys.push(key);
        }
      }
      if (rejectedKeys.length > 0) {
        return res.status(400).json({ success: false, error: `Unknown regime keys: ${rejectedKeys.join(', ')}` });
      }
      if (Object.keys(sanitizedRegime).length > 0) {
        updates.regime = sanitizedRegime;
      }
    }

    updateFundConfig(exchange, pair, updates);

    if (updates.regime) {
      getIPC(exchange).request('regime:update-config', updates.regime, exchange, pair).catch(() => {});
    }

    res.json({ success: true, config: getFundConfig(exchange, pair) });
  });

  // Toggle enabled/dryRun for an exchange/fund (?pair= optional)
  app.patch('/api/:exchange/config', (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const { enabled, dryRun } = req.body;

    if (typeof enabled === 'boolean') {
      setExchangeEnabled(exchange, pair, enabled);
      log('INFO', `[${exchange}/${pair}] Trading automation ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    if (typeof dryRun === 'boolean') {
      setExchangeDryRun(exchange, pair, dryRun);
      log('INFO', `[${exchange}/${pair}] Dry-run mode ${dryRun ? 'ENABLED' : 'DISABLED'}`);
    }

    res.json({ success: true, config: getFundConfig(exchange, pair) });
  });

  // Get state for an exchange/fund (?pair= optional)
  app.get('/api/:exchange/state', (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const config = getFundConfig(exchange, pair);
    const state = stateTracker.loadState(config, exchange, pair);
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
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const { getAdapter } = require('../adapters');

    const config = getFundConfig(exchange, pair);
    const state = stateTracker.loadState(config, exchange, pair);

    let currentPrice = 0;
    let quoteBalance = { available: 0, hold: 0 };
    let assetBalance = { available: 0, hold: 0 };
    let keysConfigured = false;
    let apiError = null;
    const quoteCurrency = getQuoteCurrency(config.productId);

    const adapter = getAdapter(exchange);

    if (adapter.hasValidKeys && adapter.hasValidKeys()) {
      keysConfigured = true;
      try {
        currentPrice = await adapter.getCurrentPrice(config.productId);
        quoteBalance = await adapter.getAccountBalance(quoteCurrency);
        assetBalance = await adapter.getAccountBalance(getBaseCurrency(config.productId));
      } catch (err) {
        apiError = err.message || 'API connection failed';
        log('ERROR', `[${exchange}/${pair}] Status check failed: ${apiError}`);
      }
    }

    res.json({
      exchange,
      pair,
      currentPrice,
      quoteBalance,
      assetBalance,
      quoteCurrency,
      keysConfigured,
      apiError,
      config,
      state,
      lastUpdated: new Date().toISOString(),
    });
  });

  // Get summary for an exchange/fund (?pair= optional)
  app.get('/api/:exchange/summary', (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const config = getFundConfig(exchange, pair);
    const state = stateTracker.loadState(config, exchange, pair);
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
      const proceeds = o.netProceeds || (o.sellQuantity * (o.filledPrice || o.sellPrice));
      const cost = o.buyCostBasis || (o.buyQuantity * o.buyPrice);
      const costForSold = o.buyQuantity > 0 ? cost * (o.sellQuantity / o.buyQuantity) : 0;
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
        assetReserves: state.assetReserves || 0,
        usdcFundSize: state.usdcFundSize || 0,
        outstandingOrdersUSDC: state.outstandingOrdersUSDC || 0,
        outstandingOrdersAsset: state.outstandingOrdersAsset || 0,
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

  // Get candles for an exchange/fund (for charts)
  app.get('/api/:exchange/candles', async (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const { granularity = 'ONE_MINUTE', limit = 60 } = req.query;
    const config = getFundConfig(exchange, pair);
    const { getAdapter } = require('../adapters');
    const adapter = getAdapter(exchange);

    const productId = config.productId;
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

  // Sync pending orders for an exchange/fund
  app.post('/api/:exchange/sync', async (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });

    if (!getGlobalConfig().simpleDcaEnabled) {
      return res.status(400).json({ success: false, error: 'Simple DCA is disabled. Use Regime engine.' });
    }

    const config = getFundConfig(exchange, pair);
    const state = stateTracker.loadState(config, exchange, pair);

    const filledOrders = await syncOrderStatuses(state, exchange);
    if (filledOrders.length > 0) {
      stateTracker.saveState(state, exchange, pair);
    }

    res.json({
      success: true,
      exchange,
      pair,
      filledOrders: filledOrders.length,
      lastSyncTime: new Date().toISOString(),
    });
  });

  // Trigger trade for an exchange/fund
  app.post('/api/:exchange/trade', async (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });

    if (!getGlobalConfig().simpleDcaEnabled) {
      return res.status(400).json({ success: false, error: 'Simple DCA is disabled. Use Regime engine.' });
    }

    log('INFO', `[${exchange}/${pair}] Manual trade triggered via API`);

    const result = await runIntervalCycle(exchange);
    res.json({ ...result, triggeredAt: new Date().toISOString(), trigger: 'manual' });
  });

  // Consolidate pending orders for an exchange/fund
  app.post('/api/:exchange/consolidate', async (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const { orderIds } = req.body || {};

    log('INFO', `[${exchange}/${pair}] Consolidation triggered via API`);

    const config = getFundConfig(exchange, pair);
    const state = stateTracker.loadState(config, exchange, pair);
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
