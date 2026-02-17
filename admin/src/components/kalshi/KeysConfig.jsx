import { useState, useEffect } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export default function KeysConfig() {
  const [keys, setKeys] = useState({
    keyId: '',
    privateKeyPem: '',
    environment: 'demo'
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => {
    const fetchKeys = async () => {
      setLoading(true)
      setMessage(null)
      setTestResult(null)

      const res = await fetch('/api/kalshi/keys')
      if (res.ok) {
        const data = await res.json()
        if (data.keys?.hasKeys) {
          setKeys({
            keyId: data.keys.keyId || '',
            privateKeyPem: '', // Don't show actual key
            environment: data.keys.environment || 'demo'
          })
        }
      }
      setLoading(false)
    }
    fetchKeys()
  }, [])

  const handleChange = (key, value) => {
    setKeys(prev => ({ ...prev, [key]: value }))
    setTestResult(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)

    const res = await fetch('/api/kalshi/keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys)
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'API keys saved successfully!' })
    } else {
      const error = await res.json().catch(() => ({}))
      setMessage({ type: 'error', text: error.error || 'Failed to save keys' })
    }

    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)

    const res = await fetch('/api/kalshi/test-connection', { method: 'POST' })
    const data = await res.json().catch(() => ({ error: 'Failed to connect' }))
    setTestResult(data)

    setTesting(false)
  }

  const handleDelete = async () => {
    setDeleting(true)
    setMessage(null)

    const res = await fetch('/api/kalshi/keys', { method: 'DELETE' })

    if (res.ok) {
      setKeys({ keyId: '', privateKeyPem: '', environment: 'demo' })
      setConfirmDelete(false)
      setMessage({ type: 'success', text: 'API keys deleted successfully!' })
      setTestResult(null)
    } else {
      setMessage({ type: 'error', text: 'Failed to delete keys' })
    }

    setDeleting(false)
  }

  const hasAllFields = keys.keyId?.trim() && keys.privateKeyPem?.trim()
  const hasAnyKeys = keys.keyId?.trim()

  if (loading) {
    return <div className="text-gray-400">Loading keys...</div>
  }

  return (
    <div className="max-w-2xl">
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Kalshi API Credentials</h2>
          <button
            onClick={() => setShowSecrets(!showSecrets)}
            className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
          >
            {showSecrets ? <EyeOff size={16} /> : <Eye size={16} />}
            {showSecrets ? 'Hide' : 'Show'}
          </button>
        </div>

        <p className="text-gray-400 text-sm mb-6">
          Configure your Kalshi API credentials. You can create API keys at{' '}
          <a
            href="https://kalshi.com/account/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            kalshi.com/account/api-keys
          </a>
        </p>

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
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              API Key ID
            </label>
            <input
              type="text"
              value={keys.keyId}
              onChange={(e) => handleChange('keyId', e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">The API key identifier (UUID format)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Private Key (RSA PEM)
            </label>
            <textarea
              value={keys.privateKeyPem}
              onChange={(e) => handleChange('privateKeyPem', e.target.value)}
              placeholder={showSecrets ? '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----' : '... (configured)'}
              rows={6}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-blue-500 resize-none"
            />
            <p className="mt-1 text-xs text-gray-500">The RSA private key in PEM format</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Environment
            </label>
            <select
              value={keys.environment}
              onChange={(e) => handleChange('environment', e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="demo">Demo (demo-api.kalshi.co)</option>
              <option value="prod">Production (api.kalshi.co)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">Use Demo for testing with paper money</p>
          </div>
        </div>

        {/* Test Connection Result */}
        {testResult && (
          <div className={`mt-4 p-3 rounded-lg ${
            testResult.success
              ? 'bg-green-900/50 border border-green-700'
              : 'bg-red-900/50 border border-red-700'
          }`}>
            <div className={`font-medium ${testResult.success ? 'text-green-200' : 'text-red-200'}`}>
              {testResult.success ? 'Connection successful!' : 'Connection failed'}
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
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Keys'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !hasAnyKeys}
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
                Are you sure you want to delete your Kalshi API keys? This action cannot be undone.
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
        <strong>Security Note:</strong> API keys are stored locally in the data directory.
        Never share your private key with anyone. Use a dedicated API key with limited permissions for this bot.
      </div>
    </div>
  )
}
