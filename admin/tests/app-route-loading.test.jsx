import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { BrowserRouter } from '../src/lib/router'

// Route-level behaviour of the code-split shell: a shared loading announcement,
// chunk-failure recovery, and per-fund remounts of lazily loaded fund pages.
vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => true,
  useRegimeEvents: () => ({ connected: true }),
}))
vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ subscribe() {}, unsubscribe() {}, on() {}, off() {} }),
}))
vi.mock('../src/components/sentinel/AlertBanner', () => ({ default: () => null }))
const mocks = vi.hoisted(() => ({ overview: { mode: 'ok' }, mounts: [] }))
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
