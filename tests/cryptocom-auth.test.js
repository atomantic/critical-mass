// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildParamString, generateSignature } = require('../src/adapters/cryptocom/auth');

// ---------------------------------------------------------------------------
// buildParamString numeric handling (issue #208D)
//
// The old implementation ran obj.toString().replace(/\.?0+$/, '') on numbers.
// JS toString() never emits trailing decimal zeros, so that regex only ever
// stripped trailing zeros of INTEGERS (300 → "3"), corrupting the signed
// payload for any numeric param ending in 0.
// ---------------------------------------------------------------------------

describe('cryptocom buildParamString numeric serialization (issue #208D)', () => {
  it('serializes an integer ending in 0 without stripping the zero', () => {
    assert.equal(buildParamString({ count: 300 }), 'count300');
  });

  it('does not corrupt large integer timestamps ending in 0', () => {
    assert.equal(buildParamString({ start_time: 1750000000000 }), 'start_time1750000000000');
  });

  it('preserves a numeric value with a fractional part', () => {
    assert.equal(buildParamString({ price: 12.5 }), 'price12.5');
  });

  it('sorts keys and concatenates mixed numeric/string params exactly', () => {
    // Keys sorted alphabetically: count, page_size, symbol
    assert.equal(
      buildParamString({ symbol: 'BTC_USDT', count: 300, page_size: 20 }),
      'count300page_size20symbolBTC_USDT'
    );
  });

  it('handles nested numeric params ending in 0', () => {
    assert.equal(
      buildParamString({ params: { limit: 100 } }),
      'paramslimit100'
    );
  });

  it('produces a signature that agrees with an independent HMAC over the same canonical string', () => {
    const secret = 'test-secret';
    const apiKey = 'test-key';
    const method = 'private/get-trades';
    const id = 1;
    const nonce = 1750000000000;
    const params = { count: 300 };

    const expectedPayload = method + id + apiKey + 'count300' + nonce;
    const expectedSig = crypto.createHmac('sha256', secret).update(expectedPayload).digest('hex');

    assert.equal(generateSignature(method, id, apiKey, params, nonce, secret), expectedSig);
  });
});
