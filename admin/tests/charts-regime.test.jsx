import React, { Component } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
    return { ok: true, json: async () => ({ status: { isRunning: true }, config: {}, fills: [], candles: [] }) }
  }))
  render(<RenderBoundary><ChartsRegime exchange="coinbase" pair="BTC-USDC" /></RenderBoundary>)
  expect(screen.getByText('Loading regime charts...')).toBeTruthy()
  releaseFetch()
  expect(await screen.findByText('Engine Running')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Price chart')).toBeTruthy()
})
