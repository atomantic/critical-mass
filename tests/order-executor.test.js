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
    const adapter = {
      cancelOrder: async () => ({ success: true }),
      getOrder: async () => { throw new Error('getOrder should not be needed on a clean cancel'); },
    };
    const exec = createOrderExecutor('gemini', baseConfig(), adapter, 'ETH-USD', {});
    restoreEntry(exec, 'entry-clean-1');
    restoreEntry(exec, 'entry-clean-2');

    const cancelled = await exec.cancelAllEntries();

    assert.equal(cancelled, 2);
    assert.equal(exec.getPendingCounts().entries, 0);
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
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0, completionPercentage: 0 }),
      cancelOrder: async (orderId) => { cancelled.push(orderId); },
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
