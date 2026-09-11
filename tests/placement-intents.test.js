// @ts-check
// issue #472 — durable pending-placement intents.
//
// An order POST whose outcome we never learn (ambiguous response we cannot
// reconcile, or a crash between dispatch and response) used to leave either a
// plain `{success:false}` — the shape every caller reads as "safe to re-place
// next cycle" — or no record at all, because entry tracking starts only on
// success. Either way the next engine tick committed the same capital a second
// time against an order that may already be resting live on the exchange.
//
// These tests pin the durable half of the fix with no live exchange access:
// the intent is on disk BEFORE the request leaves the process, a persistence
// failure stops the submission, the record blocks every later placement for the
// fund (including after a restart), only a DEFINITIVE outcome clears it, and an
// operator adopt/discard is exactly-once.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const stateTracker = require('../src/state-tracker');
const { placeWithUnknownReconcile } = require('../src/order-manager');
const { createOrderExecutor } = require('../src/order-executor');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const PRODUCT = 'BTC-USDC';

let tmpRoot;

/** Point every fund data path at a throwaway directory. */
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-intents-'));
  mock.method(migration, 'getExchangeDataDir', () => path.join(tmpRoot, EXCHANGE));
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const intentsFile = () => stateTracker.getPlacementIntentsFile(EXCHANGE, PAIR);
const readIntents = () => stateTracker.loadPlacementIntents(EXCHANGE, PAIR);

/** The ambiguous-placement error shape every adapter throws (see #427). */
const unknownError = (clientOrderId) => Object.assign(new Error('socket hang up'), {
  status: 'unknown',
  unknownOutcome: true,
  clientOrderId,
});

const scope = (action = 'entry_bid', side = 'buy') => ({
  intent: { exchange: EXCHANGE, pair: PAIR, action, side, price: 100, size: 0.5, sizeUsdc: 50 },
});

/** Rewrite every persisted intent so it looks like another process wrote it. */
const simulateRestart = () => {
  const intents = readIntents().map(i => ({ ...i, instanceId: 'a-process-that-died' }));
  stateTracker.savePlacementIntents(intents, EXCHANGE, PAIR);
};

describe('placement intent store (state-tracker)', () => {
  it('persists an intent as dispatching, owned by this process', () => {
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy', price: 100, size: 0.5 });

    assert.ok(fs.existsSync(intentsFile()), 'the intent file exists immediately');
    const [persisted] = readIntents();
    assert.equal(persisted.id, intent.id);
    assert.equal(persisted.status, stateTracker.PLACEMENT_INTENT_STATUS.DISPATCHING);
    assert.equal(persisted.instanceId, stateTracker.PROCESS_INSTANCE_ID);
    assert.equal(persisted.action, 'entry_bid');
  });

  it('does not block on this process\'s own in-flight dispatch', () => {
    stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'take_profit', side: 'sell' });
    assert.deepEqual(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR), [],
      'a concurrent placement in the same process must not be blocked by an in-flight sibling');
  });

  it('blocks on a dispatching intent left behind by a dead process (restart)', () => {
    stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy' });
    simulateRestart();

    const blocking = stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].status, stateTracker.PLACEMENT_INTENT_STATUS.DISPATCHING);
  });

  it('blocks on an unresolved intent regardless of which process wrote it', () => {
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy' });
    stateTracker.markPlacementIntentUnresolved(EXCHANGE, PAIR, intent.id, { clientOrderId: 'coid-1', reason: 'lookup failed' });

    const blocking = stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].clientOrderId, 'coid-1');
  });

  it('resolves exactly once — a second resolve is a no-op', () => {
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy' });

    assert.equal(stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, intent.id)?.id, intent.id);
    assert.equal(stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, intent.id), null,
      'whoever removes the row owns the recovery; a duplicate call must find nothing');
    assert.deepEqual(readIntents(), []);
  });

  it('scopes intents per fund — one fund never blocks another', () => {
    stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy' });
    simulateRestart();

    assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 1);
    assert.deepEqual(stateTracker.getBlockingPlacementIntents(EXCHANGE, 'ETH-USDC'), []);
  });

  it('fails closed on a corrupt intent file instead of reading it as empty', () => {
    fs.mkdirSync(path.dirname(intentsFile()), { recursive: true });
    fs.writeFileSync(intentsFile(), '{ not json');

    assert.throws(() => readIntents(), /corrupted or unreadable/);
    const blocking = stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR);
    assert.equal(blocking.length, 1, 'an unreadable file must block placements, never wave them through');
    assert.equal(blocking[0].id, 'unreadable-intent-file');
  });

  it('annotates unresolved intents for the operator with a recovery instruction', () => {
    const withId = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy', size: 0.5, price: 100 });
    stateTracker.markPlacementIntentUnresolved(EXCHANGE, PAIR, withId.id, { clientOrderId: 'coid-7', reason: 'lookup failed' });
    const noId = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'take_profit', side: 'sell', size: 0.4, price: 120 });

    const described = stateTracker.describePlacementIntents(EXCHANGE, PAIR);
    const unresolved = described.find(i => i.id === withId.id);
    const dispatching = described.find(i => i.id === noId.id);

    assert.equal(unresolved.needsAttention, true);
    assert.match(unresolved.recoveryHint, /coid-7/);
    assert.equal(dispatching.needsAttention, false, 'a freshly dispatched placement is reported but not flagged');
    assert.match(dispatching.recoveryHint, /No client order id/);
  });

  it('flags a crash-leftover dispatch for the operator immediately, not after a grace period', () => {
    stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy' });
    simulateRestart();

    // A crash-and-restart can complete in under a second, so an age-based rule
    // would wave through exactly the case that matters.
    const [described] = stateTracker.describePlacementIntents(EXCHANGE, PAIR);
    assert.equal(described.needsAttention, true);
    assert.ok(described.ageMs < 60_000, 'flagged well inside any plausible grace period');
  });
});

describe('ladder placement halts on an unresolved rung', () => {
  it('stops the ladder instead of reporting the rung as an ordinary failure', async () => {
    const placed = [];
    const adapter = {
      name: EXCHANGE,
      placeLimitBuy: async (_product, qty, price) => {
        placed.push(price);
        if (placed.length === 1) return { success: true, orderId: 'rung-1' };
        // No findOrderByClientOrderId on this adapter — unreconcilable.
        throw unknownError('coid-rung-2');
      },
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    };
    const executor = createOrderExecutor(EXCHANGE, {}, adapter, PRODUCT, {}, PAIR);

    const result = await executor.placeLadderOrders([
      { index: 0, price: 100, sizeUsdc: 50, assetQty: 0.5 },
      { index: 1, price: 99, sizeUsdc: 50, assetQty: 0.5 },
      { index: 2, price: 98, sizeUsdc: 50, assetQty: 0.5 },
    ]);

    assert.equal(result.pending, true, 'a thrown reconcile must not be folded into a clean failure');
    assert.equal(result.orders.length, 1);
    assert.equal(placed.length, 2, 'the ladder stops at the unresolved rung — later rungs are never submitted');
    assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 1);
  });
});

describe('placeWithUnknownReconcile — intent is durable before dispatch', () => {
  it('persists the intent BEFORE the placement leaves the process', async () => {
    let intentsAtDispatch = null;
    const adapter = { name: EXCHANGE };

    const result = await placeWithUnknownReconcile(adapter, PRODUCT, async () => {
      intentsAtDispatch = readIntents();
      return { success: true, orderId: 'ok-1' };
    }, scope());

    assert.equal(result.success, true);
    assert.equal(intentsAtDispatch.length, 1, 'a crash in the dispatch window must find a record already on disk');
    assert.equal(intentsAtDispatch[0].action, 'entry_bid');
    assert.deepEqual(readIntents(), [], 'a definitive success clears the intent');
  });

  it('does not submit the order when the intent cannot be persisted', async () => {
    let submitted = 0;
    mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: no space left on device'); });

    const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => {
      submitted++;
      return { success: true, orderId: 'must-not-happen' };
    }, scope());

    assert.equal(submitted, 0, 'an order dispatched with no durable record is the exact failure this guards');
    assert.equal(result.success, false);
    assert.equal(result.intentPersistenceFailed, true);
  });

  it('clears the intent on a definitive exchange rejection', async () => {
    const rejection = Object.assign(new Error('INVALID_PRICE'), { status: 'error' });

    await assert.rejects(
      () => placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => { throw rejection; }, scope()),
      /INVALID_PRICE/,
    );
    assert.deepEqual(readIntents(), [], 'the exchange never took the order — the fund must not stay blocked');
  });

  it('clears the intent when the exchange positively never received the order', async () => {
    const adapter = { name: EXCHANGE, findOrderByClientOrderId: async () => null };

    const result = await placeWithUnknownReconcile(adapter, PRODUCT, async () => { throw unknownError('coid-absent'); }, {
      ...scope(), retryDelaysMs: [],
    });

    assert.equal(result.success, false);
    assert.notEqual(result.pending, true, 'a positive not-found is definitive, not pending');
    assert.deepEqual(readIntents(), []);
  });

  it('clears the intent when an ambiguous placement is reconciled and adopted', async () => {
    let submissions = 0;
    const adapter = {
      name: EXCHANGE,
      findOrderByClientOrderId: async () => ({ orderId: 'real-1', status: 'OPEN' }),
    };

    const result = await placeWithUnknownReconcile(adapter, PRODUCT, async () => {
      submissions++;
      throw unknownError('coid-live');
    }, { ...scope(), retryDelaysMs: [] });

    assert.equal(submissions, 1, 'the placement thunk is never re-invoked');
    assert.equal(result.success, true);
    assert.equal(result.reconciled, true);
    assert.deepEqual(readIntents(), [], 'adoption is a definitive outcome');
  });
});

describe('placeWithUnknownReconcile — unreconcilable outcomes stay pending', () => {
  it('holds the intent pending when there is no way to reconcile', async () => {
    // No findOrderByClientOrderId — the adapter cannot look the order up at all.
    const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => { throw unknownError('coid-2'); }, scope());

    assert.equal(result.success, false);
    assert.equal(result.pending, true, 'must NOT be an ordinary failure — that shape means "safe to re-place"');

    const [persisted] = readIntents();
    assert.equal(persisted.status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);
    assert.equal(persisted.clientOrderId, 'coid-2');
  });

  it('holds the intent pending when the reconcile lookup itself fails', async () => {
    const adapter = {
      name: EXCHANGE,
      findOrderByClientOrderId: async () => { throw new Error('429 rate limited'); },
    };

    const result = await placeWithUnknownReconcile(adapter, PRODUCT, async () => { throw unknownError('coid-3'); }, {
      ...scope(), retryDelaysMs: [],
    });

    assert.equal(result.pending, true, '"we could not check" is never "it isn\'t there"');
    assert.equal(readIntents()[0].status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);
  });

  it('refuses every later placement on the fund while an intent is unresolved', async () => {
    await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => { throw unknownError('coid-4'); }, scope());

    // Second tick: a different action on the same fund must also be refused —
    // the unknown order may be holding this fund's capital either way.
    let submitted = 0;
    const retry = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => {
      submitted++;
      return { success: true, orderId: 'second-order' };
    }, scope('take_profit', 'sell'));

    assert.equal(submitted, 0, 'repeated ticks must not submit a replacement');
    assert.equal(retry.success, false);
    assert.equal(retry.pending, true);
    assert.ok(retry.blockedByIntentId, 'the refusal names the intent that must be reconciled');
    assert.equal(readIntents().length, 1, 'a refused placement adds no second intent row');
  });

  it('keeps refusing after a restart (the guard lives on disk, not in memory)', async () => {
    let submitted = 0;
    await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => {
      submitted++;
      throw unknownError('coid-5');
    }, scope());
    assert.equal(submitted, 1);

    simulateRestart();

    const afterRestart = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => {
      submitted++;
      return { success: true, orderId: 'post-restart' };
    }, scope());

    assert.equal(submitted, 1, 'a restarted process must not re-place against an unresolved intent');
    assert.equal(afterRestart.pending, true);
  });

  it('a crash inside the dispatch window blocks the restarted process', async () => {
    // Simulate the crash: the intent is written, the POST goes out, and the
    // process dies before any response is processed.
    stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'entry_bid', side: 'buy', price: 100, size: 0.5 });
    simulateRestart();

    let submitted = 0;
    const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => {
      submitted++;
      return { success: true, orderId: 'would-double-spend' };
    }, scope());

    assert.equal(submitted, 0);
    assert.equal(result.pending, true);
  });

  it('resumes placing once the intent is resolved', async () => {
    await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => { throw unknownError('coid-6'); }, scope());
    const [blocked] = readIntents();
    stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, blocked.id);

    const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => ({ success: true, orderId: 'resumed-1' }), scope());
    assert.equal(result.success, true);
    assert.equal(result.orderId, 'resumed-1');
  });

  it('leaves unscoped placements (no fund) on the legacy path', async () => {
    const result = await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => ({ success: true, orderId: 'unscoped' }));
    assert.equal(result.orderId, 'unscoped');
    assert.equal(fs.existsSync(intentsFile()), false, 'no fund scope, no intent file');
  });
});

describe('operator adoption is exactly once', () => {
  const executorFor = () => createOrderExecutor(EXCHANGE, {}, { name: EXCHANGE }, PRODUCT, {}, PAIR);

  it('adopts an entry order into pending tracking, then refuses to adopt it twice', () => {
    const executor = executorFor();
    const intent = { action: 'entry_bid', price: 100, size: 0.5, sizeUsdc: 50, createdAt: 1000 };

    const first = executor.adoptPlacement({ orderId: 'adopted-1' }, intent);
    assert.equal(first.tracked, true);
    assert.equal(executor.getPendingCounts().entries, 1);

    const second = executor.adoptPlacement({ orderId: 'adopted-1' }, intent);
    assert.equal(second.tracked, false, 'a duplicate adoption would double-count the fill');
    assert.equal(executor.getPendingCounts().entries, 1);
  });

  it('adopts a body TP through the same tracking a normal placement uses', () => {
    const executor = executorFor();
    const result = executor.adoptPlacement({ orderId: 'tp-9' }, { action: 'body_tp', bodyId: 'body-1', price: 120, size: 0.4 });

    assert.equal(result.tracked, true);
    assert.equal(executor.isBodyTpOrder('tp-9'), true);
    assert.equal(executor.getBodyByTpOrderId('tp-9')?.bodyId, 'body-1');
  });

  it('refuses to track an intent whose action maps to no order type', () => {
    const executor = executorFor();
    const result = executor.adoptPlacement({ orderId: 'x-1' }, { action: 'dca_buy' });
    assert.equal(result.tracked, false);
    assert.equal(executor.getPendingCounts().entries, 0);
  });
});

describe('DCA operator reconcile', () => {
  const dcaScope = () => ({ intent: { exchange: EXCHANGE, action: 'dca_buy', side: 'buy', sizeUsdc: 25 } });

  // dca-engine resolves its fund by the exchange's default pair, which in a
  // fresh tmp dir is 'default'.
  const dcaIntents = () => stateTracker.loadPlacementIntents(EXCHANGE);

  it('discards an intent the operator has verified, unblocking the cycle', async () => {
    const dcaEngine = require('../src/dca-engine');
    await placeWithUnknownReconcile({ name: EXCHANGE }, PRODUCT, async () => { throw unknownError('coid-dca'); }, dcaScope());
    const [intent] = dcaIntents();
    assert.equal(intent.status, stateTracker.PLACEMENT_INTENT_STATUS.UNRESOLVED);

    const result = await dcaEngine.reconcilePlacementIntent(EXCHANGE, intent.id, 'discard');
    assert.equal(result.success, true);
    assert.deepEqual(dcaIntents(), []);

    const again = await dcaEngine.reconcilePlacementIntent(EXCHANGE, intent.id, 'discard');
    assert.equal(again.success, false, 'a double-clicked discard must not report a second success');
  });

  it('rejects an unknown reconcile action', async () => {
    const dcaEngine = require('../src/dca-engine');
    const result = await dcaEngine.reconcilePlacementIntent(EXCHANGE, 'whatever', 'delete-everything');
    assert.equal(result.success, false);
    assert.match(result.error, /Unknown reconcile action/);
  });
});
