// @ts-check
/**
 * Lookahead-bias guard for scripts/backtest-updown.js seeding (issue #105).
 *
 * Live parity rule: candle-aggregator getCandles() returns only COMPLETED
 * candles. A bucket's timestamp is its START, so seedUpTo must only seed
 * buckets whose END (timestamp + tfMs) <= evalTs. A bucket ending exactly
 * at evalTs is completed (included); an in-progress bucket is excluded.
 */
const { describe, it } = require('node:test')
const assert = require('node:assert')

const { seedUpTo, findLastIndex, TF_MS } = require('../scripts/backtest-updown')

const HOUR = TF_MS['1h']
const MIN = TF_MS['1m']

/** Build a fake aggregator that records seedCandles calls per TF. */
function recordingAggregator() {
  const seeded = {}
  return {
    seeded,
    seedCandles: (tf, candles) => { seeded[tf] = candles },
  }
}

/** Build n consecutive candles for a TF starting at startTs. */
function makeCandles(startTs, intervalMs, n) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: startTs + i * intervalMs,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1,
  }))
}

describe('backtest-updown seedUpTo — completed-candle boundary', () => {
  // evalTs at an exact hour boundary: hour bucket [evalTs-1h, evalTs) ends
  // exactly at evalTs → included; bucket starting at evalTs is in progress.
  const evalTs = Date.UTC(2026, 0, 10, 12, 0, 0)

  it('includes a bucket ending exactly at evalTs', () => {
    const agg = recordingAggregator()
    const candles1h = makeCandles(evalTs - 5 * HOUR, HOUR, 5) // last ends at evalTs
    seedUpTo(agg, { '1h': candles1h }, evalTs)
    assert.strictEqual(agg.seeded['1h'].length, 5)
    const last = agg.seeded['1h'][agg.seeded['1h'].length - 1]
    assert.strictEqual(last.timestamp + HOUR, evalTs)
  })

  it('excludes the in-progress bucket (start <= evalTs but end > evalTs)', () => {
    const agg = recordingAggregator()
    // 6th bucket starts at evalTs - 30min... use mid-bucket evalTs instead:
    const midBucketEval = evalTs + 30 * MIN // 12:30 — hour bucket [12:00,13:00) in progress
    const candles1h = makeCandles(evalTs - 5 * HOUR, HOUR, 6) // last starts at 12:00
    seedUpTo(agg, { '1h': candles1h }, midBucketEval)
    const seeded = agg.seeded['1h']
    assert.strictEqual(seeded.length, 5, 'in-progress 12:00 bucket must be excluded')
    for (const c of seeded) {
      assert.ok(c.timestamp + HOUR <= midBucketEval, `bucket ${c.timestamp} leaks future data`)
    }
  })

  it('seeds the 1m candle whose end equals evalTs, not the next one', () => {
    const agg = recordingAggregator()
    const candles1m = makeCandles(evalTs - 10 * MIN, MIN, 20) // spans past evalTs
    seedUpTo(agg, { '1m': candles1m }, evalTs)
    const seeded = agg.seeded['1m']
    const last = seeded[seeded.length - 1]
    assert.strictEqual(last.timestamp, evalTs - MIN, 'last seeded 1m candle ends exactly at evalTs')
  })

  it('never leaks future data on any signal timeframe', () => {
    const agg = recordingAggregator()
    const tfCandles = {}
    for (const [tf, tfMs] of Object.entries(TF_MS)) {
      // Candles spanning well past evalTs on every TF
      tfCandles[tf] = makeCandles(evalTs - 10 * tfMs, tfMs, 20)
    }
    const midEval = evalTs + 17 * MIN // arbitrary mid-bucket time for most TFs
    seedUpTo(agg, tfCandles, midEval)
    for (const [tf, candles] of Object.entries(agg.seeded)) {
      for (const c of candles) {
        assert.ok(
          c.timestamp + TF_MS[tf] <= midEval,
          `${tf} bucket starting ${c.timestamp} ends after evalTs ${midEval}`
        )
      }
    }
  })

  it('seeds nothing when no bucket has completed yet', () => {
    const agg = recordingAggregator()
    const candles1h = makeCandles(evalTs, HOUR, 3) // all start at/after evalTs
    seedUpTo(agg, { '1h': candles1h }, evalTs + 30 * MIN)
    assert.strictEqual(agg.seeded['1h'], undefined)
  })
})

describe('backtest-updown findLastIndex', () => {
  const candles = makeCandles(0, MIN, 5) // timestamps 0..240000

  it('returns last index with timestamp <= target', () => {
    assert.strictEqual(findLastIndex(candles, 2 * MIN), 2)
    assert.strictEqual(findLastIndex(candles, 2 * MIN + 1), 2)
    assert.strictEqual(findLastIndex(candles, 10 * MIN), 4)
  })

  it('returns -1 when no candle qualifies', () => {
    assert.strictEqual(findLastIndex(candles, -1), -1)
  })
})
