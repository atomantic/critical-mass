const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMacroRegime } = require('../src/macro-regime');
const { createRegimeDetector } = require('../src/regime-detector');
const { createRiskManager } = require('../src/risk-manager');
const { initializeApyTracking } = require('../src/apy-calculator');
const { createTpOptimizer } = require('../src/tp-optimizer');
const { createSizeOptimizer } = require('../src/size-optimizer');

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

describe('regime stack structured logging', () => {
  it('preserves operator messages and appends fund-specific event context', () => {
    const lines = [];
    const originalLog = console.log;
    console.log = line => lines.push(line);

    try {
      createMacroRegime('coinbase', {}, {}, 'BTC-USDC').restoreState({
        mode: 'MARKUP',
        score: 42,
      });

      createRegimeDetector('coinbase', {}, {}, 'BTC-USDC').restoreState({
        mode: 'CAUTION',
        transitionCount: 3,
      });

      createRiskManager('coinbase', {
        maxCycleBuys: 2,
        cycleResetHours: 0,
      }, 'BTC-USDC').checkCycleBuysLimit(2);

      initializeApyTracking({}, { maxUsdcDeployed: 1000 }, 'coinbase', undefined, 'BTC-USDC');

      createTpOptimizer('coinbase', {}, {}, 'BTC-USDC').importState({
        recentCycles: [],
        stats: { totalSampleCount: 2 },
        totalVolSampleCount: 1,
      });

      createSizeOptimizer('coinbase', {}, {}, 'BTC-USDC').importState({
        stats: { totalCycleCount: 4, avgStepsUsed: 1.5, p90StepsUsed: 2 },
      });
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(
      contextFor(lines, '📂 [coinbase] Macro state restored: MARKUP score=42.0'),
      { exchange: 'coinbase', pair: 'BTC-USDC', mode: 'MARKUP', score: 42 }
    );
    assert.deepEqual(
      contextFor(lines, '📂 [coinbase] Restored regime state: mode=CAUTION, transitions=3'),
      { exchange: 'coinbase', pair: 'BTC-USDC', mode: 'CAUTION', transitionCount: 3 }
    );
    assert.deepEqual(
      contextFor(lines, '⚠️ [coinbase] Cycle buys limit reached: 2/2, waiting for TP or auto-reset'),
      { exchange: 'coinbase', pair: 'BTC-USDC', currentStep: 2, maxSteps: 2 }
    );
    const apyContext = contextFor(lines, '📊 [coinbase] APY tracking started fresh: deposited=$1000.00');
    assert.equal(apyContext.exchange, 'coinbase');
    assert.equal(apyContext.pair, 'BTC-USDC');
    assert.equal(apyContext.trackingMode, 'fresh');
    assert.equal(apyContext.depositedCapital, 1000);
    assert.equal(apyContext.maxUsdcDeployed, 1000);
    assert.equal(typeof apyContext.engineStartTime, 'number');

    assert.deepEqual(
      contextFor(lines, '📊 [coinbase] TP optimizer restored: 2 cycle samples, 1 vol samples, 0 recent cycles'),
      {
        exchange: 'coinbase', pair: 'BTC-USDC', cycleSampleCount: 2,
        volatilitySampleCount: 1, recentCycleCount: 0,
      }
    );
    assert.deepEqual(
      contextFor(lines, '📊 [coinbase] Size optimizer restored: 4 cycles, avg 1.5 steps, p90 2 steps'),
      {
        exchange: 'coinbase', pair: 'BTC-USDC', totalCycleCount: 4,
        averageStepsUsed: 1.5, p90StepsUsed: 2,
      }
    );
  });
});
