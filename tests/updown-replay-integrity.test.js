// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { seedCompletedCandles, TF_MS } = require('../src/updown/replay-candles')
const { scorecardRecordKey, withHistoricalClock } = require('../scripts/backfill-scorecard')
const { findCandleGaps } = require('../scripts/backtest-updown')

describe('UpDown replay integrity', () => {
  it('shares the completed-candle boundary across historical replay tools', () => {
    const decisionTs = Date.UTC(2026, 0, 1, 12)
    const candles = [
      { timestamp: decisionTs - TF_MS['1h'], close: 100 },
      { timestamp: decisionTs, close: 999 }, // unfinished future OHLC
    ]
    const seeded = {}
    seedCompletedCandles({ seedCandles: (tf, rows) => { seeded[tf] = rows } }, { '1h': candles }, decisionTs, ['1h'])
    assert.deepEqual(seeded['1h'].map(c => c.close), [100])
  })

  it('runs signal stability against historical time and always restores Date.now', () => {
    const original = Date.now
    const historicalTs = Date.UTC(2025, 5, 1)
    assert.equal(withHistoricalClock(historicalTs, () => Date.now()), historicalTs)
    assert.equal(Date.now, original)
    assert.throws(() => withHistoricalClock(historicalTs, () => { throw new Error('boom') }), /boom/)
    assert.equal(Date.now, original)
  })

  it('gives rerun records deterministic semantic keys', () => {
    const ts = '2026-01-01T00:05:00.000Z'
    const oldPrediction = { type: 'prediction', id: 'backfill_1767225900000_42', ts, trigger: 'backfill' }
    const newPrediction = { type: 'prediction', id: 'backfill_1767225900000', ts, trigger: 'backfill' }
    assert.equal(scorecardRecordKey(oldPrediction), scorecardRecordKey(newPrediction))
    assert.equal(
      scorecardRecordKey({ type: 'outcome', predictionId: oldPrediction.id, window: '5m' }),
      scorecardRecordKey({ type: 'outcome', predictionId: newPrediction.id, window: '5m' }),
    )
  })

  it('detects internal gaps instead of backtesting discontinuous history', () => {
    const minute = TF_MS['1m']
    const candles = [{ timestamp: 0 }, { timestamp: minute }, { timestamp: 3 * minute }]
    assert.deepEqual(findCandleGaps(candles), [{ after: minute, before: 3 * minute, missing: 1 }])
  })
})
