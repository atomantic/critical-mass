import { useState, useEffect } from 'react'

const INTERVAL_OPTIONS = [
  { label: '6 hours', value: 6 * 60 * 60 * 1000 },
  { label: '12 hours', value: 12 * 60 * 60 * 1000 },
  { label: '24 hours', value: 24 * 60 * 60 * 1000 },
  { label: '48 hours', value: 48 * 60 * 60 * 1000 },
]

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function BackupRestore() {
  const [config, setConfig] = useState(null)
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [restoring, setRestoring] = useState(false)
  // Set when the gateway refuses a restore because a writer never confirmed it
  // stopped (HTTP 409 `writers-not-quiesced`). Holds the blocking writers so the
  // operator can see WHAT is still alive before deciding to override (issue #429).
  const [blockedBy, setBlockedBy] = useState(null)
  const [forceAcknowledged, setForceAcknowledged] = useState(false)
  // Pre-flight result for the selected archive: whether it carries a #430
  // configuration manifest, which funds it would restore, and whether that
  // replays cleanly onto THIS machine's base config. Read-only — fetched when
  // the operator selects an archive, before any restore is submitted.
  const [compatibility, setCompatibility] = useState(null)
  const [compatibilityLoading, setCompatibilityLoading] = useState(false)
  const [compatibilityError, setCompatibilityError] = useState(null)
  const [legacyAcknowledged, setLegacyAcknowledged] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [refreshError, setRefreshError] = useState(null)

  // `silent` refreshes run after a completed action: they must never swap the page
  // for the loading/error gate, or the action's own result message is erased.
  const fetchData = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    const fail = (text) => (silent ? setRefreshError(text) : setError(text))
    try {
      const res = await fetch('/api/backups')
      if (res.ok) {
        const data = await res.json()
        setBackups(data.backups || [])
        setConfig(data.config || {})
        setRefreshError(null)
      } else {
        fail(`Failed to load backups (HTTP ${res.status})`)
      }
    } catch (err) {
      fail(err.message || 'Failed to load backups')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    if (!restoreTarget) {
      setCompatibility(null)
      setCompatibilityError(null)
      return
    }
    let cancelled = false
    setCompatibilityLoading(true)
    setCompatibility(null)
    setCompatibilityError(null)
    fetch(`/api/backups/${restoreTarget}/compatibility`)
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return
        if (ok && data?.success) setCompatibility(data)
        else setCompatibilityError(data?.error || 'Unknown error')
      })
      .catch(err => { if (!cancelled) setCompatibilityError(err.message || 'Request failed') })
      .finally(() => { if (!cancelled) setCompatibilityLoading(false) })
    return () => { cancelled = true }
  }, [restoreTarget])

  const handleSaveConfig = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/backups/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (res.ok) {
        setMessage({ type: 'success', text: 'Backup settings saved!' })
        fetchData({ silent: true })
      } else {
        setMessage({ type: 'error', text: 'Failed to save settings' })
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleCreateBackup = async () => {
    setCreating(true)
    setMessage(null)
    try {
      const res = await fetch('/api/backups', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setMessage({ type: 'success', text: `Backup created: ${data.filename} (${formatBytes(data.sizeBytes)})` })
        fetchData({ silent: true })
      } else {
        const data = await res.json().catch(() => ({}))
        setMessage({ type: 'error', text: `Backup failed: ${data.error || 'Unknown error'}` })
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to create backup' })
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (filename) => {
    setDeleting(filename)
    try {
      const res = await fetch(`/api/backups/${filename}`, { method: 'DELETE' })
      if (res.ok) {
        setMessage({ type: 'success', text: `Deleted ${filename}` })
        fetchData({ silent: true })
      } else {
        setMessage({ type: 'error', text: 'Failed to delete backup' })
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to delete backup' })
    } finally {
      setDeleting(null)
    }
  }

  const handleRestore = async ({ force = false } = {}) => {
    if (!restoreTarget) return
    setRestoring(true)
    setMessage(null)
    let blocked = null
    try {
      const res = await fetch(`/api/backups/${restoreTarget}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force, acceptLegacyWithoutBase: legacyAcknowledged }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        setMessage({
          type: data.forced ? 'error' : 'success',
          text: [
            data.forced
              ? `${data.message || `Restored ${data.filesRestored} files`} — FORCED past ${data.unconfirmed?.length || 0} unconfirmed writer(s); verify your data before restarting engines.`
              : (data.message || `Restored ${data.filesRestored} files`),
            data.configRestored
              ? 'Fund configuration was restored from the archive manifest.'
              : 'Data files only — this machine kept its existing fund configuration.',
          ].join(' '),
        })
      } else if (res.status === 409 && data.code === 'writers-not-quiesced') {
        // Nothing was written. Keep the target selected and offer the override.
        blocked = data.unconfirmed || []
        setMessage({ type: 'error', text: data.error || 'Restore blocked: writers did not confirm shutdown' })
      } else {
        setMessage({ type: 'error', text: `Restore failed: ${data.error || 'Unknown error'}` })
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to restore backup' })
    } finally {
      setBlockedBy(blocked)
      setForceAcknowledged(false)
      if (!blocked) setRestoreTarget(null)
      setRestoring(false)
    }
    fetchData({ silent: true })
  }

  const cancelRestore = () => {
    setRestoreTarget(null)
    setBlockedBy(null)
    setForceAcknowledged(false)
    setLegacyAcknowledged(false)
  }

  // A legacy archive carries no configuration, so restoring it is a data-only
  // operation the operator has to opt into explicitly (issue #430).
  const restoreBlocked = compatibilityLoading || (compatibility?.legacy === true && !legacyAcknowledged)

  if (error) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="max-w-sm text-center">
          <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg mb-4">
            {error}
          </div>
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {loading ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      </div>
    )
  }

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Config Panel */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Backup Settings</h2>

        {message && (
          <div className={`mb-4 p-3 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-900/50 border border-green-700 text-green-200'
              : 'bg-red-900/50 border border-red-700 text-red-200'
          }`}>
            {message.text}
          </div>
        )}

        {refreshError && (
          <div className="mb-4 p-3 rounded-lg bg-yellow-900/50 border border-yellow-700 text-yellow-200 flex items-center justify-between gap-3">
            <span>Backup list may be out of date: {refreshError}</span>
            <button
              onClick={() => fetchData({ silent: true })}
              className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 rounded font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
        )}

        {/* Enable toggle */}
        <div className="flex items-center gap-3 mb-4">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={e => setConfig(prev => ({ ...prev, enabled: e.target.checked }))}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
          </label>
          <span className="text-sm font-medium">Enable Scheduled Backups</span>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Backup Interval</label>
              <select
                value={config.intervalMs}
                onChange={e => setConfig(prev => ({ ...prev, intervalMs: parseInt(e.target.value) }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              >
                {INTERVAL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Max Backups</label>
              <input
                type="number"
                value={config.maxBackups}
                onChange={e => setConfig(prev => ({ ...prev, maxBackups: Math.max(1, Math.min(30, parseInt(e.target.value) || 7)) }))}
                min={1}
                max={30}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">Oldest backups are pruned automatically</p>
            </div>
          </div>

          {/* Include price cache */}
          <label className="flex items-center gap-2 text-sm cursor-pointer hover:text-white text-gray-300">
            <input
              type="checkbox"
              checked={config.includePriceCache}
              onChange={e => setConfig(prev => ({ ...prev, includePriceCache: e.target.checked }))}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
            />
            Include price cache files
            <span className="text-xs text-gray-500">(~45MB per exchange, can be regenerated)</span>
          </label>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Manual Backup */}
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Manual Backup</h3>
            <p className="text-sm text-gray-400 mt-1">Create a backup of all trading data right now</p>
          </div>
          <button
            onClick={handleCreateBackup}
            disabled={creating}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
          >
            {creating ? 'Creating...' : 'Create Backup Now'}
          </button>
        </div>
      </div>

      {/* Restore Confirmation */}
      {restoreTarget && (
        <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-yellow-300 mb-2">Confirm Restore</h3>
          <p className="text-sm text-yellow-200 mb-1">
            Restoring <span className="font-mono font-medium">{restoreTarget}</span>
          </p>
          <p className="text-sm text-yellow-200/80 mb-4">
            This will stop all running engines and overwrite current data files.
            API keys will NOT be affected. You will need to restart engines manually from the dashboard.
          </p>
          {compatibilityLoading && (
            <div className="bg-gray-800/60 border border-gray-600 rounded-lg p-4 mb-4 text-sm text-gray-300">
              Checking archive configuration compatibility...
            </div>
          )}
          {compatibility && !compatibilityLoading && (
            compatibility.compatible ? (
              <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 mb-4">
                <p className="text-sm font-semibold text-green-200 mb-2">
                  Archive carries its fund configuration (manifest v{compatibility.manifestVersion}).
                  It will be replayed onto this machine's config, replacing the funds below.
                </p>
                <ul className="text-xs text-green-200/90 font-mono space-y-1">
                  {compatibility.funds?.map(f => (
                    <li key={`${f.exchange}:${f.pair}`}>
                      {f.exchange} &middot; {f.pair} &middot; {f.totalAllocation ?? '—'}
                      {f.enabled ? ' · enabled' : ' · disabled'}{f.dryRun ? ' · dry-run' : ''}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-green-200/70 mt-2">
                  API keys, Telegram and Sentinel credentials on this machine are preserved.
                </p>
              </div>
            ) : (
              <div className="bg-red-900/40 border border-red-700 rounded-lg p-4 mb-4">
                <p className="text-sm font-semibold text-red-200 mb-2">
                  {compatibility.legacy ? 'Legacy archive: no configuration manifest' : 'Archive configuration cannot be applied'}
                </p>
                <p className="text-xs text-red-200/90 mb-3">{compatibility.error}</p>
                {compatibility.legacy && (
                  <label className="flex items-center gap-2 text-xs text-red-200">
                    <input
                      type="checkbox"
                      checked={legacyAcknowledged}
                      onChange={e => setLegacyAcknowledged(e.target.checked)}
                      className="accent-red-500"
                    />
                    Restore data files only and keep this machine's current fund configuration
                  </label>
                )}
              </div>
            )
          )}
          {compatibilityError && !compatibilityLoading && (
            <div className="bg-yellow-900/40 border border-yellow-700 rounded-lg p-4 mb-4 text-xs text-yellow-200">
              Could not check archive compatibility: {compatibilityError}
            </div>
          )}
          {blockedBy && (
            <div className="bg-red-900/40 border border-red-700 rounded-lg p-4 mb-4">
              <p className="text-sm font-semibold text-red-200 mb-2">
                Blocked: {blockedBy.length} writer(s) did not confirm shutdown. No files were changed.
              </p>
              <ul className="text-xs text-red-200/90 font-mono space-y-1 mb-3">
                {blockedBy.map(w => (
                  <li key={`${w.exchange}:${w.reason}`}>
                    {w.exchange} &middot; {w.reason}{w.error ? ` — ${w.error}` : ''}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-red-200/80 mb-3">
                Forcing the restore applies the archive anyway. If one of these writers is
                still alive it will overwrite the recovered files with its own pre-restore
                snapshot. Only force when you know the process is dead (e.g. a crashed
                engine that cannot be reached over IPC).
              </p>
              <label className="flex items-center gap-2 text-xs text-red-200">
                <input
                  type="checkbox"
                  checked={forceAcknowledged}
                  onChange={e => setForceAcknowledged(e.target.checked)}
                  className="accent-red-500"
                />
                I have verified the listed writers are not running
              </label>
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={cancelRestore}
              disabled={restoring}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => handleRestore()}
              disabled={restoring || restoreBlocked}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-yellow-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {restoring ? 'Restoring...' : blockedBy ? 'Retry Restore' : 'Confirm Restore'}
            </button>
            {blockedBy && (
              <button
                onClick={() => handleRestore({ force: true })}
                disabled={restoring || restoreBlocked || !forceAcknowledged}
                className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:bg-red-900 disabled:text-red-400 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
              >
                Force Restore Anyway
              </button>
            )}
          </div>
        </div>
      )}

      {/* Backups List */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Backups ({backups.length})</h3>
        {backups.length === 0 ? (
          <p className="text-gray-400 text-sm">No backups yet. Create one manually or wait for the scheduled backup.</p>
        ) : (
          <div className="space-y-2">
            {backups.map(backup => (
              <div key={backup.filename} className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono text-gray-200 truncate">{backup.filename}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {new Date(backup.createdAt).toLocaleString()} &middot; {formatBytes(backup.sizeBytes)}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <button
                    onClick={() => setRestoreTarget(backup.filename)}
                    disabled={restoring}
                    className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 disabled:bg-yellow-800 disabled:cursor-not-allowed rounded text-xs font-medium transition-colors"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => handleDelete(backup.filename)}
                    disabled={deleting === backup.filename}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed rounded text-xs font-medium transition-colors"
                  >
                    {deleting === backup.filename ? '...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default BackupRestore
