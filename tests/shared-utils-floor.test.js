// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { floorToIncrement, incrementToDecimals } = require('../src/shared-utils');

// issue #109 — Math.floor(value/increment)*increment steps a full increment
// down for many exactly-representable inputs (float dust). floorToIncrement
// absorbs the representation error without ever rounding UP past a real tick.
describe('floorToIncrement (issue #109)', () => {
  it('does not undershoot on inputs that the naive floor breaks', () => {
    // Naive: Math.floor(0.29/0.01)*0.01 === 0.28
    assert.equal(Number(floorToIncrement(0.29, 0.01).toFixed(2)), 0.29);
    // Naive: Math.floor(8.2/0.1)*0.1 === 8.1
    assert.equal(Number(floorToIncrement(8.2, 0.1).toFixed(1)), 8.2);
  });

  it('still floors a value that is genuinely above a tick (never rounds up)', () => {
    assert.equal(Number(floorToIncrement(0.299, 0.01).toFixed(2)), 0.29);
    assert.equal(Number(floorToIncrement(1.0049, 0.01).toFixed(2)), 1.00);
    assert.equal(Number(floorToIncrement(8.27, 0.1).toFixed(1)), 8.2);
  });

  it('handles 8-decimal base increments (BTC sizes)', () => {
    assert.equal(Number(floorToIncrement(0.00012345, 0.00000001).toFixed(8)), 0.00012345);
    assert.equal(Number(floorToIncrement(0.123456789, 0.00000001).toFixed(8)), 0.12345678);
  });

  it('returns the value unchanged when increment is missing or non-positive', () => {
    assert.equal(floorToIncrement(1.23, 0), 1.23);
    assert.equal(floorToIncrement(1.23, undefined), 1.23);
  });

  it('composes with incrementToDecimals for exchange-ready strings', () => {
    const inc = 0.01;
    const v = floorToIncrement(0.29, inc);
    assert.equal(v.toFixed(incrementToDecimals(inc)), '0.29');
  });
});
