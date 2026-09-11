// @ts-check
/**
 * Regime Engine API Routes (Gateway Proxy)
 *
 * Forwards regime engine commands and queries to the Coinbase engine
 * process via IPC WebSocket. Config reads/writes stay local (file-based).
 */

const { getRegimeConfig, updateRegimeConfig, updateFundConfig, validateRegimeConfig, getFundConfig } = require('../config-utils');
const { buildStoppedRegimeStatus } = require('../regime-status');
const { createContextLogger } = require('../logger');
const { sanitizeRegimeConfig } = require('../config-validator');
const { getSafeIPC, withConfiguredPair } = require('./route-utils');

/**
 * Context logger for the regime routes. Every endpoint here is fund-scoped, so
 * exchange and pair are real context; `route` names the endpoint.
 * @param {string} [exchange] - Exchange the request targets
 * @param {string} [pair] - Fund pair the request targets
 * @param {string} [route] - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const regimeLogger = (exchange, pair, route) => createContextLogger({
  module: 'regime-routes',
  exchange,
  pair,
  route,
});

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

/** Convert IPC connection errors to standard response */
const engineError = (err) => ({ success: false, error: `Engine unavailable: ${err.message}` });

/**
 * Read-only status synthesized from disk for when the engine IPC is dead.
 * Delegates to the shared stopped/offline status synthesizer (issue #357),
 * which re-derives P&L from the cached fill ledger and falls back to the
 * ledger's last fill price for `market.lastPrice` when there's no live
 * price to report — the same enrichment the engine's own IPC handler and
 * the Socket.IO stream produce.
 *
 * Returns null when there's no persisted state to fall back on, so a true
 * IPC outage (e.g., first-time fund or broken connection with no saved
 * data) still surfaces as 503 rather than masking as a stopped engine.
 * `health.mode: 'ENGINE_DOWN'` (vs. the engine's own `'STOPPED'`) tells the
 * dashboard this is an unreachable engine, not a clean operator stop, so
 * the operator doesn't take an unsafe control action against a process
 * that may still be running.
 */
const buildOfflineStatus = (exchange, pair) => buildStoppedRegimeStatus(exchange, pair, {
  mode: 'ENGINE_DOWN',
  requireExistingState: true,
});

/** HTTP status code for error responses */
const errStatus = (result) => result.error?.includes('unavailable') ? 503 : 400;

/**
 * @param {import('express').Express} app
 * @param {{exchangeIPCMap: Object}} deps
 */
module.exports = (app, deps) => {
  // Every regime route is fund-scoped. Wrap registrations once so a future
  // handler cannot accidentally forward an unvalidated query string to IPC.
  const originalApp = app;
  app = Object.create(app);
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (route, handler) => originalApp[method](route, withConfiguredPair(handler));
  }
  const { exchangeIPCMap } = deps;
  const getIPC = (exchange) => getSafeIPC(exchangeIPCMap, exchange);
  // Reads the pair already validated and attached by withConfiguredPair —
  // distinct from route-utils' resolvePairParam, which resolves one from
  // params/query before that validation happens.
  const getFundPair = (req) => req.fundPair;

  // ============ Config (file-based, stays in gateway) ============

  app.get('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const config = buildClientConfig(exchange, pair);
    res.json({ success: true, exchange, pair, config });
  });

  app.put('/api/:exchange/regime/config', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const logger = regimeLogger(exchange, pair, '/api/:exchange/regime/config');
    const rawUpdates = req.body;
    if (typeof rawUpdates !== 'object' || rawUpdates === null || Array.isArray(rawUpdates)) {
      return res.status(400).json({ success: false, errors: ['config update must be an object'] });
    }

    // Fund-level fields are governed by their own schema below. Everything else
    // must pass through the same regime allowlist used by the full config route,
    // so stale UI fields cannot be persisted or sent to the live engine.
    const fundUpdates = {};
    const rawRegimeUpdates = {};
    for (const [key, value] of Object.entries(rawUpdates)) {
      (FUND_LEVEL_FIELDS.includes(key) ? fundUpdates : rawRegimeUpdates)[key] = value;
    }
    const { value: regimeUpdates, droppedKeys } = sanitizeRegimeConfig(rawRegimeUpdates);
    if (droppedKeys.length > 0) {
      logger.warn(`⚠️ 🧹 [${exchange}/${pair}] Ignored unknown regime config keys: ${droppedKeys.join(', ')}`, {
        action: 'update-config',
        droppedKeys,
      });
    }
    const updates = { ...regimeUpdates, ...fundUpdates };

    const currentConfig = getRegimeConfig(exchange, pair);
    const keysToValidate = Object.keys(regimeUpdates);
    const crossFieldPairs = {
      tpMinPercent: 'tpMaxPercent', tpMaxPercent: 'tpMinPercent',
      macroDeclineThreshold: 'macroAccumulationThreshold', macroAccumulationThreshold: 'macroMarkupThreshold',
      macroMarkupThreshold: 'macroAccumulationThreshold',
    };
    const validationSubset = { ...regimeUpdates };
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
    logger.info(`ℹ️ 🔧 [${exchange}/${pair}] Config updated (fund: ${Object.keys(fundUpdates).join(',') || 'none'}, regime: ${Object.keys(regimeUpdates).join(',') || 'none'})`, {
      action: 'update-config',
      fundKeys: Object.keys(fundUpdates),
      regimeKeys: Object.keys(regimeUpdates),
    });

    // Return the merged view GET would produce, so the client reflects both
    // fund-level and regime changes immediately.
    const config = buildClientConfig(exchange, pair);

    try {
      const applied = await getIPC(exchange).request('regime:update-config', updates, exchange, pair);
      if (applied?.success === false) throw new Error(applied.error || applied.message || 'Engine rejected config update');
    } catch (err) {
      logger.error(`❌ 🚨 [${exchange}/${pair}] Regime config persisted but live engine update failed: ${err.message}`, {
        action: 'update-config',
        channel: 'regime:update-config',
        persisted: true,
        applied: false,
        error: err.message,
      });
      return res.status(503).json({
        success: false,
        persisted: true,
        applied: false,
        error: `Config was saved but the live engine did not apply it: ${err.message}`,
        exchange,
        pair,
        config,
      });
    }

    res.json({ success: true, persisted: true, applied: true, exchange, pair, config });
  });

  // ============ Engine Commands (forwarded via IPC) ============

  app.get('/api/:exchange/regime/status', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
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
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:start', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/stop', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:stop', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/pause', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:pause', { reason: req.body?.reason }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/resume', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:resume', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // Mark fund as draining: blocks new entries, lets the current TP cycle complete,
  // then auto-stops the engine and marks lifecycle 'closed'.
  app.post('/api/:exchange/regime/close', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = await getIPC(exchange).request('regime:close', { reason }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    regimeLogger(exchange, pair, '/api/:exchange/regime/close').info(`ℹ️ 🚦 [${exchange}/${pair}] Fund close requested${reason ? `: ${reason}` : ''}`, {
      action: 'close-fund',
      reason,
    });
    res.json(result);
  });

  // Reopen a closed fund: lifecycle 'closed' → 'active'. Does not restart the engine.
  app.post('/api/:exchange/regime/reopen', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:reopen', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    regimeLogger(exchange, pair, '/api/:exchange/regime/reopen').info(`ℹ️ 🔓 [${exchange}/${pair}] Fund reopened`, { action: 'reopen-fund' });
    res.json(result);
  });

  app.post('/api/:exchange/regime/force-regime', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
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
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:resume-drawdown', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/preview-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:preview-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rebuild-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:rebuild-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/cancel-ladder', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:cancel-ladder', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rollup-body', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const { bodyId } = req.body || {};
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId is required' });

    // Two verified cancellations plus placement can exceed the default 10s IPC deadline.
    const result = await getIPC(exchange).request('regime:rollup-body', { bodyId }, exchange, pair, 60_000).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rollup-all', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    // Collapse serializes multiple roll-ups, each with exchange settlement checks.
    const result = await getIPC(exchange).request('regime:rollup-all', {}, exchange, pair, 300_000).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/reset-cycle', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:reset-cycle', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/set-body-tp', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
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
    const pair = getFundPair(req);
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
    const pair = getFundPair(req);
    const data = await getIPC(exchange).request('regime:chart-data', {}, exchange, pair).catch(() =>
      ({ priceHistory: [], atrHistory: [], regimeHistory: [], exchange, pair, timestamp: Date.now() })
    );
    res.json({ success: true, exchange, pair, data });
  });

  app.get('/api/:exchange/regime/fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:fills', {}, exchange, pair).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.get('/api/:exchange/regime/open-orders', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:open-orders', {}, exchange, pair).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, pair, ...result });
  });

  app.post('/api/:exchange/regime/recalculate', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const { apply = false } = req.body;
    const result = await getIPC(exchange).request('regime:recalculate', { apply }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/convert-dca', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const { preview = true, merge = false } = req.body;
    const result = await getIPC(exchange).request('regime:convert-dca', { preview, merge }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Manual Trade Tracking ============

  app.get('/api/:exchange/regime/unaccounted-fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const { startDate } = req.query;
    if (!startDate) return res.status(400).json({ success: false, error: 'startDate query parameter is required' });
    const result = await getIPC(exchange).request('regime:unaccounted-fills', { startDate }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/manual-trades', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:manual-trades', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade/:tradeId/check', async (req, res) => {
    const { exchange, tradeId } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-check', { tradeId }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade-buy', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-buy', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/manual-trade-pair', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:manual-trade-pair', req.body, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/dismiss-fills', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
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
    const pair = getFundPair(req);
    const limit = parseInt(req.query.limit) || 100;
    const result = await getIPC(exchange).request('regime:dry-run-log', { limit }, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/pnl', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-pnl', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/dry-run/reset', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-reset', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/state', async (req, res) => {
    const { exchange } = req.params;
    const pair = getFundPair(req);
    const result = await getIPC(exchange).request('regime:dry-run-state', {}, exchange, pair).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });
};
