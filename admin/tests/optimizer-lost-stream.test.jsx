import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const handlers = new Map()
const socket = {
  on: (e, h) => { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e).add(h) },
  off: (e, h) => handlers.get(e)?.delete(h),
}
const emit = (e, d) => [...(handlers.get(e) || [])].forEach(h => h(d))

vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
vi.mock('../src/components/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

import Optimizer from '../src/components/Optimizer'

HTMLDialogElement.prototype.showModal = function () { this.open = true }

const LOST = /Lost contact with the optimizer run/

async function startRun() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      const { runId } = JSON.parse(opts.body)
      return { ok: true, status: 200, json: async () => ({ success: true, streaming: true, runId }) }
    }
    return { status: 200, ok: true, json: async () => ({ success: false }) }
  }))
  render(<Optimizer exchange="coinbase" pair="BTC-USD" />)
  await act(async () => {})
  const btn = screen.getByRole('button', { name: /^Run \d+ Test/ })
  await act(async () => { fireEvent.click(btn) })
  expect(screen.getAllByText('Running...').length).toBeGreaterThan(0)
}

beforeEach(() => { handlers.clear(); vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('re-enables controls and shows the message when the socket disconnects mid-run', async () => {
  await startRun()
  await act(async () => { emit('disconnect') })
  expect(screen.getByText(LOST)).toBeTruthy()
  expect(screen.queryByText('Running...')).toBeNull()
})

it('gives up after the progress silence bound and resets it on progress', async () => {
  await startRun()
  await act(async () => { vi.advanceTimersByTime(100_000) })
  await act(async () => { emit('optimizer:progress', { exchange: 'coinbase', pair: 'BTC-USD', runId: JSON.parse(fetch.mock.calls.find(c => c[1]?.method === 'POST')[1].body).runId, current: 1, total: 10 }) })
  await act(async () => { vi.advanceTimersByTime(100_000) })
  expect(screen.queryByText(LOST)).toBeNull()
  await act(async () => { vi.advanceTimersByTime(30_000) })
  expect(screen.getByText(LOST)).toBeTruthy()
  expect(screen.queryByText('Running...')).toBeNull()
})

it('a normal optimizer:complete settles the run without the lost-contact message', async () => {
  await startRun()
  const runId = JSON.parse(fetch.mock.calls.find(c => c[1]?.method === 'POST')[1].body).runId
  await act(async () => { emit('optimizer:complete', { exchange: 'coinbase', pair: 'BTC-USD', runId, totalCombinations: 1, duration: 1000, config: { intervals: ['1hour'], markups: [4], periods: ['30D'] }, topResults: [], bestResult: { metrics: { totalValue: 12345, roi: 5, fillRate: 50 }, params: { intervalType: '1hour', intervalBuyAmount: 50, sellMarkupPercent: 4, holdbackPercent: 0, period: '30D' } } }) })
  await act(async () => { vi.advanceTimersByTime(300_000); emit('disconnect') })
  expect(screen.queryByText(LOST)).toBeNull()
  expect(screen.queryByText('Running...')).toBeNull()
})

it('confirms applying the tested allocation and refreshes the fund after one write', async () => {
  const params = { intervalType: '1hour', intervals: 100, intervalBuyAmount: 50, sellMarkupPercent: 4, holdbackPercent: 0, period: '30D' }
  const results = {
    cached: true, fundSize: 5000, duration: 1000, totalCombinations: 1,
    config: { intervals: ['1hour'], markups: [4], periods: ['30D'] },
    topResults: [], bestResult: { metrics: { totalValue: 6000, roi: 20, fillRate: 50 }, params },
  }
  let finish
  const ok = body => ({ status: 200, ok: true, json: async () => body })
  const request = vi.fn(async (url, options) => options?.method === 'PUT'
    ? new Promise(resolve => { finish = () => resolve(ok({ success: true })) })
    : ok(results))
  vi.stubGlobal('fetch', request)
  const onApply = vi.fn()
  render(<Optimizer exchange="coinbase" pair="BTC-USD" onApply={onApply} />)
  const apply = await screen.findByRole('button', { name: 'Apply Best Settings to Config' })
  fireEvent.click(apply)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  const writes = () => request.mock.calls.filter(([, options]) => options?.method === 'PUT')
  expect(writes()).toHaveLength(0)
  fireEvent.click(apply)
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply Settings' })
  act(() => {
    fireEvent.click(confirm)
    fireEvent.click(confirm)
  })
  expect(confirm.disabled).toBe(true)
  expect(writes()).toHaveLength(1)
  expect(writes()[0][0]).toBe('/api/coinbase/config?pair=BTC-USD')
  expect(JSON.parse(writes()[0][1].body)).toEqual({
    totalAllocation: 5000, intervalType: '1hour', intervalsToSpread: 100, sellMarkupPercent: 4, holdbackPercent: 0,
  })
  expect(onApply).not.toHaveBeenCalled()
  await act(async () => finish())
  expect(onApply).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})
