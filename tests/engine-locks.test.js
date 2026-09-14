// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineLocks, FILL_WAIT_MS, FILL_POLL_MS } = require('../src/engine-locks');

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
});
