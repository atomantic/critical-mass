import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp, Crosshair, Brain, Loader2, Trash2 } from 'lucide-react'
import useKalshiSocket from '../../hooks/useKalshiSocket'
import useCoinbaseSocket from '../../hooks/useCoinbaseSocket'
import useCompositeSocket from '../../hooks/useCompositeSocket'
import usePolymarketSocket from '../../hooks/usePolymarketSocket'
import PerformanceCharts from './PerformanceCharts'
import LiveBTCChart from './LiveBTCChart'
import { parseStrikeFromTitle } from './LiveBTCChart'
import TopControlBar, { HeaderStatus } from './TopControlBar'
import TimePeriodSelector from './TimePeriodSelector'
import MarketSidebar from './MarketSidebar'

/**
 * Format a number as USD currency
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0)
}

/**
 * Format a dollar value as compact currency (e.g., "$1.2M", "$450K")
 * @param {number} value
 * @returns {string}
 */
const formatCompactCurrency = (value) => {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${Math.round(value)}`
}

/**
 * Format countdown as MM:SS
 * @param {number} seconds
 * @returns {string}
 */
const formatCountdown = (seconds) => {
  if (seconds <= 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Format a close_time into a human-readable time window like "Feb 15, 2:30-2:45 AM ET"
 * @param {string} closeTime - ISO timestamp
 * @returns {string}
 */
const formatTimeWindow = (closeTime, ticker) => {
  const close = new Date(closeTime)
  const dateStr = close.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const closeTimeStr = close.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  // Determine window duration from ticker pattern
  const upper = (ticker || '').toUpperCase()
  const windowMins = upper.includes('15M') ? 15
    : upper.includes('1H') ? 60
    : null // unknown -- just show settlement time

  if (windowMins) {
    const open = new Date(close.getTime() - windowMins * 60 * 1000)
    const openTime = open.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    return `${dateStr}, ${openTime}-${closeTimeStr} ET`
  }
  return `${dateStr}, settles ${closeTimeStr} ET`
}

/**
 * Strategy monitor showing real-time market analysis from the settlement sniper
 */
function StrategyMonitor({ diagnostics }) {
  if (!diagnostics?.length) return null

  const buckets = { primary: [], exit: [], scout: [], monitor: [], no_trade: [] }
  for (const d of diagnostics) {
    const bucket = buckets[d.window] ?? buckets.no_trade
    bucket.push(d)
  }

  const actionable = [...buckets.primary, ...buckets.exit, ...buckets.scout]
    .sort((a, b) => a.ttl - b.ttl)

  const windowColors = {
    primary: 'bg-green-500/20 text-green-400 border-green-500/30',
    exit: 'bg-red-500/20 text-red-400 border-red-500/30',
    scout: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }

  const formatTTL = (seconds) => {
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const formatPct = (val) => val != null ? `${(val * 100).toFixed(1)}%` : '---'
  const formatStrike = (strike) => strike ? `$${strike.toLocaleString()}` : '---'

  const monitorCount = buckets.monitor.length
  const expiredCount = buckets.no_trade.length

  const nextUp = [...buckets.scout, ...buckets.monitor]
    .filter(d => d.ttl > 0)
    .sort((a, b) => a.ttl - b.ttl)[0]

  return (
    <div className="bg-gray-800 rounded-lg p-3 md:p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Crosshair size={20} className="text-green-400" />
          <h3 className="text-base md:text-lg font-semibold">Strategy Monitor</h3>
        </div>
        <div className="flex items-center gap-2 md:gap-3 text-xs">
          {buckets.primary.length > 0 && (
            <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 font-medium">
              {buckets.primary.length} trading
            </span>
          )}
          {buckets.scout.length > 0 && (
            <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
              {buckets.scout.length} scouting
            </span>
          )}
          {monitorCount > 0 && (
            <span className="text-gray-500">{monitorCount} monitoring</span>
          )}
          {expiredCount > 0 && (
            <span className="text-gray-600">{expiredCount} settled</span>
          )}
        </div>
      </div>

      {actionable.length > 0 ? (
        <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0" style={{ WebkitOverflowScrolling: 'touch' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left text-xs border-b border-gray-700">
                <th className="pb-2 pr-3">Strike</th>
                <th className="pb-2 pr-3">TTL</th>
                <th className="pb-2 pr-3">Window</th>
                <th className="pb-2 pr-3">Vol</th>
                <th className="pb-2 pr-3">Fair</th>
                <th className="pb-2 pr-3">Market</th>
                <th className="pb-2 pr-3">Edge</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {actionable.map((d, i) => {
                const edgeVal = d.edge != null ? d.edge * 100 : null
                const edgeColor = edgeVal == null ? 'text-gray-500'
                  : Math.abs(edgeVal) >= 15 ? 'text-green-400 font-bold'
                  : Math.abs(edgeVal) >= 5 ? 'text-yellow-400'
                  : 'text-gray-400'
                const isEntry = d.status?.startsWith('ENTRY')

                return (
                  <tr key={`${d.ticker}-${i}`} className={`border-b border-gray-700/30 ${isEntry ? 'bg-green-900/20' : ''}`}>
                    <td className="py-1.5 pr-3 font-mono text-xs">{formatStrike(d.strike)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{formatTTL(d.ttl)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`px-1.5 py-0.5 rounded text-xs border ${windowColors[d.window] || 'bg-gray-700 text-gray-400'}`}>
                        {d.window}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-gray-300">
                      {d.vol != null ? `${(d.vol * 100).toFixed(0)}%` : '---'}
                      {d.volPoints > 0 && <span className="text-gray-600 ml-1">({d.volPoints})</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{formatPct(d.fairProb)}</td>
                    <td className="py-1.5 pr-3 text-xs">{formatPct(d.marketProb)}</td>
                    <td className={`py-1.5 pr-3 text-xs ${edgeColor}`}>
                      {edgeVal != null ? `${edgeVal >= 0 ? '+' : ''}${edgeVal.toFixed(1)}%` : '---'}
                    </td>
                    <td className="py-1.5 text-xs text-gray-400 max-w-[200px] truncate" title={d.status}>
                      {d.status}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : nextUp ? (
        <p className="text-sm text-gray-500">
          No markets in trading window. Next settlement in <span className="text-gray-300">{formatTTL(nextUp.ttl)}</span> ({formatStrike(nextUp.strike)})
        </p>
      ) : (
        <p className="text-sm text-gray-500">Waiting for markets to approach settlement window...</p>
      )}
    </div>
  )
}

/**
 * AI Strategy Review panel
 */
function AIReviewPanel({ review, reviewStatus }) {
  const [expanded, setExpanded] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [triggerError, setTriggerError] = useState(null)

  const handleTrigger = async () => {
    setTriggering(true)
    setTriggerError(null)
    const res = await fetch('/api/kalshi/review/trigger', { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (!data?.success) {
      setTriggering(false)
      setTriggerError(data?.reason || 'Failed to start review')
    }
    // On success, keep triggering=true until socket confirms running/complete/error
  }

  const isRunning = reviewStatus?.status === 'running' || triggering
  const hasError = reviewStatus?.status === 'error'

  // Clear triggering once socket confirms the review is running or finished
  useEffect(() => {
    if (reviewStatus?.status === 'running' || reviewStatus?.status === 'error') {
      setTriggering(false)
    }
  }, [reviewStatus?.status])

  // Clear triggering when a new review result arrives
  useEffect(() => {
    if (review) setTriggering(false)
  }, [review])

  // Auto-clear trigger error after 5s
  useEffect(() => {
    if (!triggerError) return
    const t = setTimeout(() => setTriggerError(null), 5000)
    return () => clearTimeout(t)
  }, [triggerError])

  return (
    <div className="bg-gray-800 rounded-lg p-3 md:p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Brain size={20} className="text-purple-400 shrink-0" />
          <h3 className="text-base md:text-lg font-semibold truncate">AI Strategy Review</h3>
          {isRunning && (
            <span className="flex items-center gap-1 text-xs text-purple-400">
              <Loader2 size={12} className="animate-spin" />
              Analyzing...
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {review && (
            <span className="text-[10px] md:text-xs text-gray-500 hidden md:inline">
              {new Date(review.timestamp).toLocaleString()} | {review.model}
            </span>
          )}
          <button
            onClick={handleTrigger}
            disabled={isRunning}
            className="px-3 py-2 min-h-[44px] md:min-h-0 md:py-1 text-xs bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 disabled:cursor-not-allowed rounded transition-colors"
          >
            {isRunning ? 'Running...' : 'Run Review'}
          </button>
        </div>
      </div>

      {(triggerError || hasError) && (
        <p className="text-red-400 text-sm mb-2">{triggerError || reviewStatus?.error || 'Review failed'}</p>
      )}

      {!review && !isRunning && !triggerError && !hasError && (
        <p className="text-gray-500 text-sm">No review yet. Click "Run Review" to trigger an AI analysis of your strategy performance.</p>
      )}

      {review?.content && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-300 mb-2"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Collapse' : 'Expand'} review ({review.content.length} chars, {(review.duration / 1000).toFixed(1)}s)
          </button>
          {expanded && (
            <div className="bg-gray-900 rounded p-4 text-sm text-gray-300 whitespace-pre-wrap max-h-96 overflow-y-auto leading-relaxed">
              {review.content}
            </div>
          )}
          {!expanded && (
            <div className="bg-gray-900 rounded p-3 text-sm text-gray-400 max-h-20 overflow-hidden relative">
              {review.content.slice(0, 300)}...
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-gray-900 to-transparent" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Log entry display component
 */
function LogEntry({ log }) {
  const time = new Date(log.timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  const typeConfig = {
    info: { icon: '\u2139\uFE0F', color: 'text-blue-400', bg: 'bg-blue-900/20' },
    eval: { icon: '\uD83D\uDD0D', color: 'text-gray-400', bg: 'bg-gray-700/30' },
    signal: { icon: '\uD83D\uDCCA', color: 'text-yellow-400', bg: 'bg-yellow-900/20' },
    trade: { icon: '\u2705', color: 'text-green-400', bg: 'bg-green-900/20' },
    error: { icon: '\u274C', color: 'text-red-400', bg: 'bg-red-900/20' }
  }

  const { icon, color, bg } = typeConfig[log.type] || typeConfig.info

  const evalDetails = log.type === 'eval' && log.data?.results?.length > 0
    ? log.data.results.map(r =>
        r.signalCount > 0
          ? `${r.strategy}: ${r.signals.map(s => `${s.action} ${s.side} ${s.ticker}`).join(', ')}`
          : `${r.strategy}: no signals`
      ).join(' | ')
    : null

  return (
    <div className={`p-2 rounded ${bg} flex gap-2`}>
      <span className="text-gray-500 shrink-0">{time}</span>
      <span className="shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className={color}>{log.message}</span>
        {evalDetails && (
          <div className="text-gray-500 truncate" title={evalDetails}>
            {evalDetails}
          </div>
        )}
        {log.type === 'signal' && log.data?.reason && (
          <div className="text-gray-500">
            {log.data.reason} ({(log.data.confidence * 100).toFixed(0)}% confidence)
          </div>
        )}
        {log.type === 'trade' && log.data?.pnl !== undefined && (
          <div className={log.data.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
            P&L: {formatCurrency(log.data.pnl)}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Order book imbalance indicator: shows bid/ask pressure as a colored bar
 */
function OrderBookImbalance({ imbalance }) {
  if (imbalance == null) return null

  // imbalance ranges [-1, 1]: positive = bid pressure (bullish), negative = ask pressure (bearish)
  const pct = Math.round(imbalance * 100)
  const color = imbalance > 0.1 ? 'text-green-400' : imbalance < -0.1 ? 'text-red-400' : 'text-gray-400'
  const barWidth = Math.min(Math.abs(pct), 100)
  const barColor = imbalance > 0 ? 'bg-green-500' : 'bg-red-500'

  return (
    <div className="flex items-center gap-1.5" title={`Order book imbalance: ${pct}%`}>
      <span className={`text-xs ${color}`}>OBI</span>
      <div className="w-16 h-2 bg-gray-700 rounded-full overflow-hidden relative">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-px h-full bg-gray-500" />
        </div>
        <div
          className={`h-full ${barColor} rounded-full absolute ${imbalance > 0 ? 'left-1/2' : 'right-1/2'}`}
          style={{ width: `${barWidth / 2}%` }}
        />
      </div>
      <span className={`text-xs font-mono ${color}`}>{pct > 0 ? '+' : ''}{pct}%</span>
    </div>
  )
}

/**
 * Polymarket 5-min windows within the current Kalshi 15-min window.
 * Shows 3 slots: settled results + live window with countdown.
 */
function PolymarketWindows({ sentiment, settledWindows, kalshiCloseTime }) {
  const [now, setNow] = useState(Date.now())

  // Tick every second so live countdown updates
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (!kalshiCloseTime) return null

  // Compute the 15-min window boundaries (Kalshi window closes at kalshiCloseTime)
  const closeTs = new Date(kalshiCloseTime).getTime()
  const openTs = closeTs - 15 * 60 * 1000

  // Three 5-min slots within this 15-min window
  const slots = [0, 1, 2].map(i => {
    const slotStart = Math.floor(openTs / 1000) + i * 300
    const slotEnd = slotStart + 300
    return { slotStart, slotEnd, index: i }
  })

  // Match settled windows and live sentiment to slots
  const slotData = slots.map(({ slotStart, slotEnd, index }) => {
    const settled = settledWindows.find(w => w.windowStart === slotStart)
    const isLive = sentiment?.windowStart === slotStart
    const startTime = new Date(slotStart * 1000).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true
    })
    const endTime = new Date(slotEnd * 1000).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true
    })
    return { slotStart, slotEnd, index, settled, isLive, startTime, endTime }
  })

  // Count settled Up vs Down for summary
  const settledCount = slotData.filter(s => s.settled).length
  const upCount = slotData.filter(s => s.settled?.result === 'up').length

  return (
    <div className="flex items-center gap-2">
      <div className="shrink-0 text-center">
        <div className="text-[10px] md:text-xs text-purple-400 font-medium">Polymarket</div>
        <div className="text-[10px] text-gray-500">5m crowd</div>
      </div>
      <div className="flex gap-1.5 flex-1 min-w-0">
        {slotData.map(({ index, settled, isLive, startTime, endTime }) => {
          // Settled window
          if (settled) {
            const isUp = settled.result === 'up'
            const pct = Math.round((isUp ? settled.finalUpPrice : settled.finalDownPrice) * 100)
            return (
              <div
                key={index}
                className={`flex-1 rounded px-2 py-2 md:py-1.5 text-center text-xs border min-h-[44px] ${
                  isUp
                    ? 'bg-green-900/40 border-green-700/40 text-green-400'
                    : 'bg-red-900/40 border-red-700/40 text-red-400'
                }`}
                title={`${startTime}-${endTime}: ${settled.result.toUpperCase()} (${pct}%)`}
              >
                <div className="font-semibold">{isUp ? '▲ Up' : '▼ Down'}</div>
                <div className="font-mono">{pct}%</div>
                <div className="text-[10px] opacity-60">{startTime}</div>
              </div>
            )
          }

          // Live window
          if (isLive && sentiment) {
            const isUp = sentiment.upPrice > sentiment.downPrice
            const upPct = Math.round(sentiment.upPrice * 100)
            const downPct = Math.round(sentiment.downPrice * 100)
            const remaining = Math.max(0, Math.round((sentiment.windowEnd * 1000 - now) / 1000))
            const mins = Math.floor(remaining / 60)
            const secs = remaining % 60

            return (
              <div
                key={index}
                className={`flex-1 rounded px-2 py-2 md:py-1.5 text-center text-xs border-2 min-h-[44px] ${
                  isUp
                    ? 'bg-green-900/30 border-green-500/50 text-green-400'
                    : 'bg-red-900/30 border-red-500/50 text-red-400'
                }`}
                title={`LIVE ${startTime}-${endTime}: Up ${upPct}% / Down ${downPct}%`}
              >
                <div className="font-bold">{isUp ? '▲ Up' : '▼ Down'}</div>
                <div className="font-mono">{isUp ? upPct : downPct}%</div>
                <div className="text-[10px] font-mono opacity-80">{mins}:{String(secs).padStart(2, '0')}</div>
              </div>
            )
          }

          // Future / no data
          return (
            <div
              key={index}
              className="flex-1 rounded px-2 py-1.5 text-center text-xs border border-gray-700/40 bg-gray-800/50 text-gray-600"
              title={`${startTime}-${endTime}: Pending`}
            >
              <div>---</div>
              <div className="text-[10px]">{startTime}</div>
            </div>
          )
        })}
      </div>
      {settledCount > 0 && (
        <div className="shrink-0 text-center text-[10px] text-gray-500">
          {upCount}/{settledCount} up
        </div>
      )}
    </div>
  )
}

/**
 * Settlement Windows table -- shows closed windows and live window
 */
function SettlementWindows({ socketSummaries, latestDiagnostics, compositePrice, timeLeft }) {
  const [fetchedSummaries, setFetchedSummaries] = useState([])

  useEffect(() => {
    fetch('/api/kalshi/engine/windows')
      .then(res => res.ok ? res.json() : { summaries: [] })
      .then(data => setFetchedSummaries(data.summaries || []))
      .catch(() => {})
  }, [])

  // Merge fetched + socket summaries, dedup by closeTime, newest first
  const allSummaries = useMemo(() => {
    const byClose = new Map()
    for (const s of fetchedSummaries) byClose.set(s.closeTime, s)
    for (const s of socketSummaries) byClose.set(s.closeTime, s)
    return Array.from(byClose.values()).sort((a, b) =>
      new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime()
    )
  }, [fetchedSummaries, socketSummaries])

  // Derive live window from diagnostics
  const liveWindow = useMemo(() => {
    if (!latestDiagnostics?.length) return null
    const activeDiags = latestDiagnostics.filter(d => d.ticker && d.ttl > 0)
    if (!activeDiags.length) return null

    // Group by approximate close_time (same TTL range = same window)
    const minTTL = Math.min(...activeDiags.map(d => d.ttl))
    const windowDiags = activeDiags.filter(d => d.ttl <= minTTL + 60)

    const closeTime = new Date(Date.now() + minTTL * 1000).toISOString()
    const withPrices = windowDiags.filter(d => d.marketProb != null || d.edge != null)

    let bestEdge = null
    for (const d of windowDiags) {
      if (d.edge == null) continue
      if (!bestEdge || Math.abs(d.edge) > Math.abs(bestEdge.edge)) {
        bestEdge = { edge: d.edge, strategy: d.strategy || '---', strike: d.strike }
      }
    }

    return {
      closeTime,
      btcSpot: compositePrice?.price ?? null,
      marketsEvaluated: windowDiags.length,
      marketsWithPrices: withPrices.length,
      bestEdge
    }
  }, [latestDiagnostics, compositePrice])

  const formatWindowTime = (closeTime) => {
    const d = new Date(closeTime)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }

  const formatEdge = (bestEdge) => {
    if (!bestEdge) return '---'
    const pct = (Math.abs(bestEdge.edge) * 100).toFixed(1)
    return `${pct}% (${bestEdge.strategy})`
  }

  const formatStrikeShort = (ticker) => {
    if (!ticker) return '---'
    const seg = ticker.split('-').pop()
    if (seg?.startsWith('B')) return `B${parseInt(seg.slice(1)).toLocaleString()}`
    if (seg?.startsWith('T')) return `T${parseInt(seg.slice(1)).toLocaleString()}`
    return seg
  }

  if (allSummaries.length === 0 && !liveWindow) return null

  return (
    <div className="bg-gray-800 rounded-lg p-3 md:p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base md:text-lg font-semibold">Settlement Windows</h3>
        <span className="text-xs text-gray-500">{allSummaries.length} settled</span>
      </div>
      <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0" style={{ WebkitOverflowScrolling: 'touch' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left text-xs border-b border-gray-700">
              <th className="pb-2 pr-3">Window</th>
              <th className="pb-2 pr-3">BTC</th>
              <th className="pb-2 pr-3">Winner</th>
              <th className="pb-2 pr-3">Best Edge</th>
              <th className="pb-2 pr-3">Our Action</th>
              <th className="pb-2 pr-3">P&L</th>
              <th className="pb-2">Markets</th>
            </tr>
          </thead>
          <tbody>
            {/* Live row */}
            {liveWindow && (
              <tr className="border-b border-gray-700/30 bg-blue-900/10">
                <td className="py-1.5 pr-3 text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 font-bold text-[10px] mr-1.5">LIVE</span>
                  {formatWindowTime(liveWindow.closeTime)}
                  {timeLeft > 0 && (
                    <span className="text-gray-500 ml-1">({formatCountdown(timeLeft)})</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-xs font-mono">
                  {liveWindow.btcSpot ? `$${liveWindow.btcSpot.toLocaleString()}` : '---'}
                </td>
                <td className="py-1.5 pr-3 text-xs text-gray-500">---</td>
                <td className="py-1.5 pr-3 text-xs">{formatEdge(liveWindow.bestEdge)}</td>
                <td className="py-1.5 pr-3 text-xs text-gray-500">---</td>
                <td className="py-1.5 pr-3 text-xs text-gray-500">---</td>
                <td className="py-1.5 text-xs text-gray-400">{liveWindow.marketsWithPrices}/{liveWindow.marketsEvaluated} priced</td>
              </tr>
            )}
            {/* Settled rows */}
            {allSummaries.map((s) => {
              const hasAction = !!s.ourAction
              const pnl = s.ourAction?.pnl
              const rowBg = hasAction
                ? (pnl > 0 ? 'bg-green-900/10' : 'bg-red-900/10')
                : ''
              const pnlColor = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500'

              return (
                <tr key={s.closeTime} className={`border-b border-gray-700/30 ${rowBg}`}>
                  <td className="py-1.5 pr-3 text-xs">{formatWindowTime(s.closeTime)}</td>
                  <td className="py-1.5 pr-3 text-xs font-mono">
                    {s.btcSpot ? `$${s.btcSpot.toLocaleString()}` : '---'}
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {s.winningBracket
                      ? <span className="text-green-400">{formatStrikeShort(s.winningBracket.ticker)} YES</span>
                      : <span className="text-gray-500">---</span>
                    }
                  </td>
                  <td className="py-1.5 pr-3 text-xs">{formatEdge(s.bestEdge)}</td>
                  <td className="py-1.5 pr-3 text-xs">
                    {hasAction
                      ? `${s.ourAction.side.toUpperCase()} ${s.ourAction.contracts}x`
                      : s.noActionReason
                        ? <span className="text-yellow-500/80" title={`Edge detected but no trade: ${s.noActionReason}`}>{s.noActionReason}</span>
                        : <span className="text-gray-500">---</span>
                    }
                  </td>
                  <td className={`py-1.5 pr-3 text-xs font-mono ${pnlColor}`}>
                    {pnl != null ? `$${pnl.toFixed(2)}` : '---'}
                  </td>
                  <td className="py-1.5 text-xs text-gray-400">
                    {s.marketsWithPrices}/{s.marketsEvaluated} priced
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Main dashboard: Kalshi-style BTC market view with two-panel layout
 */
export default function Dashboard() {
  const [status, setStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [engineAction, setEngineAction] = useState(null)
  const [btcMarkets, setBtcMarkets] = useState([])
  const [activeMarket, setActiveMarket] = useState(null)
  const [timeLeft, setTimeLeft] = useState(0)
  const [logsExpanded, setLogsExpanded] = useState(true)
  const [secondaryExpanded, setSecondaryExpanded] = useState(true)

  const { connected, prices, logs, balance: socketBalance, positions: socketPositions, stats: socketStats, subscribe, getPrice, clearLogs, latestDiagnostics, aiReview, aiReviewStatus, windowSummaries: socketWindowSummaries } = useKalshiSocket()
  const { connected: coinbaseConnected, prices: cryptoPrices, getPrice: getCryptoPrice } = useCoinbaseSocket()
  const { compositePrice, orderBook } = useCompositeSocket()
  const { sentiment: polymarketSentiment, settledWindows: polymarketWindows } = usePolymarketSocket()

  const fetchData = async (forceRefresh = false) => {
    const refreshParam = forceRefresh ? '?refresh=true' : ''
    const [statusRes, configRes] = await Promise.all([
      fetch(`/api/kalshi/status${refreshParam}`),
      fetch('/api/kalshi/config')
    ])

    if (statusRes.ok) setStatus(await statusRes.json())
    if (configRes.ok) setConfig(await configRes.json())
    setLoading(false)
  }

  // Fetch BTC markets for TimePeriodSelector (15min preferred, hourly fallback)
  const fetchBtcMarkets = async () => {
    const [res, hourlyRes] = await Promise.all([
      fetch('/api/kalshi/markets?type=crypto&asset=BTC&timeframe=15min'),
      fetch('/api/kalshi/markets?type=crypto&asset=BTC&timeframe=hourly')
    ])
    const data = res.ok ? await res.json() : { markets: [] }
    const hourlyData = hourlyRes.ok ? await hourlyRes.json() : { markets: [] }
    const now = Date.now()

    // Merge 15min + hourly, dedup by ticker
    const seen = new Set()
    const merged = [...(data.markets || []), ...(hourlyData.markets || [])]
      .filter(m => m.ticker?.startsWith('KX') && !seen.has(m.ticker) && seen.add(m.ticker))
    const allMarkets = merged
      .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())

    // Group by close_time and pick nearest-to-ATM strike per window
    const spotPrice = getCryptoPrice('BTC-USD')?.price || 0
    const byWindow = new Map()
    for (const m of allMarkets) {
      const key = m.close_time
      if (!byWindow.has(key)) byWindow.set(key, [])
      byWindow.get(key).push(m)
    }

    const deduped = []
    for (const [, windowMarkets] of byWindow) {
      if (spotPrice > 0) {
        const best = windowMarkets.reduce((closest, m) => {
          const strike = parseStrikeFromTitle(m.title) || 0
          const closestStrike = parseStrikeFromTitle(closest.title) || 0
          return Math.abs(strike - spotPrice) < Math.abs(closestStrike - spotPrice) ? m : closest
        })
        deduped.push(best)
      } else {
        deduped.push(windowMarkets[0])
      }
    }

    setBtcMarkets(deduped)

    // Auto-select nearest active market if none selected
    if (!activeMarket) {
      const nearest = deduped.find(m => new Date(m.close_time).getTime() > now)
      if (nearest) {
        const strike = parseStrikeFromTitle(nearest.title)
        const closeTime = new Date(nearest.close_time).getTime()
        setActiveMarket({ ticker: nearest.ticker, event_ticker: nearest.event_ticker, strike, closeTime, title: nearest.title, close_time: nearest.close_time })
      }
    }
  }

  useEffect(() => {
    fetchData()
    fetchBtcMarkets()
    const statusInterval = setInterval(() => fetchData(false), 60000)
    const marketsInterval = setInterval(fetchBtcMarkets, 120000)
    return () => { clearInterval(statusInterval); clearInterval(marketsInterval) }
  }, [])

  // Update active market TTL from diagnostics
  useEffect(() => {
    if (!latestDiagnostics?.length) return

    const btcDiags = latestDiagnostics
      .filter(d => d.ticker?.startsWith('KX') && d.ttl > 0)
      .sort((a, b) => a.ttl - b.ttl)

    if (!btcDiags.length) return

    const currentDiag = activeMarket?.ticker && btcDiags.find(d => d.ticker === activeMarket.ticker)
    if (currentDiag) {
      setActiveMarket(prev => ({ ...prev, closeTime: Date.now() + currentDiag.ttl * 1000 }))
      return
    }

    const is15min = (ticker) => ticker?.toUpperCase().includes('15M')
    const nearest15m = btcDiags.find(d => is15min(d.ticker))
    if (!nearest15m) return

    setActiveMarket({
      ticker: nearest15m.ticker,
      strike: nearest15m.strike,
      closeTime: Date.now() + nearest15m.ttl * 1000,
      ttl: nearest15m.ttl
    })
  }, [latestDiagnostics])

  // Countdown timer
  useEffect(() => {
    if (!activeMarket?.closeTime) { setTimeLeft(0); return }
    const tick = () => setTimeLeft(Math.max(0, Math.round((activeMarket.closeTime - Date.now()) / 1000)))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [activeMarket?.closeTime])

  // Subscribe to active market ticker for live prices
  useEffect(() => {
    if (activeMarket?.ticker) subscribe([activeMarket.ticker])
  }, [activeMarket?.ticker, subscribe])

  const toggleConfig = async (key, value) => {
    setUpdating(true)
    const res = await fetch('/api/kalshi/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    })
    if (res.ok) {
      setConfig(await res.json())
      await fetchData()
    }
    setUpdating(false)
  }

  const handleEngine = async (action) => {
    setEngineAction(action)
    const endpoint = action === 'start' ? '/api/kalshi/engine/start' : '/api/kalshi/engine/stop'
    await fetch(endpoint, { method: 'POST' })
    await fetchData()
    setEngineAction(null)
  }

  const handleResetDryRun = async () => {
    setEngineAction('reset')
    await fetch('/api/kalshi/engine/dry-run/reset', { method: 'POST' })
    await fetchData()
    setEngineAction(null)
  }

  const handleMarketSelect = (market) => {
    const strike = parseStrikeFromTitle(market.title)
    const closeTime = new Date(market.close_time).getTime()
    setActiveMarket({ ticker: market.ticker, event_ticker: market.event_ticker, strike, closeTime, title: market.title, close_time: market.close_time })
  }

  // Derived data
  const marketPrice = activeMarket?.ticker ? prices.get(activeMarket.ticker) : null
  const positions = socketPositions || status?.positions || []

  // Subscribe to position tickers for live price updates
  useEffect(() => {
    const tickers = positions?.map(p => p.ticker).filter(Boolean) || []
    if (tickers.length > 0) subscribe(tickers)
  }, [positions, subscribe])

  const matchingPosition = useMemo(() => {
    if (!activeMarket?.ticker || !positions?.length) return null
    return positions.find(p => p.ticker === activeMarket.ticker)
  }, [activeMarket?.ticker, positions])

  const balance = {
    available: status?.realBalance?.available ?? socketBalance?.available ?? status?.balance?.available,
    inPositions: status?.realBalance?.inPositions ?? socketBalance?.inPositions ?? status?.balance?.inPositions
  }
  const realBalance = status?.realBalance
  const stats = {
    trades: socketStats?.trades ?? status?.todayStats?.trades ?? 0,
    wins: socketStats?.wins ?? status?.todayStats?.wins ?? 0,
    pnl: socketStats?.pnl ?? status?.todayStats?.pnl ?? 0
  }

  const yesBid = marketPrice?.yesBid ?? null
  const yesAsk = marketPrice?.yesAsk ?? null
  const noPrice = yesAsk != null ? 100 - yesAsk : null
  const spread = (yesBid != null && yesAsk != null) ? yesAsk - yesBid : null
  const midPrice = (yesBid != null && yesAsk != null) ? ((yesBid + yesAsk) / 2).toFixed(1) : null
  const countdownColor = timeLeft > 300 ? 'text-green-400' : timeLeft > 60 ? 'text-yellow-400' : 'text-red-400'
  const countdownPulse = timeLeft > 0 && timeLeft <= 60 ? 'animate-pulse' : ''

  // Derive market type label from ticker
  const marketLabel = (() => {
    const t = (activeMarket?.ticker || '').toUpperCase()
    if (t.includes('15M')) return 'BTC 15-Min Market'
    if (t.includes('1H')) return 'BTC Hourly Market'
    if (t.includes('KXBTCD')) return 'BTC Daily Market'
    if (t.startsWith('KXBTC')) return 'BTC Bracket Market'
    return 'BTC Market'
  })()

  const btcPrice = getCryptoPrice('BTC-USD')
  const currentPrice = compositePrice?.price || btcPrice?.price || 0
  const changeColor = btcPrice?.priceChange >= 0 ? 'text-green-400' : 'text-red-400'
  const changeArrow = btcPrice?.priceChange >= 0 ? '▲' : '▼'
  const changeAmount = Math.abs(btcPrice?.priceChange || 0)

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="text-gray-400">Loading dashboard...</div>
      </div>
    )
  }

  const hasKeys = status?.config?.apiEnvironment || config?.apiEnvironment

  return (
    <div className="p-2 md:p-4 space-y-3 md:space-y-4">
      {!hasKeys && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
          <p className="text-yellow-200">
            API keys not configured. <Link to="/kalshi/config/keys" className="underline hover:text-white">Configure keys</Link> to start trading.
          </p>
        </div>
      )}

      {/* Status indicators in header nav */}
      <HeaderStatus
        config={config}
        status={status}
        connected={connected}
        coinbaseConnected={coinbaseConnected}
        exchangeCount={compositePrice?.exchangeCount}
        onRefresh={() => fetchData(true)}
      />

      {/* Top Control Bar */}
      <TopControlBar
        config={config}
        status={status}
        updating={updating}
        engineAction={engineAction}
        onToggleConfig={toggleConfig}
        onEngine={handleEngine}
        onResetDryRun={handleResetDryRun}
      />

      {/* Main Two-Panel Layout */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Left: Market View (~70%) */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Market Header */}
          <div className="bg-gray-800 rounded-lg p-3 md:p-4">
            <div className="flex items-start justify-between mb-2 gap-2">
              <div className="flex items-start gap-2 md:gap-3 min-w-0">
                <span className="text-xl md:text-2xl shrink-0 mt-0.5">₿</span>
                <div className="min-w-0">
                  <div className="text-base md:text-lg font-bold leading-tight">{marketLabel}</div>
                  {activeMarket?.ticker && (
                    <a href={`https://kalshi.com/markets/${activeMarket.event_ticker || activeMarket.ticker}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-[10px] md:text-xs text-gray-600 hover:text-blue-400 font-mono truncate block">{activeMarket.ticker}</a>
                  )}
                  {activeMarket?.close_time && (
                    <div className="text-[10px] md:text-xs text-gray-500">{formatTimeWindow(activeMarket.close_time, activeMarket.ticker)}</div>
                  )}
                </div>
              </div>
              {timeLeft > 0 && (
                <div className="text-right shrink-0">
                  <div className="text-[10px] md:text-xs text-gray-500">settles in</div>
                  <div className={`text-lg md:text-2xl font-mono font-bold ${countdownColor} ${countdownPulse}`}>
                    {formatCountdown(timeLeft)}
                  </div>
                </div>
              )}
            </div>

            {/* BTC Price (prominent) */}
            <div className="flex flex-wrap items-baseline gap-2 md:gap-3 mb-3">
              <span className="text-2xl md:text-4xl font-bold">
                {currentPrice ? `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '---'}
              </span>
              {changeAmount > 0 && (
                <span className={`text-sm md:text-lg ${changeColor}`}>
                  {changeArrow} ${changeAmount.toFixed(2)}
                </span>
              )}
              {orderBook && (
                <div className="ml-auto">
                  <OrderBookImbalance imbalance={orderBook.imbalance} />
                </div>
              )}
            </div>


            {/* Chart (taller, chartOnly mode) */}
            <LiveBTCChart
              btcPrice={btcPrice}
              kalshiPrices={prices}
              positions={positions}
              diagnostics={latestDiagnostics}
              coinbaseConnected={coinbaseConnected}
              compositePrice={compositePrice}
              chartOnly
              activeMarketOverride={activeMarket}
              timeLeftOverride={timeLeft}
              orderBook={orderBook}
            />

            {/* Time Period Selector */}
            <div className="mt-3">
              <TimePeriodSelector
                markets={btcMarkets}
                activeMarketTicker={activeMarket?.ticker}
                onSelect={handleMarketSelect}
              />
            </div>

            {/* Polymarket 5-min crowd sentiment windows */}
            {activeMarket?.close_time && (activeMarket?.ticker || '').toUpperCase().includes('15M') && (
              <div className="mt-3 pt-3 border-t border-gray-700/50">
                <PolymarketWindows
                  sentiment={polymarketSentiment}
                  settledWindows={polymarketWindows}
                  kalshiCloseTime={activeMarket.close_time}
                />
              </div>
            )}

            {/* Bottom bar: Prior Close + Up/Down + probability */}
            <div className="flex flex-wrap items-center gap-2 md:gap-4 mt-3 pt-3 border-t border-gray-700">
              {activeMarket?.strike && currentPrice > 0 && (() => {
                const isUp = currentPrice >= activeMarket.strike
                const diff = currentPrice - activeMarket.strike
                const diffStr = `${diff >= 0 ? '+' : ''}$${Math.abs(diff).toFixed(2)}`
                return (
                  <span className={`px-2 md:px-3 py-1.5 rounded text-xs md:text-sm font-bold cursor-help ${isUp
                    ? 'bg-green-900/50 border border-green-500/50 text-green-400'
                    : 'bg-red-900/50 border border-red-500/50 text-red-400'
                  }`} title={`BTC is currently ${diffStr} ${isUp ? 'above' : 'below'} the strike price of $${activeMarket.strike.toLocaleString()}`}>
                    {isUp ? '▲ Up' : '▼ Down'} {diffStr}
                  </span>
                )
              })()}
              {activeMarket?.strike && (
                <div className="text-xs md:text-sm cursor-help" title="The BTC closing price from the previous period. This is the strike price the market is betting above/below.">
                  <span className="text-gray-500">Prior Close </span>
                  <span className="text-yellow-400 font-semibold">${activeMarket.strike.toLocaleString()}</span>
                </div>
              )}
              {orderBook?.liquidityToStrike && (
                <div className="hidden md:block text-sm cursor-help" title={`Dollar value of resting orders between current price and strike. "${orderBook.liquidityToStrike.side}" indicates which side of the book is closer to strike.`}>
                  <span className="text-gray-500">Liquidity </span>
                  <span className="text-gray-200 font-semibold">{formatCompactCurrency(orderBook.liquidityToStrike.dollarValue)}</span>
                  <span className="text-gray-500 ml-1">{orderBook.liquidityToStrike.side}</span>
                </div>
              )}
              {midPrice != null && (
                <div className="text-xs md:text-sm cursor-help" title={`Market mid-price: ${midPrice}¢ (bid ${yesBid}¢ / ask ${yesAsk}¢, spread ${spread}¢). This is Kalshi's implied probability that BTC closes above the strike.`}>
                  <span className="text-gray-500">Mkt Prob </span>
                  <span className="text-gray-200 font-semibold">{midPrice}%</span>
                  <span className="text-gray-600 text-xs ml-1">({spread}¢ spread)</span>
                </div>
              )}
              <div className="flex items-center gap-2 w-full md:w-auto md:ml-auto mt-1 md:mt-0">
                {yesAsk != null ? (
                  <>
                    <span className="flex-1 md:flex-none text-center px-2 md:px-3 py-2 md:py-1.5 rounded bg-green-900/40 border border-green-700/50 text-green-400 text-sm font-semibold cursor-help min-h-[44px] flex items-center justify-center"
                      title={`Cost to buy YES: ${yesAsk}¢ per contract. You profit if BTC closes above the strike price.`}>
                      ▲ Up {yesAsk}¢
                    </span>
                    <span className="flex-1 md:flex-none text-center px-2 md:px-3 py-2 md:py-1.5 rounded bg-red-900/40 border border-red-700/50 text-red-400 text-sm font-semibold cursor-help min-h-[44px] flex items-center justify-center"
                      title={`Cost to buy NO: ${noPrice}¢ per contract. You profit if BTC closes below the strike price.`}>
                      ▼ Down {noPrice}¢
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-gray-500">No market prices</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Sidebar (~30%) */}
        <div className="w-full lg:w-80 shrink-0">
          <MarketSidebar
            activeMarket={activeMarket}
            matchingPosition={matchingPosition}
            marketPrice={marketPrice}
            balance={balance}
            realBalance={realBalance}
            stats={stats}
            mode={status?.mode}
            shadowStats={status?.shadowStats}
            positions={positions}
            prices={prices}
            onPositionClick={(pos) => {
              setActiveMarket({
                ticker: pos.ticker,
                event_ticker: pos.event_ticker,
                strike: null,
                closeTime: null,
                title: pos.ticker
              })
            }}
          />
        </div>
      </div>

      {/* Below the Fold - Collapsible Secondary Panels */}
      <div>
        <button
          onClick={() => setSecondaryExpanded(!secondaryExpanded)}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-3 min-h-[44px] py-2"
        >
          {secondaryExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {secondaryExpanded ? 'Hide' : 'Show'} Strategy & Analytics
        </button>

        {secondaryExpanded && (
          <div className="space-y-4">
            {/* Performance Charts */}
            {status?.trades?.length > 0 && (
              <PerformanceCharts
                trades={status.trades}
                startingBalance={status?.realBalance?.available ? status.realBalance.available + (status?.todayStats?.pnl || 0) : 10000}
                currentBalance={socketBalance || status?.balance}
              />
            )}

            {/* AI Strategy Review */}
            <AIReviewPanel review={aiReview} reviewStatus={aiReviewStatus} />

            {/* Settlement Windows */}
            <SettlementWindows
              socketSummaries={socketWindowSummaries}
              latestDiagnostics={latestDiagnostics}
              compositePrice={compositePrice}
              timeLeft={timeLeft}
            />

            {/* Strategy Monitor */}
            <StrategyMonitor diagnostics={latestDiagnostics} />

            {/* Evaluation Log */}
            <div className="bg-gray-800 rounded-lg p-3 md:p-4">
              <div className="flex items-center justify-between mb-4">
                <button
                  onClick={() => setLogsExpanded(!logsExpanded)}
                  className="flex items-center gap-2 text-base md:text-lg font-semibold hover:text-gray-300 transition-colors min-h-[44px]"
                >
                  {logsExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                  Evaluation Log
                </button>
                <div className="flex items-center gap-2">
                  {logs.length > 0 && (
                    <span className="text-xs text-gray-500">{logs.length} entries</span>
                  )}
                  {logs.length > 0 && (
                    <button
                      onClick={clearLogs}
                      className="p-1.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                      title="Clear logs"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              {logsExpanded && (
                <div className="space-y-1 max-h-80 overflow-y-auto font-mono text-xs">
                  {logs.length === 0 ? (
                    <p className="text-gray-500 py-4 text-center">
                      {status?.engineRunning
                        ? 'Waiting for evaluation results...'
                        : 'Start the engine to see evaluations'}
                    </p>
                  ) : (
                    logs.map((log, i) => (
                      <LogEntry key={`${log.timestamp}-${i}`} log={log} />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
