// @ts-check
/**
 * API Keys Management Routes
 */

const fs = require('fs');
const { getExchangeKeysPath } = require('../migration');
const { createContextLogger } = require('../logger');
const { loadConfig } = require('../dca-engine');
const { getQuoteCurrency } = require('../config-utils');
const { validateCoinbaseKeys, validateStandardExchangeKeys } = require('../adapters/key-validation');

const MAX_CREDENTIAL_LENGTH = 16 * 1024;

const getAdapterConfiguredState = (exchange) => {
  try {
    const { getAdapter } = require('../adapters');
    return Boolean(getAdapter(exchange).hasValidKeys());
  } catch {
    return false;
  }
};

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
    const body = req.body || {};

    let keysData;
    if (exchange === 'coinbase') {
      if (typeof body.name !== 'string' || typeof body.privateKey !== 'string') {
        const errorDetail = (body.apiKey || body.apiSecret)
          ? ' (Coinbase Advanced API / CDP keys are required, not regular Coinbase API keys)'
          : '';
        return res.status(400).json({ success: false, error: `name and privateKey are required for Coinbase${errorDetail}` });
      }
      const name = body.name.trim();
      const privateKey = body.privateKey.trim();
      if (name.length > MAX_CREDENTIAL_LENGTH || privateKey.length > MAX_CREDENTIAL_LENGTH) {
        return res.status(400).json({ success: false, error: 'Credential fields exceed the maximum allowed length' });
      }
      if (!privateKey.includes('-----BEGIN')) {
        return res.status(400).json({ success: false, error: "This private key isn't an ECDSA key in PEM format. In the Coinbase Developer Platform, create a new API key with the signature algorithm set to ECDSA (under Advanced settings), then paste the private key that starts with -----BEGIN EC PRIVATE KEY-----." });
      }
      keysData = { name, privateKey };
      if (!validateCoinbaseKeys(keysData)) {
        return res.status(400).json({ success: false, error: 'Invalid Coinbase credential shape: name must be at least 10 characters and privateKey must be PEM' });
      }
      keysData.createdAt = new Date().toISOString();
    } else {
      if (typeof body.apiKey !== 'string' || typeof body.apiSecret !== 'string') {
        return res.status(400).json({ success: false, error: 'apiKey and apiSecret are required' });
      }
      const apiKey = body.apiKey.trim();
      const apiSecret = body.apiSecret.trim();
      if (apiKey.length > MAX_CREDENTIAL_LENGTH || apiSecret.length > MAX_CREDENTIAL_LENGTH) {
        return res.status(400).json({ success: false, error: 'Credential fields exceed the maximum allowed length' });
      }
      keysData = { apiKey, apiSecret };
      if (!validateStandardExchangeKeys(keysData)) {
        return res.status(400).json({ success: false, error: 'Invalid credential shape: apiKey and apiSecret must each be at least 10 characters' });
      }
      keysData.createdAt = new Date().toISOString();
    }

    const keysPath = getExchangeKeysPath(exchange);
    writeJSON(keysPath, keysData);
    keysLogger(exchange, '/api/:exchange/keys').info(`ℹ️ 🔑 [${exchange}] API keys configured`, {
      action: 'save-keys',
      method: req.method,
    });
    const configured = getAdapterConfiguredState(exchange);
    res.json({ success: true, exchange, configured });
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

    // Report the REAL post-delete state rather than hardcoding false (issue #688):
    // a stale/legacy credential source could still leave the adapter usable even
    // after this file is gone, and the UI should reflect that instead of hiding it.
    // Any exchange without a registered adapter (unknown/unsupported) falls back
    // to false, matching the pre-existing behavior for that case.
    let configured = false;
    try {
      const { getAdapter } = require('../adapters');
      configured = getAdapter(exchange).hasValidKeys();
    } catch (err) {
      keysLogger(exchange, '/api/:exchange/keys').warn(`⚠️ [${exchange}] Could not resolve adapter to verify post-delete state`, { error: err.message });
    }

    res.json({ success: true, exchange, configured });
  });
};
