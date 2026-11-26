import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import UpDownDashboard from '../src/components/updown/Dashboard.jsx'
import useRegimeDashboardData from '../src/components/regime/useRegimeDashboardData'

// Replaces the source-text 'dashboard request ownership wiring' block of
// tests/dashboard-request-ownership.test.js (#508): the dashboards must route
// reads through a per-mount owner so a superseded response never commits.
const realtime = vi.hoisted(() => {
  const handlers = new Map()
  return {
    handlers,
    on: (e, h) => handlers.set(e, [...(handlers.get(e) || []), h]),
    off: (e, h) => handlers.set(e, (handlers.get(e) || []).filter(x => x !== h)),
    subscribe: vi.fn(), unsubscribe: vi.fn(),
    fire: (e, p) => (handlers.get(e) || []).forEach(h => h(p)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => realtime }))
vi.mock('../src/hooks/useUpDownSocket', () => ({
  useUpDownSocket: () => ({ connected: true, tick: null, indicators: null, signal: null, scorecard: null }),
}))
vi.mock('../src/components/updown/PriceChart', () => ({ default: () => null }))
vi.mock('../src/components/updown/SignalPanel', () => ({ default: () => null }))
vi.mock('../src/components/updown/SignalBanner', () => ({ default: () => null }))
vi.mock('../src/components/updown/ContractSetup', () => ({ default: () => null }))
vi.mock('../src/components/updown/TradeHistory', () => ({ default: () => null }))
vi.mock('../src/components/updown/ScorecardPanel', () => ({ default: () => null }))
vi.mock('../src/components/updown/TimeframeGrid', () => ({ default: () => null }))
vi.mock('../src/components/updown/TimeWarningBanner', () => ({ default: () => null }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); realtime.handlers.clear() })
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

it('UpDown: a status read in flight when Stop is pressed cannot restore Running after the Stop', async () => {
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const stale = deferred()
  let statusCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url === '/api/updown/status') {
      statusCalls += 1
      if (statusCalls === 1) return json({ running: true, signalHistory: [] })
      if (statusCalls === 2) return stale.promise
      return json({ running: false, signalHistory: [] })
    }
    return json({ success: true })
  }))
  render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)
  const stop = await screen.findByRole('button', { name: 'Stop' })
  now += 2500 // past the realtime refresh throttle
  act(() => realtime.fire('updown:changed', {}))
  await waitFor(() => expect(statusCalls).toBe(2))
  fireEvent.click(stop)
  await screen.findByRole('button', { name: 'Start' })
  await act(async () => stale.resolve(json({ running: true, signalHistory: [] })))
  expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})

it('UpDown: unmounting aborts the in-flight status read', async () => {
  let signal
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    signal = options.signal
    return new Promise(() => {})
  }))
  const view = render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)
  await waitFor(() => expect(signal).toBeTruthy())
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('RegimeDashboard data hook: an older fills read that lands last does not replace the newer one', async () => {
  const reads = []
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (!url.includes('/regime/fills/cycles')) return Promise.resolve(json({}))
    const gate = deferred()
    reads.push(gate)
    return gate.promise
  }))
  const { result } = renderHook(() => useRegimeDashboardData('coinbase', 'BTC-USDC', '?pair=BTC-USDC'))
  await waitFor(() => expect(reads).toHaveLength(1))
  let second
  act(() => { second = result.current.fetchFills() })
  await waitFor(() => expect(reads).toHaveLength(2))
  const fill = id => ({ detailFills: [{ orderId: id, side: 'buy', size: 1, price: 1 }], fillCount: 1, fillCycleGroups: [] })
  await act(async () => { reads[1].resolve(json(fill('new'))); await second })
  await act(async () => { reads[0].resolve(json(fill('old'))); await Promise.resolve() })
  expect(result.current.liveFills.map(f => f.orderId)).toEqual(['new'])
})
