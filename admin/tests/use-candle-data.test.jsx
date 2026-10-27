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
})
