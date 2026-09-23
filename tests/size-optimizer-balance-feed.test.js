// @ts-check
//
// Engine-level regression for issue #694: all four
// recordCycleForSizeOptimizer() call sites in regime-engine.js used to pass
// config.maxUsdcDeployed (the deployment CAP) in as the "available balance"
// argument. size-optimizer.js's calculateAdjustment() then computed
// newMaxUsdcDeployed = availableBalance * targetUtilization — feeding the cap
// back into itself, so every evaluation multiplied the cap by
// targetUtilization (~0.9) again, ratcheting it toward the $10 floor.
//
// The fix makes recordCycleForSizeOptimizer() fetch the REAL exchange quote
// balance from the adapter (the same adapter.getAccountBalance() call the
// ladder/entry preflight paths already use) instead of accepting a
// caller-supplied balance. This file proves that value — not
// config.maxUsdcDeployed — is what reaches the size optimizer.
//
// Disk safety: throwaway pair '__test694__' -> data/coinbase/__test694__/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The size optimizer persists per-pair into the SHARED data/config.json;
// neutralize the write before regime-engine is required (it destructures
// updateRegimeConfig at load time), mirroring the other engine-level suites.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test694__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
});

const makeAdapter = (over = {}) => ({
  getOpenOrders: async () => [],
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  cancelOrder: async () => ({ success: false }),
  getPositions: async () => [],
  getAccountBalance: async () => ({ available: '0' }),
  ...over,
});

const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-new' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  cancelAllLadderOrders: async () => ({ cancelled: 0 }),
  getPendingLadderOrders: () => [],
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  getPendingEntries: () => new Map(),
  getOrderPlacedAt: () => null,
  isLadderOrder: () => false,
  ...over,
});

/** A sell fill for a legacy/untracked TP, shaped for adapter.getOrderFills. */
const sellFill = (orderId, size, price) => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'sell',
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  tradeTime: new Date().toISOString(),
}];

const makeEngine = ({ adapter, executor } = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
  eng._test.setAdapter(makeAdapter(adapter || {}));
  eng._test.setOrderExecutor(makeExecutor(executor || {}));
  engines.push(eng);
  return eng;
};

const setupLegacyTp = (eng, orderId) => {
  Object.assign(eng._getPositionState(), {
    activeTpOrderId: orderId,
    totalAsset: 0.01,
    totalCostBasis: 500,
    avgCostBasis: 50000,
    assetOnOrder: 0.009,
    cycleBuys: 3,
    ladderActive: false,
    pendingLadderOrders: [],
  });
};

describe('issue #694 — recordCycleForSizeOptimizer feeds the real adapter balance, not the cap', () => {
  it('the balance the size optimizer records equals the mocked adapter balance, and differs from config.maxUsdcDeployed', async () => {
    const orderId = 'balance-feed-live';
    const MOCK_BALANCE = 4242.42; // deliberately far from config.maxUsdcDeployed (default 10000)

    const eng = makeEngine({
      adapter: {
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.009, averageFilledPrice: 51000 }),
        getOrderFills: async () => sellFill(orderId, 0.009, 51000),
        getAccountBalance: async () => ({ available: String(MOCK_BALANCE) }),
      },
    });
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });

    const configMaxUsdcDeployed = eng._getConfig().maxUsdcDeployed;
    assert.notEqual(configMaxUsdcDeployed, MOCK_BALANCE, 'test setup must keep the cap and the mocked balance distinct');

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.totalCycleCount, 1, 'the cycle completion reached the size optimizer');
    assert.equal(
      sizeOptimizer.lastKnownBalance,
      MOCK_BALANCE,
      'recordCycleForSizeOptimizer must feed the optimizer the real adapter balance'
    );
    assert.notEqual(
      sizeOptimizer.lastKnownBalance,
      configMaxUsdcDeployed,
      'the optimizer must NOT have been fed config.maxUsdcDeployed as the balance (issue #694)'
    );
  });

  it('a failed/unavailable balance fetch does not feed the cap back in either — lastKnownBalance stays at its prior value', async () => {
    const orderId = 'balance-feed-failure';
    const eng = makeEngine({
      adapter: {
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.009, averageFilledPrice: 51000 }),
        getOrderFills: async () => sellFill(orderId, 0.009, 51000),
        getAccountBalance: async () => { throw new Error('exchange unavailable'); },
      },
    });
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });
    const configMaxUsdcDeployed = eng._getConfig().maxUsdcDeployed;

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.totalCycleCount, 1, 'the cycle is still recorded for stats even without a fresh balance');
    assert.equal(
      sizeOptimizer.lastKnownBalance,
      0,
      'with no prior known balance and a failed fetch, lastKnownBalance stays at its unset (0) value — never the cap'
    );
    assert.notEqual(sizeOptimizer.lastKnownBalance, configMaxUsdcDeployed, 'must never fall back to feeding the cap as the balance');
  });

  it('an adapter with no getAccountBalance method at all does not throw and does not feed the cap back in', async () => {
    // Distinct from the "fetch throws" case above: here the adapter simply
    // never HAS the method (some test/legacy adapters), so
    // `typeof adapter.getAccountBalance === 'function'` must gate the call —
    // calling `adapter.getAccountBalance(...)` when it's undefined throws a
    // synchronous TypeError that would otherwise escape recordCycleForSizeOptimizer
    // and abort the whole fill-handling call (verified against a prior version
    // of this fix, which broke tests/offline-fill-recovery.test.js exactly this way).
    const orderId = 'balance-feed-no-method';
    const eng = makeEngine({
      adapter: {
        getOrder: async () => ({ status: 'FILLED', filledSize: 0.009, averageFilledPrice: 51000 }),
        getOrderFills: async () => sellFill(orderId, 0.009, 51000),
        getAccountBalance: undefined,
      },
    });
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });
    const configMaxUsdcDeployed = eng._getConfig().maxUsdcDeployed;

    await assert.doesNotReject(
      eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false }),
      'a missing getAccountBalance method must not throw out of fill handling'
    );

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.totalCycleCount, 1, 'the cycle is still recorded for stats even with no balance method');
    assert.equal(sizeOptimizer.lastKnownBalance, 0, 'no balance method available — lastKnownBalance stays at its unset (0) value');
    assert.notEqual(sizeOptimizer.lastKnownBalance, configMaxUsdcDeployed, 'must never fall back to feeding the cap as the balance');
  });
});
