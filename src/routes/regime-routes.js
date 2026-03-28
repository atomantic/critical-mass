// @ts-check
/**
 * Regime Engine API Routes (Gateway Proxy)
 *
 * Forwards regime engine commands and queries to the Coinbase engine
 * process via IPC WebSocket. Config reads/writes stay local (file-based).
 */

const { getRegimeConfig, updateRegimeConfig, validateRegimeConfig, getExchangeConfig } = require('../config-utils');
const { log } = require('../logger');

/** Convert IPC connection errors to standard response */
const engineError = (err) => ({ success: false, error: `Engine unavailable: ${err.message}` });

/** HTTP status code for error responses */
const errStatus = (result) => result.error?.includes('unavailable') ? 503 : 400;

/**
 * @param {import('express').Express} app
 * @param {{exchangeIPCMap: Object}} deps
 */
module.exports = (app, deps) => {
  const { exchangeIPCMap } = deps;
  const getIPC = (exchange) => exchangeIPCMap[exchange] || exchangeIPCMap.coinbase;

  // ============ Config (file-based, stays in gateway) ============

  app.get('/api/:exchange/regime/config', (req, res) => {
    const { exchange } = req.params;
    const regimeConfig = getRegimeConfig(exchange);
    const exchangeConfig = getExchangeConfig(exchange);
    const config = { ...regimeConfig, dryRun: exchangeConfig.dryRun, productId: exchangeConfig.productId };
    res.json({ success: true, exchange, config });
  });

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

    // Notify engine of config change (fire-and-forget)
    getIPC(exchange).request('regime:update-config', updates, exchange).catch(() => {});

    res.json({ success: true, exchange, config });
  });

  // ============ Engine Commands (forwarded via IPC) ============

  app.get('/api/:exchange/regime/status', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:status', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/start', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:start', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/stop', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:stop', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/pause', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:pause', { reason: req.body?.reason }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/resume', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:resume', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/force-regime', async (req, res) => {
    const { exchange } = req.params;
    const { regime, reason } = req.body;

    const validRegimes = ['HARVEST', 'CAUTION', 'TREND'];
    if (!regime || !validRegimes.includes(regime.toUpperCase())) {
      return res.status(400).json({ success: false, error: `Invalid regime. Must be one of: ${validRegimes.join(', ')}` });
    }

    const result = await getIPC(exchange).request('regime:force-regime', { regime: regime.toUpperCase(), reason }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/resume-drawdown', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:resume-drawdown', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/preview-ladder', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:preview-ladder', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rebuild-ladder', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:rebuild-ladder', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/cancel-ladder', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:cancel-ladder', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/rollup-body', async (req, res) => {
    const { exchange } = req.params;
    const { bodyId } = req.body || {};
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId is required' });

    const result = await getIPC(exchange).request('regime:rollup-body', { bodyId }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Data Queries (forwarded via IPC) ============

  app.get('/api/:exchange/regime/chart-data', async (req, res) => {
    const { exchange } = req.params;
    const data = await getIPC(exchange).request('regime:chart-data', {}, exchange).catch(() =>
      ({ priceHistory: [], atrHistory: [], regimeHistory: [], exchange, timestamp: Date.now() })
    );
    res.json({ success: true, exchange, data });
  });

  app.get('/api/:exchange/regime/fills', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:fills', {}, exchange).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, ...result });
  });

  app.get('/api/:exchange/regime/open-orders', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:open-orders', {}, exchange).catch(engineError);
    if (result.success === false) return res.status(errStatus(result)).json(result);
    res.json({ success: true, exchange, ...result });
  });

  app.post('/api/:exchange/regime/recalculate', async (req, res) => {
    const { exchange } = req.params;
    const { apply = false } = req.body;
    const result = await getIPC(exchange).request('regime:recalculate', { apply }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/sync-fills', async (req, res) => {
    const { exchange } = req.params;
    const { dryRun = false } = req.body;
    const result = await getIPC(exchange).request('regime:sync-fills', { dryRun }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/convert-dca', async (req, res) => {
    const { exchange } = req.params;
    const { preview = true, merge = false } = req.body;
    const result = await getIPC(exchange).request('regime:convert-dca', { preview, merge }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  // ============ Dry-Run Routes (forwarded via IPC) ============

  app.get('/api/:exchange/regime/dry-run/log', async (req, res) => {
    const { exchange } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const result = await getIPC(exchange).request('regime:dry-run-log', { limit }, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/pnl', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:dry-run-pnl', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.post('/api/:exchange/regime/dry-run/reset', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:dry-run-reset', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });

  app.get('/api/:exchange/regime/dry-run/state', async (req, res) => {
    const { exchange } = req.params;
    const result = await getIPC(exchange).request('regime:dry-run-state', {}, exchange).catch(engineError);
    if (!result.success) return res.status(errStatus(result)).json(result);
    res.json(result);
  });
};
