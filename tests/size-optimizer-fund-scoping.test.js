// @ts-check
//
// Engine-level regression for issue #694 (codex review, P1): adapter's
// getAccountBalance() is ACCOUNT-wide, not fund-scoped. With two or more
// configured funds on the same exchange sharing a quote currency (e.g.
// BTC-USDC and ETH-USDC both settling in USDC), recordCycleForSizeOptimizer()
// must NOT feed each fund's optimizer the whole shared wallet balance — that
// would let siblings independently ratchet their own maxUsdcDeployed up
// toward ~90% of the SAME pooled balance, over-committing capital across
// funds. This mirrors the pre-existing checkPositionCoverage's `sharingBase`
// skip (same file) applied to the quote-currency side.
//
// Disk safety: throwaway pair lives under data/coinbase/__test694fs__/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// recordCycleForSizeOptimizer() is invoked fire-and-forget (not awaited) by
// its callers as of issue #694 review round 2, so its own async work can
// still be pending when handleOrderFill()'s own promise resolves. Flush past
// it before asserting on sizeOptimizer state.
const flushAsync = () => new Promise(resolve => setImmediate(resolve));

// The size optimizer persists per-pair into the SHARED data/config.json;
// neutralize the write before regime-engine is required (it destructures
// updateRegimeConfig at load time), mirroring the other engine-level suites.
// getConfiguredFunds is stubbed the same way — regime-engine.js destructures
// it at require-time, so the stub must be installed before the first
// `require('../src/regime-engine')` in this process for the destructured
// reference to see it (node --test runs each file in its own process).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
const originalGetConfiguredFunds = configUtils.getConfiguredFunds;
const originalGetFundConfig = configUtils.getFundConfig;
configUtils.updateRegimeConfig = () => {};
let STUBBED_FUNDS = [];
configUtils.getConfiguredFunds = () => STUBBED_FUNDS;
// recordCycleForSizeOptimizer resolves each candidate's EFFECTIVE traded
// quote currency via getFundConfig(exchange, pair).productId (not the raw
// pair string, to cover quote-currency overrides — see the source comment).
// The real getFundConfig() would otherwise read production data/config.json
// and resolve every unknown test pair to the same DEFAULTS.productId,
// silently defeating every scenario below. regime-engine.js destructures
// getFundConfig at require-time, so this stub function reference must stay
// the SAME object forever — only the mutable PRODUCT_ID_OVERRIDES map it
// reads may change between tests (reassigning configUtils.getFundConfig
// itself later would not reach the already-captured destructured reference).
let PRODUCT_ID_OVERRIDES = {};
configUtils.getFundConfig = (_exchange, pair) => ({ productId: PRODUCT_ID_OVERRIDES[pair] || pair });

const { createRegimeEngine } = require('../src/regime-engine');

// Dash-shaped so getQuoteCurrency splits it as a real pair would ('-USDC' -> 'USDC').
const TEST_PAIR = '__TEST694FS__-USDC';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  configUtils.getConfiguredFunds = originalGetConfiguredFunds;
  configUtils.getFundConfig = originalGetFundConfig;
});

const makeAdapter = (over = {}) => ({
  getOpenOrders: async () => [],
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  cancelOrder: async () => ({ success: false }),
  getPositions: async () => [],
  getAccountBalance: async () => ({ available: '4242.42' }),
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

const makeEngine = () => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
  eng._test.setAdapter(makeAdapter());
  eng._test.setOrderExecutor(makeExecutor());
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

describe('issue #694 (codex P1) — recordCycleForSizeOptimizer skips the shared-wallet balance across sibling funds', () => {
  it('feeds the real balance when this is the only fund on the exchange for its quote currency', async () => {
    STUBBED_FUNDS = [{ exchange: 'coinbase', pair: TEST_PAIR }];
    const orderId = 'fund-scoping-solo';
    const eng = makeEngine();
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    await flushAsync();

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.lastKnownBalance, 4242.42, 'the only fund sharing this quote currency may use the real adapter balance');
  });

  it('does NOT fetch/feed the account-wide balance when a sibling fund on the same exchange shares this quote currency', async () => {
    STUBBED_FUNDS = [
      { exchange: 'coinbase', pair: TEST_PAIR },
      { exchange: 'coinbase', pair: 'ETH-USDC' }, // sibling fund, same exchange, same quote currency
    ];
    const orderId = 'fund-scoping-shared';
    const eng = makeEngine();
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    await flushAsync();

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.totalCycleCount, 1, 'the cycle is still recorded for stats even when the balance is skipped');
    assert.notEqual(
      sizeOptimizer.lastKnownBalance,
      4242.42,
      'must NOT feed the shared account-wide balance when a sibling fund shares this quote currency'
    );
    assert.equal(sizeOptimizer.lastKnownBalance, 0, 'ambiguous multi-fund balance is treated the same as an unverified reading');
  });

  it('a sibling fund on a DIFFERENT exchange does not trigger the skip', async () => {
    STUBBED_FUNDS = [
      { exchange: 'coinbase', pair: TEST_PAIR },
      { exchange: 'gemini', pair: 'ETH-USDC' }, // different exchange — not ambiguous
    ];
    const orderId = 'fund-scoping-other-exchange';
    const eng = makeEngine();
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    await flushAsync();

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.lastKnownBalance, 4242.42, 'a sibling on a different exchange does not share this wallet');
  });

  it('a sibling fund on the same exchange with a DIFFERENT quote currency does not trigger the skip', async () => {
    STUBBED_FUNDS = [
      { exchange: 'coinbase', pair: TEST_PAIR },
      { exchange: 'coinbase', pair: 'ETH-USD' }, // same exchange, different quote currency
    ];
    const orderId = 'fund-scoping-other-quote';
    const eng = makeEngine();
    setupLegacyTp(eng, orderId);
    Object.assign(eng._getConfig(), { sizeAutoManaged: true });

    await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
    await flushAsync();

    const { sizeOptimizer } = eng.getState();
    assert.equal(sizeOptimizer.lastKnownBalance, 4242.42, 'a sibling quoted in a different currency does not share this wallet');
  });

  it('a sibling whose IDENTITY pair differs in quote currency from its ACTUAL traded productId (override) still triggers the skip (codex review round 3)', async () => {
    // A fund's configured identity `pair` and its live-traded `productId` can
    // differ by quote currency (a documented, supported override — see
    // productIdMatchesPair in config-utils.js): e.g. a fund registered under
    // pair 'ETH-USD' can actually trade productId 'ETH-USDC'. Comparing raw
    // pair strings alone would miss this fund sharing the USDC wallet.
    PRODUCT_ID_OVERRIDES = { 'ETH-USD': 'ETH-USDC' };
    try {
      STUBBED_FUNDS = [
        { exchange: 'coinbase', pair: TEST_PAIR },
        { exchange: 'coinbase', pair: 'ETH-USD' }, // identity pair says USD, but trades USDC
      ];
      const orderId = 'fund-scoping-productid-override';
      const eng = makeEngine();
      setupLegacyTp(eng, orderId);
      Object.assign(eng._getConfig(), { sizeAutoManaged: true });

      await eng._test.handleOrderFill({ orderId, side: 'sell', isPartialFill: false });
      await flushAsync();

      const { sizeOptimizer } = eng.getState();
      assert.equal(
        sizeOptimizer.lastKnownBalance,
        0,
        'a sibling that ACTUALLY trades USDC (via productId override) must still be recognized as sharing the wallet'
      );
    } finally {
      PRODUCT_ID_OVERRIDES = {};
    }
  });
});
