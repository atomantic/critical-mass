import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import TransactionsRegime from '../src/components/TransactionsRegime'
import ConfigEditor from '../src/components/ConfigEditor'
import Dashboard from '../src/components/Dashboard'
import AggressivenessControl from '../src/components/regime/AggressivenessControl'
import useRegimeDashboardData from '../src/components/regime/useRegimeDashboardData'

vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on: () => {}, off: () => {}, connect: () => {}, disconnect: () => {}, emit: () => {} }),
}))
vi.mock('../src/hooks/useTradeEvents', async importOriginal => ({
  ...(await importOriginal()),
  useRegimeEvents: () => ({ status: null, setStatus: () => {} }),
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const fail = status => ({ ok: false, status, json: async () => ({}) })
const PRESETS = { conservative: { kFactor: 1 }, moderate: { kFactor: 2 }, aggressive: { kFactor: 3 }, 'ultra-aggressive': { kFactor: 4 } }

const fillsBody = {
  revision: 'r1', fills: [], cycleIds: [],
  summary: { totalBuys: 0, totalSells: 0, totalAssetBought: 0, totalBtcSold: 0, totalFees: 0, totalPnL: 0, totalHoldbackBtc: 0, totalHoldbackValue: 0 },
  pageInfo: { page: 0, pageCount: 1, total: 0, start: 0, end: 0, hasPrev: false, hasNext: false },
}

function stubTransactions({ statusDown, configDown }) {
  const state = { statusDown, configDown }
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    if (url.includes('/regime/fills')) return ok(fillsBody)
    if (url.includes('/regime/status')) return state.statusDown ? fail(503) : ok({ status: { isDryRun: true } })
    if (url.includes('/regime/open-orders')) return ok({ orders: [] })
    if (url.includes('/manual-trades')) return ok({ success: true, trades: [] })
    return state.configDown ? fail(500) : ok({ config: { productId: 'ETH-USD' } })
  }))
  return state
}

it('transactions shows an unknown dry-run notice for a failed status read and recovers on Retry', async () => {
  const state = stubTransactions({ statusDown: true })
  render(<TransactionsRegime exchange="coinbase" pair="BTC-USD" />)
  expect((await screen.findByRole('alert')).textContent).toContain('Engine status unavailable — dry-run mode unknown')
  expect(screen.queryByText(/Viewing dry-run simulated transactions/)).toBeNull()
  state.statusDown = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry status' }))
  expect(await screen.findByText(/Viewing dry-run simulated transactions/)).toBeTruthy()
  expect(screen.queryByText(/Engine status unavailable/)).toBeNull()
})

it('transactions treats a 2xx status with an unreadable body as unavailable without failing fills', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    if (url.includes('/regime/fills')) return ok(fillsBody)
    if (url.includes('/regime/status')) return { ok: true, status: 200, json: async () => { throw new Error('bad json') } }
    if (url.includes('/regime/open-orders')) return ok({ orders: [] })
    if (url.includes('/manual-trades')) return ok({ success: true, trades: [] })
    return ok({ config: { productId: 'BTC-USD' } })
  }))
  render(<TransactionsRegime exchange="coinbase" pair="BTC-USD" />)
  expect(await screen.findByText(/Engine status unavailable/)).toBeTruthy()
  expect(screen.queryByText(/Transactions unavailable/)).toBeNull()
  expect(screen.queryByText(/Open orders unavailable/)).toBeNull()
})

it('transactions uses the fund base currency from pair when the config read fails', async () => {
  stubTransactions({ configDown: true })
  render(<TransactionsRegime exchange="coinbase" pair="SOL-USD" />)
  await screen.findByText('Open Orders')
  expect(document.body.textContent).toContain('SOL')
  expect(document.body.textContent).not.toContain('BTC')
})

it('regime dashboard presets failure surfaces an error, and retry() reloads presets', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    if (url.includes('/presets/aggressiveness')) return down ? fail(500) : ok({ presets: PRESETS })
    return ok({ status: {}, config: {}, detailFills: [] })
  }))
  const { result } = renderHook(() => useRegimeDashboardData('coinbase', 'BTC-USD', '?pair=BTC-USD'))
  await waitFor(() => expect(result.current.presetsError).toContain('Presets unavailable'))
  expect(result.current.presets).toBeNull()
  down = false
  await result.current.retry()
  await waitFor(() => expect(result.current.presets).toEqual(PRESETS))
  expect(result.current.presetsError).toBeNull()
})

it('aggressiveness control shows Presets unavailable with Retry', () => {
  const retry = vi.fn()
  render(<AggressivenessControl config={{}} exchange="coinbase" pairQuery="" onConfigUpdate={vi.fn()} presets={null} presetsError="Presets unavailable (HTTP 500)" retryPresets={retry} />)
  expect(screen.getByRole('alert').textContent).toContain('Presets unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalled()
})

it('config editor shows Presets unavailable for a failed read and shows the editor after Retry', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/presets/aggressiveness')
    ? (down ? fail(500) : ok({ presets: PRESETS })) : ok({})))
  render(<ConfigEditor config={{ productId: 'BTC-USD', regime: { enabled: false } }} strategy="regime" />)
  expect((await screen.findByText(/Presets unavailable/))).toBeTruthy()
  expect(screen.queryByText('Aggressiveness Presets')).toBeNull()
  down = false
  const alert = screen.getByText(/Presets unavailable/).closest('[role="alert"]')
  fireEvent.click(alert.querySelector('button'))
  expect(await screen.findByText('Aggressiveness Presets')).toBeTruthy()
  expect(screen.queryByText(/Presets unavailable/)).toBeNull()
})

it('dca dashboard says regime status is unavailable, keeps Export hidden and recovers on Retry', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async url =>
    String(url).includes('/regime/status') ? (down ? fail(503) : ok({ running: false })) : ok({})))
  const summary = {
    config: { productId: 'BTC-USD' },
    state: { orders: [{ id: 'o1', status: 'pending', buyPrice: 1, sellPrice: 2, amount: 1, createdAt: 1 }] },
    stats: { pendingOrders: 1 }, costBasis: null, nextTrade: null,
  }
  render(<Dashboard summary={summary} onRefresh={vi.fn()} exchange="coinbase" />)
  expect(await screen.findByText(/Regime status unavailable/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Export to Regime' })).toBeNull()
  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Export to Regime' })).toBeTruthy()
  expect(screen.queryByText(/Regime status unavailable/)).toBeNull()
})
