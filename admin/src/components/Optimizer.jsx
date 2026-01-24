import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

function Optimizer({ exchange = 'coinbase' }) {
  const [fundSize, setFundSize] = useState(10000)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [currentBest, setCurrentBest] = useState(null)
  const socketRef = useRef(null)

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
    fetch(`/api/${exchange}/optimizer/cache`)
      .then(res => res.json())
      .then(data => {
        if (data.cached) {
          setResults(data)
          setFundSize(data.fundSize || 10000)
        }
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false))
  }, [])

  const formatUSD = (n) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const formatPercent = (n) => `${(n || 0).toFixed(2)}%`

  const runOptimizer = async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    setProgress(null)
    setCurrentBest(null)
    if (forceRefresh) setResults(null)

    fetch(`/api/${exchange}/optimizer/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fundSize, forceRefresh })
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) throw new Error(data.error)
        // Only set results if not from websocket (cached results)
        if (data.cached) {
          setResults(data)
          setLoading(false)
        }
        // Non-cached results come via websocket
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }

  const clearCache = async () => {
    fetch(`/api/${exchange}/optimizer/cache`, { method: 'DELETE' })
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

    fetch(`/api/${exchange}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
      .then(res => res.json())
      .then(() => alert(`Settings applied to ${exchange}!`))
      .catch(err => alert('Failed to apply settings: ' + err.message))
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
        <h2 className="text-xl font-semibold mb-4">DCA Parameter Optimizer</h2>
        <p className="text-gray-400 text-sm mb-6">
          Find the best combination of interval, markup, and holdback settings by testing 192 parameter combinations across multiple time periods.
        </p>

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
            disabled={loading}
            className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded font-medium"
          >
            {loading ? 'Running...' : (results?.cached ? 'Load Cached' : 'Run Optimizer')}
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
                    <span className="ml-1 text-green-400 font-medium">{formatUSD(currentBest.metrics.totalValue)}</span>
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
                  {formatUSD(results.bestResult.metrics.totalValue)}
                </div>
                <div className="text-sm text-gray-500">
                  from {formatUSD(fundSize)} fund ({formatPercent(results.bestResult.metrics.roi)} ROI)
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
                <span className="ml-2 text-white font-medium">{formatUSD(results.bestResult.params.intervalBuyAmount)}</span>
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
                      <td className="py-2 pr-4">{formatUSD(result.intervalBuyAmount)}</td>
                      <td className="py-2 pr-4">{result.sellMarkupPercent}%</td>
                      <td className="py-2 pr-4">{result.holdbackPercent}%</td>
                      <td className="py-2 pr-4">{result.period}</td>
                      <td className="py-2 pr-4 font-medium text-green-400">{formatUSD(result.totalValue)}</td>
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
            <li>Tests 6 interval types: 5min, 10min, 30min, 1hour, 4hour, daily</li>
            <li>Each interval has a scaled buy amount (5min=$1, 10min=$2, 30min=$10, 1hour=$50, 4hour=$100, daily=$500)</li>
            <li>Tests markup percentages 1-8% with holdback always set to 50% of markup</li>
            <li>Runs backtests across 30D, 60D, 90D, and 1Y time periods</li>
            <li>Ranks all 192 combinations by Total Value to find the best configuration</li>
            <li>Uses your specified fund size to simulate realistic capital constraints</li>
          </ul>
        </div>
      )}
    </div>
  )
}

export default Optimizer
