import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import UpDownDashboard from '../src/components/updown/Dashboard.jsx'

const realtime = vi.hoisted(() => {
  const handlers = new Map()
  return {
    handlers,
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]),
    off: (event, handler) => handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    fire: (event, payload) => (handlers.get(event) || []).forEach(handler => handler(payload)),
  }
})
const feed = vi.hoisted(() => ({ tick: null }))
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => realtime }))
vi.mock('../src/hooks/useUpDownSocket', () => ({
  useUpDownSocket: () => ({ connected: true, tick: feed.tick, indicators: null, signal: null, scorecard: null }),
}))
vi.mock('../src/components/updown/PriceChart', () => ({
  default: ({ contract }) => <div data-testid="chart-target">{contract?.target ?? 'none'}</div>,
}))
vi.mock('../src/components/updown/SignalPanel', () => ({
  default: ({ position }) => <div data-testid="signal-position">{position?.entryPrice ?? 'none'}</div>,
}))
vi.mock('../src/components/updown/SignalBanner', () => ({
  default: ({ position }) => <div data-testid="banner-position">{position?.entryPrice ?? 'none'}</div>,
}))
vi.mock('../src/components/updown/TimeWarningBanner', () => ({
  parseExpiry: value => typeof value === 'number' ? value : NaN,
  default: ({ expiry, timeRemaining }) => (
    <div data-testid="countdown">{String(expiry)} / {String(timeRemaining ?? 'status expiry')}</div>
  ),
}))
vi.mock('../src/components/updown/ContractSetup', () => ({ default: () => null }))
vi.mock('../src/components/updown/TradeHistory', () => ({ default: () => null }))
vi.mock('../src/components/updown/ScorecardPanel', () => ({ default: () => null }))
vi.mock('../src/components/updown/TimeframeGrid', () => ({ default: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  realtime.handlers.clear()
  feed.tick = null
})

it('refreshes contract and position on change events while stopped, without using an older tick for countdown or P&L', async () => {
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const oldExpiry = now + 2 * 60 * 60 * 1000
  const newExpiry = now + 8 * 60 * 60 * 1000
  feed.tick = {
    price: 100,
    timestamp: now,
    timeRemaining: 2 * 60 * 60 * 1000,
    contract: { expiry: oldExpiry },
    pnl: { pnl: 999 },
  }
  let status = {
    running: false,
    contract: { expiry: oldExpiry, target: 100 },
    position: { entryPrice: 80, contracts: 1, direction: 'up' },
    signalHistory: [],
  }
  const fetch = vi.fn(async url => {
    if (url === '/api/updown/status') return { ok: true, status: 200, json: async () => structuredClone(status) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetch)

  render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)
  expect((await screen.findByTestId('chart-target')).textContent).toBe('100')
  expect(screen.getByTestId('signal-position').textContent).toBe('80')

  status = {
    ...status,
    contract: { expiry: newExpiry, target: 120 },
    position: { entryPrice: 90, contracts: 2, direction: 'up' },
  }
  now += 2000
  act(() => realtime.fire('updown:changed', { field: 'contract' }))
  await waitFor(() => expect(screen.getByTestId('chart-target').textContent).toBe('120'))
  expect(screen.getByTestId('signal-position').textContent).toBe('90')
  expect(screen.getByTestId('banner-position').textContent).toBe('90')
  expect(screen.getByTestId('countdown').textContent).toBe(`${newExpiry} / status expiry`)
  const pnlRow = screen.getByText('Contract P&L').parentElement
  expect(within(pnlRow).getByText('$0.20')).toBeTruthy()
  expect(screen.queryByText('$999.00')).toBeNull()

  status = { ...status, position: null }
  now += 2000
  act(() => realtime.fire('updown:changed', { field: 'position' }))
  await waitFor(() => expect(screen.getByTestId('signal-position').textContent).toBe('none'))
  expect(screen.getByTestId('banner-position').textContent).toBe('none')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear tracker' })).toBeNull())
  expect(fetch.mock.calls.filter(([url]) => url === '/api/updown/status')).toHaveLength(3)
})
