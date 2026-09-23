// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { finiteFloat } = require('../src/shared-utils');

// Issue #684: getOpenOrders() adapters compute a REMAINING size as
// originalSize - filledSize. `parseFloat(x || 0)` alone only guards a FALSY
// input (missing/empty/0) — a TRUTHY but non-numeric value (an exchange
// returning "N/A" for a numeric field) still parses to NaN, which then
// poisons the subtraction and fails every `> 0` gate downstream the same way
// `undefined` did before the fix (e.g. the orphan-sell-order safety warning).
// finiteFloat is the shared guard: parse, then fall back unless the result
// is actually finite.
describe('finiteFloat', () => {
  it('parses a valid numeric string', () => {
    assert.equal(finiteFloat('1.5'), 1.5);
    assert.equal(finiteFloat('0'), 0);
  });

  it('falls back to 0 by default when the value is missing/falsy', () => {
    assert.equal(finiteFloat(undefined), 0);
    assert.equal(finiteFloat(null), 0);
    assert.equal(finiteFloat(''), 0);
  });

  it('falls back to a custom fallback when given one', () => {
    assert.equal(finiteFloat(undefined, 42), 42);
    assert.equal(finiteFloat('not a number', -1), -1);
  });

  for (const badValue of ['N/A', 'not a number', 'Infinity', 'NaN', {}, []]) {
    it(`falls back instead of returning NaN/Infinity for a truthy-but-unparseable value (${JSON.stringify(badValue)})`, () => {
      const result = finiteFloat(badValue, 0);
      assert.ok(Number.isFinite(result), `expected a finite fallback, got ${result}`);
      assert.equal(result, 0);
    });
  }

  it('accepts a real number passed through directly', () => {
    assert.equal(finiteFloat(3.14), 3.14);
    assert.equal(finiteFloat(0), 0);
  });
});
