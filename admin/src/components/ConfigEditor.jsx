import { useState, useEffect } from 'react'
import { getQuoteCurrency } from '../App'

function ConfigEditor({ config: initialConfig, onSave, exchange = 'coinbase' }) {
  const [config, setConfig] = useState(initialConfig || {})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig)
    }
  }, [initialConfig])

  const handleChange = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }))
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
      setMessage({ type: 'success', text: 'Configuration saved successfully!' })
      onSave?.()
    } else {
      const error = await res.json()
      setMessage({ type: 'error', text: error.error || 'Failed to save' })
    }
    setSaving(false)
  }

  const INTERVAL_OPTIONS = [
    { value: '10min', label: '10 Minutes' },
    { value: '1hour', label: '1 Hour' },
    { value: '4hour', label: '4 Hours' },
    { value: 'daily', label: 'Daily' }
  ]

  const quoteCurrency = getQuoteCurrency(config.productId)
  const productExample = exchange === 'gemini' ? 'BTCUSD' : 'BTC-USDC'

  const fields = [
    { key: 'productId', label: 'Product ID', type: 'text', help: `Trading pair (e.g., ${productExample})` },
    { key: 'totalAllocation', label: `Total Allocation (${quoteCurrency})`, type: 'number', help: `Maximum ${quoteCurrency} to allocate to this strategy` },
    { key: 'intervalType', label: 'Interval Type', type: 'select', options: INTERVAL_OPTIONS, help: 'How often to execute trades' },
    { key: 'intervalsToSpread', label: 'Intervals to Spread', type: 'number', help: 'Number of intervals to spread the allocation over' },
    { key: 'sellMarkupPercent', label: 'Sell Markup (%)', type: 'number', help: 'Percentage above buy price to set sell orders' },
    { key: 'holdbackPercent', label: 'Holdback (%)', type: 'number', help: 'Percentage of each buy to keep as BTC reserves' },
    { key: 'minOrderSize', label: `Minimum Order Size (${quoteCurrency})`, type: 'number', help: `Minimum ${quoteCurrency} amount per order` },
    { key: 'maxBuyPrice', label: `Maximum Buy Price (${quoteCurrency})`, type: 'number', help: `Skip buys when BTC price exceeds this` },
    { key: 'enabled', label: 'Enabled', type: 'toggle', help: 'Enable or disable the bot' },
  ]

  const intervalsToSpread = config.intervalsToSpread || config.daysToSpread || 1
  const intervalAmount = intervalsToSpread ? (config.totalAllocation / intervalsToSpread) : 0
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === config.intervalType)?.label || 'Daily'

  return (
    <div className="max-w-2xl">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-6">Bot Configuration</h2>

        {message && (
          <div className={`mb-4 p-3 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-900/50 border border-green-700 text-green-200'
              : 'bg-red-900/50 border border-red-700 text-red-200'
          }`}>
            {message.text}
          </div>
        )}

        <div className="space-y-4">
          {fields.map(field => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                {field.label}
              </label>
              {field.type === 'toggle' ? (
                <button
                  type="button"
                  onClick={() => handleChange(field.key, !config[field.key])}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    config[field.key] ? 'bg-blue-600' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      config[field.key] ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              ) : field.type === 'select' ? (
                <select
                  value={config[field.key] || field.options[field.options.length - 1].value}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                >
                  {field.options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type}
                  value={config[field.key] || ''}
                  onChange={(e) => handleChange(
                    field.key,
                    field.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value
                  )}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                />
              )}
              <p className="mt-1 text-xs text-gray-500">{field.help}</p>
            </div>
          ))}
        </div>

        {/* Calculated Values */}
        <div className="mt-6 pt-6 border-t border-gray-700">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Calculated Values</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Buy Amount per {intervalLabel}:</span>
              <span className="ml-2 text-white">${intervalAmount.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-gray-500">Expected Return per Cycle:</span>
              <span className="ml-2 text-white">
                +{((1 - config.holdbackPercent / 100) * (1 + config.sellMarkupPercent / 100) * 100 - 100).toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-gray-500">BTC Holdback per Cycle:</span>
              <span className="ml-2 text-white">{config.holdbackPercent}%</span>
            </div>
            <div>
              <span className="text-gray-500">Sell Price Multiplier:</span>
              <span className="ml-2 text-white">{(1 + config.sellMarkupPercent / 100).toFixed(2)}x</span>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>

      {/* Warning */}
      <div className="mt-4 p-4 bg-yellow-900/30 border border-yellow-700/50 rounded-lg text-yellow-200 text-sm">
        <strong>Note:</strong> Changes take effect on the next run. The bot will not make additional trades today if it has already run.
      </div>
    </div>
  )
}

export default ConfigEditor
