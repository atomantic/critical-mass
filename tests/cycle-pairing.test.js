// @ts-check
// Issue #697: shared/cycle-pairing.mjs is the one pairing rule set behind the
// server's realized P&L and the admin Filled Orders view. It must load through
// CommonJS require() (the server) as well as ESM import (the Vite admin build).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.join(__dirname, '../shared/cycle-pairing.mjs');
const { pairCycleFills, buyPairKey } = require(MODULE);

const buy = (orderId, extra = {}) => ({ orderId, side: 'buy', size: 1, price: 100, quoteAmount: 100, netFee: 0, timestamp: 1, ...extra });
const sell = (orderId, extra = {}) => ({ orderId, side: 'sell', size: 1, price: 110, quoteAmount: 110, netFee: 0, timestamp: 5, ...extra });

test('loads identically through require() and import()', async () => {
  const esm = await import(pathToFileURL(MODULE).href);
  assert.equal(esm.pairCycleFills, pairCycleFills);
  assert.equal(esm.buyPairKey, buyPairKey);
});

test('no-orderId buys key by tradeId', () => {
  assert.equal(buyPairKey({ orderId: 'o1', tradeId: 't1' }), 'o1');
  assert.equal(buyPairKey({ orderId: undefined, tradeId: 't1' }), '__noorder__:t1');
});

test('orphaned sellOrderId redirects to the latest filled sell of the body, learning bodyId from a sibling buy', () => {
  const fills = [
    buy('b1', { sellOrderId: 'gone', bodyId: 'body' }),
    buy('b2', { sellOrderId: 'gone' }),
    sell('early', { bodyId: 'body', timestamp: 2, bodyPnl: 1, bodyHoldbackAsset: 0 }),
    sell('late', { bodyId: 'body', size: 1.5, quoteAmount: 165, timestamp: 9 }),
  ];
  const snapshot = structuredClone(fills);
  const p = pairCycleFills(fills);
  assert.deepEqual(p.sells.get('late')?.buyKeys, ['b1', 'b2']);
  assert.equal(p.buys.get('b2')?.pairedSellOrderId, 'late');
  // 165 − 200 × 1.5/2 = 15, plus the annotated 1
  assert.equal(p.sells.get('late')?.pnl, 15);
  assert.equal(p.realizedPnL, 16);
  assert.equal(p.realizedAssetPnL, 0.5);
  assert.deepEqual(fills, snapshot, 'input is never mutated');
});

test('annotations are taken once per order; negative holdback annotations book nothing', () => {
  const p = pairCycleFills([
    sell('s', { bodyPnl: 3, bodyHoldbackAsset: -0.1 }),
    sell('s', { bodyPnl: 3, bodyHoldbackAsset: -0.1 }),
  ]);
  assert.equal(p.realizedPnL, 3);
  assert.equal(p.realizedAssetPnL, 0);
});

test('an unannotated sell with no linked buys is unpaired, not zero-cost profit', () => {
  const p = pairCycleFills([sell('s', { size: 0.4 })]);
  assert.equal(p.sells.get('s')?.pnl, null);
  assert.equal(p.realizedPnL, 0);
  assert.equal(p.unpairedSellQty, 0.4);
});

test('a sell larger than its linked buys charges their full cost, never more', () => {
  const p = pairCycleFills([buy('b', { sellOrderId: 's' }), sell('s', { size: 2, quoteAmount: 220 })]);
  assert.equal(p.sells.get('s')?.pnl, 120);
  assert.equal(p.sells.get('s')?.holdback, 0);
});

test('a consumedBy record limits the linked share, so an open remainder is not booked as holdback', () => {
  // Buy of 2 partly sold by the earlier (unannotated) TP, then re-linked to a
  // resting replacement TP; the bodyId redirect pairs it with the earlier sell.
  const p = pairCycleFills([
    buy('b', { size: 2, quoteAmount: 200, sellOrderId: 'tp-resting', bodyId: 'body', consumedBy: { 'tp-partial': 1 } }),
    sell('tp-partial', { bodyId: 'body', size: 1, quoteAmount: 110 }),
  ]);
  assert.equal(p.buys.get('b')?.pairedSellOrderId, 'tp-partial');
  assert.equal(p.sells.get('tp-partial')?.holdback, 0);
  assert.equal(p.sells.get('tp-partial')?.pnl, 10);
});
