import Button from './ui/Button'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRegimeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'
import CumulativePnlChart from './charts/CumulativePnlChart'
import { formatCurrency, formatPrice } from './charts/chartUtils'
import { pairQuery as buildPairQuery } from '../utils/api'
import { deriveRegimeCumulativePnl } from '../utils/regimeFillGroups.mjs'
import { apiGet } from '../utils/apiClient'
import { pnlColorClass } from '../utils/pnlFormat.mjs'

export function deriveFillMarker(status) {
  if (!status) return ''
  const pos = status.position
  return [
    pos?.cyclesCompleted ?? '',
    pos?.cycleBuys ?? '',
    pos?.realizedPnL ?? '',
    pos?.realizedAssetPnL ?? '',
    pos?.lastFillId ?? status.lastFillId ?? '',
    pos?.lastFillTime ?? status.lastFillTime ?? '',
    pos?.fillCount ?? status.fillCount ?? '',
  ].join(':')
}

function ChartsRegime({ exchange = 'coinbase', pair, fillDebounceMs = 1500 }) {
  const pairQuery = buildPairQuery(pair)
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [fillAggregates, setFillAggregates] = useState(null)
  const [loading, setLoading] = useState(true)
  const [historicalPrices, setHistoricalPrices] = useState([])
  const [historicalAtr, setHistoricalAtr] = useState([])
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false)
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const readState = useRef(null)
  const lastMarkerRef = useRef(null)
  const fetchFillsRef = useRef(null)

  const { connected, status: socketStatus } = useRegimeEvents(exchange, pair)

  // Use socket status when available, fall back to local status
  const status = socketStatus || localStatus
  const statusRef = useRef(status)
  statusRef.current = status

  // Chart data buffering (for real-time updates) with cache support
  const { priceHistory: realtimePrices, atrHistory: realtimeAtr, regimeHistory, initializeFromCache } = useChartDataBuffer(status)

  // Combine historical (1m candle) data with the live buffer. Once the live
  // buffer has any data it covers the same recent window as the candle
  // history (the buffer is restored from up to an hour of cached ticks), so
  // concatenating both wholesale double-covers that window with an unsorted
  // series — the price/ATR charts then draw a line that jumps backward in
  // time and redraws the same hour twice. Only keep the candle points that
  // predate the live buffer's earliest point, and always sort by timestamp
  // (matches RegimeDashboard, which only ever feeds the live buffer to its chart).
  const priceHistory = useMemo(() => {
    const earliestRealtime = realtimePrices[0]?.timestamp
    const olderHistorical = earliestRealtime != null
      ? historicalPrices.filter(d => d.timestamp < earliestRealtime)
      : historicalPrices
    return [...olderHistorical, ...realtimePrices].sort((a, b) => a.timestamp - b.timestamp)
  }, [historicalPrices, realtimePrices])

  const atrHistory = useMemo(() => {
    const earliestRealtime = realtimeAtr[0]?.timestamp
    const olderHistorical = earliestRealtime != null
      ? historicalAtr.filter(d => d.timestamp < earliestRealtime)
      : historicalAtr
    return [...olderHistorical, ...realtimeAtr].sort((a, b) => a.timestamp - b.timestamp)
  }, [historicalAtr, realtimeAtr])

  const fetchData = useCallback(async () => {
    const session = readState.current
    if (!session?.active || session.inFlight) return
    session.inFlight = true
    const controller = new AbortController()
    session.controller = controller
    let readSucceeded = false
    try {
      const candlesQuery = pair ? `?granularity=ONE_MINUTE&limit=60&pair=${encodeURIComponent(pair)}` : '?granularity=ONE_MINUTE&limit=60'
      const read = async (url, name) => {
        const result = await apiGet(url, { signal: controller.signal })
        if (!result.ok) throw new Error(result.status ? `${name} fetch failed: HTTP ${result.status}` : result.error)
        return result.data
      }
      const results = await Promise.allSettled([
        read(`/api/${exchange}/regime/status${pairQuery}`, 'Status'),
        read(`/api/${exchange}/regime/config${pairQuery}`, 'Config'),
        read(`/api/${exchange}/regime/fills/cycles${pairQuery}`, 'Fills'),
        read(`/api/${exchange}/candles${candlesQuery}`, 'Candles'),
        read(`/api/${exchange}/regime/chart-data${pairQuery}`, 'Chart data'),
      ])
      if (!session.active) return
      const requiredFailure = results.slice(0, 3).find(result => result.status === 'rejected')
      if (requiredFailure) throw requiredFailure.reason
      const [statusData, configData, fillsData] = results.slice(0, 3).map(result => result.value)
      const candlesResult = results[3]
      const cacheResult = results[4]
      const loadedMarker = deriveFillMarker(statusData.status)
      session.hasSnapshot = true
      session.loadedMarker = loadedMarker
      setLocalStatus(statusData.status)
      setConfig(configData.config)
      setFillAggregates(fillsData)
      setError(null)
      setStale(false)
      readSucceeded = true

      // If live socket status has a newer marker than the snapshot we just loaded, retain it as requested.
      const liveMarker = deriveFillMarker(statusRef.current || socketStatus)
      if (liveMarker && liveMarker !== loadedMarker) {
        session.requestedMarker = liveMarker
      }

      const unavailable = candlesResult.status === 'rejected' || cacheResult.status === 'rejected'
      setHistoryUnavailable(unavailable)
      if (candlesResult.status === 'fulfilled' && candlesResult.value.candles?.length) {
        const candles = candlesResult.value.candles
        setHistoricalPrices(candles.map(c => ({ timestamp: c.timestamp, price: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low) })).reverse())
        setHistoricalAtr(candles.map(c => ({ timestamp: c.timestamp, atr1m: parseFloat(c.high) - parseFloat(c.low), atr5m: null, realizedVol: null, volBaseline: null })).reverse())
      }
      if (cacheResult.status === 'fulfilled' && cacheResult.value.data) initializeFromCache(cacheResult.value.data)
    } catch (err) {
      if (!session.active) return
      if (!session.hasSnapshot) setError(err.message || 'Failed to load regime charts')
      else setStale(true)
    } finally {
      session.inFlight = false
      if (session.controller === controller) session.controller = null
      if (session.active) setLoading(false)
      if (session.active && readSucceeded && session.requestedMarker && session.requestedMarker !== session.loadedMarker) {
        fetchFillsRef.current?.()
      }
    }
  }, [exchange, pair, initializeFromCache]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFills = useCallback(async () => {
    const session = readState.current
    if (!session?.active || session.inFlight) return
    // Capture the marker at request start so a completed older request cannot acknowledge a later marker.
    const requestMarker = session.requestedMarker || deriveFillMarker(statusRef.current)
    session.inFlight = true
    const controller = new AbortController()
    session.fillsController = controller
    let readSucceeded = false
    try {
      const result = await apiGet(`/api/${exchange}/regime/fills/cycles${pairQuery}`, { signal: controller.signal })
      if (!result.ok) throw new Error(result.status ? `Fills fetch failed: HTTP ${result.status}` : result.error)
      const fillsData = result.data
      if (!session.active) return
      setFillAggregates(fillsData)
      setStale(false)
      session.loadedMarker = requestMarker
      readSucceeded = true
    } catch (err) {
      if (!session.active) return
      if (err.name !== 'AbortError') {
        if (!session.hasSnapshot) setError(err.message || 'Failed to load fills')
        else setStale(true)
      }
    } finally {
      session.inFlight = false
      if (session.fillsController === controller) session.fillsController = null
      if (session.active && readSucceeded && session.requestedMarker && session.requestedMarker !== session.loadedMarker) {
        fetchFillsRef.current?.()
      }
    }
  }, [exchange, pairQuery])
  fetchFillsRef.current = fetchFills

  useEffect(() => {
    const session = {
      active: true,
      inFlight: false,
      hasSnapshot: false,
      loadedMarker: null,
      requestedMarker: null,
      controller: null,
      fillsController: null,
    }
    readState.current = session
    lastMarkerRef.current = null
    setLocalStatus(null)
    setConfig(null)
    setFillAggregates(null)
    setHistoricalPrices([])
    setHistoricalAtr([])
    setError(null)
    setStale(false)
    setHistoryUnavailable(false)
    setLoading(true)
    fetchData()
    return () => {
      session.active = false
      session.controller?.abort()
      session.fillsController?.abort()
    }
  }, [fetchData])

  // Refresh fills aggregates when a fill lands in live status (#1390, #1818).
  const fillMarker = deriveFillMarker(status)
  useEffect(() => {
    if (lastMarkerRef.current === null) {
      lastMarkerRef.current = fillMarker
      return
    }
    if (lastMarkerRef.current === fillMarker) return
    lastMarkerRef.current = fillMarker
    const session = readState.current
    if (session && fillMarker && fillMarker === session.loadedMarker) return

    const t = setTimeout(() => {
      const session = readState.current
      if (!session?.active) return
      session.requestedMarker = fillMarker
      if (session.inFlight) return
      if (session.loadedMarker === fillMarker) return
      fetchFillsRef.current?.()
    }, fillDebounceMs)
    return () => clearTimeout(t)
  }, [fillMarker, fillDebounceMs])

  const isRunning = status?.isRunning
  const isDryRun = Boolean(status?.isDryRun || config?.dryRun)
  const market = status?.market || {}
  const position = status?.position || {}
  const regime = status?.regime || {}
  const dryRunFilled = status?.dryRun?.filledOrders || []
  const buyCount = isDryRun ? dryRunFilled.filter(f => f.side === 'buy').length : fillAggregates?.buyCount || 0
  const sellCount = isDryRun ? dryRunFilled.filter(f => f.side === 'sell').length : fillAggregates?.sellCount || 0

  // Calculate cumulative P&L distribution from fills aligned with cycle-pairing ruleset
  const pnlData = useMemo(() => {
    return isDryRun
      ? deriveRegimeCumulativePnl({ isDryRun, dryRunFilled })
      : (fillAggregates?.pnlPoints || []).map(point => ({ date: new Date(point.timestamp), pnl: point.pnl, cumulative: point.cumulative }))
  }, [fillAggregates, isDryRun, dryRunFilled])

  if (error) {
    return <div role="alert" className="flex flex-col items-center justify-center h-64 gap-4"><div className="text-red-400">Error: {error}</div><Button onClick={fetchData} variant="primary" size="md">Retry</Button></div>
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime charts...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {stale && <div role="status" className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-3 flex items-center justify-between"><span className="text-yellow-400">Data is stale. Waiting for a successful refresh...</span><Button onClick={fetchData} variant="warning" size="sm">Refresh Now</Button></div>}
      {!stale && <div className="flex justify-end"><Button onClick={fetchData} variant="secondary" size="sm">Refresh</Button></div>}
      {historyUnavailable && <p className="text-sm text-yellow-400">Price history unavailable.</p>}
      {/* Status Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className={isRunning ? 'text-green-400' : 'text-gray-400'}>
              {isRunning ? 'Engine Running' : 'Engine Stopped'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-blue-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-400">
              WebSocket {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          {isDryRun && (
            <span className="px-2 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-xs rounded-sm">
              Dry-Run Mode
            </span>
          )}
        </div>
        <div>
          <span className="text-gray-400">Current Price:</span>
          <span className="text-2xl font-bold ml-3">
            {formatPrice(market.lastPrice || 0)}
          </span>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-blue-400">{buyCount}</div>
          <div className="text-xs text-gray-400">Total Entries</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-green-400">{sellCount}</div>
          <div className="text-xs text-gray-400">TPs Filled</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-orange-400">{position.cyclesCompleted || 0}</div>
          <div className="text-xs text-gray-400">Cycles</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-white">${market.atr1m?.toFixed(2) || '-'}</div>
          <div className="text-xs text-gray-400">ATR (1m)</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className={`text-lg font-bold ${
            regime.mode === 'HARVEST' ? 'text-green-400' :
            regime.mode === 'CAUTION' ? 'text-yellow-400' :
            'text-red-400'
          }`}>
            {regime.mode || 'N/A'}
          </div>
          <div className="text-xs text-gray-400">Regime</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className={`text-lg font-bold ${pnlColorClass(position.realizedPnL || 0)}`}>
            {formatCurrency(position.realizedPnL || 0)}
          </div>
          <div className="text-xs text-gray-400">Realized P&L</div>
        </div>
      </div>

      {/* Main Charts */}
      {isRunning || priceHistory.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Price Chart */}
          <div className="lg:col-span-2">
            <RegimePriceChart
              priceData={priceHistory}
              regimeData={regimeHistory}
              currentPrice={market.lastPrice}
              anchorPrice={position.anchorPrice}
              atr={market.atr1m}
              kFactor={config?.kFactor || 0.6}
              height={320}
            />
          </div>

          {/* Volatility Chart */}
          <VolatilityChart
            atrData={atrHistory}
            regimeData={regimeHistory}
            height={240}
          />

          {/* Regime Timeline */}
          <div>
            <RegimeTimeline
              data={regimeHistory}
              currentRegime={regime}
              height={80}
            />

            {/* P&L Over Time */}
            {pnlData.length > 0 && (
              <div className="bg-gray-800 rounded-lg p-4 mt-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Cumulative P&L</h3>
                {!isDryRun && fillAggregates?.pnlPointsTruncated && <p className="text-xs text-gray-400 mb-2">Chart samples historical sells; cumulative total includes every sell.</p>}
                <CumulativePnlChart points={pnlData} />
                <div className="flex justify-between text-xs text-gray-400 mt-2">
                  <span>First Fill</span>
                  <span className={pnlColorClass(pnlData[pnlData.length - 1]?.cumulative)}>
                    Total: {formatCurrency(pnlData[pnlData.length - 1]?.cumulative || 0)}
                  </span>
                  <span>Latest</span>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
            <p className="text-lg">No chart data available</p>
            <p className="text-sm text-gray-400 mt-2">
              Start the regime engine from the Dashboard to begin collecting data.
            </p>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
        <h4 className="font-semibold text-gray-300 mb-2">Chart Legend</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-sm"></div>
            <span>HARVEST regime (full entries)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-yellow-500 rounded-sm"></div>
            <span>CAUTION regime (reduced entries)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded-sm"></div>
            <span>TREND regime (buys at Trend Scale; none at 0)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-blue-500 rounded-sm"></div>
            <span>ATR trigger band</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChartsRegime
