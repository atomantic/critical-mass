import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import CostBasisRegime from '../src/components/CostBasisRegime'

// Cost basis re-reads on `regime:changed` for its own fund, not on a timer.
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    subscribe: () => {},
    unsubscribe: () => {},
    listeners: (event) => [...(handlers.get(event) || [])],
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const body = (url) => {
  if (url.includes('/regime/status')) return { status: { position: {}, market: { lastPrice: 100 } } }
  if (url.includes('/regime/fills/cycles')) return { cycles: [], revision: 'r1' }
  return { config: { productId: 'BTC-USDC' } }
}

it('re-reads for its own fund only, once per throttle window, and rereads a change that lands mid-read', async () => {
  const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/regime/status')).length
  let release
  let hold = false
  const gate = () => new Promise(resolve => { release = resolve })
  const fetchMock = vi.fn(async (url) => {
    url = String(url)
    if (hold && url.includes('/regime/status')) await gate()
    return { ok: true, status: 200, json: async () => body(url) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await waitFor(() => expect(reads()).toBe(1))

  await act(async () => { socket.fire('regime:changed', { exchange: 'gemini', pair: 'BTC-USDC' }) })
  expect(reads()).toBe(1)

  await new Promise(resolve => setTimeout(resolve, 2100))
  hold = true
  await act(async () => { socket.fire('regime:changed', { exchange: 'coinbase', pair: 'BTC-USDC' }) })
  await waitFor(() => expect(reads()).toBe(2))
  // A second change while that read is still pending is queued, not dropped.
  await act(async () => { socket.fire('regime:state', { exchange: 'coinbase', pair: 'BTC-USDC' }) })
  hold = false
  await act(async () => { release() })
  await waitFor(() => expect(reads()).toBe(3), { timeout: 4000 })
})

it('keeps a newer socket price when an older HTTP batch settles later', async () => {
  let releaseFills
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    if (url.includes('/regime/fills/cycles')) {
      await new Promise(resolve => { releaseFills = resolve })
    }
    return { ok: true, status: 200, json: async () => body(url) }
  }))
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await waitFor(() => expect(releaseFills).toBeTypeOf('function'))
  await act(async () => {
    socket.fire('regime:status', { exchange: 'coinbase', pair: 'BTC-USDC', status: { isRunning: true, market: { lastPrice: 110 } } })
  })
  await act(async () => { releaseFills() })
  expect(await screen.findByText('$110.00')).toBeTruthy()
  await act(async () => {
    socket.fire('regime:status', { exchange: 'coinbase', pair: 'BTC-USDC', status: { isRunning: true, market: { lastPrice: 110 } } })
  })
  expect(screen.getByText('$110.00')).toBeTruthy()
})

it('ignores a delayed prior-fund socket callback during a new fund read', async () => {
  let releaseNewFills
  vi.stubGlobal('fetch', vi.fn(async url => {
    url = String(url)
    const isNewFund = url.includes('ETH-USDC')
    if (isNewFund && url.includes('/regime/fills/cycles')) {
      await new Promise(resolve => { releaseNewFills = resolve })
    }
    const data = url.includes('/regime/status')
      ? { status: { isRunning: true, position: {}, market: { lastPrice: isNewFund ? 200 : 100 } } }
      : url.includes('/regime/fills/cycles') ? { cycles: [], revision: 'r1' } : { config: { productId: isNewFund ? 'ETH-USDC' : 'BTC-USDC' } }
    return { ok: true, status: 200, json: async () => data }
  }))
  const { rerender } = render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  expect(await screen.findByText('$100.00')).toBeTruthy()
  await act(async () => {
    socket.fire('regime:status', { exchange: 'coinbase', pair: 'BTC-USDC', status: { isRunning: true, market: { lastPrice: 110 } } })
  })
  expect(screen.getByText('$110.00')).toBeTruthy()
  const oldHandler = socket.listeners('regime:status')[0]
  rerender(<CostBasisRegime exchange="coinbase" pair="ETH-USDC" />)
  await waitFor(() => expect(releaseNewFills).toBeTypeOf('function'))
  await act(async () => {
    oldHandler({ exchange: 'coinbase', pair: 'BTC-USDC', status: { isRunning: true, market: { lastPrice: 120 } } })
    releaseNewFills()
  })
  expect(await screen.findByText('$200.00')).toBeTruthy()
  expect(screen.queryByText('$120.00')).toBeNull()
  await act(async () => {
    socket.fire('regime:status', { exchange: 'coinbase', pair: 'ETH-USDC', status: { isRunning: true, market: { lastPrice: 210 } } })
  })
  expect(screen.getByText('$210.00')).toBeTruthy()
})
