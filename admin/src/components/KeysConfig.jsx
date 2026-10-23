import Button from './ui/Button'
import { useState, useEffect, useRef } from 'react'
import ModalDialog from './ModalDialog'
import { plural } from '../utils/plural.mjs'
import { apiGet, apiPost, apiPut, apiDelete, describeMutationFailure } from '../utils/apiClient'
import { useNotify } from './Toast'

const EXCHANGE_DISPLAY_NAMES = { coinbase: 'Coinbase', gemini: 'Gemini', cryptocom: 'Crypto.com' }

function getConnectionResult(testResult, exchangeName) {
  if (!testResult) return null
  if (!testResult.success) return { heading: '✗ Connection failed', details: testResult.error || '' }

  let details = ''
  if (testResult.balance) {
    const currency = testResult.quoteCurrency
    const precision = currency === 'BTC' || currency === 'ETH' ? 8 : 2
    const available = testResult.balance.available
    const amount = Number.isFinite(Number(available)) ? Number(available).toFixed(precision) : String(available ?? '')
    details = `Available${currency ? ` ${currency}` : ''}: ${amount}`
    if (currency && testResult.productId) details += ` (quote currency of ${testResult.productId})`
    if (currency && Number(available) === 0) details += ` No ${currency} balance found on this account.`
  }

  return { heading: `✓ Connected to ${exchangeName}`, details }
}

const EXCHANGE_FIELD_CONFIGS = {
  coinbase: {
    title: 'Coinbase Advanced Trade API',
    description: 'Configure your Coinbase Advanced Trade API credentials. Keys must be generated through the Coinbase Developer Platform (CDP) — regular Coinbase API keys are not supported.',
    portalUrl: 'https://cloud.coinbase.com/access/api',
    portalLabel: 'Coinbase Developer Platform (CDP)',
    notice: 'Critical Mass requires Coinbase Advanced API (CDP) credentials. Do NOT use regular or legacy Coinbase API keys from coinbase.com/settings/api — standard API secrets cannot authenticate and will fail. When you create the key, open Advanced settings and set the signature algorithm to ECDSA. The portal\'s default (Ed25519) will not work.',
    fields: [
      { key: 'name', label: 'API Key Name', type: 'text', placeholder: 'organizations/.../apiKeys/...', help: 'The CDP API key name (starts with "organizations/"). Regular Coinbase API keys do not use this format.' },
      { key: 'privateKey', label: 'Private Key', type: 'textarea', placeholder: '-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----', help: 'The ECDSA private key in PEM format (starts with "-----BEGIN EC PRIVATE KEY-----"). Ed25519 keys and standard API secrets are not supported.' },
    ],
  },
  gemini: {
    title: 'Gemini API',
    description: 'Configure your Gemini API credentials. You can create API keys at https://exchange.gemini.com/settings/api',
    portalUrl: 'https://exchange.gemini.com/settings/api',
    portalLabel: 'Gemini API Settings',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'account-xxxxxxxx', help: 'Your Gemini account-level API key (starts with "account-"). Master keys are not supported.' },
      { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: '••••••••••••••••', help: 'Your Gemini API secret' },
    ],
  },
  cryptocom: {
    title: 'Crypto.com API',
    description: 'Configure your Crypto.com Exchange API credentials. You can create API keys at https://exchange.crypto.com/settings/api',
    portalUrl: 'https://exchange.crypto.com/settings/api',
    portalLabel: 'Crypto.com Exchange API Settings',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'your-api-key', help: 'Your Crypto.com API key' },
      { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: '••••••••••••••••', help: 'Your Crypto.com API secret' },
    ],
  },
}

function KeysConfig({ exchange, funds = [], onSave }) {
  // Local edit state — what the operator is typing. The server never echoes back
  // secret values, so this always starts blank regardless of stored state.
  const [keys, setKeys] = useState({})
  // Server-reported contract: whether keys exist, which fields are stored, and when.
  const [configured, setConfigured] = useState(false)
  const [fields, setFields] = useState({})
  const [createdAt, setCreatedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The delete confirmation is a native modal that sits above the toast stack, so its failure is shown inside it.
  const [deleteError, setDeleteError] = useState(null)
  // Load failure is a persistent state of this panel, so it stays inline; save/delete results are toasts.
  const [loadError, setLoadError] = useState(null)
  const notify = useNotify()
  const [showSecrets, setShowSecrets] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  // Bumped whenever the keys under test change, so a test still in flight
  // cannot report on keys that are no longer the ones on screen or on disk.
  const testGeneration = useRef(0)
  // Live region announcements for accessibility
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  const [alertAnnouncement, setAlertAnnouncement] = useState('')

  const exchangeName = EXCHANGE_DISPLAY_NAMES[exchange] || exchange
  const connectionResult = getConnectionResult(testResult, exchangeName)
  const config = EXCHANGE_FIELD_CONFIGS[exchange] || {
    title: `${exchangeName} API`,
    description: 'Configure your API credentials.',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'text' },
      { key: 'apiSecret', label: 'API Secret', type: 'password' },
    ],
  }

  const fundPairs = funds.map(fund => fund.pair).filter(Boolean)
  const runningFunds = funds.filter(fund => fund.regimeRunning).length
  const pairList = fundPairs.join(', ')

  // `silent` skips the full-page loading state so a post-save/post-delete refetch
  // doesn't blank out the form while the save/delete toast is up.
  const fetchKeys = async (silent = false) => {
    if (!silent) setLoading(true)
    testGeneration.current += 1
    setTestResult(null)
    const result = await apiGet(`/api/${exchange}/keys`, { allowEmpty: true })
    if (result.ok) {
      const data = result.data || {}
      setConfigured(Boolean(data.configured))
      setFields(data.fields || {})
      setCreatedAt(data.createdAt || null)
      setLoadError(null)
    } else if (result.status !== 404) {
      setLoadError(result.status === 0 ? result.error : 'Failed to load keys')
    }
    if (!silent) setLoading(false)
  }

  useEffect(() => {
    setKeys({})
    setLoadError(null)
    fetchKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange])

  // Announce connection test results via live regions
  useEffect(() => {
    if (testResult === null) {
      // Clear announcements when testResult is reset (e.g., starting a new test)
      setStatusAnnouncement('')
      setAlertAnnouncement('')
    } else if (testResult) {
      const result = getConnectionResult(testResult, exchangeName)
      const announcement = [result.heading, result.details].filter(Boolean).join(' ')

      if (testResult.success) {
        setStatusAnnouncement(announcement)
        setAlertAnnouncement('')
      } else {
        setAlertAnnouncement(announcement)
        setStatusAnnouncement('')
      }
    }
  }, [testResult])

  const handleChange = (key, value) => {
    setKeys(prev => ({ ...prev, [key]: value }))
    testGeneration.current += 1
    setTestResult(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await apiPut(`/api/${exchange}/keys`, keys, { allowEmpty: true })
      if (result.ok) {
        notify('success', 'API keys saved successfully!')
        setKeys({})
        await fetchKeys(true)
        onSave?.()
      } else {
        notify('error', describeMutationFailure(result, 'Failed to save keys'))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    const generation = ++testGeneration.current
    setTesting(true)
    setTestResult(null)
    const response = await apiPost(`/api/${exchange}/test-connection`)
    setTesting(false)
    // A reply body (including success:false) is the server's own verdict; otherwise report the client's reason.
    const result = response.data ?? { success: false, error: response.error }
    if (generation === testGeneration.current) setTestResult(result)
  }

  // Save requires every field to be freshly typed — the server never echoes stored
  // values back, so there's nothing to submit unless the operator supplies them all.
  const hasAllFields = config.fields.every(f => keys[f.key]?.trim())
  // Credentials exist whenever the server says so, regardless of what (if anything)
  // is currently typed in the form.
  const hasAnyKeys = configured
  // The server tests the keys saved on disk, never the form. While new keys are
  // typed a "Connected" result would vouch for the old keys, so testing waits
  // until they are saved (or the edits are cleared).
  const hasTypedKeys = config.fields.some(f => keys[f.key]?.trim())
  const canTest = configured && !hasTypedKeys

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await apiDelete(`/api/${exchange}/keys`, { allowEmpty: true })
      if (result.ok) {
        setKeys({})
        setConfirmDelete(false)
        notify('success', 'API keys deleted successfully!')
        await fetchKeys(true)
        onSave?.()
      } else {
        setDeleteError(describeMutationFailure(result, 'Failed to delete keys'))
      }
    } finally {
      setDeleting(false)
    }
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
      {/* Live regions for screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusAnnouncement}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {alertAnnouncement}
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">{config.title}</h2>
            {configured ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/50 border border-green-700 text-green-200">
                Configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-700 border border-gray-600 text-gray-300">
                Not configured
              </span>
            )}
          </div>
          <Button
            onClick={() => setShowSecrets(!showSecrets)}
            variant="quiet" size="inline" className="gap-1"
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
          </Button>
        </div>

        {config.notice && (
          <div className="mb-4 p-3.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs leading-relaxed">
            <div className="font-semibold text-amber-100 flex items-center gap-1.5 mb-1 text-sm">
              <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Coinbase Advanced API Required</span>
            </div>
            <p className="mb-2 text-amber-200/90">{config.notice}</p>
            {config.portalUrl && (
              <a
                href={config.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-amber-300 hover:text-white underline font-medium"
              >
                Create API Key on {config.portalLabel || 'Portal'} →
              </a>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-sm text-gray-400 mb-1">
          <p>{config.description}</p>
          {!config.notice && config.portalUrl && (
            <a
              href={config.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 underline shrink-0 inline-flex items-center gap-1"
            >
              Open Settings →
            </a>
          )}
        </div>
        <p className="text-gray-400 text-sm mb-3">
          These keys are shared by all {plural(funds.length, `${exchangeName} fund`)}: {pairList}.
        </p>
        <p className="text-gray-400 text-xs mb-6">
          {configured && createdAt ? `Stored on ${new Date(createdAt).toLocaleString()}` : ' '}
        </p>

        {loadError && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/50 border border-red-700 text-red-200">
            {loadError}
          </div>
        )}

        <div className="space-y-4">
          {config.fields.map(field => {
            const isStored = Boolean(fields[field.key])
            const placeholder = isStored
              ? 'stored — enter a new value to replace'
              : field.placeholder
            return (
            <div key={field.key}>
              <label htmlFor={field.key} className="block text-sm font-medium text-gray-300 mb-1 flex items-center gap-2">
                {field.label}
                {isStored && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-green-900/50 border border-green-700 text-green-200">
                    configured
                  </span>
                )}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={field.key}
                  value={keys[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={placeholder}
                  rows={5}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-hidden focus:border-blue-500 resize-none"
                />
              ) : (
                <input
                  id={field.key}
                  type={field.type === 'password' && !showSecrets ? 'password' : 'text'}
                  value={keys[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                />
              )}
              {field.help && <p className="mt-1 text-xs text-gray-400">{field.help}</p>}
            </div>
            )
          })}
        </div>

        {/* Test Connection Result */}
        {testResult && (
          <div className={`mt-4 p-3 rounded-lg ${
            testResult.success
              ? 'bg-green-900/50 border border-green-700'
              : 'bg-red-900/50 border border-red-700'
          }`}>
            <div className={`font-medium ${testResult.success ? 'text-green-200' : 'text-red-200'}`}>
              {connectionResult.heading}
            </div>
            {testResult.success && connectionResult.details && (
              <div className="text-sm text-gray-300 mt-1">
                {connectionResult.details}
              </div>
            )}
            {testResult.error && (
              <div className="text-sm text-red-300 mt-1">{testResult.error}</div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          <Button
            onClick={handleSave}
            disabled={saving || !hasAllFields}
            variant="primary" size="md" touchTarget="always" className="flex-1 font-medium"
          >
            {saving ? 'Saving...' : 'Save Keys'}
          </Button>
          <Button
            onClick={handleTest}
            disabled={testing || !canTest}
            variant="secondary" size="md" touchTarget="always" className="font-medium"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </Button>
          {hasTypedKeys && (
            <p className="text-xs text-gray-400 sm:self-center">Save the new keys to test them.</p>
          )}
          {hasAnyKeys && (
            <Button
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              variant="destructive" size="md" touchTarget="always" className="font-medium"
            >
              Delete Keys
            </Button>
          )}
        </div>

        {/* Delete Confirmation Modal */}
        {confirmDelete && (
          <ModalDialog
            onClose={() => { setConfirmDelete(false); setDeleteError(null) }}
            labelledBy="delete-keys-title"
            describedBy="delete-keys-desc"
            dismissible={!deleting}
          >
            <h3 id="delete-keys-title" className="text-lg font-semibold text-white mb-2">Delete {exchangeName} API keys?</h3>
            <p id="delete-keys-desc" className="text-gray-400 mb-4">
              Every {exchangeName} fund ({pairList}) uses these keys. {runningFunds > 0 && `${plural(runningFunds, 'running fund')} will immediately fail to place, cancel or check orders until new keys are saved. `}
              {exchange === 'gemini' && 'If this key has "Requires Heartbeat" enabled, Gemini cancels its open orders about 5 minutes after heartbeats stop. '}
              Exchanges show the secret only once, so reconnecting usually means creating a new key.
            </p>
            {deleteError && <p role="alert" className="text-red-300 mb-4">{deleteError}</p>}
            <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
              <Button
                type="button"
                autoFocus
                onClick={() => { setConfirmDelete(false); setDeleteError(null) }}
                disabled={deleting}
                variant="secondary" size="md" touchTarget="always" className="font-medium"
              >
                Keep keys
              </Button>
              <Button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                variant="destructive" size="md" touchTarget="always" className="font-medium"
              >
                {deleting ? 'Deleting…' : `Delete ${exchangeName} keys`}
              </Button>
            </div>
          </ModalDialog>
        )}
      </div>

      {/* Security Warning */}
      <div className="mt-4 p-4 bg-yellow-900/30 border border-yellow-700/50 rounded-lg text-yellow-200 text-sm">
        <strong>Security Note:</strong> API keys are stored locally in the data directory. Never share your API secrets with anyone.
        Coinbase: View + Trade (leave Transfer off). Gemini: an account-level ("Primary") key with the Trading role.
        If you enable "Requires Heartbeat", Gemini cancels this key's open orders about 5 minutes after the last Gemini fund stops.
        Crypto.com: Trade permission (leave withdrawals off).
      </div>
    </div>
  )
}

export default KeysConfig
