import { afterEach, describe, expect, it, vi } from 'vitest'
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

function line(lineText) {
  act(() => fire('logs:line', { processName: 'gateway', line: lineText, type: 'out', timestamp: 1 }))
}

afterEach(() => {
  cleanup()
  socket.handlers.clear()
  socket.emit.mockClear()
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
