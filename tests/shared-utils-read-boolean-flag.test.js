// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readBooleanFlag } = require('../src/shared-utils');

// Issue #454: apply/preview/merge/createBody select a preview-vs-mutate branch
// downstream (regime-routes.js, coinbase-engine.js IPC handlers, and
// manual-trade-import.js's importBuy). Coercing a truthy-but-non-boolean value
// (the string "false", a number, an array/object, null) has flipped destructive
// behavior before (see the `dryRun` fund-config guard this helper mirrors), so
// only a literal boolean may select the branch — everything else is rejected.
describe('readBooleanFlag', () => {
  it('returns the default when the field is omitted', () => {
    assert.deepEqual(readBooleanFlag({}, 'apply', false), { value: false });
    assert.deepEqual(readBooleanFlag({}, 'preview', true), { value: true });
  });

  it('is body-null-safe, treating a missing body as omitted', () => {
    assert.deepEqual(readBooleanFlag(null, 'apply', false), { value: false });
    assert.deepEqual(readBooleanFlag(undefined, 'apply', false), { value: false });
  });

  it('accepts a literal boolean regardless of the default', () => {
    assert.deepEqual(readBooleanFlag({ apply: true }, 'apply', false), { value: true });
    assert.deepEqual(readBooleanFlag({ apply: false }, 'apply', true), { value: false });
  });

  for (const badValue of ['false', 'true', 0, 1, [], {}, null, 'yes', undefined]) {
    it(`rejects a present-but-non-boolean value (${JSON.stringify(badValue)})`, () => {
      const result = readBooleanFlag({ apply: badValue }, 'apply', false);
      assert.equal(result.value, undefined);
      assert.equal(result.error, 'apply must be a boolean');
    });
  }
});
