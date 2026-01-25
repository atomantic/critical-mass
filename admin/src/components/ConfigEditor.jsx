import { useState, useEffect, useRef } from 'react'
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

        {/* Trading Settings - 3 column grid */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <FormInput label="Product ID" value={config.productId} onChange={(v) => handleChange('productId', v)} />
          <FormInput label={`Allocation (${quoteCurrency})`} value={config.totalAllocation} onChange={(v) => handleChange('totalAllocation', v)} type="number" />
          <FormSelect label="Interval" value={config.intervalType} onChange={(v) => handleChange('intervalType', v)} options={INTERVAL_OPTIONS} />
          <FormInput label="Intervals" value={config.intervalsToSpread} onChange={(v) => handleChange('intervalsToSpread', v)} type="number" />
          <FormInput label="Markup %" value={config.sellMarkupPercent} onChange={(v) => handleChange('sellMarkupPercent', v)} type="number" />
          <FormInput label="Holdback %" value={config.holdbackPercent} onChange={(v) => handleChange('holdbackPercent', v)} type="number" />
          <FormInput label={`Min Order (${quoteCurrency})`} value={config.minOrderSize} onChange={(v) => handleChange('minOrderSize', v)} type="number" />
          <FormInput label={`Max Price (${quoteCurrency})`} value={config.maxBuyPrice} onChange={(v) => handleChange('maxBuyPrice', v)} type="number" />
        </div>

        {/* Consolidation - inline row */}
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

        {/* Calculated Values - compact */}
        <div className="border-t border-gray-700 pt-3 mb-4">
          <div className="grid grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-gray-500">Buy per {intervalLabel}:</span>
              <span className="ml-1 text-white">${intervalAmount.toFixed(2)}</span>
            </div>
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
