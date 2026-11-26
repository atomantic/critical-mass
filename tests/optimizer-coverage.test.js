// @ts-check
/**
 * #213B — the optimizer labeled results with the REQUESTED period even when the
 * cache held fewer candles, so periods longer than the available history
 * produced identical metrics all labeled "90D"/"1Y". buildResultRecord must
 * surface the ACTUAL coverage and flag under-covered periods.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildResultRecord, compareOptimizerResults, runOptimizer, prefetchPriceData } = require('../src/optimizer-engine');

const baseMetrics = () => ({
  totalValue: 10_500,
  roi: 5,
  fillRate: 80,
  sellsFilled: 10,
  totalSells: 12,
  avgIntervalsToFill: 3,
  assetReserves: 0.01,
  netFees: 5,
  intervalsSkipped: 0,
  startDate: '2026-05-01T00:00:00.000Z',
  endDate: '2026-06-30T00:00:00.000Z',
});

describe('#213B optimizer coverage labeling', () => {
  it('flags an under-covered period and records actual vs requested intervals', () => {
    const currentParams = {
      intervalType: 'daily',
      intervalBuyAmount: 500,
      sellMarkupPercent: 5,
      holdbackPercent: 2.5,
      period: '1Y',
      intervals: 365, // requested a year
      fundSize: 10_000,
    };
    // runBacktest reports the real count it actually simulated.
    const result = { params: { intervals: 60 }, metrics: baseMetrics() };

    const record = buildResultRecord(currentParams, result);

    assert.equal(record.params.requestedIntervals, 365);
    assert.equal(record.params.actualIntervals, 60);
    assert.equal(record.params.underCovered, true, 'a 60-of-365 result must be flagged under-covered');
    assert.ok(Math.abs(record.params.coveragePct - (60 / 365) * 100) < 1e-9);
    // Coverage truth also mirrored onto metrics for consumers that read metrics.
    assert.equal(record.metrics.actualIntervals, 60);
    assert.equal(record.metrics.underCovered, true);
    // Original requested period label is preserved for display.
    assert.equal(record.params.period, '1Y');
  });

  it('does not flag a fully-covered period', () => {
    const currentParams = {
      intervalType: 'daily', period: '30D', intervals: 30, fundSize: 10_000,
    };
    const result = { params: { intervals: 30 }, metrics: baseMetrics() };

    const record = buildResultRecord(currentParams, result);

    assert.equal(record.params.underCovered, false);
    assert.equal(record.params.actualIntervals, 30);
    assert.equal(record.params.coveragePct, 100);
  });
});

describe('#213B follow-up — compareOptimizerResults ranks fully-covered ahead of under-covered', () => {
  const makeRecord = (annualizedRoi, underCovered) => ({
    params: { underCovered },
    metrics: { annualizedRoi },
  });

  it('a fully covered result outranks an under-covered one with higher annualized ROI', () => {
    const fullyCovered = makeRecord(10_000, false);
    const underCovered = makeRecord(50_000, true); // higher totalValue, but the period silently truncated
    const results = [underCovered, fullyCovered];
    results.sort(compareOptimizerResults);

    assert.equal(results[0], fullyCovered, 'a trustworthy result must never be crowned worse than a mislabeled one');
    assert.equal(results[1], underCovered);
  });

  it('sorts by annualized ROI descending within the same coverage group', () => {
    const results = [makeRecord(100, false), makeRecord(300, false), makeRecord(200, false)];
    results.sort(compareOptimizerResults);
    assert.deepEqual(results.map((r) => r.metrics.annualizedRoi), [300, 200, 100]);
  });

  it('sorts under-covered results among themselves too, not just deprioritized wholesale', () => {
    const results = [makeRecord(10, true), makeRecord(30, true), makeRecord(20, true)];
    results.sort(compareOptimizerResults);
    assert.deepEqual(results.map((r) => r.metrics.annualizedRoi), [30, 20, 10]);
  });
});

describe('#2056 optimizer ranking and interval validation', () => {
  it('ranks the 30-day result above the higher-value 60-day result on annualized ROI', () => {
    const makeResult = (days, endDate, totalValue, roi) => buildResultRecord(
      { intervalType: 'daily', period: `${days}D`, intervals: days },
      { params: { intervals: days }, metrics: { ...baseMetrics(), startDate: '2026-01-01T00:00:00Z', endDate, totalValue, roi } },
    );
    const shorter = makeResult(30, '2026-01-30T00:00:00Z', 10_300, 3);
    const longer = makeResult(60, '2026-03-01T00:00:00Z', 10_500, 5);
    assert.equal(shorter.metrics.annualizedRoi, 36.5);
    assert.deepEqual([longer, shorter].sort(compareOptimizerResults), [shorter, longer]);
  });

  it('rejects a one-minute optimizer interval before fetching history', async () => {
    await assert.rejects(runOptimizer({ intervals: ['1min'] }), /Unsupported optimizer interval: 1min/);
    await assert.rejects(prefetchPriceData(['1min'], ['30D']), /Unsupported optimizer interval: 1min/);
  });
});
