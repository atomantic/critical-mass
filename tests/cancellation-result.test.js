const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyBodyTpCancellation } = require('../src/cancellation-result');

describe('classifyBodyTpCancellation compatibility', () => {
  const cases = [
    ['omitted quantity', { cancelled: true }, 'cancelled'],
    ['zero quantity', { cancelled: true, filledSize: 0 }, 'cancelled'],
    ['positive quantity', { cancelled: true, filledSize: 0.003 }, 'cancelled_with_execution'],
    ['cancellation wins over filled', { cancelled: true, filled: true }, 'cancelled'],
    ['execution wins over filled', { cancelled: true, filled: true, filledSize: 1 }, 'cancelled_with_execution'],
    ['truthy cancellation and coercible size', { cancelled: 'yes', filledSize: '0.003' }, 'cancelled_with_execution'],
    ['negative quantity', { cancelled: 1, filledSize: -1 }, 'cancelled'],
    ['non-numeric quantity', { cancelled: true, filledSize: 'unknown' }, 'cancelled'],
    ['fully filled', { cancelled: false, filled: true, filledSize: 0 }, 'filled'],
    ['truthy filled', { cancelled: 0, filled: 'yes' }, 'filled'],
    ['execution alone is unresolved', { filledSize: 1 }, 'unresolved'],
    ['false flags', { cancelled: false, filled: false }, 'unresolved'],
    ['absent flags', {}, 'unresolved'],
  ];
  for (const [name, result, expected] of cases) {
    it(name, () => {
      const before = structuredClone(result);
      assert.equal(classifyBodyTpCancellation(Object.freeze(result)), expected);
      assert.deepEqual(result, before);
    });
  }
});
