// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isCancelledStatus, isTerminalStatus } = require('../src/shared-utils');

describe('isCancelledStatus', () => {
  for (const status of ['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED']) {
    it(`treats ${status} as a terminal cancellation`, () => {
      assert.equal(isCancelledStatus({ status }), true);
    });
  }

  it('is case-insensitive', () => {
    assert.equal(isCancelledStatus({ status: 'expired' }), true);
  });

  for (const status of ['OPEN', 'PENDING', 'QUEUED', 'CANCEL_QUEUED', 'PARTIALLY_FILLED', 'FILLED', 'UNKNOWN']) {
    it(`does not treat ${status} as a cancellation`, () => {
      assert.equal(isCancelledStatus({ status }), false);
    });
  }

  for (const order of [null, undefined, {}]) {
    it(`returns false for ${JSON.stringify(order) ?? String(order)}`, () => {
      assert.equal(isCancelledStatus(order), false);
    });
  }
});

describe('isTerminalStatus', () => {
  it('accepts a filled order', () => {
    assert.equal(isTerminalStatus({ status: 'FILLED' }), true);
  });

  it('accepts completion at 100% before the status flips (issue #107 window)', () => {
    assert.equal(isTerminalStatus({ status: 'OPEN', completionPercentage: 100 }), true);
  });

  it('accepts a cancelled order', () => {
    assert.equal(isTerminalStatus({ status: 'EXPIRED' }), true);
  });

  for (const status of ['OPEN', 'PENDING', 'CANCEL_QUEUED', 'PARTIALLY_FILLED', 'UNKNOWN']) {
    it(`rejects the non-terminal status ${status}`, () => {
      assert.equal(isTerminalStatus({ status }), false);
    });
  }

  it('rejects a null order', () => {
    assert.equal(isTerminalStatus(null), false);
  });
});
