import { useState, useEffect, useCallback, useRef } from 'react'
import { getSocket } from './useTradeEvents'

const MAX_LINES = 2000

export function useLogStream(processName, { lines = 500 } = {}) {
  const [logs, setLogs] = useState([])
  const [subscribed, setSubscribed] = useState(false)
  const [flushing, setFlushing] = useState(false)
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

    const handleSubscribed = () => setSubscribed(true)
    const handleUnsubscribed = () => setSubscribed(false)
    const handleError = (data) => {
      console.error('Log stream error:', data.error)
      setSubscribed(false)
    }
    const handleFlushed = (data) => {
      if (data.processName === processName) {
        setFlushing(false)
      }
    }

    socket.on('logs:line', handleLine)
    socket.on('logs:subscribed', handleSubscribed)
    socket.on('logs:unsubscribed', handleUnsubscribed)
    socket.on('logs:error', handleError)
    socket.on('logs:flushed', handleFlushed)

    socket.emit('logs:subscribe', { processName, lines })

    return () => {
      socket.emit('logs:unsubscribe')
      socket.off('logs:line', handleLine)
      socket.off('logs:subscribed', handleSubscribed)
      socket.off('logs:unsubscribed', handleUnsubscribed)
      socket.off('logs:error', handleError)
      socket.off('logs:flushed', handleFlushed)
      setSubscribed(false)
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

  return { logs, subscribed, clear, flush, flushing }
}
