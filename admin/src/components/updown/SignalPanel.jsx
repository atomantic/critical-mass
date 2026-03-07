import { useState, useEffect } from 'react'
import { Signal, Minus } from 'lucide-react'
import { signalBadgeColors, getSignalIcon } from '../../constants/signals'

function ConfidenceBar({ value }) {
  const pct = Math.max(0, Math.min(100, (value ?? 0) * 100))
  const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-gray-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-700 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-10 text-right">{pct.toFixed(0)}%</span>
    </div>
  )
}

export default function SignalPanel({ signal, indicators }) {
  const [history, setHistory] = useState([])

  useEffect(() => {
    if (!signal?.timestamp) return
    setHistory(prev => {
      const exists = prev.some(h => h.timestamp === signal.timestamp)
      if (exists) return prev
      return [signal, ...prev].slice(0, 50)
    })
  }, [signal?.timestamp])

  // Fetch initial history
  useEffect(() => {
    fetch('/api/updown/signals')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.signals) setHistory(data.signals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 50))
      })
      .catch(() => {})
  }, [])

  // Show loading state until live indicators arrive to avoid displaying stale signals
  const liveReady = !!indicators?.type || !!indicators?.timeframes
  const type = liveReady ? (indicators?.type || signal?.type || 'NEUTRAL') : null
  const liveScore = indicators?.score ?? signal?.score
  const liveConfidence = indicators?.confidence ?? signal?.confidence
  const colors = type ? (signalBadgeColors[type] || signalBadgeColors.NEUTRAL) : 'bg-gray-500/10 border-gray-500/20 text-gray-500'
  const Icon = type ? getSignalIcon(type) : Minus

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center gap-2 mb-3">
        <Signal size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold">Signal</h3>
      </div>

      {/* Current Signal Badge */}
      <div className={`rounded-lg border p-3 mb-4 ${colors}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon size={18} />
            <span className="text-lg font-bold">{type ? type.replace(/_/g, ' ') : 'CALCULATING...'}</span>
          </div>
          {type && liveConfidence != null && (
            <span className="text-sm font-mono">{(liveConfidence * 100).toFixed(0)}%</span>
          )}
        </div>
        {type && liveConfidence != null && (
          <div className="mt-2">
            <ConfidenceBar value={liveConfidence} />
          </div>
        )}
      </div>

      {/* Score */}
      {liveScore != null && (
        <div className="mb-4 text-xs text-gray-400">
          Composite score: <span className="font-mono text-white">{liveScore.toFixed(1)}</span>
        </div>
      )}

      {/* History Log */}
      {history.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1 font-medium">History</div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {history.map((h, i) => {
              const hType = h.type || 'NEUTRAL'
              const hColors = signalBadgeColors[hType] || signalBadgeColors.NEUTRAL
              return (
                <div key={h.timestamp || i} className="flex items-center justify-between py-1 text-xs">
                  <span className="text-gray-500">
                    {h.timestamp ? new Date(h.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '---'}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${hColors}`}>{hType.replace(/_/g, ' ')}</span>
                  {h.confidence != null && (
                    <span className="text-gray-400 font-mono">{(h.confidence * 100).toFixed(0)}%</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
