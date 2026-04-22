import { useState, useEffect } from 'react'

const EXCHANGE_FIELD_CONFIGS = {
  coinbase: {
    title: 'Coinbase Advanced Trade API',
    description: 'Configure your Coinbase API credentials. You can create API keys at https://www.coinbase.com/settings/api',
    fields: [
      { key: 'name', label: 'API Key Name', type: 'text', placeholder: 'organizations/.../apiKeys/...', help: 'The API key identifier (starts with "organizations/")' },
      { key: 'privateKey', label: 'Private Key', type: 'textarea', placeholder: '-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----', help: 'The EC private key in PEM format' },
    ],
  },
  gemini: {
    title: 'Gemini API',
    description: 'Configure your Gemini API credentials. You can create API keys at https://exchange.gemini.com/settings/api',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'master-xxxxxxxx', help: 'Your Gemini API key' },
      { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: '••••••••••••••••', help: 'Your Gemini API secret' },
    ],
  },
}

function KeysConfig({ exchange, onSave }) {
  const [keys, setKeys] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const config = EXCHANGE_FIELD_CONFIGS[exchange] || {
    title: `${exchange} API`,
    description: 'Configure your API credentials.',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'text' },
      { key: 'apiSecret', label: 'API Secret', type: 'password' },
    ],
  }

  useEffect(() => {
    const fetchKeys = async () => {
      setLoading(true)
      setMessage(null)
      setTestResult(null)
      const res = await fetch(`/api/${exchange}/keys`)
      if (res.ok) {
        const data = await res.json()
        setKeys(data.keys || {})
      } else if (res.status !== 404) {
        setMessage({ type: 'error', text: 'Failed to load keys' })
      }
      setLoading(false)
    }
    fetchKeys()
  }, [exchange])

  const handleChange = (key, value) => {
    setKeys(prev => ({ ...prev, [key]: value }))
    setTestResult(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    const res = await fetch(`/api/${exchange}/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys),
    })
    if (res.ok) {
      setMessage({ type: 'success', text: 'API keys saved successfully!' })
      onSave?.()
    } else {
      const error = await res.json()
      setMessage({ type: 'error', text: error.error || 'Failed to save keys' })
    }
    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    const res = await fetch(`/api/${exchange}/test-connection`, { method: 'POST' })
    const data = await res.json()
    setTestResult(data)
    setTesting(false)
  }

  const hasAllFields = config.fields.every(f => keys[f.key]?.trim())
  const hasAnyKeys = config.fields.some(f => keys[f.key]?.trim())

  const handleDelete = async () => {
    setDeleting(true)
    setMessage(null)
    const res = await fetch(`/api/${exchange}/keys`, { method: 'DELETE' })
    if (res.ok) {
      setKeys({})
      setConfirmDelete(false)
      setMessage({ type: 'success', text: 'API keys deleted successfully!' })
      onSave?.()
    } else {
      setMessage({ type: 'error', text: 'Failed to delete keys' })
    }
    setDeleting(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-gray-400">Loading keys...</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">{config.title}</h2>
          <button
            onClick={() => setShowSecrets(!showSecrets)}
            className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
          >
            {showSecrets ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Hide Secrets
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Show Secrets
              </>
            )}
          </button>
        </div>

        <p className="text-gray-400 text-sm mb-6">{config.description}</p>

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
          {config.fields.map(field => (
            <div key={field.key}>
              <label htmlFor={field.key} className="block text-sm font-medium text-gray-300 mb-1">
                {field.label}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={field.key}
                  value={keys[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  rows={5}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-blue-500 resize-none"
                />
              ) : (
                <input
                  id={field.key}
                  type={field.type === 'password' && !showSecrets ? 'password' : 'text'}
                  value={keys[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                />
              )}
              {field.help && <p className="mt-1 text-xs text-gray-500">{field.help}</p>}
            </div>
          ))}
        </div>

        {/* Test Connection Result */}
        {testResult && (
          <div className={`mt-4 p-3 rounded-lg ${
            testResult.success
              ? 'bg-green-900/50 border border-green-700'
              : 'bg-red-900/50 border border-red-700'
          }`}>
            <div className={`font-medium ${testResult.success ? 'text-green-200' : 'text-red-200'}`}>
              {testResult.success ? '✓ Connection successful!' : '✗ Connection failed'}
            </div>
            {testResult.balance && (
              <div className="text-sm text-gray-300 mt-1">
                Balance: ${testResult.balance.available?.toFixed(2)} available
              </div>
            )}
            {testResult.error && (
              <div className="text-sm text-red-300 mt-1">{testResult.error}</div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving || !hasAllFields}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Keys'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !hasAllFields}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {hasAnyKeys && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:bg-red-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              Delete Keys
            </button>
          )}
        </div>

        {/* Delete Confirmation Modal */}
        {confirmDelete && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-md mx-4">
              <h3 className="text-lg font-semibold text-white mb-2">Delete API Keys?</h3>
              <p className="text-gray-400 mb-4">
                Are you sure you want to delete the {exchange} API keys? This action cannot be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-red-800 rounded-lg font-medium transition-colors"
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Security Warning */}
      <div className="mt-4 p-4 bg-yellow-900/30 border border-yellow-700/50 rounded-lg text-yellow-200 text-sm">
        <strong>Security Note:</strong> API keys are stored locally in the data directory. Never share your API secrets with anyone.
        For Coinbase, use "Trade" permission only. For Gemini, use "Primary" scope with trading enabled.
      </div>
    </div>
  )
}

export default KeysConfig
