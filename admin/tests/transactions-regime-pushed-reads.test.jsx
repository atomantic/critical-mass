import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import TransactionsRegime from '../src/components/TransactionsRegime'

// Replaces the source-text 'audit model stays aligned with the UI' test in
// tests/perf-route-audit.test.js: Transactions reads a 100-row page plus the
// fund config, and re-reads on a pushed regime:changed rather than a timer.
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    on: (e, h) => { handlers.set(e, [...(handlers.get(e) || []), h]) },
    off: (e, h) => { handlers.set(e, (handlers.get(e) || []).filter(x => x !== h)) },
    subscribe: () => {}, unsubscribe: () => {},
    fire: (e, p) => (handlers.get(e) || []).forEach(h => h(p)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const response = body => ({ ok: true, status: 200, json: async () => body })

it('reads a 100-row page and the fund config, and re-reads only on a pushed regime:changed', async () => {
  vi.useFakeTimers()
  const urls = []
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    urls.push(url)
    if (url.includes('/regime/fills?')) {
      return response({ fills: [], summary: { totalBuys: 0, totalSells: 0 }, pageInfo: { page: 0, pageSize: 100, total: 0, totalPages: 1 }, cycleIds: [], revision: 'r1' })
    }
    if (url.includes('/regime/status')) return response({ status: { isDryRun: false } })
    if (url.includes('/regime/open-orders')) return response({ orders: [] })
    if (url.includes('/manual-trades')) return response({ success: true, trades: [] })
    return response({ config: { productId: 'BTC-USDC' } })
  }))
  await act(async () => { render(<TransactionsRegime exchange="coinbase" pair="BTC-USDC" />) })
  expect(urls.some(u => u.includes('/regime/fills?'))).toBe(true)
  expect(urls.some(u => /\/api\/coinbase\/config\?pair=BTC-USDC/.test(u))).toBe(true)
  const fillsReads = () => urls.filter(u => u.includes('/regime/fills?'))
  expect(new URL(fillsReads()[0], 'http://localhost').searchParams.get('pageSize')).toBe('100')
  const before = fillsReads().length

  // Idle: no short-interval timer re-read (longer intervals are barred by tests/no-admin-polling.test.js).
  await act(() => vi.advanceTimersByTimeAsync(2300))
  expect(fillsReads().length).toBe(before)

  await act(async () => { socket.fire('regime:changed', { exchange: 'coinbase', pair: 'BTC-USDC' }) })
  expect(fillsReads().length).toBe(before + 1)
})

it('labels a resting ladder buy as an entry', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.includes('/regime/open-orders')) {
      return response({ orders: [{ orderId: 'ladder-buy', type: 'ladder_entry', side: 'buy', size: 0.01, price: 50000 }] })
    }
    if (url.includes('/regime/fills?')) return response({ fills: [], pageInfo: { total: 0, totalPages: 1 } })
    if (url.includes('/regime/status')) return response({ status: { isDryRun: false } })
    if (url.includes('/manual-trades')) return response({ trades: [] })
    return response({ config: { productId: 'BTC-USDC' } })
  }))
  render(<TransactionsRegime exchange="coinbase" pair="BTC-USDC" />)
  const row = (await screen.findByText('ladder-buy')).closest('tr')
  expect(within(row).getByTitle('Limit buy entry order').textContent).toBe('Entry')
  expect(within(row).queryByText('TP')).toBeNull()
})
