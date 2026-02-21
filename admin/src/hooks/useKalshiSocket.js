import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { io } from 'socket.io-client'

/**
 * @typedef {Object} PriceUpdate
 * @property {string} ticker - Market ticker
 * @property {number} yesBid - Best yes bid
 * @property {number} yesAsk - Best yes ask
 * @property {number} noBid - Best no bid
 * @property {number} noAsk - Best no ask
 * @property {number} lastPrice - Last trade price
 * @property {number} volume - Volume
 * @property {number} updatedAt - Timestamp
 */

/**
 * @typedef {Object} TradeUpdate
 * @property {string} ticker - Market ticker
 * @property {string} tradeId - Trade ID
 * @property {number} count - Number of contracts
 * @property {number} price - Trade price
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} LogEntry
 * @property {'info' | 'signal' | 'trade' | 'error' | 'eval'} type - Log type
 * @property {string} message - Log message
 * @property {Object} data - Additional log data
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} AccountBalance
 * @property {number} available - Available balance
 * @property {number} portfolioValue - Total portfolio value
 */

/**
 * @typedef {Object} TodayStats
 * @property {number} trades - Number of trades today
 * @property {number} wins - Number of winning trades
 * @property {number} pnl - Total P&L for today
 */

const MAX_LOGS = 100

/**
 * Custom hook for Kalshi Socket.IO connection
 * @returns {{
 *   connected: boolean,
 *   prices: Map<string, PriceUpdate>,
 *   logs: LogEntry[],
 *   balance: AccountBalance | null,
 *   positions: Array | null,
 *   stats: TodayStats | null,
 *   subscribe: (tickers: string[]) => void,
 *   unsubscribe: (tickers: string[]) => void,
 *   getPrice: (ticker: string) => PriceUpdate | null,
 *   clearLogs: () => void
 * }}
 */
export const useKalshiSocket = () => {
  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [prices, setPrices] = useState(new Map())
  const [logs, setLogs] = useState([])
  const [balance, setBalance] = useState(null)
  const [positions, setPositions] = useState(null)
  const [stats, setStats] = useState(null)
  const [aiReview, setAiReview] = useState(null)
  const [aiReviewStatus, setAiReviewStatus] = useState(null)
  const [windowSummaries, setWindowSummaries] = useState([])
  const subscribedRef = useRef(new Set())

  useEffect(() => {
    // Connect to the server's Socket.IO
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      // Resubscribe to any tickers we were tracking
      if (subscribedRef.current.size > 0) {
        socket.emit('kalshi:subscribe', Array.from(subscribedRef.current))
      }
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('kalshi:price', (data) => {
      setPrices(prev => {
        const next = new Map(prev)
        next.set(data.ticker, data)
        return next
      })
    })

    socket.on('kalshi:trade', (data) => {
      // Update last price from trade
      setPrices(prev => {
        const next = new Map(prev)
        const existing = next.get(data.ticker) || {}
        next.set(data.ticker, { ...existing, lastPrice: data.price, updatedAt: Date.now() })
        return next
      })
    })

    socket.on('kalshi:log', (logEntry) => {
      setLogs(prev => {
        const next = [logEntry, ...prev]
        // Keep only the most recent logs
        return next.slice(0, MAX_LOGS)
      })
    })

    socket.on('kalshi:balance', (data) => {
      setBalance(data)
    })

    socket.on('kalshi:positions', (data) => {
      setPositions(data)
    })

    socket.on('kalshi:stats', (data) => {
      setStats(data)
    })

    socket.on('kalshi:review', (data) => {
      setAiReview(data)
      setAiReviewStatus(null) // Clear "running" status when review arrives
    })

    socket.on('kalshi:review:status', (data) => {
      setAiReviewStatus(data)
    })

    socket.on('kalshi:window-summary', (data) => {
      setWindowSummaries(prev => [data, ...prev].slice(0, 50))
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  const subscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.add(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit('kalshi:subscribe', tickerList)
    }
  }, [])

  const unsubscribe = useCallback((tickers) => {
    const tickerList = Array.isArray(tickers) ? tickers : [tickers]
    tickerList.forEach(t => subscribedRef.current.delete(t))

    if (socketRef.current?.connected) {
      socketRef.current.emit('kalshi:unsubscribe', tickerList)
    }
  }, [])

  const getPrice = useCallback((ticker) => {
    return prices.get(ticker) || null
  }, [prices])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  // Extract latest diagnostics from most recent eval log (memoized to prevent infinite re-render loops)
  const evalLog = logs.find(l => l.type === 'eval')
  const latestDiagnostics = useMemo(
    () => evalLog?.data?.results?.flatMap(r => r.diagnostics || []) || [],
    [evalLog]
  )

  return { connected, prices, logs, balance, positions, stats, subscribe, unsubscribe, getPrice, clearLogs, latestDiagnostics, aiReview, aiReviewStatus, windowSummaries }
}

export default useKalshiSocket
