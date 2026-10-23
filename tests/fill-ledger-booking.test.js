// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBookingStore } = require('../src/fill-ledger-booking');

test('a late sell row stays unbooked until its tranche commits, and credit is persisted before return', () => {
  const first = { tradeId: 'sell-1', orderId: 'tp-1', side: 'sell', size: 0.002, timestamp: 1 };
  const late = { tradeId: 'sell-2', orderId: 'tp-1', side: 'sell', size: 0.001, timestamp: 2 };
  const fills = new Map([[first.tradeId, first], [late.tradeId, late]]);
  const persisted = [];
  let dirty = false;
  let version = 0;
  const store = createBookingStore({
    fills,
    getFillsForOrder: orderId => [...fills.values()].filter(f => f.orderId === orderId)
      .sort((a, b) => a.timestamp - b.timestamp),
    setDirty: () => { dirty = true; },
    bumpLedgerVersion: () => { version += 1; },
    persist: () => {
      assert.equal(dirty, true, 'credit is dirty before persistence');
      persisted.push([...fills.values()].map(f => ({
        tradeId: f.tradeId, credited: f.capitalCredited, size: f.capitalCreditedSize,
      })));
      dirty = false;
    },
  });

  assert.equal(store.commitSellBooking('tp-1', { bodyPnl: 3, partialFill: true },
    { soldSize: 0.002, bookedTradeIds: ['sell-1'] }), 0.002);
  assert.deepEqual(store.getUnbookedSellFills('tp-1').map(f => f.tradeId), ['sell-2']);
  assert.equal(store.commitSellBooking('tp-1', { bodyPnl: 2, partialFill: false },
    { additive: true, soldSize: 0.001, bookedTradeIds: ['sell-2'] }), 0.003);
  assert.equal(store.getSellBooking('tp-1').bodyPnl, 5);
  assert.deepEqual(store.getUnbookedSellFills('tp-1'), []);
  assert.equal(first.partialFill, undefined);
  assert.equal(late.partialFill, undefined);

  assert.equal(store.claimCapitalCredit('tp-1', 0.003), true);
  assert.deepEqual(persisted, [[
    { tradeId: 'sell-1', credited: true, size: 0.003 },
    { tradeId: 'sell-2', credited: true, size: 0.003 },
  ]], 'both partial rows are durable before the caller credits capital');
  assert.equal(store.claimCapitalCredit('tp-1', 0.003), false, 'the same booking cannot credit twice');
  assert.equal(persisted.length, 1, 'a replay does not rewrite the ledger');
  assert.ok(version >= 3, 'booking and credit invalidate derived reads');
});
