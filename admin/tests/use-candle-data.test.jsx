import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import useCandleData from '../src/hooks/useCandleData'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const makeFetchMock = (candlesMap = {}) => vi.fn(async (url, opts) => {
  if (opts?.signal?.aborted) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      success: true,
      candles: candlesMap,
    }),
  }
})

describe('useCandleData display limit and live candle preservation', () => {
  it('ignores invalid prices without corrupting live candle extrema', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ '1m': [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
    ] }))
    let props = { tickPrice: null, tickTimestamp: null }
    const { result, rerender } = renderHook(() =>
      useCandleData('coinbase', props.tickPrice, props.tickTimestamp, { defaultInterval: '1m' })
    )
    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    props = { tickPrice: 110, tickTimestamp: 60_000 }; rerender()
    for (const tickPrice of [0, -1, NaN, Infinity]) {
      props = { tickPrice, tickTimestamp: 60_010 }; rerender()
    }
    props = { tickPrice: 120, tickTimestamp: 120_000 }; rerender()

    expect(result.current.chartData.find(c => c.time === 60_000)).toMatchObject({
      high: 110, low: 110, price: 110,
    })
  })

  it('retains all relevant completed live candles when maxBucketsOverride changes (Auto/100/300)', async () => {
    const historical = [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
    ]
    const fetchMock = makeFetchMock({ '1m': historical })
    vi.stubGlobal('fetch', fetchMock)

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: null },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    // Wait for initial historical fetch to populate
    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))
    expect(result.current.chartData[0].price).toBe(100)

    // First live tick in next minute bucket (t=60_000)
    props = {
      ...props,
      tickPrice: 110,
      tickTimestamp: 60_000,
    }
    rerender()

    // Second live tick in next minute bucket (t=120_000) — completes t=60_000 bucket
    props = {
      ...props,
      tickPrice: 120,
      tickTimestamp: 120_000,
    }
    rerender()

    // All three candles (t=0, 60_000, 120_000) should be present
    expect(result.current.chartData.length).toBe(3)
    expect(result.current.chartData.map(c => c.price)).toEqual([100, 110, 120])

    // Increase maxBucketsOverride to 100
    props = {
      ...props,
      options: { ...props.options, maxBucketsOverride: 100 },
    }
    rerender()

    // Completed live candle (110) and latest candle (120) must be retained
    expect(result.current.chartData.length).toBe(3)
    expect(result.current.chartData.map(c => c.price)).toEqual([100, 110, 120])

    // Increase maxBucketsOverride to 300
    props = {
      ...props,
      options: { ...props.options, maxBucketsOverride: 300 },
    }
    rerender()

    expect(result.current.chartData.length).toBe(3)
    expect(result.current.chartData.map(c => c.price)).toEqual([100, 110, 120])

    // Return to Auto (null)
    props = {
      ...props,
      options: { ...props.options, maxBucketsOverride: null },
    }
    rerender()

    expect(result.current.chartData.length).toBe(3)
    expect(result.current.chartData.map(c => c.price)).toEqual([100, 110, 120])

    // Verify no redundant history fetch occurred during display limit changes
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves current-bucket high/low and close when changing display count/range', async () => {
    const historical = [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
    ]
    vi.stubGlobal('fetch', makeFetchMock({ '1m': historical }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: null },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Multiple ticks in current bucket (t=60_000) establishing high, low, close
    props = { ...props, tickPrice: 110, tickTimestamp: 60_000 }; rerender()
    props = { ...props, tickPrice: 125, tickTimestamp: 60_010 }; rerender()
    props = { ...props, tickPrice: 105, tickTimestamp: 60_020 }; rerender()
    props = { ...props, tickPrice: 118, tickTimestamp: 60_030 }; rerender()

    // Change display count to 100 — syncs projection
    props = { ...props, options: { ...props.options, maxBucketsOverride: 100 } }
    rerender()

    const currentAfter100 = result.current.chartData.find(c => c.time === 60_000)
    expect(currentAfter100).toBeTruthy()
    expect(currentAfter100.high).toBe(125)
    expect(currentAfter100.low).toBe(105)
    expect(currentAfter100.price).toBe(118)

    // Change display count to 300
    props = { ...props, options: { ...props.options, maxBucketsOverride: 300 } }
    rerender()

    const currentAfter300 = result.current.chartData.find(c => c.time === 60_000)
    expect(currentAfter300.high).toBe(125)
    expect(currentAfter300.low).toBe(105)
    expect(currentAfter300.price).toBe(118)

    // Change display count back to Auto (null)
    props = { ...props, options: { ...props.options, maxBucketsOverride: null } }
    rerender()

    const currentAfterAuto = result.current.chartData.find(c => c.time === 60_000)
    expect(currentAfterAuto.high).toBe(125)
    expect(currentAfterAuto.low).toBe(105)
    expect(currentAfterAuto.price).toBe(118)
  })

  it('does not replace newer live observations with older values on late historical reply', async () => {
    let resolveFetch
    const delayedFetch = new Promise(resolve => { resolveFetch = resolve })
    vi.stubGlobal('fetch', vi.fn(() => delayedFetch))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 60 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    // Deliver live tick before history arrives
    props = { ...props, tickPrice: 115, tickTimestamp: 60_000 }; rerender()
    props = { ...props, tickPrice: 120, tickTimestamp: 60_010 }; rerender() // high: 120
    props = { ...props, tickPrice: 112, tickTimestamp: 60_020 }; rerender() // low: 112, close: 112

    // Now resolve delayed historical response with older close=105, high=110, low=95
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          candles: {
            '1m': [
              { timestamp: 0, open: 100, high: 102, low: 98, close: 100, volume: 5 },
              { timestamp: 60_000, open: 100, high: 110, low: 95, close: 105, volume: 10 },
            ],
          },
        }),
      })
    })

    await vi.waitFor(() => expect(result.current.isLoading).toBe(false))

    const liveBucket = result.current.chartData.find(c => c.time === 60_000)
    expect(liveBucket).toBeTruthy()
    // Extrema are merged
    expect(liveBucket.high).toBe(120) // Math.max(120, 110)
    expect(liveBucket.low).toBe(95)   // Math.min(112, 95)
    // Newer live close (112) is preserved, not replaced by historical close (105)
    expect(liveBucket.price).toBe(112)
  })

  it('keeps timeframe/exchange changes isolated without mixing instruments or candle widths', async () => {
    let coinbaseControllerSignal
    let geminiControllerSignal
    const fetchMock = vi.fn(async (url, opts) => {
      if (url.includes('coinbase')) {
        coinbaseControllerSignal = opts?.signal
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [{ timestamp: 60_000, open: 100, high: 101, low: 99, close: 100 }],
              '5m': [{ timestamp: 300_000, open: 500, high: 505, low: 495, close: 500 }],
            },
          }),
        }
      }
      if (url.includes('gemini')) {
        geminiControllerSignal = opts?.signal
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '5m': [{ timestamp: 300_000, open: 700, high: 710, low: 690, close: 700 }],
            },
          }),
        }
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: null },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))
    expect(result.current.chartData[0].price).toBe(100)

    // Switch interval to 5m
    act(() => {
      result.current.setInterval('5m')
    })

    await vi.waitFor(() => {
      expect(result.current.chartData.length).toBe(1)
      expect(result.current.chartData[0].price).toBe(500)
    })
    // 1m candle (100) must not be mixed with 5m candle (500)
    expect(result.current.chartData.map(c => c.price)).toEqual([500])

    // Switch exchange to gemini
    props = {
      ...props,
      exchange: 'gemini',
      options: { defaultInterval: '5m', maxBucketsOverride: null },
    }
    rerender()

    await vi.waitFor(() => {
      expect(result.current.chartData.length).toBe(1)
      expect(result.current.chartData[0].price).toBe(700)
    })
    expect(result.current.chartData.map(c => c.price)).toEqual([700])
  })

  it('keeps Heikin Ashi and indicators aligned with the retained OHLC sequence and bounds retention', async () => {
    // Generate 40 historical candles
    const historical = Array.from({ length: 40 }, (_, i) => ({
      timestamp: i * 60_000,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 100,
    }))
    vi.stubGlobal('fetch', makeFetchMock({ '1m': historical }))

    const { result } = renderHook(() =>
      useCandleData('coinbase', null, null, { defaultInterval: '1m', maxBucketsOverride: 30 })
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(30))

    // Every displayed candle should have aligned HA values and indicator values where defined
    const latest = result.current.chartData[result.current.chartData.length - 1]
    expect(latest.haOpen).not.toBeNull()
    expect(latest.haClose).not.toBeNull()
    expect(latest.haHigh).not.toBeNull()
    expect(latest.haLow).not.toBeNull()
    expect(latest.bollingerUpper).not.toBeNull()
    expect(latest.rsi).not.toBeNull()
  })

  it('updates UI projection immediately when display limits change without waiting for a new live tick', async () => {
    const historical = Array.from({ length: 20 }, (_, i) => ({
      timestamp: i * 60_000,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
    }))
    vi.stubGlobal('fetch', makeFetchMock({ '1m': historical }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 5 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(5))

    // Expand projection to 15 without delivering any new live tick
    props = {
      ...props,
      options: { ...props.options, maxBucketsOverride: 15 },
    }
    rerender()

    // Immediately shows 15 candles
    expect(result.current.chartData.length).toBe(15)
  })

  it('aggregates historical volume across multiple candles mapping to the same bucket and replaces on refresh', async () => {
    // Two historical candles falling into the same 5m bucket (t=0..300_000)
    const historical = [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 102, volume: 40 },
      { timestamp: 60_000, open: 102, high: 108, low: 101, close: 106, volume: 60 },
    ]
    vi.stubGlobal('fetch', makeFetchMock({ '5m': historical }))

    const { result } = renderHook(() =>
      useCandleData('coinbase', null, null, { defaultInterval: '5m', maxBucketsOverride: 10 })
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    const bucket = result.current.chartData[0]
    expect(bucket.volume).toBe(100) // 40 + 60
    expect(bucket.open).toBe(100)
    expect(bucket.high).toBe(108)
    expect(bucket.low).toBe(95)
    expect(bucket.price).toBe(106)
    // VWAP calculation uses aggregated volume (100)
    expect(bucket.vwap).not.toBeNull()
  })

  it('rebuilds display buckets from retained source candles when bucketMs changes without re-fetching', async () => {
    // Custom views with same candleTf '1m' but different bucketMs
    const customViews = {
      '1m_agg': { bucketMs: 60_000, maxBuckets: 60, candleTf: '1m', indicatorTf: '1m' },
      '5m_agg': { bucketMs: 300_000, maxBuckets: 12, candleTf: '1m', indicatorTf: '1m' },
    }
    const historical = [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
    ]
    const fetchMock = makeFetchMock({ '1m': historical })
    vi.stubGlobal('fetch', fetchMock)

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { views: customViews, defaultView: '1m_agg' },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Accumulate live candles
    props = { ...props, tickPrice: 110, tickTimestamp: 60_000 }; rerender()
    props = { ...props, tickPrice: 120, tickTimestamp: 120_000 }; rerender()

    expect(result.current.chartData.length).toBe(3)

    // Switch view to 5m_agg (same candleTf '1m', different bucketMs 300_000)
    act(() => {
      result.current.setView('5m_agg')
    })

    // Should aggregate the 3 retained 1m candles into one 5m bucket (0..300_000)
    expect(result.current.chartData.length).toBe(1)
    expect(result.current.chartData[0].open).toBe(100)
    expect(result.current.chartData[0].price).toBe(120)

    // Verify fetch was NOT rerun because seriesKey (exchange:candleTf) did not change
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows a newer finalized historical response to update completed candle close after live ticks stop', async () => {
    const historicalInitial = [
      { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
    ]
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ success: true, candles: { '1m': historicalInitial } }),
        }
      }
      // On retry/refresh after live ticks stop:
      // Finalized candle for t=60_000 closed at 118 (whereas last live tick was 115)
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          candles: {
            '1m': [
              { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
              { timestamp: 60_000, open: 100, high: 120, low: 95, close: 118, volume: 25 },
            ],
          },
        }),
      }
    }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 10 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Live tick at t=60_000 with price 115
    props = { ...props, tickPrice: 115, tickTimestamp: 60_000 }; rerender()

    // Move to next bucket (t=120_000) so t=60_000 is completed
    props = { ...props, tickPrice: 130, tickTimestamp: 120_000 }; rerender()

    const bucket60kBefore = result.current.chartData.find(c => c.time === 60_000)
    expect(bucket60kBefore.price).toBe(115)

    // Stop live ticks, trigger retry (refresh)
    props = { ...props, tickPrice: null, tickTimestamp: null }; rerender()
    act(() => {
      result.current.retry()
    })

    // The newer finalized historical close (118) should now update the completed candle
    await vi.waitFor(() => {
      const bucket60kAfter = result.current.chartData.find(c => c.time === 60_000)
      expect(bucket60kAfter.price).toBe(118)
    })
  })

  it('scales source retention by display-to-source interval ratio to support 300 aggregated buckets', async () => {
    // 1500 1m candles -> 300 5m buckets
    const candles1m = []
    for (let i = 0; i < 1500; i++) {
      candles1m.push({
        timestamp: i * 60_000,
        open: 100 + (i % 10),
        high: 110 + (i % 10),
        low: 90 + (i % 10),
        close: 105 + (i % 10),
        volume: 5,
      })
    }
    vi.stubGlobal('fetch', makeFetchMock({ '1m': candles1m }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: {
        views: {
          '5m_view': { bucketMs: 300_000, maxBuckets: 300, candleTf: '1m', indicatorTf: '1m' },
        },
        defaultView: '5m_view',
      },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.isLoading).toBe(false))

    // All 300 5m buckets should be retained and displayed (1500 1m candles / 5 = 300 buckets)
    expect(result.current.chartData.length).toBe(300)
    expect(result.current.chartData[0].time).toBe(0)
    expect(result.current.chartData[299].time).toBe(299 * 300_000)

    // Deliver live ticks into current and subsequent buckets
    const lastTime = 1500 * 60_000
    props = { ...props, tickPrice: 150, tickTimestamp: lastTime }; rerender()
    // Live tick in a new 5m bucket (triggering live tick pruning, bucket transition, projection & sync)
    props = { ...props, tickPrice: 155, tickTimestamp: lastTime + 300_000 }; rerender()

    // Verify all 300 display buckets remain intact without dropping ~100 buckets
    expect(result.current.chartData.length).toBe(300)
    expect(result.current.chartData[result.current.chartData.length - 1].price).toBe(155)
  })

  it('resets indicator fields when recomputation produces null values upon switching views', async () => {
    // 30 1m candles
    const candles1m = []
    for (let i = 0; i < 30; i++) {
      candles1m.push({
        timestamp: i * 60_000,
        open: 100 + i,
        high: 105 + i,
        low: 95 + i,
        close: 102 + i,
        volume: 10,
      })
    }
    vi.stubGlobal('fetch', makeFetchMock({ '1m': candles1m }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: {
        views: {
          '1m_view': { bucketMs: 60_000, maxBuckets: 30, candleTf: '1m', indicatorTf: '1m' },
          '15m_view': { bucketMs: 900_000, maxBuckets: 10, candleTf: '1m', indicatorTf: '1m' },
        },
        defaultView: '1m_view',
      },
    }

    const { result } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(30))

    // Candle index 25 in 1m view has enough lookback for Bollinger bands (lookback 20)
    const candle25 = result.current.chartData.find(c => c.time === 25 * 60_000)
    expect(candle25.bollingerUpper).not.toBeNull()

    // First candle (t=0) has null bollinger bands due to insufficient lookback
    const candle0 = result.current.chartData.find(c => c.time === 0)
    expect(candle0.bollingerUpper).toBeNull()

    // Switch view to 15m_view (t=0..900_000 and t=900_000..1800_000)
    act(() => {
      result.current.setView('15m_view')
    })

    // Now switch back to 1m_view
    act(() => {
      result.current.setView('1m_view')
    })

    // Verify first bucket (t=0) still has null bollingerUpper, not polluted by reused bucket state
    const candle0After = result.current.chartData.find(c => c.time === 0)
    expect(candle0After.bollingerUpper).toBeNull()
  })

  it('preserves live close for unfinished source candles even if refresh occurs after live ticks', async () => {
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [{ timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 }],
            },
          }),
        }
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          candles: {
            '1m': [
              { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
              // Stale server snapshot for current unfinished candle at t=60_000
              { timestamp: 60_000, open: 100, high: 110, low: 95, close: 105, volume: 15 },
            ],
          },
        }),
      }
    }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 10 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Deliver live tick for candle t=60_000 at t=60_010 (candle is unfinished: 60_010 < 120_000)
    props = { ...props, tickPrice: 125, tickTimestamp: 60_010 }; rerender()

    const bucketBefore = result.current.chartData.find(c => c.time === 60_000)
    expect(bucketBefore.price).toBe(125)

    // Trigger refresh while candle is still unfinished (latest tick is at 60_010)
    props = { ...props, tickPrice: null, tickTimestamp: null }; rerender()
    act(() => {
      result.current.retry()
    })

    await vi.waitFor(() => expect(fetchCount).toBe(2))

    // The unfinished candle must preserve its live tick close (125), not overwritten by stale server close (105)
    const bucketDuring = result.current.chartData.find(c => c.time === 60_000)
    expect(bucketDuring.price).toBe(125)
  })

  it('retains enough source history across views so switching from 1m to aggregated 5m displays all 300 buckets', async () => {
    // 1500 1m candles
    const candles1m = []
    for (let i = 0; i < 1500; i++) {
      candles1m.push({
        timestamp: i * 60_000,
        open: 100 + (i % 10),
        high: 110 + (i % 10),
        low: 90 + (i % 10),
        close: 105 + (i % 10),
        volume: 5,
      })
    }
    vi.stubGlobal('fetch', makeFetchMock({ '1m': candles1m }))

    const customViews = {
      '1m_view': { bucketMs: 60_000, maxBuckets: 60, candleTf: '1m', indicatorTf: '1m' },
      '5m_view': { bucketMs: 300_000, maxBuckets: 300, candleTf: '1m', indicatorTf: '1m' },
    }

    const { result } = renderHook(() =>
      useCandleData('coinbase', null, null, {
        views: customViews,
        defaultView: '1m_view',
      })
    )

    await vi.waitFor(() => expect(result.current.isLoading).toBe(false))
    // In 1m view, displays 60 buckets
    expect(result.current.chartData.length).toBe(60)

    // Switch view to 5m_view (needs 1500 source candles)
    act(() => {
      result.current.setView('5m_view')
    })

    // Should retain all 1500 source candles and display all 300 5m buckets without truncation to 200
    expect(result.current.chartData.length).toBe(300)
    expect(result.current.chartData[0].time).toBe(0)
    expect(result.current.chartData[299].time).toBe(299 * 300_000)
  })

  it('preserves live close when refresh was requested during an unfinished candle even if reply arrives after next candle opens', async () => {
    let resolveRefreshFetch
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [{ timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 }],
            },
          }),
        }
      }
      return new Promise(res => {
        resolveRefreshFetch = () => res({
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [
                { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
                // Stale server snapshot taken while candle was unfinished
                { timestamp: 60_000, open: 100, high: 125, low: 95, close: 105, volume: 15 },
              ],
            },
          }),
        })
      })
    }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 10 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Deliver live tick for candle t=60_000 with price 125 at t=60_020
    props = { ...props, tickPrice: 125, tickTimestamp: 60_020 }; rerender()

    // Refresh is requested while candle t=60_000 is still unfinished (requestTime = 60_020 < 120_000)
    props = { ...props, tickPrice: null, tickTimestamp: null }; rerender()
    act(() => {
      result.current.retry()
    })

    // Now, while the refresh fetch is still in flight, next candle opens with tick at t=120_000
    props = { ...props, tickPrice: 130, tickTimestamp: 120_000 }; rerender()

    // Now the delayed refresh response finally arrives
    await act(async () => {
      resolveRefreshFetch()
    })

    await vi.waitFor(() => expect(result.current.isLoading).toBe(false))

    // The live close of 125 for candle 60_000 must NOT be overwritten by the pre-completion snapshot (105)
    const bucket60k = result.current.chartData.find(c => c.time === 60_000)
    expect(bucket60k.price).toBe(125)
  })

  it('does not overwrite finalized historical close when display dependencies change without new tick', async () => {
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [{ timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 }],
            },
          }),
        }
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          candles: {
            '1m': [
              { timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 },
              // Finalized candle for t=60_000 closed at 118
              { timestamp: 60_000, open: 100, high: 120, low: 95, close: 118, volume: 20 },
            ],
          },
        }),
      }
    }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { defaultInterval: '1m', maxBucketsOverride: 10 },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Deliver live tick for candle t=60_000 with price 115
    props = { ...props, tickPrice: 115, tickTimestamp: 60_000 }; rerender()

    // Move to next bucket (t=120_000) so candle t=60_000 is completed
    props = { ...props, tickPrice: 130, tickTimestamp: 120_000 }; rerender()

    // Stop live ticks, trigger refresh
    props = { ...props, tickPrice: null, tickTimestamp: null }; rerender()
    act(() => {
      result.current.retry()
    })

    // The newer finalized historical close (118) updates completed candle t=60_000
    await vi.waitFor(() => {
      const bucket60k = result.current.chartData.find(c => c.time === 60_000)
      expect(bucket60k.price).toBe(118)
    })

    // Now, change display limit without any new tick observation arriving
    props = { ...props, options: { ...props.options, maxBucketsOverride: 20 } }; rerender()

    // Changing display limit must NOT replay any previous tick onto candle t=60_000
    const bucket60kAfter = result.current.chartData.find(c => c.time === 60_000)
    expect(bucket60kAfter.price).toBe(118)
  })

  it('preserves separate display buckets when live ticks cross display boundaries within one source candle', async () => {
    // Custom views with 30s and 1m display buckets over 1m source candles
    const customViews = {
      '30s_view': { bucketMs: 30_000, maxBuckets: 60, candleTf: '1m', indicatorTf: '1m' },
      '1m_view': { bucketMs: 60_000, maxBuckets: 60, candleTf: '1m', indicatorTf: '1m' },
    }
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      if (fetchCount === 1) {
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            candles: {
              '1m': [{ timestamp: 0, open: 100, high: 105, low: 95, close: 100, volume: 10 }],
            },
          }),
        }
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          candles: {
            '1m': [{ timestamp: 0, open: 100, high: 120, low: 95, close: 120, volume: 20 }],
          },
        }),
      }
    }))

    let props = {
      exchange: 'coinbase',
      tickPrice: null,
      tickTimestamp: null,
      options: { views: customViews, defaultView: '30s_view' },
    }

    const { result, rerender } = renderHook(() =>
      useCandleData(props.exchange, props.tickPrice, props.tickTimestamp, props.options)
    )

    await vi.waitFor(() => expect(result.current.chartData.length).toBe(1))

    // Tick 1 at t=10_000 (falls in 30s display bucket 0..30_000, within 1m candle 0..60_000)
    props = { ...props, tickPrice: 110, tickTimestamp: 10_000 }; rerender()

    // Tick 2 at t=40_000 (crosses 30s display boundary to bucket 30_000..60_000, still within 1m candle 0..60_000)
    props = { ...props, tickPrice: 120, tickTimestamp: 40_000 }; rerender()

    // Both display buckets must exist: bucket 0 and bucket 30_000
    // Bucket 30_000 must NOT be collapsed into bucket 0 or deleted during projection
    expect(result.current.chartData.length).toBe(2)
    const bucket0 = result.current.chartData.find(c => c.time === 0)
    const bucket30k = result.current.chartData.find(c => c.time === 30_000)
    expect(bucket0).toBeTruthy()
    expect(bucket0.price).toBe(110)
    expect(bucket30k).toBeTruthy()
    expect(bucket30k.price).toBe(120)

    // Trigger refresh at t=40_000 while 1m candle is still unfinished (40_000 < 60_000)
    props = { ...props, tickPrice: null, tickTimestamp: null }; rerender()
    act(() => {
      result.current.retry()
    })
    await vi.waitFor(() => expect(fetchCount).toBe(2))

    // The refresh cannot overwrite bucket 0's live close (110) with the full 1m candle's close (120)
    const bucket0AfterRefresh = result.current.chartData.find(c => c.time === 0)
    expect(bucket0AfterRefresh.price).toBe(110)

    // Tick 3 at t=50_000 (updates bucket 30_000 close)
    props = { ...props, tickPrice: 125, tickTimestamp: 50_000 }; rerender()

    // Switch view from 30s_view to 1m_view (aggregates into bucket 0)
    act(() => {
      result.current.setView('1m_view')
    })
    expect(result.current.chartData.length).toBe(1)

    // Switch back to 30s_view (rebuilds both finer buckets with original OHLC)
    act(() => {
      result.current.setView('30s_view')
    })
    expect(result.current.chartData.length).toBe(2)
    expect(result.current.chartData[0].price).toBe(110)
    expect(result.current.chartData[1].price).toBe(125)

    // Tick 4 at t=70_000 (crosses into next 1m window, opening bucket 60_000 and triggering sync)
    props = { ...props, tickPrice: 135, tickTimestamp: 70_000 }; rerender()
    expect(result.current.chartData.length).toBe(3)
    const bucket30kUpdated = result.current.chartData.find(c => c.time === 30_000)
    expect(bucket30kUpdated.price).toBe(125)
    const bucket60k = result.current.chartData.find(c => c.time === 60_000)
    expect(bucket60k).toBeTruthy()
    expect(bucket60k.price).toBe(135)
  })
})
