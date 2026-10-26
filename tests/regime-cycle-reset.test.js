const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyResetSupersession, selectCarryForwardBuys } = require('../src/regime-cycle-reset');

const context = (overrides = {}) => ({
  requestedCycleId: 'cycle-a', baselineTurnoverGeneration: 3,
  baselineTradeIds: new Set(['baseline-buy']), resetCause: 'close', ...overrides,
});
const snapshot = (turnoverGeneration, entries = []) => ({
  turnoverGeneration, closeGenerationByCycleId: new Map(entries),
});

describe('cycle reset supersession contract', () => {
  it('allows an unchanged null-cycle baseline and ignores a renamed cycle ID', () => {
    assert.equal(classifyResetSupersession(context({ requestedCycleId: null }), snapshot(3)), null);
    assert.equal(classifyResetSupersession(context(), snapshot(3, [['renamed', 3]])), null);
  });
  it('distinguishes operator supersession from an already-counted close', () => {
    assert.deepEqual(classifyResetSupersession(context(), snapshot(4)), { turnedOver: false, duplicateClose: false });
    assert.deepEqual(classifyResetSupersession(context(), snapshot(4, [['cycle-a', 4]])), { turnedOver: false, duplicateClose: true });
  });
  it('tracks null-cycle closes and excludes closes at or before the baseline', () => {
    assert.deepEqual(classifyResetSupersession(context({ requestedCycleId: null }), snapshot(4, [[null, 4]])), { turnedOver: false, duplicateClose: true });
    assert.deepEqual(classifyResetSupersession(context(), snapshot(4, [['cycle-a', 3]])), { turnedOver: false, duplicateClose: false });
  });
  it('does not confuse a later-cycle close with the requested close after overlapping sweeps', () => {
    assert.deepEqual(classifyResetSupersession(context(), snapshot(5, [['cycle-b', 5]])), { turnedOver: false, duplicateClose: false });
    assert.deepEqual(classifyResetSupersession(context(), snapshot(5, [['cycle-a', 4], ['cycle-b', 5]])), { turnedOver: false, duplicateClose: true });
  });
});

describe('cycle reset carry-forward snapshots', () => {
  it('keeps sold buys with their sell, carrying unsold, placed-only and still-open partial buys in order', () => {
    const rows = [
      { tradeId: 'unsold', orderId: 'buy-1' },
      { tradeId: 'closed', orderId: 'buy-2', sellOrderId: 'sold' },
      { tradeId: 'placed-only', orderId: 'buy-3', sellOrderId: 'pending' },
      { tradeId: 'partial', orderId: 'buy-4', sellOrderId: 'partial-sale' },
    ];
    const result = selectCarryForwardBuys({ windowBuys: rows, soldOrderIds: new Set(['sold', 'partial-sale']), openBuyOrderIds: new Set(['buy-4']) });
    assert.deepEqual(result.map(row => row.tradeId), ['unsold', 'placed-only', 'partial']);
    assert.equal(result[0], rows[0]);
    assert.equal(rows.length, 4);
  });
});
