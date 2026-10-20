// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pairCycleFills, foldSellAnnotations } = require('../shared/cycle-pairing.mjs');
const { computeFillsWithPnL } = require('../shared/transactions-regime-pnl.mjs');

const sell = (extra) => ({
  orderId: 'tp', side: 'sell', size: 1, price: 120, quoteAmount: 120,
  netFee: 0, bodyId: 'body', ...extra,
});

test('three annotated partials book one order total in pairing and Transactions', () => {
  const fills = [1, 2, 3].map(timestamp => sell({ timestamp,
    bodyPnl: 30, bodyHoldbackAsset: 0.75, bodyReservesSoldAsset: 0.375,
  }));
  const paired = pairCycleFills(fills);
  assert.deepEqual([paired.realizedPnL, paired.realizedAssetPnL, paired.unpairedSellQty], [30, 0.375, 0]);
  const rows = computeFillsWithPnL(fills);
  assert.deepEqual(rows.map(({ pnl, holdbackAsset }) => ({ pnl, holdbackAsset })),
    Array(3).fill({ pnl: 10, holdbackAsset: 0.125 }));
  assert.deepEqual(rows.reduce((sum, row) => [sum[0] + row.pnl, sum[1] + row.holdbackAsset], [0, 0]), [30, 0.375]);
});

test('first annotations follow ledger order for pairing and stable chronological order for Transactions', () => {
  const fills = [
    sell({ timestamp: 3, bodyPnl: 0, satellitePnl: 999, bodyHoldbackAsset: -1, bodyReservesSoldAsset: '0.25' }),
    sell({ timestamp: 1, satellitePnl: 12, satelliteHoldbackAsset: 0.5, bodyReservesSoldAsset: -2 }),
    sell({ timestamp: 1, bodyPnl: 24, bodyHoldbackAsset: 1, bodyReservesSoldAsset: 0.5 }),
  ];
  const snapshot = structuredClone(fills);
  const paired = pairCycleFills(fills);
  assert.deepEqual([paired.realizedPnL, paired.realizedAssetPnL, paired.unpairedSellQty], [0, -0.25, 0]);
  assert.deepEqual(computeFillsWithPnL(fills).map(({ timestamp, pnl, holdbackAsset }) => ({ timestamp, pnl, holdbackAsset })), [
    { timestamp: 1, pnl: 4, holdbackAsset: null },
    { timestamp: 1, pnl: 4, holdbackAsset: null },
    { timestamp: 3, pnl: 4, holdbackAsset: null },
  ]);
  assert.deepEqual(fills, snapshot);
});

test('Transactions preserves annotated, linked, cost basis, and running-average fallback precedence', () => {
  const fills = [
    { orderId: 'core', side: 'buy', size: 2, quoteAmount: 100, netFee: 0, timestamp: 0 },
    { orderId: 'linked-buy', side: 'buy', sellOrderId: 'linked', size: 1, quoteAmount: 80, netFee: 0, isBodyOwned: true, timestamp: 1 },
    sell({ orderId: 'annotated', timestamp: 2, bodyPnl: 0, bodyCostBasis: 90 }),
    sell({ orderId: 'linked', timestamp: 3, bodyCostBasis: 90 }),
    sell({ orderId: 'basis', timestamp: 4, satelliteCostBasis: 90 }),
    sell({ orderId: 'zero-basis', timestamp: 5, bodyCostBasis: 0 }),
    sell({ orderId: 'average', bodyId: undefined, timestamp: 6 }),
  ];
  assert.deepEqual(computeFillsWithPnL(fills).map(({ pnl, holdbackAsset, avgCost }) => ({ pnl, holdbackAsset, avgCost })), [
    { pnl: null, holdbackAsset: null, avgCost: 50 },
    { pnl: null, holdbackAsset: null, avgCost: 50 },
    { pnl: 0, holdbackAsset: null, avgCost: 50 },
    { pnl: 40, holdbackAsset: null, avgCost: 50 },
    { pnl: 30, holdbackAsset: null, avgCost: 50 },
    { pnl: 70, holdbackAsset: null, avgCost: 50 },
    { pnl: 70, holdbackAsset: null, avgCost: 50 },
  ]);
});

test('shared fold exposes per-order totals and first non-null annotations without mutating rows', () => {
  const fills = [
    sell({ timestamp: 3, bodyPnl: null, satellitePnl: 12, bodyHoldbackAsset: 0, bodyCostBasis: 0, bodyReservesSoldAsset: -1 }),
    sell({ timestamp: 1, bodyPnl: 24, bodyHoldbackAsset: 1, bodyCostBasis: 90, bodyReservesSoldAsset: '0.25' }),
    sell({ timestamp: 2, bodyPnl: 36, bodyHoldbackAsset: 2, bodyReservesSoldAsset: 0.5 }),
    { orderId: 'ignored', side: 'buy' },
  ];
  const snapshot = structuredClone(fills);
  assert.deepEqual(foldSellAnnotations(fills.values()), new Map([['tp', {
    orderId: 'tp', size: 3, quote: 360, fee: 0, proceeds: 360,
    bodyId: 'body', timestamp: 3, pnl: 12, holdback: 0, reservesSold: 0.25, costBasis: 0,
  }]]));
  assert.deepEqual(pairCycleFills(fills.values()), pairCycleFills(fills), 'pairing accepts a single-pass iterable');
  assert.deepEqual(fills, snapshot);
});
