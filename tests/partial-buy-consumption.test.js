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

describe('merge-snapshot complete sale with the live body still present (issues #607, #718)', () => {
  it('closes the whole snapshot body, leaving only the fold-in, so bodies + reserves match the ledger', async () => {
    // The target TP fills its FULL planned size (0.0099 of a 0.01 body; 0.0001
    // is designed holdback) during a buy-merge cancel, while a fold-in lands
    // on the same live body. The snapshot body closed: the live body loses
    // the whole snapshot (sold + holdback) and keeps only the fold-in.
    let target;
    let getOrderCalls = 0;
    const eng = makeEngine({
      getOrder: async () => {
        getOrderCalls++;
        return getOrderCalls === 1
          ? { filledSize: 0, status: 'OPEN' }
          : { filledSize: 0.0099, status: 'CANCELLED', averageFilledPrice: 50500 };
      },
      getOpenOrders: async () => [],
      getOrderFills: async (orderId) => {
        if (orderId === 'tp-full') {
          eng.getFillLedger().ingestFill(rawFill('buy', 'buy-f', 'buy-f-t1', 0.006, 55000));
          celestialHierarchy.mergeIntoBody(target, { assetQty: 0.006, costBasis: 330, avgPrice: 55000 }, 100000, 'buy-f');
          return [rawFill('sell', 'tp-full', 'tp-full-t1', 0.0099, 50500)];
        }
        return orderId === 'buy-new' ? [rawFill('buy', 'buy-new', 'buy-new-t1', 0.01, 50000)] : [];
      },
    }, {
      getPendingCounts: () => ({ total: 1_000_000 }),
      cancelBodyTpOrder: async () => ({ cancelled: true, filled: false, filledSize: 0.0099, filledValue: 499.95, averageFilledPrice: 50500, totalFees: 0 }),
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-o', 'buy-o-t1', 0.01, 50000));
    ledger.annotateFillsByOrderId('buy-o', { sellOrderId: 'tp-full' });
    target = makeBody('body-ffffffff', 'buy-o', 0.01, 50000, 'tp-full');
    target.assetOnOrder = 0.0099;
    const pos = eng._getPositionState();
    pos.celestialBodies = [target];

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    assert.deepEqual(ledger.getBuyOrderConsumption('buy-o').consumedBy, { 'tp-full': 0.01 },
      'the snapshot buy is consumed in full: sold + booked holdback');
    assert.equal(ledger.getBuyOrderConsumption('buy-f').consumedBy, null, 'the fold-in was not part of the sold TP');

    const live = pos.celestialBodies.find(b => b.id === 'body-ffffffff');
    assert.ok(live, 'the live body survives, holding only the fold-in');
    assert.ok(Math.abs(live.assetQty - 0.006) < EPS, `fold-in qty only, got ${live.assetQty}`);
    assert.ok(Math.abs(live.costBasis - 330) < 0.01, `fold-in cost only, got ${live.costBasis}`);
    assert.ok(Math.abs(live.avgPrice - 55000) < 0.01, `fold-in price, got ${live.avgPrice}`);
    assert.deepEqual(live.buyOrders.map(e => e.orderId), ['buy-f'], 'the closed snapshot tranche left the live body');
    assert.ok(!live.sourceOrderIds.includes('buy-o'), 'the closed snapshot buy is no longer a source of the live body');
    assert.ok(live.sourceOrderIds.includes('buy-f'));

    const derived = ledger.getDerivedRealizedPnL();
    const inBodies = pos.celestialBodies.reduce((sum, b) => sum + b.assetQty, 0);
    const bodyCost = pos.celestialBodies.reduce((sum, b) => sum + b.costBasis, 0);
    assert.ok(Math.abs(derived.heldOpenAssetQty - inBodies) < EPS, `held ${derived.heldOpenAssetQty} vs bodies ${inBodies}`);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - bodyCost) < 0.01, `held cost ${derived.heldOpenBuyCostBasis} vs bodies ${bodyCost}`);
    // Issue #718: the holdback is booked as reserves and NOT also kept in the
    // live body, so the ledger identity holds exactly.
    assert.ok(Math.abs(derived.realizedAssetPnL - 0.0001) < EPS);
    assert.ok(Math.abs((inBodies + derived.realizedAssetPnL) - derived.ledgerNetAsset) < EPS,
      `bodies ${inBodies} + reserves ${derived.realizedAssetPnL} vs ledger ${derived.ledgerNetAsset}`);
  });
});

describe('late complete merge-snapshot fill after the live body was re-armed (issue #718)', () => {
  it('links the closed snapshot\'s untracked buys to the sell that closed them', async () => {
    // A buy merges onto the body cleanly (its TP cancel reports no execution),
    // and the merged body gets a replacement TP, which re-stamps every source
    // buy with that TP's orderId. The OLD TP's full fill then arrives late
    // through the completed-snapshot window. Its source buy is legacy
    // (sourceOrderIds only, no tranche), so only sellOrderId can close it.
    const eng = makeEngine({
      getOrderFills: async (orderId) => {
        if (orderId === 'buy-new') return [rawFill('buy', 'buy-new', 'buy-new-t1', 0.01, 50000)];
        if (orderId === 'tp-old') return [rawFill('sell', 'tp-old', 'tp-old-t1', 0.0099, 52000)];
        return [];
      },
    }, {
      getPendingCounts: () => ({ total: 1_000_000 }), // force the single body as merge target
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-l', 'buy-l-t1', 0.01, 50000));
    ledger.annotateFillsByOrderId('buy-l', { sellOrderId: 'tp-old' });
    const legacy = makeBody('body-llllllll', 'buy-l', 0.01, 50000, 'tp-old');
    legacy.buyOrders = [];
    legacy.sourceOrderIds = ['buy-l'];
    legacy.assetOnOrder = 0.0099;
    const pos = eng._getPositionState();
    pos.celestialBodies = [legacy];

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });
    const merged = pos.celestialBodies.find(b => b.id === 'body-llllllll');
    assert.ok(merged && merged.tpOrderId && merged.tpOrderId !== 'tp-old', 'the merged body was re-armed');
    assert.notEqual(ledger.getFillsForOrder('buy-l')[0].sellOrderId, 'tp-old', 'the replacement TP re-stamped the legacy buy');

    await eng._test.handleOrderFill(sellFill('tp-old', 0.0099, 52000));

    const live = pos.celestialBodies.find(b => b.id === 'body-llllllll');
    assert.ok(live, 'the live body survives, holding only the fold-in');
    assert.ok(Math.abs(live.assetQty - 0.01) < EPS, `fold-in qty only, got ${live.assetQty}`);
    assert.ok(Math.abs(live.costBasis - 500) < 0.01, `fold-in cost only, got ${live.costBasis}`);
    assert.ok(!live.sourceOrderIds.includes('buy-l'));
    assert.equal(ledger.getFillsForOrder('buy-l')[0].sellOrderId, 'tp-old', 'the closed legacy buy is linked to the sell that closed it');

    const derived = ledger.getDerivedRealizedPnL();
    const inBodies = pos.celestialBodies.reduce((sum, b) => sum + b.assetQty, 0);
    const bodyCost = pos.celestialBodies.reduce((sum, b) => sum + b.costBasis, 0);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - bodyCost) < 0.01, `held cost ${derived.heldOpenBuyCostBasis} vs bodies ${bodyCost}`);
    assert.ok(Math.abs((inBodies + derived.realizedAssetPnL) - derived.ledgerNetAsset) < EPS,
      `bodies ${inBodies} + reserves ${derived.realizedAssetPnL} vs ledger ${derived.ledgerNetAsset}`);
  });
});

describe('legacy buy order split across bodies (issue #607)', () => {
  it('seeds the first record with what other bodies already sold under sellOrderId closure', async () => {
    // Pre-#607: order buy-s filled in two advancing partials that landed in two
    // bodies. Body 1 (0.004) closed long ago; body 2 (0.006) is still open.
    // Neither tranche carries consumedQty.
    const eng = makeEngine({
      getOrderFills: async (orderId) => (orderId === 'tp-2' ? [rawFill('sell', 'tp-2', 'tp-2-t1', 0.0059, 52000)] : []),
    });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-s', 'buy-s-t1', 0.004, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-s', 'buy-s-t2', 0.006, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-y', 'buy-y-t1', 0.1, 40000));
    ledger.ingestFill(rawFill('sell', 'tp-1', 'tp-1-t1', 0.004, 52000));
    ledger.annotateFillsByOrderId('tp-1', { bodyPnl: 8, bodyHoldbackAsset: 0, isBodyOwned: true });
    ledger.annotateFillsByOrderId('buy-s', { sellOrderId: 'tp-2' });
    const body2 = makeBody('body-22222222', 'buy-s', 0.006, 50000, 'tp-2');
    delete body2.buyOrders[0].consumedQty; // a pre-#607 tranche
    body2.assetOnOrder = 0.0059;
    pos.celestialBodies = [body2, makeBody('body-yyyyyyyy', 'buy-y', 0.1, 40000, 'tp-y')];

    await eng._test.handleOrderFill(sellFill('tp-2', 0.0059, 52000));

    assert.deepEqual(ledger.getBuyOrderConsumption('buy-s').consumedBy, { __legacy__: 0.004, 'tp-2': 0.006 });
    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.heldOpenAssetQty - 0.1) < EPS, `body 1's sold tranche is not resurrected as open, got ${derived.heldOpenAssetQty}`);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - 4000) < 0.01);
  });
});

describe('late fill of a rolled-up source TP (issue #607)', () => {
  it('does not close tranches the surviving target body now carries', async () => {
    const sells = {};
    const eng = makeEngine({
      getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
      getOpenOrders: async () => [],
      getOrderFills: async (orderId) => sells[orderId] || [],
    }, {
      // Both cancels report clean — the source TP fills anyway afterwards.
      cancelBodyTpOrder: async () => ({ cancelled: true, filled: false, filledSize: 0 }),
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-src', 'buy-src-t1', 0.01, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-tgt', 'buy-tgt-t1', 0.02, 51000));
    const source = makeBody('src', 'buy-src', 0.01, 50000, 'tp-src');
    source.assetOnOrder = 0.0099;
    const target = makeBody('tgt', 'buy-tgt', 0.02, 51000, 'tp-tgt');
    const pos = eng._getPositionState();
    pos.celestialBodies = [source, target];

    const result = await eng.manualMergeBody('src', { targetId: 'tgt' });
    assert.equal(result.success, true, `roll-up completes: ${result.message}`);
    assert.deepEqual(pos.celestialBodies.map(b => b.id), ['tgt']);

    // The "cancelled" source TP turns out to have filled 0.004.
    sells['tp-src'] = [rawFill('sell', 'tp-src', 'tp-src-t1', 0.004, 52000)];
    await eng._test.handleOrderFill(sellFill('tp-src', 0.004, 52000));

    assert.deepEqual(ledger.getBuyOrderConsumption('buy-src').consumedBy, { 'tp-src': 0.004 },
      'only the sold qty is consumed — the target still carries the rest');
    const derived = ledger.getDerivedRealizedPnL();
    const bodyCost = pos.celestialBodies.reduce((sum, b) => sum + b.costBasis, 0);
    assert.ok(derived.heldOpenBuyCostBasis >= bodyCost - 0.01 - 0.004 * 50000,
      `held cost ${derived.heldOpenBuyCostBasis} must not drop the whole source (bodies ${bodyCost})`);
    assert.ok(Math.abs(derived.heldOpenAssetQty - (0.03 - 0.004)) < EPS, `held qty ${derived.heldOpenAssetQty}`);
  });
});

describe('legacy order closed before deploy, continued after (issue #607)', () => {
  it('seals the pre-deploy closure at boot, so a re-stamped later tranche does not resurrect it', async () => {
    const sells = { 'tp-b': [rawFill('sell', 'tp-b', 'tp-b-t1', 0.0059, 52000)] };
    const eng = makeEngine({ getOrderFills: async (orderId) => sells[orderId] || [] });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    // Pre-deploy: 0.004 of buy-p filled into body A, whose TP closed it.
    ledger.ingestFill(rawFill('buy', 'buy-p', 'buy-p-t1', 0.004, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-y', 'buy-y-t1', 0.1, 40000));
    ledger.annotateFillsByOrderId('buy-p', { sellOrderId: 'tp-a' });
    ledger.ingestFill(rawFill('sell', 'tp-a', 'tp-a-t1', 0.004, 52000));
    ledger.annotateFillsByOrderId('tp-a', { bodyPnl: 8, bodyHoldbackAsset: 0, isBodyOwned: true });
    pos.celestialBodies = [makeBody('body-yyyyyyyy', 'buy-y', 0.1, 40000, 'tp-y')];

    // Deploy: boot seals the legacy closure.
    assert.equal(eng._test.sealLegacyClosure(), 1);
    assert.deepEqual(ledger.getBuyOrderConsumption('buy-p').consumedBy, { __legacy__: 0.004 });
    assert.equal(eng._test.sealLegacyClosure(), 0, 'idempotent');

    // Post-deploy: the same order fills 0.006 more into a new body B, whose
    // TP placement re-stamps sellOrderId on EVERY row of the order.
    ledger.ingestFill(rawFill('buy', 'buy-p', 'buy-p-t2', 0.006, 50000));
    const bodyB = makeBody('body-bbbbbbbb', 'buy-p', 0.006, 50000, 'tp-b');
    bodyB.assetOnOrder = 0.0059;
    pos.celestialBodies.push(bodyB);
    ledger.annotateFillsByOrderId('buy-p', { sellOrderId: 'tp-b' });
    assert.ok(Math.abs(ledger.getDerivedRealizedPnL().heldOpenAssetQty - 0.106) < EPS, 'only B and Y are held before B sells');

    await eng._test.handleOrderFill(sellFill('tp-b', 0.0059, 52000));

    assert.deepEqual(ledger.getBuyOrderConsumption('buy-p').consumedBy, { __legacy__: 0.004, 'tp-b': 0.006 });
    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.heldOpenAssetQty - 0.1) < EPS, `A's long-sold part is not resurrected, got ${derived.heldOpenAssetQty}`);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis - 4000) < 0.01, `no phantom cost, got ${derived.heldOpenBuyCostBasis}`);
  });

  it('does not seal orders whose linked sell has no fills, and credits live tranches', () => {
    const eng = makeEngine({});
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-r', 'buy-r-t1', 0.01, 50000));
    ledger.annotateFillsByOrderId('buy-r', { sellOrderId: 'tp-resting' });
    // A live body whose order is (falsely) linked to a filled sell (#677 shape).
    ledger.ingestFill(rawFill('buy', 'buy-l', 'buy-l-t1', 0.02, 50000));
    ledger.ingestFill(rawFill('sell', 'tp-other', 'tp-other-t1', 0.001, 52000));
    ledger.annotateFillsByOrderId('buy-l', { sellOrderId: 'tp-other' });
    const live = makeBody('body-llllllll', 'buy-l', 0.02, 50000, 'tp-l');
    delete live.buyOrders[0].consumedQty;
    pos.celestialBodies = [live];

    assert.equal(eng._test.sealLegacyClosure(), 1);
    assert.equal(ledger.getBuyOrderConsumption('buy-r').consumedBy, null, 'a resting TP link is not closure');
    assert.deepEqual(ledger.getBuyOrderConsumption('buy-l').consumedBy, { __legacy__: 0 }, 'the live tranche stays open');
  });
});

describe('legacy seal ordering at boot (issue #607)', () => {
  it('seals before offline-fill recovery re-stamps the order onto a new body TP', async () => {
    // Pre-deploy: 0.004 of buy-p went into body A, whose TP tp-a closed it.
    // During the deploy downtime the rest of buy-p (0.006) filled; boot's
    // offline recovery books it into a new body B and places B's TP, which
    // re-stamps sellOrderId on every row of buy-p.
    const sells = {};
    let sealedWhenOfflineCheckRan = null;
    let eng;
    eng = makeEngine({
      getProductDetails: async () => PRODUCT_DETAILS,
      getOpenOrders: async () => {
        sealedWhenOfflineCheckRan = eng.getFillLedger().getBuyOrderConsumption('buy-p').consumedBy;
        return [];
      },
      getOrder: async (orderId) => (orderId === 'buy-p'
        ? { status: 'FILLED', side: 'BUY', filledSize: 0.01, averageFilledPrice: 50000 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async (orderId) => {
        if (orderId === 'buy-p') {
          return [rawFill('buy', 'buy-p', 'buy-p-t1', 0.004, 50000), rawFill('buy', 'buy-p', 'buy-p-t2', 0.006, 50000)];
        }
        return sells[orderId] || [];
      },
      getAccountBalance: async () => ({ total: 0, available: 0, hold: 0 }),
    }, {
      getPendingEntries: () => new Map([['buy-p', { type: 'entry' }]]),
      getPendingOrdersList: () => [],
      setPriceIncrement: () => {},
      placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-b' }),
    });
    eng._test.setRunning(false);
    eng._test.setRecoveryModule({
      recoverState: async () => ({ position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0 } }),
    });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-p', 'buy-p-t1', 0.004, 50000));
    ledger.annotateFillsByOrderId('buy-p', { sellOrderId: 'tp-a' });
    ledger.ingestFill(rawFill('sell', 'tp-a', 'tp-a-t1', 0.004, 52000));
    ledger.annotateFillsByOrderId('tp-a', { bodyPnl: 8, bodyHoldbackAsset: 0, isBodyOwned: true });
    pos.celestialBodies = [];

    await eng.start().catch(() => {}); // later boot stages are not under test

    assert.deepEqual(sealedWhenOfflineCheckRan, { __legacy__: 0.004 }, 'sealed before offline fill recovery ran');
    const bodyB = pos.celestialBodies.find(b => b.buyOrders.some(e => e.orderId === 'buy-p'));
    assert.ok(bodyB, 'offline recovery booked the downtime tranche into a body');
    assert.equal(ledger.getFillsForOrder('buy-p')[0].sellOrderId, bodyB.tpOrderId, "B's TP re-stamped the order");

    // B sells: A's long-sold share must not come back as held.
    sells[bodyB.tpOrderId] = [rawFill('sell', bodyB.tpOrderId, 'tp-b-t1', bodyB.assetOnOrder, 52000)];
    await eng._test.handleOrderFill(sellFill(bodyB.tpOrderId, bodyB.assetOnOrder, 52000));
    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.heldOpenAssetQty) < EPS, `nothing of buy-p is held, got ${derived.heldOpenAssetQty}`);
    assert.ok(Math.abs(derived.heldOpenBuyCostBasis) < 0.01, `no phantom cost, got ${derived.heldOpenBuyCostBasis}`);
  });

  it('leaves an order unsealed when a live body references it through a tranche it cannot measure', () => {
    const eng = makeEngine({});
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-u', 'buy-u-t1', 0.02, 50000));
    ledger.ingestFill(rawFill('buy', 'buy-s', 'buy-s-t1', 0.01, 50000));
    ledger.ingestFill(rawFill('sell', 'tp-stale', 'tp-stale-t1', 0.001, 52000));
    ledger.annotateFillsByOrderId('buy-u', { sellOrderId: 'tp-stale' });
    ledger.annotateFillsByOrderId('buy-s', { sellOrderId: 'tp-stale' });
    // Pre-quantity-tracking body: backfilled tranche with assetQty 0.
    const legacy = makeBody('body-uuuuuuuu', 'buy-u', 0.02, 50000, 'tp-u');
    legacy.buyOrders = [{ orderId: 'buy-u', price: 50000, assetQty: 0, sizeUsdc: 0, filledAt: 0 }];
    // A body that knows buy-s only by sourceOrderId.
    const noTranche = { ...makeBody('body-ssssssss', 'buy-x', 0.01, 50000, 'tp-s'), sourceOrderIds: ['buy-s'], buyOrders: [] };
    pos.celestialBodies = [legacy, noTranche];

    assert.equal(eng._test.sealLegacyClosure(), 0);
    assert.equal(ledger.getBuyOrderConsumption('buy-u').consumedBy, null);
    assert.equal(ledger.getBuyOrderConsumption('buy-s').consumedBy, null);
  });
});

describe('foreign sell with no bodies surfaces through position coverage, not the position model (issue #750)', () => {
  it('leaves totalAsset/totalCostBasis/reserves untouched and attributes the ledger gap to untrackedSold', async () => {
    const eng = makeEngine({
      getOrderFills: async (orderId) => (orderId === 'manual-750' ? [rawFill('sell', 'manual-750', 'manual-750-t1', 0.3, 2600)] : []),
      getAccountBalance: undefined,
    });
    const pos = eng._getPositionState();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-l', 'buy-l-t1', 1.0, 2500));
    // Legacy core position, no bodies: the ambiguous case the issue describes.
    pos.celestialBodies = [];
    pos.totalAsset = 1.0;
    pos.totalCostBasis = 2500;
    pos.avgCostBasis = 2500;
    const reservesBefore = pos.realizedAssetPnL || 0;

    await eng._test.handleOrderFill(sellFill('manual-750', 0.3, 2600));

    assert.ok(ledger.getFillsForOrder('manual-750').every(f => f.untrackedSell === true), 'annotated untrackedSell');
    assert.equal(pos.totalAsset, 1.0, 'totalAsset not guessed down');
    assert.equal(pos.totalCostBasis, 2500, 'totalCostBasis not guessed down');
    assert.equal(pos.realizedAssetPnL || 0, reservesBefore, 'reserves not guessed down');

    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.untrackedSellQty - 0.3) < EPS, `untrackedSellQty, got ${derived.untrackedSellQty}`);
    assert.ok(Math.abs(derived.ledgerNetAsset - 0.7) < EPS, 'the sale is inside ledger net');

    pos.engineStartTime = Date.now() - 86_400_000;
    await eng._test.sweepLedgerDrift();
    const cov = eng._test.getPositionCoverage();
    assert.ok(Math.abs(cov.ledger.untrackedSold - 0.3) < EPS, `untrackedSold surfaced, got ${cov.ledger.untrackedSold}`);
    assert.equal(eng.getState().positionCoverage.ledger.untrackedSold, cov.ledger.untrackedSold, 'surfaced on engine state');
  });

  it('counts a foreign order once per order, including a fill row ingested after the annotation', () => {
    const eng = makeEngine({});
    const ledger = eng.getFillLedger();
    ledger.ingestFill(rawFill('buy', 'buy-m', 'buy-m-t1', 1.0, 2500));
    ledger.ingestFill(rawFill('sell', 'manual-m', 'manual-m-t1', 0.2, 2600));
    ledger.ingestFill(rawFill('sell', 'manual-m', 'manual-m-t2', 0.1, 2600));
    ledger.annotateFillsByOrderId('manual-m', { untrackedSell: true });
    ledger.ingestFill(rawFill('sell', 'manual-m', 'manual-m-t3', 0.05, 2600)); // late row, no flag
    ledger.ingestFill(rawFill('sell', 'tp-own', 'tp-own-t1', 0.4, 2600)); // not foreign
    const derived = ledger.getDerivedRealizedPnL();
    assert.ok(Math.abs(derived.untrackedSellQty - 0.35) < EPS, `got ${derived.untrackedSellQty}`);
  });
});
