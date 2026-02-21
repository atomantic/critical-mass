import { useState, useEffect } from 'react'

export default function GeneralConfig() {
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

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)

    const res = await fetch('/api/kalshi/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'Configuration saved!' })
    } else {
      setMessage({ type: 'error', text: 'Failed to save configuration' })
    }

    setSaving(false)
  }

  if (loading) {
    return <div className="text-gray-400">Loading configuration...</div>
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
        <h3 className="text-lg font-semibold">Bot Settings</h3>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Automation Enabled</div>
            <div className="text-sm text-gray-400">Allow bot to place trades automatically</div>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, enabled: !c.enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.enabled ? 'bg-green-500' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Dry Run Mode</div>
            <div className="text-sm text-gray-400">Simulate trades without real money</div>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, dryRun: !c.dryRun }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.dryRun ? 'bg-yellow-500' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.dryRun ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        <div>
          <label className="block font-medium mb-2">API Environment</label>
          <select
            value={config.apiEnvironment}
            onChange={(e) => setConfig(c => ({ ...c, apiEnvironment: e.target.value }))}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
          >
            <option value="demo">Demo (demo-api.kalshi.co)</option>
            <option value="prod">Production (api.kalshi.co)</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">Use Demo for testing with paper money</p>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold">Market Types</h3>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Crypto Markets</div>
            <div className="text-sm text-gray-400">BTC 15-minute price predictions</div>
          </div>
          <button
            onClick={() => setConfig(c => ({
              ...c,
              markets: { ...c.markets, crypto: { ...c.markets.crypto, enabled: !c.markets.crypto.enabled }}
            }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.markets?.crypto?.enabled ? 'bg-blue-500' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.markets?.crypto?.enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Sports Markets</div>
            <div className="text-sm text-gray-400">NFL, NBA game outcomes</div>
          </div>
          <button
            onClick={() => setConfig(c => ({
              ...c,
              markets: { ...c.markets, sports: { ...c.markets.sports, enabled: !c.markets.sports.enabled }}
            }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.markets?.sports?.enabled ? 'bg-purple-500' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              config.markets?.sports?.enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 rounded-lg font-medium transition-colors"
      >
        {saving ? 'Saving...' : 'Save Configuration'}
      </button>
    </div>
  )
}
