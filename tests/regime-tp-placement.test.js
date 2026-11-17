// @ts-check
// Issue #1980: take-profit placement lives in regime-tp-placement.js. Pins the
// factory's contract in isolation — the exposed surface, the sell size a body
// TP is placed for (body quantity less the planned holdback), the order of the
// executor call, the ownership handoff and the buy-link annotation, the
// engine-owned in-flight guard, the legacy single-TP fall-through, and the
// call-time accessors for the bindings the engine reassigns. Engine-level
// behavior stays covered by the body-TP, merge, reconcile and startup suites
// that drive a real engine.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTpPlacement } = require('../src/regime-tp-placement');
const { createPositionSizer } = require('../src/position-sizer');
const { createInitialRegimePositionState } = require('../src/regime-state-store');
const celestialHierarchy = require('../src/celestial-hierarchy');
const { roundPrice } = require('../src/volatility-utils');
const { PLACEMENT_RETRY_DELAY_MS } = require('../src/timing-constants');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const body = (orderId, qty, price) => celestialHierarchy.createNewBody(
  { assetQty: qty, costBasis: qty * price, avgPrice: price }, orderId
);

const make = (overrides = {}) => {
  const calls = [];
  const config = { holdbackRatio: 0.5, feeRate: 0.001, tpMult: 1, tpMinPercent: 1, tpMaxPercent: 5 };
  const positionState = createInitialRegimePositionState();
  const positionSizer = createPositionSizer('coinbase', config);
  const live = {
    adapter: { getOrder: async (orderId) => { calls.push(['getOrder', orderId]); return { filledSize: '0.4', filledValue: '40.4', averageFilledPrice: '101', totalFees: '0.04' }; } },
    orderExecutor: {
      placeBodyTpOrder: async (sellQty, tpPrice, bodyId, avgPrice, opts) => {
        calls.push(['placeBodyTpOrder', sellQty, tpPrice, bodyId, avgPrice]);
        if (opts.onAccepted) opts.onAccepted({ orderId: 'tp-1' });
        return { success: true, orderId: 'tp-1' };
      },
      placeTakeProfitOrder: async (sellQty, tpPrice, options) => {
        calls.push(['placeTakeProfitOrder', sellQty, tpPrice, options]);
        return { success: true, orderId: 'legacy-tp', updated: true };
      },
      cancelTpOrder: async () => { calls.push('cancelTpOrder'); },
      markSettled: (orderId) => { calls.push(['markSettled', orderId]); },
    },
    marketState: { recentSwing: 0, lastPrice: 100 },
    priceIncrement: 0.01,
    productDetails: null,
  };
  const deps = {
    exchange: 'coinbase', baseCurrency: 'BTC', isDryRun: false, config, logger: noopLogger,
    positionState,
    fillLedger: {
      annotateFillsByOrderIds: (ids, annotation) => { calls.push(['annotateFillsByOrderIds', [...ids], annotation]); },
      getCurrentCycleFills: () => [],
    },
    regimeDetector: { getMode: () => 'HARVEST' },
    macroRegime: null,
    positionSizer,
    tpPlacementInFlight: new Set(), dustWaitLoggedQty: new Map(),
    getAdapter: () => live.adapter,
    getOrderExecutor: () => live.orderExecutor,
    getMarketState: () => live.marketState,
    getPriceIncrement: () => live.priceIncrement,
    getProductDetails: () => live.productDetails,
    lookupOrNull: (label, subject, lookup) => lookup.catch(() => null),
    handleOrderFill: async (fillData) => { calls.push(['handleOrderFill', fillData]); },
    saveLiveStateGuarded: (reason) => { calls.push(['saveLiveStateGuarded', reason]); return true; },
    ...overrides,
  };
  return { api: createTpPlacement(deps), calls, config, positionState, positionSizer, live, deps };
};

describe('createTpPlacement (issue #1980)', () => {
  it('exposes the engine-facing TP placement functions', () => {
    const { api } = make();
    assert.deepEqual(Object.keys(api).sort(), [
      'calculateDynamicTpPercent', 'placeBodyTp', 'placeBodyTpWithRetry', 'placeTakeProfitOrder',
    ]);
  });

  it('the dynamic TP percent reads market state at call time, scales by regime and macro, and clamps', () => {
    let mode = 'HARVEST';
    const { api, live } = make({ regimeDetector: { getMode: () => mode } });
    assert.equal(api.calculateDynamicTpPercent(), 1); // no swing: the minimum
    live.marketState = { recentSwing: 2, lastPrice: 100 };
    assert.equal(api.calculateDynamicTpPercent(), 2);
    mode = 'CAUTION';
    assert.equal(api.calculateDynamicTpPercent(), 3);
    mode = 'TREND';
    assert.equal(api.calculateDynamicTpPercent(), 1.6);
    live.marketState = { recentSwing: 50, lastPrice: 100 };
    assert.equal(api.calculateDynamicTpPercent(), 5); // clamped to the maximum
    const macro = make({ macroRegime: { getMultipliers: () => ({ tpMult: 1.5 }) } });
    macro.live.marketState = { recentSwing: 2, lastPrice: 100 };
    assert.equal(macro.api.calculateDynamicTpPercent(), 3);
  });

  it('a body TP is placed for the body quantity less the planned holdback, then adopted, saved and linked to its buys', async () => {
    const { api, calls, positionState, positionSizer, deps } = make();
    const b = body('buy-1', 0.4, 100);
    positionState.celestialBodies = [b];
    const tierCfg = celestialHierarchy.getTierConfig(b.tier);
    const { tpPercent } = celestialHierarchy.calculateBodyTpPercent(1, b.tier, 5);
    const tpPrice = roundPrice(100 * (1 + tpPercent / 100), 0.01);
    const expected = positionSizer.calculateTakeProfitSize(0.4, 100, tpPrice, tierCfg.holdbackScale);
    assert.ok(expected.holdbackQty > 0);
    assert.ok(expected.sellQty < b.assetQty);

    assert.equal(await api.placeBodyTp(b), true);
    assert.deepEqual(calls, [
      ['placeBodyTpOrder', expected.sellQty, tpPrice, b.id, 100],
      // Live mode persists ownership inside the placement handoff.
      ['saveLiveStateGuarded', 'body-tp-placed'],
      ['annotateFillsByOrderIds', ['buy-1'], { sellOrderId: 'tp-1', bodyId: b.id, bodyTier: b.tier }],
    ]);
    assert.equal(b.tpOrderId, 'tp-1');
    assert.equal(b.tpPrice, tpPrice);
    assert.equal(b.assetOnOrder, expected.sellQty);
    assert.equal(positionState.assetOnOrder, expected.sellQty);
    assert.equal(deps.tpPlacementInFlight.size, 0);

    // A body that already owns a TP is never placed twice.
    calls.length = 0;
    assert.equal(await api.placeBodyTp(b), false);
    assert.deepEqual(calls, []);
  });

  it('dry-run passes no ownership handoff and still adopts the accepted order', async () => {
    const seen = [];
    const { api, calls, positionState, live } = make({ isDryRun: true });
    live.orderExecutor = {
      placeBodyTpOrder: async (sellQty, tpPrice, bodyId, avgPrice, opts) => { seen.push(opts.onAccepted); return { success: true, orderId: 'tp-dry' }; },
    };
    const b = body('buy-1', 0.4, 100);
    positionState.celestialBodies = [b];
    assert.equal(await api.placeBodyTp(b), true);
    assert.deepEqual(seen, [null]);
    assert.equal(b.tpOrderId, 'tp-dry');
    assert.ok(!calls.some((call) => call[0] === 'saveLiveStateGuarded'));
  });

  it('skips a body the engine-owned in-flight guard already holds and releases its own claim on failure', async () => {
    const { api, calls, positionState, live, deps } = make();
    const b = body('buy-1', 0.4, 100);
    positionState.celestialBodies = [b];
    deps.tpPlacementInFlight.add(b.id);
    assert.equal(await api.placeBodyTp(b), false);
    assert.deepEqual(calls, []);
    deps.tpPlacementInFlight.delete(b.id);
    live.orderExecutor = { placeBodyTpOrder: async () => { throw new Error('exchange down'); } };
    assert.equal(await api.placeBodyTp(b), false);
    assert.equal(b.tpOrderId, null);
    assert.equal(deps.tpPlacementInFlight.size, 0);
  });

  it('consumes the one-shot TP hints and applies an override above the floor', async () => {
    const { api, calls, positionState } = make();
    const b = body('buy-1', 0.4, 100);
    positionState.celestialBodies = [b];
    b._overrideTpPct = 3;
    b._maxTpPct = 2;
    assert.equal(await api.placeBodyTp(b), true);
    assert.equal(calls[0][2], 103);
    assert.equal('_overrideTpPct' in b, false);
    assert.equal('_maxTpPct' in b, false);
  });

  it('reads product details and the price increment at call time: a sub-minimum sell places the full body with no holdback', async () => {
    const { api, calls, positionState, live } = make();
    const b = body('buy-1', 0.29, 100);
    positionState.celestialBodies = [b];
    live.productDetails = { baseMinSize: '0.29', baseIncrement: '0.01' };
    live.priceIncrement = 0.5;
    assert.equal(await api.placeBodyTp(b), true);
    assert.deepEqual(calls[0].slice(0, 3), ['placeBodyTpOrder', 0.29, 101]);
    assert.equal(b.assetOnOrder, 0.29);
  });

  it('placeBodyTpWithRetry retries a failed placement once after the placement delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { api, positionState, live } = make();
    let attempts = 0;
    live.orderExecutor = {
      placeBodyTpOrder: async () => {
        attempts += 1;
        return attempts === 1 ? { success: false, errorMessage: 'rejected' } : { success: true, orderId: 'tp-2' };
      },
    };
    const b = body('buy-1', 0.4, 100);
    positionState.celestialBodies = [b];
    const placed = api.placeBodyTpWithRetry(b, 'Test');
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    t.mock.timers.tick(PLACEMENT_RETRY_DELAY_MS);
    assert.equal(await placed, true);
    assert.equal(attempts, 2);
    assert.equal(b.tpOrderId, 'tp-2');
  });

  it('placeTakeProfitOrder with bodies cancels an unowned legacy TP and places only the missing body TPs', async () => {
    const { api, calls, positionState } = make();
    const covered = body('buy-1', 0.4, 100);
    covered.tpOrderId = 'tp-existing';
    const missing = body('buy-2', 0.4, 100);
    positionState.celestialBodies = [covered, missing];
    positionState.activeTpOrderId = 'legacy-tp';
    positionState.lastTpPrice = 105;
    await api.placeTakeProfitOrder();
    assert.equal(calls[0], 'cancelTpOrder');
    assert.deepEqual(calls.filter((call) => call[0] === 'placeBodyTpOrder').map((call) => call[3]), [missing.id]);
    assert.equal(positionState.activeTpOrderId, null);
    assert.equal(positionState.lastTpPrice, 0);
    assert.equal(covered.tpOrderId, 'tp-existing');
    assert.equal(missing.tpOrderId, 'tp-1');
  });

  it('with no bodies it falls through to the legacy single TP, sized after the holdback, and links the core buys', async () => {
    const { api, calls, positionState, positionSizer, deps } = make();
    deps.fillLedger.getCurrentCycleFills = () => [
      { side: 'buy', orderId: 'core-1' },
      { side: 'buy', orderId: 'body-owned', isBodyOwned: true },
      { side: 'buy', orderId: 'folded', cycleAttribution: 'timeframe' },
      { side: 'sell', orderId: 'sell-1' },
    ];
    positionState.celestialBodies = [];
    positionState.totalAsset = 0.4;
    positionState.avgCostBasis = 100;
    const expected = positionSizer.calculateTakeProfitSize(0.4, 100, 101);
    await api.placeTakeProfitOrder({ forceUpdate: true });
    assert.deepEqual(calls, [
      ['placeTakeProfitOrder', expected.sellQty, 101, { forceUpdate: true }],
      ['annotateFillsByOrderIds', ['core-1'], { sellOrderId: 'legacy-tp' }],
    ]);
    assert.ok(expected.sellQty < 0.4);
    assert.equal(positionState.activeTpOrderId, 'legacy-tp');
    assert.equal(positionState.lastTpPrice, 101);
    assert.equal(positionState.assetOnOrder, expected.sellQty);
  });

  it('a legacy TP that filled during its own cancel-and-replace is settled, then routed through the fill pipeline', async () => {
    const { api, calls, positionState, live } = make();
    positionState.celestialBodies = [];
    positionState.totalAsset = 0.4;
    positionState.avgCostBasis = 100;
    live.orderExecutor = {
      placeTakeProfitOrder: async () => ({ filledDuringCancel: true, filledOrderId: 'old-tp', filledSize: 0 }),
      markSettled: (orderId) => { calls.push(['markSettled', orderId]); },
    };
    await api.placeTakeProfitOrder();
    assert.deepEqual(calls, [
      // No fill fields on the cancel result: fetched through the swapped-in adapter.
      ['getOrder', 'old-tp'],
      ['markSettled', 'old-tp'],
      ['handleOrderFill', {
        orderId: 'old-tp', side: 'sell', status: 'FILLED',
        filledSize: 0.4, filledValue: 40.4, averageFilledPrice: 101, totalFees: 0.04,
      }],
    ]);
    assert.equal(positionState.activeTpOrderId, null);
  });
});
