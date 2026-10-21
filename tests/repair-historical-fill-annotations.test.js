// @ts-check
//
// Characterization tests for repairHistoricalFillAnnotations (issue #1230).
// Pins steps 1-3 of the boot-time repair at the exported boundary with a real
// fill ledger; step 0 (orphan buy recovery) is pinned in reset-cycle-buys.test.js.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-repair-hist-annot-test');

const { repairHistoricalFillAnnotations } = require('../src/regime-engine');
const { createFillLedger } = require('../src/fill-ledger');

// Each test gets its own pair: persist() writes the ledger to disk and a new
// createFillLedger on the same pair would reload it.
const PAIRS = [];
after(() => {
  isolatedData.cleanup();
});

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (h) => new Date(T0 + h * 3600_000).toISOString();

const makeLedger = () => {
  const pair = `__test1230_${PAIRS.length}__`;
  PAIRS.push(pair);
  const ledger = createFillLedger('coinbase', pair, pair);
  ledger.setCurrentCycleId('cycle-1', T0);
  // Counts real disk writes, including internal persist() calls the ledger makes
  // through its closure (a spy on ledger.persist would miss those).
  const baseline = ledger._test.getWriteCount();
  return { ledger, persistCount: () => ledger._test.getWriteCount() - baseline };
};

const run = (ledger, positionState, logs = [], extraDeps = {}) => repairHistoricalFillAnnotations({
  fillLedger: ledger,
  positionState,
  config: {},
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  baseCurrency: 'BTC',
  priceIncrement: 0.01,
  exchange: 'coinbase',
  celestialHierarchy: { findMergeTarget: () => null },
  calculateDynamicTpPercent: () => 1,
  roundPrice: (p) => p,
  roundAsset: (q) => Math.round(q * 1e8) / 1e8,
  fmtPrice: String,
  ...extraDeps,
});

const byTrade = (ledger, tradeId) => ledger.getAllFills().find(f => f.tradeId === tradeId);

describe('repairHistoricalFillAnnotations', () => {
  it('stamps body ownership on buy rows listed in sourceOrderIds / buyOrders', () => {
    const { ledger, persistCount } = makeLedger();
    ledger.ingestFill({ tradeId: 'a-src', orderId: 'a-src-buy', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'a-bo', orderId: 'a-bo-buy', side: 'buy', price: '50000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'a-mig', orderId: 'core-migration', side: 'buy', price: '50000', size: '0.01', tradeTime: at(3) }, null, { skipPersist: true });
    const positionState = {
      activeTpOrderId: null,
      celestialBodies: [{
        id: 'body-1', tier: 'moon', tpOrderId: 'tp-1',
        sourceOrderIds: ['a-src-buy'],
        buyOrders: [{ orderId: 'a-src-buy' }, { orderId: 'a-bo-buy' }, { orderId: 'core-migration' }],
      }],
    };
    run(ledger, positionState);

    for (const id of ['a-src', 'a-bo']) {
      const f = byTrade(ledger, id);
      assert.equal(f.isBodyOwned, true, id);
      assert.equal(f.bodyId, 'body-1', id);
      assert.equal(f.bodyTier, 'moon', id);
      assert.equal(f.sellOrderId, 'tp-1', id);
    }
    assert.ok(!byTrade(ledger, 'a-mig').bodyId, 'core-migration buyOrders entry is skipped');
    assert.equal(persistCount(), 2);
  });

  it('pairs an unannotated body sell with the size-matching earlier buy', () => {
    const { ledger, persistCount } = makeLedger();
    ledger.ingestFill({ tradeId: 'b-buy', orderId: 'b-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'b-sell', orderId: 'b-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'b-buy2', orderId: 'b-buy2-o', side: 'buy', price: '50000', size: '0.0105', tradeTime: at(3) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'b-sell2', orderId: 'b-sell2-o', side: 'sell', price: '40000', size: '0.0105', tradeTime: at(4) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    const sell = byTrade(ledger, 'b-sell');
    const buy = byTrade(ledger, 'b-buy');
    assert.equal(sell.isBodyOwned, true);
    assert.ok(sell.bodyPnl > 0);
    assert.equal(sell.bodyHoldbackAsset, 0);
    assert.equal(sell.bodyBtcQty, 0.01);
    assert.equal(sell.bodyAvgPrice, 50000);
    assert.equal(buy.sellOrderId, 'b-sell-o');

    // Losing match is no pairing (#1398): the sell stays unannotated, so the
    // fill path can still flag it untrackedSell, and the buy stays unclosed.
    const losing = byTrade(ledger, 'b-sell2');
    assert.equal(losing.isBodyOwned, undefined);
    assert.equal(losing.bodyPnl, undefined);
    assert.equal(byTrade(ledger, 'b-buy2').sellOrderId, undefined);
    // The buy's sellOrderId link persists; nothing is left dirty for the final flush.
    assert.equal(persistCount(), 1);
  });

  it('does not re-book a foreign (untrackedSell) sell as a body sell or close the matching buy', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'u-buy', orderId: 'u-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'u-sell', orderId: 'u-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.annotateFillsByOrderId('u-sell-o', { untrackedSell: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    const sell = byTrade(ledger, 'u-sell');
    assert.equal(sell.isBodyOwned, undefined);
    assert.equal(sell.bodyPnl, undefined);
    assert.equal(sell.bodyHoldbackAsset, undefined);
    assert.equal(byTrade(ledger, 'u-buy').sellOrderId, undefined);
    assert.equal(byTrade(ledger, 'u-buy').isBodyOwned, undefined);
  });

  it('keeps a foreign sell excluded when a late row of the order carries no untrackedSell flag', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'l-buy', orderId: 'l-buy-o', side: 'buy', price: '50000', size: '0.005', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'l-sell-a', orderId: 'l-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.annotateFillsByOrderId('l-sell-o', { untrackedSell: true });
    // Ingested after the flag was written: belongs to the same foreign order.
    ledger.ingestFill({ tradeId: 'l-sell-b', orderId: 'l-sell-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(2.1) }, null, { skipPersist: true });
    assert.equal(byTrade(ledger, 'l-sell-b').untrackedSell, undefined, 'precondition: late row is unflagged');
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    for (const id of ['l-sell-a', 'l-sell-b']) {
      assert.equal(byTrade(ledger, id).isBodyOwned, undefined, id);
      assert.equal(byTrade(ledger, id).bodyPnl, undefined, id);
    }
    assert.equal(byTrade(ledger, 'l-buy').sellOrderId, undefined);
  });

  it('does not overwrite the per-order bodyPnl of an annotated body sell when a late row is unannotated', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'p-buy', orderId: 'p-buy-o', side: 'buy', price: '50000', size: '0.005', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'p-sell-a', orderId: 'p-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.annotateFillsByOrderId('p-sell-o', { isBodyOwned: true, bodyPnl: 123, bodyHoldbackAsset: 0.001, bodyCostBasis: 400 });
    ledger.ingestFill({ tradeId: 'p-sell-b', orderId: 'p-sell-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(2.1) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 'p-sell-a').bodyPnl, 123);
    assert.equal(byTrade(ledger, 'p-sell-a').bodyHoldbackAsset, 0.001);
    assert.equal(byTrade(ledger, 'p-sell-b').bodyPnl, undefined, 'late row is not re-annotated on its own');
    assert.equal(byTrade(ledger, 'p-buy').sellOrderId, undefined);
  });

  it('only pairs a buy whose size is within 1% of the sell, and leaves other sells unannotated', () => {
    const { ledger } = makeLedger();
    // sell 0.01 BTC: 0.0102 is +2% and 0.0098 is -2% (both outside); 0.00995 / 0.01005 are inside.
    const cases = [
      { id: 'n-hi', buySize: '0.0102', paired: false },
      { id: 'n-lo', buySize: '0.0098', paired: false },
      { id: 'n-in-hi', buySize: '0.01005', paired: true },
      // In band but smaller than the sell (negative holdback): rejected, left unannotated (#1398).
      { id: 'n-in-lo', buySize: '0.00995', paired: false },
    ];
    cases.forEach(({ id, buySize }, i) => {
      ledger.ingestFill({ tradeId: `${id}-buy`, orderId: `${id}-buy-o`, side: 'buy', price: '50000', size: buySize, tradeTime: at(10 * i + 1) }, null, { skipPersist: true });
      ledger.ingestFill({ tradeId: `${id}-sell`, orderId: `${id}-sell-o`, side: 'sell', price: '60000', size: '0.01', tradeTime: at(10 * i + 2) }, null, { skipPersist: true });
    });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    for (const { id, paired } of cases) {
      const sell = byTrade(ledger, `${id}-sell`);
      const buy = byTrade(ledger, `${id}-buy`);
      if (paired) {
        assert.equal(sell.isBodyOwned, true, `${id}: sell is booked`);
        assert.equal(buy.sellOrderId, `${id}-sell-o`, `${id}: buy is closed by its sell`);
      } else {
        assert.equal(sell.isBodyOwned, undefined, `${id}: unpaired sell stays unannotated`);
        assert.equal(sell.bodyPnl, undefined, id);
        assert.equal(buy.sellOrderId, undefined, `${id}: out-of-band buy is not closed`);
      }
    }
  });

  it('never pairs a sell with a buy that happened after it', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'e-sell', orderId: 'e-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'e-buy', orderId: 'e-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 'e-sell').isBodyOwned, undefined);
    assert.equal(byTrade(ledger, 'e-sell').bodyPnl, undefined);
    assert.equal(byTrade(ledger, 'e-buy').sellOrderId, undefined);
    assert.equal(byTrade(ledger, 'e-buy').isBodyOwned, undefined);
  });

  it('does not re-book a timestamp-folded (timeframe) sell as a body sell', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 't-buy', orderId: 't-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 't-sell', orderId: 't-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    byTrade(ledger, 't-sell').cycleAttribution = 'timeframe';
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 't-sell').bodyPnl, undefined);
    assert.equal(byTrade(ledger, 't-buy').sellOrderId, undefined);
  });

  it('matches a multi-row sell order once, as a single aggregated sell', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'm-buy1', orderId: 'm-buy1-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'm-buy2', orderId: 'm-buy2-o', side: 'buy', price: '50000', size: '0.005', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'm-sell-a', orderId: 'm-sell-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(3) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'm-sell-b', orderId: 'm-sell-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(3.1) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    // The two 0.005 rows aggregate to 0.01 and pair with the 0.01 buy only;
    // per-row matching would have consumed m-buy2 as well.
    assert.equal(byTrade(ledger, 'm-buy1').sellOrderId, 'm-sell-o');
    assert.equal(byTrade(ledger, 'm-buy2').sellOrderId, undefined);
    assert.equal(byTrade(ledger, 'm-sell-a').bodyPnl, byTrade(ledger, 'm-sell-b').bodyPnl);
    assert.ok(byTrade(ledger, 'm-sell-a').bodyPnl > 0);
    assert.equal(byTrade(ledger, 'm-sell-a').bodyBtcQty, 0.01);
  });

  it('matches interleaved multi-row sell orders chronologically by their aggregate timestamp', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'i-buy1', orderId: 'i-buy1-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'i-buy2', orderId: 'i-buy2-o', side: 'buy', price: '51000', size: '0.01', tradeTime: at(3.5) }, null, { skipPersist: true });
    // Order X starts first but completes last (aggregate timestamp t5); order Y completes at t4.
    ledger.ingestFill({ tradeId: 'i-x1', orderId: 'i-x-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(3) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'i-y1', orderId: 'i-y-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(4) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'i-x2', orderId: 'i-x-o', side: 'sell', price: '60000', size: '0.005', tradeTime: at(5) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 'i-buy2').sellOrderId, 'i-y-o', 'the earlier-completing sell claims the nearest earlier buy');
    assert.equal(byTrade(ledger, 'i-buy1').sellOrderId, 'i-x-o');
  });

  // Issue #1398: rows of a still-resting body TP recovered at boot are owed
  // their real booking; a guessed pairing would book them against a rung.
  it('leaves a live body TP\'s recovered partial unannotated even when a rung matches its size', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'lt-rung1', orderId: 'lt-rung1-o', side: 'buy', price: '50000', size: '0.005', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'lt-rung2', orderId: 'lt-rung2-o', side: 'buy', price: '49000', size: '0.005', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'lt-p1', orderId: 'lt-tp', side: 'sell', price: '60000', size: '0.005', tradeTime: at(3) }, null, { skipPersist: true });
    const positionState = {
      activeTpOrderId: null,
      celestialBodies: [{
        id: 'body-live', tier: 'moon', tpOrderId: 'lt-tp',
        sourceOrderIds: ['lt-rung1-o', 'lt-rung2-o'],
        buyOrders: [{ orderId: 'lt-rung1-o' }, { orderId: 'lt-rung2-o' }],
      }],
    };
    run(ledger, positionState);

    const partial = byTrade(ledger, 'lt-p1');
    assert.equal(partial.isBodyOwned, undefined);
    assert.equal(partial.bodyPnl, undefined);
    assert.equal(partial.bodyHoldbackAsset, undefined);
    assert.equal(ledger.getSellBooking('lt-tp'), null);
    // Step 1 still links the rungs to the live TP; nothing else touches them.
    for (const id of ['lt-rung1', 'lt-rung2']) {
      assert.equal(byTrade(ledger, id).sellOrderId, 'lt-tp', id);
      assert.equal(byTrade(ledger, id).consumedBy, undefined, id);
    }
  });

  it('skips sells of a merge-snapshot TP passed in by the caller', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'ms-buy', orderId: 'ms-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'ms-sell', orderId: 'ms-tp', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null }, [], { mergeSnapshotTpOrderIds: ['ms-tp'] });

    assert.equal(byTrade(ledger, 'ms-sell').bodyPnl, undefined);
    assert.equal(byTrade(ledger, 'ms-sell').isBodyOwned, undefined);
    assert.equal(byTrade(ledger, 'ms-buy').sellOrderId, undefined);
  });

  it('never re-pairs a buy that carries a consumption record', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'cb-buy', orderId: 'cb-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.annotateFillsByOrderId('cb-buy-o', { isBodyOwned: true, bodyId: 'body-dead', sellOrderId: 'cb-old-sell' });
    ledger.recordBuyConsumption('cb-buy-o', 'cb-old-sell', 0.01);
    ledger.ingestFill({ tradeId: 'cb-sell', orderId: 'cb-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 'cb-sell').bodyPnl, undefined);
    assert.equal(byTrade(ledger, 'cb-sell').isBodyOwned, undefined);
    assert.equal(byTrade(ledger, 'cb-buy').sellOrderId, 'cb-old-sell');
    assert.deepEqual(byTrade(ledger, 'cb-buy').consumedBy, { 'cb-old-sell': 0.01 });
  });

  it('never pairs a buy a live body owns by bodyId', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'lb-buy', orderId: 'lb-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    ledger.annotateFillsByOrderId('lb-buy-o', { isBodyOwned: true, bodyId: 'body-live' });
    ledger.ingestFill({ tradeId: 'lb-sell', orderId: 'lb-sell-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    run(ledger, { activeTpOrderId: null, celestialBodies: [{ id: 'body-live', tier: 'moon', tpOrderId: null, sourceOrderIds: [], buyOrders: [] }] });

    assert.equal(byTrade(ledger, 'lb-sell').bodyPnl, undefined);
    assert.equal(byTrade(ledger, 'lb-buy').sellOrderId, undefined);
  });

  it('keeps a buy whose pairing was rejected available for a later valid sell', () => {
    const { ledger } = makeLedger();
    ledger.ingestFill({ tradeId: 'rj-buy', orderId: 'rj-buy-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { skipPersist: true });
    // Losing size-match first, then the real TP.
    ledger.ingestFill({ tradeId: 'rj-loss', orderId: 'rj-loss-o', side: 'sell', price: '40000', size: '0.01', tradeTime: at(2) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'rj-tp', orderId: 'rj-tp-o', side: 'sell', price: '60000', size: '0.01', tradeTime: at(3) }, null, { skipPersist: true });
    const logs = [];
    run(ledger, { celestialBodies: [], activeTpOrderId: null }, logs);

    assert.equal(byTrade(ledger, 'rj-loss').isBodyOwned, undefined);
    assert.ok(byTrade(ledger, 'rj-tp').bodyPnl > 0);
    assert.equal(byTrade(ledger, 'rj-buy').sellOrderId, 'rj-tp-o');
    assert.equal(logs.filter(m => m.includes('unannotated')).length, 1, 'rejections are summarized in one line');
  });

  it('moves -recovered- cycle fills inside the current cycle range only', () => {
    const { ledger, persistCount } = makeLedger();
    ledger.ingestFill({ tradeId: 'c-live', orderId: 'c-live-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(5) }, null, { skipPersist: true });
    ledger.ingestFill({ tradeId: 'c-in', orderId: 'c-in-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(6) }, null, { cycleId: 'old-recovered-1', skipPersist: true });
    ledger.ingestFill({ tradeId: 'c-out', orderId: 'c-out-o', side: 'buy', price: '50000', size: '0.01', tradeTime: at(1) }, null, { cycleId: 'old-recovered-2', skipPersist: true });
    run(ledger, { celestialBodies: [], activeTpOrderId: null });

    assert.equal(byTrade(ledger, 'c-in').cycleId, 'cycle-1');
    assert.equal(byTrade(ledger, 'c-out').cycleId, 'old-recovered-2');
    assert.equal(persistCount(), 1);
  });

  it('does nothing without a current cycle', () => {
    const { ledger } = makeLedger();
    ledger.setCurrentCycleId(null);
    const before = ledger._test.getWriteCount();
    run(ledger, { celestialBodies: [], activeTpOrderId: null });
    assert.equal(ledger._test.getWriteCount() - before, 0);
  });
});
