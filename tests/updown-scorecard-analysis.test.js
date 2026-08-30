// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const registerUpdownRoutes = require('../src/routes/updown-routes')
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
    const heatmap = registerUpdownRoutes.buildIndicatorTimeframeHeatmap(
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
