import { useState, useEffect } from 'react'

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
    { key: 'depth_pause', label: 'Depth Pause' },
    { key: 'regime_hourly', label: 'Hourly Summary' },
    { key: 'orders_consolidated', label: 'Orders Consolidated' },
  ],
}

function NotificationsConfig() {
  const [config, setConfig] = useState(null)
  const [rawToken, setRawToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState(null)
  const [stats, setStats] = useState(null)

  const fetchConfig = async () => {
    setLoading(true)
    const res = await fetch('/api/notifications/config')
    if (res.ok) {
      const data = await res.json()
      setConfig(data)
      setRawToken('')
    }
    setLoading(false)
  }

  const fetchStats = async () => {
    const res = await fetch('/api/notifications/stats')
    if (res.ok) {
      setStats(await res.json())
    }
  }

  useEffect(() => {
    fetchConfig()
    fetchStats()
    const interval = setInterval(fetchStats, 10000)
    return () => clearInterval(interval)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)

    const payload = { ...config }
    // Only send token if user entered a new one
    if (rawToken) {
      payload.telegram = { ...payload.telegram, botToken: rawToken }
    } else {
      // Don't send masked token back
      delete payload.telegram.botToken
    }

    const res = await fetch('/api/notifications/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'Notification settings saved!' })
      fetchConfig()
      fetchStats()
    } else {
      setMessage({ type: 'error', text: 'Failed to save settings' })
    }
    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setMessage(null)
    const res = await fetch('/api/notifications/test', { method: 'POST' })
    const result = await res.json()
    if (result.success) {
      setMessage({ type: 'success', text: 'Test message sent to Telegram!' })
    } else {
      setMessage({ type: 'error', text: `Test failed: ${result.error}` })
    }
    setTesting(false)
    fetchStats()
  }

  const updateEvent = (key, value) => {
    setConfig(prev => ({
      ...prev,
      events: { ...prev.events, [key]: value },
    }))
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
      {/* Telegram Setup */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Telegram Notifications</h2>
        <p className="text-gray-400 text-sm mb-6">
          Get notified of critical events via Telegram. Create a bot with{' '}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">@BotFather</a>
          {' '}and get your chat ID from{' '}
          <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">@userinfobot</a>.
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
          <span className="text-sm font-medium">Enable Notifications</span>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Bot Token</label>
            <input
              type="password"
              value={rawToken || ''}
              onChange={e => setRawToken(e.target.value)}
              placeholder={config.telegram.botToken || 'Enter bot token from @BotFather'}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
            {config.telegram.botToken && !rawToken && (
              <p className="mt-1 text-xs text-gray-500">Token configured (masked). Enter a new value to change.</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Chat ID</label>
            <input
              type="text"
              value={config.telegram.chatId || ''}
              onChange={e => setConfig(prev => ({
                ...prev,
                telegram: { ...prev.telegram, chatId: e.target.value },
              }))}
              placeholder="Your Telegram chat ID"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Event Toggles */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Event Filters</h3>
        <div className="space-y-5">
          {Object.entries(EVENT_GROUPS).map(([group, events]) => (
            <div key={group}>
              <h4 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">{group}</h4>
              <div className="grid grid-cols-2 gap-2">
                {events.map(evt => (
                  <label key={evt.key} className="flex items-center gap-2 text-sm cursor-pointer hover:text-white text-gray-300">
                    <input
                      type="checkbox"
                      checked={config.events[evt.key] !== false}
                      onChange={e => updateEvent(evt.key, e.target.checked)}
                      className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    {evt.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Timing */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Timing</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Rate Limit (ms)</label>
              <input
                type="number"
                value={config.rateLimitMs}
                onChange={e => setConfig(prev => ({ ...prev, rateLimitMs: parseInt(e.target.value) || 5000 }))}
                min={1000}
                max={60000}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">Batch window for rapid events</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Daily Summary Hour</label>
              <input
                type="number"
                value={config.dailySummaryHour}
                onChange={e => setConfig(prev => ({ ...prev, dailySummaryHour: parseInt(e.target.value) || 20 }))}
                min={0}
                max={23}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">Hour (0-23) for daily summary</p>
            </div>
          </div>

          {/* Quiet hours */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.quietHours.enabled}
                  onChange={e => setConfig(prev => ({
                    ...prev,
                    quietHours: { ...prev.quietHours, enabled: e.target.checked },
                  }))}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
              <span className="text-sm font-medium">Quiet Hours</span>
              <span className="text-xs text-gray-500">(critical events still sent)</span>
            </div>
            {config.quietHours.enabled && (
              <div className="grid grid-cols-2 gap-4 ml-14">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Start Hour</label>
                  <input
                    type="number"
                    value={config.quietHours.start}
                    onChange={e => setConfig(prev => ({
                      ...prev,
                      quietHours: { ...prev.quietHours, start: parseInt(e.target.value) || 23 },
                    }))}
                    min={0}
                    max={23}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">End Hour</label>
                  <input
                    type="number"
                    value={config.quietHours.end}
                    onChange={e => setConfig(prev => ({
                      ...prev,
                      quietHours: { ...prev.quietHours, end: parseInt(e.target.value) || 7 },
                    }))}
                    min={0}
                    max={23}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-3">Stats</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-400">Status</div>
              <div className={stats.isRunning ? 'text-green-400' : 'text-gray-500'}>
                {stats.isRunning ? 'Running' : 'Stopped'}
              </div>
            </div>
            <div>
              <div className="text-gray-400">Messages Sent</div>
              <div className="text-white">{stats.sent}</div>
            </div>
            <div>
              <div className="text-gray-400">Errors</div>
              <div className={stats.errors > 0 ? 'text-red-400' : 'text-white'}>{stats.errors}</div>
            </div>
            <div>
              <div className="text-gray-400">Last Sent</div>
              <div className="text-white text-xs">
                {stats.lastSentAt ? new Date(stats.lastSentAt).toLocaleString() : 'Never'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !config.telegram.chatId}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
        >
          {testing ? 'Sending...' : 'Send Test'}
        </button>
      </div>
    </div>
  )
}

export default NotificationsConfig
