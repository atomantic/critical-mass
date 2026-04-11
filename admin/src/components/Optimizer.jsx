import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { formatCurrency } from './charts/chartUtils'
import { useToast } from './Toast'
import { pairQuery as buildPairQuery } from '../utils/api'

// Available options for optimizer
const ALL_INTERVALS = ['5min', '10min', '30min', '1hour', '4hour', 'daily']
const ALL_MARKUPS = [1, 2, 3, 4, 5, 6, 7, 8, 10]
const ALL_PERIODS = ['30D', '60D', '90D', '1Y']

// Default buy amounts per interval (can be customized)
const DEFAULT_BUY_AMOUNTS = {
  '5min': 1,
  '10min': 2,
  '30min': 10,
  '1hour': 50,
  '4hour': 100,
  'daily': 500
}

function ToggleChip({ label, checked, onChange, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${checked
        ? 'bg-blue-600 text-white'
        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
      }`}
    >
      {label}
    </button>
  )
}

function Optimizer({ exchange = 'coinbase', pair }) {
  const [fundSize, setFundSize] = useState(10000)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [currentBest, setCurrentBest] = useState(null)
  const [showConfig, setShowConfig] = useState(false)
  const socketRef = useRef(null)

  // Configurable parameters
  const [selectedIntervals, setSelectedIntervals] = useState(['10min', '1hour', 'daily'])
  const [selectedMarkups, setSelectedMarkups] = useState([2, 4, 6, 8])
  const [selectedPeriods, setSelectedPeriods] = useState(['30D', '90D', '1Y'])
  const [buyAmounts, setBuyAmounts] = useState({ ...DEFAULT_BUY_AMOUNTS })

  const { addToast } = useToast()
  const pairQuery = buildPairQuery(pair)

  // Connect to WebSocket
  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    socket.on('optimizer:progress', (data) => {
      setProgress(data)
    })

    socket.on('optimizer:newBest', (data) => {
      setCurrentBest(data)
    })

    socket.on('optimizer:complete', (data) => {
      setResults(data)
      setLoading(false)
      setProgress(null)
      setCurrentBest(null)
    })

    socket.on('optimizer:error', (data) => {
      setError(data.error)
      setLoading(false)
      setProgress(null)
    })

    return () => socket.disconnect()
  }, [])

  // Load cached results on mount
  useEffect(() => {
    fetch(`/api/${exchange}/optimizer/cache${pairQuery}`)
      .then(res => res.json())
      .then(data => {
        if (data.cached) {
          setResults(data)
          setFundSize(data.fundSize || 10000)
          // Restore config from cache if available
          if (data.config) {
            if (data.config.intervals) setSelectedIntervals(data.config.intervals)
            if (data.config.markups) setSelectedMarkups(data.config.markups)
            if (data.config.periods) setSelectedPeriods(data.config.periods)
            if (data.config.buyAmounts) setBuyAmounts(data.config.buyAmounts)
          }
        }
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false))
  }, [])

  const formatPercent = (n) => `${(n || 0).toFixed(2)}%`

  const toggleInterval = (interval) => {
    setSelectedIntervals(prev =>
      prev.includes(interval)
        ? prev.filter(i => i !== interval)
        : [...prev, interval]
    )
  }

  const toggleMarkup = (markup) => {
    setSelectedMarkups(prev =>
      prev.includes(markup)
        ? prev.filter(m => m !== markup)
        : [...prev, markup]
    )
  }

  const togglePeriod = (period) => {
    setSelectedPeriods(prev =>
      prev.includes(period)
        ? prev.filter(p => p !== period)
        : [...prev, period]
    )
  }

  const selectAllIntervals = () => setSelectedIntervals([...ALL_INTERVALS])
  const selectAllMarkups = () => setSelectedMarkups([...ALL_MARKUPS])
  const selectAllPeriods = () => setSelectedPeriods([...ALL_PERIODS])

  const totalCombinations = selectedIntervals.length * selectedMarkups.length * selectedPeriods.length

  const runOptimizer = async (forceRefresh = false) => {
    if (selectedIntervals.length === 0 || selectedMarkups.length === 0 || selectedPeriods.length === 0) {
      setError('Please select at least one option for each parameter category')
      return
    }

    setLoading(true)
    setError(null)
    setProgress(null)
    setCurrentBest(null)
    if (forceRefresh) setResults(null)

    fetch(`/api/${exchange}/optimizer/run${pairQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fundSize,
        forceRefresh,
        intervals: selectedIntervals,
        markups: selectedMarkups,
        periods: selectedPeriods,
        buyAmounts
      })
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) throw new Error(data.error || 'Unknown error')
        // Cached results come via HTTP response
        if (data.cached) {
          setResults(data)
          setLoading(false)
        }
        // Non-cached results stream via WebSocket (data.streaming = true)
        // Keep loading state, results will come via optimizer:complete event
      })
      .catch(err => {
        console.error('Optimizer fetch error:', err)
        setError(err.message || 'Failed to start optimizer')
        setLoading(false)
      })
  }

  const clearCache = async () => {
    fetch(`/api/${exchange}/optimizer/cache${pairQuery}`, { method: 'DELETE' })
      .then(res => res.json())
      .then(() => setResults(null))
      .catch(err => setError(err.message))
  }

  const applySettings = async (result) => {
    const config = {
      intervalType: result.intervalType,
      intervalsToSpread: result.intervals,
      totalAllocation: fundSize,
      sellMarkupPercent: result.sellMarkupPercent,
      holdbackPercent: result.holdbackPercent
    }

    fetch(`/api/${exchange}/config${pairQuery}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
      .then(res => res.json())
      .then((data) => {
        if (data.success) {
          addToast({
            type: 'success',
            title: 'Settings Applied',
            message: `Configuration updated for ${exchange}`
          })
        } else {
          addToast({
            type: 'error',
            title: 'Apply Failed',
            message: data.error || 'Unknown error'
          })
        }
      })
      .catch(err => addToast({
        type: 'error',
        title: 'Apply Failed',
        message: err.message
      }))
  }

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Configuration Panel */}
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">DCA Parameter Optimizer</h2>
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            {showConfig ? 'Hide Configuration' : 'Show Configuration'}
          </button>
        </div>

        <p className="text-gray-400 text-sm mb-4">
          Test {totalCombinations} parameter combinations
          ({selectedIntervals.length} intervals x {selectedMarkups.length} markups x {selectedPeriods.length} periods)
        </p>

        {/* Expandable Configuration Section */}
        {showConfig && (
          <div className="space-y-4 mb-6 p-4 bg-gray-700/50 rounded-lg">
            {/* Intervals */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Intervals to Test</label>
                <button
                  onClick={selectAllIntervals}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Select All
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_INTERVALS.map(interval => (
                  <ToggleChip
                    key={interval}
                    label={interval}
                    checked={selectedIntervals.includes(interval)}
                    onChange={() => toggleInterval(interval)}
                    disabled={loading}
                  />
                ))}
              </div>
            </div>

            {/* Markups */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Markup Percentages</label>
                <button
                  onClick={selectAllMarkups}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Select All
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_MARKUPS.map(markup => (
                  <ToggleChip
                    key={markup}
                    label={`${markup}%`}
                    checked={selectedMarkups.includes(markup)}
                    onChange={() => toggleMarkup(markup)}
                    disabled={loading}
                  />
                ))}
              </div>
            </div>

            {/* Periods */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Time Periods</label>
                <button
                  onClick={selectAllPeriods}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Select All
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_PERIODS.map(period => (
                  <ToggleChip
                    key={period}
                    label={period}
                    checked={selectedPeriods.includes(period)}
                    onChange={() => togglePeriod(period)}
                    disabled={loading}
                  />
                ))}
              </div>
            </div>

            {/* Buy Amounts per Interval */}
            <div>
              <label className="text-sm text-gray-400 block mb-2">Buy Amount per Interval ($)</label>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                {selectedIntervals.map(interval => (
                  <div key={interval}>
                    <label className="text-xs text-gray-500 block">{interval}</label>
                    <input
                      type="number"
                      value={buyAmounts[interval] || DEFAULT_BUY_AMOUNTS[interval]}
                      onChange={(e) => setBuyAmounts(prev => ({
                        ...prev,
                        [interval]: parseFloat(e.target.value) || 1
                      }))}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm"
                      min="1"
                      disabled={loading}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Fund Size ($)</label>
            <input
              type="number"
              value={fundSize}
              onChange={(e) => setFundSize(parseFloat(e.target.value) || 0)}
              className="w-48 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
              min="100"
              step="1000"
            />
          </div>
          <button
            onClick={() => runOptimizer(false)}
            disabled={loading || totalCombinations === 0}
            className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed rounded font-medium"
          >
            {loading ? 'Running...' : (results?.cached ? 'Load Cached' : `Run ${totalCombinations} Tests`)}
          </button>
          {results && (
            <>
              <button
                onClick={() => runOptimizer(true)}
                disabled={loading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded font-medium"
              >
                {loading ? 'Running...' : 'Force Refresh'}
              </button>
              <button
                onClick={clearCache}
                disabled={loading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded font-medium"
              >
                Clear Cache
              </button>
            </>
          )}
        </div>

        {results?.cached && results?.cachedAt && (
          <div className="mt-4 text-sm text-gray-400">
            Using cached results from {new Date(results.cachedAt).toLocaleString()}
            {results.fundSize !== fundSize && (
              <span className="ml-2 text-yellow-400">
                (cached for ${results.fundSize.toLocaleString()} fund - click Run to use new fund size)
              </span>
            )}
          </div>
        )}

        {loading && progress && (
          <div className="mt-4 space-y-4">
            {/* Progress bar */}
            <div>
              <div className="flex justify-between text-sm text-gray-400 mb-1">
                <span>{progress.message}</span>
                <span>{progress.current}/{progress.total} ({progress.percentComplete}%)</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.percentComplete}%` }}
                />
              </div>
            </div>

            {/* Current test info */}
            {progress.currentTest && (
              <div className="bg-gray-700/50 rounded p-3">
                <div className="text-xs text-gray-400 mb-1">Currently Testing:</div>
                <div className="text-sm">
                  <span className="text-white font-medium">{progress.currentTest.intervalType}</span>
                  <span className="text-gray-400 mx-2">|</span>
                  <span className="text-white">{progress.currentTest.sellMarkupPercent}% markup</span>
                  <span className="text-gray-400 mx-2">|</span>
                  <span className="text-white">{progress.currentTest.holdbackPercent}% holdback</span>
                  <span className="text-gray-400 mx-2">|</span>
                  <span className="text-white">{progress.currentTest.period}</span>
                </div>
              </div>
            )}

            {/* Current best result */}
            {currentBest && (
              <div className="bg-green-900/30 border border-green-700 rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-green-400">★</span>
                  <span className="text-xs text-green-400">Current Best:</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
                  <div>
                    <span className="text-gray-400">Interval:</span>
                    <span className="ml-1 text-white">{currentBest.params.intervalType}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Markup:</span>
                    <span className="ml-1 text-white">{currentBest.params.sellMarkupPercent}%</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Period:</span>
                    <span className="ml-1 text-white">{currentBest.params.period}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Value:</span>
                    <span className="ml-1 text-green-400 font-medium">{formatCurrency(currentBest.metrics.totalValue)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">ROI:</span>
                    <span className={`ml-1 ${currentBest.metrics.roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {currentBest.metrics.roi >= 0 ? '+' : ''}{formatPercent(currentBest.metrics.roi)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {loading && !progress && (
          <div className="mt-4">
            <div className="text-sm text-gray-400 mb-2">
              Starting optimizer...
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div className="bg-green-500 h-2 rounded-full animate-pulse" style={{ width: '5%' }} />
            </div>
          </div>
        )}
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
          {/* Summary */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Optimization Complete</h3>
                <p className="text-sm text-gray-400">
                  Tested {results.totalCombinations} combinations in {(results.duration / 1000).toFixed(1)}s
                </p>
              </div>
              <div className="text-right">
                <div className="text-sm text-gray-400">Best Total Value</div>
                <div className="text-2xl font-bold text-green-400">
                  {formatCurrency(results.bestResult.metrics.totalValue)}
                </div>
                <div className="text-sm text-gray-500">
                  from {formatCurrency(fundSize)} fund ({formatPercent(results.bestResult.metrics.roi)} ROI)
                </div>
              </div>
            </div>
          </div>

          {/* Best Result Highlight */}
          <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-green-400 text-xl">★</span>
              <h3 className="text-lg font-semibold text-green-400">Best Configuration</h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
              <div>
                <span className="text-gray-400">Interval:</span>
                <span className="ml-2 text-white font-medium">{results.bestResult.params.intervalType}</span>
              </div>
              <div>
                <span className="text-gray-400">Buy Amount:</span>
                <span className="ml-2 text-white font-medium">{formatCurrency(results.bestResult.params.intervalBuyAmount)}</span>
              </div>
              <div>
                <span className="text-gray-400">Markup:</span>
                <span className="ml-2 text-white font-medium">{results.bestResult.params.sellMarkupPercent}%</span>
              </div>
              <div>
                <span className="text-gray-400">Holdback:</span>
                <span className="ml-2 text-white font-medium">{results.bestResult.params.holdbackPercent}%</span>
              </div>
              <div>
                <span className="text-gray-400">Period:</span>
                <span className="ml-2 text-white font-medium">{results.bestResult.params.period}</span>
              </div>
              <div>
                <span className="text-gray-400">Fill Rate:</span>
                <span className="ml-2 text-white font-medium">{formatPercent(results.bestResult.metrics.fillRate)}</span>
              </div>
            </div>
            <button
              onClick={() => applySettings(results.bestResult.params)}
              className="mt-4 px-4 py-2 bg-green-600 hover:bg-green-700 rounded font-medium text-sm"
            >
              Apply Best Settings to Config
            </button>
          </div>

          {/* Top Results Table */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-4">Top 20 Configurations (by Total Value)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700">
                    <th className="pb-2 pr-4">#</th>
                    <th className="pb-2 pr-4">Interval</th>
                    <th className="pb-2 pr-4">Buy Amt</th>
                    <th className="pb-2 pr-4">Markup</th>
                    <th className="pb-2 pr-4">Holdback</th>
                    <th className="pb-2 pr-4">Period</th>
                    <th className="pb-2 pr-4">Total Value</th>
                    <th className="pb-2 pr-4">ROI</th>
                    <th className="pb-2 pr-4">Fill Rate</th>
                    <th className="pb-2 pr-4">Avg Fill</th>
                    <th className="pb-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {results.topResults.map((result, i) => (
                    <tr key={i} className={`border-t border-gray-700 ${i === 0 ? 'bg-green-900/20' : ''}`}>
                      <td className="py-2 pr-4">
                        {i === 0 ? <span className="text-green-400">★</span> : i + 1}
                      </td>
                      <td className="py-2 pr-4">{result.intervalType}</td>
                      <td className="py-2 pr-4">{formatCurrency(result.intervalBuyAmount)}</td>
                      <td className="py-2 pr-4">{result.sellMarkupPercent}%</td>
                      <td className="py-2 pr-4">{result.holdbackPercent}%</td>
                      <td className="py-2 pr-4">{result.period}</td>
                      <td className="py-2 pr-4 font-medium text-green-400">{formatCurrency(result.totalValue)}</td>
                      <td className={`py-2 pr-4 ${result.roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {result.roi >= 0 ? '+' : ''}{formatPercent(result.roi)}
                      </td>
                      <td className="py-2 pr-4">{formatPercent(result.fillRate)}</td>
                      <td className="py-2 pr-4">
                        {result.avgIntervalsToFill ? `${result.avgIntervalsToFill.toFixed(1)}` : 'N/A'}
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => applySettings(result)}
                          className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"
                        >
                          Apply
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Parameter Space Info */}
          <div className="bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
            <h4 className="font-semibold text-gray-300 mb-2">Parameters Tested</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <span className="text-gray-500">Intervals:</span>
                <span className="ml-2">{results.config.intervals.join(', ')}</span>
              </div>
              <div>
                <span className="text-gray-500">Markups:</span>
                <span className="ml-2">{results.config.markups.join(', ')}%</span>
              </div>
              <div>
                <span className="text-gray-500">Periods:</span>
                <span className="ml-2">{results.config.periods.join(', ')}</span>
              </div>
              <div>
                <span className="text-gray-500">Net Fee:</span>
                <span className="ml-2">{(results.config.feePercent - results.config.rebatePercent).toFixed(3)}%</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Instructions */}
      {!results && !loading && (
        <div className="bg-gray-800/50 rounded-lg p-4 text-gray-400">
          <h4 className="font-semibold text-gray-300 mb-2">How the Optimizer Works</h4>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Click "Show Configuration" to customize which parameters to test</li>
            <li>Select intervals, markup percentages, and time periods to include</li>
            <li>Adjust buy amounts per interval (default scales with interval length)</li>
            <li>Holdback is always 50% of markup (e.g., 4% markup = 2% holdback)</li>
            <li>Runs backtests for each combination and ranks by Total Value</li>
            <li>Uses your specified fund size to simulate realistic capital constraints</li>
          </ul>
        </div>
      )}
    </div>
  )
}

export default Optimizer
