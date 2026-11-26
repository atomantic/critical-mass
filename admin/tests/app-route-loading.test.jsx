import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import OperatorLogin from '../src/components/OperatorLogin'
import { BrowserRouter } from '../src/lib/router'
import { preloadInitialRoute } from '../src/routeChunks'

// Route-level behaviour of the code-split shell: a shared loading announcement,
// chunk-failure recovery, and per-fund remounts of lazily loaded fund pages.
vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => true,
  useRegimeEvents: () => ({ connected: true }),
}))
vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ subscribe() {}, unsubscribe() {}, on() {}, off() {} }),
  pauseRealtimeClient: vi.fn(),
}))
vi.mock('../src/components/sentinel/AlertBanner', () => ({ default: () => null }))
const mocks = vi.hoisted(() => ({ overview: { mode: 'ok' }, mounts: [], loadLogViewer: vi.fn() }))
vi.mock('../src/components/LogViewer', () => {
  mocks.loadLogViewer()
  return { default: () => <div>Private gateway logs</div> }
})
vi.mock('../src/components/Overview', () => ({
  default: () => {
    if (mocks.overview.mode === 'throw') throw new Error('chunk failed')
    return <div>Overview page</div>
  },
}))
vi.mock('../src/components/RegimeDashboard', async () => {
  const { useEffect } = await import('react')
  function RegimeDashboard({ exchange, pair }) {
    // Mount-only on purpose: a remount, not a prop change, records a new entry.
    useEffect(() => { mocks.mounts.push(`${exchange}/${pair}`) }, []) // eslint-disable-line react-hooks/exhaustive-deps
    return <div>Regime dashboard {exchange}/{pair}</div>
  }
  return { default: RegimeDashboard }
})

const response = (data) => ({ ok: true, status: 200, json: async () => data })
const fund = (name, pair) => ({ name, pair, productId: pair, strategy: 'regime', regimeEnabled: true })

beforeEach(() => {
  mocks.overview.mode = 'ok'
  mocks.mounts.length = 0
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (url === '/api/exchanges') return Promise.resolve(response({ exchanges: [fund('coinbase', 'BTC-USDC'), fund('coinbase', 'ETH-USDC')] }))
    if (url.includes('/regime/status')) return Promise.resolve(response({ status: { isRunning: false, lifecycle: { lifecycle: 'active' } } }))
    return Promise.resolve(response({}))
  }))
})
afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = (path) => {
  window.history.replaceState({}, '', path)
  return render(<BrowserRouter><App /></BrowserRouter>)
}

it('announces route loading through a polite status region until the lazy page arrives', async () => {
  mount('/')
  const status = screen.getAllByRole('status').find(el => el.textContent === 'Loading...')
  expect(status?.getAttribute('aria-live')).toBe('polite')
  await screen.findByText('Overview page')
  expect(screen.queryByText('Loading...')).toBeNull()
})

it('starts fetching a known route while the session check gates its UI and data', async () => {
  window.history.replaceState({}, '', '/gateway/logs')
  const probe = Promise.withResolvers()
  vi.stubGlobal('fetch', vi.fn(() => probe.promise))

  preloadInitialRoute(window.location.pathname)
  render(<OperatorLogin><BrowserRouter><App /></BrowserRouter></OperatorLogin>)
  await waitFor(() => expect(mocks.loadLogViewer).toHaveBeenCalledOnce())
  expect(screen.getByText('Checking operator session…')).toBeTruthy()
  expect(screen.queryByText('Private gateway logs')).toBeNull()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session'])

  probe.resolve(response({ required: true, authenticated: false }))
  expect(await screen.findByRole('heading', { name: 'Operator sign-in' })).toBeTruthy()
})

it('recovers from a failed route with an alert and a Reload page button', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.overview.mode = 'throw'
  const reload = vi.fn()
  const original = window.location
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload, pathname: original.pathname, href: original.href } })
  try {
    mount('/')
    await screen.findByText('This page could not be loaded.')
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original })
  }
})

it('remounts the fund page when the fund changes', async () => {
  mount('/coinbase/BTC-USDC')
  await screen.findByText('Regime dashboard coinbase/BTC-USDC')
  window.history.pushState({}, '', '/coinbase/ETH-USDC')
  await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
  await screen.findByText('Regime dashboard coinbase/ETH-USDC')
  await waitFor(() => expect(mocks.mounts).toEqual(['coinbase/BTC-USDC', 'coinbase/ETH-USDC']))
})
