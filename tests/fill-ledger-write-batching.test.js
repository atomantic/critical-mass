// @ts-check
//
// The live fill path must rewrite the fill ledger a bounded number of times
// per order, not once per execution row (ingestOrderFillEvidence) or once per
// source buy (handleBodyTpFill's buy -> sell linkage). The ledger rewrite is a
// synchronous full-file write, so a 100+ row order or a body with hundreds of
// tranches otherwise blocks the event loop for seconds mid-fill.
//
// Method: close the same body twice, differing only in the number of execution
// rows / source buys, and assert the number of disk writes is identical. Run
// through the REAL handleOrderFill closure via the engine's _test hooks.
//
// Disk safety: throwaway pairs live under a disposable temp root removed in
// after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-ledger-write-batching-test');

// Neutralize the size optimizer's shared-config write BEFORE regime-engine is
// required (it destructures updateRegimeConfig at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');
const { createRecoveryModule } = require('../src/recovery');
const { createFillLedger } = require('../src/fill-ledger');

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };
const TP_ORDER_ID = 'tp-batching';
const T0 = Date.parse('2026-08-19T15:00:00.000Z');

/**
 * Engine with one body of `tranches` source buys whose resting TP sells
 * 0.048 in `rows` execution rows. Returns a runner that fills the TP and
 * reports how many ledger writes the fill cost.
 */
const makeScenario = ({ rows, tranches }, pair) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter({
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getPositions: async () => [],
    getOrderFills: async (orderId) => (orderId !== TP_ORDER_ID ? [] : Array.from({ length: rows }, (_, i) => ({
      tradeId: `sell-trade-${i}`,
      orderId: TP_ORDER_ID,
      side: 'sell',
      price: '51000',
      size: (0.048 / rows).toFixed(8),
      totalCommission: '0.01',
      rebate: '0',
      tradeTime: new Date(T0 + 60_000 + i * 1000).toISOString(),
    }))),
  });
  eng._test.setOrderExecutor({
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-new-1' }),
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    cancelAllLadderOrders: async () => ({ cancelled: 0 }),
    getPendingLadderOrders: () => [],
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    handleOrderCancel: () => {},
    getPendingCounts: () => ({ total: 0 }),
    isLadderOrder: () => false,
    getOrderPlacedAt: () => null,
  });

  const ledger = eng.getFillLedger();
  ledger.startNewCycle();
  const buyIds = Array.from({ length: tranches }, (_, i) => `buy-${i}`);
  buyIds.forEach((orderId, i) => {
    ledger.ingestFill({
      tradeId: `${orderId}-t1`, orderId, side: 'buy', price: '50000', size: (0.05 / tranches).toFixed(8),
      totalCommission: '0', rebate: '0', tradeTime: new Date(T0 + i * 1000).toISOString(),
    }, null, { skipPersist: true });
  });
  ledger.persist();

  const pos = eng._getPositionState();
  pos.celestialBodies = [{
    id: 'body-batching',
    tier: 'ASTEROID',
    assetQty: 0.05,
    costBasis: 2500,
    avgPrice: 50000,
    tpPrice: 51000,
    tpOrderId: TP_ORDER_ID,
    assetOnOrder: 0.048,
    buyOrders: buyIds.map(orderId => ({ orderId, price: 50000, assetQty: 0.05 / tranches, sizeUsdc: 2500 / tranches, filledAt: T0 })),
    sourceOrderIds: buyIds,
  }];
  pos.totalAsset = 0.05;
  engines.push(eng);

  return {
    ledger,
    fillTp: async () => {
      const before = ledger._test.getWriteCount();
      await eng._test.handleOrderFill({
        orderId: TP_ORDER_ID, side: 'sell', status: 'FILLED', filledSize: 0.048, averageFilledPrice: 51000,
      });
      return ledger._test.getWriteCount() - before;
    },
  };
};

describe('fill ledger writes per order are independent of row/tranche count', () => {
  it('ingests a multi-row sell order with one ledger write, not one per execution row', async () => {
    const few = makeScenario({ rows: 2, tranches: 2 }, '__testbatchrows_a__');
    const many = makeScenario({ rows: 12, tranches: 2 }, '__testbatchrows_b__');

    const fewWrites = await few.fillTp();
    const manyWrites = await many.fillTp();

    assert.equal(many.ledger.getFillsForOrder(TP_ORDER_ID).length, 12, 'every execution row reached the ledger');
    assert.equal(manyWrites, fewWrites, `12 rows cost ${manyWrites} writes vs ${fewWrites} for 2`);
  });

  it('links the source buys of a closing body with one ledger write, not one per buy', async () => {
    const few = makeScenario({ rows: 2, tranches: 2 }, '__testbatchbuys_a__');
    const many = makeScenario({ rows: 2, tranches: 10 }, '__testbatchbuys_b__');

    const fewWrites = await few.fillTp();
    const manyWrites = await many.fillTp();

    const linked = many.ledger.getAllFills().filter(f => f.side === 'buy' && f.sellOrderId === TP_ORDER_ID);
    assert.equal(linked.length, 10, 'every source buy is linked to the closing sell');
    assert.equal(manyWrites, fewWrites, `10 tranches cost ${manyWrites} writes vs ${fewWrites} for 2`);
  });

  it('persists a 12-row / 5-buy closing fill in exactly three ledger writes and loses nothing on reload', async () => {
    const pair = '__testbatchdisk__';
    const scenario = makeScenario({ rows: 12, tranches: 5 }, pair);

    const writes = await scenario.fillTp();

    // Relative checks above only prove "same count for 2 and 12"; a dropped flush
    // would pass them. Pin the absolute cost: one flush of the ingested execution
    // rows, one buy -> sell linkage write, one booking commit.
    assert.equal(writes, 3);
    // A fresh ledger on the same pair sees only what reached disk.
    const reloaded = createFillLedger('coinbase', pair, pair);
    assert.equal(reloaded.getFillsForOrder(TP_ORDER_ID).length, 12, 'every execution row reached disk');
    const linked = reloaded.getAllFills().filter(f => f.side === 'buy' && f.sellOrderId === TP_ORDER_ID);
    assert.equal(linked.length, 5, 'every source buy link reached disk');
  });

  it('startup recovery ingests its recent fills with one ledger write', async () => {
    const pair = '__testbatchrecovery__';
    const rowsFor = (orderId, n) => Array.from({ length: n }, (_, i) => ({
      tradeId: `${orderId}-t${i}`, orderId, side: 'buy', price: '50000', size: '0.001',
      totalCommission: '0', rebate: '0', tradeTime: new Date(T0 + i * 1000).toISOString(),
    }));
    const adapter = {
      getOpenOrders: async () => [{ orderId: 'rec-a', filledSize: 0.006 }, { orderId: 'rec-b', filledSize: 0.006 }],
      getOrderFills: async (orderId) => rowsFor(orderId, 6),
      getAccountBalance: async () => ({ available: 0, hold: 0 }),
    };
    const ledger = createFillLedger('coinbase', pair, pair);
    ledger.setCurrentCycleId('cycle-1', T0);
    const before = ledger._test.getWriteCount();

    const result = await createRecoveryModule('coinbase', adapter, pair).recoverState(ledger, {});

    assert.ok(result.position);
    assert.equal(ledger.getAllFills().length, 12, 'every recovered row reached the ledger');
    assert.equal(ledger._test.getWriteCount() - before, 1);
  });

  it('startup recovery surfaces the ingest error, not a failed flush, and propagates a lone flush failure', async () => {
    const adapter = {
      getOpenOrders: async () => [{ orderId: 'rec-x', filledSize: 0.001 }],
      getOrderFills: async () => [{ tradeId: 'rec-x-t', orderId: 'rec-x', side: 'buy', price: '50000', size: '0.001' }],
      getAccountBalance: async () => ({ available: 0, hold: 0 }),
    };
    const makeLedger = (over) => ({
      ingestFill: () => ({ ingested: true }),
      persist: () => {},
      getCurrentCycleFills: () => [],
      rebuildPositionFromFills: () => ({ totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0 }),
      ...over,
    });
    const recovery = createRecoveryModule('coinbase', adapter, '__testbatchflush__');

    await assert.rejects(
      recovery.recoverState(makeLedger({
        ingestFill: () => { throw new Error('ingest root cause'); },
        persist: () => { throw new Error('disk full'); },
      }), {}),
      /ingest root cause/,
    );
    await assert.rejects(
      recovery.recoverState(makeLedger({ persist: () => { throw new Error('disk full'); } }), {}),
      /disk full/,
    );
  });

  it('live fill ingest surfaces the ingest error when the flush also fails', async () => {
    const scenario = makeScenario({ rows: 3, tranches: 2 }, '__testbatchflush_live__');
    const ledger = scenario.ledger;
    const realIngest = ledger.ingestFill;
    const realPersist = ledger.persist;
    let ingests = 0;
    ledger.ingestFill = (...args) => {
      if (++ingests === 2) throw new Error('ingest root cause');
      return realIngest(...args);
    };
    ledger.persist = () => { throw new Error('disk full'); };
    try {
      await assert.rejects(scenario.fillTp(), /ingest root cause/);
    } finally {
      ledger.ingestFill = realIngest;
      ledger.persist = realPersist;
    }
  });
});
