// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { ingestNewFillsForOrder, settleCancelledOrder, createTimerTracker } = require('../src/market-data-service');

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
 * including the skipPersist option (real ledger auto-persists per fill
 * unless skipPersist is set).
 */
const makeLedger = () => {
  const seen = new Set();
  const ingested = []; // { tradeId, orderPlacedAt, skipPersist }
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
      if (!options.skipPersist) persistCalls += 1;
      return { ingested: true, fill };
    },
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
    retryDelayMs: 30000,
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
