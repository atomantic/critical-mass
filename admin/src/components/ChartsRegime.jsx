import { useState, useEffect, useCallback } from 'react'
import { useRegimeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'
import { formatCurrency, formatPrice } from './charts/chartUtils'

function ChartsRegime({ exchange = 'coinbase' }) {
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [fills, setFills] = useState([])
  const [loading, setLoading] = useState(true)
  const [historicalPrices, setHistoricalPrices] = useState([])
  const [historicalAtr, setHistoricalAtr] = useState([])

  const { connected, status: socketStatus, regimeState, healthState } = useRegimeEvents(exchange)

  // Use socket status when available, fall back to local status
  const status = socketStatus || localStatus

  // Chart data buffering (for real-time updates) with cache support
  const { priceHistory: realtimePrices, atrHistory: realtimeAtr, regimeHistory, initializeFromCache } = useChartDataBuffer(status)

  // Combine historical + real-time data
  const priceHistory = historicalPrices.length > 0 ? [...historicalPrices, ...realtimePrices] : realtimePrices
  const atrHistory = historicalAtr.length > 0 ? [...historicalAtr, ...realtimeAtr] : realtimeAtr

  const fetchData = useCallback(async () => {
    const [statusRes, configRes, fillsRes, candlesRes, chartDataRes] = await Promise.all([
      fetch(`/api/${exchange}/regime/status`),
      fetch(`/api/${exchange}/regime/config`),
      fetch(`/api/${exchange}/regime/fills`),
      fetch(`/api/${exchange}/candles?granularity=ONE_MINUTE&limit=60`),
      fetch(`/api/${exchange}/regime/chart-data`),
    ])

    if (statusRes.ok) {
      const data = await statusRes.json()
      setLocalStatus(data.status)
    }
    if (configRes.ok) {
      const data = await configRes.json()
      setConfig(data.config)
    }
    if (fillsRes.ok) {
      const data = await fillsRes.json()
      setFills(data.fills || [])
    }
    if (candlesRes.ok) {
      const data = await candlesRes.json()
      if (data.candles && data.candles.length > 0) {
        // Convert candles to price history format (timestamp is already in ms)
        const prices = data.candles.map(c => ({
          date: new Date(c.timestamp),
          price: parseFloat(c.close),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
        })).reverse() // Oldest first
        setHistoricalPrices(prices)

        // Calculate ATR from candles (simplified: use high-low range)
        const atrData = data.candles.map(c => ({
          date: new Date(c.timestamp),
          atr: parseFloat(c.high) - parseFloat(c.low),
        })).reverse()
        setHistoricalAtr(atrData)
      }
    }
    // Initialize chart data buffer from server cache (restores data across page reloads)
    if (chartDataRes.ok) {
      const data = await chartDataRes.json()
      if (data.data) {
        initializeFromCache(data.data)
      }
    }
    setLoading(false)
  }, [exchange, initializeFromCache])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime charts...</div>
      </div>
    )
  }

  const isRunning = status?.isRunning
  const isDryRun = status?.isDryRun
  const market = status?.market || {}
  const position = status?.position || {}
  const regime = status?.regime || {}

  // Build fill markers for price chart
  const buyFills = fills
    .filter(f => f.side === 'buy')
    .map(f => ({
      date: new Date(f.timestamp),
      price: f.price,
      size: f.size,
    }))

  const sellFills = fills
    .filter(f => f.side === 'sell')
    .map(f => ({
      date: new Date(f.timestamp),
      price: f.price,
      size: f.size,
    }))

  // Calculate P&L distribution from fills
  const pnlData = (() => {
    const sortedFills = [...fills].sort((a, b) => a.timestamp - b.timestamp)
    let totalBtc = 0
    let totalCost = 0
    let cumulativePnL = 0
    const pnlPoints = []

    sortedFills.forEach(fill => {
      if (fill.side === 'buy') {
        totalBtc += fill.size
        totalCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || 0)
      } else {
        const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
        const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || 0)
        const costBasis = avgCost * fill.size
        const pnl = proceeds - costBasis
        cumulativePnL += pnl

        pnlPoints.push({
          date: new Date(fill.timestamp),
          pnl: pnl,
          cumulative: cumulativePnL,
        })

        // Update position
        const remaining = totalBtc - fill.size
        if (remaining > 0) {
          totalBtc = remaining
          totalCost = avgCost * remaining
        } else {
          totalBtc = 0
          totalCost = 0
        }
      }
    })

    return pnlPoints
  })()

  return (
    <div className="space-y-6">
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
            <span className="px-2 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-xs rounded">
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
          <div className="text-2xl font-bold text-blue-400">{fills.filter(f => f.side === 'buy').length}</div>
          <div className="text-xs text-gray-400">Total Entries</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-green-400">{fills.filter(f => f.side === 'sell').length}</div>
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
          <div className={`text-lg font-bold ${(position.realizedPnL || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
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
              buyMarkers={buyFills}
              sellMarkers={sellFills}
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
                <div className="h-32 flex items-end gap-1">
                  {pnlData.map((point, i) => {
                    const maxPnL = Math.max(...pnlData.map(p => Math.abs(p.cumulative))) || 1
                    const height = Math.abs(point.cumulative) / maxPnL * 100
                    const isPositive = point.cumulative >= 0

                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col justify-end items-center"
                        title={`${new Date(point.date).toLocaleString()}: ${formatCurrency(point.cumulative)}`}
                      >
                        <div
                          className={`w-full rounded-t ${isPositive ? 'bg-green-500' : 'bg-red-500'}`}
                          style={{ height: `${height}%` }}
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-gray-500 mt-2">
                  <span>First Fill</span>
                  <span className={pnlData[pnlData.length - 1]?.cumulative >= 0 ? 'text-green-400' : 'text-red-400'}>
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
            <p className="text-sm text-gray-500 mt-2">
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
            <div className="w-3 h-3 bg-green-500 rounded"></div>
            <span>HARVEST regime (full entries)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-yellow-500 rounded"></div>
            <span>CAUTION regime (reduced entries)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded"></div>
            <span>TREND regime (exits only)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-blue-500 rounded"></div>
            <span>ATR trigger band</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChartsRegime
