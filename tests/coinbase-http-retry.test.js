// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// GET-only 429/502/503/504 retry with backoff, Retry-After and per-attempt
// signing (#1621). Sleep and jitter are injected so the tests run instantly.

let keysPath;
let originalFetch;

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-retry-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (keysPath && fs.existsSync(keysPath)) fs.unlinkSync(keysPath);
});

const res = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

/** @param {any[]} responses */
const setup = (responses) => {
  const calls = [];
  const sleeps = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  const adapter = createCoinbaseAdapter(keysPath, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  return { adapter, calls, sleeps };
};

const getPrice = (adapter) => adapter.getAccountBalance('USDC');

describe('coinbase GET 429/5xx retry', () => {
  it('retries a 429 then succeeds, regenerating auth per attempt', async () => {
    const ok = { accounts: [{ currency: 'USDC', type: 'ACCOUNT_TYPE_CRYPTO', available_balance: { value: '5' }, hold: { value: '0' } }], has_next: false };
    const { adapter, calls, sleeps } = setup([res(429, {}, { 'retry-after': '2' }), res(200, ok)]);
    const bal = await getPrice(adapter);
    assert.ok(bal);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
    assert.notEqual(calls[0].opts.headers.Authorization, calls[1].opts.headers.Authorization);
  });

  it('uses exponential backoff and gives up after 3 attempts on 503', async () => {
    const { adapter, calls, sleeps } = setup([res(503, { message: 'down' })]);
    await assert.rejects(() => getPrice(adapter), (err) => err.status === 503);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  it('caps a large Retry-After at the 10s ceiling', async () => {
    const { adapter, sleeps } = setup([res(429, {}, { 'retry-after': '120' }), res(200, { accounts: [], has_next: false })]);
    await getPrice(adapter).catch(() => {});
    assert.deepEqual(sleeps, [10000]);
  });

  it('does not retry other client errors', async () => {
    const { adapter, calls } = setup([res(404)]);
    await assert.rejects(() => getPrice(adapter), (err) => err.status === 404);
    assert.equal(calls.length, 1);
  });

  it('never retries POSTs on 429 or 503', async () => {
    for (const status of [429, 503]) {
      const { adapter, calls, sleeps } = setup([res(status)]);
      await assert.rejects(() => adapter.placeLimitSell('BTC-USDC', 0.001, 50000, `cid-${status}`));
      assert.equal(calls.length, 1);
      assert.equal(sleeps.length, 0);
    }
  });
});
