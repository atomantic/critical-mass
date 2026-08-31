// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_INTERVALS_BY_TYPE,
  optimizerRequestKey,
  validateBacktestInput,
  validateOptimizerInput,
  validatePriceQuery,
} = require('../src/simulation-policy');
const { SimulationRunCoordinator } = require('../src/simulation-run-coordinator');

describe('simulation request policy', () => {
  it('rejects invalid price and backtest input before an engine can fetch data', () => {
    assert.equal(validatePriceQuery({ intervals: '10oops' }).ok, false);
    assert.equal(validatePriceQuery({ intervals: String(MAX_INTERVALS_BY_TYPE.daily + 1), intervalType: 'daily' }).ok, false);
    assert.equal(validatePriceQuery({ intervalType: 'forever' }).ok, false);
    assert.equal(validatePriceQuery({ intervals: '10080', intervalType: '1min' }).ok, true);
    assert.equal(validatePriceQuery({ intervals: '10081', intervalType: '1min' }).ok, false);
    assert.equal(validateBacktestInput({ intervals: 1460, intervalType: 'daily' }).ok, true);
    assert.equal(validateBacktestInput({ intervals: 1461, intervalType: 'daily' }).ok, false);
    assert.equal(validateBacktestInput({ intervals: Infinity }).ok, false);
    assert.equal(validateBacktestInput({ intervalBuyAmount: -1 }).ok, false);
    assert.equal(validateBacktestInput({ feePercent: 101 }).ok, false);
  });

  it('normalizes valid optimizer selections and rejects duplicates or unknown values', () => {
    const normalized = validateOptimizerInput({
      intervals: ['daily', '10min'],
      markups: [8, 2],
      periods: ['1Y', '30D'],
      buyAmounts: { daily: 750, '10min': 12 },
    });
    assert.equal(normalized.ok, true);
    assert.deepEqual(normalized.value.intervals, ['10min', 'daily']);
    assert.deepEqual(normalized.value.markups, [2, 8]);
    assert.deepEqual(normalized.value.periods, ['30D', '1Y']);
    assert.deepEqual(normalized.value.buyAmounts, { '10min': 12, daily: 750 });
    assert.equal(validateOptimizerInput({ intervals: ['daily', 'daily'] }).ok, false);
    assert.equal(validateOptimizerInput({ periods: ['7D'] }).ok, false);
    assert.equal(validateOptimizerInput({ buyAmounts: { forever: 1 } }).ok, false);
  });

  it('uses a stable optimizer request key for equivalent selections', () => {
    const left = validateOptimizerInput({ intervals: ['daily', '10min'], markups: [8, 2], periods: ['1Y', '30D'] }).value;
    const right = validateOptimizerInput({ intervals: ['10min', 'daily'], markups: [2, 8], periods: ['30D', '1Y'] }).value;
    assert.equal(
      optimizerRequestKey({ exchange: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', ...left }),
      optimizerRequestKey({ exchange: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', ...right }),
    );
  });
});

describe('simulation run coordinator', () => {
  it('bounds active jobs, cleans up failures, and rate limits force refreshes', async () => {
    let now = 1_000;
    const coordinator = new SimulationRunCoordinator({ maxActive: 1, refreshCooldownMs: 30_000, now: () => now });
    let release;
    const first = coordinator.start({ resourceKey: 'fund:coinbase:BTC-USDC', requestKey: 'first', forceRefresh: true }, () => new Promise(resolve => { release = resolve; }));
    assert.equal(first.accepted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.start({ resourceKey: 'fund:coinbase:BTC-USDC', requestKey: 'duplicate' }, () => Promise.resolve()).status, 409);
    assert.equal(coordinator.start({ resourceKey: 'fund:gemini:BTCUSD', requestKey: 'capacity' }, () => Promise.resolve()).status, 429);
    release('done');
    await first.promise;
    assert.equal(coordinator.status('fund:coinbase:BTC-USDC'), null);
    now += 1_000;
    assert.equal(coordinator.start({ resourceKey: 'fund:coinbase:BTC-USDC', requestKey: 'refresh', forceRefresh: true }, () => Promise.resolve()).code, 'SIMULATION_REFRESH_COOLDOWN');

    const failing = coordinator.start({ resourceKey: 'fund:gemini:BTCUSD', requestKey: 'failure' }, () => Promise.reject(new Error('expected')));
    await assert.rejects(failing.promise, /expected/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.status('fund:gemini:BTCUSD'), null);
  });
});
