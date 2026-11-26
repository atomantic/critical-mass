import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import useBtcSeconds from '../src/hooks/useBtcSeconds'

const socket = vi.hoisted(() => {
  const handlers = new Map()
  const rooms = []
  return {
    rooms,
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler) },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    subscribe: (room) => rooms.push(room),
    unsubscribe: (room) => rooms.splice(rooms.indexOf(room), 1),
    fire: (event, payload) => [...(handlers.get(event) || [])].forEach(handler => handler(payload)),
    count: (event) => handlers.get(event)?.size ?? 0,
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

const api = vi.hoisted(() => ({ calls: [] }))
vi.mock('../src/utils/apiClient', () => ({
  apiGet: (url, { signal } = {}) => new Promise((resolve, reject) => {
    api.calls.push({ url, resolve, signal })
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }),
}))

const T0 = 1_800_000_000_000
const bar = (sec, close) => ({ t: T0 + sec * 1000, open: close, high: close, low: close, close, buyVolume: 1, sellVolume: 0, trades: 1 })
const status = (over = {}) => ({ running: true, now: T0, coinbase: { connected: true, lastEventAt: T0 - 400 }, index: { connected: true, lastEventAt: T0 - 900 }, ...over })
const reply = (i, data) => act(async () => { api.calls[i].resolve({ ok: true, data: { success: true, bars: [], index: [], status: status(), ...data } }) })
const push = (data) => act(async () => { socket.fire('btc-feed:update', { bars: [], index: [], status: status(), ...data }) })

beforeEach(() => {
  api.calls.length = 0
  vi.useFakeTimers({ now: T0 })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('reads the window, then applies updates by second', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  expect(api.calls[0].url).toBe('/api/btc-feed/seconds?seconds=300')
  await reply(0, { bars: [bar(-2, 100), bar(-1, 101)], index: [{ t: T0 - 1000, value: 99 }] })
  await push({ bars: [bar(-1, 105), bar(0, 106)] })
  expect(result.current.bars.map(b => b.close)).toEqual([100, 105, 106])
  expect(result.current.index).toEqual([{ t: T0 - 1000, value: 99 }])
})

it('takes ages from the gateway clock, not the browser clock', async () => {
  vi.setSystemTime(T0 + 3_600_000)
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0)
  expect(result.current.ages).toEqual({ coinbase: 400, index: 900 })
  expect(result.current.nowMs).toBe(T0)
})

it('keeps aging while no update arrives', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0)
  await act(async () => { vi.advanceTimersByTime(11_000) })
  expect(result.current.ages.coinbase).toBeGreaterThan(10_000)
  expect(result.current.nowMs).toBeGreaterThanOrEqual(T0 + 10_500)
})

it('has no age before the first event', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  expect(result.current.ages).toEqual({ coinbase: null, index: null })
  await reply(0, { status: status({ coinbase: { connected: false, lastEventAt: null } }) })
  expect(result.current.ages.coinbase).toBeNull()
})

it('keeps an update that arrives while the read is pending over an older REST bar', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await push({ bars: [bar(0, 200)] })
  await reply(0, { bars: [bar(-1, 100), bar(0, 150)] })
  expect(result.current.bars.map(b => b.close)).toEqual([100, 200])
})

it('ages an update from when it was received, however late the read replies', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await act(async () => { vi.advanceTimersByTime(1000) })
  await push({ bars: [bar(1, 200)], status: status({ now: T0 + 1000, coinbase: { connected: true, lastEventAt: T0 + 900 } }) })
  await act(async () => { vi.advanceTimersByTime(8000) })
  await reply(0, { status: status({ now: T0 + 500, coinbase: { connected: true, lastEventAt: T0 + 400 } }) })
  expect(result.current.ages.coinbase).toBeGreaterThanOrEqual(8000)
})

it('counts a slow reply against the age instead of treating it as instant', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await act(async () => { vi.advanceTimersByTime(6000) })
  await reply(0)
  expect(result.current.ages.coinbase).toBeGreaterThanOrEqual(6000)
})

it('shows updates while a read is still pending', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await push({ bars: [bar(0, 200)] })
  expect(result.current.bars.map(b => b.close)).toEqual([200])
})

it('gives up on a hung read after 10s and retries 5s later', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await act(async () => { vi.advanceTimersByTime(9_999) })
  expect(result.current.error).toBe(null)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(result.current.error).toMatch(/timed out/i)
  expect(api.calls).toHaveLength(1)
  await act(async () => { vi.advanceTimersByTime(5_000) })
  expect(api.calls).toHaveLength(2)
  await reply(1, { bars: [bar(0, 7)] })
  expect(result.current.error).toBe(null)
  expect(result.current.bars).toHaveLength(1)
})

it('retries a failed read and stops retrying after unmount', async () => {
  const { unmount } = renderHook(() => useBtcSeconds(300))
  await act(async () => { api.calls[0].resolve({ ok: false, data: null, error: 'gateway down' }) })
  await act(async () => { vi.advanceTimersByTime(5_000) })
  expect(api.calls).toHaveLength(2)
  await act(async () => { api.calls[1].resolve({ ok: false, data: null, error: 'gateway down' }) })
  unmount()
  await act(async () => { vi.advanceTimersByTime(60_000) })
  expect(api.calls).toHaveLength(2)
})

it('re-reads after a realtime reconnect', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0, { bars: [bar(-10, 100)] })
  await act(async () => { socket.fire('connect') })
  expect(api.calls).toHaveLength(2)
  await reply(1, { bars: [bar(-10, 100), bar(-5, 103)] })
  expect(result.current.bars.map(b => b.close)).toEqual([100, 103])
})

it('ignores a late response for a previous range', async () => {
  const { result, rerender } = renderHook(({ range }) => useBtcSeconds(range), { initialProps: { range: 300 } })
  rerender({ range: 900 })
  expect(api.calls[1].url).toBe('/api/btc-feed/seconds?seconds=900')
  await reply(1, { bars: [bar(-1, 111)] })
  await reply(0, { bars: [bar(-1, 999)] })
  expect(result.current.bars.map(b => b.close)).toEqual([111])
})

it('drops bars that have left the range', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0, { bars: [bar(-299, 1), bar(0, 2)] })
  await push({ bars: [bar(60, 3)], status: status({ now: T0 + 60_000 }) })
  expect(result.current.bars.map(b => b.close)).toEqual([2, 3])
})

it('reports a failed read and keeps existing bars', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0, { bars: [bar(0, 5)] })
  await act(async () => { socket.fire('connect') })
  await act(async () => { api.calls[1].resolve({ ok: false, data: null, error: 'gateway down' }) })
  expect(result.current.error).toBe('gateway down')
  expect(result.current.bars).toHaveLength(1)
  await act(async () => { socket.fire('connect') })
  await reply(2, { bars: [bar(0, 5)] })
  expect(result.current.error).toBe(null)
})

it('keeps updates buffered by a read that a failed reconnect read overtook', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await push({ bars: [bar(0, 200)] })
  await act(async () => { socket.fire('connect') })
  await act(async () => { api.calls[1].resolve({ ok: false, data: null, error: 'gateway down' }) })
  expect(result.current.bars.map(b => b.close)).toEqual([200])
})

it('ignores a malformed update', async () => {
  const { result } = renderHook(() => useBtcSeconds(300))
  await reply(0, { bars: [bar(0, 5)] })
  await act(async () => { socket.fire('btc-feed:update', undefined); socket.fire('btc-feed:update', {}) })
  expect(result.current.bars).toHaveLength(1)
})

it('releases the room and every listener on unmount', async () => {
  const { unmount } = renderHook(() => useBtcSeconds(300))
  expect(socket.rooms).toEqual(['btc-feed'])
  unmount()
  expect(socket.rooms).toEqual([])
  expect(socket.count('btc-feed:update') + socket.count('connect')).toBe(0)
})

it('pauses clock-only updates while hidden and reconciles the age on return', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    const { result } = renderHook(() => useBtcSeconds(300))
    await reply(0)
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(result.current.ages.coinbase).toBe(400)

    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(result.current.ages.coinbase).toBe(5400)
  } finally {
    visibility.mockRestore()
  }
})
