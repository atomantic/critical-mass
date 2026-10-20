import { useState, useEffect, useCallback, useRef } from 'react'
import { useRegimeEvents } from '../../hooks/useTradeEvents'
import { useChartDataBuffer } from '../../hooks/useChartDataBuffer'
import { createRequestOwner } from '../../utils/requestOwner.mjs'

export default function useRegimeDashboardData(exchange, pair, pairQuery) {
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reads, setReads] = useState({
    status: { state: 'loading', hasData: false },
    config: { state: 'loading', hasData: false },
    fills: { state: 'loading', hasData: false },
  })
  const [liveFills, setLiveFills] = useState([])
  const [fillAggregates, setFillAggregates] = useState(null)
  const [presets, setPresets] = useState(null)
  const prevPriceRef = useRef(null)
  // Per-mount ownership fence for fills reads (#508). Initial load, the live
  // fill marker refresh and action handlers all refetch fills concurrently; only
  // the newest read may commit, so a slow older response cannot resurrect a
  // pre-fill snapshot over a newer one.
  const [fillsOwner] = useState(createRequestOwner)
  const [statusOwner] = useState(createRequestOwner)
  const [configOwner] = useState(createRequestOwner)
  useEffect(() => () => {
    fillsOwner.invalidate()
    statusOwner.invalidate()
    configOwner.invalidate()
  }, [fillsOwner, statusOwner, configOwner])
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


  // Each resource keeps its last good snapshot independently. An unsuccessful
  // owned read records an error without replacing that snapshot with empty data.
  const readSnapshot = useCallback(async (name, owner, commit) => {
    setReads(prev => ({ ...prev, [name]: { ...prev[name], state: 'loading' } }))
    const { owned, ok, data } = await owner.read(`/api/${exchange}/regime/${name === 'fills' ? 'fills/cycles' : name}${pairQuery}`)
    if (!owned) return false
    const value = name === 'fills' ? data : data?.[name]
    const valid = ok && (name === 'fills' ? Array.isArray(value?.detailFills) : value && typeof value === 'object')
    if (valid) commit(value)
    setReads(prev => ({ ...prev, [name]: valid
      ? { state: 'ready', hasData: true }
      : { ...prev[name], state: 'error', error: `${name === 'fills' ? 'Fills' : name === 'status' ? 'Status' : 'Configuration'} request failed` },
    }))
    return Boolean(valid)
  }, [exchange, pairQuery])

  const fetchStatus = useCallback(() => readSnapshot('status', statusOwner, setLocalStatus), [readSnapshot, statusOwner])
  const fetchConfig = useCallback(() => readSnapshot('config', configOwner, setConfig), [readSnapshot, configOwner])
  // Keep fillsOwner.read's ownership fence for concurrent marker/action reads.
  const fetchFills = useCallback(() => readSnapshot('fills', fillsOwner, data => {
    setFillAggregates(data)
    setLiveFills(data.detailFills)
  }), [readSnapshot, fillsOwner])
  const retry = useCallback(() => Promise.all([
    ...(reads.status.state === 'error' ? [fetchStatus()] : []),
    ...(reads.config.state === 'error' ? [fetchConfig()] : []),
    ...(reads.fills.state === 'error' ? [fetchFills()] : []),
  ]), [reads, fetchStatus, fetchConfig, fetchFills])
  const failedReads = Object.values(reads).filter(read => read.error)
  const error = failedReads.map(read => read.error).join('. ')
  const stale = failedReads.some(read => read.hasData)

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
  }, [exchange, pairQuery, initializeFromCache])

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
      await Promise.allSettled([fetchStatus(), fetchConfig(), fetchFills(), fetchCachedChartData(), fetchPresets()])
      setLoading(false)
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData, fetchPresets])

  return { status, config, loading, error, stale, retry, reads, fillsUnavailable: Boolean(reads.fills.error), liveFills, fillAggregates, presets, isRunning, prevPriceRef, priceHistory, atrHistory, regimeHistory, setSocketStatus, fetchStatus, fetchConfig, fetchFills }
}
