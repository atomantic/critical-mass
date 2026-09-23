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

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test670__';
const JUNK_DIR = isolatedData.fundDir('coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const EXECUTION = { cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };

const sellFill = (orderId) => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'sell',
  price: '50500',
  size: '0.004',
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
const makeEngine = ({ cancelResult, adapter = {} }) => {
  const placed = [];
  const cancels = [];
  let n = 0;
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
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

const readSellRow = (orderId) => {
  const ledger = JSON.parse(fs.readFileSync(path.join(JUNK_DIR, 'fill-ledger.json'), 'utf8'));
  return ledger.find(f => f.orderId === orderId);
};

const assertBookedAndResized = (eng, placed, orderId) => {
  const body = eng._getPositionState().celestialBodies.find(b => b.id === 'b1');
  assert.ok(body, 'body survives a partial sale');
  assert.ok(Math.abs(body.assetQty - 0.006) < 1e-9, `sold tranche deducted, got ${body.assetQty}`);
  assert.ok(Math.abs(body.costBasis - 300) < 1e-6, `prorated cost deducted, got ${body.costBasis}`);
  assert.notEqual(body.tpOrderId, orderId, 'body no longer points at the cancelled TP');

  const sell = readSellRow(orderId);
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
});
