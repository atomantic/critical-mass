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
