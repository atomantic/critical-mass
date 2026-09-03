// @ts-check
/**
 * API Keys Management Routes
 */

const fs = require('fs');
const { getExchangeKeysPath } = require('../migration');
const { createContextLogger } = require('../logger');
const { loadConfig } = require('../dca-engine');
const { getQuoteCurrency } = require('../config-utils');

/**
 * Context logger for the API-key routes. Every handler here is exchange-scoped
 * but pair-agnostic, so `route` identifies the endpoint instead.
 * @param {string} [exchange] - Exchange the request targets
 * @param {string} [route] - Express route pattern being served
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const keysLogger = (exchange, route) => createContextLogger({
  module: 'keys-routes',
  exchange,
  route,
});

/**
 * @param {import('express').Express} app
 * @param {{writeJSON: Function}} deps
 */
module.exports = (app, deps) => {
  const { writeJSON } = deps;

  // Check if keys exist for an exchange
  app.get('/api/:exchange/keys/status', (req, res) => {
    const { exchange } = req.params;
    const keysPath = getExchangeKeysPath(exchange);
    const exists = fs.existsSync(keysPath);
    res.json({ exchange, configured: exists });
  });

  // Get keys configuration status for an exchange (returns per-field boolean flags)
  app.get('/api/:exchange/keys', (req, res) => {
    const { exchange } = req.params;
    const keysPath = getExchangeKeysPath(exchange);
    const configured = fs.existsSync(keysPath);
    if (!configured) return res.json({ configured, keys: null });

    let keysData;
    try { keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8')); } catch { return res.json({ configured: false, keys: null }); }

    // Return boolean flags per field — never return values (even masked) to prevent round-trip overwrites
    const fields = {};
    for (const k of Object.keys(keysData)) {
      if (k === 'createdAt') continue;
      fields[k] = true;
    }
    res.json({ configured, fields, createdAt: keysData.createdAt || null });
  });

  // Save keys for an exchange (shared handler for POST and PUT)
  const saveExchangeKeys = (req, res) => {
    const { exchange } = req.params;
    const body = req.body;

    let keysData;
    if (exchange === 'coinbase') {
      if (!body.name || !body.privateKey) {
        return res.status(400).json({ success: false, error: 'name and privateKey are required for Coinbase' });
      }
      keysData = { name: body.name, privateKey: body.privateKey, createdAt: new Date().toISOString() };
    } else {
      if (!body.apiKey || !body.apiSecret) {
        return res.status(400).json({ success: false, error: 'apiKey and apiSecret are required' });
      }
      keysData = { apiKey: body.apiKey, apiSecret: body.apiSecret, createdAt: new Date().toISOString() };
    }

    const keysPath = getExchangeKeysPath(exchange);
    writeJSON(keysPath, keysData);
    keysLogger(exchange, '/api/:exchange/keys').info(`ℹ️ 🔑 [${exchange}] API keys configured`, {
      action: 'save-keys',
      method: req.method,
    });
    res.json({ success: true, exchange, configured: true });
  };
  app.post('/api/:exchange/keys', saveExchangeKeys);
  app.put('/api/:exchange/keys', saveExchangeKeys);

  // Test connection for an exchange
  app.post('/api/:exchange/test-connection', async (req, res) => {
    const { exchange } = req.params;
    const { getAdapter } = require('../adapters');

    const adapter = getAdapter(exchange);
    const exchangeConfig = loadConfig(exchange);
    const productId = exchangeConfig.productId || '';
    const quoteCurrency = getQuoteCurrency(productId);

    if (!adapter.hasValidKeys || !adapter.hasValidKeys()) {
      return res.json({ success: false, exchange, error: 'API keys not configured or invalid. Please save valid API keys first.' });
    }

    const balance = await adapter.getAccountBalance(quoteCurrency).catch(err => {
      return { _error: err.message || 'Connection failed' };
    });

    if (balance._error) {
      return res.json({ success: false, exchange, error: balance._error });
    }

    res.json({ success: true, exchange, balance, quoteCurrency });
  });

  // Delete keys for an exchange
  app.delete('/api/:exchange/keys', (req, res) => {
    const { exchange } = req.params;
    const keysPath = getExchangeKeysPath(exchange);

    if (fs.existsSync(keysPath)) {
      fs.unlinkSync(keysPath);
      keysLogger(exchange, '/api/:exchange/keys').info(`ℹ️ [${exchange}] API keys deleted`, { action: 'delete-keys' });
    }

    res.json({ success: true, exchange, configured: false });
  });
};
