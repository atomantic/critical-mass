import { useState, useEffect, useRef, useCallback } from 'react'

// Maximum data retention (1 hour in milliseconds) - matches server-side buffer and timeline display
const MAX_RETENTION_MS = 60 * 60 * 1000

// Minimum interval between data points (to prevent over-sampling)
const MIN_SAMPLE_INTERVAL_MS = 1000

// Hard cap on array length as safety net (1 hour at 1 sample/sec = 3600, add buffer)
const MAX_POINTS = 4000

// Flush accumulated ref data to React state at this interval (ms).
// Keeps render frequency independent of WebSocket tick rate.
const FLUSH_INTERVAL_MS = 5000

/**
 * Hook that accumulates WebSocket data for charting.
 *
 * Data is collected in refs on every status tick (rate-limited to 1/sec)
 * and flushed to React state every FLUSH_INTERVAL_MS. This decouples the
 * high-frequency socket updates from the React render cycle, dramatically
 * reducing GC pressure and re-render cost on long-running tabs.
 */
export function useChartDataBuffer(status) {
  const [priceHistory, setPriceHistory] = useState([])
  const [atrHistory, setAtrHistory] = useState([])
  const [regimeHistory, setRegimeHistory] = useState([])
  const [initialized, setInitialized] = useState(false)

  const lastSampleTimeRef = useRef(0)
  // Accumulation refs — mutated on every tick, flushed to state periodically
  const priceRef = useRef([])
  const atrRef = useRef([])
  const regimeRef = useRef([])
  const dirtyRef = useRef(false)

  // Trim old data from an array (time-based + hard cap) — pure, no allocation when nothing to trim
  const trimOldData = useCallback((data) => {
    if (data.length === 0) return data
    const cutoff = Date.now() - MAX_RETENTION_MS
    // Fast path: if the oldest entry is still within window, skip filter
    if (data[0].timestamp > cutoff && data.length <= MAX_POINTS) return data
    const filtered = data.filter(d => d.timestamp > cutoff)
    if (filtered.length > MAX_POINTS) {
      return filtered.slice(-MAX_POINTS)
    }
    return filtered
  }, [])

  // Accumulate into refs (no setState, no render)
  useEffect(() => {
    if (!status?.market) return

    const now = Date.now()

    // Rate limit sampling to prevent over-accumulation
    if (now - lastSampleTimeRef.current < MIN_SAMPLE_INTERVAL_MS) return
    lastSampleTimeRef.current = now

    const { market, regime } = status

    // Add price data point
    if (market.lastPrice) {
      priceRef.current.push({
        timestamp: now,
        price: market.lastPrice,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
      })
      dirtyRef.current = true
    }

    // Add ATR/volatility data point
    if (market.atr1m !== undefined || market.realizedVol !== undefined) {
      atrRef.current.push({
        timestamp: now,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
        realizedVol: market.realizedVol || 0,
        volBaseline: market.volBaseline || 0,
      })
      dirtyRef.current = true
    }

    // Track regime changes (only add when regime mode changes)
    if (regime?.mode) {
      const arr = regimeRef.current
      const last = arr[arr.length - 1]
      if (!last || last.mode !== regime.mode) {
        arr.push({
          timestamp: now,
          mode: regime.mode,
          since: regime.since,
        })
        dirtyRef.current = true
      }
    }
  }, [status])

  // Periodic flush: trim + copy refs into state
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current) return
      dirtyRef.current = false

      priceRef.current = trimOldData(priceRef.current)
      atrRef.current = trimOldData(atrRef.current)
      regimeRef.current = trimOldData(regimeRef.current)

      // Snapshot to state (single allocation per array)
      setPriceHistory([...priceRef.current])
      setAtrHistory([...atrRef.current])
      setRegimeHistory([...regimeRef.current])
    }

    // Flush immediately on mount (in case cache was loaded)
    flush()
    const interval = setInterval(flush, FLUSH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [trimOldData])

  // Clear all data
  const clearData = useCallback(() => {
    priceRef.current = []
    atrRef.current = []
    regimeRef.current = []
    dirtyRef.current = false
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

    // Load cache into refs
    if (cachedData.priceHistory?.length > 0) {
      priceRef.current = cachedData.priceHistory.filter(p => p.timestamp > cutoff)
    }
    if (cachedData.atrHistory?.length > 0) {
      atrRef.current = cachedData.atrHistory.filter(a => a.timestamp > cutoff)
    }
    if (cachedData.regimeHistory?.length > 0) {
      regimeRef.current = cachedData.regimeHistory.filter(r => r.timestamp > cutoff)
    }

    // Flush to state immediately so charts render
    setPriceHistory([...priceRef.current])
    setAtrHistory([...atrRef.current])
    setRegimeHistory([...regimeRef.current])
    dirtyRef.current = false

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
