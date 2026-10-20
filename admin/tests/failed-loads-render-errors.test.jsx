import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter } from '../src/lib/router'
import AIProviders from '../src/components/ai/Providers'
import TradeHistory from '../src/components/updown/TradeHistory'
import ScorecardAnalysis from '../src/components/updown/ScorecardAnalysis'
import SignalPanel from '../src/components/updown/SignalPanel'

vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const unavailable = { ok: false, status: 503, json: async () => ({}) }

it('AI Providers reports a failed providers read with Retry instead of "No providers configured"', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/providers') return down ? unavailable : ok({ providers: [{ id: 'p1', name: 'Example API', type: 'api', enabled: true, endpoint: 'https://api.example.com' }], activeProvider: 'p1' })
    if (url === '/api/runs?limit=20') return ok({ runs: [] })
    return ok({})
  }))
  render(<AIProviders />)
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load providers (HTTP 503).')
  expect(screen.queryByText('No providers configured.')).toBeNull()
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Example API')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('AI Providers reports a failed sample read instead of "no samples available"', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/providers') return ok({ providers: [], activeProvider: null })
    if (url === '/api/runs?limit=20') return ok({ runs: [] })
    if (url === '/api/providers/samples') throw new Error('offline')
    return ok({})
  }))
  render(<AIProviders />)
  fireEvent.click(await screen.findByRole('button', { name: 'Load Sample Providers' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load sample providers: the server is unreachable.')
  expect(screen.queryByText('No supported API sample providers are available.')).toBeNull()
})

it('trade history shows a failed read as an error, not "No trades recorded yet", and recovers on Retry', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async () => down
    ? { ok: false, status: 500, json: async () => ({}) }
    : ok({ success: true, trades: [{ id: 1, date: '2026-09-09', cost: 500, returnAmount: 600, pnl: 100 }], summary: null })))
  render(<TradeHistory />)
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load trade history.')
  expect(screen.queryByText('No trades recorded yet')).toBeNull()
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: /Edit trade from/ })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('scorecard analysis keeps the newest range when an older range response lands last', async () => {
  const pending = []
  vi.stubGlobal('fetch', vi.fn((url, { signal } = {}) => new Promise((resolve, reject) => {
    pending.push({ url, resolve })
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })))
  const analysis = predictions => ({ summary: { predictions, outcomes: 0 }, failurePatterns: [] })
  render(<BrowserRouter><ScorecardAnalysis /></BrowserRouter>)
  fireEvent.click(screen.getByRole('button', { name: '30d' }))
  const [sevenDay, thirtyDay] = pending
  await act(async () => { thirtyDay.resolve(ok(analysis(30))) })
  await act(async () => { sevenDay.resolve(ok(analysis(7))) })
  expect(await screen.findByText('30')).toBeTruthy()
  expect(screen.queryByText('7')).toBeNull()
})

it('scorecard analysis shows a failed read as an error with Retry, not "No scorecard data"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => unavailable))
  render(<BrowserRouter><ScorecardAnalysis /></BrowserRouter>)
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load scorecard analysis.')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByText('No scorecard data found for this date range.')).toBeNull()
})

it('signal history reports a failed read and keeps live signals that arrived first', async () => {
  let release
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
  const live = { timestamp: 2000, type: 'BULLISH', action: 'OPEN', score: 5 }
  render(<SignalPanel signal={live} indicators={null} position={null} />)
  await act(async () => { release(ok({ signals: [{ timestamp: 1000, type: 'NEUTRAL', score: 0 }] })) })
  expect(screen.getByText('History')).toBeTruthy()
  expect(document.querySelectorAll('.max-h-48 > div')).toHaveLength(2)
  cleanup()
  vi.stubGlobal('fetch', vi.fn(async () => unavailable))
  render(<SignalPanel signal={null} indicators={null} position={null} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Signal history unavailable.')
})
