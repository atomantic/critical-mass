import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useChartDataBuffer,
  mergeTimeSeries,
  mergeRegimeHistory,
  MAX_RETENTION_MS,
  MAX_POINTS,
} from '../src/hooks/useChartDataBuffer'

describe('mergeTimeSeries', () => {
  const now = 1700000000000
  const cutoff = now - MAX_RETENTION_MS

  it('merges cache with live refs in timestamp order', () => {
    const cached = [
      { timestamp: now - 5000, price: 100 },
      { timestamp: now - 3000, price: 105 },
    ]
    const live = [
      { timestamp: now - 2000, price: 110 },
      { timestamp: now - 1000, price: 115 },
    ]
    const result = mergeTimeSeries(cached, live, cutoff)
    expect(result).toEqual([
      { timestamp: now - 5000, price: 100 },
      { timestamp: now - 3000, price: 105 },
      { timestamp: now - 2000, price: 110 },
      { timestamp: now - 1000, price: 115 },
    ])
  })

  it('gives live data winning priority on equal timestamps', () => {
    const cached = [
      { timestamp: now - 2000, price: 100, source: 'cache' },
      { timestamp: now - 1000, price: 105, source: 'cache' },
    ]
    const live = [
      { timestamp: now - 1000, price: 120, source: 'live' },
    ]
    const result = mergeTimeSeries(cached, live, cutoff)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ timestamp: now - 2000, price: 100, source: 'cache' })
    expect(result[1]).toEqual({ timestamp: now - 1000, price: 120, source: 'live' })
  })

  it('filters out samples older than the cutoff', () => {
    const cached = [
      { timestamp: cutoff - 1000, price: 90 }, // expired
      { timestamp: cutoff + 1000, price: 95 }, // valid
    ]
    const live = [
      { timestamp: cutoff - 500, price: 92 }, // expired
      { timestamp: now - 500, price: 110 }, // valid
    ]
    const result = mergeTimeSeries(cached, live, cutoff)
    expect(result).toEqual([
      { timestamp: cutoff + 1000, price: 95 },
      { timestamp: now - 500, price: 110 },
    ])
  })

  it('does not discard live data when cache array is empty or undefined', () => {
    const live = [
      { timestamp: now - 2000, price: 100 },
      { timestamp: now - 1000, price: 105 },
    ]
    expect(mergeTimeSeries([], live, cutoff)).toEqual(live)
    expect(mergeTimeSeries(null, live, cutoff)).toEqual(live)
    expect(mergeTimeSeries(undefined, live, cutoff)).toEqual(live)
  })

  it('bounds output length to maxPoints, keeping the most recent', () => {
    const cached = Array.from({ length: 50 }, (_, i) => ({ timestamp: now - 50000 + i * 1000, price: i }))
    const result = mergeTimeSeries(cached, [], cutoff, 10)
    expect(result).toHaveLength(10)
    expect(result[0].price).toBe(40)
    expect(result[9].price).toBe(49)
  })
})

describe('mergeRegimeHistory', () => {
  const now = 1700000000000
  const cutoff = now - MAX_RETENTION_MS

  it('merges transitions in timestamp order and avoids duplicate adjacent modes', () => {
    const cached = [
      { timestamp: now - 5000, mode: 'HARVEST' },
      { timestamp: now - 3000, mode: 'TREND' },
    ]
    const live = [
      { timestamp: now - 2000, mode: 'TREND' }, // duplicate adjacent mode
      { timestamp: now - 1000, mode: 'CAUTION' },
    ]
    const result = mergeRegimeHistory(cached, live, cutoff)
    expect(result).toEqual([
      { timestamp: now - 5000, mode: 'HARVEST' },
      { timestamp: now - 3000, mode: 'TREND' },
      { timestamp: now - 1000, mode: 'CAUTION' },
    ])
  })

  it('preserves earlier boundary change when live has an earlier transition than cache duplicate', () => {
    const cached = [
      { timestamp: now - 5000, mode: 'HARVEST' },
      { timestamp: now - 2000, mode: 'TREND' },
    ]
    const live = [
      { timestamp: now - 3000, mode: 'TREND' }, // earlier transition to TREND
    ]
    const result = mergeRegimeHistory(cached, live, cutoff)
    expect(result).toEqual([
      { timestamp: now - 5000, mode: 'HARVEST' },
      { timestamp: now - 3000, mode: 'TREND' },
    ])
  })

  it('gives live data winning priority on equal timestamps', () => {
    const cached = [
      { timestamp: now - 2000, mode: 'HARVEST', source: 'cache' },
      { timestamp: now - 1000, mode: 'TREND', source: 'cache' },
    ]
    const live = [
      { timestamp: now - 1000, mode: 'CAUTION', source: 'live' },
    ]
    const result = mergeRegimeHistory(cached, live, cutoff)
    expect(result).toEqual([
      { timestamp: now - 2000, mode: 'HARVEST', source: 'cache' },
      { timestamp: now - 1000, mode: 'CAUTION', source: 'live' },
    ])
  })

  it('does not discard live regime transitions when cache is empty', () => {
    const live = [
      { timestamp: now - 2000, mode: 'HARVEST' },
      { timestamp: now - 1000, mode: 'TREND' },
    ]
    expect(mergeRegimeHistory([], live, cutoff)).toEqual(live)
    expect(mergeRegimeHistory(null, live, cutoff)).toEqual(live)
  })

  it('filters out regime transitions older than cutoff', () => {
    const cached = [
      { timestamp: cutoff - 5000, mode: 'HARVEST' },
      { timestamp: cutoff + 1000, mode: 'CAUTION' },
    ]
    const result = mergeRegimeHistory(cached, [], cutoff)
    expect(result).toEqual([
      { timestamp: cutoff + 1000, mode: 'CAUTION' },
    ])
  })
})

describe('useChartDataBuffer hook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retains live samples accumulated before delayed cache load', () => {
    const startTime = 1700000000000
    vi.setSystemTime(startTime)

    let currentStatus = {
      market: { lastPrice: 120, atr1m: 10, atr5m: 12, realizedVol: 0.8, volBaseline: 0.5 },
      regime: { mode: 'TREND', since: startTime },
    }

    const { result, rerender } = renderHook(({ status }) => useChartDataBuffer(status), {
      initialProps: { status: currentStatus },
    })

    // Advance 1.5s so lastSampleTime advances and push another tick
    vi.advanceTimersByTime(1500)
    currentStatus = {
      market: { lastPrice: 125, atr1m: 11, atr5m: 13, realizedVol: 0.9, volBaseline: 0.5 },
      regime: { mode: 'TREND', since: startTime },
    }
    rerender({ status: currentStatus })

    // Now delayed cache arrives with older timestamp data
    const cachedData = {
      priceHistory: [
        { timestamp: startTime - 10000, price: 100, atr1m: 8, atr5m: 9 },
        { timestamp: startTime - 5000, price: 105, atr1m: 9, atr5m: 10 },
      ],
      atrHistory: [
        { timestamp: startTime - 10000, atr1m: 8, atr5m: 9, realizedVol: 0.6, volBaseline: 0.5 },
        { timestamp: startTime - 5000, atr1m: 9, atr5m: 10, realizedVol: 0.7, volBaseline: 0.5 },
      ],
      regimeHistory: [
        { timestamp: startTime - 10000, mode: 'HARVEST', since: startTime - 10000 },
      ],
    }

    act(() => {
      result.current.initializeFromCache(cachedData)
    })

    // Assert that priceHistory has both older cached points AND newer live points
    expect(result.current.priceHistory).toHaveLength(4)
    expect(result.current.priceHistory[0].price).toBe(100)
    expect(result.current.priceHistory[1].price).toBe(105)
    expect(result.current.priceHistory[2].price).toBe(120)
    expect(result.current.priceHistory[3].price).toBe(125)

    // Assert that regimeHistory has both HARVEST (from cache) and TREND (from live)
    expect(result.current.regimeHistory).toHaveLength(2)
    expect(result.current.regimeHistory[0].mode).toBe('HARVEST')
    expect(result.current.regimeHistory[1].mode).toBe('TREND')
  })

  it('has deterministic live-wins behavior on equal timestamps', () => {
    const startTime = 1700000000000
    vi.setSystemTime(startTime)

    const status = {
      market: { lastPrice: 120, atr1m: 10, atr5m: 12, realizedVol: 0.8, volBaseline: 0.5 },
      regime: { mode: 'TREND', since: startTime },
    }

    const { result } = renderHook(() => useChartDataBuffer(status))

    const cachedData = {
      priceHistory: [
        { timestamp: startTime, price: 100 }, // same timestamp as live!
      ],
      atrHistory: [
        { timestamp: startTime, atr1m: 5, atr5m: 6 },
      ],
      regimeHistory: [
        { timestamp: startTime, mode: 'HARVEST' },
      ],
    }

    act(() => {
      result.current.initializeFromCache(cachedData)
    })

    // Live data must win
    expect(result.current.priceHistory).toHaveLength(1)
    expect(result.current.priceHistory[0].price).toBe(120)
    expect(result.current.atrHistory[0].atr1m).toBe(10)
    expect(result.current.regimeHistory[0].mode).toBe('TREND')
  })

  it('does not discard live data when cache arrays are empty', () => {
    const startTime = 1700000000000
    vi.setSystemTime(startTime)

    const status = {
      market: { lastPrice: 120, atr1m: 10, atr5m: 12, realizedVol: 0.8, volBaseline: 0.5 },
      regime: { mode: 'TREND', since: startTime },
    }

    const { result } = renderHook(() => useChartDataBuffer(status))

    act(() => {
      result.current.initializeFromCache({
        priceHistory: [],
        atrHistory: [],
        regimeHistory: [],
      })
    })

    expect(result.current.priceHistory).toHaveLength(1)
    expect(result.current.priceHistory[0].price).toBe(120)
    expect(result.current.regimeHistory).toHaveLength(1)
    expect(result.current.regimeHistory[0].mode).toBe('TREND')
  })

  it('initializes only once with stable callback identity', () => {
    const startTime = 1700000000000
    vi.setSystemTime(startTime)

    const { result, rerender } = renderHook(() => useChartDataBuffer(null))
    const firstCallback = result.current.initializeFromCache

    act(() => {
      result.current.initializeFromCache({
        priceHistory: [{ timestamp: startTime - 1000, price: 100 }],
        atrHistory: [],
        regimeHistory: [],
      })
    })

    expect(result.current.initialized).toBe(true)
    expect(result.current.priceHistory).toHaveLength(1)

    // Second call should be ignored
    act(() => {
      result.current.initializeFromCache({
        priceHistory: [{ timestamp: startTime - 500, price: 999 }],
      })
    })
    expect(result.current.priceHistory[0].price).toBe(100)

    // Re-render and check callback identity
    rerender()
    expect(result.current.initializeFromCache).toBe(firstCallback)
  })

  it('clears all data and resets initialized state on clearData', () => {
    const startTime = 1700000000000
    vi.setSystemTime(startTime)

    const { result } = renderHook(() => useChartDataBuffer(null))

    act(() => {
      result.current.initializeFromCache({
        priceHistory: [{ timestamp: startTime - 1000, price: 100 }],
        atrHistory: [{ timestamp: startTime - 1000, atr1m: 5 }],
        regimeHistory: [{ timestamp: startTime - 1000, mode: 'HARVEST' }],
      })
    })
    expect(result.current.initialized).toBe(true)

    act(() => {
      result.current.clearData()
    })
    expect(result.current.initialized).toBe(false)
    expect(result.current.priceHistory).toEqual([])
    expect(result.current.atrHistory).toEqual([])
    expect(result.current.regimeHistory).toEqual([])
  })
})
