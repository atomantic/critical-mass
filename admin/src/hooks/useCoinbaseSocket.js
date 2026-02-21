import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

/**
 * @typedef {Object} CryptoPriceUpdate
 * @property {string} ticker - Product ID (e.g., 'BTC-USD')
 * @property {number} price - Current price
 * @property {number} bid - Best bid
 * @property {number} ask - Best ask
 * @property {number} volume24h - 24h volume
 * @property {number} previousPrice - Previous price
 * @property {number} priceChange - Price change since last update
 * @property {number} updatedAt - Timestamp
 */

/** Default crypto tickers to subscribe to */
const DEFAULT_TICKERS = ['BTC-USD']

const THROTTLE_MS = 250

/**
 * Custom hook for Coinbase Socket.IO connection.
 * Throttles state updates to avoid render storms from high-frequency WebSocket data.
 * @param {Object} [options] - Hook options
 * @param {string[]} [options.initialTickers] - Initial tickers to subscribe to
 * @param {boolean} [options.autoConnect=true] - Auto-connect on mount
 * @returns {{
 *   connected: boolean,
 *   prices: Map<string, CryptoPriceUpdate>,
 *   subscribe: (tickers: string[]) => void,
 *   unsubscribe: (tickers: string[]) => void,
 *   getPrice: (ticker: string) => CryptoPriceUpdate | null
 * }}
 */
export const useCoinbaseSocket = (options = {}) => {
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
        socket.emit('coinbase:subscribe', tickersToSubscribe)
      }
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('coinbase:price', (data) => {
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
      socketRef.current.emit('coinbase:subscribe', tickerList)
    }
  }, [])

  const unsubscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.delete(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit('coinbase:unsubscribe', tickerList)
    }

    const next = new Map(pricesRef.current)
    tickerList.forEach(t => next.delete(t))
    pricesRef.current = next
    setPrices(new Map(pricesRef.current))
  }, [])

  // Stable callback - reads from ref, re-renders driven by throttled prices state
  const getPrice = useCallback((ticker) => {
    return pricesRef.current.get(ticker) || null
  }, [])

  return { connected, prices, subscribe, unsubscribe, getPrice }
}

export default useCoinbaseSocket
