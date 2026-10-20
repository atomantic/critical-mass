import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from '../src/lib/realtime'

// Stand-in for the browser WebSocket plus the gateway side of the protocol.
class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeSocket.instances.push(this)
  }

  send(data) { this.sent.push(JSON.parse(data)) }

  close() { this.readyState = 3 }

  accept({ id = `socket-${FakeSocket.instances.length}`, pingInterval = 25000, pingTimeout = 20000 } = {}) {
    this.readyState = 1
    this.push({ t: 'open', id, pingInterval, pingTimeout })
  }

  push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }

  // Transport lost (gateway restart, refused upgrade, network drop).
  fail() {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
}

const latest = () => FakeSocket.instances.at(-1)
const open = (options) => connect({ url: 'ws://gateway.test/realtime', createSocket: (url) => new FakeSocket(url), ...options })

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('realtime client', () => {
  it('connects to the page origin by default and reports the bus id once the gateway accepts it', () => {
    const created = []
    const client = connect({ createSocket: (url) => { created.push(url); return new FakeSocket(url) } })
    expect(created).toEqual([`ws://${window.location.host}/realtime`])
    const onConnect = vi.fn()
    client.on('connect', onConnect)
    expect(client.connected).toBe(false)
    latest().accept({ id: 'abc' })
    expect(client.connected).toBe(true)
    expect(client.id).toBe('abc')
    expect(onConnect).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('dispatches gateway events to listeners until they are removed', () => {
    const client = open()
    latest().accept()
    const handler = vi.fn()
    client.on('regime:status', handler)
    expect(client.listeners('regime:status')).toEqual([handler])
    latest().push({ t: 'event', e: 'regime:status', p: { exchange: 'coinbase' } })
    client.off('regime:status', handler)
    latest().push({ t: 'event', e: 'regime:status', p: { exchange: 'gemini' } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ exchange: 'coinbase' })
    expect(client.listeners('regime:status')).toEqual([])
    client.close()
  })

  it('shares one subscription per room between consumers', () => {
    const client = open()
    latest().accept()
    client.subscribe('updown')
    client.subscribe('updown')
    client.unsubscribe('updown')
    expect(latest().sent).toEqual([{ t: 'sub', r: 'updown' }])
    client.unsubscribe('updown')
    client.unsubscribe('updown')
    expect(latest().sent).toEqual([{ t: 'sub', r: 'updown' }, { t: 'unsub', r: 'updown' }])
    client.close()
  })

  it('reconnects with capped exponential backoff and resubscribes before replaying queued events', () => {
    const client = open()
    const order = []
    client.on('connect', () => order.push('connect'))
    client.on('disconnect', () => order.push('disconnect'))
    client.on('connect_error', () => order.push('connect_error'))
    client.subscribe('sentinel')
    latest().accept()
    expect(latest().sent).toEqual([{ t: 'sub', r: 'sentinel' }])

    latest().fail()
    expect(client.connected).toBe(false)
    expect(client.id).toBe(null)
    client.subscribe('updown')
    client.emit('logs:flush', { processName: 'critical-mass' })

    // 1 s, then 2 s, 4 s ... capped at 30 s while attempts keep failing.
    const delays = []
    for (let i = 0; i < 7; i++) {
      const count = FakeSocket.instances.length
      let waited = 0
      while (FakeSocket.instances.length === count) {
        vi.advanceTimersByTime(250)
        waited += 250
      }
      delays.push(waited)
      if (i < 6) latest().fail()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])

    latest().accept()
    expect(latest().sent).toEqual([
      { t: 'sub', r: 'sentinel' },
      { t: 'sub', r: 'updown' },
      { t: 'event', e: 'logs:flush', p: { processName: 'critical-mass' } },
    ])
    expect(order).toEqual(['connect', 'disconnect', ...Array(6).fill('connect_error'), 'connect'])

    // A successful connection resets the backoff.
    const count = FakeSocket.instances.length
    latest().fail()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances.length).toBe(count + 1)
    client.close()
  })

  it('answers heartbeats and treats a silent gateway as a dead connection', () => {
    const client = open()
    const onDisconnect = vi.fn()
    client.on('disconnect', onDisconnect)
    latest().accept({ pingInterval: 100, pingTimeout: 50 })
    const first = latest()
    vi.advanceTimersByTime(100)
    first.push({ t: 'ping' })
    expect(first.sent).toEqual([{ t: 'pong' }])
    vi.advanceTimersByTime(149)
    expect(client.connected).toBe(true)
    vi.advanceTimersByTime(1)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(first.readyState).toBe(3)
    // Late frames from the abandoned transport are ignored.
    first.push({ t: 'open', id: 'stale' })
    expect(client.connected).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(latest()).not.toBe(first)
    client.close()
  })

  it('gives up on an attempt the gateway never accepts', () => {
    const client = open({ connectTimeoutMs: 500 })
    const onError = vi.fn()
    client.on('connect_error', onError)
    vi.advanceTimersByTime(500)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(FakeSocket.instances[0].readyState).toBe(3)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
    client.close()
  })

  it('reconnects immediately on request and stops for good once closed', () => {
    const client = open()
    latest().accept()
    client.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
    latest().accept({ id: 'second' })
    expect(client.id).toBe('second')
    client.close()
    expect(client.connected).toBe(false)
    expect(latest().readyState).toBe(3)
    vi.advanceTimersByTime(60000)
    expect(FakeSocket.instances).toHaveLength(2)
    client.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('keeps delivering to other listeners when one throws', () => {
    const client = open()
    latest().accept()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    client.on('trade:event', () => { throw new Error('listener failure') })
    client.on('trade:event', after)
    latest().push({ t: 'event', e: 'trade:event', p: { id: 1 } })
    expect(after).toHaveBeenCalledWith({ id: 1 })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    client.close()
  })
})
