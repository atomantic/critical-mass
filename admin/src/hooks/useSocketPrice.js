import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

/**
 * Generic socket-based price subscription hook.
 * Eliminates duplicated logic across useCoinbaseSocket, useKrakenSocket, etc.
 *
 * @param {Object} config - Hook configuration
 * @param {string} config.subscribeEvent - Socket event name for subscribing (e.g. 'coinbase:subscribe')
 * @param {string} config.unsubscribeEvent - Socket event name for unsubscribing
 * @param {string} config.priceEvent - Socket event name for price data
 * @param {string[]} [config.initialTickers] - Default tickers to subscribe on connect
 * @param {number} [config.throttleMs=250] - Throttle interval for state updates
 * @param {boolean} [config.autoConnect=true] - Auto-connect on mount
 * @returns {{
 *   connected: boolean,
 *   prices: Map<string, Object>,
 *   subscribe: (tickers: string[]) => void,
 *   unsubscribe: (tickers: string[]) => void,
 *   getPrice: (ticker: string) => Object | null
 * }}
 */
export const useSocketPrice = (config) => {
  const {
    subscribeEvent,
    unsubscribeEvent,
    priceEvent,
    initialTickers = [],
    throttleMs = 250,
    autoConnect = true,
  } = config

  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [prices, setPrices] = useState(new Map())
  const pricesRef = useRef(new Map())
  const subscribedRef = useRef(new Set())
  const throttleRef = useRef(null)
  const initialTickersRef = useRef(initialTickers)
  initialTickersRef.current = initialTickers

  // Stable key for dependency tracking — avoids reconnect on new array identity
  const tickersKey = initialTickers.join(',')

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
        : initialTickersRef.current

      if (tickersToSubscribe.length > 0) {
        tickersToSubscribe.forEach(t => subscribedRef.current.add(t))
        socket.emit(subscribeEvent, tickersToSubscribe)
      }
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on(priceEvent, (data) => {
      const next = new Map(pricesRef.current)
      next.set(data.ticker, data)
      pricesRef.current = next

      if (!throttleRef.current) {
        throttleRef.current = setTimeout(() => {
          throttleRef.current = null
          setPrices(new Map(pricesRef.current))
        }, throttleMs)
      }
    })

    return () => {
      if (throttleRef.current) clearTimeout(throttleRef.current)
      socket.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, subscribeEvent, unsubscribeEvent, priceEvent, throttleMs, tickersKey])

  const subscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.add(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit(subscribeEvent, tickerList)
    }
  }, [subscribeEvent])

  const unsubscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.delete(t))

    if (socketRef.current?.connected && unsubscribeEvent) {
      socketRef.current.emit(unsubscribeEvent, tickerList)
    }

    const next = new Map(pricesRef.current)
    tickerList.forEach(t => next.delete(t))
    pricesRef.current = next
    setPrices(new Map(pricesRef.current))
  }, [unsubscribeEvent])

  const getPrice = useCallback((ticker) => {
    return pricesRef.current.get(ticker) || null
  }, [])

  return { connected, prices, subscribe, unsubscribe, getPrice }
}

export default useSocketPrice
