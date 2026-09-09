const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../admin/src/utils/regimeFillGroups.mjs')).href);
const buy = (orderId, extra = {}) => ({ orderId, side: 'buy', size: 2, price: 100, quoteAmount: 200, timestamp: 1, cycleId: 'cycle-1', ...extra });
const sell = (orderId, extra = {}) => ({ orderId, side: 'sell', size: 1, price: 120, quoteAmount: 120, timestamp: 3, cycleId: 'cycle-1', ...extra });

test('partial fills preserve linkage and take annotations once without mutating inputs', async () => {
  const { deriveRegimeFillGroups } = await load();
  const fills = [buy('b'), buy('b', { sellOrderId: 's', timestamp: 2 }),
    sell('s', { isBodyOwned: true, bodyPnl: 40, bodyHoldbackAsset: 0.7 }),
    sell('s', { isBodyOwned: true, bodyPnl: 40, bodyHoldbackAsset: 0.7, timestamp: 4 })];
  const original = structuredClone(fills);
  fills.forEach(Object.freeze); Object.freeze(fills);
  const result = deriveRegimeFillGroups(fills);
  assert.equal(result.sellGroups.length, 1);
  assert.equal(result.sellGroups[0].buys[0].size, 4);
  assert.equal(result.sellGroups[0].sell.size, 2);
  assert.equal(result.sellGroups[0].sell.partialCount, 2);
  assert.equal(result.totalPnl, 40);
  assert.equal(result.totalHoldback, 0.7);
  assert.equal(result.cycleGroups[0].buyCount, 1);
  assert.deepEqual(fills, original);
});

test('later partial annotations, legacy satellite annotations and zero P&L remain authoritative', async () => {
  const { deriveRegimeFillGroups } = await load();
  const result = deriveRegimeFillGroups([sell('s'), sell('s', { satellitePnl: 0, satelliteHoldbackAsset: 0.5 })]);
  assert.equal(result.totalPnl, 0);
  assert.equal(result.totalHoldback, 0.5);
});

test('old TP redirects learn shared body IDs and fallback charges only sold quantity including fees', async () => {
  const { deriveRegimeFillGroups } = await load();
  const result = deriveRegimeFillGroups([
    buy('b1', { sellOrderId: 'old', bodyId: 'body', netFee: 2 }),
    buy('b2', { sellOrderId: 'old' }),
    sell('new', { bodyId: 'body', size: 3, quoteAmount: 360, netFee: 1 })
  ]);
  assert.deepEqual(result.sellGroups[0].buys.map(b => b.orderId), ['b1', 'b2']);
  assert.equal(result.totalPnl, 57); // 359 proceeds - (202 + 100) allocated cost
  assert.equal(result.totalHoldback, 1);
  assert.deepEqual(result.orphanCandidates, []);
});

test('body fallback, direct linkage precedence, unknown cycles and orphan ordering are preserved', async () => {
  const { deriveRegimeFillGroups } = await load();
  const result = deriveRegimeFillGroups([
    buy('fallback', { bodyId: 'fallback' }), sell('s1', { bodyId: 'fallback' }),
    buy('direct', { sellOrderId: 's2' }), buy('unclaimed', { bodyId: 'other', timestamp: 5 }),
    sell('s2', { bodyId: 'other', cycleId: 'cycle-12' }),
    sell('unknown', { cycleId: null }), buy('loose', { timestamp: 8 })
  ]);
  assert.deepEqual(result.cycleGroups.map(c => c.cycleId), ['cycle-12', 'cycle-1', 'unknown']);
  assert.deepEqual(result.sellGroups.find(g => g.sell.orderId === 's2').buys.map(b => b.orderId), ['direct']);
  assert.deepEqual(result.orphanCandidates.map(b => b.orderId), ['loose', 'unclaimed']);
  assert.equal(result.cycleGroups[1].minTs, 1);
  assert.equal(result.cycleGroups[1].maxTs, 3);
  assert.equal(result.sellGroups.find(g => g.sell.orderId === 'unknown').sell.pnl, null);
});

test('search recomputes visible totals and pending TP visibility never mutates cached history', async () => {
  const { deriveRegimeFillGroups, searchRegimeFillGroups, visibleOrphanBuys } = await load();
  const history = deriveRegimeFillGroups([buy('BUY-A', { sellOrderId: 's1' }), sell('s1'), sell('s2', { bodyPnl: 50 }), buy('orphan', { bodyId: 'open' })]);
  const snapshot = structuredClone(history);
  assert.equal(searchRegimeFillGroups(history, ''), history);
  const searched = searchRegimeFillGroups(history, 'buy-a');
  assert.equal(searched.totalPnl, 20);
  assert.equal(searched.totalHoldback, 1);
  assert.equal(searched.cycleGroups[0].sells.length, 1);
  assert.equal(searchRegimeFillGroups(history, 'missing').cycleGroups.length, 0);
  assert.equal(visibleOrphanBuys(history.orphanCandidates, [{ bodyId: 'open', status: 'open' }]).length, 0);
  assert.equal(visibleOrphanBuys(history.orphanCandidates, [{ bodyId: 'open', status: 'filled' }]).length, 1);
  assert.deepEqual(history, snapshot);
});

// Execute the production memo declarations with a dependency-aware hook harness.
// This records invocation counts, not browser/React scheduling or DOM timings.
test('60 price updates reuse history; fills, cycle selection and remount invalidate independently', async () => {
  const utils = await load();
  const source = fs.readFileSync(path.join(__dirname, '../admin/src/components/RegimeDashboard.jsx'), 'utf8');
  const memoSource = source.slice(source.indexOf('  const filteredFills = useMemo'), source.indexOf('  // Derive the most recent cycle ID'));
  assert.ok(memoSource.includes('historicalFillGroups'));
  const reserveSource = source.match(/const reservesUsd = .*\n/)[0];
  const run = new Function('useMemo', 'deriveRegimeFillGroups', 'searchRegimeFillGroups', 'liveFills', 'showAllCycles', 'fillSearchId', 'status', `${memoSource}\nconst { totalHoldback } = searchedFillGroups; const market = status.market; ${reserveSource} return { history: historicalFillGroups, searched: searchedFillGroups, reservesUsd };`);
  let calls = 0, cache = [], cursor = 0;
  const useMemo = (fn, deps) => {
    const slot = cursor++;
    if (!cache[slot] || deps.some((dep, i) => !Object.is(dep, cache[slot].deps[i]))) cache[slot] = { deps, value: fn() };
    return cache[slot].value;
  };
  const fills = [buy('b', { sellOrderId: 's' }), sell('s'), sell('s2', { cycleId: 'cycle-2', bodyPnl: 10 })];
  const render = (price, snapshot = fills, all = true, search = '') => {
    cursor = 0;
    return run(useMemo, (...args) => { calls++; return utils.deriveRegimeFillGroups(...args); }, utils.searchRegimeFillGroups, snapshot, all, search, { market: { lastPrice: price }, pendingOrders: [] });
  };
  const first = render(100);
  for (let i = 1; i <= 60; i++) {
    const next = render(100 + i);
    assert.equal(next.history, first.history);
    assert.equal(next.searched.cycleGroups, first.searched.cycleGroups);
    assert.equal(next.reservesUsd, 100 + i);
  }
  assert.equal(calls, 1);
  render(200, fills, true, 'b'); assert.equal(calls, 1);
  assert.equal(render(200, fills, false).history.sellGroups.length, 1); assert.equal(calls, 2);
  const refreshed = [...fills, sell('s3')];
  render(200, refreshed); assert.equal(calls, 3);
  cache = []; render(200, refreshed); assert.equal(calls, 4);
});
