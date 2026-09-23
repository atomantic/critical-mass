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
  assert.equal(result.totalPnl, 57.5); // 359 proceeds - 402 linked cost x 3/4 sold (CLAUDE.md proration, #697)
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

// Issue #700: the dry-run Filled Orders walk moved out of a render closure.
test('dry-run groups: core sells consume accumulated buys, body sells consume none, input untouched', async () => {
  const { deriveDryRunFillGroups } = await load();
  const orders = [
    { orderId: 'b2', side: 'buy', size: 1, filledAt: 20 },
    { orderId: 'b1', side: 'buy', size: 1, placedAt: 10 },
    { orderId: 'core-1', side: 'sell', type: 'take_profit', pnl: 5, holdbackAsset: 0.1, filledAt: 30 },
    { orderId: 'body-1', side: 'sell', type: 'body_tp', pnl: 2, holdbackAsset: 0.05, filledAt: 40 },
    { orderId: 'sat-1', side: 'sell', type: 'take_profit', isSatellite: true, pnl: 1, filledAt: 45 },
    { orderId: 'b3', side: 'buy', size: 1, filledAt: 50 },
  ];
  const original = structuredClone(orders);
  Object.freeze(orders);
  const result = deriveDryRunFillGroups(orders);
  assert.deepEqual(result.sellGroups.map(g => g.sell.orderId), ['sat-1', 'body-1', 'core-1']);
  assert.deepEqual(result.sellGroups.map(g => g.key), ['fill-sat-1', 'fill-body-1', 'fill-core-1']);
  assert.deepEqual(result.sellGroups[2].buys.map(b => b.orderId), ['b1', 'b2']);
  assert.deepEqual(result.sellGroups[0].buys, []);
  assert.deepEqual(result.sellGroups[1].buys, []);
  assert.deepEqual(result.pendingBuys.map(b => b.orderId), ['b3']);
  assert.equal(result.totalPnl, 8);
  assert.ok(Math.abs(result.totalHoldback - 0.15) < 1e-12);
  assert.deepEqual(orders, original);
  assert.deepEqual(deriveDryRunFillGroups(), { sellGroups: [], pendingBuys: [], totalPnl: 0, totalHoldback: 0 });
});

test('dry-run search matches sell or buy IDs case-insensitively and recomputes totals', async () => {
  const { deriveDryRunFillGroups, searchDryRunFillGroups } = await load();
  const history = deriveDryRunFillGroups([
    { orderId: 'BUY-A', side: 'buy', filledAt: 1 },
    { orderId: 'tp-1', side: 'sell', type: 'take_profit', pnl: 3, holdbackAsset: 0.2, filledAt: 2 },
    { orderId: 'tp-2', side: 'sell', type: 'body_tp', pnl: 7, holdbackAsset: 0.4, filledAt: 3 },
  ]);
  assert.equal(searchDryRunFillGroups(history, ''), history);
  const byBuy = searchDryRunFillGroups(history, 'buy-a');
  assert.deepEqual(byBuy.sellGroups.map(g => g.sell.orderId), ['tp-1']);
  assert.equal(byBuy.totalPnl, 3);
  assert.equal(byBuy.totalHoldback, 0.2);
  assert.equal(searchDryRunFillGroups(history, 'TP-2').totalPnl, 7);
  assert.equal(searchDryRunFillGroups(history, 'missing').sellGroups.length, 0);
  assert.equal(history.totalPnl, 10);
});

// Execute the production memo declarations with a dependency-aware hook harness.
// This records invocation counts, not browser/React scheduling or DOM timings.
test('60 price updates reuse history; fills, cycle selection and remount invalidate independently', async () => {
  const utils = await load();
  // The Filled Orders memos moved out of RegimeDashboard.jsx with the section (#700).
  const source = fs.readFileSync(path.join(__dirname, '../admin/src/components/regime/FilledOrdersSection.jsx'), 'utf8');
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

// ---------------------------------------------------------------------------
// Issue #697: the Filled Orders grand total and the Position card's realized
// P&L are computed by one shared rule set (shared/cycle-pairing.mjs). Feed the
// SAME fills to the real server ledger and to deriveRegimeFillGroups and
// require identical totals. Ledgers live under a disposable temp root.
// ---------------------------------------------------------------------------
const { after } = require('node:test');
const { createIsolatedDataDir } = require('./test-data-dir');
const { buildRealisticCycleLedger } = require('./helpers/realistic-cycle-ledger');
const isolatedData = createIsolatedDataDir('cm-regime-fill-groups-parity-test');
after(() => isolatedData.cleanup());

let ledgerSeq = 0;
const newLedger = () => {
  const { createFillLedger } = require('../src/fill-ledger');
  ledgerSeq += 1;
  const ledger = createFillLedger(`parity-${ledgerSeq}`, 'BTC-USDC', 'BTC-USDC', { quiet: true });
  ledger.startNewCycle();
  return ledger;
};
let tradeSeq = 0;
const ingest = (ledger, side, orderId, price, size, fee = '0') => {
  tradeSeq += 1;
  ledger.ingestFill({
    tradeId: `p-${side}-${tradeSeq}`, orderId, side, price: String(price), size: String(size),
    totalCommission: fee, rebate: '0', liquidityIndicator: 'MAKER',
    tradeTime: new Date(Date.parse('2026-09-01T00:00:00Z') + tradeSeq * 60_000).toISOString(),
  });
};
const setOnTrade = (ledger, tradeId, fields) => {
  for (const f of ledger.getAllFills()) if (f.tradeId === tradeId) Object.assign(f, fields);
  ledger.markDirty();
};
const assertParity = async (ledger, expected) => {
  const { deriveRegimeFillGroups } = await load();
  const server = ledger.computeRealizedFromCyclePairs();
  const client = deriveRegimeFillGroups(ledger.getAllFills());
  assert.ok(Math.abs(client.totalPnl - server.realizedPnL) < 0.005,
    `client totalPnl ${client.totalPnl} != server realizedPnL ${server.realizedPnL}`);
  assert.ok(Math.abs(client.totalHoldback - server.realizedAssetPnL) < 1e-9,
    `client totalHoldback ${client.totalHoldback} != server realizedAssetPnL ${server.realizedAssetPnL}`);
  if (expected) {
    assert.equal(server.realizedPnL, expected.realizedPnL);
    assert.equal(server.realizedAssetPnL, expected.realizedAssetPnL);
  }
  return { server, client };
};

test('#697 A: unannotated sell with holdback charges prorated linked cost on both sides', async () => {
  const ledger = newLedger();
  ingest(ledger, 'buy', 'b1', 100, 1);
  ingest(ledger, 'buy', 'b2', 100, 1);
  ledger.annotateFillsByOrderIds(['b1', 'b2'], { sellOrderId: 's1' });
  ingest(ledger, 'sell', 's1', 120, 1.8);
  // proceeds 216 − 200 × (1.8 / 2) = 36; holdback 0.2
  await assertParity(ledger, { realizedPnL: 36, realizedAssetPnL: 0.2 });
});

test('#697 B: buys stamped with a re-placed TP id pair with the real sell through bodyId', async () => {
  const ledger = newLedger();
  ingest(ledger, 'buy', 'b1', 100, 1);
  ledger.annotateFillsByOrderId('b1', { sellOrderId: 'old', bodyId: 'body1' });
  ingest(ledger, 'sell', 's-new', 110, 0.9);
  ledger.annotateFillsByOrderId('s-new', { bodyId: 'body1' });
  // 99 − 100 × 0.9 = 9; holdback 0.1
  const { server, client } = await assertParity(ledger, { realizedPnL: 9, realizedAssetPnL: 0.1 });
  assert.deepEqual(client.sellGroups[0].buys.map(b => b.orderId), ['b1']);
  // Its cost is now in realized, so it must not also be held open.
  assert.equal(server.heldOpenBuyCostBasis, 0);
  assert.equal(server.heldOpenAssetQty, 0);
});

test('#697 C: a body-owned sell with only a holdback annotation uses it and prorates cost', async () => {
  const ledger = newLedger();
  ingest(ledger, 'buy', 'b1', 100, 1);
  ledger.annotateFillsByOrderId('b1', { sellOrderId: 's1', isBodyOwned: true });
  ingest(ledger, 'sell', 's1', 110, 0.9);
  ledger.annotateFillsByOrderId('s1', { isBodyOwned: true, bodyHoldbackAsset: 0.08 });
  await assertParity(ledger, { realizedPnL: 9, realizedAssetPnL: 0.08 });
});

test('#697: a holdback annotation wins even without isBodyOwned', async () => {
  const ledger = newLedger();
  ingest(ledger, 'buy', 'b1', 100, 1);
  ledger.annotateFillsByOrderId('b1', { sellOrderId: 's1' });
  ingest(ledger, 'sell', 's1', 110, 0.9);
  ledger.annotateFillsByOrderId('s1', { bodyHoldbackAsset: 0.05 });
  await assertParity(ledger, { realizedPnL: 9, realizedAssetPnL: 0.05 });
});

test('#697: no-orderId buys linked to different sells stay distinct', async () => {
  const ledger = newLedger();
  ingest(ledger, 'buy', undefined, 100, 1);
  const first = tradeSeq;
  ingest(ledger, 'buy', undefined, 50, 1);
  const second = tradeSeq;
  setOnTrade(ledger, `p-buy-${first}`, { sellOrderId: 's1' });
  setOnTrade(ledger, `p-buy-${second}`, { sellOrderId: 's2' });
  ingest(ledger, 'sell', 's1', 110, 1);
  ingest(ledger, 'sell', 's2', 60, 1);
  const { client } = await assertParity(ledger, { realizedPnL: 20, realizedAssetPnL: 0 });
  const bySell = Object.fromEntries(client.sellGroups.map(g => [g.sell.orderId, g]));
  assert.equal(bySell.s1.buys.length, 1);
  assert.equal(bySell.s1.buys[0].quoteAmount, 100);
  assert.equal(bySell.s1.sell.pnl, 10);
  assert.equal(bySell.s2.buys.length, 1);
  assert.equal(bySell.s2.buys[0].quoteAmount, 50);
  assert.equal(bySell.s2.sell.pnl, 10);
  assert.deepEqual(client.orphanCandidates, []);
});

test('#697 parity: a realistic fully-annotated ledger keeps its pre-#697 realized totals on both sides', async () => {
  const ledger = newLedger();
  buildRealisticCycleLedger(ledger);
  // Captured from the pre-#697 server implementation over this fixture —
  // annotated ledgers must never move.
  const { server } = await assertParity(ledger, { realizedPnL: 14.59, realizedAssetPnL: 0.00027 });
  assert.equal(server.heldOpenBuyCostBasis, 244.85);
  assert.equal(server.heldOpenAssetQty, 0.0025);
  assert.equal(server.unpairedSellQty, 0);
});
