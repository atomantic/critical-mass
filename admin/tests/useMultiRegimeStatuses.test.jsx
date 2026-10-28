import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMultiRegimeStatuses, useRegimeEvents } from '../src/hooks/useTradeEvents'

const socket = vi.hoisted(() => ({
  connected: true,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  handlers: new Map(),
  on: vi.fn((event, handler) => {
    const listeners = socket.handlers.get(event) || new Set()
    listeners.add(handler)
    socket.handlers.set(event, listeners)
  }),
  off: vi.fn((event, handler) => socket.handlers.get(event)?.delete(handler)),
  emit(event, payload) {
    for (const handler of socket.handlers.get(event) || []) handler(payload)
  },
}))

vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

afterEach(() => {
  cleanup()
  socket.handlers.clear()
  socket.on.mockClear()
  socket.off.mockClear()
  socket.subscribe.mockClear()
  socket.unsubscribe.mockClear()
})

describe('useMultiRegimeStatuses', () => {
  it('renders with the real hook, receives status events, and removes its listeners on unmount', () => {
    const { result, unmount } = renderHook(() => useMultiRegimeStatuses())

    expect(result.current.connected).toBe(true)
    expect(socket.subscribe).toHaveBeenCalledWith('regime:status:all')
    expect(socket.on.mock.calls.map(([event]) => event)).toEqual([
      'connect', 'disconnect', 'regime:status',
    ])
    expect(socket.handlers.get('regime:status').size).toBe(1)

    const status = { isRunning: true, position: { totalCostBasis: 42 } }
    act(() => socket.emit('regime:status', { exchange: 'coinbase', pair: 'BTC-USDC', status }))

    expect(result.current.statuses['coinbase::BTC-USDC']).toEqual(status)

    unmount()

    expect(socket.unsubscribe).toHaveBeenCalledWith('regime:status:all')
    expect(socket.handlers.get('connect').size).toBe(0)
    expect(socket.handlers.get('disconnect').size).toBe(0)
    expect(socket.handlers.get('regime:status').size).toBe(0)
    expect(socket.off.mock.calls.map(([event]) => event)).toEqual([
      'connect', 'disconnect', 'regime:status',
    ])
  })
})


it('moves dashboard subscriptions when the fund changes and releases them on unmount', () => {
  const { rerender, unmount } = renderHook(({ exchange, pair }) => useRegimeEvents(exchange, pair),
    { initialProps: { exchange: 'gemini', pair: 'BTCUSD' } })
  expect(socket.subscribe).toHaveBeenCalledWith('regime:status:gemini:BTCUSD')
  rerender({ exchange: 'gemini', pair: 'ETHUSD' })
  expect(socket.unsubscribe).toHaveBeenCalledWith('regime:status:gemini:BTCUSD')
  expect(socket.subscribe).toHaveBeenCalledWith('regime:status:gemini:ETHUSD')
  unmount()
  expect(socket.unsubscribe).toHaveBeenCalledWith('regime:status:gemini:ETHUSD')
})

it('fences old-fund socket and action snapshots while retaining new-fund updates across reconnects', () => {
  const { result, rerender } = renderHook(({ pair }) => useRegimeEvents('gemini', pair),
    { initialProps: { pair: 'BTCUSD' } })
  act(() => socket.emit('regime:status', { exchange: 'gemini', pair: 'BTCUSD', status: { isRunning: true, risk: { old: true }, market: { lastPrice: 100 } } }))
  expect(result.current.status.market.lastPrice).toBe(100)
  const oldHandler = [...socket.handlers.get('regime:status')][0]
  const oldSetStatus = result.current.setStatus

  rerender({ pair: 'ETHUSD' })
  expect(result.current.status).toBeNull()
  expect(result.current.statusSeq).toBe(0)
  act(() => oldHandler({ exchange: 'gemini', pair: 'BTCUSD', status: { isRunning: true, market: { lastPrice: 101 } } }))
  expect(result.current.status).toBeNull()

  act(() => socket.emit('regime:status', { exchange: 'gemini', pair: 'ETHUSD', status: { isRunning: true, market: { lastPrice: 200 } } }))
  expect(result.current.status.market.lastPrice).toBe(200)
  expect(result.current.status.risk).toBeUndefined()
  act(() => oldSetStatus({ isRunning: false, market: { lastPrice: 1 } }))
  expect(result.current.status.market.lastPrice).toBe(200)

  act(() => result.current.setStatus({ isRunning: false, market: { lastPrice: 201 } }))
  expect(result.current.status).toEqual({ isRunning: false, market: { lastPrice: 201 } })
  act(() => socket.emit('disconnect'))
  expect(result.current.connected).toBe(false)
  expect(result.current.status.market.lastPrice).toBe(201)
  act(() => socket.emit('connect'))
  expect(result.current.connected).toBe(true)
  expect(result.current.status.market.lastPrice).toBe(201)
})
