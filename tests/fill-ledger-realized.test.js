// @ts-check
//
// Issue #1613: the realized-P&L derivation (cycle-pair source of truth and the
// diagnostics-only FIFO replay) lives in the pure src/fill-ledger-realized.js;
// createFillLedger keeps the same method names and only memoizes.
//
// The pinned values below were produced by the pre-extraction ledger methods
// (computeRealizedFromCyclePairs / computeFifoRealized on main) over the same
// fixture, so the extraction is held to the exact same output. The fixture
// exercises every held-open branch: legacy open, legacy closed by a filled
// linked sell, consumedCostFraction, quantity-aware consumedBy (unioned across
// rows), a bodyId redirect onto an unannotated sell, a no-orderId buy keyed by
// tradeId, a per-orderId bodyPnl taken once across partial rows, an
// untrackedSell flag on only one row of its order, and an uncovered sell.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');
const realized = require('../src/fill-ledger-realized');

const originalGetExchangeDataDir = migration.getExchangeDataDir;
/** @type {string} */
let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-ledger-realized-test-'));
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

const fill = (tradeId, side, orderId, size, price, timestamp, extra = {}) => ({
  tradeId, side, orderId, size, price, quoteAmount: size * price, fee: 0.1, netFee: 0.1, rebate: 0, timestamp, cycleId: 'cycle-1', ...extra,
});

/** @returns {Array<any>} */
const fixture = () => [
  fill('b-open', 'buy', 'o-open', 0.5, 100, 1000),
  fill('b-closed', 'buy', 'o-closed', 1, 100, 1100, { sellOrderId: 's-plain' }),
  fill('s-plain', 'sell', 's-plain', 0.8, 120, 1200),
  fill('b-ccf', 'buy', 'o-ccf', 2, 90, 1300, { sellOrderId: 's-resting', consumedCostFraction: 0.25 }),
  fill('b-cons-1', 'buy', 'o-cons', 0.6, 95, 1400, { sellOrderId: 's-body', consumedBy: { 's-body': 0.5 } }),
  fill('b-cons-2', 'buy', 'o-cons', 0.4, 95, 1410, { sellOrderId: 's-body' }),
  fill('s-body-1', 'sell', 's-body', 0.25, 110, 1500, { bodyPnl: 3.5, bodyHoldbackAsset: 0.1, isBodyOwned: true, bodyId: 'body-a' }),
  fill('s-body-2', 'sell', 's-body', 0.15, 110, 1510, { bodyPnl: 3.5, bodyHoldbackAsset: 0.1, isBodyOwned: true, bodyId: 'body-a' }),
  fill('b-redir', 'buy', 'o-redir', 0.3, 100, 1600, { sellOrderId: 's-dead', isBodyOwned: true, bodyId: 'body-r' }),
  fill('s-r', 'sell', 's-r', 0.3, 115, 1700, { isBodyOwned: true, bodyId: 'body-r' }),
  fill('b-no-order', 'buy', undefined, 0.2, 80, 1800),
  fill('u-1', 'sell', 'u-ord', 0.1, 130, 1900, { untrackedSell: true }),
  fill('u-2', 'sell', 'u-ord', 0.05, 130, 1910),
  fill('s-uncovered', 'sell', 's-unc', 10, 100, 2000),
];
/** The fixture without the uncovered sell, so FIFO has remaining lots. */
const coveredFixture = () => fixture().filter(f => f.tradeId !== 's-uncovered');

const EXPECTED_PAIRS = {
  realizedPnL: 23.62,
  realizedAssetPnL: 0.3,
  heldOpenBuyCostBasis: 248.87,
  heldOpenAssetQty: 2.7,
  ledgerNetAsset: -6.65,
  unpairedSellQty: 10.15,
  untrackedSellQty: 0.15,
};
const EXPECTED_PAIRS_COVERED = { ...EXPECTED_PAIRS, ledgerNetAsset: 3.35, unpairedSellQty: 0.15 };
const EXPECTED_FIFO = {
  realizedPnL: 56.67,
  remainingAssetQty: -6.65,
  uncoveredSellQty: 6.65,
  remainingLotCost: 0,
  remainingLotQty: 0,
};
const EXPECTED_FIFO_COVERED = {
  realizedPnL: 29.69,
  remainingAssetQty: 3.35,
  uncoveredSellQty: 0,
  remainingLotCost: 307.99,
  remainingLotQty: 3.35,
};

const toMap = (rows) => new Map(rows.map(r => [r.tradeId, r]));

let ledgerSeq = 0;
/**
 * @param {Array<Object>} rows - Rows written as the ledger file before load
 * @returns {any}
 */
const loadLedger = (rows) => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  const { createFillLedger, getFillLedgerPath } = require('../src/fill-ledger');
  const exchange = `realized-${++ledgerSeq}`;
  const file = getFillLedgerPath(exchange, PAIR);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return createFillLedger(exchange, PAIR, PAIR, { quiet: true });
};

describe('fill-ledger-realized (issue #1613)', () => {
  it('computeRealizedFromCyclePairs matches the pre-extraction snapshot (Map and array input)', () => {
    assert.deepStrictEqual(realized.computeRealizedFromCyclePairs(toMap(fixture())), EXPECTED_PAIRS);
    assert.deepStrictEqual(realized.computeRealizedFromCyclePairs(fixture()), EXPECTED_PAIRS);
    assert.deepStrictEqual(realized.computeRealizedFromCyclePairs(toMap(coveredFixture())), EXPECTED_PAIRS_COVERED);
  });

  it('computeFifoRealized matches the pre-extraction snapshot (Map and array input)', () => {
    assert.deepStrictEqual(realized.computeFifoRealized(toMap(fixture())), EXPECTED_FIFO);
    assert.deepStrictEqual(realized.computeFifoRealized(fixture()), EXPECTED_FIFO);
    assert.deepStrictEqual(realized.computeFifoRealized(toMap(coveredFixture())), EXPECTED_FIFO_COVERED);
  });

  it('never mutates the rows it reads', () => {
    const rows = fixture();
    const snapshot = JSON.parse(JSON.stringify(rows));
    const map = toMap(rows);
    realized.computeRealizedFromCyclePairs(map);
    realized.computeFifoRealized(map);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), snapshot);
    assert.deepStrictEqual(Array.from(map.keys()), snapshot.map(r => r.tradeId), 'fills order unchanged');
  });

  it('ledger methods keep their names and return the same values as the pure module', () => {
    const ledger = loadLedger(fixture());
    assert.deepStrictEqual(ledger.computeRealizedFromCyclePairs(), EXPECTED_PAIRS);
    assert.deepStrictEqual(ledger.getDerivedRealizedPnL(), EXPECTED_PAIRS);
    assert.deepStrictEqual(ledger.computeFifoRealized(), EXPECTED_FIFO);
    assert.deepStrictEqual(ledger.computeRealizedFromCyclePairs(), realized.computeRealizedFromCyclePairs(ledger.getAllFills()));
  });

  it('ledger memoizes over ledgerVersion and returns copies', () => {
    const ledger = loadLedger(coveredFixture());
    const first = ledger.computeRealizedFromCyclePairs();
    const count = ledger._test.getRealizedRecomputeCount();
    first.realizedPnL = -1;
    assert.deepStrictEqual(ledger.computeRealizedFromCyclePairs(), EXPECTED_PAIRS_COVERED, 'caller mutation does not reach the cache');
    assert.equal(ledger._test.getRealizedRecomputeCount(), count, 'unchanged ledger served from cache');
    ledger.markDirty();
    assert.deepStrictEqual(ledger.computeRealizedFromCyclePairs(), EXPECTED_PAIRS_COVERED);
    assert.equal(ledger._test.getRealizedRecomputeCount(), count + 1, 'version bump recomputes');
  });

  it('consumedBy helpers: sum ignores invalid entries, merge keeps the max per sell', () => {
    assert.equal(realized.sumConsumedBy({ a: 0.5, b: -1, c: NaN, d: 0.25 }), 0.75);
    assert.deepStrictEqual(
      realized.mergeConsumedBy({ a: 0.5, bad: -1 }, { a: 0.25, b: 0.1, c: NaN }),
      { a: 0.5, b: 0.1 },
    );
    assert.deepStrictEqual(realized.mergeConsumedBy(null, { a: 1 }), { a: 1 });
  });

  it('fill-ledger no longer re-exports the fill-ledger-recalc helpers', () => {
    delete require.cache[require.resolve('../src/fill-ledger')];
    const ledgerModule = require('../src/fill-ledger');
    for (const name of ['CYCLE_COMPLETE_SELL_RATIO', 'isCompletedCycle', 'splitOrphansIntoCycles', 'attributeOrphanFills',
      'groupFillsByCycle', 'collectCycleTimestamps', 'buildCycleRenumberingMap']) {
      assert.equal(name in ledgerModule, false, `${name} should be imported from fill-ledger-recalc`);
    }
    assert.ok(ledgerModule.LEGACY_CONSUMPTION_KEY, 'LEGACY_CONSUMPTION_KEY stays exported for its production callers');
  });
});
