// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOrderExecutor } = require('../src/order-executor');

// Minimal config and adapter scaffolding. Only the surface area exercised
// by these tests is filled in; everything else defaults harmlessly.
const baseConfig = () => ({
  orderStaleMs: 60_000,
  cancelRateLimitMs: 0,
});

/**
 * Build an adapter whose getOrder() returns the supplied status. Other
 * methods are stubs that throw to flag accidental real-API calls.
 */
const makeAdapter = (getOrderResult) => ({
  getOrder: async () => getOrderResult,
  cancelOrder: async () => { throw new Error('cancelOrder should not be called'); },
  placeLimitBuy: async () => { throw new Error('placeLimitBuy should not be called'); },
  placeLimitSell: async () => { throw new Error('placeLimitSell should not be called'); },
  getOrderFills: async () => [],
});

describe('checkPendingOrderFills — CANCELLED with partial fills', () => {
  it('routes partial fills through onFillDetected before clearing', async () => {
    // Models the leak pattern: a TP order cancels (externally or via Gemini
    // heartbeat timeout) with some of its size already filled. Without the
    // catch-up call, those fills are silently dropped from the ledger.
    const captured = [];
    const adapter = makeAdapter({ status: 'CANCELLED', filledSize: 0.05, completionPercentage: 50, side: 'SELL' });
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    exec.restorePendingOrder('order-abc', {
      type: 'body_tp',
      price: 2400,
      size: 0.1,
      sizeUsdc: 240,
      placedAt: Date.now(),
    });

    const result = await exec.checkPendingOrderFills();

    assert.equal(result.cancelled, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].orderId, 'order-abc');
    assert.equal(captured[0].status.isPartialFill, true);
    assert.equal(captured[0].status.filledSize, 0.05);
    assert.ok(captured[0].status.placedAt > 0, 'placedAt should be propagated');
  });

  it('reports polled>0 when a status round-trip succeeds, and polled=0 when getOrder fails (issue #110 M6)', async () => {
    // The engine gates healthMonitor.recordOrderUpdate() on result.polled so a
    // dead order-status REST path can't masquerade as a live order feed.
    const okAdapter = makeAdapter({ status: 'OPEN', filledSize: 0, completionPercentage: 0, side: 'SELL' });
    const okExec = createOrderExecutor('gemini', baseConfig(), okAdapter, 'ETH-USD', {});
    okExec.restorePendingOrder('o1', { type: 'body_tp', price: 2400, size: 0.1, sizeUsdc: 240, placedAt: Date.now() });
    const okResult = await okExec.checkPendingOrderFills();
    assert.equal(okResult.polled, 1, 'a successful getOrder counts as a poll');

    // getOrder rejects → swallowed to null → no successful poll → polled=0
    const deadAdapter = {
      getOrder: async () => { throw new Error('REST down'); },
      cancelOrder: async () => { throw new Error('nope'); },
      placeLimitBuy: async () => { throw new Error('nope'); },
      placeLimitSell: async () => { throw new Error('nope'); },
      getOrderFills: async () => [],
    };
    const deadExec = createOrderExecutor('gemini', baseConfig(), deadAdapter, 'ETH-USD', {});
    deadExec.restorePendingOrder('o2', { type: 'body_tp', price: 2400, size: 0.1, sizeUsdc: 240, placedAt: Date.now() });
    const deadResult = await deadExec.checkPendingOrderFills();
    assert.equal(deadResult.polled, 0, 'a fully-failing order feed must report zero successful polls');

    // No pending orders → zero round-trips → polled=0
    const emptyExec = createOrderExecutor('gemini', baseConfig(), okAdapter, 'ETH-USD', {});
    const emptyResult = await emptyExec.checkPendingOrderFills();
    assert.equal(emptyResult.polled, 0, 'no pending orders means no liveness signal');
  });

  it('skips onFillDetected when filledSize is zero', async () => {
    // Cancellation with no fills is the common case — clean cancel, no
    // ledger work needed. Don't fire onFillDetected to avoid spurious
    // processing.
    const captured = [];
    const adapter = makeAdapter({ status: 'CANCELLED', filledSize: 0, completionPercentage: 0, side: 'SELL' });
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    exec.restorePendingOrder('order-empty', {
      type: 'body_tp',
      price: 2400,
      size: 0.1,
      sizeUsdc: 240,
      placedAt: Date.now(),
    });

    const result = await exec.checkPendingOrderFills();

    assert.equal(result.cancelled, 1);
    assert.equal(captured.length, 0);
  });

  it('uses partialFillTracker high-water mark when status filledSize is missing', async () => {
    // Some adapters can transition straight from PARTIALLY_FILLED to CANCELLED
    // and the cancel-status response may not carry the cumulative filledSize.
    // The executor's partialFillTracker has the last-known size from a prior
    // PARTIALLY_FILLED poll — use it as the fallback so partials aren't lost.
    const captured = [];
    let callCount = 0;
    const adapter = {
      getOrder: async () => {
        callCount++;
        // First poll: partial. Second poll: cancelled with no filledSize.
        return callCount === 1
          ? { status: 'PARTIALLY_FILLED', filledSize: 0.03, completionPercentage: 30, side: 'SELL' }
          : { status: 'CANCELLED', filledSize: 0, completionPercentage: 0, side: 'SELL' };
      },
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    exec.restorePendingOrder('order-tracker', {
      type: 'body_tp',
      price: 2400,
      size: 0.1,
      sizeUsdc: 240,
      placedAt: Date.now(),
    });

    await exec.checkPendingOrderFills(); // first poll → partial, sets tracker
    assert.equal(captured.length, 1, 'first poll fires partial-fill callback');
    assert.equal(captured[0].status.isPartialFill, true);
    assert.equal(captured[0].status.filledSize, 0.03);

    await exec.checkPendingOrderFills(); // second poll → cancelled, should catch up using tracker
    assert.equal(captured.length, 2, 'second poll fires catch-up partial-fill callback');
    assert.equal(captured[1].status.isPartialFill, true);
    assert.equal(captured[1].status.filledSize, 0.03, 'falls back to tracker value');
  });
});

describe('refreshStaleOrders — CANCELLED with partial fills', () => {
  it('routes partial fills through onFillDetected before clearing', async () => {
    const captured = [];
    const adapter = makeAdapter({ status: 'CANCELLED', filledSize: 0.04, completionPercentage: 40, side: 'BUY' });
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    // Place an order that is older than staleOrderMs so refreshStaleOrders
    // actually inspects it.
    exec.restorePendingOrder('order-stale', {
      type: 'entry',
      price: 2300,
      size: 0.1,
      sizeUsdc: 230,
      placedAt: Date.now() - 10 * 60_000, // 10 minutes ago, stale
    });

    const refreshed = await exec.refreshStaleOrders();

    assert.equal(refreshed, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].orderId, 'order-stale');
    assert.equal(captured[0].status.isPartialFill, true);
    assert.equal(captured[0].status.filledSize, 0.04);
  });

  it('skips onFillDetected when filledSize is zero', async () => {
    const captured = [];
    const adapter = makeAdapter({ status: 'CANCELLED', filledSize: 0, completionPercentage: 0, side: 'BUY' });
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    exec.restorePendingOrder('order-clean', {
      type: 'entry',
      price: 2300,
      size: 0.1,
      sizeUsdc: 230,
      placedAt: Date.now() - 10 * 60_000,
    });

    const refreshed = await exec.refreshStaleOrders();

    assert.equal(refreshed, 1);
    assert.equal(captured.length, 0);
  });
});

describe('refreshStaleOrders — refused cancel on an OPEN stale entry (issue #674)', () => {
  const restoreStaleEntry = (exec, orderId) =>
    exec.restorePendingOrder(orderId, {
      type: 'entry', price: 2300, size: 0.1, sizeUsdc: 230,
      placedAt: Date.now() - 10 * 60_000, // stale
    });

  it('routes a fill through onFillDetected — not onEntryCancelled — when the OPEN-sweep cancel is refused because the order already filled', async () => {
    const captured = [];
    const entryCancelled = [];
    let getOrderCalls = 0;
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => {
        getOrderCalls++;
        // First read is refreshStaleOrders' own top-of-loop snapshot (still
        // OPEN, so it decides to cancel). Every read after that (inside
        // safeCancelOrder's refused-cancel check) sees the fill.
        return getOrderCalls === 1
          ? { status: 'OPEN', filledSize: 0, completionPercentage: 0, side: 'BUY' }
          : { status: 'FILLED', filledSize: 0.1, completionPercentage: 100, side: 'BUY', filledValue: 230, averageFilledPrice: 2300, totalFees: 0.05 };
      },
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });
    restoreStaleEntry(exec, 'order-refused-filled');

    const refreshed = await exec.refreshStaleOrders();

    assert.equal(refreshed, 1);
    assert.equal(captured.length, 1, 'the fill is routed through onFillDetected');
    assert.equal(captured[0].orderId, 'order-refused-filled');
    assert.equal(captured[0].status.side, 'buy');
    assert.equal(captured[0].status.filledSize, 0.1);
    assert.deepEqual(entryCancelled, [], 'a filled order is not an entry-cancellation');
    assert.equal(exec.getPendingCounts().entries, 0);
  });

  it('clears the partialFillTracker entry on a refused-because-filled cancel, not just pendingOrders (issue #674 codex review finding)', async () => {
    // Reuse the SAME orderId across two unrelated episodes to detect a leak:
    // seed partialFillTracker via a PARTIALLY_FILLED poll, let the
    // refused-cancel-because-filled branch run (which must clear the
    // tracker as well as pendingOrders), then restore a fresh order under
    // the same id and confirm a later clean cancel does NOT fall back to
    // the stale high-water mark from the first episode.
    const orderId = 'order-tracker-reuse';
    let phase = 'seed';
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => {
        if (phase === 'seed') return { status: 'PARTIALLY_FILLED', filledSize: 0.05, completionPercentage: 50, side: 'BUY' };
        if (phase === 'refresh-open') return { status: 'OPEN', filledSize: 0, completionPercentage: 0, side: 'BUY' };
        if (phase === 'refresh-filled') return { status: 'FILLED', filledSize: 0.1, completionPercentage: 100, side: 'BUY', filledValue: 230, averageFilledPrice: 2300, totalFees: 0.05 };
        return { status: 'CANCELLED', filledSize: 0, side: 'BUY' }; // phase === 'verify'
      },
    };
    const captured = [];
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId2, status) => captured.push({ orderId: orderId2, status }),
    });

    // 1. Seed the tracker with a partial-fill poll.
    exec.restorePendingOrder(orderId, { type: 'entry', price: 2300, size: 0.1, sizeUsdc: 230, placedAt: Date.now() - 10 * 60_000 });
    await exec.checkPendingOrderFills();
    assert.equal(captured.length, 1, 'seed poll fires the partial-fill callback');

    // 2. Refused-cancel-because-filled: first read OPEN (decide to cancel),
    // then FILLED (safeCancelOrder's refused-check) — lands in refreshStaleOrders'
    // cancelResult.filled branch, which must also clear partialFillTracker.
    exec.restorePendingOrder(orderId, { type: 'entry', price: 2300, size: 0.1, sizeUsdc: 230, placedAt: Date.now() - 10 * 60_000 });
    phase = 'refresh-open';
    let getOrderCallsInPhase = 0;
    adapter.getOrder = async () => {
      getOrderCallsInPhase++;
      return getOrderCallsInPhase === 1
        ? { status: 'OPEN', filledSize: 0, completionPercentage: 0, side: 'BUY' }
        : { status: 'FILLED', filledSize: 0.1, completionPercentage: 100, side: 'BUY', filledValue: 230, averageFilledPrice: 2300, totalFees: 0.05 };
    };
    await exec.refreshStaleOrders();
    assert.equal(captured.length, 2, 'the refused-because-filled cancel also fires onFillDetected');

    // 3. Restore a FRESH order under the same id and force a clean cancel
    // with filledSize 0 — if the tracker leaked the 0.05 from step 1, this
    // would incorrectly report a partial fill.
    exec.restorePendingOrder(orderId, { type: 'entry', price: 2300, size: 0.1, sizeUsdc: 230, placedAt: Date.now() - 10 * 60_000 });
    phase = 'verify';
    adapter.getOrder = async () => ({ status: 'CANCELLED', filledSize: 0, side: 'BUY' });
    await exec.checkPendingOrderFills();

    assert.equal(captured.length, 2, 'no stale partialFillTracker leak — the clean cancel must not fire onFillDetected a third time');
  });

  it('keeps the order tracked when the cancel is neither filled nor cancelled (ack\'d but never settled)', async () => {
    // cancelOrder is refused and getOrder never converges to a terminal
    // state — safeCancelOrder exhausts its ack-retry budget and returns
    // {cancelled:false, filled:false}. The old raw-cancel code would have
    // dropped the order from tracking unconditionally; it must now stay
    // tracked for the polling backstop instead.
    const captured = [];
    const entryCancelled = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'OPEN', filledSize: 0, completionPercentage: 0, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });
    restoreStaleEntry(exec, 'order-refused-unresolved');

    const refreshed = await exec.refreshStaleOrders();

    assert.equal(refreshed, 0, 'an unresolved cancel is not counted as refreshed');
    assert.equal(captured.length, 0);
    assert.deepEqual(entryCancelled, []);
    assert.equal(exec.getPendingCounts().entries, 1, 'order stays tracked for the polling backstop');
  });
});

describe('cancelAllEntries — refused-cancel fill handling (issue #209 A)', () => {
  const restoreEntry = (exec, orderId, placedAt = Date.now()) =>
    exec.restorePendingOrder(orderId, { type: 'entry', price: 2300, size: 0.1, sizeUsdc: 230, placedAt });

  it('routes a fill through onFillDetected and does NOT count a refused cancel as cancelled', async () => {
    // Exchange refuses the cancel (resolves {success:false}) because the order
    // already filled. Without inspecting result.value.success the old code
    // counted this as cancelled and dropped tracking, so the polling backstop
    // never saw the fill (invisible asset on Gemini).
    const captured = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'FILLED', completionPercentage: 100, filledSize: 0.1, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    restoreEntry(exec, 'entry-filled');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 0, 'a filled order is not a cancel');
    assert.equal(captured.length, 1, 'the fill is routed through onFillDetected');
    assert.equal(captured[0].orderId, 'entry-filled');
    assert.ok(captured[0].status.placedAt > 0, 'placedAt propagated for fill-time');
    assert.equal(exec.getPendingCounts().entries, 0, 'order dropped from tracking after fill routed');
  });

  it('keeps a still-OPEN order tracked when the cancel is refused (does not silently delete)', async () => {
    // Refused cancel but the order is still live on the exchange. The old code
    // deleted it anyway; now we keep it so checkPendingOrderFills can still
    // catch a later fill.
    const captured = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'OPEN', completionPercentage: 0, filledSize: 0, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    restoreEntry(exec, 'entry-open');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 0);
    assert.equal(captured.length, 0);
    assert.equal(exec.getPendingCounts().entries, 1, 'still-open order remains tracked for the polling backstop');
  });

  it('routes partial fills when a refused cancel resolves to CANCELLED, and counts it cancelled', async () => {
    const captured = [];
    const entryCancelled = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'CANCELLED', completionPercentage: 20, filledSize: 0.02, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });
    restoreEntry(exec, 'entry-partial');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 1, 'a genuine CANCELLED counts as cancelled');
    assert.equal(captured.length, 1, 'partial fill routed before dropping tracking');
    assert.equal(captured[0].status.filledSize, 0.02);
    assert.equal(captured[0].status.isPartialFill, true);
    assert.deepEqual(entryCancelled, ['entry-partial'], 'entry-cancel callback fires');
    assert.equal(exec.getPendingCounts().entries, 0);
  });

  it('counts a genuinely-successful cancel and drops tracking', async () => {
    // A successful cancel ack ({success:true}) is now verified with a
    // getOrder check (issue #674 Fix step 1 — no adapter's cancelOrder
    // response carries filledSize, so the ack alone can't rule out a partial
    // fill). A getOrder failure here must not block the clean-cancel path —
    // fall back to trusting the ack, matching every other cancel path's
    // "can't verify, don't block on it" fallback.
    const adapter = {
      cancelOrder: async () => ({ success: true }),
      getOrder: async () => { throw new Error('network blip on the post-cancel check'); },
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {});
    restoreEntry(exec, 'entry-clean-1');
    restoreEntry(exec, 'entry-clean-2');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 2);
    assert.equal(exec.getPendingCounts().entries, 0);
  });

  it('routes a partial fill through onFillDetected when a SUCCESSFUL cancel carries a fill (issue #674 Fix step 1 / PR #712 follow-up)', async () => {
    // The exchange acknowledges the cancel ({success:true}) — the `!refused`
    // path — but a rung partially filled in the race window right before the
    // cancel took. No adapter's cancelOrder response carries filledSize, so
    // this can only be discovered via a follow-up getOrder call; the old code
    // never made one and just deleted the order, silently losing the fill.
    const captured = [];
    const entryCancelled = [];
    const adapter = {
      cancelOrder: async () => ({ success: true }),
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, filledValue: 9.2, averageFilledPrice: 2300, totalFees: 0.01, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });
    restoreEntry(exec, 'entry-success-partial');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 1, 'a successful cancel with a partial fill still counts as cancelled');
    assert.equal(captured.length, 1, 'the fill is routed through onFillDetected exactly once');
    assert.equal(captured[0].orderId, 'entry-success-partial');
    assert.equal(captured[0].status.isPartialFill, true);
    assert.equal(captured[0].status.filledSize, 0.004);
    assert.deepEqual(entryCancelled, ['entry-success-partial'], 'entry-cancel callback fires via the shared handler');
    assert.equal(exec.getPendingCounts().entries, 0, 'order dropped from tracking after the fill was routed');
  });

  it('handles a thrown cancel by checking the order rather than blindly deleting', async () => {
    // A rejected cancel promise where the order turns out to have filled must
    // still route the fill.
    const captured = [];
    const adapter = {
      cancelOrder: async () => { throw new Error('network blip'); },
      getOrder: async () => ({ status: 'FILLED', completionPercentage: 100, filledSize: 0.1, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    restoreEntry(exec, 'entry-threw');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].orderId, 'entry-threw');
    assert.equal(exec.getPendingCounts().entries, 0);
  });
});

describe('getPendingCounts — ladder_entry visibility (issue #107 M5)', () => {
  const adapter = makeAdapter({ status: 'OPEN' });

  it('counts ladder_entry orders separately from entry orders', () => {
    const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {});
    exec.restorePendingOrder('e-1', { type: 'entry', price: 100, size: 1, sizeUsdc: 100, placedAt: Date.now() });
    exec.restorePendingOrder('l-1', { type: 'ladder_entry', price: 99, size: 1, sizeUsdc: 99, placedAt: Date.now() });
    exec.restorePendingOrder('l-2', { type: 'ladder_entry', price: 98, size: 1, sizeUsdc: 98, placedAt: Date.now() });
    exec.restorePendingOrder('tp-1', { type: 'body_tp', price: 110, size: 1, sizeUsdc: 110, placedAt: Date.now() });

    const counts = exec.getPendingCounts();
    assert.equal(counts.entries, 1);
    assert.equal(counts.ladderEntries, 2, 'ladder rungs must be counted so reactive entries can detect them');
    assert.equal(counts.bodies, 1);
    assert.equal(counts.total, 4);
  });

  it('reports zero ladderEntries when only reactive entries rest', () => {
    const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {});
    exec.restorePendingOrder('e-1', { type: 'entry', price: 100, size: 1, sizeUsdc: 100, placedAt: Date.now() });
    const counts = exec.getPendingCounts();
    assert.equal(counts.entries, 1);
    assert.equal(counts.ladderEntries, 0);
  });
});

describe('safeCancelOrder — surfaces cancelled-with-partials filledSize (issue #227)', () => {
  // safeCancelOrder is internal; exercise it via cancelBodyTpOrder / cancelTpOrder.
  // The `cancelOrder` returns {success:false} + `getOrder` reporting a terminal
  // CANCELLED status takes the fast reject-path branch (no poll timers).
  const makeCancelAdapter = (getOrderResult) => ({
    cancelOrder: async () => ({ success: false }),
    getOrder: async () => getOrderResult,
    placeLimitBuy: async () => { throw new Error('placeLimitBuy should not be called'); },
    placeLimitSell: async () => { throw new Error('placeLimitSell should not be called'); },
    getOrderFills: async () => [],
  });

  it('cancelBodyTpOrder surfaces the partial sold qty on a cancelled-with-partials TP', async () => {
    const adapter = makeCancelAdapter({ status: 'CANCELLED', filledSize: 0.003, side: 'SELL' });
    const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {});
    exec.restoreBodyTpOrder('body-1', 'tp-1', 0.01, 51000);

    const result = await exec.cancelBodyTpOrder('body-1', 'tp-1');

    assert.equal(result.cancelled, true, 'a partially-filled-then-cancelled order still reports cancelled');
    assert.equal(result.filled, false);
    assert.equal(result.filledSize, 0.003, 'the sold quantity is surfaced directly');
  });

  for (const [status, expected] of [
    ['CANCELLED', { cancelled: true, filled: false, filledSize: 0.003, filledValue: 153, averageFilledPrice: 51000, totalFees: 0.02 }],
    ['FILLED', { cancelled: false, filled: true, filledSize: 0.003 }],
    ['OPEN', { cancelled: false, filled: false, filledSize: 0 }],
  ]) {
    it(`preserves the exact ${status} result and body-specific tracking`, async () => {
      const captured = [];
      const adapter = makeCancelAdapter({ status, filledSize: 0.003, filledValue: 153, averageFilledPrice: 51000, totalFees: 0.02, side: 'SELL' });
      const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {
        onFillDetected: (id) => captured.push(id),
      });
      exec.restoreBodyTpOrder('body-shape', 'tp-shape', 0.01, 51000);
      assert.deepEqual(await exec.cancelBodyTpOrder('body-shape'), expected);
      assert.equal(exec.isBodyTpOrder('tp-shape'), status === 'OPEN');
      assert.equal(exec.getPendingOrdersList().some(o => o.orderId === 'tp-shape'), status !== 'CANCELLED');
      if (status !== 'OPEN') {
        assert.deepEqual(await exec.cancelBodyTpOrder('body-shape'), { cancelled: true, filled: false, filledSize: 0 });
        await exec.checkPendingOrderFills();
        assert.deepEqual(captured, status === 'FILLED' ? ['tp-shape'] : []);
      }
    });
  }

  it('cancelBodyTpOrder reports filledSize 0 on a clean cancel (guard is specific)', async () => {
    const adapter = makeCancelAdapter({ status: 'CANCELLED', filledSize: 0, side: 'SELL' });
    const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {});
    exec.restoreBodyTpOrder('body-2', 'tp-2', 0.01, 51000);

    const result = await exec.cancelBodyTpOrder('body-2', 'tp-2');

    assert.equal(result.cancelled, true);
    assert.equal(result.filledSize, 0, 'a clean cancel surfaces no partial');
  });

  it('cancelBodyTpOrder falls back to the partialFillTracker high-water mark', async () => {
    // Gemini can jump PARTIALLY_FILLED → CANCELLED with the cancel-status
    // response omitting the cumulative filledSize. A prior fill-check poll set
    // the tracker; safeCancelOrder must fall back to it.
    let call = 0;
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => {
        call++;
        // First call: the fill-check poll observes a partial (seeds the tracker).
        // Second call: the cancel's status read reports CANCELLED with no size.
        return call === 1
          ? { status: 'PARTIALLY_FILLED', filledSize: 0.004, completionPercentage: 40, side: 'SELL' }
          : { status: 'CANCELLED', filledSize: 0, side: 'SELL' };
      },
      placeLimitBuy: async () => { throw new Error('nope'); },
      placeLimitSell: async () => { throw new Error('nope'); },
      getOrderFills: async () => [],
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {});
    exec.restoreBodyTpOrder('body-3', 'tp-3', 0.02, 2400);

    await exec.checkPendingOrderFills(); // seeds partialFillTracker via the partial poll
    const result = await exec.cancelBodyTpOrder('body-3', 'tp-3');

    assert.equal(result.cancelled, true);
    assert.equal(result.filledSize, 0.004, 'falls back to the tracked high-water mark when status omits it');
  });
});

describe('order-executor placement paths — unknown-outcome reconciliation (issue #226 follow-up)', () => {
  // Coinbase throws this exact shape when a placement POST network-errors
  // after possibly reaching the exchange (src/adapters/coinbase/api.js).
  const unknownError = (clientOrderId) =>
    Object.assign(new Error('unknown order outcome'), { status: 'unknown', unknownOutcome: true, clientOrderId });

  const configFor = (over = {}) => ({
    entryOffsetBps: 10,
    entryMaxRetries: 3,
    tpUpdateThresholdPct: 0.5,
    orderStaleMs: 30000,
    cancelRateLimitMs: 0,
    maxOpenOrders: 20,
    ...over,
  });

  it('placeEntryBid adopts a reconciled order instead of retrying into a double-place', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitBuy: async () => { placeCalls++; throw unknownError('coid-entry-1'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-entry-1', status: 'OPEN' }),
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }), // immediate-cancel verify check
    };
    const exec = createOrderExecutor('coinbase', configFor(), adapter, 'BTC-USDC');

    const result = await exec.placeEntryBid(1000, 100_000, 100_010);

    assert.equal(placeCalls, 1, 'must NOT re-place a possibly-executed entry bid');
    assert.equal(result.success, true);
    assert.equal(result.orderId, 'real-entry-1');
  });

  it('placeTakeProfitOrder adopts a reconciled order', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-tp-1'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-tp-1', status: 'OPEN' }),
    };
    const exec = createOrderExecutor('coinbase', configFor(), adapter, 'BTC-USDC');

    const result = await exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });

    assert.equal(placeCalls, 1);
    assert.equal(result.success, true);
    assert.equal(result.orderId, 'real-tp-1');
  });

  it('placeBodyTpOrder adopts a reconciled order', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-body-1'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-body-1', status: 'OPEN' }),
    };
    const exec = createOrderExecutor('coinbase', configFor(), adapter, 'BTC-USDC');

    const result = await exec.placeBodyTpOrder(0.01, 55000, 'body-x');

    assert.equal(placeCalls, 1);
    assert.equal(result.success, true);
    assert.equal(result.orderId, 'real-body-1');
  });

  it('placeLadderOrders adopts a reconciled order for a ladder level', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitBuy: async () => { placeCalls++; throw unknownError('coid-ladder-1'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-ladder-1', status: 'OPEN' }),
      getOrder: async () => ({ status: 'OPEN' }), // ladder's own immediate-cancel verify check
    };
    const exec = createOrderExecutor('coinbase', configFor(), adapter, 'BTC-USDC');

    const { orders, failedCount } = await exec.placeLadderOrders([
      { index: 0, price: 90000, sizeUsdc: 900, assetQty: 0.01 },
    ]);

    assert.equal(placeCalls, 1);
    assert.equal(failedCount, 0, 'a reconciled placement must not count as a failed ladder level');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 'real-ladder-1');
  });

  it('a genuinely-failed (non-reconcilable) unknown placement is reported as a clean failure, not blindly retried', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-tp-2'); },
      findOrderByClientOrderId: async () => null, // never landed on the exchange
    };
    const exec = createOrderExecutor('coinbase', configFor(), adapter, 'BTC-USDC');

    const result = await exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });

    assert.equal(placeCalls, 1, 'placement attempted exactly once, never blind-retried');
    assert.equal(result.success, false);
  });
});

describe('refreshStaleOrders — per-order adaptive stale timeout', () => {
  it('honors order.staleMs over the global regime-adjusted timeout', async () => {
    const cancelled = [];
    // refreshStaleOrders now routes its cancel through safeCancelOrder (issue
    // #674), so cancelOrder must return the {success} shape it expects, and
    // getOrder must converge to CANCELLED once a cancel has been attempted —
    // otherwise safeCancelOrder's ack'd-poll branch would spin for real
    // seconds waiting for a status that never changes. Returning
    // {success:false} takes the zero-delay refused-cancel branch instead,
    // which reads getOrder once more immediately.
    const cancelledIds = new Set();
    const adapter = {
      getOrder: async (orderId) => cancelledIds.has(orderId)
        ? { status: 'CANCELLED', filledSize: 0, completionPercentage: 0 }
        : { status: 'OPEN', filledSize: 0, completionPercentage: 0 },
      cancelOrder: async (orderId) => { cancelledIds.add(orderId); cancelled.push(orderId); return { success: false }; },
      placeLimitBuy: async () => { throw new Error('placeLimitBuy should not be called'); },
      placeLimitSell: async () => { throw new Error('placeLimitSell should not be called'); },
      getOrderFills: async () => [],
    };
    const exec = createOrderExecutor('coinbase', baseConfig(), adapter, 'BTC-USDC', {});

    // Deep bid with a 5-minute adaptive window, aged past the 60s global timeout.
    exec.restorePendingOrder('adaptive-entry', {
      type: 'entry',
      price: 62_000,
      size: 0.01,
      sizeUsdc: 620,
      placedAt: Date.now() - 120_000,
      staleMs: 300_000,
    });
    // Tight bid without a per-order timeout, aged the same — expires on the global 60s.
    exec.restorePendingOrder('default-entry', {
      type: 'entry',
      price: 62_900,
      size: 0.01,
      sizeUsdc: 629,
      placedAt: Date.now() - 120_000,
    });

    const refreshed = await exec.refreshStaleOrders();

    assert.equal(refreshed, 1, 'only the default-timeout order goes stale');
    assert.deepStrictEqual(cancelled, ['default-entry']);
    assert.ok(exec.getPendingEntries().has('adaptive-entry'), 'adaptive order must keep resting');

    // Once the adaptive window elapses, the same sweep cancels it.
    exec.getPendingEntries().get('adaptive-entry').placedAt = Date.now() - 400_000;
    const secondPass = await exec.refreshStaleOrders();
    assert.equal(secondPass, 1);
    assert.deepStrictEqual(cancelled, ['default-entry', 'adaptive-entry']);
  });
});

describe('scheduleStaleOrderTimeout — refused cancel during stale check (issue #674)', () => {
  // scheduleStaleOrderTimeout is internal (scheduled by placeEntryBid); it is
  // exercised here through the public placeEntryBid entry point with a short
  // per-order staleMs, using a real (short) timer — same approach as the
  // issue's own reproduction script.
  it('routes a fill through onFillDetected — not onEntryCancelled — when the stale-timeout cancel is refused because the order already filled', async () => {
    let getOrderCalls = 0;
    const filledStatus = {
      status: 'FILLED', filledSize: 0.01, completionPercentage: 100,
      side: 'BUY', filledValue: 300, averageFilledPrice: 30000, totalFees: 0.5,
    };
    const adapter = {
      placeLimitBuy: async () => ({ success: true, orderId: 'stale-entry-1' }),
      // Cancel is refused — the canonical reason (per #209 A) is that the
      // order already filled.
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => {
        getOrderCalls++;
        // First read is the stale-timeout's own snapshot (still resting).
        // Every read after that (safeCancelOrder's refused-cancel check, and
        // placeEntryBid's own immediate-cancel verify at +750ms) sees the fill.
        return getOrderCalls === 1
          ? { status: 'OPEN', filledSize: 0, completionPercentage: 0 }
          : filledStatus;
      },
      getOrderFills: async () => [],
      getBidAsk: async () => ({ bid: 30000, ask: 30010 }),
    };

    const captured = [];
    const entryCancelled = [];
    const exec = createOrderExecutor('coinbase', {
      entryOffsetBps: 10,
      entryMaxRetries: 3,
      orderStaleMs: 60_000, // unused — staleMs is passed per-call below
      cancelRateLimitMs: 0,
    }, adapter, 'ZZZ-TEST-674', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });

    const staleMs = 60; // real timer, kept short so the test stays fast
    const result = await exec.placeEntryBid(1000, 30000, 30010, 0, null, staleMs);
    assert.equal(result.success, true);

    // placeEntryBid's own fixed 750ms immediate-cancel verify delay is well
    // past the 60ms stale timeout, so by the time it resolves the stale-timer
    // callback (refused cancel → filled) has already run to completion.
    assert.equal(captured.length, 1, 'the fill is routed through onFillDetected');
    assert.equal(captured[0].orderId, 'stale-entry-1');
    assert.equal(captured[0].status.side, 'buy');
    assert.equal(captured[0].status.filledSize, 0.01);
    assert.ok(captured[0].status.placedAt > 0, 'placedAt propagated for fill-time');
    assert.deepEqual(entryCancelled, [], 'a filled order is not an entry-cancellation');
    assert.equal(exec.getPendingCounts().entries, 0, 'order dropped from tracking after the fill was routed');

    exec.clearTimers();
  });

  it('keeps the order tracked when the stale-timeout cancel is neither filled nor cancelled (ack\'d but never settled)', async () => {
    // cancelOrder is refused and getOrder never converges to a terminal
    // state — safeCancelOrder exhausts its ack-retry budget and returns
    // {cancelled:false, filled:false}. The old raw-cancel code would have
    // dropped the order from tracking unconditionally; it must now stay
    // tracked for the polling backstop instead.
    const adapter = {
      placeLimitBuy: async () => ({ success: true, orderId: 'stale-entry-unresolved' }),
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'OPEN', filledSize: 0, completionPercentage: 0 }),
      getOrderFills: async () => [],
      getBidAsk: async () => ({ bid: 30000, ask: 30010 }),
    };

    const captured = [];
    const entryCancelled = [];
    const exec = createOrderExecutor('coinbase', {
      entryOffsetBps: 10,
      entryMaxRetries: 3,
      orderStaleMs: 60_000,
      cancelRateLimitMs: 0,
    }, adapter, 'ZZZ-TEST-674-3', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });

    const staleMs = 60;
    const result = await exec.placeEntryBid(1000, 30000, 30010, 0, null, staleMs);
    assert.equal(result.success, true);

    // safeCancelOrder's refused-cancel path retries maxAckRetries(=2) times
    // with a 1s sleep between attempts before giving up — wait past that,
    // on top of the 750ms placeEntryBid already waited.
    await new Promise(r => setTimeout(r, 2500));

    assert.equal(captured.length, 0, 'no fill to route');
    assert.deepEqual(entryCancelled, [], 'not a confirmed cancellation either');
    assert.equal(exec.getPendingCounts().entries, 1, 'order stays tracked for the polling backstop');

    exec.clearTimers();
  });
});

describe('cancelAllLadderOrders — partial fill during a successful cancel (issue #674)', () => {
  const restoreLadder = (exec, orderId, ladderIndex = 0) =>
    exec.restorePendingOrder(orderId, {
      type: 'ladder_entry', price: 51000 - ladderIndex * 100, size: 0.01, sizeUsdc: 510,
      ladderIndex, placedAt: Date.now(),
    });

  it('routes a partial fill through onFillDetected when the cancel is honored with filledSize > 0', async () => {
    // A ladder rung cancels cleanly (the exchange honors it), but part of it
    // filled in the race window before the cancel took. The old code checked
    // only `result.cancelled` and dropped tracking with a bare delete,
    // silently losing that bought asset (no body, no TP).
    // cancelOrder resolves {success:false} (the refused-cancel fast path
    // safeCancelOrder takes without any polling delay) with getOrder already
    // reporting the terminal CANCELLED-with-partial state — the same shape a
    // genuinely-honored cancel resolves to once safeCancelOrder verifies it.
    const captured = [];
    const entryCancelled = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, filledValue: 204, averageFilledPrice: 51000, totalFees: 0.01, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
      onEntryCancelled: (orderId) => entryCancelled.push(orderId),
    });
    restoreLadder(exec, 'ladder-partial');

    const result = await exec.cancelAllLadderOrders();

    assert.equal(result.cancelled, 1, 'a genuine cancel still counts as cancelled');
    assert.equal(result.partialFills, 1, 'the partial fill is reported back to the caller');
    assert.equal(result.remainingTracked, 0);
    assert.equal(captured.length, 1, 'partial fill routed through onFillDetected before dropping tracking');
    assert.equal(captured[0].orderId, 'ladder-partial');
    assert.equal(captured[0].status.isPartialFill, true);
    assert.equal(captured[0].status.filledSize, 0.004);
    assert.equal(captured[0].status.side, 'buy');
    assert.deepEqual(entryCancelled, ['ladder-partial'], 'entry-cancel callback still fires for the ladder rung');
  });

  it('skips onFillDetected on a clean cancel with zero fill (guard is specific)', async () => {
    const captured = [];
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: (orderId, status) => captured.push({ orderId, status }),
    });
    restoreLadder(exec, 'ladder-clean');

    const result = await exec.cancelAllLadderOrders();

    assert.equal(result.cancelled, 1);
    assert.equal(result.partialFills, 0);
    assert.equal(captured.length, 0);
  });

  it('awaits the fill callback before returning, so a synchronous caller (resetCycle) never resets state ahead of it (issue #674 review finding)', async () => {
    // resetCycle/rebuildLadder/cancelLadder all `await cancelAllLadderOrders()`
    // and then immediately reset cycle-scoped state (and, in the real engine,
    // call fillLedger.startNewCycle()). If the partial-fill callback were
    // fire-and-forget, that reset could race ahead of the fill actually being
    // booked, silently attributing it to the wrong cycle. Simulate a slow
    // (but eventually completing) onFillDetected and assert
    // cancelAllLadderOrders does not resolve until it has.
    let onFillDetectedResolved = false;
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, filledValue: 204, averageFilledPrice: 51000, totalFees: 0.01, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: async () => {
        await new Promise(r => setTimeout(r, 50));
        onFillDetectedResolved = true;
      },
    });
    restoreLadder(exec, 'ladder-await-check');

    const result = await exec.cancelAllLadderOrders();

    assert.equal(onFillDetectedResolved, true, 'cancelAllLadderOrders must not resolve before the async fill callback completes');
    assert.equal(result.partialFills, 1);
  });

  it('drops tracking BEFORE awaiting a slow fill callback, not after (issue #674 codex review finding)', async () => {
    // handleCancelledOrder is now awaitable so cancelAllLadderOrders can wait
    // for the fill to fully book, but that must not delay when the order
    // leaves pendingOrders: a concurrent sweep (checkPendingOrderFills,
    // another refreshStaleOrders pass) reads pendingOrders synchronously, and
    // if the order were still tracked while a slow fill/TP-placement callback
    // is in flight, that concurrent pass could rediscover the same
    // "cancelled" order and re-run this same booking a second time. Assert
    // the order is already gone from pendingOrders WHILE the callback is
    // still running, not only after it resolves.
    let trackedDuringCallback = null;
    const adapter = {
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.004, filledValue: 204, averageFilledPrice: 51000, totalFees: 0.01, side: 'BUY' }),
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {
      onFillDetected: async () => {
        // Sample pendingOrders state from INSIDE the callback — this runs
        // while cancelAllLadderOrders' await is still pending.
        trackedDuringCallback = exec.getPendingCounts().ladderEntries;
        await new Promise(r => setTimeout(r, 20));
      },
    });
    restoreLadder(exec, 'ladder-drop-before-await');

    await exec.cancelAllLadderOrders();

    assert.equal(trackedDuringCallback, 0, 'order must already be untracked while the fill callback is still in flight');
  });
});
