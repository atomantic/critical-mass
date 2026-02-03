import { useState, useEffect, useCallback, useRef } from 'react'
import { io } from 'socket.io-client'

// Maximum events to keep in history
const MAX_EVENTS = 50

// Singleton socket connection
let socket = null

const getSocket = () => {
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

export function useRegimeEvents(exchange = null) {
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

    const handleStatusUpdate = (data) => {
      if (exchange && data.exchange !== exchange) return
      setStatus(data.status)
    }

    const handleRegimeChange = (data) => {
      if (exchange && data.exchange !== exchange) return
      setRegimeState(data)
      setEvents((prev) => [{
        type: 'regime_change',
        ...data,
        timestamp: new Date().toISOString(),
      }, ...prev].slice(0, MAX_EVENTS))
    }

    const handleHealthChange = (data) => {
      if (exchange && data.exchange !== exchange) return
      setHealthState(data)
      setEvents((prev) => [{
        type: 'health_change',
        ...data,
        timestamp: new Date().toISOString(),
      }, ...prev].slice(0, MAX_EVENTS))
    }

    const handlePositionUpdate = (data) => {
      if (exchange && data.exchange !== exchange) return
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
  }, [exchange])

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
