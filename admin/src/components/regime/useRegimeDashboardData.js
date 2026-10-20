import { useState, useEffect, useCallback, useRef } from 'react'
import { useRegimeEvents } from '../../hooks/useTradeEvents'
import { useChartDataBuffer } from '../../hooks/useChartDataBuffer'
import { createRequestOwner } from '../../utils/requestOwner.mjs'

export default function useRegimeDashboardData(exchange, pair, pairQuery) {
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [liveFills, setLiveFills] = useState([])
  const [fillAggregates, setFillAggregates] = useState(null)
  const [presets, setPresets] = useState(null)
  const prevPriceRef = useRef(null)
  // Per-mount ownership fence for fills reads (#508). Initial load, the live
  // fill marker refresh and action handlers all refetch fills concurrently; only
  // the newest read may commit, so a slow older response cannot resurrect a
  // pre-fill snapshot over a newer one.
  const [fillsOwner] = useState(createRequestOwner)
  useEffect(() => () => fillsOwner.invalidate(), [fillsOwner])
  const { status: socketStatus, setStatus: setSocketStatus } = useRegimeEvents(exchange, pair)

  // Use socket status when available, fall back to local status (for initial load / when engine stopped)
  const status = socketStatus || localStatus

  // Chart data buffering with cache support
  const { priceHistory, atrHistory, regimeHistory, initializeFromCache } = useChartDataBuffer(status)

  // Sync config from status updates (hot-reload without refresh)
  useEffect(() => {
    if (status?.config) {
      setConfig(prev => prev ? { ...prev, ...status.config } : status.config)
    }
  }, [status?.config])

  // Track previous price for animation
  useEffect(() => {
    if (status?.market?.lastPrice) {
      prevPriceRef.current = status.market.lastPrice
    }
  }, [status?.market?.lastPrice])


  // Fetch status (only used for initial load and when engine is stopped)
  const fetchStatus = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/status${pairQuery}`)
    if (res.ok) {
      const data = await res.json()
      setLocalStatus(data.status)
      setError(null)
    }
  }, [exchange])

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`)
    if (res.ok) {
      const data = await res.json()
      setConfig(data.config)
    }
  }, [exchange])

  // Fetch bounded fill aggregates from the cached engine read view. Reads go through the per-mount request
  // owner so overlapping refreshes always commit in request order (#508).
  const fetchFills = useCallback(async () => {
    const { owned, data } = await fillsOwner.read(`/api/${exchange}/regime/fills/cycles${pairQuery}`)
    if (owned && data) {
      setFillAggregates(data)
      setLiveFills(data.detailFills || [])
    }
  }, [exchange, pairQuery, fillsOwner])

  // Refresh the Filled Orders table when a fill lands. fetchFills otherwise ran
  // only on mount + manual actions, so the realized-P&L bar and cycle groupings
  // went stale while the engine traded live — visibly disagreeing with the
  // socket-driven Position card. Key on the position markers that change on a
  // buy or sell fill; debounce so a burst of partial-fill status emits triggers
  // a single refetch (#111). Declared AFTER fetchFills to avoid a TDZ
  // ReferenceError on the dep array at render (#111 review).
  const fillMarker = `${status?.position?.cyclesCompleted ?? ''}:${status?.position?.cycleBuys ?? ''}:${status?.position?.realizedPnL ?? ''}:${status?.position?.realizedAssetPnL ?? ''}`
  const fillRefreshRef = useRef(null)
  useEffect(() => {
    // Skip the very first run (mount already fetched fills).
    if (fillRefreshRef.current === null) { fillRefreshRef.current = fillMarker; return }
    if (fillRefreshRef.current === fillMarker) return
    fillRefreshRef.current = fillMarker
    const t = setTimeout(() => { fetchFills() }, 1500)
    return () => clearTimeout(t)
  }, [fillMarker, fetchFills])

  // Fetch cached chart data from server
  const fetchCachedChartData = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/chart-data${pairQuery}`)
    if (res.ok) {
      const data = await res.json()
      if (data.data) {
        initializeFromCache(data.data)
      }
    }
  }, [exchange, initializeFromCache])

  // Fetch aggressiveness presets
  const fetchPresets = useCallback(async () => {
    const res = await fetch('/api/presets/aggressiveness')
    if (res.ok) {
      const data = await res.json()
      setPresets(data.presets)
    }
  }, [])

  const isRunning = status?.isRunning
  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        await Promise.all([fetchStatus(), fetchConfig(), fetchFills(), fetchCachedChartData(), fetchPresets()])
      } catch {
        // Leave whatever state the individual fetches already set — loading
        // below still clears so the page never gets stuck on "Loading…".
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData, fetchPresets])

  return { status, config, loading, error, liveFills, fillAggregates, presets, isRunning, prevPriceRef, priceHistory, atrHistory, regimeHistory, setSocketStatus, fetchStatus, fetchConfig, fetchFills }
}
