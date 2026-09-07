// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { buildIndicatorTimeframeHeatmap, buildScorecardAnalysis, resolvePerpCorrect } = require('../src/updown/scorecard-analytics')
const { INDICATORS } = require('../src/updown/indicator-config')
const { ALL_SIGNAL_TFS } = require('../src/updown/signal-engine')

describe('UpDown scorecard analysis', () => {
  it('attributes correctness to the exact indicator and timeframe pair', () => {
    const predictions = [{
      id: 'p1',
      timeframes: {
        '1m': { scores: { rsi: 30, macd: 0 } },
        '5m': { scores: { rsi: 0, macd: -30 } },
      },
    }]
    const outcomes = [{ predictionId: 'p1', window: '5m', priceChangeBps: 100 }]
    const heatmap = buildIndicatorTimeframeHeatmap(
      predictions,
      outcomes,
      ['rsi', 'macd'],
      ['1m', '5m'],
    )

    assert.deepEqual(heatmap.rsi['1m'], { correct: 1, total: 1, accuracy: 100 })
    assert.deepEqual(heatmap.rsi['5m'], { correct: 0, total: 0, accuracy: null })
    assert.deepEqual(heatmap.macd['1m'], { correct: 0, total: 0, accuracy: null })
    assert.deepEqual(heatmap.macd['5m'], { correct: 0, total: 1, accuracy: 0 })
  })

  it('uses the complete canonical model catalog', () => {
    assert.deepEqual(INDICATORS, ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum', 'obv', 'williamsR', 'cci'])
    assert.ok(ALL_SIGNAL_TFS.includes('1w'))
    assert.equal(ALL_SIGNAL_TFS.length, 11)
  })
})

const outcome = (predictionId, overrides = {}) => ({
  type: 'outcome', predictionId, window: '5m',
  ts: '2026-09-07T10:05:00.000Z', compositeDirection: 'up',
  compositeCorrect: true, priceChangeBps: 100,
  ...overrides,
})

describe('shared outcome interpretation', () => {
  it('respects explicit values and resolves legacy noise-floor scratches', () => {
    for (const explicit of [true, false, null]) {
      assert.equal(resolvePerpCorrect(outcome('explicit', {
        perpCorrect: explicit, compositeCorrect: !explicit, priceChangeBps: 0,
      })), explicit)
    }
    assert.equal(resolvePerpCorrect(outcome('legacy-win')), true)
    assert.equal(resolvePerpCorrect(outcome('legacy-loss', { compositeCorrect: false, priceChangeBps: -100 })), false)
    assert.equal(resolvePerpCorrect(outcome('unscored', { compositeCorrect: null })), null)
    assert.equal(resolvePerpCorrect(outcome('missing', { priceChangeBps: undefined })), null)
    for (const [window, floor] of [['1m', 5], ['5m', 10], ['15m', 20], ['1h', 40], ['legacy', 10]]) {
      for (const sign of [-1, 1]) {
        assert.equal(resolvePerpCorrect(outcome('scratch', { window, priceChangeBps: floor * sign })), null)
        assert.equal(resolvePerpCorrect(outcome('scored', { window, priceChangeBps: (floor + 1) * sign })), true)
      }
    }
  })

  it('preserves an empty response and the canonical catalog', () => {
    const analysis = buildScorecardAnalysis([])
    assert.equal(analysis.success, true)
    assert.deepEqual(analysis.catalog.timeframes, ALL_SIGNAL_TFS)
    assert.deepEqual(analysis.catalog.indicators.map(i => i.key), INDICATORS)
    assert.deepEqual(analysis.accuracyOverTime, [])
    assert.deepEqual(analysis.indicatorAccuracyOverTime, [])
    assert.deepEqual(analysis.weightEvolution, [])
    assert.deepEqual(analysis.failurePatterns, [])
    assert.equal(analysis.contractAnalysis, null)
    assert.equal(analysis.perpAnalysis, null)
    assert.deepEqual(analysis.summary, {
      accuracy: null, perpDirectionalAccuracy: null, predictions: 0, outcomes: 0,
      bestIndicator: null, worstIndicator: null, bestTimeframe: null, bestWindow: null,
      perpRealizedPnl: null, perpWinRate: null, perpRounds: 0,
    })
  })

  it('deduplicates semantic outcomes, excludes DOWN, and keeps expiry settlements separate', () => {
    const prediction = { type: 'prediction', id: 'p1', contract: { range: 500 } }
    const win = outcome('p1')
    const rows = [
      prediction, prediction, win, win,
      outcome('p2', { perpCorrect: false, compositeCorrect: false, priceChangeBps: -100 }),
      outcome('scratch', { perpCorrect: null, compositeCorrect: false }),
      outcome('noise', { compositeCorrect: false, priceChangeBps: 10 }),
      outcome('down', { compositeDirection: 'down', perpCorrect: false }),
      outcome('p1', { window: 'contract', compositeCorrect: null, perpCorrect: null, contractOutcome: 'win' }),
      outcome('p1', { window: '1h', contractOutcome: 'loss' }),
    ]
    const before = JSON.stringify(rows)
    const analysis = buildScorecardAnalysis(rows)
    assert.equal(analysis.summary.predictions, 1)
    assert.equal(analysis.summary.outcomes, 5)
    assert.equal(analysis.summary.perpDirectionalAccuracy, 66.67)
    assert.deepEqual(analysis.contractAnalysis, {
      total: 1, byRange: { 500: { wins: 1, losses: 0, total: 1, accuracy: 100 } },
    })
    assert.equal(JSON.stringify(rows), before)
  })

  it('preserves raw trends, failure patterns, exact heatmaps, weights, and 0.01-BTC paper P&L', () => {
    const rows = [1, 2, 3].map(i => outcome('p' + i, {
      compositeCorrect: false, perpCorrect: false,
      indicatorResults: { rsi: { predictions: 2, correct: 0 }, macd: { predictions: 1, correct: 0 } },
      indicatorTfResults: { rsi: { '5m': { correct: false }, '1m': { correct: null } } },
      tfResults: { '5m': { correct: false } },
    }))
    rows.push(
      { type: 'weights', ts: '2026-09-07T10:00:00Z', weights: { rsi: 0.2 } },
      { type: 'perp_fill', action: 'OPEN' },
      { type: 'perp_fill', action: 'ADD' },
      { type: 'perp_fill', action: 'CLOSE', trade: { avgEntry: 80000, exitPrice: 80100, contracts: 2, pnl: 9999 } },
      { type: 'perp_fill', action: 'CLOSE', trade: { avgEntry: 80000, exitPrice: 79900, contracts: 1 } },
    )
    const analysis = buildScorecardAnalysis(rows)
    assert.deepEqual(analysis.failurePatterns, [{ indicators: ['macd', 'rsi'], failures: 3, total: 3, failureRate: 100 }])
    assert.deepEqual(analysis.accuracyOverTime, [{ hour: '2026-09-07T10', accuracy: 0, correct: 0, total: 3 }])
    assert.equal(analysis.indicatorAccuracyOverTime[0].rsi, 0)
    assert.deepEqual(analysis.heatmap.rsi['5m'], { correct: 0, total: 3, accuracy: 0 })
    assert.deepEqual(analysis.heatmap.rsi['1m'], { correct: 0, total: 0, accuracy: null })
    assert.deepEqual(analysis.weightEvolution, [{ ts: '2026-09-07T10:00:00Z', rsi: 0.2 }])
    assert.deepEqual(analysis.perpAnalysis, { opens: 1, adds: 1, closes: 2, wins: 1, losses: 1, winRate: 50, realizedPnl: 1 })
    assert.equal(analysis.summary.perpRealizedPnl, 1)
    assert.equal(analysis.summary.bestTimeframe, '5m')
    assert.equal(analysis.summary.bestWindow, '5m')
  })
})
