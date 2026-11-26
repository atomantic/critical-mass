import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRegimeEvents } from '../../hooks/useTradeEvents'
import { useChartDataBuffer } from '../../hooks/useChartDataBuffer'
import { createRequestOwner } from '../../utils/requestOwner.mjs'
import { apiGet } from '../../utils/apiClient'
import { readRegimeStatus } from '../../utils/readRegimeStatus'
import { shareStructure } from '../../utils/structuralShare.mjs'
import { EMPTY_SNAPSHOT, STATUS_STALE_MS, toUnreachableStatus } from '../../utils/regimeStatusSnapshot.mjs'

export default function useRegimeDashboardData(exchange, pair, pairQuery, readInitialStatus = readRegimeStatus) {
  const [localSnapshot, setLocalSnapshot] = useState(EMPTY_SNAPSHOT)
  // seq of the snapshot that went STATUS_STALE_MS without a successor
  const [silentSeq, setSilentSeq] = useState(null)
  const [config, setConfig] = useState(null)
  // Latches true once status and config have each settled, so a later refetch
  // (Retry, action, silent-engine probe) never swaps the dashboard back to the
  // full-page loading state.
  const [gateOpen, setGateOpen] = useState(false)
  // Chart history and presets load behind their own placeholders (not the gate).
  const [chartLoading, setChartLoading] = useState(true)
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [reads, setReads] = useState({
    status: { state: 'loading', hasData: false },
    config: { state: 'loading', hasData: false },
    fills: { state: 'loading', hasData: false },
  })
  const [liveFills, setLiveFills] = useState([])
  const [fillAggregates, setFillAggregates] = useState(null)
  const [presets, setPresets] = useState(null)
  // null = not failed; string = the presets read failed (presets stay null)
  const [presetsError, setPresetsError] = useState(null)
  const prevPriceRef = useRef(null)
  // Per-mount ownership fence for fills reads (#508). Initial load, the live
  // fill marker refresh and action handlers all refetch fills concurrently; only
  // the newest read may commit, so a slow older response cannot resurrect a
  // pre-fill snapshot over a newer one.
  const [fillsOwner] = useState(createRequestOwner)
  const [statusOwner] = useState(() => createRequestOwner({
    readImpl: (url, { initialReader, ...options }) => (initialReader ?? readRegimeStatus)(url, options),
  }))
  const [configOwner] = useState(createRequestOwner)
  useEffect(() => () => {
    fillsOwner.invalidate()
    statusOwner.invalidate()
    configOwner.invalidate()
  }, [fillsOwner, statusOwner, configOwner])
  const { status: socketStatus, statusSeq: socketSeq = 0, setStatus: setSocketStatus } = useRegimeEvents(exchange, pair)

  // The newest snapshot wins whichever source it came from, so an HTTP read
  // after an action or a Retry can replace a stale socket snapshot (#1388).
  const latest = socketStatus && (!localSnapshot.status || socketSeq > localSnapshot.seq)
    ? { status: socketStatus, seq: socketSeq }
    : localSnapshot
  // A running snapshot with no successor for STATUS_STALE_MS shows as an
  // unreachable engine (stopped-status fields only) until a fresh one arrives.
  const statusSilent = Boolean(latest.status) && silentSeq === latest.seq
  // Every push deserialises fresh objects; share unchanged subtrees with the
  // previous status so memoised panels keep their props between pushes.
  const sharedStatus = useRef(null)
  const status = useMemo(() => {
    const next = shareStructure(sharedStatus.current, statusSilent ? toUnreachableStatus(latest.status) : latest.status)
    sharedStatus.current = next
    return next
  }, [statusSilent, latest.status])

  // Chart data buffering with cache support. Fed the received snapshot, so a
  // silent engine adds no synthetic point at its frozen price.
  const { priceHistory, atrHistory, regimeHistory, initializeFromCache } = useChartDataBuffer(latest.status)

  // Sync config from status updates (hot-reload without refresh)
  useEffect(() => {
    if (status?.config) {
      setConfig(prev => prev ? shareStructure(prev, { ...prev, ...status.config }) : status.config)
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
  const readSnapshot = useCallback(async (name, owner, commit, options) => {
    setReads(prev => ({ ...prev, [name]: { ...prev[name], state: 'loading' } }))
    const { owned, ok, data, seq } = await owner.read(`/api/${exchange}/regime/${name === 'fills' ? 'fills/cycles' : name}${pairQuery}`, options)
    if (!owned) return false
    const value = name === 'fills' ? data : data?.[name]
    const valid = ok && (name === 'fills' ? Array.isArray(value?.detailFills) : value && typeof value === 'object')
    if (valid) {
      if (name === 'status') commit(value, seq)
      else commit(value)
    }
    setReads(prev => ({ ...prev, [name]: valid
      ? { state: 'ready', hasData: true }
      : { ...prev[name], state: 'error', error: `${name === 'fills' ? 'Fills' : name === 'status' ? 'Status' : 'Configuration'} request failed` },
    }))
    return Boolean(valid)
  }, [exchange, pairQuery])

  const fetchStatus = useCallback((fresh = true) =>
    readSnapshot('status', statusOwner, (value, seq) => setLocalSnapshot({ status: value, seq }), {
      fresh, initialReader: fresh ? undefined : readInitialStatus,
    }),
  [readInitialStatus, readSnapshot, statusOwner])

  // The engine's process dying sends nothing to the browser, and the socket's
  // "Live" state only tracks the gateway. Mark a running snapshot silent once
  // nothing has arrived for STATUS_STALE_MS and probe over HTTP: the gateway
  // answers with the on-disk ENGINE_DOWN status when the engine IPC is gone, or
  // the running engine's status when the market was just quiet. A stopped
  // snapshot already shows no running-only state, so a quiet stopped fund is
  // left as "Engine Stopped".
  const latestRunning = latest.status?.isRunning === true
  const latestSeq = latest.seq
  useEffect(() => {
    if (!latestRunning) return
    const t = setTimeout(() => {
      setSilentSeq(latestSeq)
      fetchStatus()
    }, STATUS_STALE_MS)
    return () => clearTimeout(t)
  }, [latestRunning, latestSeq, fetchStatus])
  const fetchConfig = useCallback(() => readSnapshot('config', configOwner, setConfig), [readSnapshot, configOwner])
  // Keep fillsOwner.read's ownership fence for concurrent marker/action reads.
  const fetchFills = useCallback(() => readSnapshot('fills', fillsOwner, data => {
    setFillAggregates(data)
    setLiveFills(data.detailFills)
  }), [readSnapshot, fillsOwner])
  // Fetch aggressiveness presets
  const fetchPresets = useCallback(async () => {
    try {
      const result = await apiGet('/api/presets/aggressiveness')
      if (result.status === 0) throw new Error(result.error || 'request failed')
      const data = result.ok ? result.data : null
      if (data?.presets && typeof data.presets === 'object') {
        setPresets(data.presets)
        setPresetsError(null)
      } else setPresetsError(`Presets unavailable${result.ok ? '' : ` (HTTP ${result.status})`}`)
    } catch {
      setPresetsError('Presets unavailable: request failed')
    } finally {
      setPresetsLoading(false)
    }
  }, [])
  const retry = useCallback(() => Promise.all([
    ...(presetsError ? [fetchPresets()] : []),
    ...(reads.status.state === 'error' ? [fetchStatus()] : []),
    ...(reads.config.state === 'error' ? [fetchConfig()] : []),
    ...(reads.fills.state === 'error' ? [fetchFills()] : []),
  ]), [reads, presetsError, fetchPresets, fetchStatus, fetchConfig, fetchFills])
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
    const result = await apiGet(`/api/${exchange}/regime/chart-data${pairQuery}`)
    if (result.status === 0) throw new Error(result.error || 'Network error')
    if (result.ok && result.data?.data) initializeFromCache(result.data.data)
  }, [exchange, pairQuery, initializeFromCache])

  const isRunning = status?.isRunning
  // First paint waits only for status + config. A socket snapshot that lands
  // before the HTTP status read satisfies the status half (the newest snapshot
  // still wins in `latest`), and the config half is also satisfied by the config
  // carried on a status snapshot.
  const statusSettled = Boolean(latest.status) || reads.status.state !== 'loading'
  const configSettled = config != null || reads.config.state !== 'loading'
  const gateReady = statusSettled && configSettled
  useEffect(() => { if (gateReady) setGateOpen(true) }, [gateReady])
  const loading = !gateOpen && !gateReady
  // Fills are still on their first read: consumers must show a loading state,
  // never "no fills" or a zero/partial total. A refetch that already holds data
  // keeps showing the last good snapshot instead.
  const fillsLoading = reads.fills.state === 'loading' && !reads.fills.hasData

  // Initial load only - no polling needed, socket provides live updates. All
  // reads start in parallel; only status + config gate the first paint.
  useEffect(() => {
    setChartLoading(true)
    setPresetsLoading(true)
    fetchStatus(false)
    fetchConfig()
    fetchFills()
    fetchPresets()
    fetchCachedChartData().catch(() => {}).finally(() => setChartLoading(false))
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData, fetchPresets])

  return { status, config, loading, fillsLoading, chartLoading, presetsLoading, error, stale, retry, reads, fillsUnavailable: Boolean(reads.fills.error), liveFills, fillAggregates, presets, presetsError, retryPresets: fetchPresets, isRunning, prevPriceRef, priceHistory, atrHistory, regimeHistory, setSocketStatus, fetchStatus, fetchConfig, fetchFills }
}
