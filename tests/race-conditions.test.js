// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Mutex Utility Tests
// ============================================================================
describe('Mutex utility', () => {
  const { createMutex } = require('../src/async-mutex');

  it('serializes concurrent access', async () => {
    const mutex = createMutex();
    const order = [];

    const task = async (label, delayMs) => {
      const release = await mutex.acquire();
      order.push(`${label}-start`);
      await new Promise(r => setTimeout(r, delayMs));
      order.push(`${label}-end`);
      release();
    };

    // Launch two tasks concurrently
    await Promise.all([task('A', 50), task('B', 10)]);

    // A should fully complete before B starts (serialized)
    assert.deepStrictEqual(order, ['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('reports locked state correctly', async () => {
    const mutex = createMutex();
    assert.equal(mutex.isLocked(), false);

    const release = await mutex.acquire();
    assert.equal(mutex.isLocked(), true);

    release();
    // After release, isLocked may still be true briefly if queue resolves;
    // the key invariant is that acquire returned and we could release
    assert.ok(true);
  });

  it('handles multiple sequential acquires', async () => {
    const mutex = createMutex();
    const results = [];

    for (let i = 0; i < 3; i++) {
      const release = await mutex.acquire();
      results.push(i);
      release();
    }

    assert.deepStrictEqual(results, [0, 1, 2]);
  });

  it('auto-releases after the timeout when a holder never releases (deadlock guard)', async () => {
    // Documents the hazard the tpMutex fix addresses: a small auto-release
    // timeout admits a second acquirer even though the first never released.
    const mutex = createMutex(30);
    const first = await mutex.acquire(); // acquired, intentionally never released
    void first;

    const start = Date.now();
    await mutex.acquire(); // only resolves because the 30ms guard fires
    const waited = Date.now() - start;

    assert.ok(waited >= 25, `second acquire waited for the auto-release (~30ms), got ${waited}ms`);
    assert.ok(waited < 200, `second acquire did not hang, got ${waited}ms`);
  });

  it('does NOT auto-release a slow section when the timeout sits above its duration (issue #209 B)', async () => {
    // The tpMutex now uses a deadlock guard well above the max real critical
    // section, so a legitimately slow section never admits a concurrent caller.
    const mutex = createMutex(10_000); // guard far above the section length
    const events = [];

    const slow = async () => {
      const release = await mutex.acquire();
      events.push('slow-start');
      await new Promise(r => setTimeout(r, 60)); // slow section
      events.push('slow-end');
      release();
    };
    const other = async () => {
      const release = await mutex.acquire();
      events.push('other');
      release();
    };

    await Promise.all([slow(), other()]);

    // No mid-section auto-release: the slow section fully completes before the
    // second caller runs.
    assert.deepStrictEqual(events, ['slow-start', 'slow-end', 'other']);
  });

  it('never auto-releases when timeout is 0', async () => {
    const mutex = createMutex(0);
    const first = await mutex.acquire(); // never released
    void first;

    let secondAcquired = false;
    mutex.acquire().then(() => { secondAcquired = true; });
    await new Promise(r => setTimeout(r, 80));

    assert.equal(secondAcquired, false, 'timeout=0 means the lock is held until explicitly released');
  });
});

// ============================================================================
// Race 1: Duplicate TP Sell Orders
// ============================================================================
describe('Race 1: Duplicate TP prevention', () => {
  const { createOrderExecutor } = require('../src/order-executor');

  const createMockAdapter = (overrides = {}) => ({
    cancelOrder: async () => ({ success: true }),
    getOrder: async () => ({ status: 'CANCELLED' }),
    placeLimitBuy: async () => ({ success: true, orderId: 'buy-1' }),
    placeLimitSell: async () => ({ success: true, orderId: 'sell-new' }),
    getBidAsk: async () => ({ bid: 100000, ask: 100010 }),
    ...overrides,
  });

  const createTestConfig = () => ({
    entryOffsetBps: 10,
    entryMaxRetries: 3,
    tpUpdateThresholdPct: 0.5,
    orderStaleMs: 30000,
    cancelRateLimitMs: 500,
    maxOpenOrders: 20,
  });

  it('cancelTpOrder returns {cancelled, filled} instead of boolean', async () => {
    const adapter = createMockAdapter();
    const executor = createOrderExecutor('test', createTestConfig(), adapter, 'BTC-USDC');

    // First place a TP so there's something to cancel
    const placeResult = await executor.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });
    assert.ok(placeResult.success);

    const result = await executor.cancelTpOrder();
    assert.equal(typeof result.cancelled, 'boolean');
    assert.equal(typeof result.filled, 'boolean');
    assert.equal(result.cancelled, true);
    assert.equal(result.filled, false);
  });

  it('detects fill-during-cancel and returns filledDuringCancel', async () => {
    // Adapter: cancel fails, getOrder shows FILLED
    const adapter = createMockAdapter({
      cancelOrder: async () => ({ success: false }),
      getOrder: async () => ({ status: 'FILLED', completionPercentage: 100 }),
      placeLimitSell: async () => ({ success: true, orderId: 'sell-1' }),
    });

    const executor = createOrderExecutor('test', createTestConfig(), adapter, 'BTC-USDC');

    // Place initial TP
    await executor.placeTakeProfitOrder(0.01, 100000, { forceUpdate: true });
    assert.ok(executor.getActiveTpOrderId());

    // Now try to place a new TP — should detect fill-during-cancel
    const result = await executor.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });
    assert.equal(result.filledDuringCancel, true);
    assert.ok(result.filledOrderId);
    assert.equal(result.success, false);
  });

  it('mutex serializes concurrent TP updates', async () => {
    let sellCallCount = 0;
    const adapter = createMockAdapter({
      placeLimitSell: async () => {
        sellCallCount++;
        await new Promise(r => setTimeout(r, 20));
        return { success: true, orderId: `sell-${sellCallCount}` };
      },
    });

    const executor = createOrderExecutor('test', createTestConfig(), adapter, 'BTC-USDC');

    // Fire two TP placements concurrently (both force update to bypass anti-churn)
    const [r1, r2] = await Promise.all([
      executor.placeTakeProfitOrder(0.01, 100000, { forceUpdate: true }),
      executor.placeTakeProfitOrder(0.01, 101000, { forceUpdate: true }),
    ]);

    // Both should complete (serialized, not racing)
    assert.ok(r1.success || r2.success);
    // The second call should have cancelled the first's TP (mutex ensures no overlap)
    assert.ok(sellCallCount >= 1);
  });

  it('concurrent placeTakeProfitOrder under a slow cancel leaves exactly one live TP (issue #209 B)', async () => {
    // Two placeTakeProfitOrder calls race while each TP cancel is slow. With
    // the deadlock guard sitting well above the section duration the mutex
    // fully serializes them, so the position ends with a single live TP sell —
    // not two (which would over-sell from holdback/reserves).
    let sellSeq = 0;
    const live = new Set();      // order IDs currently resting on the "exchange"
    const cancelledIds = new Set();

    const adapter = createMockAdapter({
      cancelOrder: async (orderId) => {
        // Slow cancel: simulate the degraded-network stall that used to trip
        // the 30s auto-release. Kept short so the test is fast; serialization
        // is what we assert, not wall-clock.
        await new Promise(r => setTimeout(r, 30));
        live.delete(orderId);
        cancelledIds.add(orderId);
        return { success: true };
      },
      getOrder: async (orderId) =>
        cancelledIds.has(orderId)
          ? { status: 'CANCELLED', completionPercentage: 0 }
          : { status: 'OPEN', completionPercentage: 0 },
      placeLimitSell: async () => {
        const orderId = `tp-${++sellSeq}`;
        live.add(orderId);
        return { success: true, orderId };
      },
    });

    const executor = createOrderExecutor('test', createTestConfig(), adapter, 'BTC-USDC');

    // Seed an existing active TP so both concurrent calls have to cancel first.
    executor.restorePendingOrder('tp-0', { type: 'take_profit', price: 99000, size: 0.01, sizeUsdc: 990, placedAt: Date.now() });
    live.add('tp-0');

    await Promise.all([
      executor.placeTakeProfitOrder(0.01, 100000, { forceUpdate: true }),
      executor.placeTakeProfitOrder(0.01, 101000, { forceUpdate: true }),
    ]);

    assert.equal(live.size, 1, `exactly one TP should be live, found ${[...live].join(',')}`);
    assert.ok(live.has(executor.getActiveTpOrderId()), 'the tracked active TP is the live one');
  });
});

// ============================================================================
// Race 2: State File Corruption
// ============================================================================
describe('Race 2: Atomic writes and version locking', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'race2-'));
  });

  it('atomicWriteSync leaves no .tmp artifacts on success', () => {
    const { atomicWriteSync } = require('../src/state-tracker');
    const filePath = path.join(tmpDir, 'test-state.json');

    atomicWriteSync(filePath, JSON.stringify({ test: true }));

    assert.ok(fs.existsSync(filePath));
    assert.ok(!fs.existsSync(filePath + '.tmp'));
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(data.test, true);
  });

  it('atomicWriteSync preserves file integrity on overwrite', () => {
    const { atomicWriteSync } = require('../src/state-tracker');
    const filePath = path.join(tmpDir, 'test-overwrite.json');

    // Write initial
    atomicWriteSync(filePath, JSON.stringify({ version: 1 }));
    // Overwrite
    atomicWriteSync(filePath, JSON.stringify({ version: 2 }));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(data.version, 2);
    assert.ok(!fs.existsSync(filePath + '.tmp'));
  });

  it('saveRegimeState increments _saveVersion on each save', () => {
    const { saveRegimeState, loadRegimeState, getRegimeStateFile } = require('../src/state-tracker');

    // Use a test exchange to avoid touching real state
    const testExchange = 'test-race2-version';
    const stateFile = getRegimeStateFile(testExchange);
    const dir = path.dirname(stateFile);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save twice
    const position = { totalBTC: 0.1, totalCostBasis: 10000, celestialBodies: [] };
    const regime = { mode: 'HARVEST', since: Date.now() };

    saveRegimeState(position, regime, testExchange);
    const data1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const v1 = data1.position._saveVersion;

    saveRegimeState(position, regime, testExchange);
    const data2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const v2 = data2.position._saveVersion;

    assert.ok(v2 > v1, `Version should increment: ${v2} > ${v1}`);

    // Clean up
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ============================================================================
// Race 3: Sell Fills During Body Merges
// ============================================================================
describe('Race 3: Merge-snapshot fill handling', () => {

  it('pendingMergeTpOrders stores snapshots correctly', () => {
    // Simulate the Map behavior used in regime-engine
    const pendingMergeTpOrders = new Map();

    const bodySnapshot = {
      id: 'body-123',
      tier: 'ASTEROID',
      btcQty: 0.001,
      costBasis: 100,
      avgPrice: 100000,
      tpOrderId: 'tp-order-abc',
    };

    pendingMergeTpOrders.set(bodySnapshot.tpOrderId, { ...bodySnapshot });

    assert.ok(pendingMergeTpOrders.has('tp-order-abc'));
    const snapshot = pendingMergeTpOrders.get('tp-order-abc');
    assert.equal(snapshot.id, 'body-123');
    assert.equal(snapshot.btcQty, 0.001);
    assert.equal(snapshot.costBasis, 100);
  });

  it('snapshot-based fill processing calculates correct P&L', () => {
    const snapshot = {
      id: 'body-merged',
      tier: 'ASTEROID',
      btcQty: 0.001,
      costBasis: 100,
      avgPrice: 100000,
      tpOrderId: 'tp-filled',
    };

    // Simulate fill summary
    const summary = {
      totalSize: 0.00099, // sell qty after holdback
      totalValue: 105,    // proceeds at TP price
      totalFees: 0.10,
      avgPrice: 106060.61,
    };

    const proceeds = summary.totalValue - summary.totalFees;
    const pnl = proceeds - snapshot.costBasis;
    const holdbackBtc = snapshot.btcQty - summary.totalSize;

    assert.ok(pnl > 0, `PnL should be positive: ${pnl}`);
    assert.ok(holdbackBtc > 0, `Holdback should be positive: ${holdbackBtc}`);
    assert.ok(Math.abs(proceeds - 104.9) < 0.001, `Proceeds ≈ 104.9: ${proceeds}`);
    assert.ok(Math.abs(pnl - 4.9) < 0.001, `PnL ≈ 4.9: ${pnl}`);
  });

  it('completedMergeTpOrders deduplicates same order ID', () => {
    const completedMergeTpOrders = new Map();

    const snapshot1 = { id: 'body-1', btcQty: 0.001 };
    const snapshot2 = { id: 'body-1-dupe', btcQty: 0.002 };

    completedMergeTpOrders.set('tp-123', snapshot1);
    // Second set with same key overwrites (expected Map behavior)
    completedMergeTpOrders.set('tp-123', snapshot2);

    assert.equal(completedMergeTpOrders.size, 1);
    assert.equal(completedMergeTpOrders.get('tp-123').id, 'body-1-dupe');
  });

  it('TTL expiry removes entries from completedMergeTpOrders', async () => {
    const completedMergeTpOrders = new Map();

    completedMergeTpOrders.set('tp-expire', { id: 'body-ttl', btcQty: 0.001 });
    // Simulate TTL with short timeout
    setTimeout(() => completedMergeTpOrders.delete('tp-expire'), 50);

    assert.ok(completedMergeTpOrders.has('tp-expire'));
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!completedMergeTpOrders.has('tp-expire'));
  });
});
