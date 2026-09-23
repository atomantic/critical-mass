// @ts-check
//
// Issue #607: a buy order can be PARTLY closed.
//
// computeRealizedFromCyclePairs used to decide a buy was closed on a boolean —
// `sellOrderId` set and that sell has fills. `sellOrderId` is stamped across
// every fill of a buy order at TP placement, so when the TP that closed a body
// sold less than the order bought (the body only ever attributed the order's
// first tranche), the unsold remainder counted as closed and left the position
// model entirely. Body sales now record, per buy order, what they consumed
// (sold + booked holdback), and held inventory is derived from that record.
//
// Issue #704 (folded in): a buy folded onto a body after an earlier partial
// sale must not inherit that sale's consumption.
//
// Disk safety: throwaway pairs '__test607<x>__' live under a disposable temp root
// that is removed in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-partial-buy-consumption-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// sync-fills destructures getAdapter at load; stub before anything requires it.
const adapters = require('../src/adapters');
const originalGetAdapter = adapters.getAdapter;
adapters.getAdapter = () => ({ getReconciliationFills: async () => [] });

const { createRegimeEngine } = require('../src/regime-engine');
const celestialHierarchy = require('../src/celestial-hierarchy');

// One pair per engine: each engine loads (and persists) its own fill ledger,
// so sharing a pair would leak one test's fills into the next.
let pairSeq = 0;
const nextPair = () => `__test607${String.fromCharCode(97 + pairSeq++)}__`;

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  adapters.getAdapter = originalGetAdapter;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };
const EPS = 1e-6;

const rawFill = (side, orderId, tradeId, size, price) => ({
  tradeId,
  orderId,
  side,
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  liquidityIndicator: side === 'buy' ? 'TAKER' : 'MAKER',
  tradeTime: new Date().toISOString(),
});

const makeEngine = (adapter, executor = {}) => {
  let tp = 0;
  const pair = nextPair();
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter({ getOrder: async () => ({ filledSize: 0, status: 'OPEN' }), ...adapter });
  eng._test.setOrderExecutor({
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: `tp-replaced-${++tp}` }),
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    ...executor,
  });
  engines.push(eng);
  return eng;
};

/** A body built the way createNewBody builds one, from `qty` of `orderId`. */
const makeBody = (id, orderId, qty, price, tpOrderId) => ({
  ...celestialHierarchy.createNewBody({ assetQty: qty, costBasis: qty * price, avgPrice: price }, orderId),
  id,
  tier: 'satellite',
  tpOrderId,
  tpPrice: price * 1.04,
  assetOnOrder: qty,
});

const sellFill = (orderId, size, price) => ({
  orderId, side: 'sell', status: 'FILLED', filledSize: size, averageFilledPrice: price, isPartialFill: false,
});

describe('planBodyConsumption', () => {
  const entry = (orderId, assetQty, consumedQty) => ({ orderId, assetQty, ...(consumedQty != null && { consumedQty }) });

  it('spreads a sale over the tranches in proportion to their open quantity', () => {
    const entries = [entry('o', 0.01, 0.004), entry('f', 0.005, 0)];
    const plan = celestialHierarchy.planBodyConsumption(entries, 0.011, 0.003);
    assert.ok(plan);
    const o = plan.orders.get('o');
    const f = plan.orders.get('f');
    assert.ok(Math.abs(o.delta - 0.003 * 6 / 11) < 1e-12);
    assert.ok(Math.abs(f.delta - 0.003 * 5 / 11) < 1e-12);
    assert.equal(o.prior, 0.004);
    assert.equal(f.prior, 0, 'a fold-in inherits nothing from the earlier sale (issue #704)');
    assert.equal(entries[0].consumedQty, 0.004, 'pure: entries are not mutated');
  });

  it('aggregates several tranches of one order', () => {
    const plan = celestialHierarchy.planBodyConsumption([entry('o', 0.3, 0), entry('o', 0.2, 0)], 0.5, 0.5);
    assert.ok(Math.abs(plan.orders.get('o').delta - 0.5) < 1e-12);
    assert.equal(plan.entries.length, 2);
  });

  it('seeds pre-#607 tranches from their legacy consumed fraction', () => {
    const plan = celestialHierarchy.planBodyConsumption([entry('o', 0.01)], 0.006, 0.006, () => 0.4);
    assert.ok(Math.abs(plan.orders.get('o').prior - 0.004) < 1e-12);
    assert.ok(Math.abs(plan.entries[0].next - 0.01) < 1e-12);
  });

  it('returns null when no tranche has open quantity to consume', () => {
    assert.equal(celestialHierarchy.planBodyConsumption([], 0.5, 0.5), null, 'no tranches (adopted body)');
    assert.equal(celestialHierarchy.planBodyConsumption([entry('o', 0)], 0.5, 0.5), null, 'zero-qty backfilled tranche');
    assert.equal(celestialHierarchy.planBodyConsumption([entry('core-migration', 0.5)], 0.5, 0.5), null);
    assert.equal(celestialHierarchy.planBodyConsumption([entry('o', 0.5, 0.5)], 0.5, 0.5), null, 'fully consumed');
    assert.equal(celestialHierarchy.planBodyConsumption([entry('o', 0.5)], 0.5, 0), null, 'nothing consumed');
  });

  it('leaves the untracked share of a body unrecorded instead of loading it onto the tranches', () => {
    // 0.4 tracked + 0.1 with no tranche (e.g. an adopted body merged in).
    const partial = celestialHierarchy.planBodyConsumption([entry('o', 0.4, 0)], 0.5, 0.1);
    assert.ok(Math.abs(partial.coverage - 0.8) < 1e-12);
    assert.ok(Math.abs(partial.orders.get('o').delta - 0.08) < 1e-12, 'the tranche takes its 80% share of the sale');
    const full = celestialHierarchy.planBodyConsumption([entry('o', 0.4, 0)], 0.5, 0.5);
    assert.ok(Math.abs(full.orders.get('o').delta - 0.4) < 1e-12, 'a full close consumes the whole tranche');
  });

  it('consumes every tranche in full when the sale closes the body', () => {
    // A legacy-seeded tranche that overstates the body by a sliver.
    const over = celestialHierarchy.planBodyConsumption([entry('o', 0.52, 0)], 0.5, 0.5, undefined, { closesBody: true });
    assert.equal(over.coverage, 1);
    assert.ok(Math.abs(over.orders.get('o').delta - 0.52) < 1e-12, 'no sliver of a closed body stays open');
    const notClosing = celestialHierarchy.planBodyConsumption([entry('o', 0.52, 0)], 0.5, 0.5);
    assert.ok(Math.abs(notClosing.orders.get('o').delta - 0.5) < 1e-12, 'a partial consumes only its own share');
  });
});

describe('a TP that sold less than its buy order bought (issue #607)', () => {
  it('keeps the unsold remainder held open, and the coverage identity holds from the ledger alone', async () => {
    const eng = makeEngine({
      getOrderFills: async (orderId) => (orderId === 'tp-a' ? [rawFill('sell', 'tp-a', 'tp-a-t1', 0.8, 2600)] : []),
      // No account-balance API: the check must stand on the ledger alone.
      getAccountBalance: undefined,
    });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();

    // Order buy-a filled 2.0 ETH in two tranches; the body only ever took the
    // first (the second is the tranche the pre-fix partial-fill leak lost).
    ledger.ingestFill(rawFill('buy', 'buy-a', 'buy-a-t1', 0.86, 2500));
    ledger.ingestFill(rawFill('buy', 'buy-a', 'buy-a-t2', 1.14, 2500));
    ledger.ingestFill(rawFill('buy', 'buy-b', 'buy-b-t1', 0.1, 2400));
    // TP placement stamps sellOrderId over EVERY fill of the order.
    ledger.annotateFillsByOrderId('buy-a', { sellOrderId: 'tp-a' });
    ledger.annotateFillsByOrderId('buy-b', { sellOrderId: 'tp-b' });

    const bodyA = makeBody('body-aaaaaaaa', 'buy-a', 0.86, 2500, 'tp-a');
    bodyA.assetOnOrder = 0.8; // 0.06 designed holdback
    const bodyB = makeBody('body-bbbbbbbb', 'buy-b', 0.1, 2400, 'tp-b'); // keeps the cycle open
    pos.celestialBodies = [bodyA, bodyB];

    await eng._test.handleOrderFill(sellFill('tp-a', 0.8, 2600));

    assert.deepEqual(pos.celestialBodies.map(b => b.id), ['body-bbbbbbbb'], 'body A closed');
    assert.deepEqual(ledger.getBuyOrderConsumption('buy-a').consumedBy, { 'tp-a': 0.86 },
      'the sale consumed the tranche the body held: 0.8 sold + 0.06 holdback');

    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.realizedAssetPnL - 0.06) < EPS, `holdback booked as reserves, got ${derived.realizedAssetPnL}`);
    assert.ok(Math.abs(derived.heldOpenAssetQty - (1.14 + 0.1)) < EPS,
      `the unsold 1.14 stays held alongside body B, got ${derived.heldOpenAssetQty}`);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - (1.14 * 2500 + 0.1 * 2400)) < 0.01,
      `heldOpenBuyCostBasis carries the remainder's cost, got ${derived.heldOpenBuyCostBasis}`);
    assert.ok(Math.abs(derived.ledgerNetAsset - (derived.heldOpenAssetQty + derived.realizedAssetPnL)) < EPS,
      'ledger net == held open + reserves');

    // The coverage check needs no exchange balance to see the lost remainder.
    pos.engineStartTime = Date.now() - 86_400_000;
    await eng._test.sweepLedgerDrift();
    const cov = eng._test.getPositionCoverage();
    assert.ok(cov.skipped, 'the exchange-balance reading was not available');
    assert.ok(Math.abs(cov.ledger.unmodelled - 1.14) < EPS, `ledger coverage gap, got ${cov.ledger.unmodelled}`);
    assert.ok(Math.abs(cov.ledger.untrackedOpen - 1.14) < EPS, `open inventory no body tracks, got ${cov.ledger.untrackedOpen}`);
    assert.ok(Math.abs(cov.ledger.inBodies - 0.1) < EPS);
    assert.equal(eng.getState().positionCoverage.ledger.unmodelled, cov.ledger.unmodelled, 'surfaced on engine state');
  });

  it('reports no ledger gap when every bought unit is in a body or reserves', async () => {
    const eng = makeEngine({
      getOrderFills: async (orderId) => (orderId === 'tp-c' ? [rawFill('sell', 'tp-c', 'tp-c-t1', 0.45, 2600)] : []),
    });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-c', 'buy-c-t1', 0.5, 2500));
    ledger.ingestFill(rawFill('buy', 'buy-d', 'buy-d-t1', 0.1, 2400));
    ledger.annotateFillsByOrderId('buy-c', { sellOrderId: 'tp-c' });
    const bodyC = makeBody('body-cccccccc', 'buy-c', 0.5, 2500, 'tp-c');
    bodyC.assetOnOrder = 0.45;
    pos.celestialBodies = [bodyC, makeBody('body-dddddddd', 'buy-d', 0.1, 2400, 'tp-d')];

    await eng._test.handleOrderFill(sellFill('tp-c', 0.45, 2600));
    pos.engineStartTime = Date.now() - 86_400_000;
    await eng._test.sweepLedgerDrift();

    const cov = eng._test.getPositionCoverage();
    assert.ok(Math.abs(cov.ledger.unmodelled) < EPS, `no gap, got ${cov.ledger.unmodelled}`);
    assert.ok(Math.abs(cov.ledger.untrackedOpen) < EPS, `no untracked open inventory, got ${cov.ledger.untrackedOpen}`);
  });
});

describe('sequential partial sales around a fold-in (issues #607, #704)', () => {
  it('charges each buy only for the sales it was part of, and held cost reconciles to the body', async () => {
    const sells = {
      'tp-1': [rawFill('sell', 'tp-1', 'tp-1-t1', 0.004, 52000)],
      'tp-2': [rawFill('sell', 'tp-2', 'tp-2-t1', 0.003, 61000)],
      'tp-3': [rawFill('sell', 'tp-3', 'tp-3-t1', 0.008, 62000)],
    };
    const eng = makeEngine({ getOrderFills: async (orderId) => sells[orderId] || [] });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-o', 'buy-o-t1', 0.01, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-x', 'buy-x-t1', 0.1, 40000));
    ledger.annotateFillsByOrderId('buy-o', { sellOrderId: 'tp-1' });

    const body = makeBody('body-oooooooo', 'buy-o', 0.01, 50000, 'tp-1');
    body.assetOnOrder = 0.0099;
    pos.celestialBodies = [body, makeBody('body-xxxxxxxx', 'buy-x', 0.1, 40000, 'tp-x')];
    const bodyHeld = () => ledger.getDerivedRealizedPnL().heldOpenBuyCostBasis - 0.1 * 40000;

    // S1: a true partial of body O's TP — 0.004 of 0.0099 on order.
    await eng._test.handleOrderFill(sellFill('tp-1', 0.004, 52000));
    assert.ok(Math.abs(body.assetQty - 0.006) < EPS);
    assert.ok(Math.abs(bodyHeld() - body.costBasis) < 0.01, `held cost == body cost after S1 (${bodyHeld()} vs ${body.costBasis})`);

    // Fold-in F lands on the same body after S1, at a different price.
    ledger.ingestFill(rawFill('buy', 'buy-f', 'buy-f-t1', 0.005, 60000));
    celestialHierarchy.mergeIntoBody(body, { assetQty: 0.005, costBasis: 300, avgPrice: 60000 }, 100000, 'buy-f');
    ledger.annotateFillsByOrderId('buy-f', { sellOrderId: body.tpOrderId });
    ledger.annotateFillsByOrderId('buy-o', { sellOrderId: body.tpOrderId });
    body.tpOrderId = 'tp-2';
    body.assetOnOrder = 0.0109;

    // S2: a second, independent partial — 0.003 of the 0.011 body.
    await eng._test.handleOrderFill(sellFill('tp-2', 0.003, 61000));
    assert.ok(Math.abs(body.costBasis - 600 * (1 - 0.003 / 0.011)) < 0.01, `body cost ${body.costBasis}`);
    assert.ok(Math.abs(bodyHeld() - body.costBasis) < 0.01,
      `held cost reconciles to the body after S2 (${bodyHeld()} vs ${body.costBasis}) — the #704 example understated it by $90`);

    const consumedF = ledger.getBuyOrderConsumption('buy-f');
    assert.deepEqual(Object.keys(consumedF.consumedBy), ['tp-2'], 'F is charged only for S2');
    assert.ok(Math.abs(consumedF.consumedQty - 0.003 * 5 / 11) < EPS, `F consumed its open share of S2, got ${consumedF.consumedQty}`);
    assert.equal(consumedF.consumedCostFraction, undefined,
      'the body-level consumedCostFraction scalar is no longer stamped onto buys a consumption record covers');

    // S3: the body's TP fills completely — everything left is consumed.
    body.tpOrderId = 'tp-3';
    body.assetOnOrder = 0.0079;
    await eng._test.handleOrderFill(sellFill('tp-3', 0.0079, 62000));
    assert.deepEqual(pos.celestialBodies.map(b => b.id), ['body-xxxxxxxx'], 'body O closed');
    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - 0.1 * 40000) < 0.01, `only body X is held, got ${derived.heldOpenBuyCostBasis}`);
    assert.ok(Math.abs(derived.heldOpenAssetQty - 0.1) < EPS);
    assert.ok(Math.abs(derived.ledgerNetAsset - (derived.heldOpenAssetQty + derived.realizedAssetPnL)) < EPS,
      'ledger net == held open + reserves after the full sequence');
  });
});

describe('legacy consumedCostFraction fallback (issue #704)', () => {
  it('composes each buy\'s own fraction when a body\'s tranches cannot record the sale', async () => {
    // A body from before buyOrders tracked quantities: no usable tranches, so
    // sales fall back to consumedCostFraction. The #704 worked example.
    const sells = { 'tp-1': [rawFill('sell', 'tp-1', 'tp-1-t1', 0.004, 52000)] };
    const eng = makeEngine({ getOrderFills: async (orderId) => sells[orderId] || [] });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-o', 'buy-o-t1', 0.01, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-x', 'buy-x-t1', 0.1, 40000));
    ledger.annotateFillsByOrderId('buy-o', { sellOrderId: 'tp-1' });
    const body = { ...makeBody('body-llllllll', 'buy-o', 0.01, 50000, 'tp-1'), buyOrders: [], assetOnOrder: 0.0099 };
    pos.celestialBodies = [body, makeBody('body-xxxxxxxx', 'buy-x', 0.1, 40000, 'tp-x')];

    await eng._test.handleOrderFill(sellFill('tp-1', 0.004, 52000)); // S1
    assert.ok(Math.abs(ledger.getBuyOrderConsumption('buy-o').consumedCostFraction - 0.4) < 1e-9);
    assert.equal(ledger.getBuyOrderConsumption('buy-o').consumedBy, null, 'nothing recorded per buy order');

    // Fold-in F: 0.005 @ 60k = $300, known to the body only by order id.
    ledger.ingestFill(rawFill('buy', 'buy-f', 'buy-f-t1', 0.005, 60000));
    body.assetQty += 0.005;
    body.costBasis += 300;
    body.avgPrice = body.costBasis / body.assetQty;
    body.sourceOrderIds.push('buy-f');
    // The TP re-placed after S1 now rests for the merged body; it is what S2 hits.
    const tp2 = body.tpOrderId;
    assert.ok(tp2, 'S1 re-placed a TP for the remainder');
    ledger.annotateFillsByOrderId('buy-f', { sellOrderId: tp2 });
    body.assetOnOrder = 0.0109;
    sells[tp2] = [rawFill('sell', tp2, `${tp2}-t1`, 0.003, 61000)];

    await eng._test.handleOrderFill(sellFill(tp2, 0.003, 61000)); // S2
    const ratio2 = 0.003 / 0.011;
    assert.ok(Math.abs(ledger.getBuyOrderConsumption('buy-f').consumedCostFraction - ratio2) < 1e-9,
      'F is charged for S2 only, not S1');
    assert.ok(Math.abs(ledger.getBuyOrderConsumption('buy-o').consumedCostFraction - (1 - 0.6 * (1 - ratio2))) < 1e-9,
      'O composes both sales');
    const held = ledger.getDerivedRealizedPnL().heldOpenBuyCostBasis - 0.1 * 40000;
    assert.ok(Math.abs(held - body.costBasis) < 0.01, `held ${held} reconciles to the body's ${body.costBasis}`);
  });
});

describe('merge-snapshot partial sale (issue #607)', () => {
  it('charges only the tranches the snapshot TP covered, not a buy folded in after the snapshot', async () => {
    // #227 shape: a buy's merge attempt cancels the target's TP, which turns
    // out to have sold 0.004 during the cancel. While that sale is being
    // booked, a second buy (F) folds onto the same live body at a different
    // price. The snapshot's TP never covered F.
    let target;
    let getOrderCalls = 0;
    const eng = makeEngine({
      getOrder: async () => {
        getOrderCalls++;
        return getOrderCalls === 1
          ? { filledSize: 0, status: 'OPEN' }
          : { filledSize: 0.004, status: 'CANCELLED', averageFilledPrice: 50500 };
      },
      getOpenOrders: async () => [],
      getOrderFills: async (orderId) => {
        if (orderId === 'tp-target') {
          eng.getFillLedger().ingestFill(rawFill('buy', 'buy-f', 'buy-f-t1', 0.006, 55000));
          celestialHierarchy.mergeIntoBody(target, { assetQty: 0.006, costBasis: 330, avgPrice: 55000 }, 100000, 'buy-f');
          return [rawFill('sell', 'tp-target', 'tp-target-t1', 0.004, 50500)];
        }
        return orderId === 'buy-new' ? [rawFill('buy', 'buy-new', 'buy-new-t1', 0.01, 50000)] : [];
      },
    }, {
      getPendingCounts: () => ({ total: 1_000_000 }), // force the single body as merge target
      cancelBodyTpOrder: async () => ({ cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0 }),
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-o', 'buy-o-t1', 0.01, 50000));
    ledger.annotateFillsByOrderId('buy-o', { sellOrderId: 'tp-target' });
    target = makeBody('body-tttttttt', 'buy-o', 0.01, 50000, 'tp-target');
    target.assetOnOrder = 0.0099;
    eng._getPositionState().celestialBodies = [target];

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    const live = eng._getPositionState().celestialBodies.find(b => b.id === 'body-tttttttt');
    assert.ok(live, 'the target body survives its partial');
    assert.ok(Math.abs(live.costBasis - 630) < 1e-6, `body cost after the sale, got ${live.costBasis}`);
    assert.deepEqual(ledger.getBuyOrderConsumption('buy-o').consumedBy, { 'tp-target': 0.004 });
    assert.equal(ledger.getBuyOrderConsumption('buy-f').consumedBy, null, 'the fold-in was not part of the sold TP');
    const foldIn = live.buyOrders.find(e => e.orderId === 'buy-f');
    assert.equal(foldIn.consumedQty, 0);

    // Held cost for the target's buys reconciles exactly to the body: O keeps
    // 0.006 × $50k, F keeps all of its $330.
    const held = ledger.getDerivedRealizedPnL().heldOpenBuyCostBasis - 0.01 * 50000; // minus buy-new's own body
    assert.ok(Math.abs(held - live.costBasis) < 0.01, `held ${held} vs body ${live.costBasis}`);
  });
});
