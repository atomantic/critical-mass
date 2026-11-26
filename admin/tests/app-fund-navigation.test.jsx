import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../src/App'
import { BrowserRouter } from '../src/lib/router'

vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => true,
  useMultiRegimeStatuses: () => ({ snapshots: {}, statuses: {} }),
}))
vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ subscribe() {}, unsubscribe() {}, on() {}, off() {} }),
}))
HTMLDialogElement.prototype.showModal = function () { this.open = true }

vi.mock('../src/components/sentinel/AlertBanner', () => ({ default: () => null }))
vi.mock('../src/components/arbitrage/Dashboard', () => ({ default: () => <h1>Arbitrage dashboard</h1> }))
vi.mock('../src/components/celestial/CelestialVisualization', () => ({ default: () => null }))
vi.mock('../src/components/RegimeDashboard', () => ({ default: () => <h1>Regime dashboard</h1> }))
vi.mock('../src/components/Backtest', () => ({ default: () => <h1>DCA backtest</h1> }))
vi.mock('../src/components/ConfigEditor', () => ({
  default: ({ exchange, pair }) => <h1>Config for {exchange}/{pair}</h1>,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const response = data => ({ ok: true, status: 200, json: async () => data })
const geminiFund = { name: 'gemini', pair: 'BTCUSD', productId: 'BTCUSD', strategy: 'regime' }
const mount = path => {
  window.history.replaceState({}, '', path)
  render(<BrowserRouter><App /></BrowserRouter>)
}

it('stays on a direct Arbitrage visit after the fund list arrives', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(() => pending))
  mount('/arbitrage')
  await screen.findByRole('heading', { name: 'Arbitrage dashboard' })
  await act(async () => release(response({ exchanges: [geminiFund] })))
  expect(window.location.pathname).toBe('/arbitrage')
  expect(screen.queryByRole('navigation', { name: 'Fund views' })).toBeNull()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/exchanges'])
})

it('waits for a configured pair before redirecting a legacy exchange URL', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(url => url === '/api/exchanges'
    ? pending
    : Promise.resolve(response({ status: { isRunning: false } }))))
  mount('/gemini')
  expect(screen.getByText('Loading...').textContent).toBe('Loading...')
  expect(window.location.pathname).toBe('/gemini')
  await act(async () => release(response({ exchanges: [geminiFund] })))
  await screen.findByRole('heading', { name: 'Regime dashboard' })
  expect(window.location.pathname).toBe('/gemini/BTCUSD')
})

it('sends unmatched routes to Overview without selecting a fallback fund', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ exchanges: [] })))
  mount('/unknown/path/to/panel')
  await waitFor(() => expect(window.location.pathname).toBe('/'))
  expect(screen.queryByRole('navigation', { name: 'Fund views' })).toBeNull()
})

it('uses the selected pair strategy when switching on the same exchange', async () => {
  const dcaFunds = ['ETHUSD', 'SOLUSD'].map(productId => ({ name: 'gemini', productId, strategy: 'dca', enabled: true }))
  vi.stubGlobal('fetch', vi.fn(async url => response(url === '/api/exchanges'
    ? { exchanges: [geminiFund, ...dcaFunds], simpleDcaEnabled: true }
    : { config: {}, status: { isRunning: false } })))
  mount('/Gemini/ethusd/backtest')
  await screen.findByRole('link', { name: 'Backtest' })
  fireEvent.click(screen.getByRole('button', { name: /gemini\s*\/\s*ETHUSD/i }))
  fireEvent.click(screen.getByText('SOLUSD'))
  await waitFor(() => expect(window.location.pathname).toBe('/gemini/SOLUSD/backtest'))
  expect(screen.getByRole('link', { name: 'Backtest' }).getAttribute('href')).toBe('/gemini/SOLUSD/backtest')

  fireEvent.click(screen.getByRole('button', { name: /gemini\s*\/\s*SOLUSD/i }))
  fireEvent.click(screen.getByText('BTCUSD'))
  await waitFor(() => expect(window.location.pathname).toBe('/gemini/BTCUSD'))
  expect(screen.queryByRole('link', { name: 'Backtest' })).toBeNull()
})

it('creates a fund from Overview and waits for the shell list before opening Config', async () => {
  let created = false
  let release
  const pending = new Promise(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/exchanges') return created ? pending : response({ exchanges: [geminiFund] })
    if (url === '/api/gemini/funds' && options?.method === 'POST') {
      created = true
      return response({ success: true })
    }
    return response({ config: { productId: 'ETHUSD' }, status: { isRunning: false } })
  }))
  mount('/')
  fireEvent.click(await screen.findByRole('button', { name: '+ Add Fund' }, { timeout: 5000 }))
  const dialog = screen.getByRole('dialog', { name: 'Add Fund' })
  fireEvent.change(within(dialog).getByLabelText('Pair'), { target: { value: 'ETHUSD' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create Fund' }))
  await waitFor(() => expect(created).toBe(true))
  expect(window.location.pathname).toBe('/')
  await act(async () => release(response({ exchanges: [geminiFund, { ...geminiFund, pair: 'ETHUSD', productId: 'ETHUSD' }] })))
  await screen.findByRole('heading', { name: 'Config for gemini/ETHUSD' }, { timeout: 5000 })
  expect(window.location.pathname).toBe('/gemini/ETHUSD/config')
  expect(screen.queryByText(/No configured fund matches/)).toBeNull()
}, 12000)
