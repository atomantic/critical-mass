import { useEffect, useRef, useState } from 'react'
import { getRealtimeClient } from '../lib/realtime'

const THROTTLE_MS = 250

/**
 * Realtime hook for UpDown BTC perp-long signal data.
 * Throttles state updates to avoid render storms from high-frequency WebSocket data.
 */
export const useUpDownSocket = (options = {}) => {
  const { autoConnect = true } = options

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

    const socket = getRealtimeClient()

    const onConnect = () => {
      setConnected(true)
      setError(null)
    }

    const onDisconnect = () => {
      setConnected(false)
    }

    const onConnectError = (err) => {
      setError(err?.message || 'Connection error')
      setConnected(false)
    }

    // Tick data (1/sec) - throttle to 250ms
    const onTick = (data) => {
      tickRef.current = data
      if (!tickThrottleRef.current) {
        tickThrottleRef.current = setTimeout(() => {
          tickThrottleRef.current = null
          setTick(tickRef.current)
        }, THROTTLE_MS)
      }
    }

    // Indicator data (every 5s) - throttle to 250ms
    const onIndicators = (data) => {
      indicatorsRef.current = data
      if (!indicatorsThrottleRef.current) {
        indicatorsThrottleRef.current = setTimeout(() => {
          indicatorsThrottleRef.current = null
          setIndicators(indicatorsRef.current)
        }, THROTTLE_MS)
      }
    }

    // Signal changes - no throttle, these are infrequent
    const onSignal = (data) => {
      setSignal(data)
    }

    // Scorecard updates - infrequent (max 1 per 5s), no throttle needed
    const onScorecard = (data) => {
      setScorecard(data)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('updown:tick', onTick)
    socket.on('updown:indicators', onIndicators)
    socket.on('updown:signal', onSignal)
    socket.on('updown:scorecard', onScorecard)
    // The client re-sends the subscription after every reconnect.
    socket.subscribe('updown')
    setConnected(socket.connected)

    return () => {
      socket.unsubscribe('updown')
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('updown:tick', onTick)
      socket.off('updown:indicators', onIndicators)
      socket.off('updown:signal', onSignal)
      socket.off('updown:scorecard', onScorecard)
      if (tickThrottleRef.current) clearTimeout(tickThrottleRef.current)
      if (indicatorsThrottleRef.current) clearTimeout(indicatorsThrottleRef.current)
      tickThrottleRef.current = null
      indicatorsThrottleRef.current = null
    }
  }, [autoConnect])

  return { connected, tick, indicators, signal, scorecard, error }
}

export default useUpDownSocket
