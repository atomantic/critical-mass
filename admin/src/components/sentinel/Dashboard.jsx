import Button from '../ui/Button'
import { useState, useEffect, useCallback, useRef } from 'react'
import DestructiveConfirmation from '../DestructiveConfirmation'
import useSentinelSocket from '../../hooks/useSentinelSocket'
import { createRequestOwner } from '../../utils/requestOwner.mjs'
import { completePagedItems } from '../../utils/pagedList.mjs'
import { apiGet, apiPost, apiPut, apiDelete } from '../../utils/apiClient'
import usePolling from '../../hooks/usePolling'
import { useNotify } from '../Toast'

const TOUCH_BTN = 'min-h-11 min-w-11 shrink-0 inline-flex items-center justify-center'

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
  const [statusError, setStatusError] = useState(null)
  // The alert list remembers which filter it answers, so a filter switch never
  // shows the previous filter's alerts (or a failed read) as the new selection.
  const [alertsView, setAlertsView] = useState(null)
  const [alertsError, setAlertsError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [polling, setPolling] = useState(false)
  const notify = useNotify()
  const [feedWritePending, setFeedWritePending] = useState(false)
  const feedWriteLock = useRef(false)
  const configRevision = useRef(0)
  // The poll, socket alerts, filter switches and post-action refreshes overlap;
  // only the newest read of each snapshot may commit.
  const [statusOwner] = useState(createRequestOwner)
  const [alertsOwner] = useState(createRequestOwner)
  const alerts = alertsView?.filter === filter ? alertsView.alerts : null

  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState('')

  // New feed form
  const [newFeedName, setNewFeedName] = useState('')
  const [newFeedUrl, setNewFeedUrl] = useState('')

  const fetchStatus = useCallback(async () => {
    const revision = configRevision.current
    const { owned, data } = await statusOwner.read('/api/sentinel/status')
    if (!owned) return
    if (!data?.config) {
      setStatusError('Could not load Sentinel status.')
      return
    }
    setStatusError(null)
    if (revision === configRevision.current) setStatus(data)
  }, [statusOwner])

  const fetchAlerts = useCallback(async () => {
    const url = filter !== 'all' ? `/api/sentinel/alerts?severity=${filter}` : '/api/sentinel/alerts'
    const { token, signal, data } = await alertsOwner.read(url)
    if (!alertsOwner.owns(token)) return
    if (!Array.isArray(data?.items)) {
      setAlertsError('Could not load alerts.')
      return
    }
    let items
    try {
      items = await completePagedItems(url, data, { signal })
    } catch {
      if (alertsOwner.owns(token)) setAlertsError('Could not load alerts.')
      return
    }
    if (!alertsOwner.owns(token)) return
    setAlertsError(null)
    setAlertsView({ filter, alerts: items })
  }, [filter, alertsOwner])

  // `throwOnError` lets a confirmation dialog own the failure message instead of a toast.
  const request = async (label, send, { throwOnError = false } = {}) => {
    const result = await send()
    if (result.ok) return result.data || true
    // Validation replies carry an `errors` list rather than a single `error`.
    const errors = result.data?.errors
    const detail = result.data?.error ? result.error
      : (Array.isArray(errors) ? errors.join(', ') : errors) || result.error
    const message = `${label}: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`
    if (throwOnError) throw new Error(message)
    notify('error', message)
    return false
  }

  useEffect(() => {
    setAlertsError(null)
  }, [fetchStatus, fetchAlerts, statusOwner, alertsOwner])
  usePolling(() => { fetchStatus(); fetchAlerts() }, 15000, {
    deps: [fetchStatus, fetchAlerts, statusOwner, alertsOwner],
    onCleanup: () => {
      statusOwner.invalidate()
      alertsOwner.invalidate()
    },
  })

  // Re-fetch alerts when new alert arrives via socket (status comes via socket already)
  useEffect(() => {
    if (latestAlert) {
      fetchAlerts()
    }
  }, [latestAlert, fetchAlerts])

  const handleForcePoll = async () => {
    setPolling(true)
    try {
      if (await request('Could not poll feeds', () => apiPost('/api/sentinel/poll'))) {
        await fetchAlerts()
        await fetchStatus()
      }
    } finally {
      setPolling(false)
    }
  }

  const handleDismiss = async (alertId) => {
    if (await request('Could not dismiss alert', () => apiPost(`/api/sentinel/dismiss/${alertId}`))) {
      setAlertsView(prev => prev && { ...prev, alerts: prev.alerts.map(a => a.id === alertId ? { ...a, dismissed: true } : a) })
      fetchStatus()
    }
  }

  const handleClearAll = async () => {
    await request('Could not clear alerts', () => apiDelete('/api/sentinel/alerts'), { throwOnError: true })
    alertsOwner.invalidate()
    setAlertsView({ filter, alerts: [] })
    fetchStatus()
  }

  const handleToggleEnabled = async () => {
    if (feedWriteLock.current) return
    const newEnabled = !status?.config?.enabled
    feedWriteLock.current = true
    setFeedWritePending(true)
    try {
      const result = await request('Could not update Sentinel settings', () => apiPut('/api/sentinel/config', { enabled: newEnabled }))
      if (result) {
        configRevision.current += 1
        setStatus(prev => ({ ...(prev || {}), config: { ...(prev?.config || {}), ...(result.config || {}), enabled: newEnabled } }))
        await fetchStatus()
      }
    } finally {
      feedWriteLock.current = false
      setFeedWritePending(false)
    }
  }

  const handleStart = async () => {
    if (await request('Could not start Sentinel', () => apiPost('/api/sentinel/start'))) await fetchStatus()
  }

  const handleStop = async () => {
    if (await request('Could not stop Sentinel', () => apiPost('/api/sentinel/stop'))) await fetchStatus()
  }

  const updateFeeds = async (feeds, options) => {
    if (feedWriteLock.current) return false
    feedWriteLock.current = true
    setFeedWritePending(true)
    try {
      const result = await request('Could not update feeds', () => apiPut('/api/sentinel/config', { feeds }), options)
      if (result) {
        configRevision.current += 1
        setStatus(prev => ({ ...(prev || {}), config: { ...(prev?.config || {}), ...(result.config || {}), feeds } }))
        await fetchStatus()
      }
      return Boolean(result)
    } finally {
      feedWriteLock.current = false
      setFeedWritePending(false)
    }
  }

  const handleAddFeed = async () => {
    // Feeds are saved as a whole list; without the loaded list this would
    // replace every configured feed with the new one.
    if (!status?.config || !newFeedName.trim() || !newFeedUrl.trim()) return
    if (await updateFeeds([...(status?.config?.feeds || []), { name: newFeedName.trim(), url: newFeedUrl.trim(), enabled: true }])) {
      setNewFeedName('')
      setNewFeedUrl('')
    }
  }

  const handleToggleFeed = async (index) => {
    if (feedWriteLock.current) return
    const feeds = [...(status?.config?.feeds || [])]
    if (!feeds[index]) return
    feeds[index] = { ...feeds[index], enabled: !feeds[index].enabled }
    await updateFeeds(feeds)
  }

  const handleRemoveFeed = async () => {
    const feeds = status?.config?.feeds || []
    const index = feeds.findIndex(feed => feed.name === confirmation.feed.name && feed.url === confirmation.feed.url)
    if (index < 0) throw new Error('This feed has changed. Cancel and try again.')
    if (!(await updateFeeds(feeds.filter((_, i) => i !== index), { throwOnError: true }))) throw new Error('Feeds are being saved. Please try again.')
  }

  const requestClearAll = async () => {
    setConfirmationError('')
    // Clear deletes every severity, so count the unfiltered collection.
    try {
      const { ok, data } = await apiGet('/api/sentinel/alerts')
      if (!ok) throw new Error('Unable to load alerts. Please try again.')
      const all = await completePagedItems('/api/sentinel/alerts', data)
      setConfirmation({ kind: 'alerts', count: all.length, active: all.filter(alert => !alert.dismissed).length })
    } catch {
      setConfirmationError('Unable to load alerts. Please try again before clearing them.')
    }
  }

  const serviceEnabled = !!status?.config?.enabled
  const stateLabel = !status
    ? (statusError ? 'Status unavailable' : 'Loading...')
    : !serviceEnabled
    ? 'Disabled'
    : status?.feedState === 'no-feeds'
      ? 'Enabled — no feeds configured'
      : status?.running ? 'Running' : 'Stopped'

  const formatTime = (ts) => {
    if (!ts) return '-'
    const d = new Date(ts)
    return d.toLocaleString()
  }

  return (
    <div className="space-y-6">
      {confirmation && (
        <DestructiveConfirmation
          title={confirmation.kind === 'feed' ? `Remove feed "${confirmation.feed.name}"?` : `Clear all ${confirmation.count} ${confirmation.count === 1 ? 'alert' : 'alerts'}?`}
          confirmLabel={confirmation.kind === 'feed' ? 'Remove feed' : 'Clear alerts'}
          onClose={() => setConfirmation(null)}
          onConfirm={confirmation.kind === 'feed' ? handleRemoveFeed : handleClearAll}
        >
          {confirmation.kind === 'feed' ? `The saved feed ${confirmation.feed.name} (${confirmation.feed.url}) will be removed. This cannot be undone.` : `${confirmation.count} ${confirmation.count === 1 ? 'alert' : 'alerts'} will be permanently deleted, including ${confirmation.active} undismissed. This cannot be undone.`}
        </DestructiveConfirmation>
      )}
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
              {stateLabel}
            </span>
          </div>

          {status && (
            <div className="text-sm text-gray-400 space-x-4">
              <span>Polls: {status.pollCount || 0}</span>
              <span>Alerts: {status.totalAlerts || 0}</span>
              <span>Active: {status.activeAlerts || 0}</span>
              <span>Last poll: {formatTime(status.lastPollAt)}</span>
              <span>Last successful fetch: {formatTime(status.lastSuccessfulFetchAt)}</span>
            </div>
          )}

          {(status?.feedState === 'unavailable' || status?.feedState === 'degraded') && (
            <span className={`text-sm px-2 py-0.5 rounded-sm ${status.feedState === 'unavailable' ? 'bg-red-900 text-red-200' : 'bg-yellow-900 text-yellow-200'}`}>
              {status.feedState === 'unavailable' ? 'Feeds unavailable' : 'Feeds degraded'}: {status.failedFeeds}/{status.enabledFeeds} failed
            </span>
          )}

          <div className="ml-auto flex flex-wrap gap-2">
            {status?.running ? (
              <Button onClick={handleStop} variant="destructive" size="compact" touchTarget="always" className="shrink-0">
                Stop
              </Button>
            ) : (
              <Button
                onClick={handleStart}
                disabled={!serviceEnabled}
                title={serviceEnabled ? undefined : 'Enable the service first'}
                variant="success" size="compact" touchTarget="always" className="shrink-0"
              >
                Start
              </Button>
            )}
            <Button
              onClick={handleForcePoll}
              disabled={polling}
              variant="primary" size="compact" touchTarget="always" className="shrink-0"
            >
              {polling ? 'Polling...' : 'Force Poll'}
            </Button>
            <Button
              onClick={handleToggleEnabled}
              disabled={!status?.config || feedWritePending}
              variant={status?.config?.enabled ? 'warning' : 'secondary'} size="compact" touchTarget="always" className="shrink-0"
            >
              {serviceEnabled ? 'Disable service' : 'Enable service'}
            </Button>
          </div>
        </div>
        {statusError && (
          <div role="alert" className="mt-3 flex items-center justify-between gap-2 text-sm text-red-400">
            <span>{status ? `${statusError} Showing the last loaded status.` : statusError}</span>
            <Button onClick={fetchStatus} variant="secondary" size="compact" touchTarget="always" className="shrink-0">
              Retry
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-gray-400">
          Enable turns the service on and saves that choice; Start/Stop runs or pauses polling now.
        </p>
      </div>

      {/* Feed Configuration */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h2 className="text-lg font-semibold text-white mb-3">RSS Feeds</h2>
        <div className="space-y-2 mb-4">
          {(status?.config?.feeds || []).map((feed, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-gray-900/50 rounded-sm p-2">
              <button
                role="switch"
                aria-checked={feed.enabled}
                aria-label={`Enable ${feed.name} feed`}
                onClick={() => handleToggleFeed(i)}
                disabled={feedWritePending}
                className={`${TOUCH_BTN}`}
              >
                <span className={`block w-8 h-5 rounded-full relative transition-colors ${feed.enabled ? 'bg-green-600' : 'bg-gray-600'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${feed.enabled ? 'left-3.5' : 'left-0.5'}`} />
                </span>
              </button>
              <span className="text-sm text-white font-medium min-w-0 flex-1 sm:flex-none sm:min-w-[120px] wrap-break-word">{feed.name}</span>
              <span className="order-last basis-full sm:order-0 sm:basis-0 text-xs text-gray-400 truncate min-w-0 sm:flex-1">{feed.url}</span>
              <Button aria-label={`Remove ${feed.name} feed`} onClick={() => setConfirmation({ kind: 'feed', feed: { ...feed } })} disabled={feedWritePending} variant="quiet-danger" size="xs" touchTarget="always" className="shrink-0">Remove</Button>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            aria-label="Feed name"
            type="text"
            value={newFeedName}
            onChange={e => setNewFeedName(e.target.value)}
            placeholder="Feed name"
            className="px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-sm text-sm text-white w-full min-w-0 sm:w-40"
          />
          <input
            aria-label="RSS feed URL"
            type="text"
            value={newFeedUrl}
            onChange={e => setNewFeedUrl(e.target.value)}
            placeholder="RSS feed URL"
            className="px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-sm text-sm text-white w-full min-w-0 sm:flex-1"
          />
          <Button
            onClick={handleAddFeed}
            disabled={feedWritePending || !status?.config || !newFeedName.trim() || !newFeedUrl.trim()}
            variant="success" size="compact" touchTarget="always"
          >
            Add Feed
          </Button>
        </div>
      </div>

      {confirmationError && <p role="alert" className="text-red-300">{confirmationError}</p>}

      {/* Alerts */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Alerts</h2>
          <div className="flex items-center gap-2">
            <select
              aria-label="Alert filter"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded-sm text-sm text-white px-2 py-1"
            >
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            {alerts?.length > 0 && (
              <Button onClick={requestClearAll} variant="quiet-danger" size="xs" touchTarget="always" className="shrink-0">
                Clear all alerts
              </Button>
            )}
          </div>
        </div>

        {alertsError && (
          <div role="alert" className="flex items-center justify-between gap-2 mb-3 text-sm text-red-400">
            <span>{alerts ? `${alertsError} Showing the last loaded alerts.` : alertsError}</span>
            <Button onClick={fetchAlerts} variant="secondary" size="compact" touchTarget="always" className="shrink-0">
              Retry
            </Button>
          </div>
        )}
        {!alerts ? (
          !alertsError && <div className="text-gray-400 text-center py-8">Loading...</div>
        ) : alerts.length === 0 ? (
          <div className="text-gray-400 text-center py-8">No alerts yet. Enable the service, add at least one RSS feed, then Start.</div>
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
                      <span className={`px-2 py-0.5 rounded-sm text-xs font-bold ${SEVERITY_BADGES[alert.severity] || SEVERITY_BADGES.info}`}>
                        {alert.severity?.toUpperCase()}
                      </span>
                      {alert.category && alert.category !== 'unknown' && (
                        <span className="px-2 py-0.5 rounded-sm text-xs bg-gray-700 text-gray-300">
                          {alert.category.replace(/_/g, ' ')}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">{alert.source}</span>
                      <span className="text-xs text-gray-400">{formatTime(alert.publishedAt)}</span>
                    </div>
                    <h3 className="font-medium mb-1">
                      {/^https?:\/\//i.test(alert.sourceUrl || '') ? (
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
                          <span key={i} className="px-1.5 py-0.5 bg-gray-700/50 rounded-sm text-xs text-gray-400">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {!alert.dismissed && (
                    <Button
                      onClick={() => handleDismiss(alert.id)}
                      variant="quiet" size="xs" touchTarget="always" className="shrink-0"
                      title="Dismiss"
                    >
                      Dismiss
                    </Button>
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
