import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { getQuoteCurrency } from '../App'

// Input component defined OUTSIDE ConfigEditor to prevent re-creation on every render
function FormInput({ label, value, onChange, type = 'text', className = '' }) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-blue-500"
      />
    </div>
  )
}

function FormSelect({ label, value, onChange, options, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <select
        value={value ?? options[0]?.value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-blue-500"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

function ConfigEditor({ config: initialConfig, onSave, exchange = 'coinbase' }) {
  const [config, setConfig] = useState(initialConfig || {})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [isDirty, setIsDirty] = useState(false)
  const prevExchangeRef = useRef(exchange)

  // Only sync with initialConfig when exchange changes (not on every refresh)
  useEffect(() => {
    if (initialConfig && (prevExchangeRef.current !== exchange || !isDirty)) {
      setConfig(initialConfig)
      setIsDirty(false)
      prevExchangeRef.current = exchange
    }
  }, [initialConfig, exchange, isDirty])

  const handleChange = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }))
    setIsDirty(true)
  }

  // Handler for nested regime config changes
  const handleRegimeChange = (key, value) => {
    setConfig(prev => ({
      ...prev,
      regime: { ...prev.regime, [key]: value }
    }))
    setIsDirty(true)
  }

  // Get regime config with defaults
  const regimeConfig = config.regime || {}

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    const res = await fetch(`/api/${exchange}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (res.ok) {
      setMessage({ type: 'success', text: 'Configuration saved!' })
      setIsDirty(false)
      onSave?.()
    } else {
      const error = await res.json()
      setMessage({ type: 'error', text: error.error || 'Failed to save' })
    }
    setSaving(false)
  }

  const handleReset = () => {
    if (initialConfig) {
      setConfig(initialConfig)
      setIsDirty(false)
      setMessage(null)
    }
  }

  const INTERVAL_OPTIONS = [
    { value: '1min', label: '1 Min' },
    { value: '5min', label: '5 Min' },
    { value: '10min', label: '10 Min' },
    { value: '1hour', label: '1 Hour' },
    { value: '4hour', label: '4 Hour' },
    { value: 'daily', label: 'Daily' }
  ]

  const CONSOLIDATE_INTERVAL_OPTIONS = [
    { value: 'never', label: 'Off' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
  ]

  const STRATEGY_OPTIONS = [
    { value: 'fixed', label: 'Fixed Amount DCA' },
    { value: 'fibonacci', label: 'Fibonacci DCA' },
    { value: 'regime', label: 'Regime Engine' },
  ]

  const isFibonacci = config.dcaStrategy === 'fibonacci'
  const isRegime = config.dcaStrategy === 'regime'

  // Generate Fibonacci preview sequence
  const getFibPreview = (baseAmount, count = 8) => {
    const fib = [1, 1]
    for (let i = 2; i < count; i++) fib.push(fib[i-1] + fib[i-2])
    return fib.map(n => `$${(n * baseAmount).toFixed(0)}`).join(' → ')
  }

  const quoteCurrency = getQuoteCurrency(config.productId)
  const intervalsToSpread = config.intervalsToSpread || config.daysToSpread || 1
  const intervalAmount = intervalsToSpread ? (config.totalAllocation / intervalsToSpread) : 0
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === config.intervalType)?.label || 'Daily'


  // Describe consolidation behavior
  const getConsolidationStatus = () => {
    const threshold = config.consolidateAfterOrders || 0
    const interval = config.consolidateInterval || 'never'
    const parts = []
    if (threshold > 0) parts.push(`when orders > ${threshold}`)
    if (interval !== 'never') parts.push(`${interval}`)
    if (parts.length === 0) return 'Manual only'
    return parts.join(' + ')
  }

  return (
    <div className="max-w-3xl">
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Bot Configuration</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">Enabled</span>
              <button
                type="button"
                onClick={() => handleChange('enabled', !config.enabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  config.enabled ? 'bg-green-500' : 'bg-gray-600'
                }`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  config.enabled ? 'translate-x-5' : 'translate-x-1'
                }`} />
              </button>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">Dry Run</span>
              <button
                type="button"
                onClick={() => handleChange('dryRun', !config.dryRun)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  config.dryRun ? 'bg-yellow-500' : 'bg-gray-600'
                }`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  config.dryRun ? 'translate-x-5' : 'translate-x-1'
                }`} />
              </button>
            </label>
          </div>
        </div>

        {message && (
          <div className={`mb-3 p-2 rounded text-sm ${
            message.type === 'success'
              ? 'bg-green-900/50 border border-green-700 text-green-200'
              : 'bg-red-900/50 border border-red-700 text-red-200'
          }`}>
            {message.text}
          </div>
        )}

        {/* DCA Strategy Selection */}
        <div className="border-b border-gray-700 pb-3 mb-4">
          <div className="flex items-center gap-4 mb-2">
            <FormSelect
              label="DCA Strategy"
              value={config.dcaStrategy || 'fixed'}
              onChange={(v) => handleChange('dcaStrategy', v)}
              options={STRATEGY_OPTIONS}
              className="w-48"
            />
            {isFibonacci && (
              <FormInput
                label="Fib Base Amount"
                value={config.fibBaseAmount || 10}
                onChange={(v) => handleChange('fibBaseAmount', v)}
                type="number"
                className="w-32"
              />
            )}
          </div>
          {isFibonacci && (
            <div className="bg-gray-900/50 rounded p-3 text-xs">
              <div className="text-gray-400 mb-1">
                <span className="text-yellow-400 font-medium">Fibonacci Sequence:</span>{' '}
                <span className="text-white font-mono">{getFibPreview(config.fibBaseAmount || 10)}</span>
              </div>
              <p className="text-gray-500 leading-relaxed">
                This strategy is a volatility-harvesting accumulation system that incrementally builds a BTC position using
                Fibonacci-sized buys on a fixed cadence during sideways conditions, continuously resetting a limit-sell order
                based on the updated weighted cost basis while retaining a small percentage as long-term inventory.
                It relies on short-term mean reversion within low-to-moderate volatility regimes to capture small, repeated
                price oscillations that exceed the effective fee floor (~0.045% per entry), making modest profit targets
                (sub-1%) more structurally aligned than large moves. There is no directional edge; the mechanism is position
                sizing plus inventory cycling, and during trending or volatility expansion regimes it transitions from a
                trading system into a BTC accumulation engine, concentrating capital over a short window (Fibonacci ramp)
                and potentially locking funds into drawdowns, which is acceptable under the assumption of long-term BTC
                conviction and no need for near-term capital liquidity.
              </p>
            </div>
          )}
          {isRegime && (
            <div className="bg-purple-900/30 border border-purple-700/50 rounded p-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-purple-400 font-medium">Regime-Aware Volatility Engine</span>
                <Link
                  to={`/${exchange}/regime`}
                  className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-white transition-colors"
                >
                  Open Dashboard →
                </Link>
              </div>
              <p className="text-gray-400 leading-relaxed mb-3">
                An advanced volatility-driven trading system that replaces fixed-interval DCA with ATR-based triggers.
                It adapts to three market regimes: <span className="text-green-400">HARVEST</span> (mean-reverting, full entries),
                <span className="text-yellow-400"> CAUTION</span> (elevated volatility, reduced sizing), and
                <span className="text-red-400"> TREND</span> (strong momentum, exit only). Uses real-time WebSocket data,
                dynamic take-profit based on recent volatility, and automatic safety modes.
              </p>
              <div className="grid grid-cols-3 gap-3 text-gray-400">
                <div>
                  <span className="text-gray-500">Entry Trigger:</span>
                  <span className="ml-1 text-white">k × ATR price move</span>
                </div>
                <div>
                  <span className="text-gray-500">Position Sizing:</span>
                  <span className="ml-1 text-white">Liquidity-aware ladder</span>
                </div>
                <div>
                  <span className="text-gray-500">Take-Profit:</span>
                  <span className="ml-1 text-white">Dynamic volatility-based</span>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-purple-700/30 text-gray-500">
                <strong className="text-gray-400">Note:</strong> Regime Engine runs independently from the timer-based DCA scheduler.
                Disable "Enabled" toggle above to prevent conflicts, then start the engine from the Regime Dashboard.
              </div>
            </div>
          )}
        </div>

        {/* Regular DCA Trading Settings - 3 column grid */}
        {!isRegime && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <FormInput label="Product ID" value={config.productId} onChange={(v) => handleChange('productId', v)} />
              {!isFibonacci && (
                <>
                  <FormInput label={`Allocation (${quoteCurrency})`} value={config.totalAllocation} onChange={(v) => handleChange('totalAllocation', v)} type="number" />
                  <FormInput label="Intervals" value={config.intervalsToSpread} onChange={(v) => handleChange('intervalsToSpread', v)} type="number" />
                </>
              )}
              <FormSelect label="Interval" value={config.intervalType} onChange={(v) => handleChange('intervalType', v)} options={INTERVAL_OPTIONS} />
              <FormInput label="Markup %" value={config.sellMarkupPercent} onChange={(v) => handleChange('sellMarkupPercent', v)} type="number" />
              <FormInput label="Holdback %" value={config.holdbackPercent} onChange={(v) => handleChange('holdbackPercent', v)} type="number" />
              <FormInput label={`Min Order (${quoteCurrency})`} value={config.minOrderSize} onChange={(v) => handleChange('minOrderSize', v)} type="number" />
              <FormInput label={`Max Price (${quoteCurrency})`} value={config.maxBuyPrice} onChange={(v) => handleChange('maxBuyPrice', v)} type="number" />
            </div>

            {/* Consolidation - inline row (hidden for Fibonacci which handles its own consolidation) */}
            {!isFibonacci && (
              <div className="border-t border-gray-700 pt-3 mb-4">
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-400 whitespace-nowrap">Auto-Consolidate:</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">When orders &gt;</span>
                    <input
                      type="number"
                      value={config.consolidateAfterOrders || 0}
                      onChange={(e) => handleChange('consolidateAfterOrders', parseInt(e.target.value) || 0)}
                      className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">or on schedule:</span>
                    <select
                      value={config.consolidateInterval || 'never'}
                      onChange={(e) => handleChange('consolidateInterval', e.target.value)}
                      className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                    >
                      {CONSOLIDATE_INTERVAL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <span className="text-xs text-gray-500 ml-auto">
                    Active: <span className="text-white">{getConsolidationStatus()}</span>
                  </span>
                </div>
              </div>
            )}

            {/* Calculated Values - compact */}
            <div className="border-t border-gray-700 pt-3 mb-4">
              <div className="grid grid-cols-4 gap-3 text-xs">
                {!isFibonacci && (
                  <div>
                    <span className="text-gray-500">Buy per {intervalLabel}:</span>
                    <span className="ml-1 text-white">${intervalAmount.toFixed(2)}</span>
                  </div>
                )}
                {isFibonacci && (
                  <div>
                    <span className="text-gray-500">Strategy:</span>
                    <span className="ml-1 text-yellow-400">Fibonacci</span>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Return/Cycle:</span>
                  <span className="ml-1 text-green-400">
                    +{((1 - config.holdbackPercent / 100) * (1 + config.sellMarkupPercent / 100) * 100 - 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Holdback:</span>
                  <span className="ml-1 text-white">{config.holdbackPercent}%</span>
                </div>
                <div>
                  <span className="text-gray-500">Sell Multiplier:</span>
                  <span className="ml-1 text-white">{(1 + config.sellMarkupPercent / 100).toFixed(2)}x</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Regime Engine Settings */}
        {isRegime && (
          <>
            <div className="mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Volatility Clock</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="Product ID" value={config.productId} onChange={(v) => handleChange('productId', v)} />
                <FormInput label="Base Size (USDC)" value={regimeConfig.baseSizeUsdc || 50} onChange={(v) => handleRegimeChange('baseSizeUsdc', v)} type="number" />
                <FormInput label="k Factor (ATR mult)" value={regimeConfig.kFactor || 0.6} onChange={(v) => handleRegimeChange('kFactor', v)} type="number" />
                <FormInput label="ATR Period" value={regimeConfig.atrPeriod || 14} onChange={(v) => handleRegimeChange('atrPeriod', v)} type="number" />
                <FormInput label="Min Interval (ms)" value={regimeConfig.minIntervalMs || 60000} onChange={(v) => handleRegimeChange('minIntervalMs', v)} type="number" />
                <FormInput label="Max Interval (ms)" value={regimeConfig.maxIntervalMs || 3600000} onChange={(v) => handleRegimeChange('maxIntervalMs', v)} type="number" />
              </div>
            </div>

            <div className="border-t border-gray-700 pt-3 mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Regime Scaling</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="Harvest Scale" value={regimeConfig.harvestScale || 1.0} onChange={(v) => handleRegimeChange('harvestScale', v)} type="number" />
                <FormInput label="Caution Scale" value={regimeConfig.cautionScale || 0.5} onChange={(v) => handleRegimeChange('cautionScale', v)} type="number" />
                <FormInput label="Trend Scale" value={regimeConfig.trendScale || 0.0} onChange={(v) => handleRegimeChange('trendScale', v)} type="number" />
                <FormInput label="Max Ladder Steps" value={regimeConfig.maxLadderSteps || 10} onChange={(v) => handleRegimeChange('maxLadderSteps', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Scaling: HARVEST={regimeConfig.harvestScale || 1.0}x, CAUTION={regimeConfig.cautionScale || 0.5}x, TREND={regimeConfig.trendScale || 0.0}x base size
              </div>
            </div>

            <div className="border-t border-gray-700 pt-3 mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Take-Profit</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="TP Multiplier" value={regimeConfig.tpMult || 1.0} onChange={(v) => handleRegimeChange('tpMult', v)} type="number" />
                <FormInput label="TP Min %" value={regimeConfig.tpMinPercent || 2.0} onChange={(v) => handleRegimeChange('tpMinPercent', v)} type="number" />
                <FormInput label="TP Max %" value={regimeConfig.tpMaxPercent || 15.0} onChange={(v) => handleRegimeChange('tpMaxPercent', v)} type="number" />
                <FormInput label="Holdback %" value={regimeConfig.holdbackPercent || 5} onChange={(v) => handleRegimeChange('holdbackPercent', v)} type="number" />
              </div>
            </div>

            <div className="border-t border-gray-700 pt-3 mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Risk Caps</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="Max BTC Exposure" value={regimeConfig.maxBtcExposure || 0.5} onChange={(v) => handleRegimeChange('maxBtcExposure', v)} type="number" />
                <FormInput label="Max USDC Deployed" value={regimeConfig.maxUsdcDeployed || 10000} onChange={(v) => handleRegimeChange('maxUsdcDeployed', v)} type="number" />
                <FormInput label="Max Drawdown %" value={regimeConfig.maxDrawdownPercent || 20} onChange={(v) => handleRegimeChange('maxDrawdownPercent', v)} type="number" />
                <FormInput label="Entry Offset (bps)" value={regimeConfig.entryOffsetBps || 10} onChange={(v) => handleRegimeChange('entryOffsetBps', v)} type="number" />
              </div>
            </div>

            <div className="border-t border-gray-700 pt-3 mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Regime Detection</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="Momentum Mult" value={regimeConfig.momentumMult || 1.5} onChange={(v) => handleRegimeChange('momentumMult', v)} type="number" />
                <FormInput label="Vol Expansion" value={regimeConfig.volExpansionMult || 1.5} onChange={(v) => handleRegimeChange('volExpansionMult', v)} type="number" />
                <FormInput label="Vol Contraction" value={regimeConfig.volContractionMult || 1.2} onChange={(v) => handleRegimeChange('volContractionMult', v)} type="number" />
                <FormInput label="VWAP Hours" value={regimeConfig.vwapPeriodHours || 4} onChange={(v) => handleRegimeChange('vwapPeriodHours', v)} type="number" />
              </div>
            </div>

            <div className="border-t border-gray-700 pt-3 mb-4">
              <h3 className="text-sm font-medium text-purple-400 mb-3">Safety & Tail Events</h3>
              <div className="grid grid-cols-4 gap-3">
                <FormInput label="Max Spread (bps)" value={regimeConfig.maxSpreadBps || 50} onChange={(v) => handleRegimeChange('maxSpreadBps', v)} type="number" />
                <FormInput label="Flash Move Mult" value={regimeConfig.flashMoveMult || 3.0} onChange={(v) => handleRegimeChange('flashMoveMult', v)} type="number" />
                <FormInput label="Stale Data (ms)" value={regimeConfig.staleDataMs || 30000} onChange={(v) => handleRegimeChange('staleDataMs', v)} type="number" />
                <FormInput label="Safe Recovery (ms)" value={regimeConfig.safeRecoveryMs || 60000} onChange={(v) => handleRegimeChange('safeRecoveryMs', v)} type="number" />
              </div>
            </div>
          </>
        )}

        {/* Save Button */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`flex-1 px-4 py-2 rounded font-medium transition-colors ${
              isDirty
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-blue-600/50 hover:bg-blue-600'
            } disabled:bg-blue-800 disabled:cursor-not-allowed`}
          >
            {saving ? 'Saving...' : isDirty ? 'Save Configuration *' : 'Save Configuration'}
          </button>
          {isDirty && (
            <button
              onClick={handleReset}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Warning - more compact */}
      <p className="mt-3 text-xs text-gray-500">
        Changes take effect on the next run. The bot will not make additional trades this interval if it has already run.
      </p>
    </div>
  )
}

export default ConfigEditor
