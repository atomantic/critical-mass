import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Play, Square, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { useUpDownSocket } from '../../hooks/useUpDownSocket'
import PriceChart from './PriceChart'
import ContractSetup from './ContractSetup'
import PositionTracker from './PositionTracker'
import SignalPanel from './SignalPanel'
import SignalBanner from './SignalBanner'
import TimeframeGrid from './TimeframeGrid'
import TradeHistory from './TradeHistory'
import ScorecardPanel from './ScorecardPanel'
import { parseExpiry } from './TimeWarningBanner'

function formatCurrency(value) {
  if (value == null) return '---'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

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
  const [error, setError] = useState(null)
  const prevSignalRef = useRef(null)
  const [signalAnnotations, setSignalAnnotations] = useState([])

  const fetchStatus = useCallback(async () => {
    const res = await fetch('/api/updown/status').catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      setStatus(data)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 10000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // Track signal changes for chart annotations + audio alerts
  useEffect(() => {
    if (!signal?.type) return
    if (signal.type === prevSignalRef.current) return
    prevSignalRef.current = signal.type

    // Record annotation for chart
    setSignalAnnotations(prev => {
      const entry = { timestamp: signal.timestamp || Date.now(), type: signal.type, score: signal.score ?? 0 }
      const next = [...prev, entry].slice(-20)
      return next
    })

    // Audio alert for strong signals
    if (audioEnabled && (signal.type === 'STRONG_BUY' || signal.type === 'STRONG_SELL')) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = signal.type === 'STRONG_BUY' ? 880 : 440
      gain.gain.value = 0.1
      osc.start()
      osc.stop(ctx.currentTime + 0.2)
      osc.onended = () => ctx.close()
    }
  }, [signal?.type, audioEnabled])

  const handleStart = async () => {
    setStarting(true)
    setError(null)
    const res = await fetch('/api/updown/start', { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to start')
    }
    setStarting(false)
    fetchStatus()
  }

  const handleStop = async () => {
    setStopping(true)
    await fetch('/api/updown/stop', { method: 'POST' })
    setStopping(false)
    fetchStatus()
  }

  const isRunning = status?.running || false

  // Merge tick data with status for current price
  const currentPrice = tick?.price || status?.lastPrice
  const timeRemaining = tick?.timeRemaining

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

  return (
    <div className="space-y-4">
      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-200 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 ml-3">&times;</button>
        </div>
      )}

      {/* Signal Banner */}
      <SignalBanner
        signal={signal || status?.latestSignal}
        indicators={rawIndicators}
        timeRemaining={msLeft}
      />

      {/* Top Bar */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-lg font-bold">UpDown BTC Options</h2>
              <div className="text-xs text-gray-400">
                Signal-assisted binary options trading
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* BTC Price */}
            {currentPrice && (
              <span className="text-sm font-mono font-medium text-white">
                BTC {formatCurrency(currentPrice)}
              </span>
            )}

            {/* Live indicator */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
              <span className={connected ? 'text-green-400' : 'text-red-400'}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </div>

            {/* Audio toggle */}
            <button
              onClick={() => setAudioEnabled(!audioEnabled)}
              className={`p-1.5 rounded transition-colors ${audioEnabled ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}
              title={audioEnabled ? 'Disable audio alerts' : 'Enable audio alerts'}
            >
              {audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>

            {/* Restart server */}
            <button
              onClick={async () => {
                setRestarting(true)
                await fetch('/api/updown/restart', { method: 'POST' }).catch(() => {})
                setTimeout(() => setRestarting(false), 5000)
              }}
              disabled={restarting}
              className={`p-1.5 rounded transition-colors ${restarting ? 'bg-yellow-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
              title="Restart server (pm2)"
            >
              <RotateCcw size={14} className={restarting ? 'animate-spin' : ''} />
            </button>

            {/* Start/Stop */}
            {isRunning ? (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <Square size={14} />
                {stopping ? '...' : 'Stop'}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={starting}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <Play size={14} />
                {starting ? '...' : 'Start'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* TimeframeGrid + Price Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <TimeframeGrid indicators={rawIndicators} tickMomentum={tick?.tickMomentum} />
        <div className="lg:col-span-3">
          <PriceChart
            tick={tick}
            indicators={indicators}
            contract={status?.contract}
            signalAnnotations={signalAnnotations}
          />
        </div>
      </div>

      {/* Contract Setup + Position Tracker side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ContractSetup initialContract={status?.contract} onPositionSet={fetchStatus} />
        <PositionTracker initialPosition={status?.position} tick={tick} />
      </div>

      {/* Trade History + Signal Panel + Scorecard */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-2">
          <TradeHistory />
        </div>
        <div>
          <SignalPanel signal={signal || status?.latestSignal} />
        </div>
        <div>
          <ScorecardPanel scorecard={socketScorecard || status?.scorecard} />
        </div>
      </div>
    </div>
  )
}
