// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineLocks, FILL_WAIT_MS, FILL_POLL_MS, LADDER_WAIT_MS, LADDER_POLL_MS, BUSY_LADDER } = require('../src/engine-locks');

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createEngineLocks — named predicates', () => {
  it('isMutatingStructure is merge or reconcile only', () => {
    const locks = createEngineLocks();
    assert.equal(locks.isMutatingStructure(), false);
    assert.equal(locks.isMutatingPosition(), false);

    locks._test.setMergeInProgress(true);
    assert.equal(locks.isMutatingStructure(), true);
    assert.equal(locks.isMutatingPosition(), true);
    locks._test.setMergeInProgress(false);

    locks._test.setReconcileInProgress(true);
    assert.equal(locks.isMutatingStructure(), true);
    assert.equal(locks.isMutatingPosition(), true);
    locks._test.setReconcileInProgress(false);

    locks._test.setFillInProgress(2);
    assert.equal(locks.isMutatingStructure(), false, 'fills are not a structure mutation');
    assert.equal(locks.isMutatingPosition(), true, 'fills are a position mutation');
  });

  it('isMutatingPosition is merge, reconcile, or any in-flight fill', () => {
    const locks = createEngineLocks();
    locks._test.setFillInProgress(0);
    assert.equal(locks.isMutatingPosition(), false);
    locks._test.setFillInProgress(1);
    assert.equal(locks.isMutatingPosition(), true);
  });

  it('describeBusy returns the operator-facing refusal strings', () => {
    const locks = createEngineLocks();
    assert.equal(locks.describeBusy(), 'A merge or reconcile is already in progress');
    assert.equal(locks.describeBusy('structure'), 'A merge or reconcile is already in progress');
    assert.equal(locks.describeBusy('position'), 'A merge, reconcile, or fill is in progress — try again');
    assert.equal(locks.describeBusy('ladder'), 'A ladder rebuild, cancel, or cycle reset is in progress — try again');
  });
});

describe('createEngineLocks — merge reentrancy', () => {
  it('nested withMergeLock runs the inner fn instead of refusing busy', async () => {
    const locks = createEngineLocks();
    const order = [];
    const result = await locks.withMergeLock(async () => {
      order.push('outer');
      const inner = await locks.withMergeLock(async () => {
        order.push('inner');
        assert.equal(locks.getFlags().mergeInProgress, true);
        return 'inner-ok';
      });
      order.push(inner);
      return 'outer-ok';
    });
    assert.deepEqual(order, ['outer', 'inner', 'inner-ok']);
    assert.equal(result, 'outer-ok');
    assert.equal(locks.getFlags().mergeInProgress, false);
  });

  it('a second holder is refused while the first holds, even if a fill is in flight', async () => {
    const locks = createEngineLocks();
    let release;
    const held = new Promise((r) => { release = r; });
    const first = locks.withMergeLock(async () => {
      await held;
      return { success: true };
    });
    await tick();
    assert.equal(locks.getFlags().mergeInProgress, true, 'first holder must have the lock before the second races');
    locks._test.setFillInProgress(1);
    const second = await locks.withMergeLock(async () => ({ success: true, leaked: true }));
    assert.equal(second.success, false);
    assert.equal(second.leaked, undefined);
    assert.equal(second.message, locks.describeBusy('structure'));
    release();
    const firstResult = await first;
    assert.equal(firstResult.success, true);
    assert.equal(locks.getFlags().mergeInProgress, false);
  });

  it('an externally held merge flag (test setter) is not treated as reentrancy', async () => {
    const locks = createEngineLocks();
    locks._test.setMergeInProgress(true);
    const result = await locks.withMergeLock(async () => ({ success: true, leaked: true }));
    assert.equal(result.success, false);
    assert.equal(result.message, locks.describeBusy('structure'));
  });
});

describe('createEngineLocks — merge does not wait for fills', () => {
  it('withMergeLock proceeds immediately while a fill is in flight', async () => {
    let slept = 0;
    const locks = createEngineLocks({
      sleep: async (ms) => { slept += ms; },
    });
    locks._test.setFillInProgress(1);
    let ran = false;
    const t0 = Date.now();
    await locks.withMergeLock(async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(slept, 0, 'merge must not poll the fill gate');
    assert.ok(Date.now() - t0 < 50, 'merge must not busy-wait on fills');
    assert.equal(locks.getFlags().mergeInProgress, false);
  });
});

describe('createEngineLocks — fill waits for merge', () => {
  it('blocks while mergeInProgress is set, then proceeds once it clears', async () => {
    const locks = createEngineLocks();
    locks._test.setMergeInProgress(true);

    let ran = false;
    let settled = false;
    const fill = locks.withFillGate(async () => { ran = true; })
      .then(() => { settled = true; });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(settled, false, 'fill must not proceed while merge is held');
    assert.equal(ran, false);
    assert.equal(locks.getFlags().fillInProgress, 1);

    locks._test.setMergeInProgress(false);
    await fill;
    assert.equal(ran, true);
    assert.equal(locks.getFlags().fillInProgress, 0);
  });

  it('proceeds after the 15s bound and emits the timeout warning', async () => {
    let nowMs = 1_000_000;
    const warnings = [];
    const locks = createEngineLocks({
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
      logWarn: (msg) => warnings.push(msg),
    });
    locks._test.setMergeInProgress(true);

    let ran = false;
    await locks.withFillGate(async () => { ran = true; }, { exchange: 'coinbase', orderId: 'fill-9' });

    assert.equal(ran, true);
    assert.ok(nowMs >= 1_000_000 + FILL_WAIT_MS);
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0],
      '⚠️ [coinbase] Fill fill-9 proceeding after 15s wait — merge lock still held (possible stuck merge)'
    );
    assert.equal(locks.getFlags().fillInProgress, 0);
  });

  it('decrements fillInProgress even when fn throws', async () => {
    const locks = createEngineLocks();
    await assert.rejects(
      () => locks.withFillGate(async () => { throw new Error('boom'); }),
      /boom/
    );
    assert.equal(locks.getFlags().fillInProgress, 0);
  });
});

describe('createEngineLocks — reconcile and entry', () => {
  it('withReconcileLock skips when a merge is already held', () => {
    const locks = createEngineLocks();
    locks._test.setMergeInProgress(true);
    let ran = false;
    const result = locks.withReconcileLock(() => { ran = true; return 'nope'; });
    assert.equal(ran, false);
    assert.equal(result, undefined);
    assert.equal(locks.getFlags().reconcileInProgress, false);
  });

  it('withReconcileLock holds until the returned thenable settles', async () => {
    const locks = createEngineLocks();
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    locks.withReconcileLock(() => pending);
    assert.equal(locks.getFlags().reconcileInProgress, true);
    resolve();
    await pending;
    await tick();
    assert.equal(locks.getFlags().reconcileInProgress, false);
  });

  it('withReconcileLock lets the caller catch an async rejection and retry', async () => {
    const locks = createEngineLocks();
    const failure = Promise.reject(new Error('reconcile failed'));
    const result = locks.withReconcileLock(() => failure);
    assert.equal(result, failure, 'the caller retains the original promise');
    await assert.rejects(result, /reconcile failed/);
    // An ignored .finally() chain rejects separately on the next turn even
    // though the original rejection was caught; node:test reports it as a
    // failure. Let that turn run before asserting the gate is reusable.
    await tick();
    assert.equal(locks.getFlags().reconcileInProgress, false);
    assert.equal(await locks.withReconcileLock(async () => 'retried'), 'retried');
  });

  it('withEntryLock acquire/releases around fn', async () => {
    const locks = createEngineLocks();
    let during = false;
    await locks.withEntryLock(async () => {
      during = locks.isEntryInProgress();
    });
    assert.equal(during, true);
    assert.equal(locks.isEntryInProgress(), false);
  });
});

describe('createEngineLocks — constants', () => {
  it('pins the production 15s fill-wait bound and 25ms poll', () => {
    assert.equal(FILL_WAIT_MS, 15000);
    assert.equal(FILL_POLL_MS, 25);
  });

  it('pins the production 3-minute ladder-wait bound and 25ms poll (#766)', () => {
    assert.equal(LADDER_WAIT_MS, 180000);
    assert.equal(LADDER_POLL_MS, 25);
  });
});

/** A promise plus its resolver, for holding a lock open deterministically. */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('createEngineLocks — ladder lock (#766)', () => {
  it('queues a second sweep behind the first instead of refusing it', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1 });
    const order = [];
    const gate = deferred();
    const first = locks.withLadderLock(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 'first';
    });
    assert.equal(locks.isLadderBusy(), true);
    const second = locks.withLadderLock(async () => {
      order.push('second');
      return 'second';
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['first:start'], 'the second sweep waits while the first holds');
    assert.equal(locks.getFlags().ladderPending, 2);
    assert.equal(locks.getFlags().ladderHolders, 1);
    gate.resolve();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(order, ['first:start', 'first:end', 'second']);
    assert.equal(locks.isLadderBusy(), false);
    assert.equal(locks.getFlags().ladderHolders, 0);
  });

  it('serves waiters in FIFO order', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1 });
    const order = [];
    const gate = deferred();
    const holder = locks.withLadderLock(() => gate.promise);
    const waiters = ['a', 'b', 'c'].map((n) => locks.withLadderLock(async () => {
      order.push(`${n}:start`);
      await tick();
      order.push(`${n}:end`);
    }));
    gate.resolve();
    await holder;
    await Promise.all(waiters);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'], 'no two waiters overlap');
  });

  it('is reentrant for the holder\'s own async context (a mid-cancel booking that resets the cycle)', async () => {
    const locks = createEngineLocks();
    const order = [];
    const result = await locks.withLadderLock(async () => {
      order.push('sweep');
      await tick();
      // e.g. cancelAllLadderOrders → booking → last body closes → resetCycle
      const inner = await locks.withLadderLock(async () => {
        order.push('nested-reset');
        return 'inner';
      });
      order.push(inner);
      return 'outer';
    });
    assert.equal(result, 'outer');
    assert.deepEqual(order, ['sweep', 'nested-reset', 'inner']);
    assert.equal(locks.isLadderBusy(), false);
  });

  it('does not let work the holder left running reenter after it released', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1 });
    const order = [];
    const leak = deferred();
    let leaked;
    await locks.withLadderLock(async () => {
      // Fire-and-forget work spawned inside the holder inherits its context.
      leaked = (async () => {
        await leak.promise;
        return locks.withLadderLock(async () => { order.push('leaked'); });
      })();
    });
    const gate = deferred();
    const second = locks.withLadderLock(async () => {
      order.push('second:start');
      await gate.promise;
      order.push('second:end');
    });
    leak.resolve();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['second:start'], 'the stale context queues like any other caller');
    gate.resolve();
    await second;
    await leaked;
    assert.deepEqual(order, ['second:start', 'second:end', 'leaked']);
  });

  it('releases the lock when the holder throws', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1 });
    await assert.rejects(locks.withLadderLock(async () => { throw new Error('cancel failed'); }), /cancel failed/);
    assert.equal(locks.isLadderBusy(), false);
    assert.equal(await locks.withLadderLock(async () => 'next'), 'next');
  });

  it('wait:false refuses while busy and takes the lock when free', async () => {
    const locks = createEngineLocks();
    const gate = deferred();
    const holder = locks.withLadderLock(() => gate.promise);
    let ran = false;
    const refused = await locks.withLadderLock(async () => { ran = true; }, { wait: false });
    assert.equal(ran, false);
    assert.deepEqual(refused, { success: false, message: BUSY_LADDER });
    gate.resolve();
    await holder;
    assert.equal(await locks.withLadderLock(async () => 'placed', { wait: false }), 'placed');
  });

  it('a caller inside a merge never waits on a held ladder lock', async () => {
    let slept = 0;
    const warnings = [];
    const locks = createEngineLocks({
      sleep: async (ms) => { slept += ms; await tick(); },
      logWarn: (msg) => warnings.push(msg),
    });
    const gate = deferred();
    const holder = locks.withLadderLock(() => gate.promise);
    let ran = false;
    await locks.withMergeLock(async () => {
      await locks.withLadderLock(async () => { ran = true; }, { label: 'Cycle reset', exchange: 'coinbase' });
    });
    assert.equal(ran, true);
    assert.equal(slept, 0, 'a merge must not poll the ladder lock');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[coinbase\] Cycle reset running inside a merge/);
    gate.resolve();
    await holder;
  });

  it('a caller inside a merge takes a free ladder lock (so later sweeps queue behind it)', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1 });
    const order = [];
    const gate = deferred();
    const merge = locks.withMergeLock(() => locks.withLadderLock(async () => {
      order.push('merge-reset:start');
      await gate.promise;
      order.push('merge-reset:end');
    }));
    assert.equal(locks.getFlags().ladderHolders, 1, 'the merge holds the free ladder lock');
    // Outside the merge's context: a rebuild queues behind it as usual.
    const rebuild = locks.withLadderLock(async () => { order.push('rebuild'); });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ['merge-reset:start']);
    gate.resolve();
    await merge;
    await rebuild;
    assert.deepEqual(order, ['merge-reset:start', 'merge-reset:end', 'rebuild']);
  });

  it('onTimeout proceed: runs after the bound with a warning (a TP close is never dropped)', async () => {
    let nowMs = 1_000_000;
    const warnings = [];
    const locks = createEngineLocks({
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
      logWarn: (msg) => warnings.push(msg),
    });
    const stuck = deferred();
    const holder = locks.withLadderLock(() => stuck.promise);
    let ran = false;
    await locks.withLadderLock(async () => { ran = true; }, { onTimeout: 'proceed', label: 'Cycle reset', exchange: 'gemini' });
    assert.equal(ran, true);
    assert.ok(nowMs >= 1_000_000 + LADDER_WAIT_MS);
    assert.deepEqual(warnings, ['⚠️ [gemini] Cycle reset proceeding after 180s wait — ladder lock still held (possible stuck ladder sweep)']);
    stuck.resolve();
    await holder;
    assert.equal(locks.isLadderBusy(), false);
  });

  it('onTimeout proceed: a later waiter still waits for the stuck holder, not just the one that proceeded', async () => {
    let nowMs = 1_000_000;
    let clockRuns = true;
    const locks = createEngineLocks({
      now: () => nowMs,
      sleep: async (ms) => { if (clockRuns) nowMs += ms; else await tick(); },
    });
    const stuck = deferred();
    const holder = locks.withLadderLock(() => stuck.promise);
    await locks.withLadderLock(async () => 'reset', { onTimeout: 'proceed' });
    clockRuns = false;
    const order = [];
    const later = locks.withLadderLock(async () => { order.push('rebuild'); });
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(order, [], 'the rebuild did not slip in beside the stuck holder');
    stuck.resolve();
    await holder;
    await later;
    assert.deepEqual(order, ['rebuild']);
    assert.equal(locks.isLadderBusy(), false);
  });

  it('onTimeout refuse: gives up with the busy result, and later waiters stay queued behind the stuck holder', async () => {
    let nowMs = 1_000_000;
    let clockRuns = true;
    const locks = createEngineLocks({
      now: () => nowMs,
      sleep: async (ms) => { if (clockRuns) nowMs += ms; else await tick(); },
    });
    const stuck = deferred();
    const holder = locks.withLadderLock(() => stuck.promise);
    let ran = false;
    const refused = await locks.withLadderLock(async () => { ran = true; }, { onTimeout: 'refuse' });
    assert.equal(ran, false);
    assert.deepEqual(refused, { success: false, message: BUSY_LADDER });
    assert.equal(locks.isLadderBusy(), true, 'the stuck holder still holds');
    assert.equal(locks.getFlags().ladderPending, 1, 'the refused caller left the queue');

    // A later caller (clock frozen, so no timeout pressure) must still wait
    // for the stuck holder — the refusal did not hand the lock over.
    clockRuns = false;
    const order = [];
    const later = locks.withLadderLock(async () => { order.push('later'); });
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(order, [], 'queued behind the stuck holder, not the refused caller');
    stuck.resolve();
    await holder;
    await later;
    assert.deepEqual(order, ['later']);
  });
});

describe('createEngineLocks — ladder lock deadlock-freedom (#766)', () => {
  it('a TP fill waiting on the ladder lock does not block the holder\'s own mid-cancel fill booking', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1, fillPollMs: 1 });
    const order = [];
    const placement = deferred();
    const rebuild = locks.withLadderLock(async () => {
      order.push('rebuild:cancel');
      // The sweep books a rung that filled mid-cancel through the fill gate.
      await locks.withFillGate(async () => { order.push('rebuild:mid-cancel-booking'); });
      await placement.promise;
      order.push('rebuild:placed');
    });
    // A TP fill closes the last body and resets the cycle.
    const tpFill = locks.withFillGate(async () => {
      order.push('tp:booked');
      await locks.withLadderLock(async () => { order.push('tp:reset-sweep'); });
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['rebuild:cancel', 'rebuild:mid-cancel-booking', 'tp:booked'],
      'the holder\'s booking passed the fill gate while the TP fill waits on the ladder lock');
    placement.resolve();
    await Promise.all([rebuild, tpFill]);
    assert.deepEqual(order, ['rebuild:cancel', 'rebuild:mid-cancel-booking', 'tp:booked', 'rebuild:placed', 'tp:reset-sweep']);
    assert.equal(locks.getFlags().fillInProgress, 0);
    assert.equal(locks.isLadderBusy(), false);
  });

  it('a merge started while a TP fill waits on the ladder lock is not blocked by either', async () => {
    const locks = createEngineLocks({ ladderPollMs: 1, fillPollMs: 1 });
    const placement = deferred();
    const rebuild = locks.withLadderLock(() => placement.promise);
    const tpFill = locks.withFillGate(() => locks.withLadderLock(async () => 'reset'));
    await tick();
    let merged = false;
    await locks.withMergeLock(async () => { merged = true; });
    assert.equal(merged, true, 'merge ran while the ladder lock was held and a fill was queued on it');
    placement.resolve();
    await rebuild;
    assert.equal(await tpFill, 'reset');
  });
});
