// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isOrderNotFoundError } = require('../src/shared-utils');

// 2026-07-11 cryptocom incident: the engine restarted during a network outage,
// getOrder threw "fetch failed" for every saved body TP, and the startup
// restore treated the failures as "order gone" — nulling tpOrderId on 4 LIVE
// orders. The engine then re-placed TPs for two of them, leaving duplicate
// sells on the exchange. isOrderNotFoundError is the single predicate that
// decides when a getOrder failure may be treated as terminal.
describe('isOrderNotFoundError', () => {
  it('returns true only for definitive not-found signals', () => {
    assert.equal(isOrderNotFoundError(new Error('Order 123 not found')), true);

    const err404 = Object.assign(new Error('request failed'), { response: { status: 404 } });
    assert.equal(isOrderNotFoundError(err404), true);

    const errCode = Object.assign(new Error('bad request'), { response: { data: { code: 40003 } } });
    assert.equal(isOrderNotFoundError(errCode), true);
  });

  it('returns false for transient/network/auth failures (must not orphan live orders)', () => {
    assert.equal(isOrderNotFoundError(new Error('Crypto.com API network: fetch failed')), false);
    assert.equal(isOrderNotFoundError(new Error('Crypto.com API 500: Internal Server Error')), false);

    const err401 = Object.assign(new Error('UNAUTHORIZED'), { response: { status: 401 } });
    assert.equal(isOrderNotFoundError(err401), false);

    const err429 = Object.assign(new Error('rate limited'), { response: { status: 429 } });
    assert.equal(isOrderNotFoundError(err429), false);
  });

  it('is null-safe', () => {
    assert.equal(isOrderNotFoundError(null), false);
    assert.equal(isOrderNotFoundError(undefined), false);
    assert.equal(!!isOrderNotFoundError(Object.assign(new Error('x'), { response: {} })), false);
  });
});
