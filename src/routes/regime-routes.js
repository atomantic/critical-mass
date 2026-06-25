// @ts-check
/**
 * Regime Engine API Routes (Gateway Proxy)
 *
 * Forwards regime engine commands and queries to the Coinbase engine
 * process via IPC WebSocket. Config reads/writes stay local (file-based).
 */

const fs = require('fs');
const path = require('path');
const { getRegimeConfig, updateRegimeConfig, updateFundConfig, validateRegimeConfig, getFundConfig, getDefaultPair } = require('../config-utils');
const { loadRegimeState, LIFECYCLE } = require('../state-tracker');
const { resolveFundDataDir } = require('../migration');
const { calculateApyMetrics } = require('../apy-calculator');
const celestialHierarchy = require('../celestial-hierarchy');
const { log } = require('../logger');

// Fields that live on the fund/exchange block (siblings of `regime`), NOT inside
// the regime sub-block. GET sources these from getFundConfig, so a PUT must
// persist them via updateFundConfig — routing them through updateRegimeConfig
// would nest them under `regime.*` where GET never reads them (the "dry-run
// toggle resets on refresh" bug).
const FUND_LEVEL_FIELDS = ['dryRun', 'productId'];

// The config view the client sees: regime fields plus the fund-level fields
// pulled from the fund block. GET and PUT both return this, so keep it in one
// place — adding a FUND_LEVEL_FIELD updates every consumer at once.
const buildClientConfig = (exchange, pair) => {
  const regimeConfig = getRegimeConfig(exchange, pair);
  const fundConfig = getFundConfig(exchange, pair);
  const config = { ...regimeConfig };
  for (const field of FUND_LEVEL_FIELDS) config[field] = fundConfig[field];
  return config;
};

/**
 * Best-effort last market price from disk for the offline route fallback.
 * Reads the most recent fill from fill-ledger.json. Stale (engine has been
 * down for some time) but better than 0 — without this, APY's BTC component
 * shows zero until the engine restarts, and on a hard browser refresh
 * (which uses fetch as full replacement) the APY/capital panels would be
 * blank because the dashboard doesn't have a prior socket snapshot to merge.
 */
const lastPriceFromLedger = (dataDir) => {
  const ledgerPath = path.join(dataDir, 'fill-ledger.json');
  if (!fs.existsSync(ledgerPath)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const fills = Array.isArray(raw) ? raw : (raw.fills || []);
    let latest = null;
    for (const f of fills) {
      if (!latest || (f.timestamp || 0) > (latest.timestamp || 0)) latest = f;
    }
    return Number(latest?.price) || 0;
  } catch {
    return 0;
  }
};

/** Convert IPC connection errors to standard response */
const engineError = (err) => ({ success: false, error: `Engine unavailable: ${err.message}` });

/**
 * Read-only status synthesized from disk for when the engine IPC is dead.
 * Returns null when there's no persisted state to fall back on, so a true
 * IPC outage (e.g., first-time fund or broken connection with no saved
 * data) still surfaces as 503 rather than masking as a stopped engine.
 */
const buildOfflineStatus = (exchange, pair) => {
  // loadRegimeState returns an initial empty state when no file exists, so
  // checking the return value isn't enough — verify the file is on disk first.
  const dataDir = resolveFundDataDir(exchange, pair);
  const stateFile = path.join(dataDir, 'regime-state.json');
  if (!fs.existsSync(stateFile)) return null;

  let rs;
  try {
    rs = loadRegimeState(exchange, pair);
  } catch {
    return null;
  }
  const position = rs.position || {};
  const bodies = position.celestialBodies || [];
  const config = getRegimeConfig(exchange, pair);
  // Use the most recent fill price as a stale-but-reasonable last price.
  // A hard refresh uses fetch as full replacement (no socket snapshot to
  // merge with), so omitting apy would leave capital/APY panels blank.
  const lastPrice = lastPriceFromLedger(dataDir);

  // Re-derive from the ledger — a stopped engine leaves stale values on disk.
  try {
    const { getCachedFillLedger } = require('../fill-ledger');
    const productId = config.productId || pair;
    // Read-only, cached (#183): the offline fallback fires on every status poll
    // while the engine is unreachable; without caching each poll re-parses the
    // whole multi-MB ledger on the gateway event loop.
    const fl = getCachedFillLedger(exchange, productId, pair);
    const derived = fl.getDerivedRealizedPnL();
    position.realizedPnL = derived.realizedPnL;
    position.realizedAssetPnL = derived.realizedAssetPnL;
    position.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
  } catch (e) {
    // logger exports a plain function — log.warn is undefined and would itself
    // throw, turning the corrupt-ledger fallback into a 500 exactly when it's
    // needed (issue #110 M5).
    log('WARN', `[${exchange}/${pair}] offline cycle-pair derivation failed: ${e.message}`);
  }

  return {
    isRunning: false,
    // Distinguish a real IPC outage from a clean operator stop. The dashboard
    // reads health.mode; ENGINE_DOWN signals "the gateway can't reach the
    // engine process" so the operator doesn't think the engine is cleanly
    // halted and take an unsafe control action.
    health: { mode: 'ENGINE_DOWN' },
    engineDown: true,
    position,
    regime: rs.regime || null,
    // Surface the stale price as market.lastPrice too — the live-price
    // banner and cost-basis page read status.market.lastPrice and would
    // otherwise show $0 on a hard refresh during an IPC outage.
    market: { lastPrice, stale: true },
    pendingOrders: celestialHierarchy.buildPersistedPendingOrders(position),
    apy: calculateApyMetrics(position, config, { lastPrice }),
    lifecycle: {
      lifecycle: position.lifecycle || LIFECYCLE.ACTIVE,
      lifecycleChangedAt: position.lifecycleChangedAt || null,
      lifecycleReason: position.lifecycleReason || null,
      lifecycleClosedCycle: position.lifecycleClosedCycle || null,
    },
    celestial: celestialHierarchy.buildCelestialPayload(position, config),
  };
};

/** HTTP status code for error responses */
const errStatus = (result) => result.error?.includes('unavailable') ? 503 : 400;

/**
 * @param {import('express').Express} app
 * @param {{exchangeIPCMap: Object}} deps
 */
module.exports = (app, deps) => {
  const { exchangeIPCMap } = deps;
  const getIPC = (exchange) => exchangeIPCMap[exchange] || exchangeIPCMap.coinbase;
  // Resolve pair from request (?pair= query) defaulting to exchange's default
  const getPair = (req) => req.query?.pair || getDefaultPair(req.params.exchange);

  // ============ Config (file-based, stays in gateway) ============

  app.get('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const config = buildClientConfig(exchange, pair);
    res.json({ success: true, exchange, pair, config });
  });

  app.put('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const updates = req.body;

    const currentConfig = getRegimeConfig(exchange, pair);
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

    // Split fund-level fields (dryRun, productId) from regime updates — they
    // persist on different parts of the config block and are read back from
    // different places (see FUND_LEVEL_FIELDS).
    const fundUpdates = {};
    const regimeUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      (FUND_LEVEL_FIELDS.includes(key) ? fundUpdates : regimeUpdates)[key] = value;
    }

    // Type-guard fund-level fields before persisting. validateRegimeConfig above
    // only checks regime fields, so a malformed fund value would otherwise slip
    // through. dryRun is the dangerous one: the engine reads it with `=== true`,
    // so persisting the string "false" would silently flip the fund to LIVE
    // trading on restart. productId names the traded pair — reject non-strings.
    if ('dryRun' in fundUpdates && typeof fundUpdates.dryRun !== 'boolean') {
      return res.status(400).json({ success: false, errors: ['dryRun must be a boolean'] });
    }
    if ('productId' in fundUpdates && (typeof fundUpdates.productId !== 'string' || !fundUpdates.productId.trim())) {
      return res.status(400).json({ success: false, errors: ['productId must be a non-empty string'] });
    }

    if (Object.keys(fundUpdates).length > 0) {
      updateFundConfig(exchange, pair, fundUpdates);
    }
    if (Object.keys(regimeUpdates).length > 0) {
      updateRegimeConfig(exchange, pair, regimeUpdates);
    }
    log('INFO', `🔧 [${exchange}/${pair}] Config updated (fund: ${Object.keys(fundUpdates).join(',') || 'none'}, regime: ${Object.keys(regimeUpdates).join(',') || 'none'})`);

    // Notify engine of config change (fire-and-forget) — forward the full
    // update set so the running engine picks up dryRun changes too.
    getIPC(exchange).request('regime:update-config', updates, exchange, pair).catch(() => {});

    // Return the merged view GET would produce, so the client reflects both
    // fund-level and regime changes immediately.
    const config = buildClientConfig(exchange, pair);

    res.json({ success: true, exchange, pair, config });
  });

  // ============ Engine Commands (forwarded via IPC) ============

  app.get('/api/:exchange/regime/status', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:status', {}, exchange, pair).catch(engineError);
    if (!result.success) {
      // Engine unreachable: serve a read-only status from disk so the dashboard
      // keeps showing persisted body TPs (and doesn't flag those bodies' buys
      // as orphans just because pendingOrders is empty).
      // Skip the fallback for request timeouts — the engine process is likely
      // still alive but slow, and reporting it as "stopped" would mislead the
      // operator. Only fall back when the IPC connection is actually broken.
      const isTimeout = (result.error || '').toLowerCase().includes('request timeout');
      if (!isTimeout) {
        const offlineStatus = buildOfflineStatus(exchange, pair);
        if (offlineStatus) {
          return res.json({ success: true, status: offlineStatus, engineDown: true, engineError: result.error });
        }
      }
      return res.status(errStatus(result)).json(result);
    }
    res.json(result);
  });

  app.post('/api/:exchange/regime/start', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:start', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/stop', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:stop', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/pause', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:pause', { reason: req.body?.reason }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/resume', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:resume', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // Mark fund as draining: blocks new entries, lets the current TP cycle complete,
  // then auto-stops the engine and marks lifecycle 'closed'.
  app.post('/api/:exchange/regime/close', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = await getIPC(exchange).request('regime:close', { reason }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    log('INFO', `🚦 [${exchange}/${pair}] Fund close requested${reason ? `: ${reason}` : ''}`);
    res.json(result);
  });

  // Reopen a closed fund: lifecycle 'closed' → 'active'. Does not restart the engine.
  app.post('/api/:exchange/regime/reopen', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:reopen', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    log('INFO', `🔓 [${exchange}/${pair}] Fund reopened`);
    res.json(result);
  });

  app.post('/api/:exchange/regime/force-regime', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { regime, reason } = req.body;

    const validRegimes = ['HARVEST', 'CAUTION', 'TREND'];
    if (!regime || !validRegimes.includes(regime.toUpperCase())) {
      return res.status(400).json({ success: false, error: `Invalid regime. Must be one of: ${validRegimes.join(', ')}` });
    }

    const result = await getIPC(exchange).request('regime:force-regime', { regime: regime.toUpperCase(), reason }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/resume-drawdown', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:resume-drawdown', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/preview-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:preview-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rebuild-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:rebuild-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/cancel-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:cancel-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rollup-body', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { bodyId } = req.body || {};
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId is required' });

    const result = await getIPC(exchange).request('regime:rollup-body', { bodyId }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rollup-all', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:rollup-all', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/set-body-tp', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { bodyId, tpPct } = req.body || {};
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId is required' });
    const pct = parseFloat(tpPct);
    if (isNaN(pct) || pct <= 0 || pct > 50) return res.status(400).json({ success: false, error: 'tpPct must be a number between 0 and 50' });

    const result = await getIPC(exchange).request('regime:set-body-tp', { bodyId, tpPct: pct }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/set-body-tp-price', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { bodyId, limitPrice } = req.body || {};
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId is required' });
    const price = parseFloat(limitPrice);
    if (isNaN(price) || price <= 0) return res.status(400).json({ success: false, error: 'limitPrice must be a positive number' });

    const result = await getIPC(exchange).request('regime:set-body-tp-price', { bodyId, limitPrice: price }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Data Queries (forwarded via IPC) ============

  app.get('/api/:exchange/regime/chart-data', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const data = await getIPC(exchange).request('regime:chart-data', {}, exchange, pair).catch(() =>
      ({ priceHistory: [], atrHistory: [], regimeHistory: [], exchange, pair, timestamp: Date.now() })
    );
    res.json({ success: true, exchange, pair, data });
  });

  app.get('/api/:exchange/regime/fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:fills', {}, exchange, pair).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.get('/api/:exchange/regime/open-orders', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:open-orders', {}, exchange, pair).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.post('/api/:exchange/regime/recalculate', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { apply = false } = req.body;
    const result = await getIPC(exchange).request('regime:recalculate', { apply }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/convert-dca', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { preview = true, merge = false } = req.body;
    const result = await getIPC(exchange).request('regime:convert-dca', { preview, merge }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Manual Trade Tracking ============

  app.get('/api/:exchange/regime/unaccounted-fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { startDate } = req.query;
    if (!startDate) return res.status(400).json({ success: false, error: 'startDate query parameter is required' });
    const result = await getIPC(exchange).request('regime:unaccounted-fills', { startDate }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/manual-trades', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:manual-trades', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade/:tradeId/check', async (req, res) => {
    const { exchange, tradeId } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-check', { tradeId }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade-buy', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-buy', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade-pair', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-pair', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/dismiss-fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, error: 'orderIds array is required' });
    }
    const result = await getIPC(exchange).request('regime:dismiss-fills', { orderIds }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Dry-Run Routes (forwarded via IPC) ============

  app.get('/api/:exchange/regime/dry-run/log', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const limit = parseInt(req.query.limit) || 100;
    const result = await getIPC(exchange).request('regime:dry-run-log', { limit }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/pnl', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-pnl', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/dry-run/reset', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-reset', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/state', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-state', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });
};
