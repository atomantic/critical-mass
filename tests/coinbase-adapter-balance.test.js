// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// ---------------------------------------------------------------------------
// Test harness
//
// The adapter signs a JWT with an EC private key before calling fetch, so the
// test writes a freshly-generated prime256v1 key to a temp keys file and mocks
// global.fetch to return canned /accounts pages (issue #208C).
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Mock global.fetch. `handler(url, calls)` returns a response body (ok:200).
 * @param {(url: URL, calls: URL[]) => any} handler
 * @returns {{calls: URL[]}}
 */
const installFetchMock = (handler) => {
  const calls = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const body = handler(parsed, calls);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { calls };
};

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-test-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (keysPath && fs.existsSync(keysPath)) fs.unlinkSync(keysPath);
});

const makeAccount = (currency, value, overrides = {}) => ({
  currency,
  type: 'ACCOUNT_TYPE_CRYPTO',
  available_balance: { value: String(value) },
  hold: { value: '0' },
  ...overrides,
});

describe('coinbase getAccountBalance pagination (issue #208C)', () => {
  it('accumulates matching accounts across pages and terminates on has_next:false even if a cursor is echoed', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const pages = {
      '': { accounts: [makeAccount('BTC', 0)], cursor: 'CUR1', has_next: true },
      // Final page echoes a non-empty cursor but has_next:false — must still stop.
      'CUR1': { accounts: [makeAccount('BTC', 1.5)], cursor: 'CUR2', has_next: false },
    };
    const { calls } = installFetchMock((url) => {
      const cursor = url.searchParams.get('cursor') || '';
      return pages[cursor];
    });

    const bal = await adapter.getAccountBalance('BTC');
    assert.equal(calls.length, 2, 'should request exactly two pages');
    // Prefers the account with a positive balance across the accumulated pages.
    assert.equal(bal.available, 1.5);
    assert.equal(bal.total, 1.5);
  });

  it('does not loop forever when the API repeats the same cursor', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock(() => ({
      accounts: [makeAccount('BTC', 0)],
      cursor: 'STUCK',
      has_next: true,
    }));

    const bal = await adapter.getAccountBalance('BTC');
    // First page (no cursor) → STUCK, second page (cursor=STUCK) repeats → stop.
    assert.equal(calls.length, 2, 'should break once the cursor repeats');
    assert.equal(bal.total, 0);
  });

  it('encodeURIComponent-encodes an opaque cursor containing =, +, /', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const rawCursor = 'a=b+c/d';
    const { calls } = installFetchMock((url) => {
      const cursor = url.searchParams.get('cursor');
      if (!cursor) return { accounts: [], cursor: rawCursor, has_next: true };
      // The decoded cursor must round-trip to the exact raw token.
      assert.equal(cursor, rawCursor);
      return { accounts: [makeAccount('BTC', 2)], has_next: false };
    });

    const bal = await adapter.getAccountBalance('BTC');
    assert.equal(calls.length, 2);
    // Raw query string must contain the percent-encoded cursor, not the raw one.
    assert.ok(calls[1].search.includes(encodeURIComponent(rawCursor)));
    assert.equal(bal.available, 2);
  });
});
