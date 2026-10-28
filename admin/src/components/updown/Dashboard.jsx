import Button from '../ui/Button'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from '../../lib/router'
import { Play, Square, RotateCcw, Volume2, VolumeX, BarChart3 } from '../icons'
import { useUpDownSocket } from '../../hooks/useUpDownSocket'

import PriceChart from './PriceChart'
import ContractSetup from './ContractSetup'
import PositionTracker from './PositionTracker'
import SignalPanel from './SignalPanel'
import SignalBanner from './SignalBanner'
import TimeframeGrid from './TimeframeGrid'
import TradeHistory from './TradeHistory'
import ScorecardPanel from './ScorecardPanel'
import TimeWarningBanner, { parseExpiry } from './TimeWarningBanner'
import { calculateManualPositionPnl, isFreshTick } from './position-tracker-math'
import { labelHistoryActions } from '../../constants/signals'
import { formatCurrencyIntl as formatCurrency } from '../charts/chartUtils'
import { createRequestOwner } from '../../utils/requestOwner.mjs'
import { apiPost, describeMutationFailure } from '../../utils/apiClient'
import useRealtimeRefresh from '../../hooks/useRealtimeRefresh'
import { useNotify } from '../Toast'

export default function UpDownDashboard() {
  const { connected, tick, indicators: rawIndicators, signal, scorecard: socketScorecard } = useUpDownSocket()
  // Flatten indicators.timeframes[tf].indicators into indicators[tf] for child components
  const indicators = useMemo(() => {
    if (!rawIndicators?.timeframes) return null
    const flat = {}
    for (const [tf, data] of Object.entries(rawIndicators.timeframes)) {
      flat[tf] = { ...data.indicators, score: data.score, scores: data.scores, candleCount: data.candleCount }
    }
    return flat
  }, [rawIndicators])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(false)
  const notify = useNotify()
  const [statusError, setStatusError] = useState(null)
  const prevSignalRef = useRef(null)
  const [signalAnnotations, setSignalAnnotations] = useState([])

  const seededRef = useRef(false)
  // Per-mount ownership fence for status reads (#508). The 10s poll overlaps the
  // initial load and the post-Start/Stop refresh; without sequencing a pre-action
  // poll could land last and restore Running after a successful Stop.
  const [statusOwner] = useState(createRequestOwner)

  const fetchStatus = useCallback(async () => {
    const { owned, data } = await statusOwner.read('/api/updown/status')
    // A superseded read commits nothing — not even the loading reset, so it can
    // never clear state belonging to a newer request.
    if (!owned) return
    if (!data) {
      setStatusError('Could not load UpDown status.')
    } else {
      setStatusError(null)
      setStatus(data)
      // Seed signal annotations from backend history on first load
      if (!seededRef.current && data.signalHistory?.length) {
        seededRef.current = true
        setSignalAnnotations(labelHistoryActions(data.signalHistory)
          .filter(s => s.action === 'OPEN' || s.action === 'ADD' || s.action === 'CLOSE')
          .map(s => ({
            timestamp: s.timestamp,
            type: s.action,
            score: s.score ?? 0,
          })))
      }
    }
    setLoading(false)
  }, [statusOwner])

  // One read, then re-read on signals, paper fills, service changes, and saved
  // contract/position changes instead of every 10 s (#1880).
  useEffect(() => {
    fetchStatus()
    return () => statusOwner.invalidate()
  }, [fetchStatus, statusOwner])
  useRealtimeRefresh({
    events: ['updown:signal', 'updown:scorecard', 'updown:state', 'updown:changed'],
    rooms: ['updown'],
    minIntervalMs: 2000,
    onRefresh: fetchStatus,
  })

  // Track signal changes for chart annotations + audio alerts
  useEffect(() => {
    if (!signal?.type) return
    if (signal.type === prevSignalRef.current) return
    prevSignalRef.current = signal.type

    const action = signal.action
    const isFillAction = !!signal.filled && (action === 'OPEN' || action === 'ADD' || action === 'CLOSE')
    const isLegacyDirectional = !action && signal.type !== 'NEUTRAL' && signal.type !== 'NO_TRADE_ZONE'
    if (isFillAction || isLegacyDirectional) {
      setSignalAnnotations(prev => {
        const entry = { timestamp: signal.timestamp || Date.now(), type: action || signal.type, score: signal.score ?? 0 }
        return [...prev, entry].slice(-100)
      })
    }

    // Audio alert for Open / Add / Close
    if (audioEnabled && isFillAction) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = action === 'CLOSE' ? 440 : 880
      gain.gain.value = 0.1
      osc.start()
      osc.stop(ctx.currentTime + 0.2)
      osc.onended = () => ctx.close()
    }
  }, [signal?.type, audioEnabled])

  const handleStart = async () => {
    setStarting(true)
    // Any status read started before this action describes the pre-action
    // service; drop it so only the post-action refresh may commit (#508).
    statusOwner.invalidate()
    try {
      const res = await apiPost('/api/updown/start')
      if (!res.ok) throw new Error(describeMutationFailure(res, 'Failed to start'))
      await fetchStatus()
    } catch (err) {
      notify('error', err.message || 'Failed to start')
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    statusOwner.invalidate()
    try {
      const res = await apiPost('/api/updown/stop')
      if (!res.ok) throw new Error(describeMutationFailure(res, 'Failed to stop'))
      await fetchStatus()
    } catch (err) {
      notify('error', err.message || 'Failed to stop')
    } finally {
      setStopping(false)
    }
  }

  const isRunning = status?.running || false

  // Price freshness is derived at render time, and a stalled feed sends no
  // events, so re-render while running to flip the header to "Price stale".
  // Local clock only: no network traffic (#1880).
  const [, setClock] = useState(0)
  useEffect(() => {
    if (!isRunning) return undefined
    const timer = setInterval(() => setClock(n => n + 1), 2000)
    return () => clearInterval(timer)
  }, [isRunning])

  // Merge tick data with status for current price
  const now = Date.now()
  const tickFresh = isFreshTick(tick, now)
  const statusPriceFresh = status?.priceFresh === true && isFreshTick({
    price: status.lastPrice,
    timestamp: status.lastTickAt,
  }, now)
  const priceFresh = tickFresh || statusPriceFresh
  const currentPrice = tickFresh ? tick.price : (statusPriceFresh ? status.lastPrice : null)
  const liveIndicators = isRunning && priceFresh ? rawIndicators : null
  // A tick can predate a saved contract or position, even when its price is
  // still fresh. Do not let its old countdown or P&L override the new status.
  const timeRemaining = tickFresh && tick?.contract?.expiry === status?.contract?.expiry
    ? tick?.timeRemaining : null
  const trackedPosition = status?.position
  const contractPnl = trackedPosition && priceFresh
    ? calculateManualPositionPnl({
      currentPrice,
      entryPrice: trackedPosition.entryPrice,
      contracts: trackedPosition.contracts,
      direction: trackedPosition.direction === 'down' ? 'Down' : 'Up',
    })?.pnl ?? null
    : null

  // Time remaining for signal banner
  const expiryMs = parseExpiry(status?.contract?.expiry)
  const msLeft = timeRemaining ?? (Number.isFinite(expiryMs) ? expiryMs - Date.now() : NaN)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading UpDown dashboard...</div>
      </div>
    )
  }

  // Without a status snapshot the engine state, contract and position are
  // unknown: never render them as a stopped engine with empty forms.
  if (!status) {
    return (
      <div role="alert" className="bg-gray-800 rounded-lg p-8 text-center space-y-3">
        <div className="text-red-400">{statusError || 'Could not load UpDown status.'}</div>
        <Button onClick={fetchStatus} variant="secondary" size="md" touchTarget="always">
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {statusError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm text-red-400">
          <span>{statusError} Showing the last loaded status.</span>
          <Button onClick={fetchStatus} variant="secondary" size="md" touchTarget="always" className="shrink-0">
            Retry
          </Button>
        </div>
      )}

      {/* Top Bar */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-lg font-bold">UpDown BTC Perp Longs</h2>
              <div className="text-xs text-gray-400">
                Open / Add / Hold / Close — 0.01 BTC perpetual contract per Open or Add
              </div>
            </div>
            <Link
              to="/updown/analysis"
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-sm text-xs text-gray-300 hover:text-white transition-colors"
              title="Scorecard Analysis"
            >
              <BarChart3 size={14} />
              <span className="hidden sm:inline">Analysis</span>
            </Link>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* BTC Price */}
            {currentPrice && (
              <span className="text-sm font-mono font-medium text-white">
                BTC {formatCurrency(currentPrice)}
              </span>
            )}

            {/* Data health indicator */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${connected && isRunning && priceFresh ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
              <span className={connected && isRunning && priceFresh ? 'text-green-400' : 'text-red-400'}>
                {!connected ? 'Socket offline' : !isRunning ? 'Engine stopped' : !priceFresh ? 'Price stale' : 'Data live'}
              </span>
            </div>

            {/* Audio toggle */}
            <Button
              onClick={() => setAudioEnabled(!audioEnabled)}
              variant={audioEnabled ? 'primary' : 'secondary'} size="icon" touchTarget="always" className="shrink-0"
              title={audioEnabled ? 'Disable audio alerts' : 'Enable audio alerts'}
              aria-label={audioEnabled ? 'Disable audio alerts' : 'Enable audio alerts'}
            >
              {audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </Button>

            {/* Restart server */}
            <Button
              onClick={async () => {
                setRestarting(true)
                try {
                  const res = await apiPost('/api/updown/restart')
                  if (!res.ok || res.data.success !== true) {
                    throw new Error(describeMutationFailure(res, 'Restart request failed'))
                  }
                } catch (err) {
                  notify('error', err.message || 'Restart request failed')
                } finally {
                  setRestarting(false)
                }
              }}
              disabled={restarting}
              variant={restarting ? 'warning' : 'secondary'} size="icon" touchTarget="always" className="shrink-0"
              title="Restart server (pm2)"
              aria-label="Restart server"
            >
              <RotateCcw size={14} className={restarting ? 'animate-spin' : ''} />
            </Button>

            {/* Start/Stop */}
            {isRunning ? (
              <Button
                onClick={handleStop}
                disabled={stopping}
                variant="destructive" size="compact" touchTarget="always" className="shrink-0 font-medium gap-1.5"
              >
                <Square size={14} />
                {stopping ? '...' : 'Stop'}
              </Button>
            ) : (
              <Button
                onClick={handleStart}
                disabled={starting}
                variant="success" size="compact" touchTarget="always" className="shrink-0 font-medium gap-1.5"
              >
                <Play size={14} />
                {starting ? '...' : 'Start'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <TimeWarningBanner timeRemaining={timeRemaining} expiry={status?.contract?.expiry} />

      {/* 3-column layout: TimeframeGrid/Signal/History + Price Chart + Scorecard/Setup/Position */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="flex flex-col gap-4">
          <TimeframeGrid indicators={rawIndicators} tickMomentum={tick?.tickMomentum} />
          <SignalPanel signal={signal || status?.latestSignal} indicators={liveIndicators} position={status?.position} />
          <TradeHistory />
        </div>
        <div className="lg:col-span-2 flex flex-col gap-4">
          <PriceChart
            tick={tick}
            indicators={indicators}
            weeklyTrend={rawIndicators?.weeklyTrend}
            dailySMA={rawIndicators?.dailySMA}
            contract={status?.contract}
            signalAnnotations={signalAnnotations}
          />
        </div>
        <div className="flex flex-col gap-4">
          <SignalBanner
            signal={signal || status?.latestSignal}
            indicators={liveIndicators}
            timeRemaining={msLeft}
            position={status?.position}
          />
          <ScorecardPanel
            scorecard={socketScorecard || status?.scorecard}
            perp={rawIndicators?.perp || tick?.perp || status?.perp}
          />
          <ContractSetup initialContract={status?.contract} />
          <PositionTracker
            initialPosition={status?.position}
            currentPrice={currentPrice}
            contractPnl={contractPnl}
            priceFresh={priceFresh}
          />
        </div>
      </div>

    </div>
  )
}
