// @ts-check
//
// Regression tests for #670: TP cancel/replace paths (operator TP edit,
// reconcile stale-size, post-merge stale-size, startup reprice) must book a
// tranche the TP sold DURING the cancel before re-placing. cancelBodyTpOrder
// reports that race as `{cancelled: true, filledSize > 0}` and has already
// dropped executor tracking, so ignoring filledSize loses the sale (no
// bodyPnl, no consumption record) and re-lists asset the body no longer holds.
//
// Disk safety: throwaway pair '__test670__' lives under a disposable temp root
// that is removed in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-tp-cancel-exec-test');

// Neutralize the size optimizer's shared-config write BEFORE regime-engine is
// required (it destructures updateRegimeConfig at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// start() connects a REAL websocket feed — stub it BEFORE regime-engine is
// required (it destructures createWebSocketFeed at load).
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test670__';

const engines = [];
/** Engines that ran start() and so own production intervals only stop() clears. */
const started = new Set();
after(async () => {
  // stop() clears the production intervals start() schedules.
  for (const eng of engines) {
    if (started.has(eng)) await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const EXECUTION = { cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };

const sellFill = (orderId, size = '0.004') => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'sell',
  price: '50500',
  size,
  totalCommission: '0.02',
  rebate: '0',
  liquidityIndicator: 'MAKER',
  tradeTime: new Date().toISOString(),
}];

const makeBody = (tpOrderId) => ({
  id: 'b1',
  tier: 'ASTEROID',
  assetQty: 0.01,
  costBasis: 500,
  avgPrice: 50000,
  tpPrice: 50500,
  tpOrderId,
  // Deliberately stale vs. what calculateTakeProfitSize wants, so the
  // reconcile stale-size branch fires.
  assetOnOrder: 0.005,
  buyOrders: [{ orderId: 'seed-b1', price: 50000, assetQty: 0.01, sizeUsdc: 500, filledAt: 1 }],
  sourceOrderIds: ['seed-b1'],
});

/**
 * @param {{cancelResult: Object, adapter?: Object}} opts
 */
const makeEngine = ({ cancelResult, adapter = {}, executor = {}, productDetails = PRODUCT_DETAILS, pair = TEST_PAIR }) => {
  const placed = [];
  const cancels = [];
  let n = 0;
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(productDetails);
  eng._test.setAdapter({
    // Terminal-confirm lookups made by the partial-sell freeze.
    getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 }),
    getOpenOrders: async () => [],
    cancelOrder: async () => ({ success: false }),
    getOrderFills: async (orderId) => sellFill(orderId),
    ...adapter,
  });
  eng._test.setOrderExecutor({
    cancelBodyTpOrder: async (bodyId, orderId) => { cancels.push(orderId); return cancelResult; },
    placeBodyTpOrder: async (size, price) => { placed.push([size, price]); return { success: true, orderId: `tp-new-${++n}` }; },
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    ...executor,
  });
  const pos = eng._getPositionState();
  pos.celestialBodies = [makeBody('tp-old')];
  pos.totalAsset = 0.01;
  pos.totalCostBasis = 500;
  pos.activeTpOrderId = null;
  engines.push(eng);
  return { eng, placed, cancels };
};

/** Seed the source buy's ledger row so the sale's consumption can be recorded. */
const seedBuy = (eng) => {
  eng.getFillLedger().ingestFill({
    tradeId: 'seed-b1-t1', orderId: 'seed-b1', side: 'buy', price: '50000', size: '0.01',
    totalCommission: '0', rebate: '0', liquidityIndicator: 'TAKER', tradeTime: new Date().toISOString(),
  });
};

const readSellRow = (orderId, pair = TEST_PAIR) => {
  const ledger = JSON.parse(fs.readFileSync(path.join(isolatedData.fundDir('coinbase', pair), 'fill-ledger.json'), 'utf8'));
  return ledger.find(f => f.orderId === orderId);
};

const assertBookedAndResized = (eng, placed, orderId, pair = TEST_PAIR) => {
  const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
  assert.ok(body, 'body survives a partial sale');
  assert.ok(Math.abs(body.assetQty - 0.006) < 1e-9, `sold tranche deducted, got ${body.assetQty}`);
  assert.ok(Math.abs(body.costBasis - 300) < 1e-6, `prorated cost deducted, got ${body.costBasis}`);
  assert.notEqual(body.tpOrderId, orderId, 'body no longer points at the cancelled TP');

  const sell = readSellRow(orderId, pair);
  assert.ok(sell, 'the sale reached the fill ledger');
  assert.ok(Math.abs(sell.bodyPnl - 1.98) < 1e-9, `sale carries bodyPnl, got ${sell.bodyPnl}`);
  assert.equal(sell.bodyHoldbackAsset, 0, 'a partial sale books no reserves');

  // Per-buy consumption record (issue #607) written by the partial-sell path.
  const consumption = eng.getFillLedger().getBuyOrderConsumption('seed-b1');
  assert.ok(consumption?.consumedBy, 'the source buy records what the sale consumed');

  assert.ok(placed.length >= 1, 'a replacement TP was placed');
  for (const [size] of placed) {
    assert.ok(size <= 0.006 + 1e-12, `replacement TP ${size} must not exceed the 0.006 the body still holds`);
  }
};

describe('#670 TP cancel-for-replace books executions during cancel', () => {
  it('setBodyTpPercent books the sold tranche and never re-lists it', async () => {
    const { eng, placed, cancels } = makeEngine({ cancelResult: EXECUTION });
    seedBuy(eng);

    const result = await eng.setBodyTpPercent('b1', 2);

    assert.deepEqual(cancels, ['tp-old']);
    assert.equal(result.success, false, 'the edit is not applied over a mid-cancel sale');
    assert.match(result.message, /sold during cancel/);
    assertBookedAndResized(eng, placed, 'tp-old');
    assert.equal(placed.length, 1, 'only the booking path re-placed — the full-size edit TP was not');
  });

  it('reconcile stale-size re-place books the sold tranche instead of re-listing it', async () => {
    const { eng, placed, cancels } = makeEngine({
      cancelResult: EXECUTION,
      adapter: {
        // Reconcile sees an OPEN, unfilled TP whose size is stale.
        getOrder: async () => (cancels.length === 0
          ? { status: 'OPEN', filledSize: 0 }
          : { status: 'CANCELLED', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 }),
      },
    });
    seedBuy(eng);

    await eng._test.reconcileTick();

    assert.deepEqual(cancels, ['tp-old'], 'stale-size branch cancelled the TP');
    assertBookedAndResized(eng, placed, 'tp-old');
    assert.equal(placed.length, 1, 'the stale-size branch did not also re-place a full-size TP');
  });

  it('keeps the TP identity for reconciliation when booking the execution fails', async () => {
    const { eng, placed } = makeEngine({
      cancelResult: EXECUTION,
      // The freeze cannot confirm the order terminal → booking throws.
      adapter: { getOpenOrders: async () => [{ orderId: 'tp-old' }] },
    });

    const result = await eng.setBodyTpPercent('b1', 2);

    assert.equal(result.success, false);
    assert.match(result.message, /deferred to reconciliation/);
    const body = eng._getPositionState().celestialBodies[0];
    assert.equal(body.tpOrderId, 'tp-old', 'reconcile can still find the CANCELLED partial');
    assert.equal(body.assetQty, 0.01, 'nothing booked yet');
    assert.equal(placed.length, 0, 'no replacement TP over un-booked asset');
  });

  for (const [name, cancelResult, message] of [
    ['filled', { cancelled: false, filled: true, filledSize: 0.005 }, /already filled/],
    ['unresolved', { cancelled: false, filled: false, filledSize: 0 }, /cancel failed/],
  ]) {
    it(`setBodyTpPercent leaves the TP untouched when the cancel is ${name}`, async () => {
      const { eng, placed } = makeEngine({ cancelResult });
      const result = await eng.setBodyTpPercent('b1', 2);
      assert.equal(result.success, false);
      assert.match(result.message, message);
      const body = eng._getPositionState().celestialBodies[0];
      assert.equal(body.tpOrderId, 'tp-old');
      assert.equal(body.assetQty, 0.01);
      assert.equal(placed.length, 0);
    });
  }

  it('setBodyTpPercent still re-places on a clean cancel', async () => {
    const { eng, placed } = makeEngine({ cancelResult: { cancelled: true, filled: false, filledSize: 0 } });
    const result = await eng.setBodyTpPercent('b1', 2);
    assert.equal(result.success, true, result.message);
    const body = eng._getPositionState().celestialBodies[0];
    assert.equal(body.assetQty, 0.01);
    assert.equal(body.tpOrderId, 'tp-new-1');
    assert.equal(placed.length, 1);
  });
  it('post-merge stale-size re-place books the sold tranche instead of re-listing it', async () => {
    // A baseMinSize between the holdback sell size (~0.0195) and the merged
    // body (0.02) makes placeBodyTp sell the full body, which the post-merge
    // defense-in-depth check then reads as a stale TP and cancels. That cancel
    // races a 0.004 fill.
    let cancelCalls = 0;
    const { eng, placed } = makeEngine({
      cancelResult: null,
      productDetails: { baseMinSize: '0.0197', baseIncrement: '0.00000001' },
      adapter: {
        getOrder: async (orderId) => (orderId === 'tp-old'
          ? { status: 'OPEN', filledSize: 0 }
          : { status: 'CANCELLED', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 }),
        getOrderFills: async (orderId) => (orderId === 'buy-new'
          ? [{ tradeId: 'buy-new-t1', orderId, side: 'buy', price: '50000', size: '0.01', totalCommission: '0.05', rebate: '0', tradeTime: new Date().toISOString() }]
          : sellFill(orderId)),
      },
      executor: {
        // First cancel: the merge target's own TP (clean). Second: the
        // post-merge stale-size re-place, which sold 0.004 during the cancel.
        cancelBodyTpOrder: async () => (++cancelCalls === 1 ? { cancelled: true, filled: false, filledSize: 0 } : EXECUTION),
        // Force findMergeTarget to pick the single existing body.
        getPendingCounts: () => ({ total: 1_000_000 }),
      },
    });

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    assert.equal(cancelCalls, 2, 'merge cancel + post-merge stale-size cancel');
    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
    assert.ok(Math.abs(body.assetQty - 0.016) < 1e-9, `sold tranche deducted from the merged body, got ${body.assetQty}`);
    assert.notEqual(body.tpOrderId, 'tp-new-1', 'body no longer points at the cancelled post-merge TP');
    const sell = readSellRow('tp-new-1');
    assert.ok(sell && Number.isFinite(sell.bodyPnl), 'the sale was booked with bodyPnl');
    assert.equal(placed[0][0], 0.02, 'the first (merge) placement sold the full body');
    for (const [size] of placed.slice(1)) {
      assert.ok(size <= 0.016 + 1e-12, `re-placed TP ${size} must not exceed the 0.016 the body still holds`);
    }
  });

  it('startup overpriced-TP reprice books the sold tranche instead of re-listing it', async () => {
    const restored = [];
    // Own pair: start() reloads persisted state, which earlier tests wrote
    // for TEST_PAIR.
    const pair = '__test670startup__';
    const { eng, placed, cancels } = makeEngine({
      pair,
      cancelResult: EXECUTION,
      adapter: {
        getProductDetails: async () => ({ ...PRODUCT_DETAILS, quoteIncrement: '0.01' }),
        getCurrentPrice: async () => 50000,
        getAccountBalance: async () => ({ available: 0, hold: 0 }),
        loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
        // Live and unfilled at restore time; CANCELLED with the tranche once
        // the reprice has cancelled it.
        getOrder: async () => (cancels.length === 0
          ? { status: 'OPEN', filledSize: 0 }
          : { status: 'CANCELLED', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 }),
      },
      executor: {
        setPriceIncrement: () => {},
        restorePendingOrder: () => {},
        restoreBodyTpOrder: (...args) => restored.push(args),
        exportState: () => ({}),
        cancelAllEntries: async () => {},
        cancelAllLadderOrders: async () => {},
        cancelTpOrder: async () => ({ cancelled: true }),
        handleOrderCancel: () => {},
      },
    });
    eng._test.setRunning(false);
    eng._test.setRecoveryModule({
      recoverState: async () => ({
        position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
        openOrders: new Map(),
        discrepancies: [],
      }),
    });
    // Far above any tier's TP cap → the startup reprice fires.
    eng._getPositionState().celestialBodies[0].tpPrice = 75000;
    seedBuy(eng);

    started.add(eng);
    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    assert.ok(restored.some(([bodyId, orderId]) => bodyId === 'b1' && orderId === 'tp-old'), 'tracking restored before the reprice');
    assert.deepEqual(cancels, ['tp-old'], 'reprice cancelled through the executor');
    assertBookedAndResized(eng, placed, 'tp-old', pair);
    assert.equal(placed.length, 1, 'the reprice did not also re-place a full-size TP');
  });
  it('books a TP that executed its full planned size during the cancel as a completed cycle, not a partial', async () => {
    // Cancel-after-full-fill: the whole assetOnOrder (0.005) sold; the other
    // 0.005 of the body is designed holdback and must become reserves, not a
    // re-listed "remainder".
    const { eng, placed } = makeEngine({
      cancelResult: { cancelled: true, filled: false, filledSize: 0.005, filledValue: 252.5, averageFilledPrice: 50500, totalFees: 0.025 },
      adapter: {
        getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.005, filledValue: 252.5, averageFilledPrice: 50500 }),
        getOrderFills: async (orderId) => sellFill(orderId, '0.005'),
      },
      pair: '__test670full__',
    });

    const result = await eng.setBodyTpPercent('b1', 2);

    assert.equal(result.success, false);
    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 0, 'the completed TP closed its body');
    assert.equal(placed.length, 0, 'the designed holdback is not re-listed');
    const sell = readSellRow('tp-old', '__test670full__');
    assert.ok(Math.abs(sell.bodyHoldbackAsset - 0.005) < 1e-9, `holdback booked as reserves, got ${sell.bodyHoldbackAsset}`);
    assert.equal(sell.partialFill, undefined, 'not annotated as a partial fill');
  });
  it('books the sale when the exchange omits filledSize from the CANCELLED status', async () => {
    // cancelBodyTpOrder knows 0.004 sold (its polled high-water mark), but the
    // exchange's CANCELLED status carries no cumulative size.
    const { eng, placed } = makeEngine({
      cancelResult: EXECUTION,
      adapter: { getOrder: async () => ({ status: 'CANCELLED' }) },
      pair: '__test670nosize__',
    });
    seedBuy(eng);

    const result = await eng.setBodyTpPercent('b1', 2);

    assert.match(result.message, /sold during cancel — sale booked/);
    assertBookedAndResized(eng, placed, 'tp-old', '__test670nosize__');
  });
});
