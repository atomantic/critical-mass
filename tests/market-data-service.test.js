// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { ingestNewFillsForOrder, settleCancelledOrder, createTimerTracker, createWorkQueue, createMarketDataService } = require('../src/market-data-service');

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

  it('on adapter failure, reconciles watermark from ledger so post-restart with already-recorded fills does not trigger retry', async () => {
    // Scenario: an order was fully ingested before a process restart.
    // After restart, trackedOrder is recreated with lastIngestedFilledSize=0
    // even though fills are on disk. A WS event arrives, adapter is
    // transiently down. Without reconciliation, the caller would schedule
    // a retry chain for an order that's already fully recorded.
    const adapter = makeAdapter([new Error('network down')]);
    // Pre-populate the ledger to mimic disk-loaded state from a prior run.
    ledger.ingestFill({ tradeId: 't1', orderId: 'order-1', side: 'sell', price: 70000, size: 0.5, totalCommission: 0.05 }, null, { skipPersist: true });

    // trackedOrder.lastIngestedFilledSize is unset (post-restart).
    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'FILLED'
    );

    assert.equal(result.fetched, true,
      'ledger already covers WS cumulative — fetched=true so caller does not retry');
    assert.equal(trackedOrder.lastIngestedFilledSize, 0.5,
      'watermark reconciled from ledger after adapter failure');
  });

  it('on adapter failure, bails post-stop without writing to ledger or trackedOrder', async () => {
    // Service stops while getOrderFills is in flight and rejects. The
    // catch block must not call persist() or mutate lastIngestedFilledSize
    // — those would corrupt a replacement service that has taken over the
    // exchange/pair after stop.
    let stopped = false;
    const adapter = {
      getOrderFills: async () => {
        stopped = true; // simulate service.stop() during await
        throw new Error('network down');
      },
    };
    let persistCalls = 0;
    const guardLedger = {
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [{ size: 0.5 }],
      getRecordedSizeForOrder: () => 0.5,
      persist: () => { persistCalls += 1; },
    };

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: guardLedger, exchange: 'coinbase', isStopped: () => stopped },
      'order-1', trackedOrder, 0.5, 'FILLED'
    );

    assert.equal(result.fetched, false, 'must bail with fetched=false post-stop');
    assert.equal(persistCalls, 0, 'must not persist post-stop (could clobber replacement service)');
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'must not advance watermark on a stopped service');
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

  it('cancel retry chain reads the mutable target so a replayed CANCELLED can advance filledSize mid-flight', async () => {
    // First attempt fails (adapter throws); retry is scheduled.
    // Meanwhile a replayed CANCELLED advances filledSize 0.3 -> 0.7.
    // The retry must read the new target and ingest enough fills to
    // cover 0.7 — not stop short at the captured 0.3.
    const adapter = makeAdapter([
      new Error('boom'),                                  // attempt 0
      [makeFill('t1', 0.3), makeFill('t2', 0.4)],          // attempt 1 — full set covering 0.7
    ]);

    const target = { filledSize: 0.3 };
    const deps = { ...makeDeps(adapter), getCurrentFilledSize: () => target.filledSize };

    const r = await settleCancelledOrder(deps, 'order-1', trackedOrder, 'CANCELLED', 0.3);
    assert.equal(r.retryScheduled, true);
    assert.equal(ledger.ingested.length, 0);

    // Replayed CANCELLED with larger cumulative — advance the target.
    target.filledSize = 0.7;

    // Run the queued retry. With the fix, the chain re-reads target=0.7,
    // calls ingest with cumulativeFilledSize=0.7, and ingests both fills
    // (covering the full 0.7). Without the fix, it would use the captured
    // 0.3 and settle as soon as ledger covered 0.3 (stopping short).
    await scheduledTimeouts[0].fn();

    assert.equal(ledger.ingested.length, 2,
      'retry must observe target=0.7 and ingest the full set, not stop at 0.3');
    assert.deepEqual(markSettledCalls, ['order-1']);
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

// ---------------------------------------------------------------------------
// Integration: handleOrderUpdate via the real factory (uses _test hooks)
//
// These cover the regression points one layer up from the helpers — the
// terminal-status guard at the top of processOrderUpdate had previously
// blocked replayed CANCELLED events from reaching the mutable-target
// update logic, even when a retry chain was still in flight.
// ---------------------------------------------------------------------------

describe('handleOrderUpdate integration: replayed CANCELLED reaches target update during retry chain', () => {
  it('replayed CANCELLED with larger filledSize advances the in-flight retry target via processOrderUpdate', async () => {
    // First CANCELLED: filledSize=0.3, fetch fails → retry scheduled.
    // Replayed CANCELLED: filledSize=0.7 — must reach the cancel branch
    // and update the pending target so the retry catches up to 0.7.
    let callIdx = 0;
    const responses = [
      new Error('boom'),                                   // attempt 0 fails
      [{ tradeId: 't1', orderId: 'order-X', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 },
       { tradeId: 't2', orderId: 'order-X', side: 'sell', price: 70000, size: 0.4, totalCommission: 0.05 }], // retry: full set
    ];
    const fakeAdapter = {
      getOrderFills: async () => {
        const r = responses[Math.min(callIdx, responses.length - 1)];
        callIdx += 1;
        if (r instanceof Error) throw r;
        return r;
      },
    };

    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    const ingestedTradeIds = [];
    const fakeLedger = {
      ingestFill: (fill) => {
        const tradeId = fill.tradeId;
        if (ingestedTradeIds.includes(tradeId)) return { ingested: false, fill: null };
        ingestedTradeIds.push(tradeId);
        return { ingested: true, fill };
      },
      getFillsForOrder: () => ingestedTradeIds.map(id => ({ size: id === 't1' ? 0.3 : 0.4 })),
      getRecordedSizeForOrder: () => ingestedTradeIds.reduce((s, id) => s + (id === 't1' ? 0.3 : 0.4), 0),
      persist: () => {},
    };
    svc._test.injectFillLedger(fakeLedger);
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-X', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    // First CANCELLED at 0.3 — fetch fails, retry scheduled.
    await svc._test.handleOrderUpdate({ orderId: 'order-X', status: 'CANCELLED', filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0 });

    const pending = svc._test.pendingTerminalRetries.get('order-X');
    assert.ok(pending, 'retry must be pending after first cancel failed');
    assert.equal(pending.filledSize, 0.3, 'initial target captured');

    // Replayed CANCELLED at 0.7 — must update the target despite the
    // settled-status guard (status was flipped to 'cancelled' on the first
    // call's settleCancelledOrder attempt 0).
    await svc._test.handleOrderUpdate({ orderId: 'order-X', status: 'CANCELLED', filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0 });

    assert.equal(svc._test.pendingTerminalRetries.get('order-X').filledSize, 0.7,
      'replayed CANCELLED must advance the mutable target the in-flight retry reads');

    // Cleanup so timers don't leak into other tests
    svc.stop();
  });

  it('pre-populates pendingTerminalRetries before first CANCELLED await so race-arriving replays update target', async () => {
    // Block getOrderFills until the test resolves the deferred — gives
    // us a window between status flip and await resolution to fire a
    // replayed CANCELLED. Without the pre-population fix, the replay
    // would see status='cancelled' AND no pendingTerminalRetries entry,
    // hit the settled-status guard, and be dropped.
    let resolveFetch;
    const firstFetch = new Promise((resolve) => { resolveFetch = resolve; });
    let firstCallStarted = false;
    const fakeAdapter = {
      getOrderFills: async () => {
        firstCallStarted = true;
        await firstFetch;
        throw new Error('boom');
      },
    };

    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);

    const fakeLedger = {
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    };
    svc._test.injectFillLedger(fakeLedger);
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-Z', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    // Fire-and-forget the first CANCELLED — its handler will await the
    // deferred fetch.
    const firstP = svc._test.handleOrderUpdate({
      orderId: 'order-Z', status: 'CANCELLED', filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0,
    });

    // Wait until the first call has reached the await
    await new Promise(r => setImmediate(r));
    while (!firstCallStarted) await new Promise(r => setImmediate(r));

    // Verify pre-population happened synchronously during the first call.
    let target = svc._test.pendingTerminalRetries.get('order-Z');
    assert.ok(target, 'pendingTerminalRetries must be populated synchronously, before the first await');
    assert.equal(target.filledSize, 0.3, 'pre-populated with first call\'s filledSize');

    // Replayed CANCELLED with larger filledSize. Don't await — the
    // replay queues behind the first call (work-queue serialization),
    // which is itself blocked on resolveFetch. We only need to verify
    // the synchronous prelude advances the target.
    svc._test.handleOrderUpdate({
      orderId: 'order-Z', status: 'CANCELLED', filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0,
    });

    target = svc._test.pendingTerminalRetries.get('order-Z');
    assert.equal(target.filledSize, 0.7,
      'replay during the first await must advance the pre-populated target via the synchronous prelude');

    // Let the first call finish (it will throw + schedule retry, which
    // serves as the resolution path for the queued replay too).
    resolveFetch();
    await firstP;

    svc.stop();
  });

  it('replayed FILLED during retry await updates target with new aggregates (price/fees)', async () => {
    // First FILLED: filledSize=0.3, avgPrice=70000, fees=0.05.
    //  - getOrderFills returns subset (0.3) → ledger short of (in
    //    reality, also 0.3 — but we test the target replay path).
    //  Wait, simpler: schedule a retry. Then a replayed FILLED arrives
    //  with larger filledSize=0.7, avgPrice=70500, fees=0.10. The
    //  in-flight retry's target must reflect those updated aggregates.
    let callIdx = 0;
    const responses = [
      new Error('boom'),                                   // attempt 0 fails → retry
      [{ tradeId: 't1', orderId: 'order-Y', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 },
       { tradeId: 't2', orderId: 'order-Y', side: 'sell', price: 70500, size: 0.4, totalCommission: 0.05 }],
    ];
    const fakeAdapter = {
      getOrderFills: async () => {
        const r = responses[Math.min(callIdx, responses.length - 1)];
        callIdx += 1;
        if (r instanceof Error) throw r;
        return r;
      },
    };

    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);

    const ingestedTradeIds = new Set();
    const fakeLedger = {
      ingestFill: (fill) => {
        if (ingestedTradeIds.has(fill.tradeId)) return { ingested: false, fill: null };
        ingestedTradeIds.add(fill.tradeId);
        return { ingested: true, fill };
      },
      getFillsForOrder: () => Array.from(ingestedTradeIds).map(id => ({ size: id === 't1' ? 0.3 : 0.4 })),
      getRecordedSizeForOrder: () => Array.from(ingestedTradeIds).reduce((s, id) => s + (id === 't1' ? 0.3 : 0.4), 0),
      persist: () => {},
    };
    svc._test.injectFillLedger(fakeLedger);
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-Y', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    const fills = [];
    svc.setOnOrderFill(f => fills.push(f));

    // First FILLED at 0.3 with avg=70000 — fetch fails, retry scheduled.
    await svc._test.handleOrderUpdate({
      orderId: 'order-Y', status: 'FILLED',
      filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0.05,
    });

    const target = svc._test.pendingTerminalRetries.get('order-Y');
    assert.ok(target, 'retry should be pending');
    assert.equal(target.filledSize, 0.3);
    assert.equal(target.averageFilledPrice, 70000);

    // Replayed FILLED at 0.7 with new aggregates — must update target
    // synchronously (handleOrderUpdate prelude) before the retry can
    // settle against stale 0.3/70000.
    await svc._test.handleOrderUpdate({
      orderId: 'order-Y', status: 'FILLED',
      filledSize: 0.7, averageFilledPrice: 70500, totalFees: 0.10,
    });

    assert.equal(target.filledSize, 0.7,
      'replay must advance target.filledSize synchronously');
    assert.equal(target.averageFilledPrice, 70500,
      'replay must update averageFilledPrice on FILLED');
    assert.equal(target.totalFees, 0.10,
      'replay must update totalFees on FILLED');

    svc.stop();
  });

  it('replayed CANCELLED with larger cumulative restarts catchup after the prior chain has settled', async () => {
    // Adapters that synthesize getOrderFills from recent-trade queries
    // (Gemini, Crypto.com) can return only a partial history on the first
    // cancel and the rest later. Without keeping the pendingTerminalRetries
    // entry alive after the first synchronous settle, the replay would hit
    // the settled-status guard and the missing fills would be lost.
    //
    // First CANCELLED at 0.3 — getOrderFills returns [t1=0.3] → settles cleanly.
    // Replayed CANCELLED at 0.7 — getOrderFills now returns [t1=0.3, t2=0.4]
    // (the adapter's recent-trade window has expanded). The cancel branch
    // must detect target.settled=true + larger filledSize, restart catchup,
    // and ingest the missing 0.4.
    let callIdx = 0;
    const responses = [
      [{ tradeId: 't1', orderId: 'order-W', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 }],
      [{ tradeId: 't1', orderId: 'order-W', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 },
       { tradeId: 't2', orderId: 'order-W', side: 'sell', price: 70000, size: 0.4, totalCommission: 0.05 }],
    ];
    const fakeAdapter = {
      getOrderFills: async () => {
        const r = responses[Math.min(callIdx, responses.length - 1)];
        callIdx += 1;
        return r;
      },
    };

    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    const ingested = new Map(); // tradeId -> size
    const fakeLedger = {
      ingestFill: (fill) => {
        if (ingested.has(fill.tradeId)) return { ingested: false, fill: null };
        ingested.set(fill.tradeId, fill.size);
        return { ingested: true, fill };
      },
      getFillsForOrder: () => Array.from(ingested.values()).map(size => ({ size })),
      getRecordedSizeForOrder: () => Array.from(ingested.values()).reduce((s, sz) => s + sz, 0),
      persist: () => {},
    };
    svc._test.injectFillLedger(fakeLedger);
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-W', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    // First CANCELLED at 0.3 — settles cleanly with [t1].
    await svc._test.handleOrderUpdate({ orderId: 'order-W', status: 'CANCELLED', filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0 });

    const afterFirst = svc._test.pendingTerminalRetries.get('order-W');
    assert.ok(afterFirst, 'entry must stay alive after first settle (do not delete)');
    assert.equal(afterFirst.settled, true, 'wrapped markSettled must flip target.settled');
    assert.equal(afterFirst.filledSize, 0.3, 'target tracks the prior settle\'s cumulative');
    assert.equal(ingested.size, 1, 'first settle ingested t1 only');

    // Replayed CANCELLED at 0.7 — must restart catchup and ingest t2.
    await svc._test.handleOrderUpdate({ orderId: 'order-W', status: 'CANCELLED', filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0 });

    assert.equal(ingested.size, 2, 'restart catchup must ingest the missing t2');
    assert.ok(ingested.has('t2'), 't2 must be in the ledger');
    const afterReplay = svc._test.pendingTerminalRetries.get('order-W');
    assert.equal(afterReplay.filledSize, 0.7, 'target.filledSize advanced to replay\'s cumulative');
    assert.equal(afterReplay.settled, true, 'restarted chain settled cleanly');

    svc.stop();
  });

  it('CANCELLED replay arriving DURING the prior chain still triggers a restart when the chain settled at the smaller value', async () => {
    // Race: handleOrderUpdate's synchronous prelude advances target.filledSize
    // for the in-flight retry to read on its next attempt — but the chain's
    // attempt-0 path uses the parameter passed at call time, not the target.
    // If the chain happens to settle on attempt 0 (adapter returned just
    // enough on the first try), the prelude-advanced target.filledSize is
    // then "ahead" of what the ledger actually covers. The cancel branch
    // must compare against trackedOrder.lastIngestedFilledSize (the real
    // watermark), not target.filledSize, so the gap is still detected and
    // restart catch-up runs.
    let resolveFirstFetch;
    const firstFetch = new Promise((resolve) => { resolveFirstFetch = resolve; });
    let callIdx = 0;
    const fakeAdapter = {
      getOrderFills: async () => {
        const idx = callIdx;
        callIdx += 1;
        if (idx === 0) {
          // First call: block until the test fires the replay, then return
          // just enough to settle attempt 0 at filledSize=0.3.
          await firstFetch;
          return [{ tradeId: 't1', orderId: 'order-V', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 }];
        }
        // Second call (restart catchup): full set covering 0.7.
        return [
          { tradeId: 't1', orderId: 'order-V', side: 'sell', price: 70000, size: 0.3, totalCommission: 0.05 },
          { tradeId: 't2', orderId: 'order-V', side: 'sell', price: 70000, size: 0.4, totalCommission: 0.05 },
        ];
      },
    };

    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    const ingested = new Map();
    const fakeLedger = {
      ingestFill: (fill) => {
        if (ingested.has(fill.tradeId)) return { ingested: false, fill: null };
        ingested.set(fill.tradeId, fill.size);
        return { ingested: true, fill };
      },
      getFillsForOrder: () => Array.from(ingested.values()).map(size => ({ size })),
      getRecordedSizeForOrder: () => Array.from(ingested.values()).reduce((s, sz) => s + sz, 0),
      persist: () => {},
    };
    svc._test.injectFillLedger(fakeLedger);
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-V', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    // Fire-and-forget the first CANCELLED — chain is blocked on resolveFirstFetch.
    const firstP = svc._test.handleOrderUpdate({ orderId: 'order-V', status: 'CANCELLED', filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0 });

    // Wait until the chain has reached the await.
    while (callIdx === 0) await new Promise(r => setImmediate(r));

    // Replayed CANCELLED at 0.7 — synchronous prelude advances target.filledSize
    // to 0.7 immediately. The replay's processOrderUpdate queues behind the
    // first call's still-running settleCancelledOrder.
    const secondP = svc._test.handleOrderUpdate({ orderId: 'order-V', status: 'CANCELLED', filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0 });

    const targetMidFlight = svc._test.pendingTerminalRetries.get('order-V');
    assert.equal(targetMidFlight.filledSize, 0.7, 'prelude advanced target.filledSize to 0.7 synchronously');

    // Let the first chain's fetch resolve. Attempt 0 settles at filledSize=0.3
    // (the call-time parameter), even though target.filledSize is now 0.7.
    resolveFirstFetch();
    await firstP;
    await secondP;

    // The replay's processOrderUpdate ran after the first chain settled.
    // It must have detected the ledger gap (lastIngestedFilledSize=0.3 < 0.7)
    // and restarted catch-up to fetch t2.
    assert.equal(ingested.size, 2, 'restart catchup must run despite target.filledSize being equal to replay filledSize');
    assert.ok(ingested.has('t2'), 't2 must be ingested by the restart');

    svc.stop();
  });

  it('replayed FILLED with same filledSize but improved aggregates updates target.averageFilledPrice/totalFees', async () => {
    // On reconnect, Coinbase may replay a terminal FILLED event with the
    // same cumulative filledSize but more complete averageFilledPrice/
    // totalFees (the original may have arrived before WS-side aggregation
    // finalized). The synchronous prelude must update aggregates even
    // when filledSize is unchanged, otherwise finalize/callback fires
    // with stale values.
    const fakeAdapter = {
      getOrderFills: async () => { throw new Error('keep retry pending'); },
    };
    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-U', { type: 'take_profit', price: 70000, size: 0.5, placedAt: Date.now() });

    // First FILLED at 0.5 with placeholder aggregates — fetch fails, retry pending.
    await svc._test.handleOrderUpdate({
      orderId: 'order-U', status: 'FILLED',
      filledSize: 0.5, averageFilledPrice: 70000, totalFees: 0.05,
    });

    const target = svc._test.pendingTerminalRetries.get('order-U');
    assert.ok(target, 'retry must be pending');
    assert.equal(target.averageFilledPrice, 70000, 'initial aggregates captured');
    assert.equal(target.totalFees, 0.05);

    // Replayed FILLED with SAME filledSize=0.5 but updated aggregates —
    // the prelude must overwrite the prior values so a settle in the
    // retry chain finalizes with the corrected price/fees.
    await svc._test.handleOrderUpdate({
      orderId: 'order-U', status: 'FILLED',
      filledSize: 0.5, averageFilledPrice: 70500, totalFees: 0.10,
    });

    assert.equal(target.filledSize, 0.5, 'filledSize unchanged');
    assert.equal(target.averageFilledPrice, 70500,
      'replay must update averageFilledPrice even when filledSize is unchanged');
    assert.equal(target.totalFees, 0.10,
      'replay must update totalFees even when filledSize is unchanged');

    svc.stop();
  });

  it('replayed FILLED with placeholder totalFees=0 does NOT clobber a previously-correct nonzero fee total', async () => {
    // websocket-feed normalizes a missing total_fees field to 0. Without
    // a truthy guard, the prelude would overwrite a valid existing fee
    // with the placeholder zero on the replay, causing finalize/callback
    // to report fees=0 even though the original event had the correct
    // value.
    const fakeAdapter = {
      getOrderFills: async () => { throw new Error('keep retry pending'); },
    };
    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-S', { type: 'take_profit', price: 70000, size: 0.5, placedAt: Date.now() });

    // First FILLED with valid totalFees=0.05 — fetch fails, retry pending.
    await svc._test.handleOrderUpdate({
      orderId: 'order-S', status: 'FILLED',
      filledSize: 0.5, averageFilledPrice: 70000, totalFees: 0.05,
    });

    const target = svc._test.pendingTerminalRetries.get('order-S');
    assert.ok(target);
    assert.equal(target.totalFees, 0.05);

    // Replayed FILLED with placeholder totalFees=0 — must NOT overwrite.
    await svc._test.handleOrderUpdate({
      orderId: 'order-S', status: 'FILLED',
      filledSize: 0.5, averageFilledPrice: 70000, totalFees: 0,
    });

    assert.equal(target.totalFees, 0.05,
      'placeholder totalFees=0 must not clobber valid existing nonzero fees');

    svc.stop();
  });

  it('partial retry timer reschedules to the fresh attempt delay when a larger WS update arrives', async () => {
    // A pending partial retry that's already backed off to a long delay
    // (e.g. attempt=5 → 32s+) shouldn't sit on that stale delay when a
    // fresh exchange WS update arrives reporting a larger cumulative —
    // the entry must re-arm with the new (smaller) attempt's delay so
    // the new partial gets ingested promptly. The stale timer is left to
    // fire and no-op (the freshly armed timer fires first, consuming the
    // entry; the stale callback bails on the missing-entry check).
    const svc = createMarketDataService('coinbase');
    let scheduledDelays = [];
    // Wrap timerTracker.trackedSetTimeout via the module's _test pattern is
    // not exposed; instead, observe the `console.log` line which includes
    // the delay. Easier: just check that an extra timer is pending after
    // re-arm by counting tracker.size before and after.
    svc._test.injectAdapter({ getOrderFills: async () => { throw new Error('keep retry pending'); } });
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-R', { type: 'take_profit', price: 70000, size: 1.0, placedAt: Date.now() });

    // Pre-populate an entry simulating a chain that's burned 5 attempts
    // and is sitting on a long-delay timer. We don't actually schedule
    // the timer here (the entry alone is enough to verify re-arm logic
    // pre-existing-timer count).
    svc._test.pendingPartialRetries.set('order-R', { filledSize: 0.3, attempt: 5 });
    const baselineTimers = svc._test.timerTracker.size();

    // Fresh WS update at 0.7. Adapter fails so schedulePartialRetry runs
    // with attempt=1. The existing-entry branch must:
    //   1. Reset entry.attempt to 1.
    //   2. Re-arm the timer (so the new attempt=1's smaller delay is
    //      what gets honored, not the stale long delay).
    await svc._test.handleOrderUpdate({
      orderId: 'order-R', status: 'OPEN',
      filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0,
    });

    const entry = svc._test.pendingPartialRetries.get('order-R');
    assert.equal(entry.attempt, 1, 'attempt reset to fresh budget');
    assert.equal(entry.filledSize, 0.7);
    assert.ok(svc._test.timerTracker.size() > baselineTimers,
      'a new timer was armed for the fresh attempt');

    svc.stop();
  });

  it('cancel-retry replay during in-flight chain re-arms the timer instead of waiting on stale backoff', async () => {
    // First CANCELLED at 0.3 fails repeatedly; chain backs off. A replay
    // at 0.7 arrives while a long-delay retry timer is pending. The
    // cancel branch must restart the chain (which cancels the stale
    // timer in startCancelCatchup's prelude) so the fresh exchange data
    // is processed promptly rather than waiting on the stale backoff.
    // Without this, on Gemini/Crypto.com the missing fills could age
    // out of the adapter's recent-trade window before the next retry.
    const fakeAdapter = {
      getOrderFills: async () => { throw new Error('boom'); },
    };
    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter(fakeAdapter);
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-N', { type: 'take_profit', price: 70000, size: 0.7, placedAt: Date.now() });

    // First CANCELLED at 0.3 — chain starts, fails, schedules retry timer.
    await svc._test.handleOrderUpdate({
      orderId: 'order-N', status: 'CANCELLED',
      filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0,
    });
    const target = svc._test.pendingTerminalRetries.get('order-N');
    assert.ok(target, 'retry must be pending');
    const firstTimerId = target.timerId;
    assert.ok(firstTimerId != null, 'retry timer id captured on target');

    // Replay at 0.7 — must restart the chain. The prior timer should be
    // cancelled, a new one armed.
    await svc._test.handleOrderUpdate({
      orderId: 'order-N', status: 'CANCELLED',
      filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0,
    });

    const targetAfter = svc._test.pendingTerminalRetries.get('order-N');
    assert.ok(targetAfter.timerId != null, 'a new retry timer was armed');
    assert.notEqual(targetAfter.timerId, firstTimerId,
      'retry timer was re-armed after replay (id changed)');
    assert.equal(targetAfter.filledSize, 0.7, 'target advanced to replay\'s cumulative');

    svc.stop();
  });

  it('partial retry timer cancels the previously-armed timer when re-arming on a fresh WS update', async () => {
    // Without cancelling the prior timer, a sustained adapter outage with
    // many WS updates would accumulate one pending timer per update in
    // timerTracker, growing the pending set unboundedly and later flooding
    // the queue with stale no-op callbacks.
    const svc = createMarketDataService('coinbase');
    svc._test.injectAdapter({ getOrderFills: async () => { throw new Error('keep retry pending'); } });
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-P', { type: 'take_profit', price: 70000, size: 1.0, placedAt: Date.now() });

    // First WS partial — schedules a timer.
    await svc._test.handleOrderUpdate({
      orderId: 'order-P', status: 'OPEN',
      filledSize: 0.3, averageFilledPrice: 70000, totalFees: 0,
    });
    const afterFirst = svc._test.timerTracker.size();
    const firstTimerId = svc._test.pendingPartialRetries.get('order-P').timerId;
    assert.ok(firstTimerId != null, 'first timer id stored on entry');

    // Several more partials with growing cumulative — each must re-arm
    // and cancel the prior timer, NOT pile up new timers in the tracker.
    for (const fs of [0.4, 0.5, 0.6, 0.7]) {
      await svc._test.handleOrderUpdate({
        orderId: 'order-P', status: 'OPEN',
        filledSize: fs, averageFilledPrice: 70000, totalFees: 0,
      });
    }

    assert.equal(svc._test.timerTracker.size(), afterFirst,
      'timerTracker size must not grow on each fresh WS update — old timer cancelled before new one armed');

    svc.stop();
  });

  it('partial retry attempt counter resets when a fresh WS update reports a larger cumulative', async () => {
    // Without resetting attempt, an entry that's burned through most of
    // its 5-attempt budget would inherit the near-exhausted count when a
    // larger partial arrives, giving up after one or two tries on the
    // new larger value.
    const svc = createMarketDataService('coinbase');
    // Fail every fetch so retries stay scheduled (we only inspect the entry).
    svc._test.injectAdapter({ getOrderFills: async () => { throw new Error('boom'); } });
    svc._test.injectFillLedger({
      ingestFill: () => ({ ingested: false, fill: null }),
      getFillsForOrder: () => [],
      getRecordedSizeForOrder: () => 0,
      persist: () => {},
    });
    svc._test.injectProductId('BTC-USDC');
    svc.trackOrder('order-T', { type: 'take_profit', price: 70000, size: 1.0, placedAt: Date.now() });

    // Manually pre-populate the partial-retry entry to mimic a chain
    // that's already burned 4 attempts. (Easier than driving 4 timers.)
    svc._test.pendingPartialRetries.set('order-T', { filledSize: 0.3, attempt: 4 });

    // Fresh WS partial at 0.7 — adapter fails, schedulePartialRetry is
    // invoked with attempt=1. The existing-entry branch must reset
    // attempt to 1 (fresh budget for the new larger cumulative).
    await svc._test.handleOrderUpdate({
      orderId: 'order-T', status: 'OPEN',
      filledSize: 0.7, averageFilledPrice: 70000, totalFees: 0,
    });

    const entry = svc._test.pendingPartialRetries.get('order-T');
    assert.ok(entry, 'partial retry entry must remain');
    assert.equal(entry.filledSize, 0.7, 'filledSize advanced to fresh cumulative');
    assert.equal(entry.attempt, 1,
      'attempt counter reset so the new larger partial gets a fresh budget');

    svc.stop();
  });
});
