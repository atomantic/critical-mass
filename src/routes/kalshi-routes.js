// @ts-check
/**
 * Kalshi Routes
 *
 * REST API and Socket.IO event handlers for the Kalshi prediction market
 * trading engine. Mounted at /api/kalshi/ in server.js.
 *
 * Follows critical-mass route pattern: module.exports = (app, sharedDeps) => { ... }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { log } = require('../logger');
const { KALSHI_DATA_DIR } = require('../paths');
const { ts } = require('../time-utils');
const { createAsyncHandler } = require('./async-handler');
const { validateConfigUpdate, validateStrategies, validateMarkets, KALSHI_CONFIG_SCHEMA } = require('../config-validator');

const DATA_DIR = KALSHI_DATA_DIR;
const asyncHandler = createAsyncHandler('kalshi', ts);

// Lazy-loaded service references (initialized on first engine start)
let kalshiAdapters = null;
let simulationEngine = null;
let strategyIndex = null;
let kalshiPriceService = null;
let kalshiOrderbookService = null;
let liveExecutionService = null;
let kalshiAccountCache = null;
let autoTunerModule = null;
let convictionTracker = null;
let polymarketPriceService = null;
let alertService = null;
let tradeAnalyst = null;
let accountReconciliation = null;

/** Tracked market tickers for the engine */
let trackedMarketTickers = [];

/** Last time the "Fetched X markets" log was emitted (epoch ms) */
let lastFetchedMarketsLogAt = 0;

/** @type {NodeJS.Timeout | null} */
let marketRefreshTimer = null;

/** @type {NodeJS.Timeout | null} */
let nextSettlementTimer = null;

/**
 * Calculate ms until the next 15-min settlement boundary + offset.
 * @param {number} offsetMs
 * @returns {number}
 */
const msUntilNextSettlement = (offsetMs = 2000) => {
  const now = Date.now();
  const d = new Date(now);
  const mins = d.getMinutes();
  const nextBoundaryMin = Math.ceil((mins + 1) / 15) * 15;
  const next = new Date(d);
  next.setMinutes(nextBoundaryMin % 60, 0, 0);
  if (nextBoundaryMin >= 60) next.setHours(next.getHours() + 1);
  return Math.max(0, next.getTime() + offsetMs - now);
};

/**
 * Read and parse JSON file from data/kalshi directory
 * @param {string} filename
 * @returns {Promise<any>}
 */
const readJson = async (filename) => {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return {};
  const data = await fsp.readFile(filepath, 'utf-8');
  const trimmed = data.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
};

/** @type {Map<string, Promise<void>>} Per-file write serialization */
const writeLocks = new Map();
let writeSeq = 0;

/**
 * Write JSON data to file (atomic, serialized per file)
 * @param {string} filename
 * @param {any} data
 * @returns {Promise<void>}
 */
const writeJson = (filename, data) => {
  const prev = writeLocks.get(filename) || Promise.resolve();
  const current = prev.then(async () => {
    const filepath = path.join(DATA_DIR, filename);
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filepath}.${process.pid}.${++writeSeq}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, filepath);
  }).catch((err) => {
    log('ERROR', `[${ts()}] writeJson(${filename}) failed: ${err.message}`);
  });
  writeLocks.set(filename, current);
  return current;
};

/**
 * Masked keys for display
 * @param {Object} keys
 * @returns {Object}
 */
const getMaskedKeys = (keys) => ({
  keyId: keys.keyId || '',
  privateKeyPem: keys.privateKeyPem ? '••• (configured)' : '',
  environment: keys.environment || 'demo',
  hasKeys: !!(keys.keyId && keys.privateKeyPem),
});

/**
 * Validate keys exist
 * @param {Object} keys
 * @param {Object} res
 * @returns {boolean}
 */
const requireKeys = (keys, res) => {
  if (!keys.keyId || !keys.privateKeyPem) {
    res.status(400).json({ error: 'API keys not configured' });
    return false;
  }
  return true;
};

/**
 * Normalize dry-run position format to Kalshi API format
 * @param {Object} pos
 * @returns {Object}
 */
const normalizePosition = (pos) => {
  if (pos.position !== undefined) return pos;
  const contracts = pos.contracts || 0;
  const isYes = pos.side === 'yes';
  return {
    ticker: pos.ticker,
    position: isYes ? contracts : -contracts,
    average_price: pos.avgCost || 0,
    avgPrice: pos.avgCost || 0,
    metadata: pos.metadata,
  };
};

/**
 * Lazy-load Kalshi modules (avoids require failures if deps missing)
 */
const loadModules = () => {
  if (!kalshiAdapters) {
    kalshiAdapters = require('../kalshi/adapters');
  }
  if (!simulationEngine) {
    simulationEngine = require('../kalshi/engines/simulation-engine');
  }
  if (!strategyIndex) {
    strategyIndex = require('../kalshi/strategies');
  }
  if (!kalshiPriceService) {
    kalshiPriceService = require('../kalshi/services/kalshi-price-service');
  }
  if (!kalshiOrderbookService) {
    kalshiOrderbookService = require('../kalshi/services/kalshi-orderbook-service');
  }
  if (!liveExecutionService) {
    liveExecutionService = require('../kalshi/services/live-execution-service');
  }
  if (!kalshiAccountCache) {
    kalshiAccountCache = require('../kalshi/services/kalshi-account-cache');
  }
  if (!autoTunerModule) {
    autoTunerModule = require('../kalshi/services/auto-tuner');
  }
  if (!convictionTracker) {
    convictionTracker = require('../kalshi/services/conviction-tracker');
  }
  if (!polymarketPriceService) {
    polymarketPriceService = require('../kalshi/services/polymarket-price-service');
  }
  if (!alertService) {
    alertService = require('../kalshi/services/alert-service');
  }
  if (!tradeAnalyst) {
    tradeAnalyst = require('../kalshi/services/trade-analyst');
  }
  if (!accountReconciliation) {
    accountReconciliation = require('../kalshi/services/account-reconciliation');
  }
};

/**
 * Refresh market list
 */
const refreshMarkets = async () => {
  loadModules();
  const [keys, config] = await Promise.all([
    readJson('keys.json'),
    readJson('config.json'),
  ]);

  if (!keys.keyId || !keys.privateKeyPem) return;
  if (config.markets?.crypto?.enabled === false) return;

  const marketConfig = config.markets?.crypto || { assets: ['BTC'], timeframes: ['15min'] };
  let freshMarkets = await kalshiAdapters.markets.getCryptoMarkets(keys, marketConfig);

  for (let retry = 0; retry < 2 && freshMarkets.length === 0; retry++) {
    log('WARN', `[${ts()}] ⚠️ 0 markets returned, retrying in 5s (attempt ${retry + 1}/2)`);
    await new Promise(r => setTimeout(r, 5000));
    freshMarkets = await kalshiAdapters.markets.getCryptoMarkets(keys, marketConfig);
  }

  const freshTickers = freshMarkets.map(m => m.ticker);
  const oldSet = new Set(trackedMarketTickers);
  const newSet = new Set(freshTickers);

  const added = freshTickers.filter(t => !oldSet.has(t));
  const removed = trackedMarketTickers.filter(t => !newSet.has(t));

  if (added.length === 0 && removed.length === 0) return;

  if (added.length > 0) {
    kalshiPriceService.subscribeMany(added);
    added.forEach(t => kalshiOrderbookService.subscribeTicker(t));
  }
  if (removed.length > 0) removed.forEach(t => kalshiPriceService.unsubscribeTicker(t));

  simulationEngine.setMarketsInfo(freshMarkets);
  trackedMarketTickers = freshTickers;

  log('INFO', `[${ts()}] 🔄 Markets refreshed: ${freshTickers.length} active (+${added.length} new, -${removed.length} expired)`);
};

/**
 * Schedule market refresh at settlement boundaries
 */
const scheduleSettlementRefresh = () => {
  if (nextSettlementTimer) clearTimeout(nextSettlementTimer);

  const delay = msUntilNextSettlement(2000);
  const nextTime = new Date(Date.now() + delay).toISOString().slice(11, 19);
  log('INFO', `[${ts()}] ⏰ Next settlement refresh scheduled in ${Math.round(delay / 1000)}s (at ${nextTime})`);

  nextSettlementTimer = setTimeout(async () => {
    log('INFO', `[${ts()}] 🔔 Settlement boundary — refreshing markets`);
    await refreshMarkets().catch(err => log('WARN', `[${ts()}] ⚠️ Settlement refresh failed: ${err.message}`));

    setTimeout(() => refreshMarkets().catch(() => {}), 10_000);
    setTimeout(() => refreshMarkets().catch(() => {}), 30_000);

    scheduleSettlementRefresh();
  }, delay);
};

/**
 * Mount Kalshi routes on the Express app
 * @param {import('express').Application} app
 * @param {Object} sharedDeps
 */
module.exports = (app, sharedDeps) => {
  const { io } = sharedDeps;

  // ====== KEYS ROUTES ======

  app.get('/api/kalshi/keys', asyncHandler(async (req, res) => {
    const keys = await readJson('keys.json');
    res.json({ keys: getMaskedKeys(keys) });
  }));

  app.put('/api/kalshi/keys', asyncHandler(async (req, res) => {
    loadModules();
    const { keyId, privateKeyPem, environment = 'demo' } = req.body;

    if (!keyId?.trim()) return res.status(400).json({ error: 'Key ID is required' });
    if (!privateKeyPem?.trim()) return res.status(400).json({ error: 'Private key is required' });

    const validation = kalshiAdapters.validateKeys({ keyId, privateKeyPem });
    if (!validation.valid) return res.status(400).json({ error: validation.errors.join(', ') });

    await writeJson('keys.json', { keyId, privateKeyPem, environment });
    log('INFO', `[${ts()}] 🔑 Kalshi keys saved for ${environment} environment`);
    res.json({ success: true });
  }));

  app.delete('/api/kalshi/keys', asyncHandler(async (req, res) => {
    await writeJson('keys.json', { keyId: '', privateKeyPem: '', environment: 'demo' });
    log('INFO', `[${ts()}] 🔑 Kalshi keys deleted`);
    res.json({ success: true });
  }));

  app.post('/api/kalshi/test-connection', asyncHandler(async (req, res) => {
    loadModules();
    const keys = await readJson('keys.json');
    if (!requireKeys(keys, res)) return;

    const result = await kalshiAdapters.api.testConnection(keys);
    log('INFO', `[${ts()}] 🔌 Kalshi connection OK - balance: $${result.balance.available.toFixed(2)}`);
    res.json(result);
  }));

  // ====== CONFIG ROUTES ======

  app.get('/api/kalshi/config', asyncHandler(async (req, res) => {
    const config = await readJson('config.json');
    res.json(config);
  }));

  app.put('/api/kalshi/config', asyncHandler(async (req, res) => {
    const { value: validated, errors } = validateConfigUpdate(KALSHI_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
    const config = await readJson('config.json');
    const updated = { ...config, ...validated };

    // strategies and markets are nested objects — validate per-entry
    if (req.body?.strategies) {
      const { value: strats, errors: stratErrors } = validateStrategies(req.body.strategies);
      if (stratErrors.length > 0) return res.status(400).json({ error: stratErrors.join('; ') });
      updated.strategies = strats;
    }
    if (req.body?.markets) {
      const { value: mkts, errors: mktErrors } = validateMarkets(req.body.markets);
      if (mktErrors.length > 0) return res.status(400).json({ error: mktErrors.join('; ') });
      updated.markets = mkts;
    }

    await writeJson('config.json', updated);
    log('INFO', `[${ts()}] ⚙️ Kalshi config updated`);
    res.json(updated);
  }));

  app.patch('/api/kalshi/config', asyncHandler(async (req, res) => {
    const { value: validated, errors } = validateConfigUpdate(KALSHI_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
    const config = await readJson('config.json');
    const updated = { ...config, ...validated };

    // strategies and markets are nested objects — validate per-entry
    if (req.body?.strategies) {
      const { value: strats, errors: stratErrors } = validateStrategies(req.body.strategies);
      if (stratErrors.length > 0) return res.status(400).json({ error: stratErrors.join('; ') });
      updated.strategies = strats;
    }
    if (req.body?.markets) {
      const { value: mkts, errors: mktErrors } = validateMarkets(req.body.markets);
      if (mktErrors.length > 0) return res.status(400).json({ error: mktErrors.join('; ') });
      updated.markets = mkts;
    }

    await writeJson('config.json', updated);
    log('INFO', `[${ts()}] ⚙️ Kalshi config patched: ${Object.keys(validated).join(', ')}`);
    res.json(updated);
  }));

  // ====== STATUS ROUTES ======

  app.get('/api/kalshi/status', asyncHandler(async (req, res) => {
    loadModules();
    const forceRefresh = req.query.refresh === 'true';

    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    let balance = state.balance || { available: 10000, inPositions: 0 };
    let positions = (state.positions || []).map(normalizePosition);
    let realBalance = null;
    let realPositions = null;

    if (keys.keyId && keys.privateKeyPem) {
      const accountData = await kalshiAccountCache.getAccountData(keys, forceRefresh);

      if (accountData.balance) {
        const inPositions = accountData.positions?.reduce((sum, p) =>
          sum + ((p.market_exposure || 0) / 100), 0) || 0;
        realBalance = {
          available: accountData.balance.available,
          portfolioValue: accountData.balance.portfolioValue,
          inPositions,
        };
      }
      realPositions = accountData.positions || [];

      if (!config.dryRun && realBalance) {
        balance = realBalance;
        positions = realPositions;
      }
    }

    const engineStatus = simulationEngine?.getStatus?.() ?? {};

    res.json({
      config: { enabled: config.enabled, dryRun: config.dryRun, apiEnvironment: config.apiEnvironment },
      balance,
      realBalance,
      positions,
      realPositions,
      mode: config.dryRun ? 'dry_run' : 'live',
      engineRunning: state.engineRunning,
      todayStats: state.todayStats || { trades: 0, wins: 0, pnl: 0 },
      trades: state.trades || [],
      lastUpdated: state.lastUpdated || new Date().toISOString(),
      cacheStatus: kalshiAccountCache?.getCacheStatus?.() ?? {},
      shadowStats: engineStatus.shadowStats,
      shadowStrategies: engineStatus.shadowStrategies,
      shadowPositions: engineStatus.shadowPositions,
      shadowBalance: engineStatus.shadowBalance,
    });
  }));

  // ====== MARKETS ROUTES ======

  app.get('/api/kalshi/markets', asyncHandler(async (req, res) => {
    loadModules();
    const { type, asset, sport, timeframe, limit = 50 } = req.query;
    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    if (!requireKeys(keys, res)) return;

    let marketList;
    if (type === 'crypto') {
      marketList = await kalshiAdapters.markets.getCryptoMarkets(keys, {
        assets: asset ? [asset] : config.markets?.crypto?.assets || ['BTC'],
        timeframes: timeframe ? [timeframe] : config.markets?.crypto?.timeframes || ['15min'],
      });
    } else if (type === 'sports') {
      marketList = await kalshiAdapters.markets.getSportsMarkets(keys, {
        leagues: sport ? [sport] : config.markets?.sports?.leagues || [],
        maxTimeToSettle: config.markets?.sports?.maxTimeToSettle,
      });
    } else if (type === 'all') {
      log('WARN', `[${ts()}] ⚠️ Fetching ALL markets - this is slow`);
      marketList = await kalshiAdapters.markets.getAllMarkets(keys, config);
    } else {
      const cryptoMarkets = await kalshiAdapters.markets.getCryptoMarkets(keys, {
        assets: config.markets?.crypto?.assets || ['BTC'],
        timeframes: config.markets?.crypto?.timeframes || ['15min'],
      });
      const sportsMarkets = await kalshiAdapters.markets.getSportsMarkets(keys, {
        leagues: config.markets?.sports?.leagues || [],
        maxTimeToSettle: config.markets?.sports?.maxTimeToSettle,
      });
      marketList = [...cryptoMarkets, ...sportsMarkets]
        .sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    }

    const now = Date.now();
    if (now - lastFetchedMarketsLogAt > 60_000) {
      lastFetchedMarketsLogAt = now;
      log('INFO', `[${ts()}] 📊 Fetched ${marketList.length} Kalshi markets (type=${type || 'crypto+sports'})`);
    }
    res.json({ markets: marketList.slice(0, parseInt(limit)), total: marketList.length });
  }));

  app.get('/api/kalshi/markets/:ticker', asyncHandler(async (req, res) => {
    loadModules();
    const { ticker } = req.params;
    if (!ticker) return res.status(400).json({ error: 'Ticker is required' });

    const keys = await readJson('keys.json');
    if (!requireKeys(keys, res)) return;

    const market = await kalshiAdapters.markets.getMarketWithDetails(keys, ticker);
    res.json(market);
  }));

  app.get('/api/kalshi/orderbook/:ticker', asyncHandler(async (req, res) => {
    loadModules();
    const { ticker } = req.params;
    const { depth = 10 } = req.query;
    if (!ticker) return res.status(400).json({ error: 'Ticker is required' });

    const keys = await readJson('keys.json');
    if (!requireKeys(keys, res)) return;

    const orderbook = await kalshiAdapters.api.getOrderbook(keys, ticker, parseInt(depth));
    res.json(orderbook);
  }));

  // ====== PRICE CACHE ROUTES ======

  app.get('/api/kalshi/prices', asyncHandler(async (req, res) => {
    loadModules();
    const prices = kalshiPriceService.getAllCachedPrices();
    const stats = kalshiPriceService.getCacheStats();
    res.json({ prices, stats });
  }));

  app.get('/api/kalshi/prices/:ticker', asyncHandler(async (req, res) => {
    loadModules();
    const { ticker } = req.params;
    if (!ticker) return res.status(400).json({ error: 'Ticker is required' });

    const cached = kalshiPriceService.getCachedPrice(ticker);
    if (!cached) {
      kalshiPriceService.subscribeTicker(ticker);
      return res.json({ ticker, cached: null, subscribed: true });
    }
    res.json({ ticker, ...cached });
  }));

  app.post('/api/kalshi/prices/subscribe', asyncHandler(async (req, res) => {
    loadModules();
    const { tickers } = req.body;
    if (!tickers || !Array.isArray(tickers)) return res.status(400).json({ error: 'Tickers array is required' });

    kalshiPriceService.subscribeMany(tickers);
    log('INFO', `[${ts()}] 📊 Subscribed to ${tickers.length} Kalshi tickers via API`);
    res.json({ success: true, subscribed: tickers });
  }));

  // ====== POSITIONS ROUTES ======

  app.get('/api/kalshi/positions', asyncHandler(async (req, res) => {
    loadModules();
    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    if (config.dryRun) {
      const state = await readJson('state-dry-run.json');
      return res.json({ positions: state.positions || [] });
    }

    if (!requireKeys(keys, res)) return;

    const positionsData = await kalshiAdapters.api.getPositions(keys, { settlement_status: 'unsettled' });
    res.json({ positions: positionsData.market_positions || [] });
  }));

  // ====== ORDER ROUTES ======

  app.post('/api/kalshi/order', asyncHandler(async (req, res) => {
    loadModules();
    const { ticker, side, action, count, type = 'limit', price } = req.body;

    if (!ticker) return res.status(400).json({ error: 'Ticker is required' });
    if (!side || !['yes', 'no'].includes(side)) return res.status(400).json({ error: 'Side must be yes or no' });
    if (!action || !['buy', 'sell'].includes(action)) return res.status(400).json({ error: 'Action must be buy or sell' });
    if (!count || count < 1) return res.status(400).json({ error: 'Count must be at least 1' });
    if (type === 'limit' && (!price || price < 1 || price > 99)) return res.status(400).json({ error: 'Limit price must be 1-99' });

    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    if (config.dryRun) {
      const state = await readJson('state-dry-run.json');
      const orderId = `dry-${Date.now()}`;
      const simulatedOrder = {
        order_id: orderId, ticker, side, action, count, type, price,
        status: 'filled', created_time: new Date().toISOString(),
      };

      if (action === 'buy') {
        const cost = count * (price || 50);
        state.balance = state.balance || { available: 10000, inPositions: 0 };
        state.balance.available -= cost / 100;
        state.balance.inPositions += cost / 100;
        state.positions = state.positions || [];
        state.positions.push({
          ticker, side, contracts: count, avgCost: price || 50,
          metadata: { strategy: 'manual' },
        });
      }

      state.todayStats = state.todayStats || { trades: 0, wins: 0, pnl: 0 };
      state.todayStats.trades++;
      state.trades = state.trades || [];
      state.trades.push(simulatedOrder);
      state.lastUpdated = new Date().toISOString();

      await writeJson('state-dry-run.json', state);
      log('INFO', `[${ts()}] 📝 Kalshi dry-run ${action} ${count}x ${side.toUpperCase()} on ${ticker} @ ${price || 'market'}`);
      return res.json({ order: simulatedOrder });
    }

    if (!requireKeys(keys, res)) return;

    const order = { ticker, side, action, count, type, client_order_id: `cm-${Date.now()}` };
    if (type === 'limit') {
      if (side === 'yes') order.yes_price = price;
      else order.no_price = price;
    }

    const result = await kalshiAdapters.api.placeOrder(keys, order);
    log('INFO', `[${ts()}] 📝 Kalshi ${action} ${count}x ${side.toUpperCase()} on ${ticker} - order ${result.order?.order_id}`);
    res.json({ order: result.order });
  }));

  app.delete('/api/kalshi/order/:id', asyncHandler(async (req, res) => {
    loadModules();
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Order ID is required' });

    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    if (config.dryRun) {
      log('INFO', `[${ts()}] ❌ Kalshi dry-run cancelled order ${id}`);
      return res.json({ success: true });
    }

    if (!requireKeys(keys, res)) return;

    await kalshiAdapters.api.cancelOrder(keys, id);
    log('INFO', `[${ts()}] ❌ Kalshi cancelled order ${id}`);
    res.json({ success: true });
  }));

  // ====== ALERTS ROUTES ======

  app.get('/api/kalshi/alerts', asyncHandler(async (req, res) => {
    loadModules();
    res.json({ alerts: alertService.getRecentAlerts() });
  }));

  // ====== ANALYSES ROUTES ======

  app.get('/api/kalshi/analyses/:date', asyncHandler(async (req, res) => {
    loadModules();
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date must be YYYY-MM-DD format' });
    }
    const analyses = await tradeAnalyst.readAnalyses(date);
    res.json({ analyses, total: analyses.length });
  }));

  // ====== ACCOUNT RECONCILIATION ROUTES ======

  app.get('/api/kalshi/account/reconcile', asyncHandler(async (req, res) => {
    loadModules();
    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);
    if (!requireKeys(keys, res)) return;

    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    const report = await accountReconciliation.reconcile(kalshiAdapters.api, keys, state);
    res.json(report);
  }));

  app.post('/api/kalshi/account/reconcile', asyncHandler(async (req, res) => {
    loadModules();
    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);
    if (!requireKeys(keys, res)) return;

    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    const report = await accountReconciliation.reconcile(kalshiAdapters.api, keys, state);
    const corrected = accountReconciliation.applyCorrections(state, report);
    await writeJson(stateFile, corrected);

    log('INFO', `[${ts()}] ✅ Reconciliation applied: adjustment=$${report.summary.totalAdjustment.toFixed(2)}`);
    res.json({ success: true, report });
  }));

  // ====== ENGINE ROUTES ======

  app.get('/api/kalshi/engine/status', asyncHandler(async (req, res) => {
    loadModules();
    const config = await readJson('config.json');
    const state = await readJson(config.dryRun ? 'state-dry-run.json' : 'state.json');
    const engineStatus = simulationEngine?.getStatus?.() ?? {};
    const priceStats = kalshiPriceService?.getCacheStats?.() ?? {};
    res.json({
      running: state.engineRunning,
      mode: config.dryRun ? 'dry_run' : 'live',
      enabled: config.enabled,
      marketsTracked: trackedMarketTickers.length,
      trackedTickers: trackedMarketTickers,
      priceCache: priceStats,
      ...engineStatus,
    });
  }));

  app.get('/api/kalshi/engine/windows', asyncHandler(async (req, res) => {
    loadModules();
    res.json({ summaries: simulationEngine?.getWindowSummaries?.() ?? [] });
  }));

  /**
   * Core engine start logic
   */
  const startEngine = async () => {
    loadModules();
    const [keys, config] = await Promise.all([
      readJson('keys.json'),
      readJson('config.json'),
    ]);

    // Initialize alert service
    alertService.initAlertService({ webhookUrl: config.alerts?.webhookUrl, io });

    // Initialize trade analyst service
    tradeAnalyst.initTradeAnalyst({
      io,
      onConfigChange: (strategyName, strategyConfig) => {
        simulationEngine?.updateStrategy?.(strategyName, strategyConfig);
      }
    });

    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    // Fetch available crypto markets
    let cryptoMarkets = [];
    if (keys.keyId && keys.privateKeyPem && config.markets?.crypto?.enabled !== false) {
      log('INFO', `[${ts()}] 🔍 Fetching crypto markets for Kalshi engine...`);
      const marketConfig = config.markets?.crypto || { assets: ['BTC'], timeframes: ['15min'] };
      cryptoMarkets = await kalshiAdapters.markets.getCryptoMarkets(keys, marketConfig);
      log('INFO', `[${ts()}] 📊 Found ${cryptoMarkets.length} crypto markets to track`);
    }

    // Initialize Kalshi price service (connects Kalshi WebSocket for contract prices)
    await kalshiPriceService.initPriceService(io, (ticker, price) => {
      simulationEngine?.onPriceUpdate?.(ticker, price);
    });

    // Initialize orderbook service and wire to the Kalshi WebSocket
    kalshiOrderbookService.initKalshiOrderBookService(io, (ticker, metrics) => {
      simulationEngine?.onKalshiOrderBookMetrics?.(ticker, metrics);
    });
    const kalshiWsForOb = kalshiPriceService.getWsClient?.();
    if (kalshiWsForOb) {
      kalshiOrderbookService.connectToWebSocket(kalshiWsForOb);
    }

    trackedMarketTickers = cryptoMarkets.map(m => m.ticker);
    if (trackedMarketTickers.length > 0) {
      kalshiPriceService.subscribeMany(trackedMarketTickers);
      trackedMarketTickers.forEach(t => kalshiOrderbookService.subscribeTicker(t));
      simulationEngine.setMarketsInfo(cryptoMarkets);
      const earliest = cryptoMarkets[0]?.close_time?.slice(11, 16);
      const latest = cryptoMarkets[cryptoMarkets.length - 1]?.close_time?.slice(11, 16);
      log('INFO', `[${ts()}] 📡 Subscribed to ${trackedMarketTickers.length} markets (${earliest} to ${latest} UTC)`);
    } else {
      log('WARN', `[${ts()}] ⚠️ No crypto markets found - engine will wait for price data`);
    }

    // Initialize live execution when not in dry-run
    let liveExec = null;
    if (!config.dryRun && keys.keyId && keys.privateKeyPem) {
      liveExec = liveExecutionService.initLiveExecution(keys, config, {
        onFill: (fill) => {
          log('INFO', `[${ts()}] 📬 Kalshi live fill: ${fill.action} ${fill.count}x ${fill.side} ${fill.ticker} @ ${fill.price}¢`);
          simulationEngine.applyFill(fill).catch(err =>
            log('ERROR', `[${ts()}] ❌ applyFill error: ${err.message}`)
          );
        },
        onError: (err, context) => {
          log('ERROR', `[${ts()}] ❌ Kalshi live execution error: ${err.message}`);
          alertService.sendAlert('warning', 'Live execution error', { error: err.message, ticker: context?.ticker });
          if (context?.ticker) {
            simulationEngine.pendingReservations?.delete(context.ticker);
            simulationEngine.tradeCooldowns?.set(context.ticker, Date.now() + 300_000);
          }
        },
      });

      const kalshiWs = kalshiPriceService.getWsClient?.();
      if (kalshiWs) {
        liveExecutionService.connectToWebSocket(kalshiWs);
        trackedMarketTickers.forEach(ticker => kalshiWs.subscribeFills?.(ticker));
      }
      log('INFO', `[${ts()}] 🔴 Kalshi live execution service ready`);
    }

    // Initialize simulation engine (drop strategy-review-service references)
    simulationEngine.init(config, state, {
      liveExecution: liveExec,
      saveState: async (newState) => {
        await writeJson(stateFile, newState);
      },
      onTrade: (trade) => {
        log('INFO', `[${ts()}] 📈 Kalshi trade: ${trade.action} ${trade.count}x ${trade.side} ${trade.ticker}`);
        if (io) {
          io.emit('kalshi:trade', trade);
          const currentState = simulationEngine.state;
          if (currentState) {
            io.emit('kalshi:balance', currentState.balance);
            io.emit('kalshi:positions', currentState.positions);
            io.emit('kalshi:stats', currentState.todayStats);
          }
        }
        // strategy-review-service dropped (was: onTradeCompleted(trade))
      },
      onStateChange: (newState) => {
        if (io && newState) {
          io.emit('kalshi:balance', newState.balance);
          io.emit('kalshi:positions', newState.positions);
          io.emit('kalshi:stats', newState.todayStats);
        }
      },
      onLog: (logEntry) => {
        if (io) io.emit('kalshi:log', logEntry);
      },
      onWindowSummary: async (summary) => {
        if (io) io.emit('kalshi:window-summary', summary);

        // Auto-tuner: check if parameters need adjustment after each window
        if (!autoTunerModule) return;
        const tuner = autoTunerModule.autoTuner;
        if (!tuner.enabled) return;

        const currentState = simulationEngine.state;
        const sells = (currentState?.trades || []).filter(t => t.action === 'sell' || t.action === 'settlement');
        if (sells.length < 10) return;

        const totalPnl = sells.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const wins = sells.filter(t => (t.pnl || 0) > 0).length;
        const byReason = {};
        for (const t of sells) {
          const reason = t.action === 'settlement'
            ? (t.pnl > 0 ? 'Settlement (win)' : 'Settlement (loss)')
            : (t.reason?.split(':')[0]?.trim() || 'unknown');
          if (!byReason[reason]) byReason[reason] = { count: 0, pnl: 0 };
          byReason[reason].count++;
          byReason[reason].pnl += t.pnl || 0;
        }

        const analytics = {
          summary: {
            totalTrades: sells.length,
            totalPnl,
            winRate: (wins / sells.length) * 100,
            avgPnl: totalPnl / sells.length,
          },
          byReason,
        };

        const currentConfig = await readJson('config.json');
        const strategies = currentConfig.strategies || {};

        const result = await tuner.check(analytics, strategies, async (updatedStrategies) => {
          currentConfig.strategies = updatedStrategies;
          await writeJson('config.json', currentConfig);
          for (const [name, strat] of Object.entries(updatedStrategies)) {
            simulationEngine.updateStrategy(name, strat);
          }
          log('INFO', `[${ts()}] 🤖 Auto-tuner applied adjustments`);
          if (io) io.emit('kalshi:auto-tune', { adjusted: true, timestamp: Date.now() });
        });

        if (result) {
          log('INFO', `[${ts()}] 🤖 Auto-tune: ${result.suggestion.message} → ${result.suggestion.recommendation}`);
        }
      },
    });

    // Restore daily P&L
    if (!config.dryRun && state.todayStats?.pnl) {
      liveExecutionService.setDailyPnl(state.todayStats.pnl);
    }

    simulationEngine.start(5000);

    // Wire exchange aggregator composite prices to the simulation engine
    setCompositeCallback((ticker, composite) => {
      simulationEngine?.onCompositeUpdate?.(ticker, composite);
    });

    scheduleSettlementRefresh();

    if (marketRefreshTimer) clearInterval(marketRefreshTimer);
    marketRefreshTimer = setInterval(() => {
      refreshMarkets().catch(err => log('WARN', `[${ts()}] ⚠️ Fallback refresh failed: ${err.message}`));
    }, 300_000);

    if (io && state) {
      io.emit('kalshi:balance', state.balance);
      io.emit('kalshi:positions', state.positions);
      io.emit('kalshi:stats', state.todayStats);
    }

    state.engineRunning = true;
    state.lastUpdated = new Date().toISOString();
    await writeJson(stateFile, state);

    const mode = config.dryRun ? 'dry-run' : 'live';
    log('INFO', `[${ts()}] 🚀 Kalshi engine started in ${mode} mode`);
    return { success: true, mode, marketsTracked: trackedMarketTickers.length };
  };

  app.post('/api/kalshi/engine/start', asyncHandler(async (req, res) => {
    const result = await startEngine();
    res.json({
      ...result,
      status: 'running',
      markets: trackedMarketTickers.slice(0, 10),
    });
  }));

  app.post('/api/kalshi/engine/stop', asyncHandler(async (req, res) => {
    loadModules();
    const config = await readJson('config.json');
    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    simulationEngine.stop();
    setCompositeCallback(null);

    if (!config.dryRun) {
      liveExecutionService.shutdownLiveExecution();
    }

    if (kalshiOrderbookService) {
      kalshiOrderbookService.shutdownKalshiOrderBookService();
    }

    if (marketRefreshTimer) {
      clearInterval(marketRefreshTimer);
      marketRefreshTimer = null;
    }

    if (nextSettlementTimer) {
      clearTimeout(nextSettlementTimer);
      nextSettlementTimer = null;
    }

    const stoppedTickers = trackedMarketTickers.length;
    trackedMarketTickers = [];

    state.engineRunning = false;
    state.lastUpdated = new Date().toISOString();
    await writeJson(stateFile, state);

    log('INFO', `[${ts()}] 🛑 Kalshi engine stopped (was tracking ${stoppedTickers} markets)`);
    res.json({ success: true, stoppedTickers });
  }));

  app.post('/api/kalshi/engine/dry-run/reset', asyncHandler(async (req, res) => {
    loadModules();
    simulationEngine.stop();
    if (marketRefreshTimer) { clearInterval(marketRefreshTimer); marketRefreshTimer = null; }
    trackedMarketTickers = [];

    const keys = await readJson('keys.json');
    let startingBalance = 10000;
    if (keys.keyId && keys.privateKeyPem) {
      const accountData = await kalshiAccountCache.getAccountData(keys, true);
      if (accountData.balance?.available) {
        startingBalance = accountData.balance.available;
      }
    }

    const initialState = {
      engineRunning: false,
      mode: 'dry_run',
      balance: { available: startingBalance, inPositions: 0 },
      positions: [],
      todayStats: { trades: 0, wins: 0, pnl: 0 },
      trades: [],
      lastUpdated: new Date().toISOString(),
    };
    await writeJson('state-dry-run.json', initialState);
    log('INFO', `[${ts()}] 🔄 Kalshi dry-run state reset to $${startingBalance.toFixed(2)}`);
    res.json({ success: true, state: initialState });
  }));

  // ====== POLYMARKET SENTIMENT ROUTES ======

  app.get('/api/kalshi/polymarket', asyncHandler(async (req, res) => {
    loadModules();
    const { rangeStart, rangeEnd } = req.query;
    const history = rangeStart && rangeEnd
      ? polymarketPriceService.getWindowsInRange(parseInt(rangeStart), parseInt(rangeEnd))
      : { settled: polymarketPriceService.getWindowHistory(20), live: null };

    res.json({
      sentiment: polymarketPriceService.getCurrentSentiment(),
      status: polymarketPriceService.getStatus(),
      history,
    });
  }));

  // ====== CONVICTION TRACKER ROUTES ======

  app.get('/api/kalshi/conviction', asyncHandler(async (req, res) => {
    loadModules();
    const stats = await convictionTracker.getConvictionStats();
    res.json(stats);
  }));

  app.get('/api/kalshi/conviction/records', asyncHandler(async (req, res) => {
    loadModules();
    const records = await convictionTracker.getCompletedRecords();
    const limit = parseInt(req.query.limit) || 100;
    res.json({ records: records.slice(-limit).reverse(), total: records.length });
  }));

  // ====== ANALYTICS ROUTES ======

  app.get('/api/kalshi/analytics', asyncHandler(async (req, res) => {
    const config = await readJson('config.json');
    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);

    const trades = state.trades || [];
    const buys = trades.filter(t => t.action === 'buy');
    const sells = trades.filter(t => t.action === 'sell' || t.action === 'settlement');

    const byStrategy = {};
    for (const trade of sells) {
      const strat = trade.strategy || 'unknown';
      if (!byStrategy[strat]) {
        byStrategy[strat] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, avgPnl: 0, winRate: 0 };
      }
      byStrategy[strat].trades++;
      byStrategy[strat].pnl += trade.pnl || 0;
      byStrategy[strat].fees += trade.fee || 0;
      if ((trade.pnl || 0) > 0) byStrategy[strat].wins++;
      else byStrategy[strat].losses++;
    }

    for (const strat of Object.keys(byStrategy)) {
      const s = byStrategy[strat];
      s.avgPnl = s.trades > 0 ? s.pnl / s.trades : 0;
      s.winRate = s.trades > 0 ? (s.wins / s.trades) * 100 : 0;
    }

    const byReason = {};
    for (const trade of sells) {
      const reason = trade.action === 'settlement'
        ? (trade.pnl > 0 ? 'Settlement (win)' : 'Settlement (loss)')
        : (trade.reason?.split(':')[0]?.trim() || 'unknown');
      if (!byReason[reason]) byReason[reason] = { count: 0, pnl: 0, avgPnl: 0 };
      byReason[reason].count++;
      byReason[reason].pnl += trade.pnl || 0;
    }
    for (const reason of Object.keys(byReason)) {
      byReason[reason].avgPnl = byReason[reason].count > 0 ? byReason[reason].pnl / byReason[reason].count : 0;
    }

    const tradeLimit = parseInt(req.query.limit) || 50;
    const recentTrades = trades.slice(-tradeLimit).reverse();

    const totalPnl = sells.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalWins = sells.filter(t => (t.pnl || 0) > 0).length;
    const totalLosses = sells.filter(t => (t.pnl || 0) <= 0).length;
    const winRate = sells.length > 0 ? (totalWins / sells.length) * 100 : 0;
    const avgPnl = sells.length > 0 ? totalPnl / sells.length : 0;

    const entryFees = buys.reduce((sum, t) => sum + (t.fee || 0), 0);
    const exitFees = sells.reduce((sum, t) => sum + (t.fee || 0), 0);
    const totalFees = entryFees + exitFees;

    res.json({
      summary: {
        totalTrades: sells.length,
        openPositions: buys.length - sells.length,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        winRate: parseFloat(winRate.toFixed(1)),
        avgPnl: parseFloat(avgPnl.toFixed(2)),
        wins: totalWins,
        losses: totalLosses,
        totalFees: parseFloat(totalFees.toFixed(2)),
        entryFees: parseFloat(entryFees.toFixed(2)),
        exitFees: parseFloat(exitFees.toFixed(2)),
      },
      byStrategy,
      byReason,
      recentTrades,
      balance: state.balance,
      todayStats: state.todayStats,
      executionTelemetry: liveExecutionService?.getExecutionTelemetry?.() ?? {},
    });
  }));

  // ====== AUTO-TUNING ROUTES ======

  app.get('/api/kalshi/auto-tune/status', asyncHandler(async (req, res) => {
    loadModules();
    // Sync auto-tuner state from persisted config on first status check
    if (!autoTunerModule.autoTuner._configSynced) {
      const config = await readJson('config.json');
      if (config.autoTune?.enabled) autoTunerModule.autoTuner.enable();
      autoTunerModule.autoTuner._configSynced = true;
    }
    res.json({
      enabled: autoTunerModule.autoTuner.enabled,
      lastAdjustment: autoTunerModule.autoTuner.lastAdjustment,
      adjustmentCount: autoTunerModule.autoTuner.adjustmentCount,
    });
  }));

  app.post('/api/kalshi/auto-tune/enable', asyncHandler(async (req, res) => {
    loadModules();
    autoTunerModule.autoTuner.enable();
    const config = await readJson('config.json');
    config.autoTune = { ...config.autoTune, enabled: true };
    await writeJson('config.json', config);
    res.json({ success: true, enabled: true });
  }));

  app.post('/api/kalshi/auto-tune/disable', asyncHandler(async (req, res) => {
    loadModules();
    autoTunerModule.autoTuner.disable();
    const config = await readJson('config.json');
    config.autoTune = { ...config.autoTune, enabled: false };
    await writeJson('config.json', config);
    res.json({ success: true, enabled: false });
  }));

  // ====== STRATEGIES ROUTES ======

  app.get('/api/kalshi/strategies', asyncHandler(async (req, res) => {
    loadModules();
    const config = await readJson('config.json');
    const defaults = strategyIndex.getDefaultStrategyConfigs();
    const strategies = { ...defaults, ...(config.strategies || {}) };

    const strategiesWithInfo = {};
    for (const [name, strat] of Object.entries(strategies)) {
      strategiesWithInfo[name] = {
        ...strat,
        info: strategyIndex.STRATEGY_INFO[name] || { name, description: '', type: 'unknown' },
      };
    }

    res.json({ success: true, strategies: strategiesWithInfo });
  }));

  app.get('/api/kalshi/strategies/:name', asyncHandler(async (req, res) => {
    loadModules();
    const { name } = req.params;
    if (!name) return res.status(400).json({ error: 'Strategy name is required' });

    const config = await readJson('config.json');
    const defaults = strategyIndex.getDefaultStrategyConfigs();
    const strategy = config.strategies?.[name] || defaults[name];
    if (!strategy) return res.status(404).json({ error: `Strategy '${name}' not found` });

    res.json({
      success: true,
      name,
      ...strategy,
      info: strategyIndex.STRATEGY_INFO[name] || {},
    });
  }));

  app.put('/api/kalshi/strategies/:name', asyncHandler(async (req, res) => {
    loadModules();
    const { name } = req.params;
    if (!name) return res.status(400).json({ error: 'Strategy name is required' });

    const { value: validated, errors } = validateConfigUpdate(STRATEGY_CONFIG_SCHEMA, req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const config = await readJson('config.json');
    config.strategies = config.strategies || {};
    config.strategies[name] = { ...config.strategies[name], ...validated };
    await writeJson('config.json', config);

    simulationEngine.updateStrategy(name, config.strategies[name]);

    log('INFO', `[${ts()}] ⚙️ Kalshi strategy '${name}' updated: enabled=${config.strategies[name].enabled}`);
    res.json({ success: true, name, ...config.strategies[name] });
  }));

  // ====== HEALTH REPORT ======

  app.get('/api/kalshi/health-report', asyncHandler(async (req, res) => {
    loadModules();
    const config = await readJson('config.json');
    const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
    const state = await readJson(stateFile);
    const engineStatus = simulationEngine?.getStatus?.() ?? {};
    const telemetry = liveExecutionService?.getExecutionTelemetry?.() ?? {};
    const convictionStats = convictionTracker?.getConvictionStats?.() ?? {};

    const now = new Date();
    const mode = config.dryRun ? 'dry_run' : 'live';

    const trades = state.trades || [];
    const settlements = trades.filter(t => t.action === 'settlement');
    const strategyStats = {};
    for (const trade of settlements) {
      const strat = trade.strategy || 'unknown';
      if (!strategyStats[strat]) strategyStats[strat] = { trades: 0, wins: 0, losses: 0, pnl: 0, totalCost: 0 };
      strategyStats[strat].trades++;
      strategyStats[strat].pnl += trade.pnl || 0;
      strategyStats[strat].totalCost += Math.abs(trade.costBasis || 0);
      if ((trade.pnl || 0) > 0) strategyStats[strat].wins++;
      else strategyStats[strat].losses++;
    }
    for (const stats of Object.values(strategyStats)) {
      stats.winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
      stats.roi = stats.totalCost > 0 ? stats.pnl / stats.totalCost : 0;
    }

    const enabledStrategies = Object.entries(config.strategies || {})
      .filter(([, s]) => s.enabled)
      .map(([name]) => name);

    const maxDailyLoss = config.risk?.maxDailyLoss || 500;
    const todayPnl = state.todayStats?.pnl || 0;
    const todayTrades = state.todayStats?.trades || 0;
    const todayWins = state.todayStats?.wins || 0;
    const todayWinRate = todayTrades > 0 ? todayWins / todayTrades : 0;

    const alerts = [];
    if (!state.engineRunning) alerts.push({ level: 'critical', message: 'Engine is not running' });
    if (todayPnl < 0 && Math.abs(todayPnl) > maxDailyLoss * 0.5) alerts.push({ level: 'warning', message: `Daily P&L approaching circuit breaker` });
    if (todayPnl <= -maxDailyLoss) alerts.push({ level: 'critical', message: `Circuit breaker triggered` });

    const criticalAlerts = alerts.filter(a => a.level === 'critical').length;
    const warningAlerts = alerts.filter(a => a.level === 'warning').length;
    const health = criticalAlerts > 0 ? 'critical' : warningAlerts > 0 ? 'degraded' : 'healthy';

    res.json({
      health,
      timestamp: now.toISOString(),
      engine: {
        running: state.engineRunning,
        mode,
        marketsTracked: trackedMarketTickers.length,
        enabledStrategies,
      },
      balance: {
        available: state.balance?.available || 0,
        inPositions: state.balance?.inPositions || 0,
        openPositions: state.positions?.length || 0,
      },
      today: { trades: todayTrades, wins: todayWins, winRate: todayWinRate, pnl: todayPnl },
      strategyPerformance: strategyStats,
      risk: {
        maxDailyLoss,
        currentDailyPnl: todayPnl,
        circuitBreakerTriggered: todayPnl <= -maxDailyLoss,
      },
      execution: {
        avgSlippage: telemetry.avgSlippage || 0,
        totalFills: telemetry.fillCount || 0,
      },
      conviction: convictionStats,
      alerts,
    });
  }));

  // ====== PRICE BRIDGE & EXCHANGE AGGREGATOR ======
  // Initialize at route mount time so the UI gets price data even before the engine starts.
  const { createPriceBridge } = require('../kalshi/services/price-bridge');
  const { initAggregator, onExchangeUpdate, setCompositeCallback } = require('../kalshi/services/exchange-aggregator');

  initAggregator(io);

  const priceBridge = createPriceBridge(io, {
    onPriceUpdate: (ticker, price, data) => {
      // Feed into exchange aggregator for composite price (source, ticker, price, data)
      onExchangeUpdate('coinbase', ticker, price, data);
      // Emit coinbase:price for the useCoinbaseSocket hook
      io.to('coinbase').emit('coinbase:price', { ticker, ...data });
    },
  });
  priceBridge.start();

  // Gemini public WebSocket for a second price source
  const { createGeminiWebSocketFeed } = require('../adapters/gemini/websocket');
  const geminiWs = createGeminiWebSocketFeed('kalshi-gemini', {
    productId: 'BTC-USD',
    onTicker: (data) => {
      const ticker = 'BTC-USD';
      const update = {
        ticker,
        price: data.price,
        bid: data.bid,
        ask: data.ask,
        volume24h: data.volume24h || 0,
        previousPrice: data.price,
        priceChange: 0,
        updatedAt: Date.now(),
      };
      onExchangeUpdate('gemini', ticker, data.price, update);
      io.to('gemini').emit('gemini:price', update);
    },
  });
  geminiWs.connect();

  // Crypto.com public WebSocket for a third price source
  const { createCryptocomWebSocketFeed } = require('../adapters/cryptocom/websocket');
  const cryptocomWs = createCryptocomWebSocketFeed('kalshi-cryptocom', {
    productId: 'BTC-USD',
    onTicker: (data) => {
      const ticker = 'BTC-USD';
      const update = {
        ticker,
        price: data.price,
        bid: data.bid,
        ask: data.ask,
        volume24h: data.volume24h || 0,
        previousPrice: data.price,
        priceChange: 0,
        updatedAt: Date.now(),
      };
      onExchangeUpdate('cryptocom', ticker, data.price, update);
      io.to('cryptocom').emit('cryptocom:price', update);
    },
  });
  cryptocomWs.connect();

  // ====== SOCKET.IO KALSHI EVENTS ======

  io.on('connection', (socket) => {
    // Join kalshi rooms on request
    socket.on('kalshi:join', () => {
      socket.join('kalshi');
      socket.join('kalshi:coinbase');
    });

    socket.on('kalshi:leave', () => {
      socket.leave('kalshi');
      socket.leave('kalshi:coinbase');
    });

    // useCoinbaseSocket hook emits this on connect
    socket.on('coinbase:subscribe', () => socket.join('coinbase'));
    socket.on('coinbase:unsubscribe', () => socket.leave('coinbase'));

    // useCompositeSocket hook emits this on connect
    socket.on('composite:subscribe', () => socket.join('composite'));

    // Gemini + Crypto.com socket rooms
    socket.on('gemini:subscribe', () => socket.join('gemini'));
    socket.on('gemini:unsubscribe', () => socket.leave('gemini'));
    socket.on('cryptocom:subscribe', () => socket.join('cryptocom'));
    socket.on('cryptocom:unsubscribe', () => socket.leave('cryptocom'));
  });

  // Return autoStartEngine for server.js to call on boot
  return {
    autoStartEngine: async () => {
      const config = await readJson('config.json');
      const stateFile = config.dryRun ? 'state-dry-run.json' : 'state.json';
      const state = await readJson(stateFile);

      if (!state.engineRunning) {
        log('INFO', `[${ts()}] ⏸️ Kalshi engine not auto-started (was stopped before restart)`);
        return;
      }

      log('INFO', `[${ts()}] 🔄 Auto-starting Kalshi engine (was running before server restart)...`);
      await startEngine();
    },
    getEngineStatus: () => ({
      engineRunning: simulationEngine?.state?.engineRunning ?? false,
    }),
    shutdown: () => {
      // Preserve engineRunning=true so the engine auto-starts after pm2 restart.
      if (simulationEngine) {
        simulationEngine.stop({ preserveRunningFlag: true });
      }
      if (marketRefreshTimer) {
        clearInterval(marketRefreshTimer);
        marketRefreshTimer = null;
      }
      if (nextSettlementTimer) {
        clearTimeout(nextSettlementTimer);
        nextSettlementTimer = null;
      }
      if (liveExecutionService) {
        liveExecutionService.shutdownLiveExecution();
      }
      if (kalshiOrderbookService) {
        kalshiOrderbookService.shutdownKalshiOrderBookService();
      }
      log('INFO', `[${ts()}] 🛑 Kalshi services shut down`);
    },
  };
};
