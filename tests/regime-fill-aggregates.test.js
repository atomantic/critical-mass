const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/regime-aggregate-fixture');
const { aggregateRegimeFills } = require('../shared/regime-fill-aggregates.mjs');
const { computeFillsWithPnL } = require('../shared/transactions-regime-pnl.mjs');
const { summarizeFills } = require('../shared/transactions-regime-page.mjs');
const { createTransactionsReadView } = require('../src/transactions-regime-query');

test('cached aggregate parity with legacy dashboard, chart and cost-basis results', async () => {
  const { deriveRegimeFillGroups, deriveRegimeCumulativePnl } = await import('../admin/src/utils/regimeFillGroups.mjs');
  let rows = fixture();
  let revision = 'one';
  let reads = 0;
  const view = createTransactionsReadView(() => { reads++; return rows; }, () => revision);
  const actual = view.aggregates();
  const history = deriveRegimeFillGroups(rows);
  const points = deriveRegimeCumulativePnl({ fills: rows });
  assert.equal(actual.totalPnl, history.totalPnl);
  assert.ok(Math.abs(actual.totalHoldback - history.totalHoldback) < 1e-10);
  assert.deepEqual(actual.fillCycleGroups.map(c => [c.cycleId, c.totalPnl, c.totalHoldback, c.buyCount]),
    history.cycleGroups.map(c => [c.cycleId, c.totalPnl, c.totalHoldback, c.buyCount]));
  assert.deepEqual(actual.pnlPoints, points.map(p => ({ timestamp: p.date.getTime(), pnl: p.pnl, cumulative: p.cumulative })));
  assert.deepEqual(actual.cycles.map(c => [c.cycleId, c.entryCount, c.exitCount, c.totalBought, c.totalSold, c.totalCost, c.totalProceeds]), [
    ['cycle-2', 2, 1, 1.2, 0.8, 363.5, 318],
    ['cycle-1', 2, 2, 2, 1.8, 303, 268],
  ]);
  assert.equal(actual.buyCount, 4);
  assert.equal(actual.sellCount, 3);
  assert.equal(actual.fillCount, 7);
  assert.equal(view.aggregates(), actual);
  view.query({ paged: true });
  assert.equal(reads, 1, 'aggregate and page share the same revision snapshot');
  rows = [...rows, { tradeId: 'new', orderId: 'new', side: 'buy', cycleId: 'cycle-3', timestamp: 8000, size: 1, price: 10, quoteAmount: 10 }];
  revision = 'two';
  assert.equal(view.aggregates().fillCount, 8);
  assert.equal(reads, 2);
});

test('out-of-order partial annotations keep the raw ledger pairing order', async () => {
  const { deriveRegimeFillGroups, deriveRegimeCumulativePnl } = await import('../admin/src/utils/regimeFillGroups.mjs');
  const rows = fixture().reverse();
  const result = createTransactionsReadView(() => rows, () => 'reverse').aggregates();
  const legacy = deriveRegimeFillGroups(rows);
  const points = deriveRegimeCumulativePnl({ fills: rows });
  assert.equal(result.totalPnl, legacy.totalPnl);
  assert.equal(result.totalHoldback, legacy.totalHoldback);
  assert.deepEqual(result.pnlPoints, points.map(point => ({
    timestamp: point.date.getTime(), pnl: point.pnl, cumulative: point.cumulative,
  })));
});

test('30,000 fills with 15,000 cycles and fragmented open buys remain below 1 MB', () => {
  const rows = Array.from({ length: 30000 }, (_, i) => ({
    tradeId: `trade-${i}`, orderId: `order-${i}`, side: i % 2 ? 'sell' : 'buy',
    cycleId: `cycle-${Math.floor(i / 2)}`, timestamp: 1000 + i,
    size: 0.01, price: 100, quoteAmount: 1, netFee: 0.01,
    ...(i % 2 ? { bodyPnl: 0.1, bodyHoldbackAsset: 0.001 } : { sellOrderId: `order-${i + 1}` }),
  }));
  const view = createTransactionsReadView(() => rows, () => 'large');
  const result = view.aggregates();
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(bytes < 1_000_000, `aggregate response is ${bytes} bytes`);
  assert.equal(result.fillCount, 30000);
  assert.equal(result.cycleCount, 15000);
  assert.equal(result.cycles.length, 250);
  assert.equal(result.fillCycleGroups.length, 250);
  assert.ok(result.detailsTruncated);
  assert.ok(result.pnlPointsTruncated);
  assert.equal(result.pnlPoints.length, 500);
  assert.ok(result.cyclesTruncated);
  assert.ok(Math.abs(result.totalPnl - 1500) < 1e-8);
});

test('fragmented sell and open TP stay exact in totals while details are marked incomplete', async () => {
  const { deriveRegimeFillGroups } = await import('../admin/src/utils/regimeFillGroups.mjs');
  const rows = [];
  for (let i = 0; i < 510; i++) rows.push({
    tradeId: `b-${i}`, orderId: 'buy-fragmented', side: 'buy', cycleId: 'cycle-1',
    timestamp: i + 1, size: 0.01, price: 100, quoteAmount: 1,
    sellOrderId: 'sell-fragmented',
  });
  for (let i = 0; i < 5; i++) rows.push({
    tradeId: `s-${i}`, orderId: 'sell-fragmented', side: 'sell', cycleId: 'cycle-1',
    timestamp: 600 + i, size: 1, price: 120, quoteAmount: 120,
    satellitePnl: 90, satelliteHoldbackAsset: 0.1,
  });
  for (let i = 0; i < 120; i++) rows.push({
    tradeId: `open-${i}`, orderId: 'open-buy', side: 'buy', cycleId: 'cycle-2',
    timestamp: 700 + i, size: 0.01, price: 100, quoteAmount: 1,
    sellOrderId: 'open-tp',
  });
  const view = createTransactionsReadView(() => rows, () => 'fragmented');
  const result = view.aggregates();
  const previous = deriveRegimeFillGroups(rows);
  assert.equal(result.totalPnl, previous.totalPnl);
  assert.equal(result.totalHoldback, previous.totalHoldback);
  assert.equal(result.totalPnl, 90, 'satellite annotation is counted once across partial sells');
  assert.equal(result.sellCount, 5);
  assert.equal(result.cycles[0].entryCount, 120);
  assert.equal(result.fillCycleGroups[0].totalPnl, 90);
  assert.equal(result.detailsTruncated, true);
  assert.equal(result.detailFills.some(row => row.orderId === 'sell-fragmented'), false,
    'an incomplete sell group must never be presented as complete');
  assert.equal(result.openFillsTruncated, true);
  assert.equal(result.openFills.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_000_000);
});

test('projected sell annotations preserve consumed-buy proration without exposing consumption records', async () => {
  const { deriveRegimeFillGroups } = await import('../admin/src/utils/regimeFillGroups.mjs');
  const rows = [
    { tradeId: 'b', orderId: 'b', side: 'buy', cycleId: 'cycle-1', timestamp: 1,
      size: 2, price: 100, quoteAmount: 200, sellOrderId: 's1', consumedBy: { s1: 1, s2: 1 } },
    { tradeId: 's1', orderId: 's1', side: 'sell', cycleId: 'cycle-1', timestamp: 2,
      size: 1, price: 120, quoteAmount: 120 },
    { tradeId: 's2', orderId: 's2', side: 'sell', cycleId: 'cycle-2', timestamp: 3,
      size: 1, price: 130, quoteAmount: 130, bodyPnl: 30 },
  ];
  const full = deriveRegimeFillGroups(rows);
  const result = createTransactionsReadView(() => rows, () => 'consumed').aggregates();
  const displayed = deriveRegimeFillGroups(result.detailFills);
  assert.equal(full.sellGroups.find(g => g.sell.orderId === 's1').sell.pnl, 20);
  assert.equal(displayed.sellGroups.find(g => g.sell.orderId === 's1').sell.pnl, 20);
  assert.equal(displayed.totalPnl, full.totalPnl);
  assert.equal(displayed.totalHoldback, full.totalHoldback);
  assert.ok(result.detailFills.every(row => !('consumedBy' in row)));
});

test('cycle display count preserves the legacy same-body buy fallback', async () => {
  const { deriveRegimeFillGroups } = await import('../admin/src/utils/regimeFillGroups.mjs');
  const rows = [
    { tradeId: 'b', orderId: 'b', side: 'buy', cycleId: 'cycle-1', timestamp: 1,
      size: 1, price: 100, quoteAmount: 100, bodyId: 'body' },
    { tradeId: 's', orderId: 's', side: 'sell', cycleId: 'cycle-1', timestamp: 2,
      size: 1, price: 120, quoteAmount: 120, bodyId: 'body' },
  ];
  const legacy = deriveRegimeFillGroups(rows);
  const aggregate = createTransactionsReadView(() => rows, () => 'body').aggregates();
  assert.equal(aggregate.fillCycleGroups[0].buyCount, legacy.cycleGroups[0].buyCount);
  assert.equal(aggregate.fillCycleGroups[0].minTs, legacy.cycleGroups[0].minTs);
  assert.equal(aggregate.totalPnl, legacy.totalPnl);
});

for (const first of ['aggregates', 'query']) test(`${first}-first reads preserve accounting and invalidate both caches across revisions`, () => {
  // Reverse ledger order intentionally: aggregate pairing must keep raw order,
  // while transaction P&L enriches the complete chronological ledger.
  let rows = fixture().reverse();
  let revision = 'initial';
  let reads = 0;
  const view = createTransactionsReadView(() => { reads++; return rows; }, () => revision);
  let previousAggregate;
  for (const [index, transition] of ['initial', 'new-fill', 'reload', 'replacement'].entries()) {
    if (transition === 'new-fill') rows.push({ tradeId: 'new', orderId: 'new', side: 'buy', cycleId: 'cycle-3', timestamp: 8000, size: 1, price: 10, quoteAmount: 10 });
    if (transition === 'reload') rows = fixture().map(row => ({ ...row, cycleId: 'cycle-9' }));
    if (transition === 'replacement') rows = [];
    revision = transition;
    const expectedAggregate = { ...aggregateRegimeFills(rows), revision };
    const expectedSummary = summarizeFills(computeFillsWithPnL(rows));
    if (first === 'aggregates') view.aggregates();
    else view.query({ paged: true });
    const aggregate = view.aggregates();
    assert.deepEqual(aggregate, expectedAggregate, transition);
    assert.notEqual(aggregate, previousAggregate);
    assert.equal(view.aggregates(), aggregate, 'aggregate object is reused within the revision');
    assert.deepEqual(view.query({ paged: true }).summary, expectedSummary, transition);
    assert.deepEqual(view.query({ paged: true, sortField: 'pnl', side: 'sell' }).summary,
      summarizeFills(computeFillsWithPnL(rows).filter(row => row.side === 'sell')), transition);
    assert.deepEqual(view.aggregates({ revision }), { unchanged: true, revision });
    assert.equal(reads, index + 1, 'both representations share one raw read per revision');
    previousAggregate = aggregate;
  }
});
