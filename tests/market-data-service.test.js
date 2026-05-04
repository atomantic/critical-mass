// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { ingestNewFillsForOrder, settleCancelledOrder, createTimerTracker, createWorkQueue } = require('../src/market-data-service');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Fake adapter where getOrderFills can be programmed per-test.
 * @param {Array<Array|Error>} responses - One entry per call. Array => fills, Error => throw.
 */
const makeAdapter = (responses) => {
  let i = 0;
  return {
    getOrderFills: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

/**
 * Fake fillLedger that mimics ingestFill's idempotent-on-tradeId contract,
 * the skipPersist option (real ledger auto-persists per fill unless
 * skipPersist is set), and getFillsForOrder for ledger-derived watermark
 * computations in production code.
 */
const makeLedger = () => {
  const seen = new Set();
  const ingested = []; // { tradeId, orderPlacedAt, skipPersist }
  const byOrder = new Map(); // orderId -> [{ size, netFee, quoteAmount }]
  let persistCalls = 0;
  return {
    seen,
    ingested,
    get persistCalls() { return persistCalls; },
    ingestFill: (fill, orderPlacedAt = null, options = {}) => {
      const tradeId = fill.tradeId || fill.trade_id;
      if (seen.has(tradeId)) return { ingested: false, fill: null };
      seen.add(tradeId);
      ingested.push({ tradeId, orderPlacedAt, skipPersist: !!options.skipPersist });
      const orderId = fill.orderId || fill.order_id;
      if (orderId) {
        if (!byOrder.has(orderId)) byOrder.set(orderId, []);
        byOrder.get(orderId).push({
          size: parseFloat(fill.size) || 0,
          netFee: parseFloat(fill.totalCommission || fill.commission || 0) - parseFloat(fill.rebate || 0),
          quoteAmount: (parseFloat(fill.price) || 0) * (parseFloat(fill.size) || 0),
        });
      }
      if (!options.skipPersist) persistCalls += 1;
      return { ingested: true, fill };
    },
    getFillsForOrder: (orderId) => byOrder.get(orderId) || [],
    persist: () => { persistCalls += 1; },
  };
};

const makeFill = (tradeId, size = 0.5) => ({
  tradeId,
  orderId: 'order-1',
  side: 'sell',
  price: 70000,
  size,
  totalCommission: 0.1,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingestNewFillsForOrder', () => {
  let ledger;
  let trackedOrder;

  beforeEach(() => {
    ledger = makeLedger();
    trackedOrder = {
      type: 'take_profit',
      placedAt: Date.now(),
      status: 'open',
      // lastIngestedFilledSize starts unset so default-0 path is exercised
    };
  });

  it('skips work when cumulative size has not advanced beyond watermark', async () => {
    const adapter = makeAdapter([new Error('should not be called')]);
    trackedOrder.lastIngestedFilledSize = 1.0;

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'partial fill'
    );

    assert.deepEqual(result, { fetched: true, fillsCount: 0, ingestedCount: 0 });
    assert.equal(ledger.ingested.length, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });

  it('on a partial fill, ingests the new fill and advances the watermark', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(result.fetched, true);
    assert.equal(result.fillsCount, 1);
    assert.equal(result.ingestedCount, 1);
    assert.equal(ledger.ingested.length, 1);
    assert.equal(ledger.ingested[0].tradeId, 't1');
    assert.equal(trackedOrder.lastIngestedFilledSize, 0.4);
    assert.equal(ledger.persistCalls, 1, 'one trailing persist, not one per fill');
  });

  it('uses skipPersist + a single trailing persist regardless of fill count', async () => {
    // Three new fills in one update — without skipPersist this would be 3
    // synchronous JSON rewrites on the hot path.
    const adapter = makeAdapter([[makeFill('t1', 0.2), makeFill('t2', 0.3), makeFill('t3', 0.5)]]);

    await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'FILLED'
    );

    assert.equal(ledger.ingested.length, 3);
    assert.ok(ledger.ingested.every((x) => x.skipPersist === true), 'each ingestFill must pass skipPersist');
    assert.equal(ledger.persistCalls, 1, 'exactly one persist per call, regardless of fill count');
  });

  it('does not double-count when the terminal FILLED event re-fetches an already-ingested partial', async () => {
    // First partial: ledger learns about t1
    const adapter = makeAdapter([
      [makeFill('t1', 0.4)],                           // partial: returns 1 fill
      [makeFill('t1', 0.4), makeFill('t2', 0.6)],       // FILLED: returns both
    ]);

    const partial = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );
    assert.equal(partial.ingestedCount, 1);

    const filled = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'FILLED'
    );

    assert.equal(filled.fetched, true);
    assert.equal(filled.fillsCount, 2);
    assert.equal(filled.ingestedCount, 1, 't1 should be deduped, only t2 newly ingested');
    assert.equal(ledger.ingested.length, 2);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });

  it('does not advance watermark on adapter failure (so next event retries)', async () => {
    const adapter = makeAdapter([new Error('network down')]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'partial fill'
    );

    assert.equal(result.fetched, false);
    assert.equal(result.ingestedCount, 0);
    assert.equal(ledger.ingested.length, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'watermark must NOT advance — next WS update should retry the fetch');
  });

  it('does not advance watermark when persist() throws (durability hole guard)', async () => {
    // Fills land in the in-memory ledger but persist() fails. If we
    // advanced the watermark, ingestFill's tradeId dedup would mean a
    // retry sees no NEW fills (ingestedCount=0), and without an
    // unconditional persist call the disk would never catch up. The
    // helper must signal fetched=false so the caller retries, AND
    // unconditionally call persist on retries to flush the queue.
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);
    let persistCalls = 0;
    const failingLedger = {
      ingestFill: (fill) => {
        const tradeId = fill.tradeId;
        if (ledger.seen.has(tradeId)) return { ingested: false, fill: null };
        ledger.seen.add(tradeId);
        ledger.ingested.push({ tradeId, orderPlacedAt: null });
        return { ingested: true, fill };
      },
      persist: () => {
        persistCalls += 1;
        throw new Error('disk full');
      },
    };

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: failingLedger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(result.fetched, false, 'persist failure must surface as fetched=false');
    assert.equal(persistCalls, 1, 'persist was attempted');
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'watermark must NOT advance when persist failed — caller relies on this to retry');
  });

  it('does not advance watermark when adapter returns empty fills (Coinbase post-FILLED race)', async () => {
    const adapter = makeAdapter([[]]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'FILLED'
    );

    assert.equal(result.fetched, true);
    assert.equal(result.fillsCount, 0);
    assert.equal(result.ingestedCount, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'watermark must NOT advance on empty response — caller relies on this to retry');
  });

  it('on empty-fills early return, still persists to flush in-memory state from a prior failed persist', async () => {
    // Scenario: a previous call ingested fills into memory but persist
    // threw (memory ahead of disk). On the next call, adapter returns
    // [] (Coinbase race). Without persisting on the empty-fills path,
    // disk would never catch up to memory.
    const adapter = makeAdapter([[]]);
    let persistAttempts = 0;
    const dirtyLedger = {
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      persist: () => { persistAttempts += 1; },
    };

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: dirtyLedger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'FILLED'
    );

    assert.equal(result.fetched, true);
    assert.equal(persistAttempts, 1, 'must attempt persist on empty-fills path to flush prior in-memory state');
  });

  it('watermark advances by ledger-recorded size, NOT WS-reported cumulative (Gemini partial-history adapter case)', async () => {
    // Adapter returns only one fill (0.3) even though WS-reported
    // cumulative is 0.7. With the old behavior, watermark would jump to
    // 0.7 and suppress future retries, permanently dropping the missing
    // 0.4. With the fix, watermark = recordedSize (0.3), so the next
    // call still sees cumulative > watermark and retries.
    const adapter = makeAdapter([[makeFill('t1', 0.3)]]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'gemini' },
      'order-1', trackedOrder, 0.7, 'partial fill'
    );

    assert.equal(result.fetched, true);
    assert.equal(result.fillsCount, 1);
    assert.equal(trackedOrder.lastIngestedFilledSize, 0.3,
      'watermark must reflect actual ledger contents (0.3), not WS cumulative (0.7), so retries can catch the missing 0.4');
  });

  it('returns fetched=false if isStopped() flips during the adapter fetch', async () => {
    let stopped = false;
    const adapter = {
      getOrderFills: async () => {
        stopped = true; // simulate service.stop() during await
        return [makeFill('t1', 0.4)];
      },
    };

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase', isStopped: () => stopped },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(result.fetched, false, 'must bail with fetched=false post-stop');
    assert.equal(ledger.ingested.length, 0, 'must not write to fillLedger after stop');
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0, 'watermark must not advance');
  });

  it('passes placedAt for buy orders (entry/ladder) so fill-time tracking works', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);
    trackedOrder.type = 'ladder_entry';
    trackedOrder.placedAt = 1700000000000;

    await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(ledger.ingested[0].orderPlacedAt, 1700000000000,
      'buy orders should pass placedAt so 7-day fill-time stats include them');
  });

  it('passes null placedAt for sell orders (TP)', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);
    trackedOrder.type = 'take_profit';
    trackedOrder.placedAt = 1700000000000;

    await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(ledger.ingested[0].orderPlacedAt, null,
      'sell-order placedAt should not flow into the ledger');
  });

  it('handles a series of partial events without re-ingesting prior fills', async () => {
    const adapter = makeAdapter([
      [makeFill('t1', 0.3)],
      [makeFill('t1', 0.3), makeFill('t2', 0.4)],
      [makeFill('t1', 0.3), makeFill('t2', 0.4), makeFill('t3', 0.3)],
    ]);

    const r1 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.3, 'partial fill'
    );
    const r2 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.7, 'partial fill'
    );
    const r3 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'FILLED'
    );

    assert.equal(r1.ingestedCount, 1);
    assert.equal(r2.ingestedCount, 1);
    assert.equal(r3.ingestedCount, 1);
    assert.equal(ledger.ingested.length, 3);
    assert.deepEqual(ledger.ingested.map(x => x.tradeId), ['t1', 't2', 't3']);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });
});

// ---------------------------------------------------------------------------
// settleCancelledOrder: regression coverage for the cancel/fail catch-up path
// ---------------------------------------------------------------------------

describe('settleCancelledOrder', () => {
  let ledger;
  let trackedOrder;
  let markSettledCalls;
  let untrackCalls;
  let scheduledTimeouts; // [{ fn, delay }]

  beforeEach(() => {
    ledger = makeLedger();
    trackedOrder = { type: 'take_profit', placedAt: Date.now(), status: 'open' };
    markSettledCalls = [];
    untrackCalls = [];
    scheduledTimeouts = [];
  });

  const makeDeps = (adapter) => ({
    adapter,
    fillLedger: ledger,
    exchange: 'coinbase',
    markSettled: (id) => { markSettledCalls.push(id); },
    untrackOrder: (id) => { untrackCalls.push(id); },
    retryDelayBaseMs: 30000,
    retryDelayMaxMs: 300000,
    untrackDelayMs: 60000,
    scheduleTimeout: (fn, delay) => { scheduledTimeouts.push({ fn, delay }); return scheduledTimeouts.length; },
  });

  it('settles immediately when there were no unrecorded partials', async () => {
    const adapter = makeAdapter([new Error('should not be called')]);
    trackedOrder.lastIngestedFilledSize = 0;

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 0
    );

    assert.deepEqual(result, { settledNow: true, retryScheduled: false });
    assert.equal(trackedOrder.status, 'cancelled');
    assert.deepEqual(markSettledCalls, ['order-1']);
    assert.equal(scheduledTimeouts.length, 1, 'one untrack delay scheduled');
    assert.equal(scheduledTimeouts[0].delay, 60000);
  });

  it('settles after successful catch-up when partials were unrecorded', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.3)]]);

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 0.3
    );

    assert.deepEqual(result, { settledNow: true, retryScheduled: false });
    assert.equal(ledger.ingested.length, 1, 'partial caught up before settle');
    assert.deepEqual(markSettledCalls, ['order-1']);
    assert.equal(trackedOrder.lastIngestedFilledSize, 0.3);
  });

  it('does NOT settle when adapter fetch fails on cancel with unrecorded partials — schedules retry instead', async () => {
    const adapter = makeAdapter([new Error('network down')]);

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 0.3
    );

    assert.deepEqual(result, { settledNow: false, retryScheduled: true });
    assert.equal(markSettledCalls.length, 0, 'must not settle yet — markSettled is sticky');
    assert.equal(untrackCalls.length, 0, 'must not untrack yet');
    assert.equal(trackedOrder.status, 'cancelled',
      'status must flip immediately so getOrderStatus filters out the phantom open row during retry window');
    assert.equal(scheduledTimeouts.length, 1, 'one retry scheduled');
    assert.equal(scheduledTimeouts[0].delay, 30000);
  });

  it('does NOT settle when adapter returns [] on cancel with unrecorded partials (post-event race) — schedules retry', async () => {
    const adapter = makeAdapter([[]]);

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 0.3
    );

    assert.deepEqual(result, { settledNow: false, retryScheduled: true });
    assert.equal(markSettledCalls.length, 0, 'must not settle on empty fills response');
    assert.equal(scheduledTimeouts.length, 1);
  });

  it('retry callback ingests fills then settles + untracks', async () => {
    // First call (synchronous in handleOrderUpdate path) fails; the
    // scheduled retry succeeds.
    const adapter = makeAdapter([new Error('transient'), [makeFill('t1', 0.3)]]);

    await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 0.3
    );

    assert.equal(scheduledTimeouts.length, 1);
    // Run the retry callback (recursive settleCancelledOrder with attempt=1)
    await scheduledTimeouts[0].fn();

    assert.equal(ledger.ingested.length, 1, 'retry must ingest the previously-missed fill');
    assert.deepEqual(markSettledCalls, ['order-1'], 'retry must settle');
    // Untrack is scheduled via finalSettle (60s TTL), not synchronous
    assert.equal(scheduledTimeouts.length, 2, 'retry then untrack-delay');
    assert.equal(scheduledTimeouts[1].delay, 60000);
    await scheduledTimeouts[1].fn();
    assert.deepEqual(untrackCalls, ['order-1'], 'untrack TTL fires');
  });

  it('keeps retrying indefinitely with exponential backoff capped at retryDelayMaxMs', async () => {
    // Every attempt fails. Engine-restart reconciliation does NOT recover
    // cancelled-with-partials, so dropping fills after a budget would
    // lose them permanently. Retries continue with exponential backoff
    // up to a cap (here: 120s) and only stop on success or service stop.
    const adapter = makeAdapter([
      new Error('boom'), new Error('boom'), new Error('boom'),
      new Error('boom'), new Error('boom'),
    ]);

    const deps = { ...makeDeps(adapter), retryDelayBaseMs: 30000, retryDelayMaxMs: 120000 };
    await settleCancelledOrder(deps, 'order-1', trackedOrder, 'CANCELLED', 0.3);

    // attempt 0 -> next delay 30000 * 2^0 = 30000
    assert.equal(scheduledTimeouts[0].delay, 30000);
    await scheduledTimeouts[0].fn();
    // attempt 1 -> 30000 * 2 = 60000
    assert.equal(scheduledTimeouts[1].delay, 60000);
    await scheduledTimeouts[1].fn();
    // attempt 2 -> 30000 * 4 = 120000 (= cap)
    assert.equal(scheduledTimeouts[2].delay, 120000);
    await scheduledTimeouts[2].fn();
    // attempt 3 -> 30000 * 8 = 240000, but capped at 120000
    assert.equal(scheduledTimeouts[3].delay, 120000, 'backoff capped at retryDelayMaxMs');
    await scheduledTimeouts[3].fn();
    assert.equal(scheduledTimeouts[4].delay, 120000, 'still capped on subsequent attempts');

    // markSettled never fires while retries continue — order is not leaked
    // because the factory cancels these timers on stop().
    assert.equal(markSettledCalls.length, 0, 'never settle while retries are pending');
  });

  it('eventual success during the retry chain ingests fills and settles', async () => {
    // First three attempts fail, fourth succeeds.
    const adapter = makeAdapter([
      new Error('boom'), new Error('boom'), new Error('boom'),
      [makeFill('t1', 0.3)],
    ]);

    const deps = makeDeps(adapter);
    await settleCancelledOrder(deps, 'order-1', trackedOrder, 'CANCELLED', 0.3);
    await scheduledTimeouts[0].fn();
    await scheduledTimeouts[1].fn();
    await scheduledTimeouts[2].fn();

    assert.equal(ledger.ingested.length, 1, 'fill ingested on eventual success');
    assert.deepEqual(markSettledCalls, ['order-1'], 'settles on success');
  });

  it('keeps retrying when adapter returns partial history (ledger short of WS-reported cumulative)', async () => {
    // Gemini/Crypto.com case: adapter returns only some of the order's
    // fills (0.3 of a 1.0 cancel). With the old behavior (`fillsCount > 0`
    // = success), the chain would settle and lose the missing 0.7. With
    // the fix (`recordedSize < filledSize` = still needs catchup), the
    // chain retries.
    const adapter = makeAdapter([[makeFill('t1', 0.3)]]);

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'CANCELLED', 1.0
    );

    assert.deepEqual(result, { settledNow: false, retryScheduled: true },
      'must NOT settle when ledger covers only 0.3 of the 1.0 cancelled cumulative');
    assert.equal(markSettledCalls.length, 0, 'order not settled yet — retry pending');
    assert.equal(scheduledTimeouts.length, 1, 'retry scheduled');
  });

  it('cancel retry routes through enqueueWork when provided so replays serialize', async () => {
    // Verifies T32 wiring: settleCancelledOrder's retry callback uses
    // deps.enqueueWork (when provided) so a replayed CANCELLED arriving
    // during the retry window doesn't start a parallel chain.
    const adapter = makeAdapter([new Error('boom'), [makeFill('t1', 0.3)]]);
    const enqueueLog = [];
    const fakeEnqueueWork = async (key, work) => {
      enqueueLog.push(key);
      return work();
    };

    const deps = { ...makeDeps(adapter), enqueueWork: fakeEnqueueWork };
    await settleCancelledOrder(deps, 'order-1', trackedOrder, 'CANCELLED', 0.3);

    // First synchronous call failed, retry scheduled.
    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(enqueueLog.length, 0, 'no enqueue yet — first call ran inline');

    await scheduledTimeouts[0].fn();

    assert.deepEqual(enqueueLog, ['order-1'], 'retry callback routed through enqueueWork');
    assert.deepEqual(markSettledCalls, ['order-1'], 'retry settled via the queue');
  });

  it('FAILED status follows the same path as CANCELLED', async () => {
    const adapter = makeAdapter([new Error('boom')]);

    const result = await settleCancelledOrder(
      makeDeps(adapter), 'order-1', trackedOrder, 'FAILED', 0.5
    );

    assert.equal(result.retryScheduled, true);
    assert.equal(markSettledCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createTimerTracker: regression coverage for service-stop timer cancellation
// (T8 — preventing post-stop callbacks from writing to a stale fillLedger)
// ---------------------------------------------------------------------------

describe('createTimerTracker', () => {
  it('cancelAll prevents pending callbacks from firing', async () => {
    const tracker = createTimerTracker();
    let fired = 0;
    tracker.trackedSetTimeout(() => { fired += 1; }, 25);
    tracker.trackedSetTimeout(() => { fired += 1; }, 30);

    assert.equal(tracker.size(), 2, 'two pending timers');
    assert.equal(tracker.cancelAll(), 2, 'cancelAll returns count cancelled');

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fired, 0, 'cancelled timers must not fire');
    assert.equal(tracker.size(), 0, 'tracker is drained after cancelAll');
  });

  it('removes IDs from the pending set when callbacks fire normally', async () => {
    const tracker = createTimerTracker();
    let fired = 0;
    tracker.trackedSetTimeout(() => { fired += 1; }, 5);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fired, 1, 'callback fired');
    assert.equal(tracker.size(), 0, 'fired callback was removed from tracker');
  });

  it('trackedSetTimeout no-ops after cancelAll so callbacks cannot reschedule themselves', async () => {
    // Guards against the race where a callback fires just before stop()
    // and, before being clearTimeout-able, invokes trackedSetTimeout to
    // chain another retry (e.g. settleCancelledOrder's recursion). Once
    // stopped, new schedules must be rejected outright.
    const tracker = createTimerTracker();
    let postStopFired = 0;

    tracker.cancelAll();
    assert.equal(tracker.isStopped(), true);

    const id = tracker.trackedSetTimeout(() => { postStopFired += 1; }, 5);
    assert.equal(id, null, 'trackedSetTimeout returns null after stop instead of scheduling');

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(postStopFired, 0, 'rejected schedule must not fire');
    assert.equal(tracker.size(), 0, 'rejected schedule must not enter pending set');
  });

  it('isStopped reflects state + post-stop already-queued callbacks bail before invoking fn', async () => {
    // This guards against the race where setTimeout's callback is already
    // queued (between firing and clearTimeout being called). The wrapped
    // callback must check the stopped flag and skip fn() to prevent
    // post-stop writes through user callbacks.
    const tracker = createTimerTracker();
    let fired = 0;

    // Schedule a 0ms timer so the callback is queued immediately.
    tracker.trackedSetTimeout(() => { fired += 1; }, 0);

    assert.equal(tracker.isStopped(), false);
    // Cancel synchronously before yielding to the event loop. Even if a
    // 0ms timer fires before clearTimeout could reach it (in some races),
    // the wrapped callback's stopped check prevents fn() from running.
    tracker.cancelAll();
    assert.equal(tracker.isStopped(), true);

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fired, 0, 'cancelAll must prevent fn from running, even via the stopped flag');
  });

  it('integrates with settleCancelledOrder retry chain — cancelAll stops the chain', async () => {
    // This exercises the full factory pattern: pass tracker.trackedSetTimeout
    // as deps.scheduleTimeout. After cancelAll, the retry recursion stops.
    const tracker = createTimerTracker();
    let fillFetches = 0;
    const adapter = {
      getOrderFills: async () => { fillFetches += 1; throw new Error('boom'); },
    };
    const ledger = makeLedger();
    const trackedOrder = { type: 'take_profit', placedAt: Date.now(), status: 'open' };

    const deps = {
      adapter,
      fillLedger: ledger,
      exchange: 'coinbase',
      markSettled: () => {},
      untrackOrder: () => {},
      retryDelayBaseMs: 10,
      retryDelayMaxMs: 20,
      untrackDelayMs: 10,
      scheduleTimeout: tracker.trackedSetTimeout,
    };

    await settleCancelledOrder(deps, 'order-1', trackedOrder, 'CANCELLED', 0.3);

    // First synchronous attempt threw → 1 fetch, 1 retry scheduled.
    assert.equal(fillFetches, 1);
    assert.equal(tracker.size(), 1, 'one retry timer pending');

    // Simulate service stop before the retry fires.
    tracker.cancelAll();

    // Wait long enough that an uncancelled retry would have fired and
    // chained another adapter call.
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(fillFetches, 1, 'retry must NOT have fired after cancelAll');
    assert.equal(trackedOrder.status, 'cancelled', 'status flip on initial call still applied');
  });
});

// ---------------------------------------------------------------------------
// createWorkQueue: regression coverage for per-orderId update serialization
// (T28 — partial / FILLED / CANCELLED for the same order must run in order)
// ---------------------------------------------------------------------------

describe('createWorkQueue', () => {
  // Helper: a deferred promise with explicit resolve handle
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  };

  it('serializes work for the same key in arrival order', async () => {
    const q = createWorkQueue();
    const log = [];
    const a = deferred();
    const b = deferred();

    // Enqueue two pieces of work for the same key. Second one must wait
    // for the first to finish, even though both are "started" instantly.
    const p1 = q.enqueue('order-1', async () => {
      log.push('a:start');
      await a.promise;
      log.push('a:end');
    });
    const p2 = q.enqueue('order-1', async () => {
      log.push('b:start');
      await b.promise;
      log.push('b:end');
    });

    // Yield: only 'a:start' should appear; b shouldn't have started yet.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(log, ['a:start'], 'b must not start until a finishes');

    a.resolve();
    await p1;
    // Yield once more so chained microtasks (work() invocation for p2)
    // run before we assert.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(log, ['a:start', 'a:end', 'b:start'], 'b starts only after a ends');

    b.resolve();
    await p2;
    assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('different keys run concurrently', async () => {
    const q = createWorkQueue();
    const log = [];
    const a = deferred();

    const p1 = q.enqueue('order-1', async () => {
      log.push('a:start');
      await a.promise;
      log.push('a:end');
    });
    const p2 = q.enqueue('order-2', async () => {
      log.push('b:run');
    });

    await p2;
    assert.ok(log.includes('a:start'), 'order-1 work started');
    assert.ok(log.includes('b:run'), 'order-2 ran without waiting for order-1');
    assert.ok(!log.includes('a:end'), 'order-1 still in flight');

    a.resolve();
    await p1;
  });

  it('a failure on key A does not block subsequent work for the same key', async () => {
    const q = createWorkQueue();
    const log = [];

    const p1 = q.enqueue('order-1', async () => { throw new Error('boom'); });
    // Attach a noop catch immediately so the rejection isn't unhandled.
    p1.catch(() => {});
    const p2 = q.enqueue('order-1', async () => { log.push('ran'); });

    await p2;
    assert.deepEqual(log, ['ran'], 'second enqueue must run despite first throwing');
  });

  it('integrates with handleOrderUpdate-style ordering: partial then FILLED for same orderId resolves correctly', async () => {
    // Models the real race: partial-fill update is in flight (awaiting
    // the adapter); FILLED update arrives before partial finishes.
    // Without serialization, FILLED would read the watermark before the
    // partial advanced it, hit the empty-fills race, and never settle.
    // With createWorkQueue, the FILLED handler runs only after partial
    // completes — and reads the post-partial watermark.
    const q = createWorkQueue();
    const watermark = { value: 0 }; // shared "trackedOrder" state
    const log = [];
    const partialFetchDone = deferred();

    // Partial-fill work — represents ingestion that takes time
    q.enqueue('order-1', async () => {
      log.push('partial:fetch');
      await partialFetchDone.promise;
      watermark.value = 0.4; // partial advances watermark
      log.push('partial:done');
    });

    // FILLED arrives before partial completes
    const filledP = q.enqueue('order-1', async () => {
      log.push('filled:read-watermark');
      // Without serialization this would see watermark=0; with it, sees 0.4
      assert.equal(watermark.value, 0.4, 'FILLED must observe partial-advanced watermark');
      log.push('filled:done');
    });

    await new Promise(r => setImmediate(r));
    assert.deepEqual(log, ['partial:fetch'], 'FILLED must wait for partial');

    partialFetchDone.resolve();
    await filledP;
    assert.deepEqual(log, ['partial:fetch', 'partial:done', 'filled:read-watermark', 'filled:done']);
  });
});
