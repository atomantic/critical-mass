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
// Accepts three pair formats (case-insensitive):
//   BASE-QUOTE  (Coinbase, e.g. BTC-USDC)
//   BASE_QUOTE  (Crypto.com, e.g. BTC_USD)
//   BASEQUOTE   (Gemini, e.g. BTCUSD, ETHUSD)
const PAIR_RE = /^[A-Z0-9]{2,8}([-_][A-Z0-9]{2,8})?$/i;

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
    return { pair: null, error: `Invalid pair format: "${raw}". Expected e.g. BTC-USDC, BTC_USD, or ETHUSD` };
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

    // Guard against cross-market contamination. The config editor GETs a fund's
    // config and PUTs it back verbatim; if a stale config from another fund leaked
    // into the editor state (e.g. switching exchange/pair before the new config
    // loaded), its productId would clobber this fund — e.g. saving Coinbase's
    // "BTC-USDC" over Gemini's "ETHUSD", which then prices the ETH fund off the BTC
    // feed. The pair is the fund's identity, so a saved productId must trade the
    // same base asset. Quote-only edits (USD→USDC) still pass.
    if (pair && typeof updates.productId === 'string' && updates.productId) {
      const pairBase = getBaseCurrency(pair);
      const incomingBase = getBaseCurrency(updates.productId);
      if (pairBase !== incomingBase) {
        log('WARN', `🛑 [${exchange}/${pair}] Rejected config save: productId "${updates.productId}" trades ${incomingBase}, not ${pairBase}`);
        return res.status(400).json({ error: `productId "${updates.productId}" (${incomingBase}) does not match fund ${exchange}/${pair} (${pairBase}); a config save cannot change a fund's traded asset` });
      }
    }

    // regime is a nested object — sanitize keys against the allowlist before merging.
    // Unknown keys are DROPPED (not rejected): the config editor GETs the full stored
    // config and PUTs it back verbatim, so a hard 400 on a stale key — e.g. a field
    // removed from the engine in a later version but still present in a fund's
    // persisted config — would make that fund permanently unsaveable. Dropping keeps
    // the security intent (unknown keys never enter the saved overrides or reach the
    // engine) while letting the save succeed. Note this doesn't rewrite the base
    // config.json: a stale key living there stays inert (saveConfig persists only a
    // diff and computeDiff doesn't tombstone removals), but it's harmless — never
    // forwarded and dropped again on every save.
    if (req.body?.regime && typeof req.body.regime === 'object' && !Array.isArray(req.body.regime)) {
      const sanitizedRegime = {};
      const droppedKeys = [];
      for (const key of Object.keys(req.body.regime)) {
        if (REGIME_ALLOWED_KEYS.has(key)) {
          sanitizedRegime[key] = req.body.regime[key];
        } else {
          droppedKeys.push(key);
        }
      }
      if (droppedKeys.length > 0) {
        log('WARN', `🧹 [${exchange}/${pair}] Dropped ${droppedKeys.length} unknown regime key(s) on save: ${droppedKeys.join(', ')}`);
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

  // Get summary for an exchange/fund (?pair= optional).
  // Reads from regime data (regime-state.json + fill-ledger.json) and exposes
  // it in the legacy DCA shape so the main Dashboard.jsx keeps rendering. The
  // legacy DCA state.json was frozen at the DCA→regime migration (Feb 2026)
  // and has been silently 3+ months stale; everything below is rebuilt fresh.
  app.get('/api/:exchange/summary', (req, res) => {
    const { exchange } = req.params;
    const { pair, error } = validatePairParam(req);
    if (error) return res.status(400).json({ success: false, error });
    const config = getFundConfig(exchange, pair);

    const { loadRegimeState } = require('../state-tracker');
    const { createFillLedger } = require('../fill-ledger');
    const regimeState = loadRegimeState(exchange, pair);
    const position = regimeState.position || {};
    const fillLedger = createFillLedger(exchange, config.productId, pair);
    const allFills = fillLedger.getAllFills();

    const buyFills = allFills.filter(f => f.side === 'buy');
    const sellFills = allFills.filter(f => f.side === 'sell');
    const totalBought = buyFills.reduce((s, f) => s + (f.quoteAmount || 0), 0);
    const totalSold = sellFills.reduce((s, f) => s + (f.quoteAmount || 0), 0);
    const totalAssetBought = buyFills.reduce((s, f) => s + (f.size || 0), 0);
    const totalAssetSold = sellFills.reduce((s, f) => s + (f.size || 0), 0);
    const totalFees = allFills.reduce((s, f) => s + (f.netFee || 0), 0);

    const derived = fillLedger.getDerivedRealizedPnL();

    // Cost basis breakdown derived from regime bodies (pending = on TP orders;
    // reserves = accumulated holdback not currently in a body).
    const bodies = position.celestialBodies || [];
    const pendingCostBasis = bodies.reduce((s, b) => s + (b.costBasis || 0), 0);
    const pendingAsset = bodies.reduce((s, b) => s + (b.assetQty || 0), 0);
    const totalCostBasis = totalBought; // gross capital ever deployed on buys
    const avgCostPerAsset = totalAssetBought > 0 ? totalCostBasis / totalAssetBought : 0;
    // Reserves are zero-cost in the cycle-pair model (their cost was attributed
    // to the paired sell), but the dashboard's "reserves cost basis" panel
    // expects an avg-cost figure for display only. Use running avg.
    const reservesAsset = derived.realizedAssetPnL;
    const reservesCostBasis = reservesAsset * avgCostPerAsset;

    // Map regime shape onto the legacy `state` shape Dashboard.jsx expects.
    const state = {
      usdcFundSize: position.depositedCapital || 0,
      assetReserves: reservesAsset,
      outstandingOrdersUSDC: bodies.reduce((s, b) => s + (b.assetQty || 0) * (b.tpPrice || 0), 0),
      outstandingOrdersAsset: position.assetOnOrder || 0,
      totalAllocated: position.depositedCapital || 0,
      totalFees,
      totalRebates: 0,
      netFees: totalFees,
      totalIntervalsRun: position.cyclesCompleted || 0,
      orders: [], // legacy DCA-style orders; regime engine doesn't use this shape
    };

    res.json({
      exchange,
      config,
      state,
      stats: {
        totalBuys: buyFills.length,
        totalSells: sellFills.length,
        pendingOrders: (position.pendingEntryOrders || []).length,
        totalBought,
        totalSold,
        totalBTCBought: totalAssetBought,
        totalBTCSold: totalAssetSold,
        totalFees,
        totalRebates: 0,
        netFees: totalFees,
        assetReserves: state.assetReserves,
        usdcFundSize: state.usdcFundSize,
        outstandingOrdersUSDC: state.outstandingOrdersUSDC,
        outstandingOrdersAsset: state.outstandingOrdersAsset,
        allocationUsed: state.totalAllocated,
        allocationRemaining: (config.totalAllocation || state.totalAllocated || 0) - state.totalAllocated,
        intervalsRun: state.totalIntervalsRun,
        realizedProfit: derived.realizedPnL,
        // Diagnostic: sells with no paired buys (e.g. manual sells, recovery
        // sells with no linkage). Their proceeds are not counted in realizedPnL.
        unpairedSellQty: derived.unpairedSellQty || 0,
      },
      costBasis: {
        totalCostBasis,
        totalAssetBought,
        avgCostPerAsset,
        reservesAsset,
        reservesCostBasis,
        reservesAvgCost: reservesAsset > 0 ? reservesCostBasis / reservesAsset : 0,
        pendingAsset,
        pendingCostBasis,
        pendingAvgCost: pendingAsset > 0 ? pendingCostBasis / pendingAsset : 0,
        orderBreakdown: [],
      },
      nextTrade: { nextRunTime: null, intervalsRemaining: 0, allocationRemaining: 0 },
      transactions: [], // legacy DCA transaction log no longer maintained
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
