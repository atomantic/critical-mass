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
  it('reconcile retries a failed booking with the known execution even when the status omits filledSize', async () => {
    let openOrders = [{ orderId: 'tp-old' }];
    const { eng, placed } = makeEngine({
      cancelResult: EXECUTION,
      adapter: {
        // The first booking cannot confirm the order terminal; afterwards the
        // exchange reports CANCELLED with no cumulative size at all.
        getOpenOrders: async () => openOrders,
        getOrder: async () => ({ status: 'CANCELLED' }),
      },
      pair: '__test670retry__',
    });
    seedBuy(eng);

    const first = await eng.setBodyTpPercent('b1', 2);
    assert.match(first.message, /deferred to reconciliation/);
    const body = eng._getPositionState().celestialBodies[0];
    assert.equal(body.tpOrderId, 'tp-old');
    assert.equal(body.pendingTpCancelExecution.filledSize, 0.004, 'the known execution is kept for the retry');

    openOrders = [];
    await eng._test.reconcileTick();

    assertBookedAndResized(eng, placed, 'tp-old', '__test670retry__');
    assert.equal(body.pendingTpCancelExecution, undefined, 'marker cleared once booked');
  });

  it('classifies a full execution on a legacy body with no assetOnOrder as a completed TP', async () => {
    const { eng, placed } = makeEngine({
      cancelResult: { cancelled: true, filled: false, filledSize: 0.0099, filledValue: 499.95, averageFilledPrice: 50500, totalFees: 0.05 },
      adapter: {
        getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.0099 }),
        getOrderFills: async (orderId) => sellFill(orderId, '0.0099'),
      },
      pair: '__test670legacy__',
    });
    eng._getPositionState().celestialBodies[0].assetOnOrder = 0;

    await eng.setBodyTpPercent('b1', 2);

    assert.equal(eng._getPositionState().celestialBodies.length, 0, 'the completed TP closed its body');
    assert.equal(placed.length, 0);
  });
  for (const [label, status] of [
    ['omits filledSize', { status: 'CANCELLED' }],
    ['understates filledSize', { status: 'CANCELLED', filledSize: 0.002, filledValue: 101, averageFilledPrice: 50500 }],
  ]) {
    it(`startup recovery books a persisted cancel execution when the CANCELLED status ${label}`, async () => {
      // A cancel-for-replace booking failed before a restart: the body still
      // points at the cancelled TP and carries the known 0.004 sale.
      const pair = `__test670restart_${label.split(' ')[0]}__`;
      const { eng, placed } = makeEngine({
        pair,
        cancelResult: { cancelled: true, filled: false, filledSize: 0 },
        adapter: {
          getProductDetails: async () => ({ ...PRODUCT_DETAILS, quoteIncrement: '0.01' }),
          getCurrentPrice: async () => 50000,
          getAccountBalance: async () => ({ available: 0, hold: 0 }),
          loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
          getOpenOrders: async () => [],
          getOrder: async () => status,
        },
        executor: {
          setPriceIncrement: () => {},
          getPendingEntries: () => new Map(),
          restorePendingOrder: () => {},
          restoreBodyTpOrder: () => {},
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
      const body = eng._getPositionState().celestialBodies[0];
      body.pendingTpCancelExecution = { orderId: 'tp-old', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };
      seedBuy(eng);

      started.add(eng);
      const result = await eng.start();
      assert.equal(result.success, true, `start() must succeed: ${result.error}`);

      assertBookedAndResized(eng, placed, 'tp-old', pair);
      const live = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
      assert.equal(live.pendingTpCancelExecution, undefined, 'marker cleared once booked');
    });
  }

  it('accepts the final trade-level fills over a stale high-water size when the CANCELLED status omits filledSize', async () => {
    // The executor's polled high-water mark (0.004) lags the true final fill
    // (0.0045); the exchange's CANCELLED status carries no size.
    const { eng, placed } = makeEngine({
      cancelResult: EXECUTION,
      adapter: {
        getOrder: async () => ({ status: 'CANCELLED' }),
        getOrderFills: async (orderId) => sellFill(orderId, '0.0045'),
      },
      pair: '__test670stale__',
    });
    seedBuy(eng);

    const result = await eng.setBodyTpPercent('b1', 2);

    assert.match(result.message, /sold during cancel — sale booked/);
    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
    assert.ok(Math.abs(body.assetQty - 0.0055) < 1e-9, `the true final fill is deducted, got ${body.assetQty}`);
    assert.equal(body.pendingTpCancelExecution, undefined, 'booked, not left for an endless retry');
    assert.ok(readSellRow('tp-old', '__test670stale__'), 'the sale reached the fill ledger');
    for (const [size] of placed) assert.ok(size <= 0.0055 + 1e-12, `re-placed TP ${size} fits the remaining body`);
  });
});

// ---------------------------------------------------------------------------
// #744 follow-ups: the merge-snapshot stale-TP cancel, reconcile's partial
// routes on a full planned-size execution, and the stale cancel-execution
// marker.
// ---------------------------------------------------------------------------

const { isFullTpExecution, pruneStaleTpCancelMarkers } = require('../src/regime-engine');

const buyFill = (orderId, size = '0.01') => [{
  tradeId: `${orderId}-t1`, orderId, side: 'buy', price: '50000', size,
  totalCommission: '0.05', rebate: '0', liquidityIndicator: 'MAKER', tradeTime: new Date().toISOString(),
}];

/**
 * Drive a buy that merges into b1 (clean cancel of tp-old → Race-3 snapshot,
 * merged body re-armed on tp-new-1), then deliver the snapshot's late 0.002
 * fill. The merge-snapshot branch deducts it and cancels the live body's
 * now-oversized tp-new-1 — the cancel under test.
 */
const runMergeSnapshotStaleCancel = async ({ pair, staleCancel, adapter = {}, executor = {} }) => {
  let cancelCalls = 0;
  const { eng, placed } = makeEngine({
    pair,
    cancelResult: null,
    adapter: {
      getOrder: async (orderId) => (orderId === 'tp-old'
        ? { status: 'OPEN', filledSize: 0 }
        : { status: 'CANCELLED', filledSize: staleCancel.filledSize, filledValue: staleCancel.filledValue, averageFilledPrice: 50500, totalFees: staleCancel.totalFees }),
      getOrderFills: async (orderId) => {
        if (orderId === 'buy-new') return buyFill(orderId);
        if (orderId === 'tp-old') return sellFill(orderId, '0.002');
        return sellFill(orderId, String(staleCancel.filledSize));
      },
      ...adapter,
    },
    executor: {
      cancelBodyTpOrder: async () => (++cancelCalls === 1 ? { cancelled: true, filled: false, filledSize: 0 } : staleCancel),
      // Force findMergeTarget to pick the single existing body.
      getPendingCounts: () => ({ total: 1_000_000 }),
      ...executor,
    },
  });
  seedBuy(eng);

  await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });
  const merged = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
  assert.equal(merged.tpOrderId, 'tp-new-1', 'merged body re-armed on a fresh TP');
  assert.ok(eng._test.getMergeTpSnapshots().completed.has('tp-old'), 'the cancelled TP left a Race-3 snapshot');
  const placedBeforeSnapshot = placed.length;

  // The snapshot TP's late fill: a true partial (0.002 of its 0.005).
  await eng._test.handleOrderFill({ orderId: 'tp-old', side: 'sell', status: 'CANCELLED', filledSize: 0.002, filledValue: 101, averageFilledPrice: 50500 });

  return { eng, placed, placedAfter: placed.slice(placedBeforeSnapshot), cancelCalls: () => cancelCalls };
};

describe('#744 merge-snapshot stale-TP cancel books an execution during the cancel', () => {
  it('books the stale TP tranche and re-lists only what the live body still holds', async () => {
    const pair = '__test744snap__';
    const staleCancel = { cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };
    const { eng, placedAfter, cancelCalls } = await runMergeSnapshotStaleCancel({ pair, staleCancel });

    assert.equal(cancelCalls(), 2, 'merge cancel + merge-snapshot stale-TP cancel');
    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
    assert.ok(body, 'a partial sale keeps the live body');
    // 0.02 merged − 0.002 snapshot tranche − 0.004 sold during the stale cancel.
    assert.ok(Math.abs(body.assetQty - 0.014) < 1e-9, `both tranches deducted, got ${body.assetQty}`);
    assert.ok(body.tpOrderId && body.tpOrderId !== 'tp-new-1', 'body no longer points at the cancelled stale TP');
    assert.equal(body.pendingTpCancelExecution, undefined, 'booked, no retry marker left behind');

    const staleSell = readSellRow('tp-new-1', pair);
    assert.ok(staleSell && Number.isFinite(staleSell.bodyPnl), 'the stale TP sale reached the ledger with bodyPnl');
    assert.equal(staleSell.partialFill, true, 'booked as a partial of the live body');
    assert.equal(staleSell.bodyHoldbackAsset, 0, 'a partial sale books no reserves');
    assert.ok(readSellRow('tp-old', pair)?.mergeSnapshot, 'the snapshot sale itself was still booked');

    assert.equal(placedAfter.length, 1, 'exactly one replacement TP — the booking path re-armed it, the snapshot branch did not add another');
    assert.ok(placedAfter[0][0] <= 0.014 + 1e-12, `replacement TP ${placedAfter[0][0]} must not exceed the 0.014 the body still holds`);
  });

  it('closes the live body when the oversized stale TP sold more than the body still holds', async () => {
    // tp-new-1 was sized for the pre-deduction 0.02 body; after the 0.002
    // snapshot tranche the body holds 0.018, and the stale TP sold 0.019 of
    // its larger order before the cancel landed.
    const pair = '__test744snapover__';
    const staleCancel = { cancelled: true, filled: false, filledSize: 0.019, filledValue: 959.5, averageFilledPrice: 50500, totalFees: 0.1 };
    const { eng, placedAfter } = await runMergeSnapshotStaleCancel({
      pair,
      staleCancel,
      executor: { cancelAllLadderOrders: async () => {}, cancelAllEntries: async () => {} },
    });

    const bodies = eng._getPositionState().celestialBodies;
    assert.equal(bodies.find(b => b.id === 'b1'), undefined, 'the body is closed, not left with a negative quantity');
    for (const b of bodies) assert.ok(b.assetQty >= 0, `no negative body, got ${b.assetQty}`);
    assert.equal(placedAfter.length, 0, 'nothing is re-listed for a closed body');
    const staleSell = readSellRow('tp-new-1', pair);
    assert.ok(staleSell && Number.isFinite(staleSell.bodyPnl), 'the sale was booked');
    assert.equal(staleSell.partialFill, undefined, 'booked as the body-closing sale, not a partial');
  });

  it('does not book the snapshot TP twice when its fill lands during the merge cancel of that same order', async () => {
    // The buy-merge snapshots tp-old and cancels it; before that cancel
    // returns, tp-old's own 0.002 fill is delivered. The body still points at
    // tp-old, so the merge-snapshot branch sees it as the live "stale" TP and
    // its cancel reports the same 0.002 execution.
    const pair = '__test744snapself__';
    let cancelCalls = 0;
    let eng;
    ({ eng } = makeEngine({
      pair,
      cancelResult: null,
      adapter: {
        getOrder: async (orderId) => (orderId === 'tp-old' && cancelCalls === 0
          ? { status: 'OPEN', filledSize: 0 }
          : { status: 'CANCELLED', filledSize: 0.002, filledValue: 101, averageFilledPrice: 50500 }),
        getOrderFills: async (orderId) => (orderId === 'buy-new' ? buyFill(orderId) : sellFill(orderId, '0.002')),
      },
      executor: {
        cancelBodyTpOrder: async (bodyId, orderId) => {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            await eng._test.handleOrderFill({ orderId: 'tp-old', side: 'sell', status: 'CANCELLED', filledSize: 0.002, filledValue: 101, averageFilledPrice: 50500 });
            return { cancelled: true, filled: false, filledSize: 0 };
          }
          return { cancelled: true, filled: false, filledSize: 0.002, filledValue: 101, averageFilledPrice: 50500, totalFees: 0.01 };
        },
        getPendingCounts: () => ({ total: 1_000_000 }),
      },
    }));
    seedBuy(eng);

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    const ledger = JSON.parse(fs.readFileSync(path.join(isolatedData.fundDir('coinbase', pair), 'fill-ledger.json'), 'utf8'));
    assert.equal(ledger.filter(f => f.orderId === 'tp-old').length, 1, 'one sell row for tp-old');
    for (const b of eng._getPositionState().celestialBodies) {
      assert.ok(b.assetQty > 0, `no body drained by a double deduction, got ${b.assetQty}`);
    }
    const total = eng._getPositionState().celestialBodies.reduce((sum, b) => sum + b.assetQty, 0);
    // 0.01 seed − 0.002 sold once + 0.01 new buy.
    assert.ok(Math.abs(total - 0.018) < 1e-9, `the 0.002 sale is deducted exactly once, got ${total}`);
  });

  it('keeps the stale TP identity and a retry marker when booking the execution fails', async () => {
    const pair = '__test744snapfail__';
    const staleCancel = { cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };
    const { eng, placedAfter } = await runMergeSnapshotStaleCancel({
      pair,
      staleCancel,
      // The freeze cannot confirm tp-new-1 terminal → the nested booking throws.
      adapter: { getOpenOrders: async () => [{ orderId: 'tp-new-1' }] },
    });

    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
    assert.equal(body.tpOrderId, 'tp-new-1', 'reconcile can still find the CANCELLED partial');
    assert.equal(body.pendingTpCancelExecution?.orderId, 'tp-new-1');
    assert.equal(body.pendingTpCancelExecution?.filledSize, 0.004, 'the known execution is kept for the retry');
    assert.ok(Math.abs(body.assetQty - 0.018) < 1e-9, `only the snapshot tranche is deducted so far, got ${body.assetQty}`);
    assert.equal(placedAfter.length, 0, 'no replacement TP over un-booked asset');
  });
});

describe('#744 reconcile classifies a full planned-size execution as a completed TP', () => {
  for (const [label, first, frozen] of [
    ['CANCELLED status with no completionPercentage',
      { status: 'CANCELLED', filledSize: 0.005, filledValue: 252.5, averageFilledPrice: 50500 },
      { status: 'CANCELLED', filledSize: 0.005, filledValue: 252.5, averageFilledPrice: 50500 }],
    ['OPEN status within 1% of the planned size',
      { status: 'OPEN', filledSize: 0.00496, filledValue: 250.48, averageFilledPrice: 50500 },
      { status: 'CANCELLED', filledSize: 0.00496, filledValue: 250.48, averageFilledPrice: 50500 }],
  ]) {
    it(`closes the body and books the holdback as reserves (${label})`, async () => {
      const pair = `__test744rec_${first.status}__`;
      let reads = 0;
      const { eng, placed } = makeEngine({
        pair,
        cancelResult: null,
        adapter: {
          getOrder: async () => (++reads === 1 ? first : frozen),
          getOrderFills: async (orderId) => sellFill(orderId, String(first.filledSize)),
        },
      });
      seedBuy(eng);

      await eng._test.reconcileTick();

      assert.equal(eng._getPositionState().celestialBodies.length, 0, 'the completed TP closed its body');
      assert.equal(placed.length, 0, 'the designed holdback is not re-listed');
      const sell = readSellRow('tp-old', pair);
      assert.ok(sell, 'the sale reached the fill ledger');
      assert.ok(Math.abs(sell.bodyHoldbackAsset - (0.01 - first.filledSize)) < 1e-9, `holdback booked as reserves, got ${sell.bodyHoldbackAsset}`);
      assert.equal(sell.partialFill, undefined, 'not annotated as a partial fill');
    });
  }

  it('still books a genuine partial as a partial', async () => {
    const pair = '__test744recpartial__';
    const { eng, placed } = makeEngine({ pair, cancelResult: null });
    seedBuy(eng);

    await eng._test.reconcileTick();

    assertBookedAndResized(eng, placed, 'tp-old', pair);
  });
});

describe('#744 stale pendingTpCancelExecution marker', () => {
  it('is dropped once reconcile books the sale through the plain status branch', async () => {
    const pair = '__test744marker__';
    const { eng, placed } = makeEngine({
      pair,
      cancelResult: null,
      // The exchange reports MORE than the marker knew, so reconcile books
      // from the status and the marker is never consumed by the retry path.
      adapter: {
        getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.0045, filledValue: 227.25, averageFilledPrice: 50500, totalFees: 0.02 }),
        getOrderFills: async (orderId) => sellFill(orderId, '0.0045'),
      },
    });
    const body = eng._getPositionState().celestialBodies[0];
    body.pendingTpCancelExecution = { orderId: 'tp-old', filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };
    seedBuy(eng);

    await eng._test.reconcileTick();

    const live = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
    assert.ok(Math.abs(live.assetQty - 0.0055) < 1e-9, `status-reported sale booked, got ${live.assetQty}`);
    assert.notEqual(live.tpOrderId, 'tp-old');
    assert.ok(placed.length >= 1);
    assert.equal(live.pendingTpCancelExecution, undefined, 'marker for the old order is gone');
    const persisted = JSON.parse(fs.readFileSync(path.join(isolatedData.fundDir('coinbase', pair), 'regime-state.json'), 'utf8'));
    const persistedBody = (persisted.position?.celestialBodies || persisted.celestialBodies || []).find(b => b.id === 'b1');
    assert.ok(persistedBody, 'the body was persisted');
    assert.equal(persistedBody.pendingTpCancelExecution, undefined, 'and is not persisted');
  });

  it('pruneStaleTpCancelMarkers keeps only markers for the current TP', () => {
    const current = { tpOrderId: 'a', pendingTpCancelExecution: { orderId: 'a', filledSize: 1 } };
    const moved = { tpOrderId: 'b', pendingTpCancelExecution: { orderId: 'a', filledSize: 1 } };
    const cleared = { tpOrderId: null, pendingTpCancelExecution: { orderId: 'a', filledSize: 1 } };
    const none = { tpOrderId: 'c' };
    assert.equal(pruneStaleTpCancelMarkers([current, moved, cleared, none]), 2);
    assert.ok(current.pendingTpCancelExecution);
    assert.equal(moved.pendingTpCancelExecution, undefined);
    assert.equal(cleared.pendingTpCancelExecution, undefined);
    assert.equal(pruneStaleTpCancelMarkers(null), 0);
  });

  it('isFullTpExecution mirrors the sell handler classification', () => {
    assert.equal(isFullTpExecution({ assetOnOrder: 0.005, assetQty: 0.01 }, 0.00495), true);
    assert.equal(isFullTpExecution({ assetOnOrder: 0.005, assetQty: 0.01 }, 0.0049), false);
    assert.equal(isFullTpExecution({ assetOnOrder: 0, assetQty: 0.01 }, 0.0095), true, 'legacy fallback');
    assert.equal(isFullTpExecution({ assetOnOrder: 0, assetQty: 0.01 }, 0.009), false);
    assert.equal(isFullTpExecution(undefined, 1), false);
    assert.equal(isFullTpExecution({ assetOnOrder: 0.005 }, 0), false);
  });
});
