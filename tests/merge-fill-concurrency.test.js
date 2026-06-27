// @ts-check
//
// Integration tests for the #196 merge↔fill concurrency surface.
//
// These exercise the REAL closures inside createRegimeEngine (consolidateDustBodies,
// _mergeBodyImpl, the handleOrderFill wrapper, and the reconcile tick) via the
// engine's _test hooks, with mock exchange deps injected so no network is hit.
//
// Disk safety: the engine is constructed with a throwaway pair/productId
// ('__test196__') so any state / fill-ledger persistence lands in
// data/coinbase/__test196__/, which the suite deletes in after(). The
// concurrency-defer and fail-fast tests never reach a persistence call anyway —
// only the full-merge test does, and its writes are isolated + cleaned up.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test196__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

// Every engine the suite builds, so we can clear the background TTL timers a
// merge schedules (5-min dedup sweeps) and let the process exit promptly.
const engines = [];

after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

/** Mock exchange adapter; getOrder reports no partial fills by default. */
const makeAdapter = (over = {}) => ({
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  getPositions: async () => [],
  ...over,
});

/** Mock order executor; cancels/places succeed by default. */
let tpCounter = 0;
const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: `tp-new-${++tpCounter}` }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  isLadderOrder: () => false,
  getOrderPlacedAt: () => null,
  ...over,
});

/** A celestial body. tpOrderId=null + sub-min qty makes it "stranded dust". */
const makeBody = (id, avgPrice, qty, tpOrderId = null) => ({
  id,
  tier: 'ASTEROID',
  assetQty: qty,
  costBasis: qty * avgPrice,
  avgPrice,
  tpPrice: tpOrderId ? avgPrice * 1.01 : 0,
  tpOrderId,
  assetOnOrder: 0,
  buyOrders: [{ orderId: `buy-${id}` }],
  sourceOrderIds: [],
});

/**
 * Build a running engine with mock deps and the given bodies.
 * @param {{ bodies?: Array, adapter?: Object, executor?: Object, recovery?: Object }} [opts]
 */
const makeEngine = ({ bodies = [], adapter, executor, recovery } = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(makeAdapter(adapter || {}));
  eng._test.setOrderExecutor(makeExecutor(executor || {}));
  if (recovery) eng._test.setRecoveryModule(recovery);
  const pos = eng._getPositionState();
  pos.celestialBodies = bodies;
  pos.totalAsset = bodies.reduce((s, b) => s + b.assetQty, 0);
  engines.push(eng);
  return eng;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// consolidateDustBodies — defer conditions (the #196 fill↔merge gate)
// ---------------------------------------------------------------------------

describe('#196 consolidateDustBodies — defers while the engine is busy', () => {
  const dustyBodies = () => [
    makeBody('dust', 50000, 0.00005),                 // sub-min, no TP → stranded dust
    makeBody('near', 50100, 0.01, 'tp-near'),         // healthy neighbour with a TP
  ];

  it('defers (no merge attempt) while a merge is already in flight', async () => {
    let getOrderCalls = 0;
    const eng = makeEngine({
      bodies: dustyBodies(),
      adapter: { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } },
    });
    eng._test.setMergeInProgress(true);

    await eng._test.consolidateDustBodies();

    // Early-returned before reaching the merge primitive (which is what queries
    // getOrder) — proves the consolidator never STARTS a merge mid-merge.
    assert.equal(getOrderCalls, 0);
    assert.equal(eng._test.getFlags().dustMergeRetryAfter, 0, 'a defer must not set the failure cooldown');
  });

  it('defers while a reconcile is in flight', async () => {
    let getOrderCalls = 0;
    const eng = makeEngine({
      bodies: dustyBodies(),
      adapter: { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } },
    });
    eng._test.setReconcileInProgress(true);

    await eng._test.consolidateDustBodies();

    assert.equal(getOrderCalls, 0);
    assert.equal(eng._test.getFlags().dustMergeRetryAfter, 0);
  });

  it('defers while a fill is in flight (the reverse #196 direction)', async () => {
    // fillInProgress > 0 means a buy/sell fill is mid-handling; starting a merge
    // now would race the fill's celestialBodies/TP rewrite. The consolidator
    // must yield. We simulate an in-flight fill by parking handleOrderFill on a
    // never-resolving merge wait, which holds fillInProgress at 1.
    let getOrderCalls = 0;
    const eng = makeEngine({
      bodies: dustyBodies(),
      adapter: { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } },
    });
    eng._test.setMergeInProgress(true); // makes the fill wrapper park in its wait loop
    const fillPromise = eng._test.handleOrderFill({ orderId: 'x', side: 'buy', filledSize: 0 });
    await tick();
    assert.equal(eng._test.getFlags().fillInProgress, 1, 'fill should be counted as in-flight');

    // mergeInProgress is also set here, but the point is fillInProgress > 0 is an
    // independent gate. Clear merge so the consolidator's only blocker is the fill.
    eng._test.setMergeInProgress(false);
    await eng._test.consolidateDustBodies();
    assert.equal(getOrderCalls, 0, 'consolidator must defer while a fill is in flight');

    // Let the parked fill drain so the test exits cleanly.
    eng._test.setMergeInProgress(false);
    await fillPromise.catch(() => {});
  });

  it('defers while inside the dustMergeRetryAfter cooldown', async () => {
    let getOrderCalls = 0;
    const eng = makeEngine({
      bodies: dustyBodies(),
      adapter: { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } },
    });
    eng._test.setDustMergeRetryAfter(Date.now() + 60_000);

    await eng._test.consolidateDustBodies();
    assert.equal(getOrderCalls, 0, 'cooldown must suppress the re-attempt');
  });

  it('no-ops with fewer than 2 bodies or no productDetails', async () => {
    let getOrderCalls = 0;
    const adapter = { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } };

    const oneBody = makeEngine({ bodies: [makeBody('solo', 50000, 0.00005)], adapter });
    await oneBody._test.consolidateDustBodies();
    assert.equal(getOrderCalls, 0);

    const noDetails = makeEngine({ bodies: dustyBodies(), adapter });
    noDetails._test.setProductDetails(null);
    await noDetails._test.consolidateDustBodies();
    assert.equal(getOrderCalls, 0);
  });

  it('no-ops when no body is stranded dust', async () => {
    let getOrderCalls = 0;
    const eng = makeEngine({
      bodies: [makeBody('a', 50000, 0.01, 'tp-a'), makeBody('b', 51000, 0.02, 'tp-b')],
      adapter: { getOrder: async () => { getOrderCalls++; return { filledSize: 0 }; } },
    });
    await eng._test.consolidateDustBodies();
    assert.equal(getOrderCalls, 0, 'no dust → nothing to merge');
  });
});

// ---------------------------------------------------------------------------
// consolidateDustBodies — target selection + failure cooldown
// ---------------------------------------------------------------------------

describe('#196 consolidateDustBodies — target selection and cooldown', () => {
  it('selects the NEAREST body by avg price as the merge target', async () => {
    // Dust at 50000; candidates at 50100 (near) and 80000 (far). The merge must
    // target the near body. We make the merge abort at the partial-fill guard so
    // the test stays disk-free; the guard queries the chosen target's TP order,
    // revealing which body was selected.
    const queried = [];
    const eng = makeEngine({
      bodies: [
        makeBody('dust', 50000, 0.00005),
        makeBody('far', 80000, 0.01, 'tp-far'),
        makeBody('near', 50100, 0.01, 'tp-near'),
      ],
      adapter: {
        getOrder: async (orderId) => { queried.push(orderId); return { filledSize: 5 }; }, // partial → abort
      },
    });

    await eng._test.consolidateDustBodies();

    // Source ('dust') has no tpOrderId so it isn't queried; only the chosen
    // target is. The near body must be the one consulted.
    assert.deepEqual(queried, ['tp-near'], 'must merge into the nearest body, not the far one');
  });

  it('sets the 5-minute failure cooldown when a merge attempt fails', async () => {
    const before = Date.now();
    const eng = makeEngine({
      bodies: [makeBody('dust', 50000, 0.00005), makeBody('near', 50100, 0.01, 'tp-near')],
      adapter: { getOrder: async () => ({ filledSize: 5 }) }, // partial fill → merge aborts
    });

    await eng._test.consolidateDustBodies();

    const cooldown = eng._test.getFlags().dustMergeRetryAfter;
    assert.ok(cooldown >= before + 290_000, `cooldown should be ~5min out, got +${cooldown - before}ms`);
  });
});

// ---------------------------------------------------------------------------
// _mergeBodyImpl — targetId / _noLock / guards
// ---------------------------------------------------------------------------

describe('#196 _mergeBodyImpl — targetId and guards', () => {
  it('returns failure when the engine is not running', async () => {
    const eng = makeEngine({ bodies: [makeBody('a', 1, 1, 'tp-a'), makeBody('b', 2, 1, 'tp-b')] });
    eng._test.setRunning(false);
    const r = await eng._test.mergeBody('a', { targetId: 'b' });
    assert.equal(r.success, false);
    assert.match(r.message, /not running/i);
  });

  it('returns failure with fewer than 2 bodies', async () => {
    const eng = makeEngine({ bodies: [makeBody('solo', 1, 1, 'tp-solo')] });
    const r = await eng._test.mergeBody('solo', {});
    assert.equal(r.success, false);
    assert.match(r.message, /at least 2/i);
  });

  it('returns failure when the explicit targetId is not found', async () => {
    const eng = makeEngine({ bodies: [makeBody('a', 1, 1, 'tp-a'), makeBody('b', 2, 1, 'tp-b')] });
    const r = await eng._test.mergeBody('a', { targetId: 'ghost' });
    assert.equal(r.success, false);
    assert.match(r.message, /Target body ghost not found/);
  });

  it('aborts (no state mutation) when the target TP is partially filled', async () => {
    const bodies = [makeBody('a', 50000, 0.01, 'tp-a'), makeBody('b', 51000, 0.01, 'tp-b')];
    let cancelCalls = 0;
    const eng = makeEngine({
      bodies,
      adapter: { getOrder: async () => ({ filledSize: 0.003 }) }, // partial
      executor: { cancelBodyTpOrder: async () => { cancelCalls++; return { cancelled: true }; } },
    });
    const r = await eng._test.mergeBody('a', { targetId: 'b' });
    assert.equal(r.success, false);
    assert.match(r.message, /partially filled/i);
    assert.equal(cancelCalls, 0, 'must abort before cancelling any TP');
    assert.equal(eng._getPositionState().celestialBodies.length, 2, 'no body removed on abort');
  });

  it('_noLock bypasses the merge lock (used by rollupAllBodies)', async () => {
    const eng = makeEngine({ bodies: [makeBody('a', 1, 1, 'tp-a'), makeBody('b', 2, 1, 'tp-b')] });
    // Hold the lock as if a collapse-all were in progress.
    eng._test.setMergeInProgress(true);
    // Through the public lock path this would be rejected as "in progress"...
    const locked = await eng.manualMergeBody('a', { targetId: 'b' });
    assert.equal(locked.success, false);
    assert.match(locked.message, /in progress/i);
    // ...but _noLock proceeds into _mergeBodyImpl (fails later on its own merits,
    // here at the "engine running but" path — proving it did NOT short-circuit on
    // the lock). We assert it got PAST the lock check by getting a different error.
    const bypass = await eng.manualMergeBody('ghost-source', { _noLock: true });
    assert.equal(bypass.success, false);
    assert.match(bypass.message, /not found/i, 'should reach body lookup, not the lock guard');
  });
});

// ---------------------------------------------------------------------------
// manualMergeBody — public lock
// ---------------------------------------------------------------------------

describe('#196 manualMergeBody — lock acquisition', () => {
  it('rejects when a merge is already in progress', async () => {
    const eng = makeEngine({ bodies: [makeBody('a', 1, 1, 'tp-a'), makeBody('b', 2, 1, 'tp-b')] });
    eng._test.setMergeInProgress(true);
    const r = await eng.manualMergeBody('a', { targetId: 'b' });
    assert.equal(r.success, false);
    assert.match(r.message, /in progress/i);
  });

  it('rejects when a reconcile is already in progress', async () => {
    const eng = makeEngine({ bodies: [makeBody('a', 1, 1, 'tp-a'), makeBody('b', 2, 1, 'tp-b')] });
    eng._test.setReconcileInProgress(true);
    const r = await eng.manualMergeBody('a', { targetId: 'b' });
    assert.equal(r.success, false);
    assert.match(r.message, /in progress/i);
  });

  it('holds mergeInProgress for the duration of the merge and clears it after', async () => {
    let flagDuringMerge = null;
    const eng = makeEngine({
      bodies: [makeBody('a', 50000, 0.01, 'tp-a'), makeBody('b', 51000, 0.01, 'tp-b')],
      executor: {
        // Observe the lock state mid-merge (cancelBodyTpOrder runs inside the lock).
        cancelBodyTpOrder: async () => {
          flagDuringMerge = eng._test.getFlags().mergeInProgress;
          return { cancelled: true };
        },
      },
    });
    const r = await eng.manualMergeBody('a', { targetId: 'b' });
    assert.equal(r.success, true, `merge should succeed: ${r.message}`);
    assert.equal(flagDuringMerge, true, 'lock held during merge');
    assert.equal(eng._test.getFlags().mergeInProgress, false, 'lock released after merge');
  });
});

// ---------------------------------------------------------------------------
// Full merge through manualMergeBody (target selection end-to-end)
// ---------------------------------------------------------------------------

describe('#196 _mergeBodyImpl — successful merge folds source into target', () => {
  it('removes the source body and combines qty/cost into the target', async () => {
    const eng = makeEngine({
      bodies: [makeBody('src', 50000, 0.01, 'tp-src'), makeBody('tgt', 51000, 0.02, 'tp-tgt')],
    });
    const r = await eng.manualMergeBody('src', { targetId: 'tgt' });
    assert.equal(r.success, true, `merge should succeed: ${r.message}`);

    const bodies = eng._getPositionState().celestialBodies;
    assert.equal(bodies.length, 1, 'source body removed, one merged body remains');
    const merged = bodies[0];
    assert.ok(Math.abs(merged.assetQty - 0.03) < 1e-9, `merged qty 0.03, got ${merged.assetQty}`);
    assert.ok(Math.abs(merged.costBasis - (0.01 * 50000 + 0.02 * 51000)) < 1e-6, 'cost basis summed');
    assert.ok(merged.tpOrderId, 'merged body has a fresh TP order');
  });
});

// ---------------------------------------------------------------------------
// handleOrderFill — waits for an in-flight merge (the other #196 direction)
// ---------------------------------------------------------------------------

describe('#196 handleOrderFill — defers to an in-flight merge', () => {
  it('blocks while mergeInProgress is set, then proceeds once it clears', async () => {
    // getOrderFills throwing is our "proceeded past the wait" sentinel: it is the
    // first thing handleOrderFillImpl does, AFTER the merge-wait loop. While the
    // merge lock is held the loop spins and never reaches it.
    let getOrderFillsCalls = 0;
    const eng = makeEngine({
      adapter: {
        getOrderFills: async () => { getOrderFillsCalls++; throw new Error('SENTINEL_PROCEEDED'); },
      },
    });
    eng._test.setMergeInProgress(true);

    let settled = false;
    const fillPromise = eng._test
      .handleOrderFill({ orderId: 'fill-1', side: 'buy', filledSize: 0 })
      .then(() => { settled = true; })
      .catch(() => { settled = true; });

    // Give the wait loop several iterations (it polls every 25ms).
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(settled, false, 'fill must not proceed while the merge lock is held');
    assert.equal(getOrderFillsCalls, 0, 'fill must not touch the ledger path while merge runs');
    assert.equal(eng._test.getFlags().fillInProgress, 1, 'fill counted as in-flight (gates the consolidator)');

    // Release the merge lock — the fill should now proceed (and hit the sentinel).
    eng._test.setMergeInProgress(false);
    await fillPromise;
    assert.equal(settled, true, 'fill proceeds once the merge lock clears');
    assert.equal(getOrderFillsCalls, 1, 'fill reached the ledger path exactly once');
    assert.equal(eng._test.getFlags().fillInProgress, 0, 'in-flight counter decremented in finally');
  });
});

// ---------------------------------------------------------------------------
// reconcile tick — Promise.allSettled lock-release
// ---------------------------------------------------------------------------

describe('#196 reconcileTick — holds the lock until every dispatched chain settles', () => {
  it('keeps reconcileInProgress true until the slowest pending chain resolves', async () => {
    const recoveryDeferred = deferred();
    const eng = makeEngine({
      bodies: [], // no body TP polling; pending = checkPendingOrderFills + recovery.reconcile
      executor: { checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }) },
      recovery: { reconcile: () => recoveryDeferred.promise.then(() => ({ updated: false })) },
    });
    eng._getPositionState().activeTpOrderId = null; // skip the legacy-TP getOrder chain

    eng._test.reconcileTick();
    assert.equal(eng._test.getFlags().reconcileInProgress, true, 'lock taken synchronously');

    // Flush microtasks: checkPendingOrderFills has resolved, but recovery is still
    // pending, so the allSettled finally must NOT have released the lock yet.
    await tick();
    await tick();
    assert.equal(eng._test.getFlags().reconcileInProgress, true, 'lock held while a chain is still pending');

    // Resolve the slow chain; the lock releases on the next allSettled microtask.
    recoveryDeferred.resolve();
    await tick();
    await tick();
    assert.equal(eng._test.getFlags().reconcileInProgress, false, 'lock released after all chains settle');
  });

  it('skips the tick (no double-entry) when a merge is in progress', async () => {
    let recoveryCalls = 0;
    const eng = makeEngine({
      bodies: [],
      recovery: { reconcile: async () => { recoveryCalls++; return { updated: false }; } },
    });
    eng._test.setMergeInProgress(true);
    eng._test.reconcileTick();
    await tick();
    assert.equal(recoveryCalls, 0, 'reconcile must defer while a merge holds the lock');
    assert.equal(eng._test.getFlags().reconcileInProgress, false, 'no lock taken on a skipped tick');
  });
});
