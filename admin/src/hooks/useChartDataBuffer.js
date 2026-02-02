import { useState, useEffect, useRef, useCallback } from 'react'

// Maximum data retention (15 minutes in milliseconds)
const MAX_RETENTION_MS = 15 * 60 * 1000

// Minimum interval between data points (to prevent over-sampling)
const MIN_SAMPLE_INTERVAL_MS = 1000

/**
 * Hook that accumulates WebSocket data for charting
 * - Stores last 15 minutes of data points
 * - Deduplicates by timestamp
 * - Auto-trims old data
 * - Returns: { priceHistory, atrHistory, regimeHistory }
 */
export function useChartDataBuffer(status) {
  const [priceHistory, setPriceHistory] = useState([])
  const [atrHistory, setAtrHistory] = useState([])
  const [regimeHistory, setRegimeHistory] = useState([])

  const lastSampleTimeRef = useRef(0)

  // Trim old data from an array
  const trimOldData = useCallback((data) => {
    const cutoff = Date.now() - MAX_RETENTION_MS
    return data.filter(d => d.timestamp > cutoff)
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
  }, [])

  return {
    priceHistory,
    atrHistory,
    regimeHistory,
    clearData,
  }
}

export default useChartDataBuffer
