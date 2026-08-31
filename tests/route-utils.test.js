// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const migration = require('../src/migration');
const { getPair, getIPC, withConfiguredPair } = require('../src/routes/route-utils');

describe('getIPC', () => {
  it('returns only the exact exchange client', () => {
    const coinbase = { request: () => Promise.resolve() };
    const gemini = { request: () => Promise.resolve() };
    assert.equal(getIPC({ coinbase, gemini }, 'gemini'), gemini);
  });

  it('fails closed instead of falling back to Coinbase', () => {
    const coinbase = { request: () => Promise.resolve() };
    assert.throws(() => getIPC({ coinbase }, 'gemini'), /No IPC client for exchange: gemini/);
  });

  it('rejects inherited and malformed clients', () => {
    const inherited = Object.create({ coinbase: { request: () => Promise.resolve() } });
    assert.throws(() => getIPC(inherited, 'coinbase'), /No IPC client/);
    assert.throws(() => getIPC({ gemini: {} }, 'gemini'), /No IPC client/);
  });
});

describe('configured pair boundary', () => {
  it('rejects traversal, absolute paths, arrays, and unknown but well-formed pairs', () => {
    const makeRequest = (pair) => ({ params: { exchange: 'coinbase' }, query: { pair } });

    assert.equal(getPair(makeRequest('../keys')).pair, null);
    assert.equal(getPair(makeRequest('%2e%2e%2fkeys')).pair, null);
    assert.equal(getPair(makeRequest('/tmp/keys')).pair, null);
    assert.equal(getPair(makeRequest(['BTC-USDC'])).pair, null);
    assert.equal(getPair(makeRequest('ETH-USDC')).pair, null);
  });

  it('uses the configured pair and blocks invalid HTTP requests before their handler runs', () => {
    let calls = 0;
    const handler = withConfiguredPair((req, res) => {
      calls += 1;
      res.json({ pair: req.fundPair });
    });
    const response = () => ({
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    });

    const invalid = response();
    handler({ params: { exchange: 'coinbase' }, query: { pair: '../keys' } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls, 0);

    const valid = response();
    handler({ params: { exchange: 'coinbase' }, query: { pair: 'btc-usdc' } }, valid);
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.body, { pair: 'BTC-USDC' });
    assert.equal(calls, 1);
  });

  it('never resolves or creates a fund directory outside its exchange directory', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-path-boundary-'));
    const originalGetExchangeDataDir = migration.getExchangeDataDir;
    migration.getExchangeDataDir = (exchange) => {
      const exchangeDir = path.join(root, exchange);
      fs.mkdirSync(exchangeDir, { recursive: true });
      return exchangeDir;
    };
    t.after(() => {
      migration.getExchangeDataDir = originalGetExchangeDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    });

    assert.throws(() => migration.resolveFundDataDir('coinbase', '../keys'), /escapes exchange data directory/);
    assert.throws(() => migration.getFundDataDir('coinbase', '/tmp/keys'), /escapes exchange data directory/);
    assert.equal(fs.existsSync(path.join(root, 'keys')), false);

    const valid = migration.getFundDataDir('coinbase', 'BTC-USDC');
    assert.equal(valid, path.join(root, 'coinbase', 'BTC-USDC'));
    assert.equal(fs.existsSync(valid), true);
  });
});
