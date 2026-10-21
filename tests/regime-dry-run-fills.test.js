// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const celestialHierarchy = require('../src/celestial-hierarchy');
const { roundAsset, roundUSDC, roundPrice } = require('../src/volatility-utils');
const { createDryRunFillHandlers } = require('../src/regime-dry-run-fills');

const makeHarness = () => {
  const calls = [];
  const events = [];
  const config = { maxUsdcDeployed: 1000, maxCelestialBodies: 10, maxOpenOrders: 50 };
  let positionState = {
    celestialBodies: [], cycleBuys: 0, cyclesCompleted: 0, pendingLadderOrders: [], ladderActive: true,
  };
  const orderExecutor = {
    getPendingCounts: () => ({ total: 0 }),
    cancelBodyTpOrder: async (...a) => { calls.push(['cancel', ...a]); return { cancelled: true }; },
    removeBodyTracking: (id) => calls.push(['removeTracking', id]),
    getOptimalTpAnalytics: () => null,
  };
  const handlers = createDryRunFillHandlers({
    exchange: 'test', pair: 'X-USD', baseCurrency: 'X', config, celestialHierarchy,
    tradeEvents: { emitTradeEvent: (...a) => events.push(a) },
    logger: { info() {}, warn() {} },
    getPositionState: () => positionState,
    getOrderExecutor: () => orderExecutor,
    getPriceIncrement: () => 0.01,
    placeBodyTp: async (body) => { calls.push(['placeTp', body.id]); body.tpOrderId = `tp-${body.id}`; },
    resetCycle: async () => { calls.push(['reset']); positionState.cycleBuys = 0; },
    recordCycleForOptimizer: () => calls.push(['optimizer']),
    recordCycleForSizeOptimizer: async () => { calls.push(['sizeOptimizer']); },
    saveDryRunState: () => calls.push(['save']),
    resaveAfterSizeOptimizerDryRun: () => calls.push(['resave']),
    updateRegimeConfig: (...a) => calls.push(['updateConfig', a[2]]),
    roundPrice, roundAsset, roundUSDC, fmtPrice: String,
    calculateDynamicTpPercent: () => 1,
  });
  return { handlers, calls, events, config, getState: () => positionState };
};

describe('regime dry-run fill handlers', () => {
  it('onBuyFill creates a body, places its TP, clears the pending ladder order, and saves', async () => {
    const h = makeHarness();
    h.getState().pendingLadderOrders = [{ orderId: 'b1' }];
    await h.handlers.onBuyFill('b1', 1, 100, 100);
    const s = h.getState();
    assert.equal(s.celestialBodies.length, 1);
    assert.equal(s.cycleBuys, 1);
    assert.equal(s.lastEntryPrice, 100);
    assert.equal(s.ladderActive, false);
    assert.ok(h.calls.some(c => c[0] === 'placeTp'));
    assert.equal(h.calls.at(-1)[0], 'save');
    assert.equal(h.events[0][0], 'buy_filled');
  });

  it('onSellFill closes the body cycle, grows capital by pnl, and resets', async () => {
    const h = makeHarness();
    await h.handlers.onBuyFill('b1', 1, 100, 100);
    const body = h.getState().celestialBodies[0];
    await h.handlers.onSellFill(body.tpOrderId, 0.5, 101, 50.5, 5);
    const s = h.getState();
    assert.equal(s.celestialBodies.length, 0);
    assert.equal(s.cyclesCompleted, 1);
    assert.equal(h.config.maxUsdcDeployed, 1005);
    assert.ok(h.calls.some(c => c[0] === 'updateConfig' && c[1].maxUsdcDeployed === 1005));
    assert.ok(h.calls.some(c => c[0] === 'reset'));
    assert.ok(h.events.some(e => e[0] === 'body_tp_filled'));
    assert.equal(h.calls.at(-1)[0], 'save');
  });

  it('onSellFill with an unknown order takes the untracked fallback path', async () => {
    const h = makeHarness();
    Object.assign(h.getState(), { totalAsset: 2, avgCostBasis: 100, totalCostBasis: 200, cycleBuys: 2 });
    await h.handlers.onSellFill('unknown', 1, 101, 101, 3);
    assert.equal(h.getState().cyclesCompleted, 1);
    assert.equal(h.config.maxUsdcDeployed, 1003);
    assert.ok(h.events.some(e => e[0] === 'tp_filled'));
    assert.ok(h.calls.some(c => c[0] === 'reset'));
  });
});
