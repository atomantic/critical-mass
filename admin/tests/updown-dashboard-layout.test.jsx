import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import UpDownDashboard from '../src/components/updown/Dashboard.jsx'

vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on() {}, off() {}, subscribe() {}, unsubscribe() {} }),
}))
const socket = vi.hoisted(() => ({ signal: null }))
vi.mock('../src/hooks/useUpDownSocket', () => ({
  useUpDownSocket: () => ({ connected: true, tick: null, indicators: null, signal: socket.signal, scorecard: null }),
}))
const panel = vi.hoisted(() => (name) => ({ default: () => <div data-testid="panel">{name}</div> }))
vi.mock('../src/components/updown/TimeframeGrid', () => panel('TimeframeGrid'))
vi.mock('../src/components/updown/SignalPanel', () => panel('SignalPanel'))
vi.mock('../src/components/updown/TradeHistory', () => panel('TradeHistory'))
vi.mock('../src/components/updown/PriceChart', () => ({
  default: ({ signalAnnotations }) => <div data-testid="panel">PriceChart<output aria-label="Chart annotations">{signalAnnotations.map(s => `${s.type}:${s.timestamp}`).join(',')}</output></div>,
}))
vi.mock('../src/components/updown/SecondChart', () => panel('SecondChart'))
vi.mock('../src/components/updown/SignalBanner', () => panel('SignalBanner'))
vi.mock('../src/components/updown/ScorecardPanel', () => panel('ScorecardPanel'))
vi.mock('../src/components/updown/ContractSetup', () => panel('ContractSetup'))
vi.mock('../src/components/updown/PositionTracker', () => panel('PositionTracker'))
vi.mock('../src/components/updown/UpDipPanel', () => panel('UpDipPanel'))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); socket.signal = null })

it('mounts every dashboard panel once, in column order, and links to the analysis page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ running: false }) })))
  render(<BrowserRouter><UpDownDashboard /></BrowserRouter>)
  await screen.findByText('UpDown BTC Perp Longs')
  const order = screen.getAllByTestId('panel').map(el => el.textContent)
  expect(order).toEqual(['TimeframeGrid', 'SignalPanel', 'TradeHistory', 'SecondChart', 'PriceChart', 'SignalBanner', 'ContractSetup', 'PositionTracker', 'UpDipPanel', 'ScorecardPanel'])
  expect(screen.getByText('Scorecard & perp paper book').closest('details').open).toBe(false)
  expect(screen.getByRole('link', { name: /Analysis/ }).getAttribute('href')).toBe('/updown/analysis')
})

it('SignalBanner shows the action and strength label for a live signal', async () => {
  const { default: SignalBanner } = await vi.importActual('../src/components/updown/SignalBanner.jsx')
  render(<SignalBanner signal={null} indicators={{ type: 'BUY', action: 'OPEN', score: 42, confidence: 0.64, horizonPrediction: { bestHorizon: '5m' } }} />)
  expect(screen.getByText('OPEN')).toBeTruthy()
  expect(screen.getByText('Strength 64%')).toBeTruthy()
  expect(screen.getByTitle(/Heuristic signal strength: 64%/)).toBeTruthy()
  expect(screen.getByText('Best: 5m')).toBeTruthy()
})

it('annotates and plays audio for consecutive ADD fills once per event', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ running: true }) })))
  const start = vi.fn()
  vi.stubGlobal('AudioContext', class {
    createOscillator() { return { start, stop() {}, connect() {}, frequency: {} } }
    createGain() { return { gain: {}, connect() {} } }
  })
  const dashboard = () => <BrowserRouter><UpDownDashboard /></BrowserRouter>
  const { rerender } = render(dashboard())
  await screen.findByText('UpDown BTC Perp Longs')
  fireEvent.click(screen.getByRole('button', { name: /enable audio/i }))
  for (const timestamp of [100, 200, 200]) {
    socket.signal = { type: 'BUY', action: 'ADD', filled: true, timestamp }
    rerender(dashboard())
  }
  expect(screen.getByLabelText('Chart annotations').textContent).toBe('ADD:100,ADD:200')
  expect(start).toHaveBeenCalledTimes(2)
})
