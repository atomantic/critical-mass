// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isFilledStatus } = require('../src/shared-utils');

// issue #174 — the `status === 'FILLED' || completionPercentage >= 100`
// predicate was duplicated ~13 times across regime-engine, order-executor, and
// order-manager. isFilledStatus is the single source of truth. The
// completionPercentage>=100 arm exists because Coinbase can flip completion to
// 100 a tick before status flips to FILLED (issues #107, #155).
describe('isFilledStatus (issue #174)', () => {
  it('returns true when status is FILLED', () => {
    assert.equal(isFilledStatus({ status: 'FILLED' }), true);
    assert.equal(isFilledStatus({ status: 'FILLED', completionPercentage: 0 }), true);
  });

  it('returns true when completionPercentage has reached 100 even if status lags', () => {
    // Coinbase completion-before-status window (issues #107, #155)
    assert.equal(isFilledStatus({ status: 'OPEN', completionPercentage: 100 }), true);
    assert.equal(isFilledStatus({ status: 'OPEN', completionPercentage: 100.5 }), true);
    assert.equal(isFilledStatus({ completionPercentage: 100 }), true);
  });

  it('matches status case-insensitively', () => {
    // order-executor upper-cases before comparing; the helper unifies that
    assert.equal(isFilledStatus({ status: 'filled' }), true);
    assert.equal(isFilledStatus({ status: 'Filled' }), true);
  });

  it('returns false for unfilled / partially-filled orders', () => {
    assert.equal(isFilledStatus({ status: 'OPEN', completionPercentage: 0 }), false);
    assert.equal(isFilledStatus({ status: 'PARTIALLY_FILLED', completionPercentage: 50 }), false);
    assert.equal(isFilledStatus({ status: 'CANCELLED' }), false);
    assert.equal(isFilledStatus({ status: 'CANCELLED', completionPercentage: 99.9 }), false);
  });

  it('returns false for null/undefined/missing-field inputs (null-safe)', () => {
    assert.equal(isFilledStatus(null), false);
    assert.equal(isFilledStatus(undefined), false);
    assert.equal(isFilledStatus({}), false);
    assert.equal(isFilledStatus({ status: undefined }), false);
  });
});
