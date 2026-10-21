// @ts-check
//
// Issue #1335: cycle recalculation is planned by a pure function
// (src/fill-ledger-recalc.js) and applied by the ledger. recalculateCycles
// applies the plan; previewRecalculateCycles returns it without applying.
//
// The pinned snapshot below was produced by the pre-extraction
// recalculateCycles on the same fixture, so the extraction is held to the
// exact same output: result, stamped fills, live cycle and next cycle number.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');
const { planCycleRecalculation } = require('../src/fill-ledger-recalc');

const originalGetExchangeDataDir = migration.getExchangeDataDir;
/** @type {string} */
let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-ledger-recalc-test-'));
  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tmpDir, exchange);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
});
after(() => {
  migration.getExchangeDataDir = originalGetExchangeDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PAIR = 'BTC-USDC';

const fill = (tradeId, side, orderId, size, price, timestamp, cycleId, extra = {}) => ({
  tradeId, side, orderId, size, price, quoteAmount: size * price, fee: 0.1, netFee: 0.1, rebate: 0, timestamp, cycleId, ...extra,
});

/**
 * - b0/s0: an unlinked round trip before the live cycle → recovered cycle.
 * - s1b: a re-imported partial row of cycle-1's sell → attributed by order.
 * - b2b: a re-imported partial row of the live body buy → attributed by
 *   order, inherits the body's order-level annotations (#752).
 * - s2: the body's TP sell, linked from b2 → attributed by link, inherits
 *   the body's ownership.
 * - b3: an unlinked buy after the live cycle's start → timeframe fold.
 * Live cycle: cycle-2, started at 4900.
 * @returns {Array<Object>}
 */
const fixture = () => [
  fill('b0', 'buy', 'o-b0', 0.001, 90000, 300, null),
  fill('s0', 'sell', 'o-s0', 0.001, 94000, 400, null),
  fill('b1', 'buy', 'o-b1', 0.002, 100000, 1000, 'cycle-1', { sellOrderId: 'o-s1' }),
  fill('s1', 'sell', 'o-s1', 0.0015, 105000, 2000, 'cycle-1'),
  fill('s1b', 'sell', 'o-s1', 0.0005, 105000, 2100, null),
  fill('b2', 'buy', 'o-b2', 0.001, 98000, 5000, 'cycle-2', { isBodyOwned: true, bodyId: 'body-a', bodyTier: 'small', sellOrderId: 'o-s2' }),
  fill('b2b', 'buy', 'o-b2', 0.001, 98000, 5100, null),
  fill('s2', 'sell', 'o-s2', 0.0009, 103000, 6000, null),
  fill('b3', 'buy', 'o-b3', 0.001, 97000, 7000, null),
];

const BODY_A = { isBodyOwned: true, bodyId: 'body-a', bodyTier: 'small' };

const EXPECTED_DETAILS = [
  { cycleId: 'cycle-2', buys: 1, sells: 2, totalAssetBought: 0.002, assetSold: 0.002, holdbackAsset: 0, avgCost: 100050, sellPrice: 104900, pnl: 9.7 },
  { cycleId: 'cycle-1', buys: 1, sells: 1, totalAssetBought: 0.001, assetSold: 0.001, holdbackAsset: 0, avgCost: 90100, sellPrice: 93900, pnl: 3.8 },
];
const EXPECTED_ID_MAP = { 'cycle-300-recovered-1': 'cycle-1', 'cycle-1': 'cycle-2', 'cycle-2': 'cycle-3' };

let ledgerSeq = 0;
/**
 * @param {Array<Object>} fills - Rows written as the ledger file before load
 * @returns {any}
 */
const loadLedger = (fills) => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  const { createFillLedger, getFillLedgerPath } = require('../src/fill-ledger');
  const exchange = `recalc-${++ledgerSeq}`;
  const file = getFillLedgerPath(exchange, PAIR);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fills));
  return createFillLedger(exchange, PAIR, PAIR, { quiet: true });
};

describe('fill-ledger-recalc (issue #1335)', () => {
  it('recalculateCycles output matches the pre-extraction snapshot', () => {
    const ledger = loadLedger(fixture());
    ledger.setCurrentCycleId('cycle-2', 4900);
    const result = ledger.recalculateCycles();

    assert.deepStrictEqual(result, {
      cyclesCompleted: 2,
      realizedPnL: 13.5,
      realizedAssetPnL: 0,
      cycleDetails: EXPECTED_DETAILS,
      orphansFixed: 6,
      orphansAttributed: 4,
      liveCycleOrphansAttributed: 3,
      activeCycleId: 'cycle-3',
      idMap: EXPECTED_ID_MAP,
    });
    assert.equal(ledger.getCurrentCycleId(), 'cycle-3');
    assert.equal(ledger.getCurrentCycleStartedAt(), 4900);
    assert.deepStrictEqual(ledger.getCurrentCycleFills().map(f => f.tradeId), ['b2', 'b2b', 's2', 'b3']);

    const byId = Object.fromEntries(ledger.getAllFills().map(f => [f.tradeId, f]));
    const base = Object.fromEntries(fixture().map(f => [f.tradeId, f]));
    const expectStamped = (tradeId, extra) => assert.deepStrictEqual(byId[tradeId], { ...base[tradeId], ...extra }, tradeId);
    // Recovered round trip, renumbered to cycle-1; legacy auto-link stamps the buy.
    expectStamped('b0', { cycleId: 'cycle-1', sellOrderId: 'o-s0' });
    expectStamped('s0', { cycleId: 'cycle-1' });
    expectStamped('b1', { cycleId: 'cycle-2' });
    expectStamped('s1', { cycleId: 'cycle-2' });
    expectStamped('s1b', { cycleId: 'cycle-2', cycleAttribution: 'order' });
    expectStamped('b2', { cycleId: 'cycle-3' });
    expectStamped('b2b', { cycleId: 'cycle-3', ...BODY_A, sellOrderId: 'o-s2', cycleAttribution: 'order' });
    expectStamped('s2', { cycleId: 'cycle-3', ...BODY_A, cycleAttribution: 'link' });
    expectStamped('b3', { cycleId: 'cycle-3', cycleAttribution: 'timeframe' });

    assert.equal(ledger.startNewCycle(1), 'cycle-4', 'nextCycleNumber continues after the renumbered cycles');
  });

  it('previewRecalculateCycles returns the plan without applying it', () => {
    const ledger = loadLedger(fixture());
    ledger.setCurrentCycleId('cycle-2', 4900);
    const before = JSON.stringify(ledger.getAllFills());
    const version = ledger._test.getLedgerVersion();

    const preview = ledger.previewRecalculateCycles();

    assert.deepStrictEqual(preview, {
      cyclesCompleted: 2,
      cycleDetails: EXPECTED_DETAILS,
      orphansFixed: 6,
      orphansAttributed: 4,
      liveCycleOrphansAttributed: 3,
      activeCycleId: 'cycle-3',
      idMap: EXPECTED_ID_MAP,
    });
    assert.equal(JSON.stringify(ledger.getAllFills()), before, 'no fill is stamped or patched');
    assert.equal(ledger._test.getLedgerVersion(), version, 'ledger version unchanged');
    assert.equal(ledger.getCurrentCycleId(), 'cycle-2');
    assert.equal(ledger._test.getWriteCount(), 0, 'nothing persisted');
  });

  it('planCycleRecalculation never mutates its input fills', () => {
    const fills = fixture();
    const before = JSON.stringify(fills);
    const plan = planCycleRecalculation({ fills, liveCycleId: 'cycle-2', liveCycleStartedAt: 4900 });
    assert.equal(JSON.stringify(fills), before);

    const byId = Object.fromEntries(fills.map(f => [f.tradeId, f]));
    // The plan refers to the caller's own rows, so the ledger can stamp them.
    assert.deepStrictEqual(plan.attributed.map(a => [a.fill, a.cycleId, a.reason]), [
      [byId.s1b, 'cycle-1', 'order'],
      [byId.b2b, 'cycle-2', 'order'],
      [byId.s2, 'cycle-2', 'link'],
      [byId.b3, 'cycle-2', 'timeframe'],
    ]);
    assert.deepStrictEqual(plan.patches.get(byId.b2b), { ...BODY_A, sellOrderId: 'o-s2' });
    assert.deepStrictEqual(plan.patches.get(byId.s2), BODY_A);
    assert.deepStrictEqual(plan.orphanCycles, [{ cycleId: 'cycle-300-recovered-1', fills: [byId.b0, byId.s0] }]);
    assert.equal(plan.orphanFillCount, 2);
    assert.equal(plan.adoptedCycleId, null, 'a live cycle is never displaced (#675)');
    assert.equal(plan.renumbering?.nextCycleNumber, 4);
    assert.equal(plan.activeCycleId, 'cycle-3');
    assert.deepStrictEqual(plan.idMap, EXPECTED_ID_MAP);
  });

  it('adopts the latest incomplete recovered cycle only when there is no live cycle', () => {
    const fills = [
      fill('x1', 'buy', 'o-x1', 0.001, 90000, 100, null),
      fill('x2', 'sell', 'o-x2', 0.001, 95000, 200, null),
      fill('x3', 'buy', 'o-x3', 0.001, 91000, 300, null),
    ];
    const noLive = planCycleRecalculation({ fills, liveCycleId: null, liveCycleStartedAt: null });
    assert.equal(noLive.adoptedCycleId, 'cycle-300-recovered-2');
    assert.equal(noLive.activeCycleId, 'cycle-2');
    assert.deepStrictEqual(noLive.cycleDetails.map(d => d.cycleId), ['cycle-1']);

    const withLive = planCycleRecalculation({ fills, liveCycleId: 'cycle-5', liveCycleStartedAt: null });
    assert.equal(withLive.adoptedCycleId, null);
    assert.equal(withLive.activeCycleId, 'cycle-3', 'the live cycle is numbered last');

    const ledger = loadLedger(fills);
    ledger.setCurrentCycleId(null);
    const result = ledger.recalculateCycles();
    assert.equal(result.activeCycleId, 'cycle-2');
    assert.equal(ledger.getCurrentCycleStartedAt(), null);
    assert.deepStrictEqual(ledger.getCurrentCycleFills().map(f => f.tradeId), ['x3']);
  });
});
