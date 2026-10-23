import Button from './ui/Button'
import { useState, useEffect, useRef } from 'react'
import { apiGet, apiPost, apiPut, describeMutationFailure } from '../utils/apiClient'
import usePolling from '../hooks/usePolling'
import { useNotify } from './Toast'

const EVENT_GROUPS = {
  'Critical': [
    { key: 'safe_mode', label: 'SAFE Mode Activated' },
    { key: 'error', label: 'Errors' },
    { key: 'flash_move', label: 'Flash Moves' },
    { key: 'cap_reached', label: 'Cap Reached' },
  ],
  'Trading': [
    { key: 'buy_filled', label: 'Buy Filled' },
    { key: 'entry_filled', label: 'Entry Filled' },
    { key: 'tp_filled', label: 'TP Filled' },
    { key: 'sell_placed', label: 'Sell Placed' },
    { key: 'tp_placed', label: 'TP Placed' },
    { key: 'cycle_reset', label: 'Cycle Reset' },
  ],
  'Informational': [
    { key: 'regime_change', label: 'Regime Change' },
    { key: 'active_mode', label: 'Active Mode Restored' },
    { key: 'spread_pause', label: 'Spread Pause' },
    { key: 'regime_hourly', label: 'Hourly Summary' },
    { key: 'orders_consolidated', label: 'Orders Consolidated' },
  ],
}

function NotificationsConfig() {
  const [config, setConfig] = useState(null)
  const [rawToken, setRawToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const notify = useNotify()
  const [stats, setStats] = useState(null)
  const [refreshError, setRefreshError] = useState(null)

  const pendingSave = useRef(false)
  const configRequest = useRef(0)
  const draftVersion = useRef(0)
  const dirty = useRef(false)
  // Rendered mirror of `dirty`: Send Test uses the saved settings, so it must
  // not run (and report success) while unsaved edits are on screen.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const updateConfig = update => {
    if (pendingSave.current) return
    dirty.current = true
    setHasUnsavedChanges(true)
    draftVersion.current += 1
    setConfig(update)
  }
  const updateToken = token => {
    if (pendingSave.current) return
    dirty.current = true
    setHasUnsavedChanges(true)
    draftVersion.current += 1
    setRawToken(token)
  }

  // `silent` refreshes follow a successful write: they must never swap the page
  // for the loading/error gate (which would unmount the page mid-save).
  const fetchConfig = async ({ silent = false, saved = false } = {}) => {
    if (pendingSave.current && !saved) return
    const request = ++configRequest.current
    const version = draftVersion.current
    const current = () => request === configRequest.current
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    const fail = text => {
      if (current()) (silent ? setRefreshError : setError)(text)
    }
    const result = await apiGet('/api/notifications/config')
    if (current()) {
      if (result.ok) {
        if (!dirty.current && version === draftVersion.current) setConfig(result.data)
        setRefreshError(null)
      } else {
        fail(result.status === 0 ? result.error : `Failed to load notifications config (HTTP ${result.status})`)
      }
    }
    if (!silent && current()) setLoading(false)
  }

  const fetchStats = async () => {
    // A failed stats fetch is ignored so it never blocks the page.
    const result = await apiGet('/api/notifications/stats')
    if (result.ok) setStats(result.data)
  }

  useEffect(() => {
    fetchConfig()
  }, [])
  usePolling(fetchStats, 10000)

  const handleSave = async () => {
    if (pendingSave.current) return
    pendingSave.current = true
    configRequest.current += 1 // Invalidate reads started before this write.
    setSaving(true)

    const { depth_pause, ...editableEvents } = config.events || {}
    const payload = { ...config, events: editableEvents }
    // Only send token if user entered a new one
    if (rawToken) {
      payload.telegram = { ...payload.telegram, botToken: rawToken }
    } else {
      // Don't send the masked token back. Copy rather than delete: payload's
      // telegram object is the one held in state, and deleting from it erased
      // the "token configured" hint after a failed save.
      const { botToken: _maskedToken, ...telegram } = payload.telegram || {}
      payload.telegram = telegram
    }

    try {
      const result = await apiPut('/api/notifications/config', payload, { allowEmpty: true })

      if (result.ok) {
        notify('success', 'Notification settings saved!')
        dirty.current = false
        setHasUnsavedChanges(false)
        if (rawToken) {
          // The write succeeded even if the masked readback later fails.
          setConfig(prev => ({ ...prev, telegram: { ...prev.telegram, botToken: '••••••••' } }))
          setRawToken('')
        }
        await fetchConfig({ silent: true, saved: true })
        fetchStats()
      } else {
        notify('error', result.data?.errors?.join('; ')
            || (result.status === 0
              ? describeMutationFailure(result, 'Failed to save settings')
              : `Failed to save settings (${describeMutationFailure(result, `HTTP ${result.status}`)})`))
      }
    } finally {
      pendingSave.current = false
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const result = await apiPost('/api/notifications/test')
      if (result.ok && result.data?.success) {
        notify('success', 'Test message sent to Telegram!')
      } else {
        notify('error', `Test failed: ${result.data?.error || describeMutationFailure(result, 'Request failed')}`)
      }
    } finally {
      setTesting(false)
      fetchStats()
    }
  }

  const updateEvent = (key, value) => {
    updateConfig(prev => ({
      ...prev,
      events: { ...prev.events, [key]: value },
    }))
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="max-w-sm text-center">
          <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg mb-4">
            {error}
          </div>
          <Button
            onClick={() => fetchConfig()}
            disabled={loading}
            variant="primary" size="md" className="font-medium"
          >
            {loading ? 'Retrying...' : 'Retry'}
          </Button>
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
    <div className="space-y-6">
      {/* Status banner + actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">Telegram Notifications</h1>
          {stats && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
              stats.isRunning ? 'bg-green-900/50 text-green-300 border border-green-700/50' : 'bg-gray-700 text-gray-400 border border-gray-600/50'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${stats.isRunning ? 'bg-green-400' : 'bg-gray-500'}`} />
              {stats.isRunning ? 'Running' : 'Stopped'}
            </span>
          )}
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleTest}
            disabled={testing || hasUnsavedChanges || !config.telegram.chatId}
            title={hasUnsavedChanges ? 'Save your changes first — the test uses the saved settings' : undefined}
            variant="secondary" size="md" className="font-medium"
          >
            {testing ? 'Sending...' : 'Send Test'}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            variant="primary" size="md" className="font-medium"
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {refreshError && (
        <div className="p-3 rounded-lg bg-yellow-900/50 border border-yellow-700 text-yellow-200 flex items-center justify-between gap-3">
          <span>Settings may be out of date: {refreshError}</span>
          <Button
            onClick={() => fetchConfig({ silent: true })}
            disabled={saving}
            variant="warning" size="sm" className="font-medium"
          >
            Refresh
          </Button>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" role="group" aria-label="Notification statistics">
          <div className="bg-gray-800 rounded-lg p-4" role="group" aria-label="Messages Sent">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Messages Sent</div>
            <div className="text-2xl font-semibold tabular-nums">{stats.sent}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4" role="group" aria-label="Errors">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Errors</div>
            <div className={`text-2xl font-semibold tabular-nums ${stats.errors > 0 ? 'text-red-400' : ''}`}>{stats.errors}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4" role="group" aria-label="Queue Depth">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Queue Depth</div>
            <div className="text-2xl font-semibold tabular-nums">{stats.queueDepth}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4" role="group" aria-label="Last Sent">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Last Sent</div>
            <div className="text-sm font-medium mt-1">
              {stats.lastSentAt ? new Date(stats.lastSentAt).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>
      )}

      {/* Two-column layout */}
      <fieldset disabled={saving} className="min-w-0 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: Connection setup + Timing */}
        <div className="space-y-6">
          {/* Telegram Setup */}
          <div className="bg-gray-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Connection</h2>
              <label htmlFor="enable-notifications" className="relative inline-flex items-center cursor-pointer">
                <input
                  id="enable-notifications"
                  type="checkbox"
                  checked={config.enabled}
                  onChange={e => updateConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                <span className="ml-3 text-sm font-medium">Enable notifications</span>
              </label>
            </div>
            <p className="text-gray-400 text-sm mb-5">
              Create a bot with{' '}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">@BotFather</a>
              {' '}and get your chat ID from{' '}
              <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">@userinfobot</a>.
            </p>

            <div className="space-y-4">
              <div>
                <label htmlFor="bot-token" className="block text-sm font-medium text-gray-300 mb-1">Bot Token</label>
                <input
                  id="bot-token"
                  type="password"
                  value={rawToken || ''}
                  onChange={e => updateToken(e.target.value)}
                  placeholder={config.telegram.botToken || 'Enter bot token from @BotFather'}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                />
                {config.telegram.botToken && !rawToken && (
                  <p className="mt-1 text-xs text-gray-400">Token configured (masked). Enter a new value to change.</p>
                )}
              </div>
              <div>
                <label htmlFor="chat-id" className="block text-sm font-medium text-gray-300 mb-1">Chat ID</label>
                <input
                  id="chat-id"
                  type="text"
                  value={config.telegram.chatId || ''}
                  onChange={e => updateConfig(prev => ({
                    ...prev,
                    telegram: { ...prev.telegram, chatId: e.target.value },
                  }))}
                  placeholder="Your Telegram chat ID"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Timing */}
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Timing</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="rate-limit-ms" className="block text-sm font-medium text-gray-300 mb-1">Batch Window (ms)</label>
                  <input
                    id="rate-limit-ms"
                    type="number"
                    value={config.rateLimitMs}
                    onChange={e => updateConfig(prev => ({ ...prev, rateLimitMs: parseInt(e.target.value) || 5000 }))}
                    min={1000}
                    max={60000}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-400">Batch window for rapid events</p>
                </div>
                <div>
                  <label htmlFor="daily-summary-hour" className="block text-sm font-medium text-gray-300 mb-1">Daily Summary Hour</label>
                  <input
                    id="daily-summary-hour"
                    type="number"
                    value={config.dailySummaryHour}
                    onChange={e => {
                      const hour = parseInt(e.target.value, 10)
                      updateConfig(prev => ({ ...prev, dailySummaryHour: Number.isNaN(hour) ? 20 : hour }))
                    }}
                    min={0}
                    max={23}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-400">Hour (0-23) for daily summary (server time, {config.timezone || 'timezone unavailable'})</p>
                </div>
              </div>

              {/* Quiet hours */}
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <label htmlFor="quiet-hours-enabled" className="relative inline-flex items-center cursor-pointer">
                    <input
                      id="quiet-hours-enabled"
                      type="checkbox"
                      checked={config.quietHours.enabled}
                      onChange={e => updateConfig(prev => ({
                        ...prev,
                        quietHours: { ...prev.quietHours, enabled: e.target.checked },
                      }))}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                    <span className="ml-3 text-sm font-medium">Quiet Hours</span>
                  </label>
                  <span className="text-xs text-gray-400">(enabled critical events still sent)</span>
                </div>
                <p className="mb-3 text-xs text-gray-400">Start and end hours use server time ({config.timezone || 'timezone unavailable'}).</p>
                {config.quietHours.enabled && (
                  <div className="grid grid-cols-2 gap-4 ml-14">
                    <div>
                      <label htmlFor="quiet-hours-start" className="block text-sm text-gray-400 mb-1">Start Hour</label>
                      <input
                        id="quiet-hours-start"
                        type="number"
                        value={config.quietHours.start}
                        onChange={e => {
                          const hour = parseInt(e.target.value, 10)
                          updateConfig(prev => ({
                            ...prev,
                            quietHours: { ...prev.quietHours, start: Number.isNaN(hour) ? 23 : hour },
                          }))
                        }}
                        min={0}
                        max={23}
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label htmlFor="quiet-hours-end" className="block text-sm text-gray-400 mb-1">End Hour</label>
                      <input
                        id="quiet-hours-end"
                        type="number"
                        value={config.quietHours.end}
                        onChange={e => {
                          const hour = parseInt(e.target.value, 10)
                          updateConfig(prev => ({
                            ...prev,
                            quietHours: { ...prev.quietHours, end: Number.isNaN(hour) ? 7 : hour },
                          }))
                        }}
                        min={0}
                        max={23}
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-hidden focus:border-blue-500"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right column: Event Filters */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Event Filters</h2>
          <div className="space-y-5">
            {Object.entries(EVENT_GROUPS).map(([group, events]) => (
              <div key={group}>
                <h4 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">{group === 'Critical' ? 'Critical events (always sent, even during quiet hours, when enabled)' : group}</h4>
                {group === 'Critical' && (
                  <p className="mb-2 text-xs text-gray-400">Sentinel critical alerts and fatal errors also bypass quiet hours. Notification delivery must be enabled and configured; event filters still apply.</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {events.map(evt => (
                    <label key={evt.key} className="flex items-center gap-2 text-sm cursor-pointer hover:text-white text-gray-300">
                      <input
                        type="checkbox"
                        checked={config.events[evt.key] !== false}
                        onChange={e => updateEvent(evt.key, e.target.checked)}
                        className="w-4 h-4 rounded-sm bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
                      />
                      {evt.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </fieldset>
    </div>
  )
}

export default NotificationsConfig
