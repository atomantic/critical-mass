import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  computeAtomoku,
  computeBollingerSeries,
  computeVWAPSeries,
  computeRSISeries,
  computeStochasticSeries,
  computeMACDSeries,
} from '../utils/computeIndicatorSeries'
import { apiGet } from '../utils/apiClient'
import computeHeikinAshi from '../utils/computeHeikinAshi'
import { createCandleLabelCache } from '../utils/candleLabels.mjs'

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

/**
 * Bar interval definitions for the decoupled interval/range mode.
 */
export const BAR_INTERVALS = {
  '1m':  { intervalMs: 60_000,    candleTf: '1m',  label: '1m' },
  '3m':  { intervalMs: 180_000,   candleTf: '3m',  label: '3m' },
  '5m':  { intervalMs: 300_000,   candleTf: '5m',  label: '5m' },
  '15m': { intervalMs: 900_000,   candleTf: '15m', label: '15m' },
  '1h':  { intervalMs: 3_600_000, candleTf: '1h',  label: '1h' },
  '10m': { intervalMs: 600_000,     candleTf: '10m', label: '10m' },
  '30m': { intervalMs: 1_800_000,   candleTf: '30m', label: '30m' },
  '2h':  { intervalMs: 7_200_000,   candleTf: '2h',  label: '2h' },
  '4h':  { intervalMs: 14_400_000,  candleTf: '4h',  label: '4h' },
  '1d':  { intervalMs: 86_400_000,  candleTf: '1d',  label: '1D' },
  '1w':  { intervalMs: 604_800_000, candleTf: '1w',  label: '1W' },
}

/**
 * Valid time ranges per bar interval, derived from server ring buffer limits.
 * Each range: { rangeMs, maxBuckets, label }
 */
export const TIME_RANGES_BY_INTERVAL = {
  '1m':  [
    { key: '30m', rangeMs: 30 * 60_000,     maxBuckets: 30,  label: '30m' },
    { key: '1h',  rangeMs: 60 * 60_000,     maxBuckets: 60,  label: '1H' },
    { key: '3h',  rangeMs: 180 * 60_000,    maxBuckets: 180, label: '3H' },
  ],
  '3m':  [
    { key: '1h',  rangeMs: 60 * 60_000,     maxBuckets: 20,  label: '1H' },
    { key: '3h',  rangeMs: 180 * 60_000,    maxBuckets: 60,  label: '3H' },
    { key: '8h',  rangeMs: 480 * 60_000,    maxBuckets: 160, label: '8H' },
  ],
  '5m':  [
    { key: '1h',  rangeMs: 60 * 60_000,     maxBuckets: 12,  label: '1H' },
    { key: '6h',  rangeMs: 360 * 60_000,    maxBuckets: 72,  label: '6H' },
    { key: '15h', rangeMs: 900 * 60_000,    maxBuckets: 180, label: '15H' },
  ],
  '15m': [
    { key: '6h',  rangeMs: 360 * 60_000,    maxBuckets: 24,  label: '6H' },
    { key: '1d',  rangeMs: 1440 * 60_000,   maxBuckets: 96,  label: '1D' },
    { key: '2d',  rangeMs: 2700 * 60_000,   maxBuckets: 180, label: '2D' },
  ],
  '1h':  [
    { key: '1d',  rangeMs: 1440 * 60_000,   maxBuckets: 24,  label: '1D' },
    { key: '3d',  rangeMs: 4320 * 60_000,   maxBuckets: 72,  label: '3D' },
    { key: '7d',  rangeMs: 10080 * 60_000,  maxBuckets: 168, label: '7D' },
  ],
  '10m': [
    { key: '3h',  rangeMs: 180 * 60_000,   maxBuckets: 18,  label: '3H' },
    { key: '12h', rangeMs: 720 * 60_000,   maxBuckets: 72,  label: '12H' },
    { key: '1d',  rangeMs: 1440 * 60_000,  maxBuckets: 144, label: '1D' },
  ],
  '30m': [
    { key: '6h',  rangeMs: 360 * 60_000,   maxBuckets: 12,  label: '6H' },
    { key: '1d',  rangeMs: 1440 * 60_000,  maxBuckets: 48,  label: '1D' },
    { key: '2d',  rangeMs: 2880 * 60_000,  maxBuckets: 96,  label: '2D' },
  ],
  '2h': [
    { key: '1d',  rangeMs: 1440 * 60_000,  maxBuckets: 12,  label: '1D' },
    { key: '3d',  rangeMs: 4320 * 60_000,  maxBuckets: 36,  label: '3D' },
    { key: '7d',  rangeMs: 10080 * 60_000, maxBuckets: 84,  label: '7D' },
  ],
  '4h': [
    { key: '3d',  rangeMs: 4320 * 60_000,  maxBuckets: 18,  label: '3D' },
    { key: '7d',  rangeMs: 10080 * 60_000, maxBuckets: 42,  label: '7D' },
    { key: '10d', rangeMs: 14400 * 60_000, maxBuckets: 60,  label: '10D' },
  ],
  '1d': [
    { key: '7d',  rangeMs: 10080 * 60_000, maxBuckets: 7,   label: '7D' },
    { key: '30d', rangeMs: 43200 * 60_000, maxBuckets: 30,  label: '30D' },
    { key: '60d', rangeMs: 86400 * 60_000, maxBuckets: 60,  label: '60D' },
  ],
  '1w': [
    { key: '12w', rangeMs: 12 * 604_800_000, maxBuckets: 12,  label: '12W' },
    { key: '26w', rangeMs: 26 * 604_800_000, maxBuckets: 26,  label: '26W' },
    { key: '52w', rangeMs: 52 * 604_800_000, maxBuckets: 52,  label: '1Y' },
  ],
}

const SYNC_INTERVAL_MS = 5_000

/**
 * Create an empty bucket at a given time key
 */
const emptyBucket = (time, price) => ({
  time,
  open: price,
  price,
  high: price,
  low: price,
  haOpen: null,
  haHigh: null,
  haLow: null,
  haClose: null,
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
  signalChange: null,
})

const resetBucketIndicators = (bucket) => {
  bucket.haOpen = null
  bucket.haHigh = null
  bucket.haLow = null
  bucket.haClose = null
  bucket.bollingerUpper = null
  bucket.bollingerMiddle = null
  bucket.bollingerLower = null
  bucket.vwap = null
  bucket.rsi = null
  bucket.stochK = null
  bucket.stochD = null
  bucket.macdLine = null
  bucket.macdSignal = null
  bucket.macdHistogram = null
  bucket.atomokuConv = null
  bucket.atomokuBase = null
  bucket.atomokuLead1 = null
  bucket.atomokuLead2 = null
  bucket.atomokuLagging = null
}

/**
 * Prune source candles and display buckets using ratio-scaled retention limit.
 * Accounts for all configured/supported views sharing the timeframe to prevent
 * losing history when switching between aggregations.
 */
const pruneRetention = (sourceMap, displayMap, bucketMs, sourceCandleMs, maxBuckets, views, candleTf) => {
  const currentRatio = Math.max(1, Math.ceil(bucketMs / (sourceCandleMs || bucketMs)))
  let maxRequiredSource = (maxBuckets || 60) * currentRatio

  if (views) {
    for (const v of Object.values(views)) {
      if (v && (!v.candleTf || v.candleTf === candleTf)) {
        const vRatio = Math.max(1, Math.ceil((v.bucketMs || 60_000) / (sourceCandleMs || 60_000)))
        const vBuckets = v.maxBuckets || 60
        const needed = vBuckets * vRatio
        if (needed > maxRequiredSource) maxRequiredSource = needed
      }
    }
  }

  // Support typical aggregated view depths up to 300 buckets (e.g. 300 * 5 = 1500)
  maxRequiredSource = Math.max(maxRequiredSource, 1500)

  const indicatorLookback = 100 * currentRatio
  const sourceLimit = Math.max(1500, Math.ceil((maxRequiredSource + indicatorLookback) * 1.5))
  if (sourceMap && sourceMap.size > sourceLimit) {
    const sortedKeys = [...sourceMap.keys()].sort((a, b) => a - b)
    const toDelete = sortedKeys.slice(0, sortedKeys.length - sourceLimit)
    for (const k of toDelete) sourceMap.delete(k)
  }
  const displayLimit = Math.max(1000, Math.ceil(((maxBuckets || 60) + 100) * 1.5))
  if (displayMap && displayMap.size > displayLimit) {
    const sortedKeys = [...displayMap.keys()].sort((a, b) => a - b)
    const toDelete = sortedKeys.slice(0, sortedKeys.length - displayLimit)
    for (const k of toDelete) displayMap.delete(k)
  }
}

/**
 * Shared hook for candle data management.
 * Fetches from /api/candles/:exchange, accumulates live ticks into buckets,
 * syncs to React state on a 5s interval.
 *
 * Two modes:
 * - Legacy mode (options.views provided): coupled view presets, no HA
 * - Interval/range mode (no options.views): decoupled selectors with HA computation
 *
 * @param {string} exchange - 'cryptocom' | 'coinbase'
 * @param {number | null | undefined} tickPrice - live price from socket
 * @param {number | null | undefined} tickTimestamp - live tick timestamp
 * @param {Object} [options]
 * @param {Object} [options.views] - custom VIEWS config (legacy mode)
 * @param {string} [options.defaultView] - initial view key (defaults to '1d')
 * @param {string} [options.defaultInterval] - initial bar interval for interval/range mode
 * @param {string} [options.defaultRange] - initial time range for interval/range mode
 * @param {number} [options.maxBucketsOverride] - override maxBuckets (candle count) for display
 */
/**
 * Merge signal change annotations into bucket map by matching timestamps to nearest bucket key.
 */
const SIGNAL_PRIORITY = {
  STRONG_BUY: 5, STRONG_SELL: 5, CLOSE: 5,
  BUY: 4, SELL: 4, OPEN: 4,
  ADD: 3,
}

const applySignalAnnotations = (map, annotations, bucketMs) => {
  if (!annotations?.length) return
  const keys = [...map.keys()].sort((a, b) => a - b)
  if (!keys.length) return

  for (const ann of annotations) {
    // Snap to the nearest bucket key (epoch-aligned first, then nearest match)
    const bKey = Math.floor(ann.timestamp / bucketMs) * bucketMs
    let bucket = map.get(bKey)

    // Fall back to nearest bucket key within one bucket width
    // (handles 1d/1w charts where exchange boundaries differ from epoch multiples)
    if (!bucket) {
      let best = null, bestDist = Infinity
      for (const k of keys) {
        const dist = Math.abs(k - ann.timestamp)
        if (dist < bestDist) { bestDist = dist; best = k }
      }
      if (best != null && bestDist <= bucketMs) {
        bucket = map.get(best)
      }
    }

    if (bucket) {
      // Keep the highest-priority signal when multiple annotations land in the same bucket
      const existing = bucket.signalChange
      const newPri = SIGNAL_PRIORITY[ann.type] || 0
      const oldPri = existing ? (SIGNAL_PRIORITY[existing.type] || 0) : -1
      if (newPri >= oldPri) {
        bucket.signalChange = { type: ann.type, score: ann.score }
      }
    }
  }
}

export default function useCandleData(exchange, tickPrice, tickTimestamp, options = {}) {
  const legacyMode = !!options.views || !options.defaultInterval

  // --- Legacy mode state ---
  const viewsRef = useRef(options.views || DEFAULT_VIEWS)
  const views = viewsRef.current
  const viewKeys = useMemo(() => Object.keys(views), [views])
  const [view, setView] = useState(options.defaultView || '1d')

  // --- Interval/range mode state ---
  const [interval, setIntervalState] = useState(options.defaultInterval || '5m')
  const [timeRange, setTimeRange] = useState(() => {
    const defaultInt = options.defaultInterval || '5m'
    const ranges = TIME_RANGES_BY_INTERVAL[defaultInt]
    if (options.defaultRange) {
      const match = ranges?.find(r => r.key === options.defaultRange)
      if (match) return options.defaultRange
    }
    return ranges?.[1]?.key || ranges?.[0]?.key || '6h'
  })

  // When interval changes, auto-adjust timeRange to the middle range
  const setInterval = useCallback((newInterval) => {
    setIntervalState(newInterval)
    const ranges = TIME_RANGES_BY_INTERVAL[newInterval]
    if (ranges?.length) {
      setTimeRange(ranges[Math.min(1, ranges.length - 1)].key)
    }
  }, [])

  const availableRanges = useMemo(
    () => TIME_RANGES_BY_INTERVAL[interval] || [],
    [interval]
  )

  // Derive bucketMs / maxBuckets / candleTf from either mode
  const { bucketMs, maxBuckets, candleTf, indicatorTf } = useMemo(() => {
    if (legacyMode) {
      const vc = views[view] || views[viewKeys[0]]
      if (options.maxBucketsOverride) return { ...vc, maxBuckets: options.maxBucketsOverride }
      return vc
    }
    const barCfg = BAR_INTERVALS[interval] || BAR_INTERVALS['5m']
    const ranges = TIME_RANGES_BY_INTERVAL[interval] || TIME_RANGES_BY_INTERVAL['5m']
    const rangeCfg = ranges.find(r => r.key === timeRange) || ranges[0]
    return {
      bucketMs: barCfg.intervalMs,
      maxBuckets: options.maxBucketsOverride || rangeCfg?.maxBuckets || 60,
      candleTf: barCfg.candleTf,
      indicatorTf: barCfg.candleTf,
    }
  }, [legacyMode, views, view, viewKeys, interval, timeRange, options.maxBucketsOverride])

  const [chartData, setChartData] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const retry = useCallback(() => setRetryNonce(n => n + 1), [])

  const sourceCandlesMapRef = useRef(new Map())
  const bucketsRef = useRef(new Map())
  const labelCacheRef = useRef(null)
  if (labelCacheRef.current === null) labelCacheRef.current = createCandleLabelCache()
  const lastBucketKeyRef = useRef(null)
  const historicalCandlesRef = useRef(null)
  const lastHARef = useRef(null) // previous bucket's HA values for live tick updates
  const activeSeriesKeyRef = useRef(null)
  const fetchSeqRef = useRef(0)
  const lastTickTimeRef = useRef(null)
  const lastTickWallClockRef = useRef(null)

  const getNow = useCallback(() => {
    if (lastTickTimeRef.current != null && lastTickWallClockRef.current != null) {
      return lastTickTimeRef.current + (Date.now() - lastTickWallClockRef.current)
    }
    return Date.now()
  }, [])

  const viewConfig = legacyMode ? (views[view] || views[viewKeys[0]]) : {
    bucketMs, maxBuckets, candleTf, indicatorTf,
  }

  const sourceCandleMs = BAR_INTERVALS[candleTf]?.intervalMs || bucketMs

  // Signal annotations ref (updated from outside via options)
  const signalAnnotationsRef = useRef(options.signalAnnotations || null)
  signalAnnotationsRef.current = options.signalAnnotations || null

  // Sync buckets ref → chart state
  const syncChart = useCallback(() => {
    const map = bucketsRef.current
    // Clear previous signal annotations then re-apply current set
    for (const bucket of map.values()) bucket.signalChange = null
    applySignalAnnotations(map, signalAnnotationsRef.current, bucketMs)

    const displayed = [...map.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-maxBuckets)
    setChartData(labelCacheRef.current.sync(displayed, { exchange, bucketMs }))
  }, [maxBuckets, bucketMs, exchange])

  /**
   * Compute HA values on sorted bucket array and write them back into the map.
   */
  const applyHeikinAshi = useCallback((map, sortedKeys) => {
    if (legacyMode) return
    const sortedBuckets = sortedKeys.map(k => map.get(k))
    const ha = computeHeikinAshi(sortedBuckets)
    for (let i = 0; i < sortedKeys.length; i++) {
      const bucket = map.get(sortedKeys[i])
      if (bucket && ha[i]) {
        bucket.haOpen = ha[i].haOpen
        bucket.haHigh = ha[i].haHigh
        bucket.haLow = ha[i].haLow
        bucket.haClose = ha[i].haClose
      }
    }
    // Store last completed bucket's HA for live tick updates
    if (ha.length >= 2) {
      lastHARef.current = ha[ha.length - 2]
    } else if (ha.length === 1) {
      lastHARef.current = ha[0]
    }
  }, [legacyMode])

  const maxBucketsRef = useRef(maxBuckets)
  maxBucketsRef.current = maxBuckets

  /**
   * Project canonical source candles onto display buckets and compute indicators client-side.
   * Preserves raw candle sequences for indicators and projects values onto buckets.
   */
  const updateFromSourceCandles = useCallback(() => {
    const sourceMap = sourceCandlesMapRef.current
    if (!sourceMap.size) return
    const sortedSourceCandles = [...sourceMap.values()].sort((a, b) => a.timestamp - b.timestamp)
    const map = bucketsRef.current

    // Group source candles into display buckets
    const bucketSourceGroups = new Map()
    for (const sc of sortedSourceCandles) {
      const bKey = Math.floor(sc.timestamp / bucketMs) * bucketMs
      let group = bucketSourceGroups.get(bKey)
      if (!group) {
        group = []
        bucketSourceGroups.set(bKey, group)
      }
      group.push(sc)
    }

    // Populate each display bucket from its group of source candles
    for (const [bKey, group] of bucketSourceGroups.entries()) {
      let bucket = map.get(bKey)
      if (!bucket) {
        bucket = emptyBucket(bKey, group[group.length - 1].close)
        map.set(bKey, bucket)
      } else {
        resetBucketIndicators(bucket)
      }
      bucket.open = group[0].open
      bucket.high = Math.max(...group.map(c => c.high))
      bucket.low = Math.min(...group.map(c => c.low))
      bucket.price = group[group.length - 1].close
      bucket.volume = group.reduce((sum, c) => sum + (c.volume || 0), 0)
      bucket.hasLiveTicks = group.some(c => c.hasLiveTicks)
    }

    // Prune stale display buckets when aggregation grouping changes
    for (const key of map.keys()) {
      if (!bucketSourceGroups.has(key)) {
        map.delete(key)
      }
    }

    // Compute indicator series on canonical source candles
    const candleBucketKeys = sortedSourceCandles.map(c => Math.floor(c.timestamp / bucketMs) * bucketMs)
    const bollinger = computeBollingerSeries(sortedSourceCandles)
    const vwap = computeVWAPSeries(sortedSourceCandles)
    const rsi = computeRSISeries(sortedSourceCandles)
    const stoch = computeStochasticSeries(sortedSourceCandles)
    const macd = computeMACDSeries(sortedSourceCandles)
    const atomoku = computeAtomoku(sortedSourceCandles)

    for (let i = 0; i < sortedSourceCandles.length; i++) {
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

    for (let i = 0; i < sortedSourceCandles.length; i++) {
      const bKey = candleBucketKeys[i]
      const bucket = map.get(bKey)
      if (!bucket) continue
      if (atomoku.leadLine1[i] != null) bucket.atomokuLead1 = atomoku.leadLine1[i]
      if (atomoku.leadLine2[i] != null) bucket.atomokuLead2 = atomoku.leadLine2[i]
    }

    // Apply Heikin Ashi on sorted display buckets
    const sortedBucketKeys = [...map.keys()].sort((a, b) => a - b)
    applyHeikinAshi(map, sortedBucketKeys)

    lastBucketKeyRef.current = sortedBucketKeys.length ? sortedBucketKeys[sortedBucketKeys.length - 1] : null
  }, [bucketMs, applyHeikinAshi])

  /**
   * Merge fetched historical candles into the canonical source sequence,
   * preserving newer live observations and observed extrema.
   */
  const mergeHistoricalCandles = useCallback((candles, requestTime, fetchSeq) => {
    if (!candles?.length) return
    const sourceMap = sourceCandlesMapRef.current
    const now = getNow()

    // Aggregate historical candles in incoming batch by sourceKey (sum volume, min/max extrema)
    const batchAggregated = new Map()
    for (const c of candles) {
      const ts = c.timestamp != null ? c.timestamp : (c.time < 1e11 ? c.time * 1000 : c.time)
      const sourceKey = Math.floor(ts / sourceCandleMs) * sourceCandleMs
      const vol = c.volume || 0
      const b = batchAggregated.get(sourceKey)
      if (b) {
        if (c.high > b.high) b.high = c.high
        if (c.low < b.low) b.low = c.low
        b.close = c.close
        b.volume += vol
      } else {
        batchAggregated.set(sourceKey, {
          timestamp: sourceKey,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: vol,
          hasHistoricalOpen: true,
        })
      }
    }

    for (const [sourceKey, b] of batchAggregated.entries()) {
      const existing = sourceMap.get(sourceKey)
      if (existing) {
        if (b.high > existing.high) existing.high = b.high
        if (b.low < existing.low) existing.low = b.low
        if (!existing.hasHistoricalOpen && b.open != null) {
          existing.open = b.open
          existing.hasHistoricalOpen = true
        }
        // Replace historical volume on refresh to avoid double counting
        existing.volume = b.volume

        const candleEndTime = sourceKey + sourceCandleMs
        const isCandleCompleted = now >= candleEndTime
        const requestStartedAfterCandleEnd = requestTime != null && requestTime >= candleEndTime
        const isResponseAuthoritative = requestStartedAfterCandleEnd && fetchSeq != null && (existing.lastTickFetchSeq == null || fetchSeq > existing.lastTickFetchSeq)

        if (existing.hasLiveTicks && (!isCandleCompleted || !requestStartedAfterCandleEnd)) {
          // Unfinished source candle or request started before candle completion:
          // Preserve live close; do not overwrite with pre-completion historical snapshot
        } else if (isResponseAuthoritative || !existing.hasLiveTicks) {
          existing.close = b.close
          if (isCandleCompleted) {
            existing.hasLiveTicks = false
          }
        }
      } else {
        sourceMap.set(sourceKey, b)
      }
    }

    // Bounded retention policy for source candles scaled by display-to-source interval ratio and indicator history
    pruneRetention(sourceMap, null, bucketMs, sourceCandleMs, maxBucketsRef.current, views, candleTf)

    // Project onto display buckets and compute indicators
    updateFromSourceCandles()
  }, [bucketMs, candleTf, getNow, sourceCandleMs, updateFromSourceCandles, views])

  const syncChartRef = useRef(syncChart)
  syncChartRef.current = syncChart
  const mergeHistoricalCandlesRef = useRef(mergeHistoricalCandles)
  mergeHistoricalCandlesRef.current = mergeHistoricalCandles

  const seriesKey = `${exchange}:${candleTf}`

  // Fetch historical candles on mount or timeframe/exchange change.
  // Retries once after 5s if the requested candleTf is missing (derived TFs may not be ready yet)
  const retryRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    let retryTimer = null
    let controller = new AbortController()

    // Isolated timeframe/exchange check:
    if (activeSeriesKeyRef.current !== seriesKey) {
      activeSeriesKeyRef.current = seriesKey
      sourceCandlesMapRef.current = new Map()
      bucketsRef.current = new Map()
      lastBucketKeyRef.current = null
      lastHARef.current = null
      historicalCandlesRef.current = null
      labelCacheRef.current.clear()
      setChartData([])
      lastTickTimeRef.current = null
      lastTickWallClockRef.current = null
    }

    retryRef.current = false
    setIsLoading(true)
    setError(null)
    const doFetch = () => {
      const fetchSeq = ++fetchSeqRef.current
      const requestTime = getNow()
      controller = new AbortController()
      apiGet(`/api/candles/${exchange}`, { signal: controller.signal })
        .then(result => {
          if (!result.ok) throw new Error(result.status >= 400 ? `Candle history request failed (${result.status})` : result.error)
          return result.data
        })
        .then(data => {
          if (cancelled) return
          if (!data?.candles) { setIsLoading(false); return }
          historicalCandlesRef.current = data.candles
          // If the requested TF has data or we already retried, done loading
          if (data.candles[candleTf]?.length || retryRef.current) {
            if (data.candles[candleTf]?.length) {
              mergeHistoricalCandlesRef.current(data.candles[candleTf], requestTime, fetchSeq)
              syncChartRef.current()
            }
            setIsLoading(false)
          } else {
            // Derived TF not seeded yet — retry once after 5s (keep isLoading=true)
            retryRef.current = true
            retryTimer = setTimeout(() => { if (!cancelled) doFetch() }, 5000)
          }
        })
        .catch(err => {
          if (cancelled || err?.name === 'AbortError') return
          setError(err?.message || 'Candle history request failed')
          setIsLoading(false)
        })
    }
    doFetch()
    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [exchange, candleTf, retryNonce, seriesKey, getNow])

  // Derive projection on display limit / range / bucket aggregation / annotations change
  useEffect(() => {
    updateFromSourceCandles()
    syncChart()
  }, [bucketMs, maxBuckets, options.signalAnnotations, syncChart, updateFromSourceCandles])

  // Process live ticks into source candles and buckets (ref mutation only — no re-render per tick)
  useEffect(() => {
    if (tickPrice == null) return
    const now = tickTimestamp != null ? Number(tickTimestamp) : Date.now()
    lastTickTimeRef.current = now
    lastTickWallClockRef.current = Date.now()
    const sourceKey = Math.floor(now / sourceCandleMs) * sourceCandleMs
    const bKey = Math.floor(now / bucketMs) * bucketMs
    const sourceMap = sourceCandlesMapRef.current
    const map = bucketsRef.current

    // Update source candle
    const sc = sourceMap.get(sourceKey)
    if (sc) {
      sc.close = tickPrice
      sc.hasLiveTicks = true
      sc.lastTickFetchSeq = fetchSeqRef.current
      if (tickPrice > sc.high) sc.high = tickPrice
      if (tickPrice < sc.low) sc.low = tickPrice
    } else {
      sourceMap.set(sourceKey, {
        timestamp: sourceKey,
        open: tickPrice,
        high: tickPrice,
        low: tickPrice,
        close: tickPrice,
        volume: 0,
        hasLiveTicks: true,
        lastTickFetchSeq: fetchSeqRef.current,
      })
    }

    // Update display bucket
    const b = map.get(bKey)
    if (b) {
      b.price = tickPrice
      b.hasLiveTicks = true
      if (tickPrice > b.high) b.high = tickPrice
      if (tickPrice < b.low) b.low = tickPrice
    } else {
      const nb = emptyBucket(bKey, tickPrice)
      nb.hasLiveTicks = true
      map.set(bKey, nb)
    }

    // Live HA update for current bucket
    if (!legacyMode) {
      const current = map.get(bKey)
      if (current) {
        const prev = lastHARef.current
        const o = current.open
        const h = current.high
        const l = current.low
        const c = current.price
        const haClose = (o + h + l + c) / 4
        const haOpen = prev ? (prev.haOpen + prev.haClose) / 2 : (o + c) / 2
        current.haOpen = haOpen
        current.haClose = haClose
        current.haHigh = Math.max(h, haOpen, haClose)
        current.haLow = Math.min(l, haOpen, haClose)
      }
    }

    // Bounded retention policy scaled by display-to-source interval ratio
    pruneRetention(sourceMap, map, bucketMs, sourceCandleMs, maxBucketsRef.current, views, candleTf)

    // Immediate sync when a new bucket opens
    if (lastBucketKeyRef.current != null && lastBucketKeyRef.current !== bKey) {
      // Store the completed bucket's HA as the new prev for future ticks
      const prevBucket = map.get(lastBucketKeyRef.current)
      if (prevBucket && prevBucket.haOpen != null) {
        lastHARef.current = {
          haOpen: prevBucket.haOpen,
          haClose: prevBucket.haClose,
        }
      }
      updateFromSourceCandles()
      syncChart()
    }
    lastBucketKeyRef.current = bKey
  }, [tickPrice, tickTimestamp, sourceCandleMs, bucketMs, legacyMode, syncChart, updateFromSourceCandles, views, candleTf])

  useEffect(() => () => labelCacheRef.current.clear(), [])

  // Periodic sync (renders chart at most every 5s)
  // NOTE: must use window.setInterval to avoid the custom setInterval (line ~187) shadowing
  useEffect(() => {
    const t = window.setInterval(syncChart, SYNC_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [syncChart])

  return {
    chartData,
    view,
    setView,
    isLoading,
    error,
    retry,
    viewConfig,
    views,
    // Interval/range mode returns
    interval,
    setInterval,
    timeRange,
    setTimeRange,
    availableRanges,
  }
}

export { formatBucketLabel } from '../utils/candleLabels.mjs'
