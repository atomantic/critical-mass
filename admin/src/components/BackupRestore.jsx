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
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [restoring, setRestoring] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const fetchData = async () => {
    setLoading(true)
    const res = await fetch('/api/backups')
    if (res.ok) {
      const data = await res.json()
      setBackups(data.backups || [])
      setConfig(data.config || {})
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleSaveConfig = async () => {
    setSaving(true)
    setMessage(null)
    const res = await fetch('/api/backups/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (res.ok) {
      setMessage({ type: 'success', text: 'Backup settings saved!' })
      fetchData()
    } else {
      setMessage({ type: 'error', text: 'Failed to save settings' })
    }
    setSaving(false)
  }

  const handleCreateBackup = async () => {
    setCreating(true)
    setMessage(null)
    const res = await fetch('/api/backups', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      setMessage({ type: 'success', text: `Backup created: ${data.filename} (${formatBytes(data.sizeBytes)})` })
      fetchData()
    } else {
      const data = await res.json().catch(() => ({}))
      setMessage({ type: 'error', text: `Backup failed: ${data.error || 'Unknown error'}` })
    }
    setCreating(false)
  }

  const handleDelete = async (filename) => {
    setDeleting(filename)
    const res = await fetch(`/api/backups/${filename}`, { method: 'DELETE' })
    if (res.ok) {
      setMessage({ type: 'success', text: `Deleted ${filename}` })
      fetchData()
    } else {
      setMessage({ type: 'error', text: 'Failed to delete backup' })
    }
    setDeleting(null)
  }

  const handleRestore = async () => {
    if (!restoreTarget) return
    setRestoring(true)
    setMessage(null)
    const res = await fetch(`/api/backups/${restoreTarget}/restore`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.success) {
      setMessage({ type: 'success', text: data.message || `Restored ${data.filesRestored} files` })
    } else {
      setMessage({ type: 'error', text: `Restore failed: ${data.error || 'Unknown error'}` })
    }
    setRestoreTarget(null)
    setRestoring(false)
    fetchData()
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
          <div className="flex gap-3">
            <button
              onClick={() => setRestoreTarget(null)}
              disabled={restoring}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-yellow-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {restoring ? 'Restoring...' : 'Confirm Restore'}
            </button>
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
