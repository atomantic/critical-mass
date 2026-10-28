import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import useRealtimeRefresh from '../src/hooks/useRealtimeRefresh'

const socket = vi.hoisted(() => {
  const handlers = new Map()
  const rooms = new Map()
  return {
    handlers,
    rooms,
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    subscribe: (room) => rooms.set(room, (rooms.get(room) || 0) + 1),
    unsubscribe: (room) => rooms.set(room, (rooms.get(room) || 0) - 1),
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
    listeners: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

function Probe(props) {
  useRealtimeRefresh(props)
  return null
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); socket.handlers.clear(); socket.rooms.clear() })

it('refreshes on listed events only, and subscribes and unsubscribes its rooms', () => {
  const onRefresh = vi.fn()
  const view = render(<Probe events={['a:changed']} rooms={['a']} onRefresh={onRefresh} />)
  expect(socket.rooms.get('a')).toBe(1)
  socket.fire('other:event')
  expect(onRefresh).not.toHaveBeenCalled()
  socket.fire('a:changed')
  expect(onRefresh).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(socket.rooms.get('a')).toBe(0)
  expect(socket.listeners()).toBe(0)
})

it('throttles event bursts to one leading and one trailing refresh, counting the mount-time read', () => {
  const onRefresh = vi.fn()
  render(<Probe events={['a:changed']} minIntervalMs={1000} onRefresh={onRefresh} />)
  act(() => { vi.advanceTimersByTime(1000) })
  socket.fire('a:changed')
  socket.fire('a:changed')
  socket.fire('a:changed')
  expect(onRefresh).toHaveBeenCalledTimes(1)
  act(() => { vi.advanceTimersByTime(1000) })
  expect(onRefresh).toHaveBeenCalledTimes(2)
  act(() => { vi.advanceTimersByTime(5000) })
  expect(onRefresh).toHaveBeenCalledTimes(2)
})

it('delays an event right after mount until the interval has passed', () => {
  const onRefresh = vi.fn()
  render(<Probe events={['a:changed']} minIntervalMs={1000} onRefresh={onRefresh} />)
  socket.fire('a:changed')
  expect(onRefresh).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1000) })
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

it('reconciles on socket reconnect and when the tab becomes visible, and not while disabled', () => {
  const onRefresh = vi.fn()
  const view = render(<Probe events={['a:changed']} onRefresh={onRefresh} />)
  socket.fire('connect')
  expect(onRefresh).toHaveBeenCalledTimes(1)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(onRefresh).toHaveBeenCalledTimes(2)
  view.rerender(<Probe events={['a:changed']} enabled={false} onRefresh={onRefresh} />)
  socket.fire('connect')
  socket.fire('a:changed')
  expect(onRefresh).toHaveBeenCalledTimes(2)
  expect(socket.listeners()).toBe(0)
})
