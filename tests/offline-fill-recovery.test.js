// @ts-check
//
// Characterization tests for #367: checkOfflineOrderFills must route offline
// fills through the SAME canonical fill pipeline (handleOrderFill) that live
// WS/polling fills use, instead of duplicating fill accounting inline.
//
// Covers:
//  - full celestial body TP fill discovered offline (routes through
//    handleOrderFill; body removed, capital credited, no premature reset
//    while other bodies remain)
//  - partial celestial body TP fill discovered offline (pre-existing
//    cancelled-with-partials branch, unchanged by #367 — characterized here
//    for completeness per the issue's acceptance criteria)
//  - offline entry buy fill (creates/merges a celestial body + places its
//    dynamic TP, instead of the old flat totalAsset mutation with no body)
//  - final-body-fills-offline -> resetCycle() runs (the #367 core defect:
//    the old inline body-TP-fill path never checked
//    celestialBodies.length === 0 and never reset the cycle)
//  - error containment (#316): one order whose offline-fill accounting
//    can't be confirmed must not abort recovery of the bodies/entries behind
//    it
//
// Disk safety: throwaway pair '__test367__' -> data/coinbase/__test367__/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The size optimizer persists per-pair into the SHARED data/config.json;
// neutralize the write before regime-engine is required (it destructures
// updateRegimeConfig at load time), mirroring the other engine-level suites.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test367__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const makeAdapter = (over = {}) => ({
  getOpenOrders: async () => [],
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  cancelOrder: async () => ({ success: false }),
  getPositions: async () => [],
  ...over,
});

let tpCounter = 0;
const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: `tp-new-${++tpCounter}` }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  getPendingEntries: () => new Map(),
  getOrderPlacedAt: () => null,
  isLadderOrder: () => false,
  ...over,
});

const makeBody = (id, avgPrice, qty, tpOrderId = null) => ({
  id,
  tier: 'ASTEROID',
  assetQty: qty,
  costBasis: qty * avgPrice,
  avgPrice,
  tpPrice: tpOrderId ? avgPrice * 1.02 : 0,
  tpOrderId,
  assetOnOrder: tpOrderId ? qty : 0,
  buyOrders: [{ orderId: `buy-${id}` }],
  sourceOrderIds: [`buy-${id}`],
});

/** A sell fill for an offline body/legacy TP, shaped for adapter.getOrderFills. */
const sellFill = (orderId, size, price) => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'sell',
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  tradeTime: new Date().toISOString(),
}];

/** A buy fill for an offline entry order, shaped for adapter.getOrderFills. */
const buyFill = (orderId, size, price) => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'buy',
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  tradeTime: new Date().toISOString(),
}];

const makeEngine = ({ bodies = [], adapter, executor } = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(makeAdapter(adapter || {}));
  eng._test.setOrderExecutor(makeExecutor(executor || {}));
  const pos = eng._getPositionState();
  pos.celestialBodies = bodies;
  pos.totalAsset = bodies.reduce((s, b) => s + b.assetQty, 0);
  pos.totalCostBasis = bodies.reduce((s, b) => s + b.costBasis, 0);
  engines.push(eng);
  return eng;
};

describe('#367 offline recovery — full celestial body TP fill', () => {
  it('routes through handleOrderFill: removes the body, credits capital, and does NOT reset the cycle while a sibling body remains', async () => {
    const filled = makeBody('filled', 50000, 0.01, 'tp-filled');
    const sibling = makeBody('sibling', 50000, 0.01, 'tp-sibling');

    const eng = makeEngine({
      bodies: [filled, sibling],
      adapter: {
        // Only 'tp-filled' is gone from the book; 'tp-sibling' still rests.
        getOpenOrders: async () => [{ orderId: 'tp-sibling' }],
        getOrder: async (orderId) => (orderId === 'tp-filled'
          ? { status: 'FILLED', filledSize: 0.01, filledValue: 510, averageFilledPrice: 51000 }
          : { status: 'OPEN' }),
        getOrderFills: async (orderId) => (orderId === 'tp-filled' ? sellFill('tp-filled', 0.01, 51000) : []),
      },
    });
    const configBefore = eng._getConfig().maxUsdcDeployed;

    const result = await eng._test.checkOfflineOrderFills();

    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'the filled body is removed, the sibling remains');
    assert.equal(pos.celestialBodies[0].id, 'sibling');
    assert.equal(pos.cyclesCompleted, 0, 'cycle must NOT reset while a body is still active');
    assert.equal(pos.celestialState.bodiesCompleted, 1, 'canonical pipeline recorded the completed body');

    // proceeds(510) - costBasis(500) = 10 credited to capital
    assert.ok(Math.abs((eng._getConfig().maxUsdcDeployed - configBefore) - 10) < 1e-6, 'capital growth credited via the canonical pipeline');
    assert.equal(result.tpFilled, false, 'tpFilled only tracks the legacy activeTpOrderId path');
  });
});

describe('#367 offline recovery — partial celestial body TP fill (pre-existing branch, unchanged)', () => {
  it('reduces the body and re-places a TP for the remainder, without removing the body', async () => {
    const body = makeBody('partial', 50000, 0.01, 'tp-partial');
    let placedCount = 0;

    const eng = makeEngine({
      bodies: [body],
      adapter: {
        getOpenOrders: async () => [],
        getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, averageFilledPrice: 51000 }),
        getOrderFills: async () => sellFill('tp-partial', 0.004, 51000),
      },
      executor: {
        placeBodyTpOrder: async () => { placedCount++; return { success: true, orderId: 'tp-partial-replacement' }; },
      },
    });

    await eng._test.checkOfflineOrderFills();

    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'body remains active on a partial fill');
    assert.ok(Math.abs(pos.celestialBodies[0].assetQty - 0.006) < 1e-9, 'remaining qty reflects the partial sell');
    assert.equal(placedCount, 1, 'a fresh TP was placed for the remaining size');
  });
});

describe('#367 offline recovery — offline entry buy fill', () => {
  it('creates a celestial body and places its dynamic TP instead of mutating flat totalAsset', async () => {
    let tpPlacements = 0;
    const eng = makeEngine({
      bodies: [],
      adapter: {
        getOpenOrders: async () => [],
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.02, filledValue: 1000, averageFilledPrice: 50000 }),
        getOrderFills: async () => buyFill('buy-offline', 0.02, 50000),
      },
      executor: {
        getPendingEntries: () => new Map([['buy-offline', { type: 'entry', placedAt: Date.now() - 5000 }]]),
        placeBodyTpOrder: async () => { tpPlacements++; return { success: true, orderId: 'tp-new-offline' }; },
      },
    });

    const result = await eng._test.checkOfflineOrderFills();

    const pos = eng._getPositionState();
    assert.equal(result.entriesFilled, 1);
    assert.equal(pos.celestialBodies.length, 1, 'a celestial body was created for the offline entry fill');
    const body = pos.celestialBodies[0];
    assert.ok(
      (body.sourceOrderIds || []).includes('buy-offline') || (body.buyOrders || []).some(b => b.orderId === 'buy-offline'),
      'the new body owns the offline entry buy order',
    );
    assert.equal(tpPlacements, 1, 'a dynamic TP was placed for the new body (not the legacy monolithic TP)');
  });
});

describe('#367 offline recovery — final body fills offline triggers a full cycle reset', () => {
  it('resets cycle state when the last celestial body fills while offline', async () => {
    const onlyBody = makeBody('only', 50000, 0.01, 'tp-only');
    const eng = makeEngine({
      bodies: [onlyBody],
      adapter: {
        getOpenOrders: async () => [],
        // Only 'tp-only' (the body TP) reports FILLED. The pre-existing
        // legacy activeTpOrderId branch (untouched by #367) must see its own
        // stale pointer as still OPEN so this test isolates the body-TP path
        // — otherwise both branches would detect a fill and double-reset.
        getOrder: async (orderId) => (orderId === 'tp-only'
          ? { status: 'FILLED', filledSize: 0.01, filledValue: 510, averageFilledPrice: 51000 }
          : { status: 'OPEN' }),
        getOrderFills: async () => sellFill('tp-only', 0.01, 51000),
      },
    });
    const pos = eng._getPositionState();
    Object.assign(eng._getConfig(), { tpAutoManaged: true, sizeAutoManaged: true });
    pos.cycleBuys = 3;
    pos.activeTpOrderId = 'stale-legacy-tp';

    await eng._test.checkOfflineOrderFills();

    assert.equal(pos.celestialBodies.length, 0, 'last body removed');
    assert.equal(pos.cyclesCompleted, 1, 'resetCycle() incremented cyclesCompleted — the #367 defect left this at 0');
    assert.equal(pos.cycleBuys, 0, 'resetCycle() zeroed cycleBuys');
    assert.equal(pos.activeTpOrderId, null, 'resetCycle() cleared the stale legacy TP pointer');
    assert.equal(eng.getState().tpOptimizer.sampleCount, 1);
    assert.equal(eng.getState().sizeOptimizer.totalCycleCount, 1);
  });
});

describe('#367 offline recovery — error containment (#316)', () => {
  it('an unconfirmed offline body-TP fill does not abort recovery of the body behind it', async () => {
    const stuck = makeBody('stuck', 50000, 0.01, 'tp-stuck');
    const later = makeBody('later', 50000, 0.01, 'tp-later');

    let getOpenOrdersCalls = 0;
    const eng = makeEngine({
      bodies: [stuck, later],
      adapter: {
        // Call 1: checkOfflineOrderFills' snapshot (neither TP open -> both offline).
        // Call 2: cancelPartialFillOrder's cross-check for 'tp-stuck' -> fails,
        //   leaving that cancellation unresolved (issue #316).
        // Call 3: cancelPartialFillOrder's cross-check for 'tp-later' -> succeeds.
        getOpenOrders: async () => {
          getOpenOrdersCalls++;
          if (getOpenOrdersCalls === 2) throw new Error('open-order lookup unavailable');
          return [];
        },
        getOrder: async (orderId) => ({
          status: 'FILLED',
          filledSize: 0.01,
          filledValue: orderId === 'tp-stuck' ? 510 : 520,
          averageFilledPrice: orderId === 'tp-stuck' ? 51000 : 52000,
        }),
        getOrderFills: async (orderId) => (orderId === 'tp-later' ? sellFill('tp-later', 0.01, 52000) : []),
      },
    });

    // Must not throw out of checkOfflineOrderFills itself.
    await eng._test.checkOfflineOrderFills();

    const pos = eng._getPositionState();
    assert.ok(pos.celestialBodies.some(b => b.id === 'stuck'), 'the unconfirmed body is retained for the next reconcile');
    assert.equal(pos.celestialBodies.some(b => b.id === 'later'), false, 'the body BEHIND the stuck one was still recovered');
    assert.equal(pos.celestialBodies.length, 1);
  });

  it('an offline entry whose fill lookup fails does not abort recovery of the entry behind it', async () => {
    const eng = makeEngine({
      bodies: [],
      adapter: {
        getOpenOrders: async () => [],
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.01, filledValue: 500, averageFilledPrice: 50000 }),
        getOrderFills: async (orderId) => {
          if (orderId === 'buy-fail') throw new Error('exchange fills lookup down');
          return buyFill('buy-ok', 0.01, 50000);
        },
      },
      executor: {
        getPendingEntries: () => new Map([
          ['buy-fail', { type: 'entry', placedAt: Date.now() - 5000 }],
          ['buy-ok', { type: 'entry', placedAt: Date.now() - 4000 }],
        ]),
      },
    });

    await eng._test.checkOfflineOrderFills();

    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'only the recoverable entry produced a body');
    assert.ok(
      (pos.celestialBodies[0].sourceOrderIds || []).includes('buy-ok'),
      'the entry BEHIND the failing one was still recovered',
    );
  });
});

const setupLegacyTp = (eng, orderId) => {
  Object.assign(eng._getPositionState(), {
    activeTpOrderId: orderId,
    totalAsset: 0.01,
    totalCostBasis: 500,
    avgCostBasis: 50000,
    assetOnOrder: 0.009,
    cycleBuys: 3,
    ladderActive: true,
    pendingLadderOrders: [{ orderId: 'resting-ladder' }],
  });
};

const readClosedTrade = (orderId) => JSON.parse(
  fs.readFileSync(path.join(JUNK_DIR, 'closed-trades.json'), 'utf8'),
).find(t => t.sellOrderId === orderId);

describe('#367 offline recovery — legacy TP', () => {
  it('preserves legacy closed-trade fees, cost basis, holdback, and execution time', async () => {
    const orderId = 'legacy-audit';
    const fills = sellFill(orderId, 0.009, 51000);
    fills[0].totalCommission = '1';
    fills[0].tradeTime = '2026-09-01T12:00:00.000Z';
    const eng = makeEngine({
      adapter: {
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.009, averageFilledPrice: 51000 }),
        getOrderFills: async () => fills,
      },
      executor: { cancelAllLadderOrders: async () => ({ cancelled: 1 }) },
    });
    setupLegacyTp(eng, orderId);
    assert.equal((await eng._test.checkOfflineOrderFills()).tpFilled, true);
    const trade = readClosedTrade(orderId);
    assert.equal(trade.qtySold, 0.009);
    assert.equal(trade.sellFees, 1);
    assert.equal(trade.sellProceeds, 458);
    assert.equal(trade.costBasis, 450);
    assert.equal(trade.buyAvgPrice, 50000);
    assert.equal(trade.pnl, 8);
    assert.equal(trade.holdbackAsset, 0.001);
    assert.equal(trade.timestamp, Date.parse(fills[0].tradeTime));
    assert.equal(trade.source, 'offline');
    assert.equal(eng._getPositionState().cyclesCompleted, 1);
  });

  it('uses canonical capital, buy linkage, optimizers, ladder cleanup, and live-fill dedup', async () => {
    const orderId = 'legacy-lifecycle';
    let cancellations = 0;
    const eng = makeEngine({
      adapter: {
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.009, averageFilledPrice: 51000 }),
        getOrderFills: async () => sellFill(orderId, 0.009, 51000),
      },
      executor: { cancelAllLadderOrders: async () => { cancellations++; return { cancelled: 1 }; } },
    });
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { tpAutoManaged: true, sizeAutoManaged: true });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(buyFill('legacy-source-buy', 0.01, 50000)[0]);
    const beforeCapital = eng._getConfig().maxUsdcDeployed;
    await eng._test.checkOfflineOrderFills();
    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    const state = eng.getState();
    assert.equal(eng._getConfig().maxUsdcDeployed - beforeCapital, 9);
    assert.equal(state.position.cyclesCompleted, 1);
    assert.equal(state.position.activeTpOrderId, null);
    assert.equal(state.position.cycleBuys, 0);
    assert.equal(state.tpOptimizer.sampleCount, 1);
    assert.equal(state.sizeOptimizer.totalCycleCount, 1);
    assert.equal(cancellations, 1);
    assert.equal(state.closedTradesSummary.count, 1);
    assert.equal(ledger.getFillsForOrder('legacy-source-buy')[0].sellOrderId, orderId);
    assert.deepEqual(readClosedTrade(orderId).buyOrderIds, ['legacy-source-buy']);
  });

  for (const failure of ['status', 'fills']) {
    it(`contains legacy ${failure} lookup failure and recovers the next entry`, async () => {
      const eng = makeEngine({
        adapter: {
          getOrder: async (id) => {
            if (id === 'legacy-failed' && failure === 'status') throw new Error('status unavailable');
            return { status: 'FILLED', filledSize: 0.01, averageFilledPrice: 50000 };
          },
          getOrderFills: async (id) => {
            if (id === 'legacy-failed') throw new Error('fills unavailable');
            return buyFill('entry-after-legacy', 0.01, 50000);
          },
        },
        executor: { getPendingEntries: () => new Map([['entry-after-legacy', {}]]) },
      });
      setupLegacyTp(eng, 'legacy-failed');
      const result = await eng._test.checkOfflineOrderFills();
      assert.equal(result.tpFilled, false);
      assert.equal(result.entriesFilled, 1);
      assert.equal(eng._getPositionState().activeTpOrderId, 'legacy-failed');
      assert.equal(eng._getPositionState().cyclesCompleted, 0);
      assert.equal(eng._getPositionState().celestialBodies.length, 1);
    });
  }
});


describe('#367 canonical legacy sell audit', () => {
  it('records a live legacy sell and excludes unrelated body-owned buys', async () => {
    const orderId = 'legacy-live';
    const eng = makeEngine({
      adapter: { getOrderFills: async () => sellFill(orderId, 0.009, 51000) },
      executor: { cancelAllLadderOrders: async () => ({ cancelled: 1 }) },
    });
    setupLegacyTp(eng, orderId);
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(buyFill('unrelated-body-buy', 0.01, 50000)[0]);
    ledger.annotateFillsByOrderId('unrelated-body-buy', { isBodyOwned: true, bodyId: 'other-body' });
    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    assert.equal(readClosedTrade(orderId).source, 'live');
    assert.deepEqual(readClosedTrade(orderId).buyOrderIds, []);
    assert.equal(ledger.getFillsForOrder('unrelated-body-buy')[0].sellOrderId, undefined);
  });

  it('does not record or reset an untracked sell while celestial bodies remain', async () => {
    const eng = makeEngine({
      bodies: [makeBody('still-active', 50000, 0.01)],
      adapter: { getOrderFills: async () => sellFill('untracked-with-body', 0.009, 51000) },
    });
    await eng._test.handleOrderFill({ orderId: 'untracked-with-body', side: 'sell', isPartialFill: false });
    assert.equal(eng.getState().closedTradesSummary.count, 0);
    assert.equal(eng._getPositionState().cyclesCompleted, 0);
    assert.equal(eng._getPositionState().celestialBodies.length, 1);
  });
});
