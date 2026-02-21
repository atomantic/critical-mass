import { useState, useEffect } from 'react'

export default function RiskConfig() {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    const fetchConfig = async () => {
      const res = await fetch('/api/kalshi/config')
      if (res.ok) setConfig(await res.json())
      setLoading(false)
    }
    fetchConfig()
  }, [])

  const updateRisk = (key, value) => {
    setConfig(c => c ? ({
      ...c,
      risk: { ...c.risk, [key]: value }
    }) : c)
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)

    const res = await fetch('/api/kalshi/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'Risk limits saved!' })
    } else {
      setMessage({ type: 'error', text: 'Failed to save risk limits' })
    }

    setSaving(false)
  }

  if (loading) {
    return <div className="text-gray-400">Loading risk configuration...</div>
  }

  if (!config) {
    return (
      <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
        Failed to load Kalshi configuration. Make sure Kalshi is enabled in config.json and the server is running.
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      {message && (
        <div className={`p-3 rounded-lg ${
          message.type === 'success'
            ? 'bg-green-900/50 border border-green-700 text-green-200'
            : 'bg-red-900/50 border border-red-700 text-red-200'
        }`}>
          {message.text}
        </div>
      )}

      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold">Position Limits</h3>

        <div>
          <label className="block font-medium mb-2">Max Contracts per Position</label>
          <input
            type="number"
            min="1"
            value={config.risk?.maxPositionContracts || 100}
            onChange={(e) => updateRisk('maxPositionContracts', parseInt(e.target.value) || 100)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Maximum contracts to hold in a single position</p>
        </div>

        <div>
          <label className="block font-medium mb-2">Max Open Positions</label>
          <input
            type="number"
            min="1"
            value={config.risk?.maxOpenPositions || 10}
            onChange={(e) => updateRisk('maxOpenPositions', parseInt(e.target.value) || 10)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Maximum number of simultaneous open positions</p>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold">Loss Limits</h3>

        <div>
          <label className="block font-medium mb-2">Max Daily Loss ($)</label>
          <input
            type="number"
            min="0"
            step="100"
            value={config.risk?.maxDailyLoss || 5000}
            onChange={(e) => updateRisk('maxDailyLoss', parseInt(e.target.value) || 5000)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Bot will stop trading after this daily loss</p>
        </div>

        <div>
          <label className="block font-medium mb-2">Stop Loss Percentage (%)</label>
          <input
            type="number"
            min="0"
            max="100"
            value={config.risk?.stopLossPercent || 50}
            onChange={(e) => updateRisk('stopLossPercent', parseInt(e.target.value) || 50)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Exit position if it loses this percentage</p>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold">Profit Taking</h3>

        <div>
          <label className="block font-medium mb-2">Take Profit Percentage (%)</label>
          <input
            type="number"
            min="0"
            max="100"
            value={config.risk?.takeProfitPercent || 25}
            onChange={(e) => updateRisk('takeProfitPercent', parseInt(e.target.value) || 25)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Exit position after this percentage gain</p>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 rounded-lg font-medium transition-colors"
      >
        {saving ? 'Saving...' : 'Save Risk Limits'}
      </button>
    </div>
  )
}
