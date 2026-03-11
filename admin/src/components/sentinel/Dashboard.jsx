import { useState, useEffect, useCallback } from 'react'
import useSentinelSocket from '../../hooks/useSentinelSocket'

const SEVERITY_COLORS = {
  critical: 'bg-red-900/50 border-red-700 text-red-200',
  warning: 'bg-yellow-900/50 border-yellow-700 text-yellow-200',
  info: 'bg-blue-900/50 border-blue-700 text-blue-200',
}

const SEVERITY_BADGES = {
  critical: 'bg-red-600 text-white',
  warning: 'bg-yellow-600 text-black',
  info: 'bg-blue-600 text-white',
}

export default function SentinelDashboard() {
  const { connected, latestAlert } = useSentinelSocket()
  const [status, setStatus] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)

  // New feed form
  const [newFeedName, setNewFeedName] = useState('')
  const [newFeedUrl, setNewFeedUrl] = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sentinel/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      }
    } catch { /* ignore */ }
  }, [])

  const fetchAlerts = useCallback(async () => {
    try {
      const url = filter !== 'all' ? `/api/sentinel/alerts?severity=${filter}` : '/api/sentinel/alerts'
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setAlerts(data.alerts || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [filter])

  useEffect(() => {
    fetchStatus()
    fetchAlerts()
    const interval = setInterval(() => { fetchStatus(); fetchAlerts() }, 15000)
    return () => clearInterval(interval)
  }, [fetchStatus, fetchAlerts])

  // Re-fetch alerts when new alert arrives via socket (status comes via socket already)
  useEffect(() => {
    if (latestAlert) {
      fetchAlerts()
    }
  }, [latestAlert, fetchAlerts])

  const handleForcePoll = async () => {
    setPolling(true)
    await fetch('/api/sentinel/poll', { method: 'POST' })
    await fetchAlerts()
    await fetchStatus()
    setPolling(false)
  }

  const handleDismiss = async (alertId) => {
    await fetch(`/api/sentinel/dismiss/${alertId}`, { method: 'POST' })
    setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, dismissed: true } : a))
    fetchStatus()
  }

  const handleClearAll = async () => {
    await fetch('/api/sentinel/alerts', { method: 'DELETE' })
    setAlerts([])
    fetchStatus()
  }

  const handleToggleEnabled = async () => {
    const newEnabled = !status?.status?.config?.enabled
    await fetch('/api/sentinel/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    })
    fetchStatus()
  }

  const handleStart = async () => {
    await fetch('/api/sentinel/start', { method: 'POST' })
    fetchStatus()
  }

  const handleStop = async () => {
    await fetch('/api/sentinel/stop', { method: 'POST' })
    fetchStatus()
  }

  const updateFeeds = async (feeds) => {
    await fetch('/api/sentinel/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feeds }),
    })
    fetchStatus()
  }

  const handleAddFeed = async () => {
    if (!newFeedName.trim() || !newFeedUrl.trim()) return
    await updateFeeds([...(status?.config?.feeds || []), { name: newFeedName.trim(), url: newFeedUrl.trim(), enabled: true }])
    setNewFeedName('')
    setNewFeedUrl('')
  }

  const handleToggleFeed = async (index) => {
    const feeds = [...(status?.config?.feeds || [])]
    feeds[index] = { ...feeds[index], enabled: !feeds[index].enabled }
    await updateFeeds(feeds)
  }

  const handleRemoveFeed = async (index) => {
    await updateFeeds((status?.config?.feeds || []).filter((_, i) => i !== index))
  }

  const formatTime = (ts) => {
    if (!ts) return '-'
    const d = new Date(ts)
    return d.toLocaleString()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">News Sentinel</h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Status + Controls */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status?.running ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className={status?.running ? 'text-green-400' : 'text-gray-400'}>
              {status?.running ? 'Running' : 'Stopped'}
            </span>
          </div>

          <div className="text-sm text-gray-400 space-x-4">
            <span>Polls: {status?.pollCount || 0}</span>
            <span>Alerts: {status?.totalAlerts || 0}</span>
            <span>Active: {status?.activeAlerts || 0}</span>
            <span>Last poll: {formatTime(status?.lastPollAt)}</span>
          </div>

          <div className="ml-auto flex gap-2">
            {status?.running ? (
              <button onClick={handleStop} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded text-sm">
                Stop
              </button>
            ) : (
              <button onClick={handleStart} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm">
                Start
              </button>
            )}
            <button
              onClick={handleForcePoll}
              disabled={polling}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-sm"
            >
              {polling ? 'Polling...' : 'Force Poll'}
            </button>
            <button
              onClick={handleToggleEnabled}
              className={`px-3 py-1.5 rounded text-sm ${status?.config?.enabled ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-gray-600 hover:bg-gray-700'}`}
            >
              {status?.config?.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      </div>

      {/* Feed Configuration */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h2 className="text-lg font-semibold text-white mb-3">RSS Feeds</h2>
        <div className="space-y-2 mb-4">
          {(status?.config?.feeds || []).map((feed, i) => (
            <div key={i} className="flex items-center gap-3 bg-gray-900/50 rounded p-2">
              <button
                onClick={() => handleToggleFeed(i)}
                className={`w-8 h-5 rounded-full relative transition-colors ${feed.enabled ? 'bg-green-600' : 'bg-gray-600'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${feed.enabled ? 'left-3.5' : 'left-0.5'}`} />
              </button>
              <span className="text-sm text-white font-medium min-w-[120px]">{feed.name}</span>
              <span className="text-xs text-gray-400 truncate flex-1">{feed.url}</span>
              <button onClick={() => handleRemoveFeed(i)} className="text-red-400 hover:text-red-300 text-sm px-2">Remove</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newFeedName}
            onChange={e => setNewFeedName(e.target.value)}
            placeholder="Feed name"
            className="px-3 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-white w-40"
          />
          <input
            type="text"
            value={newFeedUrl}
            onChange={e => setNewFeedUrl(e.target.value)}
            placeholder="RSS feed URL"
            className="px-3 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-white flex-1"
          />
          <button
            onClick={handleAddFeed}
            disabled={!newFeedName.trim() || !newFeedUrl.trim()}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 rounded text-sm"
          >
            Add Feed
          </button>
        </div>
      </div>

      {/* Alerts */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Alerts</h2>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded text-sm text-white px-2 py-1"
            >
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            {alerts.length > 0 && (
              <button onClick={handleClearAll} className="text-red-400 hover:text-red-300 text-sm">
                Clear All
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="text-gray-400 text-center py-8">Loading...</div>
        ) : alerts.length === 0 ? (
          <div className="text-gray-400 text-center py-8">No alerts yet. Enable the service and add RSS feeds to start monitoring.</div>
        ) : (
          <div className="space-y-3">
            {alerts.map(alert => (
              <div
                key={alert.id}
                className={`rounded-lg p-4 border ${SEVERITY_COLORS[alert.severity] || SEVERITY_COLORS.info} ${alert.dismissed ? 'opacity-50' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${SEVERITY_BADGES[alert.severity] || SEVERITY_BADGES.info}`}>
                        {alert.severity?.toUpperCase()}
                      </span>
                      {alert.category && alert.category !== 'unknown' && (
                        <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">
                          {alert.category.replace(/_/g, ' ')}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">{alert.source}</span>
                      <span className="text-xs text-gray-500">{formatTime(alert.publishedAt)}</span>
                    </div>
                    <h3 className="font-medium mb-1">
                      {alert.sourceUrl ? (
                        <a href={alert.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {alert.title}
                        </a>
                      ) : alert.title}
                    </h3>
                    {alert.summary && <p className="text-sm opacity-80 mb-1">{alert.summary}</p>}
                    {alert.suggestedAction && (
                      <p className="text-sm font-medium mt-1">Action: {alert.suggestedAction}</p>
                    )}
                    {alert.matchedKeywords?.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {alert.matchedKeywords.map((kw, i) => (
                          <span key={i} className="px-1.5 py-0.5 bg-gray-700/50 rounded text-xs text-gray-400">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {!alert.dismissed && (
                    <button
                      onClick={() => handleDismiss(alert.id)}
                      className="text-gray-400 hover:text-white text-sm shrink-0"
                      title="Dismiss"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
