import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { BrowserRouter } from '../src/lib/router'
// Warm the real lazy route before testing its requests and rendered values.
import '../src/components/ConfigEditor'

// The shell must read fund data only on fund routes, once the fund list names
// the fund. Global pages are stubbed: only the shell's own requests matter.
vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => true,
  useRegimeEvents: () => ({ connected: true }),
}))
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    handlers,
    subscribe: () => {},
    unsubscribe: () => {},
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
vi.mock('../src/components/Overview', () => ({ default: () => <div>Overview page</div> }))
vi.mock('../src/components/NotificationsConfig', () => ({ default: () => <div>Notifications page</div> }))
vi.mock('../src/components/BackupRestore', () => ({ default: () => <div>Backups page</div> }))
vi.mock('../src/components/Systems', () => ({ default: () => <div>Systems page</div> }))
vi.mock('../src/components/RegimeDashboard', () => ({
  default: function RegimeDashboardFixture({ exchange, pair, readInitialStatus }) {
    const [loaded, setLoaded] = React.useState(false)
    return (
      <div>
        Regime dashboard
        <button onClick={async () => {
          const result = await readInitialStatus(`/api/${exchange}/regime/status?pair=${encodeURIComponent(pair)}`)
          setLoaded(result.ok)
        }}>Read initial route status</button>
        {loaded && <span>Route status loaded</span>}
      </div>
    )
  },
}))
vi.mock('../src/components/Dashboard', () => ({ default: ({ summary }) => <div>DCA dashboard {summary?.marker}</div> }))
vi.mock('../src/components/sentinel/AlertBanner', () => ({ default: () => null }))

const response = (data, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => data })
const regimeFund = (name, pair = 'BTC-USDC') => ({ name, pair, productId: pair, strategy: 'regime', regimeEnabled: true })
let exchangesPayload
let urls

beforeEach(() => {
  urls = []
  exchangesPayload = { exchanges: [regimeFund('coinbase')] }
  vi.stubGlobal('fetch', vi.fn((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return Promise.resolve(response(exchangesPayload))
    if (url.includes('/regime/status')) return Promise.resolve(response({ status: { isRunning: false, isDryRun: false, lifecycle: { lifecycle: 'active' } } }))
    if (url.includes('/summary')) return Promise.resolve(response({ marker: 'summary', config: { productId: 'BTC-USDC', regime: { enabled: true, baseSizeUsdc: 111 } } }))
    return Promise.resolve(response({}))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = (path) => {
  window.history.replaceState({}, '', path)
  return render(<BrowserRouter><App /></BrowserRouter>)
}
const fundReads = () => urls.filter(url => url.includes('/summary') || url.includes('/regime/status'))
const exchangeReads = () => urls.filter(url => url === '/api/exchanges')
const settle = async () => {
  await waitFor(() => expect(exchangeReads().length).toBeGreaterThan(0))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}

for (const [path, text] of [['/', 'Overview page'], ['/backups', 'Backups page'], ['/notifications', 'Notifications page'], ['/systems', 'Systems page']]) {
  it(`${path} reads no fund data and shows no fund banner or sub-nav`, async () => {
    mount(path)
    await screen.findByText(text)
    await settle()
    expect(fundReads()).toEqual([])
    expect(screen.queryByRole('navigation', { name: 'Fund views' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close Fund' })).toBeNull()
  })
}

for (const path of ['/', '/backups', '/notifications', '/systems']) {
  it(`${path} with zero funds configured shows no error banner`, async () => {
    exchangesPayload = { exchanges: [] }
    mount(path)
    await settle()
    expect(fundReads()).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Could not load/)).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Fund views' })).toBeNull()
  })
}

it('does not render global pages behind a pending fund request', async () => {
  // A fund read that never settles must not hold a global page.
  fetch.mockImplementation((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return Promise.resolve(response(exchangesPayload))
    return new Promise(() => {})
  })
  mount('/backups')
  expect(await screen.findByText('Backups page')).toBeTruthy()
})

it('reads nothing for a fund the list does not name and says so', async () => {
  mount('/coinbase/ETH-USDC')
  await screen.findByText(/No configured fund matches/)
  await settle()
  expect(fundReads()).toEqual([])
  expect(screen.queryByText('Regime dashboard')).toBeNull()
})

it('reads nothing on a fund route until the fund list has loaded', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  fetch.mockImplementation((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return gate.then(() => response(exchangesPayload))
    return Promise.resolve(response({ status: { isRunning: false, lifecycle: { lifecycle: 'active' } }, config: {} }))
  })
  mount('/coinbase/BTC-USDC')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(fundReads()).toEqual([])
  await act(async () => release())
  await screen.findByText('Regime dashboard')
  await waitFor(() => expect(urls.some(url => url.includes('/regime/status'))).toBe(true))
})

it('keeps the regime summary off the dashboard, reads it for Config, and never re-reads the fund list per summary', async () => {
  mount('/coinbase/BTC-USDC')
  await screen.findByText('Regime dashboard')
  await screen.findByRole('button', { name: 'Start', exact: true })
  expect(urls.some(url => url.includes('/summary'))).toBe(false)
  // A pushed event for the fund must not trigger summary reads off the Config tab.
  await act(async () => socket.fire('trade:event', { exchange: 'coinbase', pair: 'BTC-USDC' }))
  expect(urls.some(url => url.includes('/summary'))).toBe(false)

  fireEvent.click(screen.getByRole('link', { name: 'Config' }))
  // Include the first lazy Config import on a busy test worker.
  await screen.findByDisplayValue('111', {}, { timeout: 5000 })
  expect(urls.filter(url => url.includes('/summary'))).toEqual(['/api/coinbase/summary?pair=BTC-USDC'])
  expect(exchangeReads()).toHaveLength(1)
})

it('keeps the realtime summary refresh for DCA funds', async () => {
  exchangesPayload = {
    simpleDcaEnabled: true,
    exchanges: [{ name: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', strategy: 'dca', enabled: true }],
  }
  mount('/coinbase/BTC-USDC')
  await screen.findByText('DCA dashboard summary')
  expect(urls.filter(url => url.includes('/summary'))).toHaveLength(1)
  expect(urls.some(url => url.includes('/regime/status'))).toBe(false)
  expect(exchangeReads()).toHaveLength(1)
})

it('drops fund banners, sub-nav and status when navigating from a fund to a global page', async () => {
  fetch.mockImplementation((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return Promise.resolve(response(exchangesPayload))
    if (url.includes('/regime/status')) return Promise.resolve(response({}, false, 502))
    return Promise.resolve(response({}))
  })
  mount('/coinbase/BTC-USDC')
  await screen.findByText('Failed to fetch engine status')
  expect(screen.getByRole('navigation', { name: 'Fund views' })).toBeTruthy()
  fireEvent.click(screen.getAllByRole('link', { name: 'Backups' })[0])
  await screen.findByText('Backups page')
  expect(screen.queryByText('Failed to fetch engine status')).toBeNull()
  expect(screen.queryByRole('navigation', { name: 'Fund views' })).toBeNull()
})

it('discards a status read that was in flight when the operator left the fund for a global page', async () => {
  let resolveStatus
  fetch.mockImplementation((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return Promise.resolve(response(exchangesPayload))
    if (url.includes('/regime/status')) return new Promise(resolve => { resolveStatus = () => resolve(response({ status: { isRunning: true, lifecycle: { lifecycle: 'active' } } })) })
    return Promise.resolve(response({}))
  })
  mount('/coinbase/BTC-USDC')
  await waitFor(() => expect(resolveStatus).toBeTypeOf('function'))
  fireEvent.click(screen.getAllByRole('link', { name: 'Backups' })[0])
  await screen.findByText('Backups page')
  await act(async () => resolveStatus())
  // Back on the fund, the fresh read (not the stale one) decides the header.
  fetch.mockImplementation((url) => {
    urls.push(url)
    if (url === '/api/exchanges') return Promise.resolve(response(exchangesPayload))
    if (url.includes('/regime/status')) return Promise.resolve(response({ status: { isRunning: false, lifecycle: { lifecycle: 'active' } } }))
    return Promise.resolve(response({}))
  })
  fireEvent.click(screen.getAllByRole('link', { name: 'Funds' })[0])
  await screen.findByText('Overview page')
  window.history.pushState({}, '', '/coinbase/BTC-USDC')
  await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(await screen.findByRole('button', { name: 'Start', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop', exact: true })).toBeNull()
})

it('shares the shell status response when the lazy route reads it after settlement', async () => {
  mount('/coinbase/BTC-USDC')
  await screen.findByRole('button', { name: 'Start', exact: true })
  fireEvent.click(await screen.findByRole('button', { name: 'Read initial route status' }))
  await screen.findByText('Route status loaded')
  expect(fundReads()).toEqual(['/api/coinbase/regime/status?pair=BTC-USDC'])
})
