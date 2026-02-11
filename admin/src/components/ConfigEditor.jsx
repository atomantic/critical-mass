import { useState, useEffect, useRef } from 'react'
import { getQuoteCurrency } from '../App'

// Input component defined OUTSIDE ConfigEditor to prevent re-creation on every render
function FormInput({ label, hint, value, onChange, type = 'text', className = '' }) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white focus:outline-none focus:border-blue-500"
      />
      {hint && <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

function FormSelect({ label, hint, value, onChange, options, className = '' }) {
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
      {hint && <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

// Reusable section card for the 2-column regime grid
function SectionCard({ title, children, className = '' }) {
  return (
    <div className={`bg-gray-900/40 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-medium text-purple-400 mb-3">{title}</h3>
      {children}
    </div>
  )
}

function ConfigEditor({ config: initialConfig, onSave, exchange = 'coinbase', strategy = 'dca' }) {
  const [config, setConfig] = useState(initialConfig || {})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [isDirty, setIsDirty] = useState(false)
  const prevExchangeRef = useRef(exchange)
  const prevStrategyRef = useRef(strategy)

  // Determine if showing regime config based on URL strategy prop
  const isRegime = strategy === 'regime'
  const isFibonacci = !isRegime && config.dcaStrategy === 'fibonacci'

  // Only sync with initialConfig when exchange or strategy changes (not on every refresh)
  useEffect(() => {
    if (initialConfig && (prevExchangeRef.current !== exchange || prevStrategyRef.current !== strategy || !isDirty)) {
      setConfig(initialConfig)
      setIsDirty(false)
      prevExchangeRef.current = exchange
      prevStrategyRef.current = strategy
    }
  }, [initialConfig, exchange, strategy, isDirty])

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

  const DCA_STRATEGY_OPTIONS = [
    { value: 'fixed', label: 'Fixed Amount DCA' },
    { value: 'fibonacci', label: 'Fibonacci DCA' },
  ]

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
    <div>
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Bot Configuration</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">Enabled</span>
              <button
                type="button"
                onClick={() => {
                  // Strategy-specific enabled toggle
                  if (isRegime) {
                    handleRegimeChange('enabled', !regimeConfig.enabled)
                  } else {
                    handleChange('enabled', !config.enabled)
                  }
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  (isRegime ? regimeConfig.enabled : config.enabled)
                    ? 'bg-green-500' : 'bg-gray-600'
                }`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  (isRegime ? regimeConfig.enabled : config.enabled)
                    ? 'translate-x-5' : 'translate-x-1'
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

        {/* Strategy Header */}
        <div className="border-b border-gray-700 pb-3 mb-4">
          {isRegime ? (
            <div className="bg-purple-900/30 border border-purple-700/50 rounded p-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-purple-400 font-medium">Regime-Aware Volatility Engine Configuration</span>
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
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-2">
                <FormSelect
                  label="DCA Strategy"
                  value={config.dcaStrategy || 'fixed'}
                  onChange={(v) => handleChange('dcaStrategy', v)}
                  options={DCA_STRATEGY_OPTIONS}
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
            </>
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
            {/* Holdback vs Markup validation warning */}
            {(() => {
              const holdback = config.holdbackPercent || 0;
              const markup = config.sellMarkupPercent || 1;
              const cashReturn = (1 - holdback / 100) * (1 + markup / 100) * 100 - 100;
              const maxHoldbackForCashBreakeven = (markup / (1 + markup / 100)).toFixed(2);

              if (holdback > markup && holdback > 0) {
                return (
                  <div className="mb-4 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-xs">
                    <div className="text-amber-400 font-medium mb-1">⚠️ Holdback exceeds Markup</div>
                    <div className="text-gray-300">
                      Each cycle returns{' '}
                      <span className="text-red-400 font-medium">{cashReturn.toFixed(2)}% cash</span>
                      {' '}but gains{' '}
                      <span className="text-green-400 font-medium">+{holdback}% BTC</span>.
                      <div className="mt-1 text-gray-400">
                        For cash-neutral cycles at {markup}% markup, set holdback ≤ {maxHoldbackForCashBreakeven}%.
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()}

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

        {/* Regime Engine Settings - 2-column card grid */}
        {isRegime && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Volatility Clock */}
            <SectionCard title="Volatility Clock">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Product ID" hint="Trading pair (e.g. BTC-USDC)" value={config.productId} onChange={(v) => handleChange('productId', v)} />
                <FormInput label="Base Size (USDC)" hint="Dollar amount per entry order" value={regimeConfig.baseSizeUsdc || 50} onChange={(v) => handleRegimeChange('baseSizeUsdc', v)} type="number" />
                <FormInput label="k Factor (ATR mult)" hint="Higher = longer waits between entries" value={regimeConfig.kFactor || 0.6} onChange={(v) => handleRegimeChange('kFactor', v)} type="number" />
                <FormInput label="ATR Period" hint="# of candles for ATR calculation" value={regimeConfig.atrPeriod || 14} onChange={(v) => handleRegimeChange('atrPeriod', v)} type="number" />
                <FormInput label="Min Interval (ms)" hint="Fastest allowed entry interval" value={regimeConfig.minIntervalMs || 60000} onChange={(v) => handleRegimeChange('minIntervalMs', v)} type="number" />
                <FormInput label="Max Interval (ms)" hint="Slowest entry interval (low-vol cap)" value={regimeConfig.maxIntervalMs || 3600000} onChange={(v) => handleRegimeChange('maxIntervalMs', v)} type="number" />
              </div>
            </SectionCard>

            {/* Regime Scaling */}
            <SectionCard title="Regime Scaling">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Harvest Scale" hint="Size multiplier in calm, mean-reverting markets" value={regimeConfig.harvestScale || 1.0} onChange={(v) => handleRegimeChange('harvestScale', v)} type="number" />
                <FormInput label="Caution Scale" hint="Size multiplier during elevated volatility" value={regimeConfig.cautionScale || 0.5} onChange={(v) => handleRegimeChange('cautionScale', v)} type="number" />
                <FormInput label="Trend Scale" hint="Size multiplier in strong trends (0 = no entries)" value={regimeConfig.trendScale || 0.0} onChange={(v) => handleRegimeChange('trendScale', v)} type="number" />
                <FormInput label="Max Cycle Buys" hint="Max buys per cycle before pausing entries" value={regimeConfig.maxCycleBuys || 10} onChange={(v) => handleRegimeChange('maxCycleBuys', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Scaling: HARVEST={regimeConfig.harvestScale || 1.0}x, CAUTION={regimeConfig.cautionScale || 0.5}x, TREND={regimeConfig.trendScale || 0.0}x base size
              </div>
            </SectionCard>

            {/* Entry Mode & Ladder - full width */}
            <SectionCard title="Entry Mode & Ladder" className="lg:col-span-2">
              <div className="grid grid-cols-4 gap-3 mb-3">
                <FormSelect
                  label="Entry Mode"
                  hint="Reactive: one order per trigger. Ladder: multiple orders spread across price levels"
                  value={regimeConfig.entryMode || 'reactive'}
                  onChange={(v) => handleRegimeChange('entryMode', v)}
                  options={[
                    { value: 'reactive', label: 'Reactive (single order)' },
                    { value: 'ladder', label: 'Ladder (pre-positioned)' }
                  ]}
                />
                <div className="pt-5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="ladderAutoSwitch"
                      checked={regimeConfig.ladderAutoSwitch || false}
                      onChange={(e) => handleRegimeChange('ladderAutoSwitch', e.target.checked)}
                      className="w-4 h-4 rounded bg-gray-700 border-gray-600"
                    />
                    <label htmlFor="ladderAutoSwitch" className="text-sm text-gray-300">Auto-Switch on Vol</label>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">Switch from reactive to ladder when vol spikes</div>
                </div>
                {regimeConfig.ladderAutoSwitch && (
                  <FormInput label="Auto-Switch Vol Mult" hint="realizedVol / volBaseline threshold to trigger switch (e.g. 1.5 = vol 50% above baseline)" value={regimeConfig.ladderAutoSwitchVolMult || 2.0} onChange={(v) => handleRegimeChange('ladderAutoSwitchVolMult', v)} type="number" />
                )}
              </div>
              {(regimeConfig.entryMode === 'ladder' || regimeConfig.ladderAutoSwitch) && (
                <>
                  <div className="bg-indigo-900/20 border border-indigo-700/30 rounded p-3 mb-3">
                    <div className="text-xs text-indigo-300">
                      <span className="font-medium">Ladder Mode:</span> Pre-positions multiple limit buy orders from current price down to a calculated lower bound.
                      Captures liquidity shocks and fat-tail events that single-order reactive mode misses.
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    <FormInput label="Ladder Levels" hint="Number of limit buy orders to place" value={regimeConfig.ladderLevels || 10} onChange={(v) => handleRegimeChange('ladderLevels', v)} type="number" />
                    <FormInput label="Lower Bound %" hint="How far below current price to span orders" value={regimeConfig.ladderLowerBoundPct || 15} onChange={(v) => handleRegimeChange('ladderLowerBoundPct', v)} type="number" />
                    <FormInput label="Min Spacing %" hint="Minimum gap between adjacent rungs" value={regimeConfig.ladderMinSpacingPct || 0.5} onChange={(v) => handleRegimeChange('ladderMinSpacingPct', v)} type="number" />
                    <div className="pt-5">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="ladderLowerBoundAthAdjust"
                          checked={regimeConfig.ladderLowerBoundAthAdjust !== false}
                          onChange={(e) => handleRegimeChange('ladderLowerBoundAthAdjust', e.target.checked)}
                          className="w-4 h-4 rounded bg-gray-700 border-gray-600"
                        />
                        <label htmlFor="ladderLowerBoundAthAdjust" className="text-sm text-gray-300">ATH Adjust</label>
                      </div>
                      <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">Widen lower bound when price is far below ATH</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-3 mt-3">
                    <FormSelect
                      label="Spacing Mode"
                      hint="How orders are distributed across the price range"
                      value={regimeConfig.ladderSpacingMode || 'sqrt'}
                      onChange={(v) => handleRegimeChange('ladderSpacingMode', v)}
                      options={[
                        { value: 'linear', label: 'Linear (even spacing)' },
                        { value: 'sqrt', label: 'Sqrt (denser near top)' },
                        { value: 'exponential', label: 'Exponential (denser at bottom)' }
                      ]}
                    />
                    <FormSelect
                      label="Size Mode"
                      hint="How order sizes scale across the ladder"
                      value={regimeConfig.ladderSizeMode || 'flat'}
                      onChange={(v) => handleRegimeChange('ladderSizeMode', v)}
                      options={[
                        { value: 'flat', label: 'Flat (equal sizes)' },
                        { value: 'linear', label: 'Linear (larger at bottom)' },
                        { value: 'sqrt', label: 'Sqrt (moderate scaling)' }
                      ]}
                    />
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {regimeConfig.ladderLevels || 10} orders spanning {regimeConfig.ladderLowerBoundPct || 15}% below current price.
                    {regimeConfig.ladderLowerBoundAthAdjust !== false && ' Lower bound widens based on ATH distance.'}
                    {regimeConfig.ladderAutoSwitch && ` Auto-switches to ladder when vol expands ${regimeConfig.ladderAutoSwitchVolMult || 2.0}x.`}
                  </div>
                </>
              )}
            </SectionCard>

            {/* Take-Profit */}
            <SectionCard title="Take-Profit">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="TP Multiplier" hint="ATR-based TP scaling factor" value={regimeConfig.tpMult || 1.0} onChange={(v) => handleRegimeChange('tpMult', v)} type="number" />
                <FormInput label="TP Min %" hint="Floor for take-profit percentage" value={regimeConfig.tpMinPercent || 2.0} onChange={(v) => handleRegimeChange('tpMinPercent', v)} type="number" />
                <FormInput label="TP Max %" hint="Ceiling for take-profit percentage" value={regimeConfig.tpMaxPercent || 15.0} onChange={(v) => handleRegimeChange('tpMaxPercent', v)} type="number" />
                <FormInput label="Holdback Ratio" hint="Fraction of position to keep as BTC (0-1)" value={regimeConfig.holdbackRatio ?? 0.5} onChange={(v) => handleRegimeChange('holdbackRatio', v)} type="number" />
              </div>
              {(() => {
                const holdbackRatio = regimeConfig.holdbackRatio ?? 0.5;
                const sellRatio = 1 - holdbackRatio;
                const tpMin = regimeConfig.tpMinPercent || 0.1;
                const usdcProfitPct = (sellRatio * tpMin).toFixed(2);
                const btcProfitPct = (holdbackRatio * tpMin).toFixed(2);

                return (
                  <div className="mt-2 text-xs text-gray-500">
                    Sell <span className="text-white font-medium">{(sellRatio * 100).toFixed(0)}%</span>, hold <span className="text-white font-medium">{(holdbackRatio * 100).toFixed(0)}%</span> of position.
                    {' '}At min TP ({tpMin}%): <span className="text-green-400">+{usdcProfitPct}% USDC</span>, <span className="text-blue-400">+{btcProfitPct}% BTC value</span>
                  </div>
                );
              })()}
            </SectionCard>

            {/* Regime Detection */}
            <SectionCard title="Regime Detection">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Momentum Mult" hint="VWAP divergence threshold for momentum detection" value={regimeConfig.momentumMult || 1.5} onChange={(v) => handleRegimeChange('momentumMult', v)} type="number" />
                <FormInput label="Vol Expansion" hint="realizedVol/baseline ratio to enter CAUTION" value={regimeConfig.volExpansionMult || 1.5} onChange={(v) => handleRegimeChange('volExpansionMult', v)} type="number" />
                <FormInput label="Vol Contraction" hint="realizedVol/baseline ratio to return to HARVEST" value={regimeConfig.volContractionMult || 1.2} onChange={(v) => handleRegimeChange('volContractionMult', v)} type="number" />
                <FormInput label="VWAP Hours" hint="Rolling window for VWAP calculation" value={regimeConfig.vwapPeriodHours || 4} onChange={(v) => handleRegimeChange('vwapPeriodHours', v)} type="number" />
                <FormInput label="Trend Confirm Periods" hint="Consecutive momentum periods to confirm TREND" value={regimeConfig.trendConfirmationPeriods || 5} onChange={(v) => handleRegimeChange('trendConfirmationPeriods', v)} type="number" />
              </div>
            </SectionCard>

            {/* Celestial Hierarchy - full width */}
            <SectionCard title="Celestial Hierarchy" className="lg:col-span-2">
              <div className="flex items-center gap-4 mb-3">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">Enable Celestial Bodies</span>
                  <button
                    type="button"
                    onClick={() => handleRegimeChange('celestialEnabled', !(regimeConfig.celestialEnabled !== false))}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      regimeConfig.celestialEnabled !== false ? 'bg-cyan-500' : 'bg-gray-600'
                    }`}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      regimeConfig.celestialEnabled !== false ? 'translate-x-5' : 'translate-x-1'
                    }`} />
                  </button>
                </label>
                {regimeConfig.celestialEnabled !== false && (
                  <span className="text-xs text-cyan-400">
                    Buys become celestial bodies that consolidate and promote through tiers
                  </span>
                )}
              </div>
              {regimeConfig.celestialEnabled !== false && (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <FormInput label="Max Celestial Bodies" hint="Max concurrent body TP orders (1-15)" value={regimeConfig.maxCelestialBodies ?? 10} onChange={(v) => handleRegimeChange('maxCelestialBodies', Math.round(v))} type="number" />
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    Each buy creates a celestial body (satellite). Bodies merge when TP prices are close, and promote to higher tiers as mass grows.
                    Tiers: 🛰️ satellite → 🌙 moon → 🪐 planet → ☀️ sun → 💫 hypergiant → 🕳️ black hole.
                    Higher tiers have wider TP targets and hold more BTC.
                  </div>
                  <div className="mt-2 grid grid-cols-6 gap-1 text-xs text-center">
                    {[
                      { emoji: '🛰️', name: 'Satellite', range: `$${regimeConfig.baseSizeUsdc || 25}-$${(regimeConfig.baseSizeUsdc || 25) * 3}` },
                      { emoji: '🌙', name: 'Moon', range: `$${(regimeConfig.baseSizeUsdc || 25) * 3}-$${(regimeConfig.baseSizeUsdc || 25) * 8}` },
                      { emoji: '🪐', name: 'Planet', range: `$${(regimeConfig.baseSizeUsdc || 25) * 8}-$${(regimeConfig.baseSizeUsdc || 25) * 20}` },
                      { emoji: '☀️', name: 'Sun', range: `$${(regimeConfig.baseSizeUsdc || 25) * 20}-$${(regimeConfig.baseSizeUsdc || 25) * 50}` },
                      { emoji: '💫', name: 'Hypergiant', range: `$${(regimeConfig.baseSizeUsdc || 25) * 50}-$${(regimeConfig.baseSizeUsdc || 25) * 120}` },
                      { emoji: '🕳️', name: 'Black Hole', range: `$${(regimeConfig.baseSizeUsdc || 25) * 120}+` },
                    ].map(tier => (
                      <div key={tier.name} className="bg-gray-800/50 rounded p-1">
                        <div>{tier.emoji}</div>
                        <div className="text-gray-400">{tier.name}</div>
                        <div className="text-gray-500">{tier.range}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </SectionCard>

            {/* Macro Regime - full width */}
            <SectionCard title="Macro Regime (Multi-Timeframe)" className="lg:col-span-2">
              <div className="flex items-center gap-4 mb-3">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">Enable Macro Regime</span>
                  <button
                    type="button"
                    onClick={() => handleRegimeChange('macroEnabled', !regimeConfig.macroEnabled)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      regimeConfig.macroEnabled ? 'bg-cyan-500' : 'bg-gray-600'
                    }`}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      regimeConfig.macroEnabled ? 'translate-x-5' : 'translate-x-1'
                    }`} />
                  </button>
                </label>
                {regimeConfig.macroEnabled && (
                  <span className="text-xs text-cyan-400">
                    Hourly + daily EMA overlay modulates sizing, TP, and entry offset
                  </span>
                )}
              </div>
              {regimeConfig.macroEnabled && (
                <>
                  <div className="grid grid-cols-5 gap-3 mb-4">
                    <FormInput label="Update Interval (ms)" hint="How often to re-score macro (60000-600000)" value={regimeConfig.macroUpdateIntervalMs ?? 300000} onChange={(v) => handleRegimeChange('macroUpdateIntervalMs', v)} type="number" />
                    <FormInput label="Hysteresis" hint="Score buffer to prevent mode chatter (1-20)" value={regimeConfig.macroHysteresis ?? 5} onChange={(v) => handleRegimeChange('macroHysteresis', v)} type="number" />
                    <FormInput label="Accumulation Threshold" hint="Score below this = ACCUMULATION" value={regimeConfig.macroAccumulationThreshold ?? -15} onChange={(v) => handleRegimeChange('macroAccumulationThreshold', v)} type="number" />
                    <FormInput label="Decline Threshold" hint="Score below this = DECLINE" value={regimeConfig.macroDeclineThreshold ?? -50} onChange={(v) => handleRegimeChange('macroDeclineThreshold', v)} type="number" />
                    <FormInput label="Markup Threshold" hint="Score above this = MARKUP" value={regimeConfig.macroMarkupThreshold ?? 35} onChange={(v) => handleRegimeChange('macroMarkupThreshold', v)} type="number" />
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                    <div className="bg-green-900/15 border border-green-800/30 rounded p-3">
                      <div className="text-xs text-green-400 font-medium mb-2">Accumulation (buying dips harder)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroAccumulationSizeMult ?? 1.3} onChange={(v) => handleRegimeChange('macroAccumulationSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Tighter" value={regimeConfig.macroAccumulationTpMult ?? 0.85} onChange={(v) => handleRegimeChange('macroAccumulationTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Tighter" value={regimeConfig.macroAccumulationOffsetMult ?? 0.8} onChange={(v) => handleRegimeChange('macroAccumulationOffsetMult', v)} type="number" />
                      </div>
                    </div>
                    <div className="bg-yellow-900/15 border border-yellow-800/30 rounded p-3">
                      <div className="text-xs text-yellow-400 font-medium mb-2">Markup (uptrend — reduce exposure)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroMarkupSizeMult ?? 0.7} onChange={(v) => handleRegimeChange('macroMarkupSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Wider" value={regimeConfig.macroMarkupTpMult ?? 1.3} onChange={(v) => handleRegimeChange('macroMarkupTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Wider" value={regimeConfig.macroMarkupOffsetMult ?? 1.2} onChange={(v) => handleRegimeChange('macroMarkupOffsetMult', v)} type="number" />
                      </div>
                    </div>
                    <div className="bg-red-900/15 border border-red-800/30 rounded p-3">
                      <div className="text-xs text-red-400 font-medium mb-2">Decline (capitulation — conservative)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <FormInput label="Size" hint="0.1-3.0" value={regimeConfig.macroDeclineSizeMult ?? 0.4} onChange={(v) => handleRegimeChange('macroDeclineSizeMult', v)} type="number" />
                        <FormInput label="TP" hint="Tighter" value={regimeConfig.macroDeclineTpMult ?? 0.7} onChange={(v) => handleRegimeChange('macroDeclineTpMult', v)} type="number" />
                        <FormInput label="Offset" hint="Wider" value={regimeConfig.macroDeclineOffsetMult ?? 1.5} onChange={(v) => handleRegimeChange('macroDeclineOffsetMult', v)} type="number" />
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    RANGING mode uses 1.0x for all multipliers (passthrough). Score range: -100 to +100. Thresholds must be ordered: decline &lt; accumulation &lt; markup.
                  </div>
                </>
              )}
            </SectionCard>

            {/* TP Auto-Management - full width */}
            <SectionCard title="TP Auto-Management" className="lg:col-span-2">
              <div className="flex items-center gap-4 mb-3">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">Enable Auto-Management</span>
                  <button
                    type="button"
                    onClick={() => handleRegimeChange('tpAutoManaged', !regimeConfig.tpAutoManaged)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      regimeConfig.tpAutoManaged ? 'bg-cyan-500' : 'bg-gray-600'
                    }`}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      regimeConfig.tpAutoManaged ? 'translate-x-5' : 'translate-x-1'
                    }`} />
                  </button>
                </label>
                {regimeConfig.tpAutoManaged && (
                  <span className="text-xs text-cyan-400">
                    TP values will be dynamically adjusted based on observed cycle data
                  </span>
                )}
              </div>
              {regimeConfig.tpAutoManaged && (
                <>
                  <div className="grid grid-cols-6 gap-3">
                    <FormInput label="Evaluation Cycles" hint="Re-evaluate TP after this many completed cycles" value={regimeConfig.tpEvaluationCycles || 5} onChange={(v) => handleRegimeChange('tpEvaluationCycles', v)} type="number" />
                    <FormInput label="Eval Max Hours" hint="Max hours before forcing TP re-evaluation" value={regimeConfig.tpEvaluationMaxHours || 24} onChange={(v) => handleRegimeChange('tpEvaluationMaxHours', v)} type="number" />
                    <FormInput label="Min Sample Size" hint="Min fills needed before first auto-adjust" value={regimeConfig.tpMinSampleSize || 10} onChange={(v) => handleRegimeChange('tpMinSampleSize', v)} type="number" />
                    <FormInput label="Max Change %" hint="Max single adjustment to TP values" value={regimeConfig.tpMaxChangePercent || 25} onChange={(v) => handleRegimeChange('tpMaxChangePercent', v)} type="number" />
                    <FormInput label="Absolute Min %" hint="Hard floor: TP can never go below this" value={regimeConfig.tpAbsoluteMin || 0.05} onChange={(v) => handleRegimeChange('tpAbsoluteMin', v)} type="number" />
                    <FormInput label="Absolute Max %" hint="Hard ceiling: TP can never go above this" value={regimeConfig.tpAbsoluteMax || 5.0} onChange={(v) => handleRegimeChange('tpAbsoluteMax', v)} type="number" />
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    Auto-adjusts TP range every {regimeConfig.tpEvaluationCycles || 5} cycles or {regimeConfig.tpEvaluationMaxHours || 24}h.
                    Requires {regimeConfig.tpMinSampleSize || 10} samples before first adjustment.
                    Holdback auto-set to half of TP Min.
                  </div>
                </>
              )}
            </SectionCard>

            {/* Risk Caps */}
            <SectionCard title="Risk Caps">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Deposited Capital" hint="Your actual cash deposits (0 = auto-derive)" value={regimeConfig.depositedCapital || 0} onChange={(v) => handleRegimeChange('depositedCapital', v)} type="number" />
                <FormInput label="Max BTC Exposure" hint="Max BTC the engine can hold at once" value={regimeConfig.maxBtcExposure || 0.5} onChange={(v) => handleRegimeChange('maxBtcExposure', v)} type="number" />
                <FormInput label="Max USDC Cap" hint="Max USDC deployed across active orders" value={regimeConfig.maxUsdcDeployed || 10000} onChange={(v) => handleRegimeChange('maxUsdcDeployed', v)} type="number" />
                <FormInput label="Max Drawdown %" hint="Pause entries when unrealized loss exceeds this" value={regimeConfig.maxDrawdownPercent || 20} onChange={(v) => handleRegimeChange('maxDrawdownPercent', v)} type="number" />
                <FormInput label="Liquidity Factor Cap" hint="Max size multiplier from orderbook liquidity" value={regimeConfig.liquidityFactorCap || 2.0} onChange={(v) => handleRegimeChange('liquidityFactorCap', v)} type="number" />
                <FormInput label="Drawdown Reset (hrs)" hint="Hours at drawdown cap before auto-resuming (0 = off)" value={regimeConfig.drawdownResetHours || 72} onChange={(v) => handleRegimeChange('drawdownResetHours', v)} type="number" />
                <FormInput label="Cycle Reset (hrs)" hint="Hours at cycle buys limit before auto-resetting (0 = off)" value={regimeConfig.cycleResetHours || 72} onChange={(v) => handleRegimeChange('cycleResetHours', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Auto-reset hours: 0 = disabled. After this time at a limit, the engine resumes with reset counters.
              </div>
            </SectionCard>

            {/* Order Execution */}
            <SectionCard title="Order Execution">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Entry Offset (bps)" hint="Place limit buy this many bps below market" value={regimeConfig.entryOffsetBps || 10} onChange={(v) => handleRegimeChange('entryOffsetBps', v)} type="number" />
                <FormInput label="Entry Max Retries" hint="Retry cancelled entries up to this many times" value={regimeConfig.entryMaxRetries || 3} onChange={(v) => handleRegimeChange('entryMaxRetries', v)} type="number" />
                <FormInput label="Order Stale (ms)" hint="Cancel unfilled entries after this duration" value={regimeConfig.orderStaleMs || 30000} onChange={(v) => handleRegimeChange('orderStaleMs', v)} type="number" />
                <FormInput label="Cancel Rate Limit (ms)" hint="Min wait between cancel API calls" value={regimeConfig.cancelRateLimitMs || 1000} onChange={(v) => handleRegimeChange('cancelRateLimitMs', v)} type="number" />
                <FormInput label="Max Open Orders" hint="Max simultaneous entry orders allowed" value={regimeConfig.maxOpenOrders || 3} onChange={(v) => handleRegimeChange('maxOpenOrders', v)} type="number" />
                <FormInput label="TP Update Threshold %" hint="Min price change before updating TP order" value={regimeConfig.tpUpdateThresholdPct || 0.5} onChange={(v) => handleRegimeChange('tpUpdateThresholdPct', v)} type="number" />
                <FormInput label="Reconcile Interval (ms)" hint="How often to sync local state with exchange" value={regimeConfig.reconcileIntervalMs || 300000} onChange={(v) => handleRegimeChange('reconcileIntervalMs', v)} type="number" />
              </div>
            </SectionCard>

            {/* Safety & Tail Events */}
            <SectionCard title="Safety & Tail Events">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Max Spread (bps)" hint="Pause entries when bid-ask spread exceeds this" value={regimeConfig.maxSpreadBps || 50} onChange={(v) => handleRegimeChange('maxSpreadBps', v)} type="number" />
                <FormInput label="Spread Pause (ms)" hint="How long to pause after spread breach" value={regimeConfig.spreadPauseMs || 300000} onChange={(v) => handleRegimeChange('spreadPauseMs', v)} type="number" />
                <FormInput label="Min Depth (USDC)" hint="Pause entries when orderbook depth is below this" value={regimeConfig.minDepthUsdc || 10000} onChange={(v) => handleRegimeChange('minDepthUsdc', v)} type="number" />
                <FormInput label="Depth Pause (ms)" hint="How long to pause after thin orderbook" value={regimeConfig.depthPauseMs || 300000} onChange={(v) => handleRegimeChange('depthPauseMs', v)} type="number" />
                <FormInput label="Flash Move Mult" hint="ATR multiplier to detect flash crashes" value={regimeConfig.flashMoveMult || 3.0} onChange={(v) => handleRegimeChange('flashMoveMult', v)} type="number" />
                <FormInput label="Flash Cooldown (ms)" hint="Pause duration after flash event detected" value={regimeConfig.flashCooldownMs || 600000} onChange={(v) => handleRegimeChange('flashCooldownMs', v)} type="number" />
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="cancelEntriesOnFlash"
                    checked={regimeConfig.cancelEntriesOnFlash !== false}
                    onChange={(e) => handleRegimeChange('cancelEntriesOnFlash', e.target.checked)}
                    className="w-4 h-4 rounded bg-gray-700 border-gray-600"
                  />
                  <label htmlFor="cancelEntriesOnFlash" className="text-sm text-gray-300">Cancel Entries on Flash</label>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">Pull all pending entries during flash events</div>
              </div>
            </SectionCard>

            {/* System Health */}
            <SectionCard title="System Health">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Stale Data (ms)" hint="Enter SAFE mode if no ticker data for this long" value={regimeConfig.staleDataMs || 30000} onChange={(v) => handleRegimeChange('staleDataMs', v)} type="number" />
                <FormInput label="Stale Orders (ms)" hint="Flag orders as stale after this duration" value={regimeConfig.staleOrdersMs || 60000} onChange={(v) => handleRegimeChange('staleOrdersMs', v)} type="number" />
                <FormInput label="Max Latency (ms)" hint="Enter SAFE mode if API latency exceeds this" value={regimeConfig.maxLatencyMs || 5000} onChange={(v) => handleRegimeChange('maxLatencyMs', v)} type="number" />
                <FormInput label="Safe Recovery (ms)" hint="Time healthy before exiting SAFE mode" value={regimeConfig.safeRecoveryMs || 60000} onChange={(v) => handleRegimeChange('safeRecoveryMs', v)} type="number" />
                <FormInput label="Max REST Errors" hint="Consecutive API errors before SAFE mode" value={regimeConfig.maxRestErrors || 5} onChange={(v) => handleRegimeChange('maxRestErrors', v)} type="number" />
                <FormInput label="Max Rate Limits" hint="Consecutive rate limits before SAFE mode" value={regimeConfig.maxRateLimits || 3} onChange={(v) => handleRegimeChange('maxRateLimits', v)} type="number" />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                System enters SAFE mode when health thresholds are exceeded. Safe Recovery is time healthy before exiting SAFE.
              </div>
            </SectionCard>
          </div>
        )}

        {/* Save Button */}
        <div className="flex gap-2 mt-4">
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
