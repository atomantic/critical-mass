// @ts-check
// Real engine entry/preview/rebuild paths with isolated fund storage and a
// deterministic macro signal. No engine start, network or exchange orders.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-auto-ladder');
const configUtils = require('../src/config-utils');
const oldGetConfig = configUtils.getRegimeConfig;
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
configUtils.getRegimeConfig = (...args) => ({ ...oldGetConfig(...args), macroEnabled: true });
const macroModule = require('../src/macro-regime');
const oldMacro = macroModule.createMacroRegime;
const { computeAutoSizeMultiplier } = require('../src/auto-aggressiveness');
let nextSignal;
macroModule.createMacroRegime = (_exchange, config) => {
  const signal = nextSignal;
  return {
    getState: () => ({}),
    getAutoSizeMult: deployedRatio => {
      signal.ratios.push(deployedRatio);
      return computeAutoSizeMultiplier({ score: signal.score, deployedRatio,
        ready: config.autoAggressivenessEnabled && signal.ready && signal.fresh });
    },
  };
};
const { createRegimeEngine } = require('../src/regime-engine');
const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.getRegimeConfig = oldGetConfig;
  configUtils.updateRegimeConfig = oldUpdate;
  macroModule.createMacroRegime = oldMacro;
  isolated.cleanup();
});

const setup = ({ score = 0, ready = true, fresh = true, enabled = true,
  balance = 1000, allocated = 0, cancel = undefined } = {}) => {
  const signal = { score, ready, fresh, ratios: [] };
  nextSignal = signal;
  const eng = createRegimeEngine('coinbase', `__test1783_${engines.length}__`,
    { dryRun: false, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  Object.assign(eng._getConfig(), {
    entryMode: 'ladder', ladderAutoSwitch: false, autoAggressivenessEnabled: enabled,
    maxUsdcDeployed: 1000, baseSizeUsdc: 50, minOrderSizeUsdc: 5, maxOpenOrders: 50,
    ladderSizeMode: 'fibonacci', ladderMaxAthDropPct: 80,
  });
  Object.assign(eng._getPositionState(), { totalCostBasis: allocated, celestialBodies: [] });
  Object.assign(eng._getMarketState(), { lastPrice: 100, bid: 99.99, ask: 100.01,
    atr1m: 0.5, volBaseline: 0.01, realizedVol: 0.03, ath: 120 });
  Object.assign(eng._test.getHealth(), { mode: 'ACTIVE', reason: null });
  eng._test.setRunning(true);
  eng._test.setAdapter({ getAccountBalance: async () => ({ available: String(balance) }) });
  const placed = [];
  eng._test.setOrderExecutor({
    getPendingCounts: () => ({ total: 0 }),
    cancelAllLadderOrders: cancel || (async () => ({ cancelled: 0 })),
    placeLadderOrders: async levels => {
      placed.push(levels);
      return { orders: levels.map((l, i) => ({ ...l, orderId: `rung-${i}` })), failedCount: 0 };
    },
  });
  return { eng, placed, signal };
};
const sum = levels => levels.reduce((s, l) => s + l.sizeUsdc, 0);
const view = levels => levels.map(({ price, sizeUsdc, assetQty, distancePct }) =>
  ({ price, sizeUsdc, assetQty, distancePct }));

describe('ladder auto-aggressiveness engine integration (#1783)', () => {
  it('scales preview, automatic placement and rebuild identically', async () => {
    const { eng, placed } = setup();
    const preview = await eng.previewLadder();
    assert.equal(preview.success, true);
    assert.ok(Math.abs(preview.preview.totalBudget - 500) <= 0.02);
    await eng._test.evaluateEntryTrigger();
    assert.equal(placed.length, 1);
    assert.deepEqual(view(placed[0]), preview.preview.levels);
    assert.equal((await eng.rebuildLadder()).success, true);
    assert.deepEqual(placed[1], placed[0]);
  });

  it('scales the ladderAutoSwitch path too', async () => {
    const { eng, placed } = setup();
    Object.assign(eng._getConfig(), { entryMode: 'reactive', ladderAutoSwitch: true });
    await eng._test.evaluateEntryTrigger();
    assert.equal(placed.length, 1);
    assert.ok(Math.abs(sum(placed[0]) - 500) <= 0.02);
  });

  for (const disabled of [{ enabled: false }, { ready: false }, { fresh: false }]) {
    it(`preserves baseline preview and placement for ${JSON.stringify(disabled)}`, async () => {
      const baseline = setup({ enabled: false });
      const expected = (await baseline.eng.previewLadder()).preview;
      const { eng, placed } = setup(disabled);
      assert.deepEqual((await eng.previewLadder()).preview, expected);
      await eng._test.evaluateEntryTrigger();
      assert.deepEqual(view(placed[0]), expected.levels);
      assert.equal(sum(placed[0]), 1000);
    });
  }

  it('starts the governor from held body capital and caps by exchange balance', async () => {
    const { eng, placed, signal } = setup({ score: 1, balance: 180, allocated: 0 });
    eng._getPositionState().celestialBodies = [{ costBasis: 650 }];
    await eng._test.evaluateLadderEntry();
    assert.equal(signal.ratios[0], 0.65);
    assert.equal(placed.length, 1);
    assert.ok(sum(placed[0]) <= 180);
    assert.ok(signal.ratios.some(r => r > 0.65));
  });

  it('reserves unbooked cancel-time fills in the rebuilt governor ratio', async () => {
    const { eng, placed, signal } = setup({ score: 1, cancel: async () => ({
      cancelled: 1, unbookedFills: [{ orderId: 'unbooked', filledSize: 6.5,
        unitCost: 100, cost: 650 }],
    }) });
    eng._getPositionState().ladderActive = true;
    const result = await eng.rebuildLadder();
    assert.equal(result.success, true);
    assert.equal(signal.ratios[0], 0.65);
    assert.equal(placed.length, 1);
    assert.ok(sum(placed[0]) <= 350);
  });

  it('places nothing if every scaled rung is below the exchange minimum', async () => {
    const { eng, placed } = setup({ balance: 50 });
    eng._getConfig().minOrderSizeUsdc = 30;
    const preview = await eng.previewLadder();
    assert.deepEqual(preview.preview.levels, []);
    assert.equal(preview.preview.totalBudget, 0);
    await eng._test.evaluateLadderEntry();
    assert.equal(placed.length, 0);
  });
});
