// @ts-check
// Issue #700: the RegimeDashboard "Open Orders" buy linkage (which buys a resting
// TP covers) used to live in a render-time closure that re-sorted the filtered
// fills once per open TP and read the Filled Orders "current cycle" toggle.
// It is now the pure admin/src/utils/openOrderRelations.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../admin/src/utils/openOrderRelations.mjs')).href);

const buy = (orderId, extra = {}) => ({ orderId, side: 'buy', size: 1, price: 100, quoteAmount: 100, timestamp: 1, cycleId: 'cycle-1', ...extra });
const sell = (orderId, extra = {}) => ({ orderId, side: 'sell', size: 1, price: 120, quoteAmount: 120, timestamp: 5, cycleId: 'cycle-1', ...extra });
const tp = (orderId, extra = {}) => ({ orderId, type: 'take_profit', status: 'open', size: 1, price: 120, placedAt: 1000, ...extra });
const ids = (rows) => rows.map(r => r.orderId);

test('body TP uses the body buyOrders, skipping migration artifacts', async () => {
  const { relatedBuysForOrder } = await load();
  const body = {
    tpOrderId: 'tp-body',
    buyOrders: [
      { orderId: 'b1', assetQty: 0.5, price: 90 },
      { orderId: 'core-migration', assetQty: 1 },
      { orderId: 'b2', assetQty: 0 },
      { orderId: null, assetQty: 1 },
    ],
  };
  const bodyLookup = new Map([['tp-body', body]]);
  // The ledger also links a buy to this TP — body.buyOrders wins.
  const fills = [buy('ledger', { sellOrderId: 'tp-body' })];
  assert.deepEqual(ids(relatedBuysForOrder(tp('tp-body', { type: 'body_tp' }), { bodyLookup, fills })), ['b1']);

  // Only artifacts left → fall through to the ledger stamp.
  const artifactsOnly = new Map([['tp-body', { buyOrders: [{ orderId: 'core-migration', assetQty: 1 }] }]]);
  assert.deepEqual(ids(relatedBuysForOrder(tp('tp-body', { type: 'body_tp' }), { bodyLookup: artifactsOnly, fills })), ['ledger']);
});

test('non-TP orders have no related buys', async () => {
  const { relatedBuysForOrder } = await load();
  const fills = [buy('b1')];
  assert.deepEqual(relatedBuysForOrder({ orderId: 'e1', type: 'entry' }, { bodyLookup: new Map(), fills }), []);
  assert.deepEqual(relatedBuysForOrder({ orderId: 'e2', type: 'ladder_entry' }, { bodyLookup: new Map(), fills }), []);
});

test('sellOrderId linkage aggregates partials per order, using the shared pairing rules', async () => {
  const { relatedBuysForOrder } = await load();
  const fills = [
    // Stamp only on the second partial row — the whole order still links (cycle-pairing rule).
    buy('b1', { size: 0.4, quoteAmount: 40, timestamp: 1 }),
    buy('b1', { size: 0.6, quoteAmount: 60, timestamp: 2, sellOrderId: 'tp-1' }),
    // Two distinct orderless rows must not collapse into one (#108).
    buy(undefined, { tradeId: 't-a', sellOrderId: 'tp-1', timestamp: 3 }),
    buy(undefined, { tradeId: 't-b', sellOrderId: 'tp-1', timestamp: 4 }),
    buy('other', { sellOrderId: 'tp-2' }),
  ];
  const original = structuredClone(fills);
  const rows = relatedBuysForOrder(tp('tp-1'), { bodyLookup: new Map(), fills });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { orderId: 'b1', price: 100, assetQty: 1, sizeUsdc: 100, filledAt: 1 });
  assert.deepEqual(rows.slice(1).map(r => r.filledAt), [3, 4]);
  assert.deepEqual(fills, original, 'inputs are never mutated');
});

test('live fallback: core buys since the last core sell, ignoring body fills, restarting at a cycle boundary', async () => {
  const { relatedBuysForOrder } = await load();
  const fills = [
    buy('old', { timestamp: 1 }),
    sell('core-sell', { timestamp: 2 }),
    buy('kept', { timestamp: 3 }),
    buy('body-buy', { timestamp: 4, isBodyOwned: true }),
    sell('body-sell', { timestamp: 5, isBodyOwned: true }), // body sells never reset the core walk
    buy('kept2', { timestamp: 6 }),
  ];
  assert.deepEqual(ids(relatedBuysForOrder(tp('core-tp'), { bodyLookup: new Map(), fills })), ['kept', 'kept2']);

  // Cycles are atomic: a cycle that ended without a core sell does not leak its buys.
  const crossCycle = [
    buy('prev-cycle', { timestamp: 1, cycleId: 'cycle-1' }),
    buy('this-cycle', { timestamp: 2, cycleId: 'cycle-2' }),
    buy('no-cycle', { timestamp: 3, cycleId: null }),
  ];
  assert.deepEqual(ids(relatedBuysForOrder(tp('core-tp'), { bodyLookup: new Map(), fills: crossCycle })), ['this-cycle', 'no-cycle']);
});

test('dry-run: no ledger stamps, fallback is the buys no core TP has consumed', async () => {
  const { relatedBuysForOrder } = await load();
  const dryRunFilled = [
    { orderId: 'd3', side: 'buy', size: 2, price: 95, fillPrice: 94, filledAt: 30 },
    { orderId: 'd1', side: 'buy', size: 1, price: 100, filledAt: 10 },
    { orderId: 'core-tp', side: 'sell', type: 'take_profit', size: 1, price: 110, filledAt: 20 },
    { orderId: 'body-tp', side: 'sell', type: 'body_tp', size: 1, price: 120, filledAt: 40 },
    { orderId: 'd4', side: 'buy', size: 1, price: 90, placedAt: 50 },
  ];
  const fills = [buy('ledger', { sellOrderId: 'tp-1' })]; // ignored in dry-run
  const rows = relatedBuysForOrder(tp('tp-1'), { bodyLookup: new Map(), fills, dryRunFilled, isDryRun: true });
  assert.deepEqual(ids(rows), ['d3', 'd4']);
  assert.deepEqual(rows[0], { orderId: 'd3', price: 94, assetQty: 2, sizeUsdc: 188, filledAt: 30 });
});

test('Open Orders relations do not depend on the Filled Orders current-cycle toggle', async () => {
  const { buildOpenOrderRelationIndex, relatedBuysForOrder } = await load();
  const fills = [
    buy('c1-buy', { cycleId: 'cycle-1', timestamp: 1, sellOrderId: 'c1-tp' }),
    sell('c1-tp', { cycleId: 'cycle-1', timestamp: 2 }),
    buy('c2-linked', { cycleId: 'cycle-2', timestamp: 3, sellOrderId: 'c2-tp' }),
    buy('c2-core', { cycleId: 'cycle-2', timestamp: 4 }),
    buy('c2-core-b', { cycleId: 'cycle-2', timestamp: 5 }),
  ];
  const currentCycleOnly = fills.filter(f => f.cycleId === 'cycle-2');
  const orders = [tp('c2-tp'), tp('legacy-core-tp')];
  const all = buildOpenOrderRelationIndex({ fills });
  const current = buildOpenOrderRelationIndex({ fills: currentCycleOnly });
  for (const order of orders) {
    assert.deepEqual(
      relatedBuysForOrder(order, { bodyLookup: new Map(), index: all }),
      relatedBuysForOrder(order, { bodyLookup: new Map(), index: current }),
      `${order.orderId} relations must match across the toggle`,
    );
  }
  assert.deepEqual(ids(relatedBuysForOrder(tp('c2-tp'), { bodyLookup: new Map(), index: all })), ['c2-linked']);
  assert.deepEqual(ids(relatedBuysForOrder(tp('legacy-core-tp'), { bodyLookup: new Map(), index: all })), ['c2-linked', 'c2-core', 'c2-core-b']);

  // Wiring: the dashboard hands Open Orders the unfiltered ledger, and the toggle lives in the Filled Orders section.
  const src = (rel) => fs.readFileSync(path.join(__dirname, '../admin/src/components', rel), 'utf8');
  const dashboard = src('RegimeDashboard.jsx');
  assert.match(dashboard, /<OpenOrdersTable[\s\S]*?liveFills=\{liveFills\}[\s\S]*?\/>/);
  assert.doesNotMatch(dashboard, /filteredFills|showAllCycles/);
  assert.match(src('regime/FilledOrdersSection.jsx'), /const \[showAllCycles, setShowAllCycles\] = useState\(true\)/);
  assert.doesNotMatch(src('regime/OpenOrdersTable.jsx'), /filteredFills|showAllCycles/);
});

test('deriveOpenOrderRows: open orders only, estimates + relations + age, sorted by price desc', async () => {
  const { buildOpenOrderRelationIndex, deriveOpenOrderRows } = await load();
  const index = buildOpenOrderRelationIndex({ fills: [buy('b1', { sellOrderId: 'tp-hi' })] });
  const pending = [
    { orderId: 'entry', type: 'entry', status: 'open', size: 1, price: 90, placedAt: 500 },
    tp('tp-hi', { price: 130, placedAt: 400 }),
    tp('gone', { status: 'filled', price: 200 }),
  ];
  const original = structuredClone(pending);
  const rows = deriveOpenOrderRows(pending, { bodyLookup: new Map(), index, avgCost: 100, holdbackRatio: 0.5, feeRatePerSide: 0.001, now: 1000 });
  assert.deepEqual(ids(rows), ['tp-hi', 'entry']);
  assert.equal(rows[0].age, 600);
  assert.deepEqual(ids(rows[0].relatedBuys), ['b1']);
  assert.deepEqual(rows[1].relatedBuys, []);
  assert.ok(Math.abs(rows[0].estPnl - (130 - 0.13 - 100)) < 1e-9);
  assert.equal(rows[1].estPnl, null);
  assert.deepEqual(pending, original);
});
