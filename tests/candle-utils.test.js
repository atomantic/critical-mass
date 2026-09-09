const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { upsertCandles } = require('../src/candle-utils');

describe('upsertCandles', () => {
  it('replaces whole rows, sorts, and leaves both input arrays and rows unchanged', () => {
    const old = Object.freeze({ timestamp: 2, close: 10, legacy: true });
    const replacement = Object.freeze({ timestamp: 2, open: 11, high: 15, low: 8, close: 13, volume: 50 });
    const existing = Object.freeze([old, Object.freeze({ timestamp: 1, close: 5 })]);
    const incoming = Object.freeze([Object.freeze({ timestamp: 3, close: 20 }), replacement]);
    assert.deepEqual(upsertCandles(existing, incoming), [existing[1], replacement, incoming[0]]);
    assert.equal(existing[0], old);
    assert.equal(incoming[1], replacement);
  });

  it('keeps the last duplicate and supports empty inputs and timestamp zero', () => {
    const rows = [{ timestamp: 0, close: 1 }, { timestamp: 0, close: 2 }];
    assert.deepEqual(upsertCandles(null, rows), [rows[1]]);
    assert.deepEqual(upsertCandles(rows, undefined), [rows[1]]);
    assert.deepEqual(upsertCandles([], []), []);
  });

  it('preserves the backtest compatibility export', () => {
    assert.equal(require('../src/backtest-engine').upsertCandles, upsertCandles);
  });
});
