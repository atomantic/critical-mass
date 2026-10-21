import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import Optimizer from '../src/components/Optimizer'
import Dashboard from '../src/components/Dashboard'
import useDcaConversion from '../src/components/regime/useDcaConversion'
import EmptyRegimeState from '../src/components/regime/EmptyRegimeState'

const toasts = []
vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: t => toasts.push(t) }) }))
vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on: () => {}, off: () => {}, connect: () => {}, disconnect: () => {}, emit: () => {} }),
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toasts.length = 0 })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body })

const cached = {
  cached: true, fundSize: 5000, cachedAt: 1, totalCombinations: 1, duration: 1000, topResults: [],
  config: { intervals: ['daily'], markups: [2], periods: ['30D'], feePercent: 0, rebatePercent: 0 },
  bestResult: { metrics: { totalValue: 1, roi: 1, fillRate: 1 }, params: { intervalType: 'daily', intervalBuyAmount: 1, sellMarkupPercent: 2, holdbackPercent: 0, period: '30D' } },
}

it('optimizer keeps results and shows the error when clearing the cache fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (opts.method === 'DELETE') return fail(500, { success: false, error: 'unlink failed' })
    return ok(cached)
  }))
  render(<Optimizer exchange="coinbase" />)
  const clear = await screen.findByRole('button', { name: /clear cache/i })
  fireEvent.click(clear)
  expect(await screen.findByText(/Could not clear cached results\. unlink failed/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /clear cache/i })).toBeTruthy()
})

it('optimizer shows an error instead of "no cached results" when the cache read returns 500', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => fail(500, { error: 'disk error' })))
  render(<Optimizer exchange="coinbase" />)
  expect(await screen.findByText(/Could not load cached optimizer results\. disk error/)).toBeTruthy()
})

it('DCA state read failure keeps dcaState null, reports the error and recovers on retry', async () => {
  let down = true
  vi.stubGlobal('fetch', vi.fn(async () => down ? fail(500, { error: 'boom', orders: [{ status: 'pending' }] }) : ok({ orders: [{ status: 'pending' }] })))
  const { result } = renderHook(() => useDcaConversion({ exchange: 'coinbase', pairQuery: '', isRunning: false, addToast: vi.fn() }))
  await waitFor(() => expect(result.current.dcaStateError).toBe('boom'))
  expect(result.current.dcaState).toBeNull()
  down = false
  result.current.retryDcaState()
  await waitFor(() => expect(result.current.dcaState).toEqual({ orders: [{ status: 'pending' }] }))
  expect(result.current.dcaStateError).toBeNull()
})

it('empty regime state shows an inline error with Retry for a failed DCA read', () => {
  const retry = vi.fn()
  render(<EmptyRegimeState isDryRun={false} dcaState={null} dcaStateError="boom" retryDcaState={retry} handlePreviewConvert={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toContain('boom')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalled()
  expect(screen.queryByText(/Upgrade DCA Orders/)).toBeNull()
})

const summary = {
  config: { productId: 'BTC-USD' },
  state: { orders: [{ id: 'o1', status: 'pending', buyPrice: 1, sellPrice: 2, amount: 1, createdAt: 1 }] },
  stats: { pendingOrders: 1 },
  costBasis: null,
  nextTrade: null,
}

it.each([[503], [504]])('dashboard hides Export to Regime when the regime status read returns %i', async status => {
  const fetchMock = vi.fn(async url => String(url).includes('/regime/status') ? fail(status, { running: false }) : ok({}))
  vi.stubGlobal('fetch', fetchMock)
  render(<Dashboard summary={summary} onRefresh={vi.fn()} exchange="coinbase" />)
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/regime/status'))).toBe(true))
  expect(await screen.findByText(/Pending Sell Orders/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Export to Regime' })).toBeNull()
})

it('dashboard shows Export to Regime when status reads successfully as not running', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/regime/status') ? ok({ running: false }) : ok({})))
  render(<Dashboard summary={summary} onRefresh={vi.fn()} exchange="coinbase" />)
  expect(await screen.findByRole('button', { name: 'Export to Regime' })).toBeTruthy()
})
