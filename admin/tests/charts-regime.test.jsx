import React, { Component } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChartsRegime, { deriveFillMarker } from '../src/components/ChartsRegime'

const fixture = vi.hoisted(() => ({ initializeFromCache: vi.fn(), status: null, connected: false }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useRegimeEvents: () => ({ connected: fixture.connected, status: fixture.status }) }))
vi.mock('../src/hooks/useChartDataBuffer', () => ({ useChartDataBuffer: () => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache: fixture.initializeFromCache }) }))
vi.mock('../src/components/charts/RegimePriceChart', () => ({ default: () => <div>Price chart</div> }))
vi.mock('../src/components/charts/VolatilityChart', () => ({ default: () => <div>Volatility chart</div> }))
vi.mock('../src/components/charts/RegimeTimeline', () => ({ default: () => <div>Regime timeline</div> }))

class RenderBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  fixture.status = null
  fixture.connected = false
})

it('renders the regime charts after the initial loading transition', async () => {
  let releaseFetch
  const responseReady = new Promise(resolve => { releaseFetch = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => {
    await responseReady
    return { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, buyCount: 0, sellCount: 0, pnlPoints: [], candles: [] }) }
  }))
  render(<RenderBoundary><ChartsRegime exchange="coinbase" pair="BTC-USDC" /></RenderBoundary>)
  expect(screen.getByText('Loading regime charts...')).toBeTruthy()
  releaseFetch()
  expect(await screen.findByText('Engine Running')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Price chart')).toBeTruthy()
})

it('shows a retryable error instead of stopped and zero-fill data when status fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => url.includes('/regime/status')
    ? { ok: false, status: 504, json: async () => ({}) }
    : { ok: true, json: async () => ({ config: {}, buyCount: 0, sellCount: 0, pnlPoints: [], candles: [] }) }))
  render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" />)
  expect(await screen.findByText('Error: Status fetch failed: HTTP 504')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByText('Engine Stopped')).toBeNull()
  expect(screen.queryByText('Total Entries')).toBeNull()
})

it.each(['/regime/status', '/regime/config', '/regime/fills/cycles'])('blocks the page when required read %s fails', async failedPath => {
  vi.stubGlobal('fetch', vi.fn(async url => url.includes(failedPath)
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, buyCount: 7, sellCount: 3, pnlPoints: [], candles: [] }) }))
  render(<ChartsRegime />)
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByText('Engine Running')).toBeNull()
  expect(screen.queryByText('Total Entries')).toBeNull()
})

it('retries a network failure and displays the successful snapshot', async () => {
  const fetchMock = vi.fn(async url => {
    if (fetchMock.mock.calls.filter(([called]) => called.includes('/regime/status')).length === 1) throw new Error('offline')
    return { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, buyCount: 0, sellCount: 0, pnlPoints: [], candles: [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<ChartsRegime />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Engine Running')).toBeTruthy()
})

it('keeps the last snapshot and marks it stale after a later required read fails', async () => {
  const fetchMock = vi.fn(async url => {
    const statusReads = fetchMock.mock.calls.filter(([called]) => called.includes('/regime/status')).length
    if (url.includes('/regime/status') && statusReads > 1) return { ok: false, status: 504, json: async () => ({}) }
    return { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, buyCount: 7, sellCount: 3, pnlPoints: [], candles: [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<ChartsRegime />)
  expect(await screen.findByText('Engine Running')).toBeTruthy()
  expect(screen.getByText('Total Entries').previousElementSibling.textContent).toBe('7')
  expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('3')
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/regime/fills/cycles'))).toBe(true)
  expect(fetchMock.mock.calls.some(([url]) => /\/regime\/fills(?:\?|$)/.test(url))).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })) })
  expect(screen.getByText(/Data is stale/)).toBeTruthy()
  expect(screen.getByText('Engine Running')).toBeTruthy()
  expect(screen.getByText('Total Entries').previousElementSibling.textContent).toBe('7')
})

it('reports optional candle and cache failures while retaining the dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => url.includes('/candles') || url.includes('/chart-data')
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, buyCount: 0, sellCount: 0, pnlPoints: [], candles: [] }) }))
  render(<ChartsRegime />)
  expect(await screen.findByText('Price history unavailable.')).toBeTruthy()
  expect(screen.getByText('Engine Running')).toBeTruthy()
})

describe('deriveFillMarker', () => {
  it('returns empty string when status is absent', () => {
    expect(deriveFillMarker(null)).toBe('')
    expect(deriveFillMarker(undefined)).toBe('')
  })

  it('encodes position and fill tracking fields into a stable key', () => {
    const marker = deriveFillMarker({
      position: { cyclesCompleted: 2, cycleBuys: 5, realizedPnL: 123.45, realizedAssetPnL: 0.001 },
      lastFillId: 'fill-99',
      lastFillTime: 1700000000,
      fillCount: 7,
    })
    expect(marker).toBe('2:5:123.45:0.001:fill-99:1700000000:7')
  })

  it('stays unchanged when unrelated status fields change', () => {
    const initial = {
      position: { cyclesCompleted: 1, cycleBuys: 2, realizedPnL: 50 },
      market: { lastPrice: 60000, atr1m: 100 },
      regime: { mode: 'HARVEST' },
    }
    const updated = {
      position: { cyclesCompleted: 1, cycleBuys: 2, realizedPnL: 50 },
      market: { lastPrice: 62000, atr1m: 150 },
      regime: { mode: 'CAUTION' },
      health: { mode: 'ACTIVE' },
    }
    expect(deriveFillMarker(initial)).toBe(deriveFillMarker(updated))
  })
})

describe('live fill marker refreshes', () => {
  it('triggers exactly one fills refetch and updates TPs Filled when socket fill marker advances', async () => {
    let fillsCount = 1
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 3, realizedPnL: 10 } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        return { ok: true, json: async () => ({ buyCount: 3, sellCount: fillsCount, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('1')

    const initialFillsCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length
    expect(initialFillsCalls).toBe(1)

    vi.useFakeTimers()

    // Simulate socket status update with advanced fill marker (TP filled, realizedPnL bumped)
    fillsCount = 2
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 25 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Advance timers by the full debounce duration
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    const laterFillsCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length
    expect(laterFillsCalls).toBe(initialFillsCalls + 1)
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('2')
  })

  it('does not refetch fills when unrelated status fields change', async () => {
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 25 } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        return { ok: true, json: async () => ({ buyCount: 3, sellCount: 2, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 25 },
      market: { lastPrice: 60000 },
    }
    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()

    const fillsCallsBefore = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length

    vi.useFakeTimers()

    // Update socket status with price tick and regime change, but identical position
    fixture.status = {
      ...fixture.status,
      market: { lastPrice: 61500, atr1m: 120 },
      regime: { mode: 'TREND' },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    const fillsCallsAfter = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length
    expect(fillsCallsAfter).toBe(fillsCallsBefore)
  })

  it('debounces rapid bursts of fill marker updates into a single fills refetch', async () => {
    let fillsCount = 1
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 1, realizedPnL: 10 } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        return { ok: true, json: async () => ({ buyCount: 3, sellCount: fillsCount, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()

    const initialFillsCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length
    expect(initialFillsCalls).toBe(1)

    vi.useFakeTimers()

    // Rapid burst 1: partial fill 1 at t=0
    fixture.status = { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 2, realizedPnL: 15 } }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // Rapid burst 2: partial fill 2 at t=500ms (before 1500ms debounce)
    fixture.status = { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 3, realizedPnL: 20 } }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // Rapid burst 3: terminal fill at t=1000ms
    fillsCount = 3
    fixture.status = { isRunning: true, position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 35 } }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Wait for the final debounce to settle (1500ms from the last burst at t=1000ms)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    const finalFillsCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/regime/fills/cycles')).length
    // Exactly ONE refetch occurred despite 3 rapid updates
    expect(finalFillsCalls).toBe(initialFillsCalls + 1)
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('3')
  })

  it('causes one trailing read and updates counts and P&L when two fills span a pending fills read', async () => {
    let fillsResolve = null
    let fillsCalls = 0
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 3, realizedPnL: 10 } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        fillsCalls++
        if (fillsCalls === 1) {
          // initial snapshot
          return { ok: true, json: async () => ({ buyCount: 3, sellCount: 1, pnlPoints: [{ timestamp: 1000, pnl: 10, cumulative: 10 }] }) }
        }
        if (fillsCalls === 2) {
          // hold second call
          return new Promise(resolve => {
            fillsResolve = resolve
          })
        }
        // third call (trailing read)
        return { ok: true, json: async () => ({ buyCount: 5, sellCount: 4, pnlPoints: [{ timestamp: 1000, pnl: 10, cumulative: 10 }, { timestamp: 2000, pnl: 40, cumulative: 50 }] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('1')
    expect(screen.getByText('Total Entries').previousElementSibling.textContent).toBe('3')

    vi.useFakeTimers()

    // 1. First fill advances socket marker
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 20 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Debounce expires -> starts second fills read (which is held)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(fillsCalls).toBe(2)

    // 2. Second fill arrives while read 2 is pending
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 3, cycleBuys: 4, realizedPnL: 35 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // 3. Third fill arrives 500ms later, still while read 2 is pending
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 4, cycleBuys: 5, realizedPnL: 50 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Advance by remaining debounce (1500ms from fill 3) -> debounce expires while read 2 is still held
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    // No new read yet because read 2 is still in flight
    expect(fillsCalls).toBe(2)

    // 4. Release older response for read 2
    await act(async () => {
      fillsResolve({
        ok: true,
        json: async () => ({ buyCount: 3, sellCount: 2, pnlPoints: [{ timestamp: 1000, pnl: 10, cumulative: 10 }, { timestamp: 1500, pnl: 10, cumulative: 20 }] }),
      })
    })

    // Read 3 (trailing read) must have fired automatically and settled
    expect(fillsCalls).toBe(3)
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('4')
    expect(screen.getByText('Total Entries').previousElementSibling.textContent).toBe('5')
    expect(screen.getByText('Cycles').previousElementSibling.textContent).toBe('4')
    expect(screen.getByText('Realized P&L').previousElementSibling.textContent).toBe('$50.00')
  })

  it('retains and refreshes fills when a marker arrives while the full page read is pending', async () => {
    let statusResolve = null
    let fillsCalls = 0
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return new Promise(resolve => {
          statusResolve = resolve
        })
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        fillsCalls++
        if (fillsCalls === 1) {
          // initial page snapshot fills
          return { ok: true, json: async () => ({ buyCount: 2, sellCount: 1, pnlPoints: [] }) }
        }
        // trailing fills
        return { ok: true, json: async () => ({ buyCount: 3, sellCount: 2, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(screen.getByText('Loading regime charts...')).toBeTruthy()

    vi.useFakeTimers()

    // While full page read is pending, socket emits a fill marker
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 3, realizedPnL: 25 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Advance 1500ms debounce while page read is still pending
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(fillsCalls).toBe(1) // only initial page read requested fills so far

    // Now release initial page status
    await act(async () => {
      statusResolve({
        ok: true,
        json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 2, realizedPnL: 10 } } }),
      })
    })

    // Full page read finishes, trailing fills read fires
    expect(fillsCalls).toBe(2)
    expect(screen.getByText('Engine Running')).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('2')
    expect(screen.getByText('Total Entries').previousElementSibling.textContent).toBe('3')
  })

  it('preserves data on failed read, displays stale notice, and satisfies pending marker upon retry', async () => {
    let fillsFails = false
    let fillsCalls = 0
    let statusPosition = { cyclesCompleted: 1, cycleBuys: 4, realizedPnL: 10 }
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: statusPosition } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        fillsCalls++
        if (fillsFails) {
          return { ok: false, status: 503, json: async () => ({}) }
        }
        return { ok: true, json: async () => ({ buyCount: 4, sellCount: fillsCalls === 1 ? 1 : 2, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('1')

    vi.useFakeTimers()

    // Socket advances marker
    fillsFails = true
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 4, realizedPnL: 30 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)

    // Advance debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    // Last-good view is preserved, but marked stale with Refresh Now button
    expect(screen.getByText(/Data is stale/)).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('1')
    expect(screen.getByRole('button', { name: 'Refresh Now' })).toBeTruthy()

    // Inline retry: fix network and click Refresh Now
    fillsFails = false
    statusPosition = { cyclesCompleted: 2, cycleBuys: 4, realizedPnL: 30 }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Now' }))
    })

    // Refreshed snapshot satisfies pending marker and clears stale state
    expect(screen.queryByText(/Data is stale/)).toBeNull()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('2')
  })

  it('cancels pending work and prevents trailing read when component is unmounted', async () => {
    let fillsResolve = null
    let fillsCalls = 0
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: 1, cycleBuys: 2, realizedPnL: 10 } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        fillsCalls++
        if (fillsCalls === 1) {
          return { ok: true, json: async () => ({ buyCount: 2, sellCount: 1, pnlPoints: [] }) }
        }
        return new Promise(resolve => {
          fillsResolve = resolve
        })
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender, unmount } = render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()

    vi.useFakeTimers()

    // Trigger fills refresh 1
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 2, cycleBuys: 2, realizedPnL: 20 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(fillsCalls).toBe(2)

    // While refresh 1 is pending, trigger marker for fill 2
    fixture.status = {
      isRunning: true,
      position: { cyclesCompleted: 3, cycleBuys: 2, realizedPnL: 30 },
    }
    rerender(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    // Unmount before releasing held request
    unmount()

    // Release held read
    await act(async () => {
      fillsResolve({ ok: true, json: async () => ({ buyCount: 2, sellCount: 2, pnlPoints: [] }) })
    })

    // Trailing read must NOT be executed after unmount
    expect(fillsCalls).toBe(2)
  })

  it('does not issue redundant fills read when page refresh loads changed marker while socket is disconnected', async () => {
    let fillsCalls = 0
    let currentCycles = 1
    const fetchMock = vi.fn(async url => {
      if (url.includes('/regime/status')) {
        return { ok: true, json: async () => ({ status: { isRunning: true, position: { cyclesCompleted: currentCycles, cycleBuys: 2, realizedPnL: 10 * currentCycles } } }) }
      }
      if (url.includes('/regime/config')) {
        return { ok: true, json: async () => ({ config: {} }) }
      }
      if (url.includes('/regime/fills/cycles')) {
        fillsCalls++
        return { ok: true, json: async () => ({ buyCount: 2, sellCount: currentCycles, pnlPoints: [] }) }
      }
      return { ok: true, json: async () => ({ candles: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    fixture.status = null // WebSocket disconnected
    render(<ChartsRegime exchange="coinbase" pair="BTC-USDC" fillDebounceMs={1500} />)
    expect(await screen.findByText('Engine Running')).toBeTruthy()
    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('1')
    expect(fillsCalls).toBe(1)

    vi.useFakeTimers()

    // Trigger manual refresh where server has updated data
    currentCycles = 2
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })

    expect(screen.getByText('TPs Filled').previousElementSibling.textContent).toBe('2')
    expect(fillsCalls).toBe(2) // 1 initial + 1 from Refresh button (fetchData), NO trailing redundant fills call

    // Advance timers by more than fillDebounceMs to confirm no trailing debounce was scheduled
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(fillsCalls).toBe(2)
  })
})
