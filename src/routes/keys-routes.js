// @ts-check
/**
 * API Keys Management Routes
 */

const fs = require('fs');
const { getExchangeKeysPath } = require('../migration');
const { log } = require('../logger');
const { loadConfig } = require('../dca-engine');

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

  // Get keys configuration status for an exchange (returns masked metadata)
  app.get('/api/:exchange/keys', (req, res) => {
    const { exchange } = req.params;
    const keysPath = getExchangeKeysPath(exchange);
    const configured = fs.existsSync(keysPath);
    if (!configured) return res.json({ configured, keys: null });

    let keysData;
    try { keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8')); } catch { return res.json({ configured: false, keys: null }); }

    // Return masked metadata so the UI can show which fields are set
    const masked = {};
    for (const [k, v] of Object.entries(keysData)) {
      if (k === 'createdAt') { masked[k] = v; continue; }
      masked[k] = typeof v === 'string' && v.length > 6 ? v.slice(0, 3) + '***' + v.slice(-3) : '***';
    }
    res.json({ configured, keys: masked });
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
    log('INFO', `🔑 [${exchange}] API keys configured`);
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
    const parts = productId.replace('_', '-').split('-');
    let quoteCurrency = parts[1] || 'USD';

    if (exchange === 'gemini' && quoteCurrency === 'USDC') {
      quoteCurrency = 'USD';
    }

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
      log('INFO', `[${exchange}] API keys deleted`);
    }

    res.json({ success: true, exchange, configured: false });
  });
};
