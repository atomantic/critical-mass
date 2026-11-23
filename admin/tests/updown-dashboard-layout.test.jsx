import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import UpDownDashboard from '../src/components/updown/Dashboard.jsx'

vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on() {}, off() {}, subscribe() {}, unsubscribe() {} }),
}))
vi.mock('../src/hooks/useUpDownSocket', () => ({
  useUpDownSocket: () => ({ connected: true, tick: null, indicators: null, signal: null, scorecard: null }),
}))
const panel = vi.hoisted(() => (name) => ({ default: () => <div data-testid="panel">{name}</div> }))
vi.mock('../src/components/updown/TimeframeGrid', () => panel('TimeframeGrid'))
vi.mock('../src/components/updown/SignalPanel', () => panel('SignalPanel'))
vi.mock('../src/components/updown/TradeHistory', () => panel('TradeHistory'))
vi.mock('../src/components/updown/PriceChart', () => panel('PriceChart'))
vi.mock('../src/components/updown/SecondChart', () => panel('SecondChart'))
vi.mock('../src/components/updown/SignalBanner', () => panel('SignalBanner'))
vi.mock('../src/components/updown/ScorecardPanel', () => panel('ScorecardPanel'))
vi.mock('../src/components/updown/ContractSetup', () => panel('ContractSetup'))
vi.mock('../src/components/updown/PositionTracker', () => panel('PositionTracker'))
vi.mock('../src/components/updown/UpDipPanel', () => panel('UpDipPanel'))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('mounts every dashboard panel once, in column order, and links to the analysis page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ running: false }) })))
  render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)
  await screen.findByText('UpDown BTC Perp Longs')
  const order = screen.getAllByTestId('panel').map(el => el.textContent)
  const expected = ['TimeframeGrid', 'SignalPanel', 'TradeHistory', 'SecondChart', 'PriceChart', 'SignalBanner', 'ScorecardPanel', 'ContractSetup', 'PositionTracker']
  expect(order.filter(name => expected.includes(name))).toEqual(expected)
  expect(screen.getByRole('link', { name: /Analysis/ }).getAttribute('href')).toBe('/updown/analysis')
})

it('SignalBanner shows the action and strength label for a live signal', async () => {
  const { default: SignalBanner } = await vi.importActual('../src/components/updown/SignalBanner.jsx')
  render(<SignalBanner signal={null} indicators={{ type: 'BUY', action: 'OPEN', score: 42, confidence: 0.64 }} />)
  expect(screen.getByText('OPEN')).toBeTruthy()
  expect(screen.getByText('Strength 64%')).toBeTruthy()
  expect(screen.getByTitle(/Heuristic signal strength: 64%/)).toBeTruthy()
})
