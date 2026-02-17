import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

/** Default crypto tickers to subscribe to */
const DEFAULT_TICKERS = ['BTC-USD']

const THROTTLE_MS = 250

/**
 * Custom hook for Kraken Socket.IO connection.
 * Throttles state updates to avoid render storms from high-frequency WebSocket data.
 * @param {Object} [options] - Hook options
 * @param {string[]} [options.initialTickers] - Initial tickers to subscribe to
 * @param {boolean} [options.autoConnect=true] - Auto-connect on mount
 * @returns {{
 *   connected: boolean,
 *   prices: Map<string, Object>,
 *   subscribe: (tickers: string[]) => void,
 *   unsubscribe: (tickers: string[]) => void,
 *   getPrice: (ticker: string) => Object | null
 * }}
 */
export const useKrakenSocket = (options = {}) => {
  const { initialTickers = DEFAULT_TICKERS, autoConnect = true } = options

  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [prices, setPrices] = useState(new Map())
  const pricesRef = useRef(new Map())
  const subscribedRef = useRef(new Set())
  const throttleRef = useRef(null)

  useEffect(() => {
    if (!autoConnect) return

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      const tickersToSubscribe = subscribedRef.current.size > 0
        ? Array.from(subscribedRef.current)
        : initialTickers

      if (tickersToSubscribe.length > 0) {
        tickersToSubscribe.forEach(t => subscribedRef.current.add(t))
        socket.emit('kraken:subscribe', tickersToSubscribe)
      }
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('kraken:price', (data) => {
      const next = new Map(pricesRef.current)
      next.set(data.ticker, data)
      pricesRef.current = next

      if (!throttleRef.current) {
        throttleRef.current = setTimeout(() => {
          throttleRef.current = null
          setPrices(new Map(pricesRef.current))
        }, THROTTLE_MS)
      }
    })

    return () => {
      if (throttleRef.current) clearTimeout(throttleRef.current)
      socket.disconnect()
    }
  }, [autoConnect, initialTickers])

  const subscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.add(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit('kraken:subscribe', tickerList)
    }
  }, [])

  const unsubscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.delete(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit('kraken:unsubscribe', tickerList)
    }

    const next = new Map(pricesRef.current)
    tickerList.forEach(t => next.delete(t))
    pricesRef.current = next
    setPrices(new Map(pricesRef.current))
  }, [])

  const getPrice = useCallback((ticker) => {
    return pricesRef.current.get(ticker) || null
  }, [])

  return { connected, prices, subscribe, unsubscribe, getPrice }
}

export default useKrakenSocket
