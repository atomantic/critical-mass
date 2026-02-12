import { useState, useEffect, useRef, useCallback } from 'react'

// Maximum data retention (1 hour in milliseconds) - matches server-side buffer and timeline display
const MAX_RETENTION_MS = 60 * 60 * 1000

// Minimum interval between data points (to prevent over-sampling)
const MIN_SAMPLE_INTERVAL_MS = 1000

// Hard cap on array length as safety net (1 hour at 1 sample/sec = 3600, add buffer)
const MAX_POINTS = 4000

/**
 * Hook that accumulates WebSocket data for charting
 * - Stores last 15 minutes of data points
 * - Deduplicates by timestamp
 * - Auto-trims old data
 * - Can be initialized with cached data from server
 * - Returns: { priceHistory, atrHistory, regimeHistory, initializeFromCache }
 */
export function useChartDataBuffer(status) {
  const [priceHistory, setPriceHistory] = useState([])
  const [atrHistory, setAtrHistory] = useState([])
  const [regimeHistory, setRegimeHistory] = useState([])
  const [initialized, setInitialized] = useState(false)

  const lastSampleTimeRef = useRef(0)

  // Trim old data from an array (time-based + hard cap)
  const trimOldData = useCallback((data) => {
    const cutoff = Date.now() - MAX_RETENTION_MS
    const filtered = data.filter(d => d.timestamp > cutoff)
    // Hard cap as safety net - keep most recent points if somehow over limit
    if (filtered.length > MAX_POINTS) {
      return filtered.slice(-MAX_POINTS)
    }
    return filtered
  }, [])

  // Process incoming status updates
  useEffect(() => {
    if (!status?.market) return

    const now = Date.now()

    // Rate limit sampling to prevent over-accumulation
    if (now - lastSampleTimeRef.current < MIN_SAMPLE_INTERVAL_MS) return
    lastSampleTimeRef.current = now

    const { market, regime } = status

    // Add price data point
    if (market.lastPrice) {
      const pricePoint = {
        timestamp: now,
        price: market.lastPrice,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
      }

      setPriceHistory(prev => {
        const updated = [...trimOldData(prev), pricePoint]
        return updated
      })
    }

    // Add ATR/volatility data point
    if (market.atr1m !== undefined || market.realizedVol !== undefined) {
      const atrPoint = {
        timestamp: now,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
        realizedVol: market.realizedVol || 0,
        volBaseline: market.volBaseline || 0,
      }

      setAtrHistory(prev => {
        const updated = [...trimOldData(prev), atrPoint]
        return updated
      })
    }

    // Track regime changes (only add when regime mode changes)
    if (regime?.mode) {
      setRegimeHistory(prev => {
        const trimmed = trimOldData(prev)
        const lastRegime = trimmed[trimmed.length - 1]

        // Only add if regime mode changed or this is the first entry
        if (!lastRegime || lastRegime.mode !== regime.mode) {
          return [...trimmed, {
            timestamp: now,
            mode: regime.mode,
            since: regime.since,
          }]
        }
        return trimmed
      })
    }
  }, [status, trimOldData])

  // Periodic cleanup of old data (every 30 seconds)
  useEffect(() => {
    const cleanup = () => {
      setPriceHistory(prev => trimOldData(prev))
      setAtrHistory(prev => trimOldData(prev))
      setRegimeHistory(prev => trimOldData(prev))
    }

    const interval = setInterval(cleanup, 30000)
    return () => clearInterval(interval)
  }, [trimOldData])

  // Clear all data
  const clearData = useCallback(() => {
    setPriceHistory([])
    setAtrHistory([])
    setRegimeHistory([])
    setInitialized(false)
  }, [])

  // Initialize from cached server data
  const initializeFromCache = useCallback((cachedData) => {
    if (!cachedData || initialized) return

    const now = Date.now()
    const cutoff = now - MAX_RETENTION_MS

    // Filter and set price history from cache
    if (cachedData.priceHistory?.length > 0) {
      const validPrices = cachedData.priceHistory.filter(p => p.timestamp > cutoff)
      if (validPrices.length > 0) {
        setPriceHistory(validPrices)
      }
    }

    // Filter and set ATR history from cache
    if (cachedData.atrHistory?.length > 0) {
      const validAtr = cachedData.atrHistory.filter(a => a.timestamp > cutoff)
      if (validAtr.length > 0) {
        setAtrHistory(validAtr)
      }
    }

    // Filter and set regime history from cache
    if (cachedData.regimeHistory?.length > 0) {
      const validRegime = cachedData.regimeHistory.filter(r => r.timestamp > cutoff)
      if (validRegime.length > 0) {
        setRegimeHistory(validRegime)
      }
    }

    setInitialized(true)
  }, [initialized])

  return {
    priceHistory,
    atrHistory,
    regimeHistory,
    clearData,
    initializeFromCache,
    initialized,
  }
}

export default useChartDataBuffer
