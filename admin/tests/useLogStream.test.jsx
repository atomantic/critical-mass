import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const { socket } = vi.hoisted(() => {
  const sharedSocket = { connected: true, handlers: new Map(), emit: vi.fn() }
  sharedSocket.on = vi.fn((event, handler) => {
    handler.__event = event
    sharedSocket.handlers.set(`${event}:${sharedSocket.handlers.size}`, handler)
  })
  sharedSocket.off = vi.fn((event, handler) => {
    for (const [key, value] of sharedSocket.handlers) if (key.startsWith(`${event}:`) && value === handler) sharedSocket.handlers.delete(key)
  })
  return { socket: sharedSocket }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

import { useLogStream } from '../src/hooks/useLogStream'

function fire(event, data) {
  for (const handler of socket.handlers.values()) if (handler.__event === event) handler(data)
}

// Lines are batched and flushed on a 100ms timer, so the helper advances
// fake timers past one flush window after each line.
function line(lineText) {
  act(() => {
    fire('logs:line', { processName: 'gateway', line: lineText, type: 'out', timestamp: 1 })
    vi.advanceTimersByTime(100)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  socket.handlers.clear()
  socket.emit.mockClear()
})

describe('useLogStream line batching', () => {
  it('coalesces a burst into one flush, caps at 2000 lines, and gives each line a unique id', () => {
    const { result } = renderHook(() => useLogStream('gateway', { lines: 10 }))
    act(() => {
      for (let i = 0; i < 2050; i += 1) fire('logs:line', { processName: 'gateway', line: `line ${i}`, type: 'out', timestamp: i })
    })
    expect(result.current.logs).toEqual([])
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.logs).toHaveLength(2000)
    expect(result.current.logs[0].line).toBe('line 50')
    expect(result.current.logs.at(-1).line).toBe('line 2049')
    expect(new Set(result.current.logs.map((entry) => entry.id)).size).toBe(2000)
  })

  it('drops lines still waiting for a flush when cleared', () => {
    const { result } = renderHook(() => useLogStream('gateway', { lines: 10 }))
    act(() => fire('logs:line', { processName: 'gateway', line: 'pending', type: 'out', timestamp: 1 }))
    act(() => result.current.clear())
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.logs).toEqual([])
  })
})

describe('useLogStream subscription buffer', () => {
  it('resets replayed lines on tail change, reconnect, and retry', () => {
    const { result, rerender } = renderHook(({ lines }) => useLogStream('gateway', { lines }), { initialProps: { lines: 10 } })
    line('first subscription')
    expect(result.current.logs.map((entry) => entry.line)).toEqual(['first subscription'])

    rerender({ lines: 20 })
    expect(result.current.logs).toEqual([])
    line('tail replay')
    expect(result.current.logs.map((entry) => entry.line)).toEqual(['tail replay'])

    act(() => fire('connect'))
    expect(result.current.logs).toEqual([])
    line('reconnect replay')
    expect(result.current.logs.map((entry) => entry.line)).toEqual(['reconnect replay'])

    act(() => fire('logs:terminal', { processName: 'gateway', reason: 'exited' }))
    act(() => result.current.retry())
    expect(result.current.logs).toEqual([])
    line('retry replay')
    expect(result.current.logs.map((entry) => entry.line)).toEqual(['retry replay'])

    act(() => result.current.clear())
    expect(result.current.logs).toEqual([])
  })
})
