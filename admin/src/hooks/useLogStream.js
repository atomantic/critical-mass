import { useState, useEffect, useCallback, useRef } from 'react'
import { getSocket } from './useTradeEvents'

const MAX_LINES = 2000

export function useLogStream(processName, { lines = 500 } = {}) {
  const [logs, setLogs] = useState([])
  const [subscribed, setSubscribed] = useState(false)
  const [flushing, setFlushing] = useState(false)
  // Set once the current process's PM2 log child stops streaming on its own
  // (spawn error, clean exit, or crash) while the socket stays connected —
  // { reason: 'error' | 'exited' | 'crashed', message?, code?, signal? }.
  const [terminal, setTerminal] = useState(null)
  const logsRef = useRef([])

  useEffect(() => {
    if (!processName) return

    const socket = getSocket()

    const handleLine = (data) => {
      if (data.processName !== processName) return
      const entry = { line: data.line, type: data.type, timestamp: data.timestamp }
      logsRef.current = [...logsRef.current.slice(-(MAX_LINES - 1)), entry]
      setLogs(logsRef.current)
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
      if (data.processName === processName) {
        setFlushing(false)
      }
    }
    // On the shared singleton socket, a reconnect (gateway restart, network
    // blip) drops the server-side subscription without telling this hook —
    // re-subscribe whenever the socket (re)connects, and stop claiming
    // "Streaming" the instant it disconnects (mirrors useSentinelSocket /
    // useSocketPrice, which both re-subscribe in a 'connect' handler).
    const handleConnect = () => {
      setTerminal(null)
      socket.emit('logs:subscribe', { processName, lines })
    }
    const handleDisconnect = () => {
      setSubscribed(false)
      setTerminal(null)
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
      socket.emit('logs:subscribe', { processName, lines })
    }

    return () => {
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
    }
  }, [processName, lines])

  const clear = useCallback(() => {
    logsRef.current = []
    setLogs([])
  }, [])

  const flush = useCallback(() => {
    if (!processName) return
    setFlushing(true)
    const socket = getSocket()
    socket.emit('logs:flush', { processName })
  }, [processName])

  // Explicit retry (no auto-respawn loop): re-issues the same subscription,
  // which the server treats like any other resubscribe.
  const retry = useCallback(() => {
    if (!processName) return
    setTerminal(null)
    const socket = getSocket()
    socket.emit('logs:subscribe', { processName, lines })
  }, [processName, lines])

  return { logs, subscribed, clear, flush, flushing, terminal, retry }
}
