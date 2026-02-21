import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Area, Bar } from 'recharts'
import { formatCurrency, formatPrice, formatPriceCompact } from './charts/chartUtils'

const INTERVAL_OPTIONS = [
  { value: '1min', label: '1 min' },
  { value: '5min', label: '5 min' },
  { value: '10min', label: '10 min' },
  { value: '30min', label: '30 min' },
  { value: '1hour', label: '1 hour' },
  { value: '4hour', label: '4 hours' },
  { value: 'daily', label: 'Daily' }
]

// Time periods adjusted per interval type
const getPeriodsForInterval = (intervalType) => {
  switch (intervalType) {
    case '1min':
      return [
        { label: '1H', intervals: 60 },       // 60 x 1min = 1 hour
        { label: '4H', intervals: 240 },      // 4 hours
        { label: '12H', intervals: 720 },     // 12 hours
        { label: '1D', intervals: 1440 },     // 1 day
        { label: '3D', intervals: 4320 },     // 3 days
        { label: '7D', intervals: 10080 },    // 7 days
      ]
    case '5min':
      return [
        { label: '1D', intervals: 288 },      // 288 x 5min = 1 day
        { label: '7D', intervals: 2016 },     // 7 days
        { label: '30D', intervals: 8640 },    // 30 days
        { label: '60D', intervals: 17280 },   // 60 days
        { label: '90D', intervals: 25920 },   // 90 days
        { label: '1Y', intervals: 105120 },   // 365 days
      ]
    case '10min':
      return [
        { label: '1D', intervals: 144 },     // 144 x 10min = 1 day
        { label: '7D', intervals: 1008 },    // 7 days
        { label: '30D', intervals: 4320 },   // 30 days
        { label: '60D', intervals: 8640 },   // 60 days
        { label: '90D', intervals: 12960 },  // 90 days
        { label: '1Y', intervals: 52560 },   // 365 days
      ]
    case '30min':
      return [
        { label: '1D', intervals: 48 },      // 48 x 30min = 1 day
        { label: '7D', intervals: 336 },     // 7 days
        { label: '30D', intervals: 1440 },   // 30 days
        { label: '60D', intervals: 2880 },   // 60 days
        { label: '90D', intervals: 4320 },   // 90 days
        { label: '1Y', intervals: 17520 },   // 365 days
      ]
    case '1hour':
      return [
        { label: '1D', intervals: 24 },
        { label: '7D', intervals: 168 },
        { label: '30D', intervals: 720 },
        { label: '60D', intervals: 1440 },
        { label: '90D', intervals: 2160 },
        { label: '1Y', intervals: 8760 },
      ]
    case '4hour':
      return [
        { label: '7D', intervals: 42 },
        { label: '30D', intervals: 180 },
        { label: '90D', intervals: 540 },
        { label: '1Y', intervals: 2190 },
      ]
    default: // daily
      return [
        { label: '1M', intervals: 30 },
        { label: '6M', intervals: 180 },
        { label: '1Y', intervals: 365 },
        { label: '2Y', intervals: 730 },
        { label: '4Y', intervals: 1460 },
      ]
  }
}

// Independent default values for backtest (not tied to system config)
const DEFAULT_PARAMS = {
  intervalBuyAmount: 10,
  sellMarkupPercent: 4,
  holdbackPercent: 2,
  feePercent: 0.125,
  rebatePercent: 0.031,
  intervals: 144,  // 1 day of 10-min intervals
  intervalType: '10min',
  fundSize: 10000,
  productId: null  // Will be loaded from config
}

// Extract base and quote currencies from productId
const parseProductId = (productId) => {
  if (!productId) return { baseCurrency: 'BTC', quoteCurrency: 'USD' }
  // Handle both BTC-USDC and BTC_USDT formats
  const parts = productId.replace('_', '-').split('-')
  return {
    baseCurrency: parts[0] || 'BTC',
    quoteCurrency: parts[1] || 'USD'
  }
}

function Backtest({ summary, exchange = 'coinbase', quoteCurrency: defaultQuoteCurrency = 'USDC' }) {
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [selectedPeriod, setSelectedPeriod] = useState('1D')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [configLoaded, setConfigLoaded] = useState(false)

  // Parse the productId for display
  const { baseCurrency, quoteCurrency } = params.productId
    ? parseProductId(params.productId)
    : parseProductId(summary?.config?.productId)

  // Auto-load config when exchange or summary changes
  useEffect(() => {
    if (summary?.config && !configLoaded) {
      loadFromConfig()
      setConfigLoaded(true)
    }
  }, [summary?.config])

  // Reset configLoaded when exchange changes
  useEffect(() => {
    setConfigLoaded(false)
    setResults(null)
  }, [exchange])

  // formatCurrency for balances/totals (fixed 2 decimals)
  // formatPrice for prices (smart decimals based on magnitude)
  const formatBase = (n) => (n || 0).toFixed(8)
  const formatPercent = (n) => `${(n || 0).toFixed(2)}%`

  const runBacktest = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/${exchange}/backtest/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setResults(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handlePeriodChange = (period) => {
    setSelectedPeriod(period.label)
    setParams(p => ({ ...p, intervals: period.intervals }))
  }

  const handleIntervalTypeChange = (intervalType) => {
    const periods = getPeriodsForInterval(intervalType)
    setParams(p => ({
      ...p,
      intervalType,
      intervals: periods[0].intervals
    }))
    setSelectedPeriod(periods[0].label)
  }

  const handleParamChange = (key, value) => {
    setParams(p => ({ ...p, [key]: parseFloat(value) || 0 }))
  }

  const loadFromConfig = () => {
    if (!summary?.config) return
    const config = summary.config
    const configIntervals = config.intervalsToSpread || config.daysToSpread || 60
    const intervalType = config.intervalType || 'daily'
    const periods = getPeriodsForInterval(intervalType)

    setParams({
      intervalBuyAmount: config.totalAllocation / configIntervals || 500,
      sellMarkupPercent: config.sellMarkupPercent || 10,
      holdbackPercent: config.holdbackPercent || 5,
      feePercent: 0.125,
      rebatePercent: 0.031,
      intervals: periods[periods.length > 2 ? 2 : periods.length - 1].intervals,
      intervalType,
      fundSize: config.totalAllocation || 0,
      productId: config.productId || null
    })
    setSelectedPeriod(periods[periods.length > 2 ? 2 : periods.length - 1].label)
  }

  const resetToDefaults = () => {
    setParams({
      ...DEFAULT_PARAMS,
      productId: summary?.config?.productId || null
    })
    setSelectedPeriod('1D')
  }

  // Prepare chart data (sample for performance)
  const getChartData = () => {
    if (!results?.intervalSnapshots) return []
    const snapshots = results.intervalSnapshots
    const sampleRate = Math.max(1, Math.floor(snapshots.length / 100))
    return snapshots.filter((_, i) => i % sampleRate === 0 || i === snapshots.length - 1)
  }

  const availablePeriods = getPeriodsForInterval(params.intervalType)

  return (
    <div className="space-y-6">
      {/* Configuration Panel */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Backtest Configuration</h3>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Interval</label>
            <select
              value={params.intervalType}
              onChange={(e) => handleIntervalTypeChange(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            >
              {INTERVAL_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Buy Amount ($)</label>
            <input
              type="number"
              value={params.intervalBuyAmount}
              onChange={(e) => handleParamChange('intervalBuyAmount', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Fund Size ($)</label>
            <input
              type="number"
              value={params.fundSize}
              onChange={(e) => handleParamChange('fundSize', e.target.value)}
              placeholder="0 = unlimited"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white placeholder:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Sell Markup (%)</label>
            <input
              type="number"
              step="0.1"
              value={params.sellMarkupPercent}
              onChange={(e) => handleParamChange('sellMarkupPercent', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Holdback (%)</label>
            <input
              type="number"
              step="0.1"
              value={params.holdbackPercent}
              onChange={(e) => handleParamChange('holdbackPercent', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Fee (%)</label>
            <input
              type="number"
              step="0.001"
              value={params.feePercent}
              onChange={(e) => handleParamChange('feePercent', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Rebate (%)</label>
            <input
              type="number"
              step="0.001"
              value={params.rebatePercent}
              onChange={(e) => handleParamChange('rebatePercent', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Net Fee</label>
            <div className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-gray-300">
              {formatPercent(params.feePercent - params.rebatePercent)}
            </div>
          </div>
        </div>

        {/* Time Period Selector */}
        <div className="flex flex-wrap gap-2 mb-4">
          {availablePeriods.map(period => (
            <button
              key={period.label}
              onClick={() => handlePeriodChange(period)}
              className={`px-4 py-2 rounded font-medium transition-colors ${
                selectedPeriod === period.label
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {period.label}
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={runBacktest}
            disabled={loading}
            className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded font-medium"
          >
            {loading ? 'Running Backtest...' : 'Run Backtest'}
          </button>
          <button
            onClick={loadFromConfig}
            disabled={!summary?.config}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded font-medium"
            title="Load settings from current system config"
          >
            Load from Config
          </button>
          <button
            onClick={resetToDefaults}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium"
            title="Reset to default backtest values"
          >
            Reset Defaults
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
          Error: {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <>
          {/* Summary Cards */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-4">
              {results.params.productId || baseCurrency + '/' + quoteCurrency}: {results.params.intervals} {results.params.intervalType} intervals ({results.metrics.startDate?.split('T')[0]} to {results.metrics.endDate?.split('T')[0]})
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-700/50 rounded p-3">
                <div className="text-sm text-gray-400">
                  {results.metrics.fundSize ? 'Initial Capital' : 'Total Invested'}
                </div>
                <div className="text-xl font-bold text-blue-400">{formatCurrency(results.metrics.roiBasis)}</div>
                {results.metrics.fundSize && (
                  <div className="text-xs text-gray-500 mt-1">
                    Recycled: {formatCurrency(results.metrics.totalInvested)}
                  </div>
                )}
              </div>
              <div className="bg-gray-700/50 rounded p-3">
                <div className="text-sm text-gray-400">Final Portfolio Value</div>
                <div className="text-xl font-bold text-green-400">{formatCurrency(results.metrics.totalValue)}</div>
              </div>
              <div className="bg-gray-700/50 rounded p-3">
                <div className="text-sm text-gray-400">ROI</div>
                <div className={`text-xl font-bold ${results.metrics.roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {results.metrics.roi >= 0 ? '+' : ''}{formatPercent(results.metrics.roi)}
                </div>
              </div>
              <div className="bg-gray-700/50 rounded p-3">
                <div className="text-sm text-gray-400">Profit/Loss</div>
                <div className={`text-xl font-bold ${results.metrics.totalValue - results.metrics.roiBasis >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {results.metrics.totalValue - results.metrics.roiBasis >= 0 ? '+' : ''}
                  {formatCurrency(results.metrics.totalValue - results.metrics.roiBasis)}
                </div>
              </div>
            </div>
          </div>

          {/* Detailed Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Holdings Breakdown */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h4 className="font-semibold mb-3">Final Holdings</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">
                    {results.metrics.fundSize ? `${quoteCurrency} (available funds)` : `${quoteCurrency} (from sells)`}
                  </span>
                  <span className="text-green-400">{formatCurrency(results.metrics.finalUSDC)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{baseCurrency} Reserves (holdback)</span>
                  <span className="text-yellow-400">{formatBase(results.metrics.assetReserves)} {baseCurrency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{baseCurrency} on Orders (pending)</span>
                  <span className="text-purple-400">{formatBase(results.metrics.btcOnOrders)} {baseCurrency}</span>
                </div>
                <div className="flex justify-between border-t border-gray-700 pt-2">
                  <span className="text-gray-400">Total {baseCurrency}</span>
                  <span className="text-white">{formatBase(results.metrics.totalAsset)} {baseCurrency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">{baseCurrency} Value @ {formatPrice(results.metrics.endPrice)}</span>
                  <span className="text-white">{formatCurrency(results.metrics.assetValue)}</span>
                </div>
              </div>
            </div>

            {/* Performance Stats */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h4 className="font-semibold mb-3">Performance Stats</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Sells Filled</span>
                  <span>{results.metrics.sellsFilled} / {results.metrics.totalSells}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fill Rate</span>
                  <span className={results.metrics.fillRate > 50 ? 'text-green-400' : 'text-yellow-400'}>
                    {formatPercent(results.metrics.fillRate)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Avg Intervals to Fill</span>
                  <span>{results.metrics.avgIntervalsToFill ? results.metrics.avgIntervalsToFill.toFixed(1) + ' intervals' : 'N/A'}</span>
                </div>
                {results.metrics.fundSize && (
                  <>
                    <div className="flex justify-between border-t border-gray-700 pt-2">
                      <span className="text-gray-400">Initial Fund</span>
                      <span className="text-blue-400">{formatCurrency(results.metrics.fundSize)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Final Available</span>
                      <span className="text-blue-300">{formatCurrency(results.metrics.finalAvailableFunds)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Intervals Skipped (no funds)</span>
                      <span className={results.metrics.intervalsSkipped > 0 ? 'text-yellow-400' : 'text-green-400'}>
                        {results.metrics.intervalsSkipped} / {results.params.intervals}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Intervals Bought</span>
                      <span className="text-green-400">{results.metrics.intervalsBought}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between border-t border-gray-700 pt-2">
                  <span className="text-gray-400">Total Fees</span>
                  <span className="text-red-400">{formatCurrency(results.metrics.totalFees)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Rebates</span>
                  <span className="text-green-400">{formatCurrency(results.metrics.totalRebates)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Net Fees</span>
                  <span className="text-orange-400">{formatCurrency(results.metrics.netFees)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Price Context */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h4 className="font-semibold mb-3">Price Context</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-400">Start Price:</span>
                <span className="ml-2">{formatPrice(results.metrics.startPrice)}</span>
              </div>
              <div>
                <span className="text-gray-400">End Price:</span>
                <span className="ml-2">{formatPrice(results.metrics.endPrice)}</span>
              </div>
              <div>
                <span className="text-gray-400">Price Change:</span>
                <span className={`ml-2 ${results.metrics.endPrice >= results.metrics.startPrice ? 'text-green-400' : 'text-red-400'}`}>
                  {((results.metrics.endPrice / results.metrics.startPrice - 1) * 100).toFixed(2)}%
                </span>
              </div>
              <div>
                <span className="text-gray-400">If HODL Only:</span>
                <span className="ml-2 text-gray-300">
                  {formatCurrency(results.metrics.roiBasis * (results.metrics.endPrice / results.metrics.startPrice))}
                </span>
              </div>
            </div>
          </div>

          {/* Portfolio Value Chart */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h4 className="font-semibold mb-4">Portfolio Composition Over Time</h4>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={getChartData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    stroke="#9CA3AF"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(d) => d.slice(5)}
                  />
                  <YAxis
                    yAxisId="usd"
                    stroke="#9CA3AF"
                    tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`}
                  />
                  <YAxis
                    yAxisId="btc"
                    orientation="right"
                    stroke="#F59E0B"
                    tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151' }}
                    formatter={(value, name) => {
                      if (name === 'basePrice') return [formatPrice(value), `${baseCurrency} Price`]
                      return [formatCurrency(value), name]
                    }}
                    labelFormatter={(label) => `Date: ${label}`}
                  />
                  <Legend />
                  <Area
                    yAxisId="usd"
                    type="monotone"
                    dataKey="usdcBalance"
                    name={quoteCurrency}
                    stackId="portfolio"
                    fill="#10B981"
                    fillOpacity={0.6}
                    stroke="#10B981"
                  />
                  <Area
                    yAxisId="usd"
                    type="monotone"
                    dataKey="assetValue"
                    name={`${baseCurrency} Value`}
                    stackId="portfolio"
                    fill="#F59E0B"
                    fillOpacity={0.6}
                    stroke="#F59E0B"
                  />
                  <Line
                    yAxisId="usd"
                    type="monotone"
                    dataKey="totalValue"
                    name="Total Value"
                    stroke="#FFFFFF"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="btc"
                    type="monotone"
                    dataKey="assetPrice"
                    name="basePrice"
                    stroke="#F59E0B"
                    strokeWidth={1}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Pending Orders Table */}
          {results.pendingOrders.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h4 className="font-semibold mb-3">Pending Sell Orders ({results.pendingOrders.length})</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-left border-b border-gray-700">
                      <th className="pb-2">Buy Date</th>
                      <th className="pb-2">Buy Price</th>
                      <th className="pb-2">Target Price</th>
                      <th className="pb-2">{baseCurrency} Amount</th>
                      <th className="pb-2">Current Value</th>
                      <th className="pb-2">Unrealized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.pendingOrders.slice(0, 20).map((order, i) => (
                      <tr key={i} className="border-t border-gray-700">
                        <td className="py-2">{order.buyDate}</td>
                        <td className="py-2">{formatPrice(order.buyPrice)}</td>
                        <td className="py-2">{formatPrice(order.sellTargetPrice)}</td>
                        <td className="py-2 font-mono">{formatBase(order.sellAsset)}</td>
                        <td className="py-2">{formatCurrency(order.currentValue)}</td>
                        <td className={`py-2 ${order.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {order.unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(order.unrealizedPnL)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {results.pendingOrders.length > 20 && (
                  <div className="text-center text-gray-500 text-sm mt-2">
                    Showing 20 of {results.pendingOrders.length} pending orders
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Instructions */}
      {!results && !loading && (
        <div className="bg-gray-800/50 rounded-lg p-4 text-gray-400">
          <h4 className="font-semibold text-gray-300 mb-2">
            Backtesting {params.productId || summary?.config?.productId || 'BTC-USD'}
          </h4>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Simulates buying a fixed {quoteCurrency} amount of {baseCurrency} every interval at the <strong>mid price</strong> (avg of high/low)</li>
            <li>Posts a sell order at +{params.sellMarkupPercent}% for {100 - params.holdbackPercent}% of each purchase</li>
            <li>Keeps {params.holdbackPercent}% of each purchase as {baseCurrency} reserves (never sold)</li>
            <li>Sell orders fill when the interval HIGH price reaches the target</li>
            <li>Fees ({params.feePercent}%) and rebates ({params.rebatePercent}%) applied to both buys and sells</li>
            <li><strong>Fund Size:</strong> Set to 0 for unlimited funds, or set a fixed amount - when depleted, buying pauses until sells fill</li>
            <li>Historical price data from {exchange} API (cached per trading pair)</li>
          </ul>
        </div>
      )}
    </div>
  )
}

export default Backtest
