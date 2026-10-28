import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import CostBasisRegime from '../src/components/CostBasisRegime'

// Cost basis re-reads on `regime:changed` for its own fund, not on a timer.
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    subscribe: () => {},
    unsubscribe: () => {},
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))
vi.mock('../src/hooks/useTradeEvents', () => ({ useRegimeEvents: () => ({ status: { market: { lastPrice: 123 } } }) }))

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
