import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const THROTTLE_MS = 500

/**
 * Custom hook for Polymarket 5-min BTC sentiment via Socket.IO.
 * Tracks the live window and stores settled window results.
 * @returns {{
 *   sentiment: Object | null,
 *   settledWindows: Array,
 *   connected: boolean
 * }}
 */
export const usePolymarketSocket = () => {
  const socketRef = useRef(null)
  const [sentiment, setSentiment] = useState(null)
  const [settledWindows, setSettledWindows] = useState([])
  const [connected, setConnected] = useState(false)

  const sentimentRef = useRef(null)
  const throttleRef = useRef(null)

  useEffect(() => {
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      socket.emit('polymarket:subscribe')
    })

    socket.on('disconnect', () => setConnected(false))

    socket.on('polymarket:sentiment', (data) => {
      sentimentRef.current = data
      if (!throttleRef.current) {
        throttleRef.current = setTimeout(() => {
          throttleRef.current = null
          setSentiment(sentimentRef.current)
        }, THROTTLE_MS)
      }
    })

    socket.on('polymarket:window_settled', (window) => {
      setSettledWindows(prev => [...prev.slice(-19), window])
    })

    // Fetch initial history
    const abortController = new AbortController()
    fetch('/api/kalshi/polymarket', { signal: abortController.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.sentiment) setSentiment(data.sentiment)
        if (data?.history?.settled?.length) setSettledWindows(data.history.settled)
      })
      .catch(() => {})

    return () => {
      abortController.abort()
      if (throttleRef.current) clearTimeout(throttleRef.current)
      socket.disconnect()
    }
  }, [])

  return { sentiment, settledWindows, connected }
}

export default usePolymarketSocket
