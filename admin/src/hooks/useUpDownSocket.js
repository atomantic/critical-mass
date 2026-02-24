import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const THROTTLE_MS = 250

/**
 * Socket.IO hook for UpDown BTC Options signal data.
 * Throttles state updates to avoid render storms from high-frequency WebSocket data.
 */
export const useUpDownSocket = (options = {}) => {
  const { autoConnect = true } = options

  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [tick, setTick] = useState(null)
  const [indicators, setIndicators] = useState(null)
  const [signal, setSignal] = useState(null)
  const [scorecard, setScorecard] = useState(null)
  const [error, setError] = useState(null)

  const tickRef = useRef(null)
  const indicatorsRef = useRef(null)
  const tickThrottleRef = useRef(null)
  const indicatorsThrottleRef = useRef(null)

  useEffect(() => {
    if (!autoConnect) return

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setError(null)
      socket.emit('updown:subscribe')
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('connect_error', (err) => {
      setError(err?.message || 'Connection error')
      setConnected(false)
    })

    // Tick data (1/sec) - throttle to 250ms
    socket.on('updown:tick', (data) => {
      tickRef.current = data
      if (!tickThrottleRef.current) {
        tickThrottleRef.current = setTimeout(() => {
          tickThrottleRef.current = null
          setTick(tickRef.current)
        }, THROTTLE_MS)
      }
    })

    // Indicator data (every 5s) - throttle to 250ms
    socket.on('updown:indicators', (data) => {
      indicatorsRef.current = data
      if (!indicatorsThrottleRef.current) {
        indicatorsThrottleRef.current = setTimeout(() => {
          indicatorsThrottleRef.current = null
          setIndicators(indicatorsRef.current)
        }, THROTTLE_MS)
      }
    })

    // Signal changes - no throttle, these are infrequent
    socket.on('updown:signal', (data) => {
      setSignal(data)
    })

    // Scorecard updates - infrequent (max 1 per 5s), no throttle needed
    socket.on('updown:scorecard', (data) => {
      setScorecard(data)
    })

    return () => {
      if (tickThrottleRef.current) clearTimeout(tickThrottleRef.current)
      if (indicatorsThrottleRef.current) clearTimeout(indicatorsThrottleRef.current)
      socket.disconnect()
    }
  }, [autoConnect])

  return { connected, tick, indicators, signal, scorecard, error }
}

export default useUpDownSocket
