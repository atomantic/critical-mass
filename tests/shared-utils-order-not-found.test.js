// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isOrderNotFoundError } = require('../src/shared-utils');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

// 2026-07-11 cryptocom incident: the engine restarted during a network outage,
// getOrder threw "fetch failed" for every saved body TP, and the startup
// restore treated the failures as "order gone" — nulling tpOrderId on 4 LIVE
// orders. The engine then re-placed TPs for two of them, leaving duplicate
// sells on the exchange. isOrderNotFoundError is the single predicate that
// decides when a getOrder failure may be treated as terminal.
//
// Issue #681: the old predicate checked axios-shaped `err.response.status` /
// `err.response.data.code`, which none of these fetch-based adapters ever
// set — so it silently never matched a real Gemini/Crypto.com not-found
// error. These tests drive the actual adapters (stubbing `global.fetch`)
// through their real error-construction path instead of hand-building
// synthetic errors, so a regression in the adapter's error shape breaks the
// test the same way it would break production.

let keysPath;
let originalFetch;

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `order-not-found-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

const geminiErrorResponse = (status, body) => ({
  ok: false,
  status,
  statusText: status === 404 ? 'Not Found' : 'Bad Request',
  text: async () => JSON.stringify(body),
});

const cryptocomResponse = (ok, status, body) => ({
  ok,
  status,
  statusText: ok ? 'OK' : (status === 429 ? 'Too Many Requests' : 'Internal Server Error'),
  text: async () => JSON.stringify(body),
});

describe('isOrderNotFoundError — Gemini adapter', () => {
  it('is true for a 400 with reason OrderNotFound', async () => {
    global.fetch = async () => geminiErrorResponse(400, { reason: 'OrderNotFound' });
    const adapter = createGeminiAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), true);
      return true;
    });
  });

  it('is true for a plain 404', async () => {
    global.fetch = async () => geminiErrorResponse(404, {});
    const adapter = createGeminiAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), true);
      return true;
    });
  });
});

describe('isOrderNotFoundError — Crypto.com adapter', () => {
  it('is true for an HTTP-200 body carrying code 40401 (NOT_FOUND)', async () => {
    global.fetch = async () => cryptocomResponse(true, 200, { code: 40401, message: 'NOT_FOUND' });
    const adapter = createCryptocomAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), true);
      return true;
    });
  });

  it('is true for an HTTP-400 body carrying code 316 (NO_ORDER)', async () => {
    global.fetch = async () => cryptocomResponse(false, 400, { code: 316, message: 'NO_ORDER' });
    const adapter = createCryptocomAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), true);
      return true;
    });
  });

  it('returns false for a 500 (must not orphan live orders on a transient failure)', async () => {
    global.fetch = async () => cryptocomResponse(false, 500, { code: 10001, message: 'INTERNAL_ERROR' });
    const adapter = createCryptocomAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), false);
      return true;
    });
  });

  it('returns false for a 429 rate limit', async () => {
    global.fetch = async () => cryptocomResponse(false, 429, { code: 42901, message: 'TOO_MANY_REQUESTS' });
    const adapter = createCryptocomAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), false);
      return true;
    });
  });

  it('returns false for a network error', async () => {
    global.fetch = async () => { throw new Error('fetch failed'); };
    const adapter = createCryptocomAdapter(keysPath);

    await assert.rejects(() => adapter.getOrder('x'), (err) => {
      assert.equal(isOrderNotFoundError(err), false);
      return true;
    });
  });
});

describe('isOrderNotFoundError — Coinbase stays unflagged', () => {
  it('does not treat a Coinbase-shaped 404 (no orderNotFound flag) as a definitive not-found', () => {
    // Coinbase's eventually-consistent history endpoint can briefly 404 on a
    // live order (see isOrderStillOpen), so its adapter deliberately never
    // sets `err.orderNotFound` — a Coinbase error must fall through to the
    // (non-matching) message fallback rather than the flag.
    const coinbaseLikeError = Object.assign(new Error('Coinbase API 404: Not Found'), { status: 404, endpoint: 'GET /orders/historical/x' });
    assert.equal(isOrderNotFoundError(coinbaseLikeError), false);
  });
});

describe('isOrderNotFoundError — message fallback and null-safety', () => {
  it('matches the narrow "order <id> not found" message shape', () => {
    assert.equal(isOrderNotFoundError(new Error('order abc-123 not found')), true);
  });

  it('does not match an unrelated message containing "not found"', () => {
    assert.equal(isOrderNotFoundError(new Error('Resource not found')), false);
  });

  it('is null-safe', () => {
    assert.equal(isOrderNotFoundError(null), false);
    assert.equal(isOrderNotFoundError(undefined), false);
    assert.equal(isOrderNotFoundError(new Error('x')), false);
  });
});
