import { useState, useEffect, useCallback, useRef } from 'react'
import { io } from 'socket.io-client'

// Maximum events to keep in history
const MAX_EVENTS = 50

// Singleton socket connection
let socket = null

export const getSocket = () => {
  if (!socket) {
    socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
    })
  }
  return socket
}

export function useTradeEvents(exchange = null) {
  const [events, setEvents] = useState([])
  const [connected, setConnected] = useState(false)
  const [latestEvent, setLatestEvent] = useState(null)

  useEffect(() => {
    const socket = getSocket()

    const handleConnect = () => setConnected(true)
    const handleDisconnect = () => setConnected(false)

    const handleTradeEvent = (event) => {
      // Filter by exchange if specified
      if (exchange && event.exchange !== exchange) return

      setLatestEvent(event)
      setEvents((prev) => {
        const updated = [event, ...prev]
        return updated.slice(0, MAX_EVENTS)
      })
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('trade:event', handleTradeEvent)

    // Check initial connection state
    setConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('trade:event', handleTradeEvent)
    }
  }, [exchange])

  const clearEvents = useCallback(() => {
    setEvents([])
    setLatestEvent(null)
  }, [])

  return {
    events,
    latestEvent,
    connected,
    clearEvents,
  }
}

export function useRegimeEvents(exchange = null, pair = null) {
  const [status, setStatus] = useState(null)
  const [regimeState, setRegimeState] = useState(null)
  const [healthState, setHealthState] = useState(null)
  const [positionState, setPositionState] = useState(null)
  const [connected, setConnected] = useState(false)
  const [events, setEvents] = useState([])

  useEffect(() => {
    const socket = getSocket()

    const handleConnect = () => setConnected(true)
    const handleDisconnect = () => setConnected(false)

    // Filter incoming events to ONLY this fund (exchange + pair). When pair
    // is provided, events for other funds on the same exchange are dropped
    // so e.g. a running gemini/BTCUSD engine doesn't leak into a stopped
    // gemini/ETHUSD dashboard.
    const matchesFund = (data) => {
      if (exchange && data.exchange !== exchange) return false
      if (pair && data.pair && data.pair !== pair) return false
      return true
    }

    const handleStatusUpdate = (data) => {
      if (!matchesFund(data)) return
      // Shallow-merge so a truncated emit (e.g., the market service while the
      // engine is stopped) can't blow away fields like pendingOrders/celestial
      // that were present in the prior good snapshot.
      setStatus(prev => prev ? { ...prev, ...data.status } : data.status)
    }

    const handleRegimeChange = (data) => {
      if (!matchesFund(data)) return
      setRegimeState(data)
      setEvents((prev) => [{
        type: 'regime_change',
        ...data,
        timestamp: new Date().toISOString(),
      }, ...prev].slice(0, MAX_EVENTS))
    }

    const handleHealthChange = (data) => {
      if (!matchesFund(data)) return
      setHealthState(data)
      setEvents((prev) => [{
        type: 'health_change',
        ...data,
        timestamp: new Date().toISOString(),
      }, ...prev].slice(0, MAX_EVENTS))
    }

    const handlePositionUpdate = (data) => {
      if (!matchesFund(data)) return
      setPositionState(data)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('regime:status', handleStatusUpdate)
    socket.on('regime:change', handleRegimeChange)
    socket.on('regime:health', handleHealthChange)
    socket.on('regime:position', handlePositionUpdate)

    setConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('regime:status', handleStatusUpdate)
      socket.off('regime:change', handleRegimeChange)
      socket.off('regime:health', handleHealthChange)
      socket.off('regime:position', handlePositionUpdate)
    }
  }, [exchange, pair])

  const clearEvents = useCallback(() => setEvents([]), [])

  return {
    status,
    setStatus,
    regimeState,
    healthState,
    positionState,
    connected,
    events,
    clearEvents,
  }
}

export function useMultiRegimeStatuses() {
  // Keyed by `${exchange}::${pair}` so multi-pair installs keep independent
  // status entries per fund. Events without a pair (legacy engines that
  // haven't been restarted yet) are stored under `${exchange}::${exchange}`
  // so the Overview's matching code can still find them by exchange.
  const [statuses, setStatuses] = useState({})
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const socket = getSocket()

    const handleConnect = () => setConnected(true)
    const handleDisconnect = () => setConnected(false)

    const handleStatusUpdate = (data) => {
      if (!data.exchange) return
      const pair = data.pair || data.exchange
      const key = `${data.exchange}::${pair}`
      setStatuses(prev => ({ ...prev, [key]: data.status }))
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('regime:status', handleStatusUpdate)

    setConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('regime:status', handleStatusUpdate)
    }
  }, [])

  return { statuses, connected }
}

export function useOptimizerEvents() {
  const [progress, setProgress] = useState(null)
  const [bestResult, setBestResult] = useState(null)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const socket = getSocket()

    const handleProgress = (data) => setProgress(data)
    const handleBest = (data) => setBestResult(data)
    const handleComplete = (data) => {
      setComplete(true)
      setBestResult(data.bestResult)
    }
    const handleError = (data) => setError(data.error)

    socket.on('optimizer:progress', handleProgress)
    socket.on('optimizer:newBest', handleBest)
    socket.on('optimizer:complete', handleComplete)
    socket.on('optimizer:error', handleError)

    return () => {
      socket.off('optimizer:progress', handleProgress)
      socket.off('optimizer:newBest', handleBest)
      socket.off('optimizer:complete', handleComplete)
      socket.off('optimizer:error', handleError)
    }
  }, [])

  const reset = useCallback(() => {
    setProgress(null)
    setBestResult(null)
    setComplete(false)
    setError(null)
  }, [])

  return { progress, bestResult, complete, error, reset }
}

export default useTradeEvents
