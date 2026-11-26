import ConfirmDialog from '../ui/ConfirmDialog'
import NumberInput from '../ui/NumberInput'
import Button from '../ui/Button'
import { useState, useEffect, useCallback, useRef } from 'react'
import useRealtimeRefresh from '../../hooks/useRealtimeRefresh'
import { getRealtimeClient } from '../../lib/realtime'
import { apiGet, apiPost, apiPut, apiDelete, describeMutationFailure } from '../../utils/apiClient'
import { useNotify } from '../useToast'

const ROOM = 'arbitrage'
// Bumped with the gateway's ARBITRAGE_DASHBOARD_VERSION whenever the page and
// the API change together, so a stale admin build says so instead of quietly
// rendering the old table.
const DASHBOARD_VERSION = 4
const EVENTS = ['arbitrage:status', 'arbitrage:alert']

const fmtUsd = (value, digits = 0) => Number.isFinite(value)
  ? `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  : '-'
const fmtPrice = (value) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 2 : 6 })
  : '-'
const fmtBps = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('en-US')} bps` : '-'
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : '-'
const fmtDuration = (from, to) => {
  const ms = Date.parse(to) - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Colored by the executable edge (bid/ask through real depth, fees on every
// leg), never by mid: a wide book's mid can look 28% rich while its bid loses.
const edgeClass = (pair, alertBps) => {
  if (pair.priceBasis !== 'executable') return 'text-gray-400'
  if (!Number.isFinite(pair.edgeBps)) return 'text-gray-400'
  if (pair.edgeBps >= alertBps) return 'text-green-300 font-semibold'
  if (pair.edgeBps > 0) return 'text-yellow-300'
  return 'text-gray-300'
}
const fmtSpread = (bps) => Number.isFinite(bps) ? `${(bps / 100).toFixed(bps < 10 ? 3 : 2)}%` : '-'
const fmtCompactUsd = (value) => {
  if (!Number.isFinite(value)) return '-'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`
  return `$${Math.round(value)}`
}

const SOURCE_LABELS = {
  home: 'home',
  parity: '1:1',
  venue: 'on venue',
  external: 'reference FX',
}

const SETTINGS_FIELDS = [
  { key: 'alertMinNetBps', label: 'Alert at net edge (bps, after fees)', step: 1 },
  { key: 'minAlertNotionalUsd', label: 'Minimum executable size ($)', step: 100 },
  { key: 'dislocationAlertBps', label: 'Watch-only alert (bps, pairs with no round trip)', step: 10 },
  { key: 'dislocationMaxSpreadBps', label: 'Watch-only max spread (bps)', step: 10 },
  { key: 'notionalUsd', label: 'Quote routes at ($)', step: 100 },
  { key: 'confirmPolls', label: 'Polls to confirm', step: 1 },
  { key: 'closeAfterPolls', label: 'Polls to close', step: 1 },
]

function useArbitrageSocketStatus() {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const socket = getRealtimeClient()
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    setConnected(socket.connected)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [])
  return connected
}

function OpportunityCard({ alert, onDismiss }) {
  const m = alert.current || {}
  const isOpportunity = alert.type === 'opportunity'
  const open = alert.status === 'open'
  const tone = isOpportunity
    ? (open ? 'border-green-600 bg-green-900/30' : 'border-gray-700 bg-gray-900/40')
    : (open ? 'border-yellow-700 bg-yellow-900/20' : 'border-gray-700 bg-gray-900/40')
  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded-sm ${isOpportunity ? 'bg-green-700 text-white' : 'bg-yellow-700 text-black'}`}>
              {isOpportunity ? 'Opportunity' : 'Dislocation'}
            </span>
            <span className="text-white font-semibold">{alert.venueLabel}</span>
            <span className="text-gray-300">{alert.pair}</span>
            {!open && <span className="text-xs text-gray-400">closed</span>}
          </div>
          {isOpportunity ? (
            <p className="mt-1 text-sm text-gray-200">
              Buy BTC via <b>{m.buyPair}</b>, sell via <b>{m.sellPair}</b>
              {Array.isArray(m.legs) && <span className="text-gray-400"> ({m.legs.map(l => `${l.from}→${l.to}`).join(', ')})</span>}
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-200">
              Watch only: this pair cannot round-trip on {alert.venueLabel} (no on-venue {String(alert.pair).split('/')[1]} conversion), so the edge uses reference FX.
            </p>
          )}
        </div>
        {!alert.dismissed && (
          <Button onClick={() => onDismiss(alert.id)} variant="quiet" size="xs" touchTarget="always" className="shrink-0">Dismiss</Button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
        {isOpportunity ? (
          <>
            <div><span className="text-gray-400">Net edge </span><span className="text-green-300 font-semibold">{fmtBps(m.netBps)}</span></div>
            <div><span className="text-gray-400">Est. profit </span><span className="text-white">{fmtUsd(m.profitUsd)}</span><span className="text-gray-400"> at {fmtUsd(m.notionalUsd)}</span></div>
            <div><span className="text-gray-400">Profitable up to </span><span className="text-white">{fmtUsd(m.largestProfitableUsd)}</span></div>
            <div><span className="text-gray-400">Peak </span><span className="text-white">{fmtBps(alert.peak?.netBps)} / {fmtUsd(alert.peak?.profitUsd)}</span></div>
          </>
        ) : (
          <>
            <div><span className="text-gray-400">Top-of-book edge </span><span className="text-yellow-300 font-semibold">{fmtBps(m.edgeBps ?? m.deviationBps)}</span>{m.edgeSide && <span className="text-gray-400"> ({m.edgeSide} here)</span>}</div>
            <div><span className="text-gray-400">Top of book </span><span className="text-white">{fmtCompactUsd(m.topBidHome)} bid / {fmtCompactUsd(m.topAskHome)} ask</span></div>
            <div><span className="text-gray-400">Spread </span><span className="text-white">{fmtBps(m.spreadBps)}</span></div>
            <div><span className="text-gray-400">Peak </span><span className="text-white">{fmtBps(alert.peak?.edgeBps ?? alert.peak?.deviationBps)}</span></div>
          </>
        )}
      </div>
      <div className="mt-1 text-xs text-gray-400">
        Opened {fmtTime(alert.openedAt)} · lasted {fmtDuration(alert.openedAt, alert.closedAt || alert.lastSeenAt)} · {alert.polls} polls
      </div>
    </div>
  )
}

function VenueCard({ venue, status, alertBps }) {
  const analysis = venue?.analysis
  const topRoute = analysis?.routes?.[0]
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-white font-semibold">{status.label}</h3>
        <div className="text-xs text-gray-400 flex flex-wrap gap-x-3">
          <span>Fee {status.takerFeeBps} bps/leg</span>
          {analysis && <span>Reference {fmtUsd(analysis.medianImplied)}</span>}
          {status.at && <span>{fmtTime(status.at)}</span>}
        </div>
      </div>
      {!status.enabled && <p className="text-sm text-gray-400">Not monitored.</p>}
      {status.enabled && status.ok === false && <p role="alert" className="text-sm text-red-300">Unavailable: {status.error}</p>}
      {status.enabled && !venue && status.ok === null && <p className="text-sm text-gray-400">Waiting for the first poll.</p>}
      {analysis && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="py-1 pr-3 font-normal">Pair</th>
                  <th className="py-1 pr-3 font-normal text-right" title="Best ask, in the pair's quote currency: what a market buy pays first">Market buy (ask)</th>
                  <th className="py-1 pr-3 font-normal text-right" title="Best bid, in the pair's quote currency: what a market sell gets first">Market sell (bid)</th>
                  <th className="py-1 pr-3 font-normal text-right" title="(ask - bid) / mid">Spread</th>
                  <th className="py-1 pr-3 font-normal text-right" title={`Size available at the best price, in ${analysis.home}`}>Size at buy / sell</th>
                  <th className="py-1 pr-3 font-normal text-right" title="Best of: sell here and buy back on another pair, or buy here and sell on another pair. Real depth, taker fee on every leg.">Exec. edge</th>
                  <th className="py-1 font-normal">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {analysis.pairs.map(p => {
                  const indicative = p.priceBasis !== 'executable'
                  return (
                    <tr key={p.symbol} className={`border-b border-gray-800 ${indicative ? 'opacity-60' : ''}`}>
                      <td className="py-1 pr-3 text-white whitespace-nowrap">
                        {p.pair}
                        {indicative && <span className="ml-1 text-xs px-1 py-0.5 rounded-sm bg-gray-700 text-gray-300" title="No on-venue conversion back to the home currency, so this pair cannot complete a round trip here.">no round trip</span>}
                      </td>
                      <td className="py-1 pr-3 text-right text-gray-300 tabular-nums">{fmtPrice(p.ask)}</td>
                      <td className="py-1 pr-3 text-right text-gray-300 tabular-nums">{fmtPrice(p.bid)}</td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${p.spreadBps > 100 ? 'text-yellow-300' : 'text-gray-300'}`}>{fmtSpread(p.spreadBps)}</td>
                      <td className="py-1 pr-3 text-right text-gray-300 tabular-nums whitespace-nowrap">{fmtCompactUsd(p.topAskHome)} / {fmtCompactUsd(p.topBidHome)}</td>
                      <td className={`py-1 pr-3 text-right tabular-nums whitespace-nowrap ${edgeClass(p, alertBps)}`}>
                        {fmtBps(p.edgeBps)}{p.edgeSide && Number.isFinite(p.edgeBps) && p.edgeBps > 0 ? ` ${p.edgeSide}` : ''}{p.depthLimited ? '*' : ''}
                      </td>
                      <td className="py-1 text-xs text-gray-400 whitespace-nowrap">
                        {SOURCE_LABELS[p.conversionSource] || 'none'}{p.conversionPath?.length ? ` (${p.conversionPath.join(' → ')})` : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {analysis.unconvertible?.length > 0 && (
            <p className="mt-2 text-xs text-gray-400">No on-venue conversion for {analysis.unconvertible.join(', ')}: priced from top of book at reference FX, watch only, never an opportunity.</p>
          )}
          {analysis.pairs.some(p => p.depthLimited) && (
            <p className="mt-1 text-xs text-gray-400">* The order book ran out before the quoted size.</p>
          )}
          {venue.failedBooks?.length > 0 && (
            <p className="mt-1 text-xs text-yellow-300">{venue.failedBooks.length} order book(s) failed to load this poll.</p>
          )}
          {topRoute && (
            <p className="mt-2 text-xs text-gray-300">
              Best loop: buy via {topRoute.buyPair}, sell via {topRoute.sellPair}: <span className={topRoute.atNotional.netBps > 0 ? 'text-green-300' : 'text-gray-400'}>{fmtBps(topRoute.atNotional.netBps)}</span> net at {fmtUsd(analysis.notionalUsd)} (gross {fmtBps(topRoute.grossBps)})
            </p>
          )}
        </>
      )}
    </div>
  )
}

export default function ArbitrageDashboard() {
  const connected = useArbitrageSocketStatus()
  const notify = useNotify()
  const [status, setStatus] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [alerts, setAlerts] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [polling, setPolling] = useState(false)
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
  const clearingHistoryRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(null)
  const [showDismissed, setShowDismissed] = useState(false)

  const refresh = useCallback(async () => {
    const [s, snap, list] = await Promise.all([
      apiGet('/api/arbitrage/status'),
      apiGet('/api/arbitrage/snapshot'),
      apiGet('/api/arbitrage/alerts?limit=200'),
    ])
    if (!s.ok || !snap.ok || !list.ok) {
      setLoadError('Could not load the arbitrage monitor.')
      return
    }
    setLoadError(null)
    setStatus(s.data)
    setSnapshot(snap.data)
    setAlerts(Array.isArray(list.data?.items) ? list.data.items : [])
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useRealtimeRefresh({ events: EVENTS, rooms: [ROOM], minIntervalMs: 2000, onRefresh: refresh })

  const config = status?.config
  useEffect(() => {
    if (config && !draft) setDraft(JSON.parse(JSON.stringify(config)))
  }, [config, draft])

  const save = async (updates, { resetDraft = false } = {}) => {
    setSaving(true)
    try {
      const result = await apiPut('/api/arbitrage/config', updates)
      if (!result.ok) {
        const errors = result.data?.errors
        notify('error', Array.isArray(errors) ? errors.join(', ') : describeMutationFailure(result, 'Could not save settings'))
        return
      }
      if (resetDraft) setDraft(null)
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const handlePoll = async () => {
    setPolling(true)
    try {
      const result = await apiPost('/api/arbitrage/poll')
      if (!result.ok) notify('error', describeMutationFailure(result, 'Poll failed'))
      await refresh()
    } finally {
      setPolling(false)
    }
  }

  const handleDismiss = async (id) => {
    const result = await apiPost(`/api/arbitrage/dismiss/${encodeURIComponent(id)}`)
    if (!result.ok) notify('error', describeMutationFailure(result, 'Could not dismiss'))
    await refresh()
  }

  const handleClearHistory = async () => {
    if (clearingHistoryRef.current) return
    clearingHistoryRef.current = true
    setClearingHistory(true)
    try {
      const result = await apiDelete('/api/arbitrage/alerts')
      if (!result.ok) {
        notify('error', describeMutationFailure(result, 'Could not clear history'))
        return
      }
      setClearHistoryOpen(false)
      await refresh()
    } finally {
      clearingHistoryRef.current = false
      setClearingHistory(false)
    }
  }

  const handleSaveSettings = () => {
    if (!draft || !config) return
    const updates = {}
    for (const { key } of SETTINGS_FIELDS) {
      if (draft[key] !== config[key]) updates[key] = Number(draft[key])
    }
    const pollMs = Math.round(Number(draft.pollIntervalMs))
    if (pollMs !== config.pollIntervalMs) updates.pollIntervalMs = pollMs
    const venues = {}
    for (const [id, v] of Object.entries(draft.venues || {})) {
      const current = config.venues?.[id] || {}
      const patch = {}
      if (v.enabled !== current.enabled) patch.enabled = v.enabled
      if (Number(v.takerFeeBps) !== current.takerFeeBps) patch.takerFeeBps = Number(v.takerFeeBps)
      if (Object.keys(patch).length) venues[id] = patch
    }
    if (Object.keys(venues).length) updates.venues = venues
    if (!Object.keys(updates).length) return
    save(updates, { resetDraft: true })
  }

  // Dismissed alerts drop out of both lists; one collapsed toggle brings them back.
  const visible = (alerts || []).filter(a => !a.dismissed)
  const dismissed = (alerts || []).filter(a => a.dismissed)
  const openAlerts = visible.filter(a => a.status === 'open')
  const openOpportunities = openAlerts.filter(a => a.type === 'opportunity')
  const openDislocations = openAlerts.filter(a => a.type === 'dislocation')
  const history = visible.filter(a => a.status !== 'open')
  const enabled = Boolean(config?.enabled)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Arbitrage Monitor</h1>
          <p className="text-sm text-gray-400">Same-exchange BTC price slippage across currency pairs, from public order books. Alerts only: nothing here places orders.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>

      {status?.dashboardVersion > DASHBOARD_VERSION && (
        <div role="alert" className="rounded-lg border border-yellow-700 bg-yellow-900/30 p-3 text-sm text-yellow-200">
          This page is older than the gateway. Rebuild the admin UI (<code>npm run build</code>, or <code>docker compose up -d --build</code> for Docker) and reload.
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm text-red-400">
          <span>{loadError}</span>
          <Button onClick={refresh} variant="secondary" size="compact" touchTarget="always">Retry</Button>
        </div>
      )}

      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status?.running ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className={status?.running ? 'text-green-400' : 'text-gray-400'}>
              {!status ? 'Loading...' : !enabled ? 'Disabled' : status.running ? 'Monitoring' : 'Stopped'}
            </span>
          </div>
          {status && (
            <div className="text-sm text-gray-400 flex flex-wrap gap-x-4">
              <span>Polls: {status.pollCount}</span>
              <span>Last poll: {fmtTime(status.lastPollAt)}</span>
              <span>Open opportunities: <span className={status.openOpportunities ? 'text-green-300 font-semibold' : ''}>{status.openOpportunities}</span></span>
              {status.referenceFx?.enabled && <span>Reference FX: {status.referenceFx.error ? 'unavailable' : fmtTime(status.referenceFx.fetchedAt)}</span>}
            </div>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button onClick={handlePoll} disabled={!enabled || polling} variant="primary" size="compact" touchTarget="always">
              {polling ? 'Polling...' : 'Poll now'}
            </Button>
            <Button onClick={() => save({ enabled: !enabled })} disabled={!config || saving} variant={enabled ? 'warning' : 'success'} size="compact" touchTarget="always">
              {enabled ? 'Disable monitor' : 'Enable monitor'}
            </Button>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Open opportunities</h2>
        {alerts && openOpportunities.length === 0 && <p className="text-sm text-gray-400">No executable cross-pair opportunities right now.</p>}
        {openOpportunities.map(a => <OpportunityCard key={a.id} alert={a} onDismiss={handleDismiss} />)}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Venues</h2>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {(status?.venues || []).map(v => (
            <VenueCard key={v.id} status={v} venue={snapshot?.venues?.[v.id]} alertBps={config?.alertMinNetBps ?? 50} />
          ))}
        </div>
      </section>

      {openDislocations.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-300">Watch only ({openDislocations.length})</h2>
          <p className="text-xs text-gray-400">Pairs with no round trip on their exchange whose book is still tight. Informational, not actionable.</p>
          {openDislocations.map(a => <OpportunityCard key={a.id} alert={a} onDismiss={handleDismiss} />)}
        </section>
      )}

      {draft && (
        <section className="bg-gray-800 rounded-lg p-4 border border-gray-700 space-y-4">
          <h2 className="text-lg font-semibold text-white">Alert settings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {SETTINGS_FIELDS.map(({ key, label, step }) => (
              <label key={key} className="text-sm text-gray-300 flex flex-col gap-1">
                {label}
                <input type="number" step={step} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}
                  className="px-2 py-1.5 bg-gray-900 border border-gray-600 rounded-sm text-white" />
              </label>
            ))}
            <label className="text-sm text-gray-300 flex flex-col gap-1">
              Poll every (seconds)
              <NumberInput step={5} value={Math.round(Number(draft.pollIntervalMs) / 1000)} onChange={value => setDraft(prev => ({ ...prev, pollIntervalMs: value * 1000 }))}
                className="px-2 py-1.5 bg-gray-900 border border-gray-600 rounded-sm text-white" />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {Object.entries(draft.venues || {}).map(([id, v]) => (
              <div key={id} className="bg-gray-900/50 rounded-sm p-2 text-sm text-gray-300 space-y-1">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={Boolean(v.enabled)} onChange={e => setDraft({ ...draft, venues: { ...draft.venues, [id]: { ...v, enabled: e.target.checked } } })} />
                  <span className="text-white">{status?.venues?.find(s => s.id === id)?.label || id}</span>
                </label>
                <label className="flex items-center gap-2">
                  Taker fee (bps)
                  <input type="number" step={1} value={v.takerFeeBps} onChange={e => setDraft({ ...draft, venues: { ...draft.venues, [id]: { ...v, takerFeeBps: e.target.value } } })}
                    className="w-20 px-2 py-1 bg-gray-900 border border-gray-600 rounded-sm text-white" />
                </label>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400">Net edges subtract the taker fee on every leg (FX, buy, sell). Set your own fee tier so alerts match what you would pay. Kraken is read from public data only; it is not a trading venue here.</p>
          <div className="flex gap-2">
            <Button onClick={handleSaveSettings} disabled={saving} variant="primary" size="compact" touchTarget="always">{saving ? 'Saving...' : 'Save settings'}</Button>
            <Button onClick={() => setDraft(null)} disabled={saving} variant="secondary" size="compact" touchTarget="always">Reset</Button>
          </div>
        </section>
      )}

      {clearHistoryOpen && (
        <ConfirmDialog
          title="Clear Alert History"
          description="Permanently remove historical arbitrage alerts? Open alerts will remain."
          confirmLabel="Clear History"
          busyLabel="Clearing…"
          touchTarget="always"
          busy={clearingHistory}
          onConfirm={handleClearHistory}
          onClose={() => setClearHistoryOpen(false)}
        />
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">History</h2>
          {history.length + dismissed.filter(a => a.status !== 'open').length > 0 && <Button onClick={() => setClearHistoryOpen(true)} disabled={clearingHistory} variant="quiet-danger" size="xs" touchTarget="always">Clear history</Button>}
        </div>
        {alerts && history.length === 0 && <p className="text-sm text-gray-400">No closed alerts yet.</p>}
        {history.map(a => <OpportunityCard key={a.id} alert={a} onDismiss={handleDismiss} />)}
      </section>

      {dismissed.length > 0 && (
        <section className="space-y-3">
          <Button onClick={() => setShowDismissed(v => !v)} aria-expanded={showDismissed} variant="quiet" size="xs" touchTarget="always">
            {showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed {dismissed.length === 1 ? 'alert' : 'alerts'}
          </Button>
          {showDismissed && dismissed.map(a => <OpportunityCard key={a.id} alert={a} onDismiss={handleDismiss} />)}
        </section>
      )}
    </div>
  )
}
