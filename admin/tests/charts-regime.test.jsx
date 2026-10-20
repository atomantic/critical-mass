import React, { Component } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChartsRegime from '../src/components/ChartsRegime'

const fixture = vi.hoisted(() => ({ initializeFromCache: vi.fn() }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useRegimeEvents: () => ({ connected: false, status: null }) }))
vi.mock('../src/hooks/useChartDataBuffer', () => ({ useChartDataBuffer: () => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache: fixture.initializeFromCache }) }))
vi.mock('../src/components/charts/RegimePriceChart', () => ({ default: () => <div>Price chart</div> }))
vi.mock('../src/components/charts/VolatilityChart', () => ({ default: () => <div>Volatility chart</div> }))
vi.mock('../src/components/charts/RegimeTimeline', () => ({ default: () => <div>Regime timeline</div> }))

class RenderBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
