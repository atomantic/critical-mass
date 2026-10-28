import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRealtimeConnection } from '../src/hooks/useTradeEvents'

const socket = vi.hoisted(() => ({
  connected: true,
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
})

describe('useRealtimeConnection', () => {
  it('tracks connection changes without subscribing to status events', () => {
    let renders = 0
    function Shell() {
      renders += 1
      const connected = useRealtimeConnection()
      return <span>{connected ? 'Live' : 'Offline'}</span>
    }

    const { container, unmount } = render(<Shell />)
    expect(container.textContent).toBe('Live')
    expect(socket.handlers.get('regime:status')).toBeUndefined()

    const initialRenders = renders
    act(() => {
      for (let i = 0; i < 100; i++) socket.emit('regime:status', { status: { i } })
    })
    expect(renders).toBe(initialRenders)

    act(() => socket.emit('disconnect'))
    expect(container.textContent).toBe('Offline')
    act(() => socket.emit('connect'))
    expect(container.textContent).toBe('Live')

    unmount()
    expect(socket.handlers.get('connect').size).toBe(0)
    expect(socket.handlers.get('disconnect').size).toBe(0)
    expect(socket.off.mock.calls.map(([event]) => event)).toEqual(['connect', 'disconnect'])
  })

  it('keeps root commits unchanged during a timed synthetic status stream', async () => {
    const commits = []
    function Shell() {
      const connected = useRealtimeConnection()
      return <span>{connected ? 'Live' : 'Offline'}</span>
    }

    render(<Profiler id="root" onRender={(...args) => commits.push(args)}><Shell /></Profiler>)
    await act(async () => {})
    const startingCommits = commits.length
    const startedAt = performance.now()
    const windowMs = 6500
    await new Promise(resolve => {
      const interval = setInterval(() => {
        socket.emit('regime:status', { exchange: 'coinbase', status: { isRunning: true } })
      }, 1000)
      const finishAfterWindow = () => {
        const remainingMs = windowMs - (performance.now() - startedAt)
        if (remainingMs > 0) {
          setTimeout(finishAfterWindow, Math.ceil(remainingMs))
          return
        }
        clearInterval(interval)
        resolve()
      }
      setTimeout(finishAfterWindow, windowMs)
    })

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(windowMs)
    expect(startingCommits).toBe(2)
    expect(commits.length).toBe(startingCommits)
  }, 10000)
})
