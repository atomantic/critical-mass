import { useState, useEffect, useCallback, useRef } from 'react'
import { getRealtimeClient } from '../lib/realtime'
import { shouldAcceptFlushResult } from '../utils/flushResult.mjs'

const MAX_LINES = 2000
// Incoming lines are collected and flushed into React state at most once per
// window, so a burst (engine restart, error loop) costs one array copy and one
// render per tick instead of one per line.
const FLUSH_INTERVAL_MS = 100

export function useLogStream(processName, { lines = 500 } = {}) {
  const [logs, setLogs] = useState([])
  const [subscribed, setSubscribed] = useState(false)
  const [flushing, setFlushing] = useState(false)
  // Latest completed flush outcome — { success, reason? } — one new object
  // per completion, consumed by LogViewer to fire exactly one toast (#451).
  const [flushResult, setFlushResult] = useState(null)
  // Set once the current process's PM2 log child stops streaming on its own
  // (spawn error, clean exit, or crash) while the socket stays connected —
  // { reason: 'error' | 'exited' | 'crashed', message?, code?, signal? }.
  const [terminal, setTerminal] = useState(null)
  const logsRef = useRef([])
  // Lines received since the last flush, plus the pending flush timer. Both are
  // dropped by resetLogs so a reset can never be followed by stale lines.
  const pendingRef = useRef([])
  const flushTimerRef = useRef(null)
  const nextIdRef = useRef(0)
  // The in-flight flush request (if any): { processName }. Cleared the
  // instant it settles — success, failure, disconnect, or a process switch —
  // so a duplicate or stale 'logs:flushed' can never be double-applied or
  // applied to the wrong process.
  const pendingFlushRef = useRef(null)

  // Drop buffered and pending lines and any scheduled flush. Used by clear,
  // resubscribe, reconnect and retry.
  const resetLogs = useCallback(() => {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    pendingRef.current = []
    logsRef.current = []
    setLogs([])
  }, [])

  const flushPending = useCallback(() => {
    flushTimerRef.current = null
    if (pendingRef.current.length === 0) return
    const combined = logsRef.current.concat(pendingRef.current)
    pendingRef.current = []
    logsRef.current = combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined
    setLogs(logsRef.current)
  }, [])

  useEffect(() => {
    if (!processName) return

    const socket = getRealtimeClient()

    const handleLine = (data) => {
      if (data.processName !== processName) return
      nextIdRef.current += 1
      // Stable per-line id: the row key, so React keeps existing DOM rows
      // instead of re-rendering every row when the buffer shifts.
      pendingRef.current.push({ id: nextIdRef.current, line: data.line, type: data.type, timestamp: data.timestamp })
      if (flushTimerRef.current == null) {
        flushTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL_MS)
      }
    }

    const handleSubscribed = () => {
      setSubscribed(true)
      setTerminal(null)
    }
    const handleUnsubscribed = () => setSubscribed(false)
    const handleError = (data) => {
      console.error('Log stream error:', data.error)
      setSubscribed(false)
    }
    // The PM2 log child for the currently-selected process stopped on its
    // own — the socket is still connected, so stop claiming "Streaming" and
    // surface why instead of leaving the UI looking healthy indefinitely.
    const handleTerminal = (data) => {
      if (data.processName !== processName) return
      setSubscribed(false)
      setTerminal({ reason: data.reason, message: data.message, code: data.code, signal: data.signal })
    }
    const handleFlushed = (data) => {
      if (!shouldAcceptFlushResult(pendingFlushRef.current, data, processName)) return
      pendingFlushRef.current = null
      setFlushing(false)
      setFlushResult({ success: data.success, reason: data.reason })
    }
    // On the shared connection, a reconnect (gateway restart, network blip)
    // drops the server-side PM2 tail without telling this hook — re-subscribe
    // whenever the client (re)connects, and stop claiming "Streaming" the
    // instant it disconnects.
    const handleConnect = () => {
      setTerminal(null)
      resetLogs()
      socket.emit('logs:subscribe', { processName, lines })
    }
    const handleDisconnect = () => {
      setSubscribed(false)
      setTerminal(null)
      // A flush in flight when the socket drops never gets its 'logs:flushed'
      // response — settle it as a failure instead of leaving the button
      // stuck on "Flushing..." forever or silently doing nothing.
      if (pendingFlushRef.current) {
        pendingFlushRef.current = null
        setFlushing(false)
        setFlushResult({ success: false, reason: 'disconnected' })
      }
    }

    socket.on('logs:line', handleLine)
    socket.on('logs:subscribed', handleSubscribed)
    socket.on('logs:unsubscribed', handleUnsubscribed)
    socket.on('logs:error', handleError)
    socket.on('logs:terminal', handleTerminal)
    socket.on('logs:flushed', handleFlushed)
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)

    if (socket.connected) {
      resetLogs()
      socket.emit('logs:subscribe', { processName, lines })
    }

    return () => {
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      pendingRef.current = []
      socket.emit('logs:unsubscribe')
      socket.off('logs:line', handleLine)
      socket.off('logs:subscribed', handleSubscribed)
      socket.off('logs:unsubscribed', handleUnsubscribed)
      socket.off('logs:error', handleError)
      socket.off('logs:terminal', handleTerminal)
      socket.off('logs:flushed', handleFlushed)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      setSubscribed(false)
      setTerminal(null)
      // Switching processes (or unmounting) mid-flush: drop the pending
      // request silently — no completion event means no toast — rather than
      // leaving the button stuck on "Flushing..." for whichever process is
      // now selected.
      pendingFlushRef.current = null
      setFlushing(false)
    }
  }, [processName, lines, resetLogs, flushPending])

  const clear = useCallback(() => {
    resetLogs()
  }, [resetLogs])

  const flush = useCallback(() => {
    if (!processName || pendingFlushRef.current) return
    pendingFlushRef.current = { processName }
    setFlushing(true)
    setFlushResult(null)
    const socket = getRealtimeClient()
    socket.emit('logs:flush', { processName })
  }, [processName])

  // Explicit retry (no auto-respawn loop): re-issues the same subscription,
  // which the server treats like any other resubscribe.
  const retry = useCallback(() => {
    if (!processName) return
    setTerminal(null)
    const socket = getRealtimeClient()
    resetLogs()
    socket.emit('logs:subscribe', { processName, lines })
  }, [processName, lines, resetLogs])

  return { logs, subscribed, clear, flush, flushing, flushResult, terminal, retry }
}
