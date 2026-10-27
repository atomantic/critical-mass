import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import useRegimeDashboardData from '../src/components/regime/useRegimeDashboardData'
import ChartsRegime from '../src/components/ChartsRegime'

const socketFixture = vi.hoisted(() => ({
  status: null,
  statusSeq: 0,
  setStatus: vi.fn(),
  connected: true,
}))

vi.mock('../src/hooks/useTradeEvents', () => ({
  useRegimeEvents: () => ({
    status: socketFixture.status,
    statusSeq: socketFixture.statusSeq,
    setStatus: socketFixture.setStatus,
    connected: socketFixture.connected,
  }),
}))

const chartCaptures = vi.hoisted(() => ({
  priceChartProps: null,
  timelineProps: null,
}))

vi.mock('../src/components/charts/RegimePriceChart', () => ({
  default: (props) => {
    chartCaptures.priceChartProps = props
    return <div data-testid="regime-price-chart">Price chart ({props.data?.length} points)</div>
  },
}))

vi.mock('../src/components/charts/VolatilityChart', () => ({
  default: () => <div>Volatility chart</div>,
}))

vi.mock('../src/components/charts/RegimeTimeline', () => ({
  default: (props) => {
    chartCaptures.timelineProps = props
    return <div data-testid="regime-timeline">Timeline ({props.data?.length} transitions)</div>
  },
}))

vi.mock('../src/components/charts/CumulativePnlChart', () => ({
  default: () => <div>Cumulative PnL chart</div>,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  socketFixture.status = null
  socketFixture.statusSeq = 0
  chartCaptures.priceChartProps = null
  chartCaptures.timelineProps = null
})

describe('Delayed chart cache integration with useRegimeDashboardData', () => {
  it('retains live samples accumulated during loading and does not re-trigger load effect', async () => {
    let resolveChartData
    const chartDataPromise = new Promise((resolve) => {
      resolveChartData = resolve
    })

    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/regime/chart-data')) {
        return chartDataPromise
      }
      if (url.includes('/regime/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            status: { isRunning: true, market: { lastPrice: 100 }, regime: { mode: 'HARVEST' } },
          }),
        }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, status: 200, json: async () => ({ success: true, config: {} }) }
      }
      if (url.includes('/regime/fills')) {
        return { ok: true, status: 200, json: async () => ({ success: true, detailFills: [], fillCount: 0 }) }
      }
      if (url.includes('/presets/')) {
        return { ok: true, status: 200, json: async () => ({ success: true, presets: {} }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const now = Date.now()

    // Mount hook
    const { result, rerender } = renderHook(() =>
      useRegimeDashboardData('coinbase', 'BTC-USDC', '?pair=BTC-USDC')
    )

    // While chart-data fetch is pending, live socket tick arrives with newer price 120 and TREND
    act(() => {
      socketFixture.statusSeq = 1
      socketFixture.status = {
        isRunning: true,
        market: { lastPrice: 120, atr1m: 10, atr5m: 15 },
        regime: { mode: 'TREND', since: now },
      }
    })
    rerender()

    // Now resolve delayed chart-data with older cache (price 100, HARVEST)
    await act(async () => {
      resolveChartData({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            priceHistory: [
              { timestamp: now - 10000, price: 100, atr1m: 5, atr5m: 8 },
            ],
            atrHistory: [
              { timestamp: now - 10000, atr1m: 5, atr5m: 8, realizedVol: 0.5, volBaseline: 0.5 },
            ],
            regimeHistory: [
              { timestamp: now - 10000, mode: 'HARVEST', since: now - 10000 },
            ],
          },
        }),
      })
    })

    await waitFor(() => expect(result.current.loading).toBe(false))

    // Both older cached sample (100) and newer live sample (120) must be present in priceHistory
    expect(result.current.priceHistory).toHaveLength(2)
    expect(result.current.priceHistory[0].price).toBe(100)
    expect(result.current.priceHistory[1].price).toBe(120)

    // Both older cached transition (HARVEST) and newer live transition (TREND) must be in regimeHistory
    expect(result.current.regimeHistory).toHaveLength(2)
    expect(result.current.regimeHistory[0].mode).toBe('HARVEST')
    expect(result.current.regimeHistory[1].mode).toBe('TREND')

    // Initial load effect should not re-trigger: /regime/chart-data called exactly once
    const chartDataCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/chart-data'))
    expect(chartDataCalls).toHaveLength(1)
  })
})

describe('Delayed chart cache integration with ChartsRegime', () => {
  it('verifies a chart retains the live interval received during loading', async () => {
    let resolveChartData
    const chartDataPromise = new Promise((resolve) => {
      resolveChartData = resolve
    })

    const now = Date.now()

    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/regime/chart-data')) {
        return chartDataPromise
      }
      if (url.includes('/regime/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: { isRunning: true, market: { lastPrice: 100 }, regime: { mode: 'HARVEST' } },
          }),
        }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, status: 200, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        return { ok: true, status: 200, json: async () => ({ buyCount: 0, sellCount: 0, pnlPoints: [] }) }
      }
      if (url.includes('/candles')) {
        return { ok: true, status: 200, json: async () => ({ candles: [] }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    // Initial render
    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" />)
    expect(screen.getByText('Loading regime charts...')).toBeTruthy()

    // While /chart-data is pending, socket delivers newer tick with price 120 and TREND mode
    act(() => {
      socketFixture.statusSeq = 1
      socketFixture.status = {
        isRunning: true,
        market: { lastPrice: 120, atr1m: 10, atr5m: 12 },
        regime: { mode: 'TREND', since: now },
      }
    })
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" />)

    // Now resolve delayed chart data with older cache (100 / HARVEST)
    await act(async () => {
      resolveChartData({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            priceHistory: [
              { timestamp: now - 10000, price: 100, atr1m: 5, atr5m: 6 },
            ],
            atrHistory: [
              { timestamp: now - 10000, atr1m: 5, atr5m: 6, realizedVol: 0.5, volBaseline: 0.5 },
            ],
            regimeHistory: [
              { timestamp: now - 10000, mode: 'HARVEST', since: now - 10000 },
            ],
          },
        }),
      })
    })

    expect(await screen.findByText('Engine Running')).toBeTruthy()

    // Verify RegimePriceChart received both cached 100 and live 120
    expect(chartCaptures.priceChartProps).not.toBeNull()
    const realtimePrices = chartCaptures.priceChartProps.priceData
    expect(realtimePrices).toHaveLength(2)
    expect(realtimePrices[0].price).toBe(100)
    expect(realtimePrices[1].price).toBe(120)

    // Verify RegimeTimeline received both cached HARVEST and live TREND
    expect(chartCaptures.timelineProps).not.toBeNull()
    const timelineData = chartCaptures.timelineProps.data
    expect(timelineData).toHaveLength(2)
    expect(timelineData[0].mode).toBe('HARVEST')
    expect(timelineData[1].mode).toBe('TREND')

    // Initial load should not re-trigger
    const chartDataCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/chart-data'))
    expect(chartDataCalls).toHaveLength(1)
  })
})
