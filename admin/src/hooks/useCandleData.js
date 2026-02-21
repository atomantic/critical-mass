import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  computeAtomoku,
  computeBollingerSeries,
  computeVWAPSeries,
  computeRSISeries,
  computeStochasticSeries,
  computeMACDSeries,
} from '../utils/computeIndicatorSeries'

/**
 * Default view configurations for BTC price charts.
 * Each view maps server candle timeframes to bucket sizes and display limits.
 */
export const DEFAULT_VIEWS = {
  '1h':  { bucketMs: 60_000,    maxBuckets: 60,  indicatorTf: '1m',  candleTf: '1m',  label: '1H' },
  '6h':  { bucketMs: 300_000,   maxBuckets: 72,  indicatorTf: '5m',  candleTf: '5m',  label: '6H' },
  '1d':  { bucketMs: 900_000,   maxBuckets: 96,  indicatorTf: '15m', candleTf: '15m', label: '1D' },
  '7d':  { bucketMs: 3_600_000, maxBuckets: 168, indicatorTf: '1h',  candleTf: '1h',  label: '7D' },
}

const SYNC_INTERVAL_MS = 5_000

/**
 * Create an empty bucket at a given time key
 */
const emptyBucket = (time, price) => ({
  time,
  price,
  high: price,
  low: price,
  bollingerUpper: null,
  bollingerLower: null,
  bollingerMiddle: null,
  vwap: null,
  rsi: null,
  stochK: null,
  stochD: null,
  macdLine: null,
  macdSignal: null,
  macdHistogram: null,
  atomokuConv: null,
  atomokuBase: null,
  atomokuLead1: null,
  atomokuLead2: null,
  atomokuLagging: null,
})

/**
 * Shared hook for candle data management.
 * Fetches from /api/candles/:exchange, accumulates live ticks into buckets,
 * syncs to React state on a 5s interval.
 *
 * @param {string} exchange - 'cryptocom' | 'coinbase'
 * @param {number | null | undefined} tickPrice - live price from socket
 * @param {number | null | undefined} tickTimestamp - live tick timestamp
 * @param {Object} [options]
 * @param {Object} [options.views] - custom VIEWS config (defaults to DEFAULT_VIEWS)
 * @param {string} [options.defaultView] - initial view key (defaults to '1d')
 * @returns {{chartData: Array, view: string, setView: Function, isLoading: boolean, viewConfig: Object, views: Object}}
 */
export default function useCandleData(exchange, tickPrice, tickTimestamp, options = {}) {
  // Stabilize views ref — only changes if caller passes a different views object
  const viewsRef = useRef(options.views || DEFAULT_VIEWS)
  const views = viewsRef.current

  const viewKeys = useMemo(() => Object.keys(views), [views])
  const [view, setView] = useState(options.defaultView || '1d')
  const [chartData, setChartData] = useState([])
  const [isLoading, setIsLoading] = useState(true)

  const bucketsRef = useRef(new Map())
  const lastBucketKeyRef = useRef(null)
  const historicalCandlesRef = useRef(null)

  const viewConfig = views[view] || views[viewKeys[0]]
  const { bucketMs, maxBuckets, candleTf } = viewConfig

  // Sync buckets ref → chart state (only depends on view scalars)
  const syncChart = useCallback(() => {
    const arr = [...bucketsRef.current.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-maxBuckets)
      .map(([key, d]) => ({ ...d, label: formatBucketLabel(key, bucketMs) }))
    setChartData(arr)
  }, [maxBuckets, bucketMs])

  /**
   * Populate buckets from historical candle data for the current view.
   * Computes all indicator series client-side from the raw candle array.
   */
  const populateFromCandles = useCallback((candles) => {
    if (!candles?.length) return
    const map = new Map()

    // Build bucket map from candles
    for (const c of candles) {
      const bKey = Math.floor(c.timestamp / bucketMs) * bucketMs
      const existing = map.get(bKey)
      if (existing) {
        if (c.high > existing.high) existing.high = c.high
        if (c.low < existing.low) existing.low = c.low
        existing.price = c.close
      } else {
        map.set(bKey, emptyBucket(bKey, c.close))
        const b = map.get(bKey)
        b.high = c.high
        b.low = c.low
      }
    }

    // Sort bucket keys for ordered access
    const sortedKeys = [...map.keys()].sort((a, b) => a - b)

    // Build candle-index → bucket-key mapping
    // Each candle maps to the bucket it falls into
    const candleBucketKeys = candles.map(c => Math.floor(c.timestamp / bucketMs) * bucketMs)

    // Compute indicator series from raw candles
    const bollinger = computeBollingerSeries(candles)
    const vwap = computeVWAPSeries(candles)
    const rsi = computeRSISeries(candles)
    const stoch = computeStochasticSeries(candles)
    const macd = computeMACDSeries(candles)
    const atomoku = computeAtomoku(candles)

    // Attach indicators: for each candle, apply values to its bucket.
    // When multiple candles map to the same bucket, last candle wins (most recent).
    for (let i = 0; i < candles.length; i++) {
      const bKey = candleBucketKeys[i]
      const bucket = map.get(bKey)
      if (!bucket) continue

      if (bollinger[i]) {
        bucket.bollingerUpper = bollinger[i].upper
        bucket.bollingerMiddle = bollinger[i].middle
        bucket.bollingerLower = bollinger[i].lower
      }
      if (vwap[i] != null) bucket.vwap = vwap[i]
      if (rsi[i] != null) bucket.rsi = rsi[i]
      if (stoch[i]) {
        bucket.stochK = stoch[i].k
        bucket.stochD = stoch[i].d
      }
      if (macd[i]) {
        bucket.macdLine = macd[i].macd
        bucket.macdSignal = macd[i].signal
        bucket.macdHistogram = macd[i].histogram
      }
      if (atomoku.conversionLine[i] != null) bucket.atomokuConv = atomoku.conversionLine[i]
      if (atomoku.baseLine[i] != null) bucket.atomokuBase = atomoku.baseLine[i]
      if (atomoku.laggingSpan[i] != null) bucket.atomokuLagging = atomoku.laggingSpan[i]
    }

    // Apply displaced lead lines to existing buckets.
    // leadLine1/2 arrays (length N + displacement) are pre-indexed for display position:
    // leadLine1[j] = value to show at candle position j.
    // We only apply indices 0..N-1 (within existing data range).
    for (let i = 0; i < candles.length; i++) {
      const bKey = candleBucketKeys[i]
      const bucket = map.get(bKey)
      if (!bucket) continue
      if (atomoku.leadLine1[i] != null) bucket.atomokuLead1 = atomoku.leadLine1[i]
      if (atomoku.leadLine2[i] != null) bucket.atomokuLead2 = atomoku.leadLine2[i]
    }

    // Prune to maxBuckets
    if (sortedKeys.length > maxBuckets) {
      for (const k of sortedKeys.slice(0, sortedKeys.length - maxBuckets)) map.delete(k)
    }

    bucketsRef.current = map
    const finalKeys = [...map.keys()].sort((a, b) => a - b)
    lastBucketKeyRef.current = finalKeys.length ? finalKeys[finalKeys.length - 1] : null
  }, [bucketMs, maxBuckets])

  // Fetch historical candles on mount
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    fetch(`/api/candles/${exchange}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.candles) return
        historicalCandlesRef.current = data.candles
        populateFromCandles(data.candles[candleTf])
        syncChart()
        setIsLoading(false)
      })
      .catch(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [exchange]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-populate from cached candles when view changes
  useEffect(() => {
    bucketsRef.current = new Map()
    lastBucketKeyRef.current = null
    const candles = historicalCandlesRef.current
    if (candles?.[candleTf]?.length) {
      populateFromCandles(candles[candleTf])
      syncChart()
    } else {
      setChartData([])
    }
  }, [view, candleTf, populateFromCandles, syncChart])

  // Process live ticks into buckets (ref mutation only — no re-render per tick)
  useEffect(() => {
    if (!tickPrice) return
    const now = tickTimestamp || Date.now()
    const bKey = Math.floor(now / bucketMs) * bucketMs
    const map = bucketsRef.current

    const b = map.get(bKey)
    if (b) {
      b.price = tickPrice
      if (tickPrice > b.high) b.high = tickPrice
      if (tickPrice < b.low) b.low = tickPrice
    } else {
      map.set(bKey, emptyBucket(bKey, tickPrice))
    }

    // Prune old buckets
    const cutoff = now - maxBuckets * bucketMs * 1.1
    for (const k of map.keys()) { if (k < cutoff) map.delete(k) }

    // Immediate sync when a new bucket opens
    if (lastBucketKeyRef.current != null && lastBucketKeyRef.current !== bKey) syncChart()
    lastBucketKeyRef.current = bKey
  }, [tickPrice, tickTimestamp, bucketMs, maxBuckets, syncChart])

  // Periodic sync (renders chart at most every 5s)
  useEffect(() => {
    const t = setInterval(syncChart, SYNC_INTERVAL_MS)
    return () => clearInterval(t)
  }, [syncChart])

  return { chartData, view, setView, isLoading, viewConfig, views }
}

/**
 * Format a bucket timestamp for the X axis label
 * @param {number} ts - bucket timestamp
 * @param {number} bucketMs - bucket duration in ms
 * @returns {string}
 */
export function formatBucketLabel(ts, bucketMs) {
  const d = new Date(ts)
  if (bucketMs >= 3_600_000) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
  }
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
