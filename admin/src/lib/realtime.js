// Owned replacement for the slice of socket.io-client the admin uses: one
// WebSocket to the gateway's realtime bus (src/realtime-bus.js, which also
// documents the wire protocol) with socket.io-style on/off/emit/connected/id.
//
// - Room subscriptions are reference counted (two consumers of 'updown' share
//   one subscription) and re-sent after every reconnect.
// - Events emitted while disconnected are queued and sent once connected, the
//   way socket.io-client buffered them.
// - A dropped or failed connection retries with capped exponential backoff
//   (1 s doubling to 30 s); `pingInterval + pingTimeout` without a frame from
//   the gateway counts as a dead connection.
// - Local events: 'connect', 'disconnect', and 'connect_error' when an attempt
//   fails before the gateway accepted it (for example a 401 at the upgrade —
//   browsers do not expose the status).

export const REALTIME_PATH = '/realtime'

const CONNECTING = 0
const OPEN = 1

const defaultUrl = () => {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${REALTIME_PATH}?scopedRegimeStatus=1`
}

export function connect({
  url = defaultUrl(),
  createSocket = (target) => new WebSocket(target),
  minDelayMs = 1000,
  maxDelayMs = 30000,
  connectTimeoutMs = 20000,
  maxQueued = 100,
} = {}) {
  const listeners = new Map()
  const rooms = new Map()
  const queue = []
  let ws = null
  let id = null
  let connected = false
  let closed = false
  let attempt = 0
  let reconnectTimer = null
  let livenessTimer = null
  let livenessMs = connectTimeoutMs

  const fire = (event, ...args) => {
    for (const handler of [...(listeners.get(event) || [])]) {
      try {
        handler(...args)
      } catch (error) {
        console.error(`Realtime ${event} handler failed:`, error)
      }
    }
  }

  const send = (frame) => {
    if (ws?.readyState === OPEN) ws.send(JSON.stringify(frame))
  }

  const armLiveness = () => {
    clearTimeout(livenessTimer)
    livenessTimer = setTimeout(() => drop(), livenessMs)
  }

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer)
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt)
    attempt += 1
    reconnectTimer = setTimeout(open, delay)
  }

  // Detach and close the current transport, report the loss, and retry
  // (immediately when asked, otherwise after the backoff delay).
  function drop({ immediate = false } = {}) {
    clearTimeout(livenessTimer)
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    const socket = ws
    ws = null
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null
      if (socket.readyState === CONNECTING || socket.readyState === OPEN) socket.close()
    }
    const wasConnected = connected
    connected = false
    id = null
    if (wasConnected) fire('disconnect')
    else if (socket && !closed) fire('connect_error', new Error('Realtime connection failed'))
    // A handler may have closed the client or reconnected it already.
    if (closed || ws) return
    if (immediate) {
      attempt = 0
      open()
    } else {
      scheduleReconnect()
    }
  }

  const onFrame = (text) => {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.t === 'open') {
      id = frame.id
      livenessMs = (frame.pingInterval || 25000) + (frame.pingTimeout || 20000)
      armLiveness()
      attempt = 0
      connected = true
      for (const room of rooms.keys()) send({ t: 'sub', r: room })
      for (const message of queue.splice(0)) send(message)
      fire('connect')
      return
    }
    if (!connected) return
    armLiveness()
    if (frame.t === 'ping') send({ t: 'pong' })
    else if (frame.t === 'event' && typeof frame.e === 'string') fire(frame.e, frame.p)
  }

  function open() {
    reconnectTimer = null
    if (closed || ws) return
    let socket
    try {
      socket = createSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws = socket
    livenessMs = connectTimeoutMs
    armLiveness()
    socket.onmessage = ({ data }) => { if (ws === socket) onFrame(String(data)) }
    socket.onclose = () => { if (ws === socket) drop() }
    socket.onerror = () => {}
  }

  const client = {
    get connected() { return connected },
    get id() { return id },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return client
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler)
      return client
    },
    listeners(event) {
      return [...(listeners.get(event) || [])]
    },
    emit(event, payload) {
      const message = { t: 'event', e: event, p: payload }
      if (connected) {
        send(message)
        return
      }
      queue.push(message)
      if (queue.length > maxQueued) queue.shift()
    },
    subscribe(room) {
      const count = rooms.get(room) || 0
      rooms.set(room, count + 1)
      if (count === 0 && connected) send({ t: 'sub', r: room })
    },
    unsubscribe(room) {
      const count = rooms.get(room)
      if (!count) return
      if (count > 1) {
        rooms.set(room, count - 1)
        return
      }
      rooms.delete(room)
      if (connected) send({ t: 'unsub', r: room })
    },
    // Drop the current transport and connect again now (skips the backoff).
    reconnect() {
      if (!closed) drop({ immediate: true })
    },
    close() {
      if (closed) return
      closed = true
      drop()
    },
  }

  open()
  return client
}

let shared = null

// The admin's one connection, opened on first use (after operator sign-in,
// since every consumer renders inside <OperatorLogin>).
export const getRealtimeClient = () => {
  if (!shared) shared = connect()
  return shared
}
