import { useState, useEffect } from 'react'
import { Signal, TrendingUp, TrendingDown, Minus } from 'lucide-react'

const signalColors = {
  'STRONG BUY': 'bg-green-500/20 border-green-500/40 text-green-400',
  'BUY': 'bg-green-500/10 border-green-500/20 text-green-400',
  'NEUTRAL': 'bg-gray-500/10 border-gray-500/20 text-gray-400',
  'SELL': 'bg-red-500/10 border-red-500/20 text-red-400',
  'STRONG SELL': 'bg-red-500/20 border-red-500/40 text-red-400',
}

const signalIcons = {
  'STRONG BUY': TrendingUp,
  'BUY': TrendingUp,
  'NEUTRAL': Minus,
  'SELL': TrendingDown,
  'STRONG SELL': TrendingDown,
}

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

function BreakdownItem({ name, value, signal: sig }) {
  const color = sig === 'BUY' || sig === 'STRONG BUY'
    ? 'text-green-400'
    : sig === 'SELL' || sig === 'STRONG SELL'
      ? 'text-red-400'
      : 'text-gray-400'

  return (
    <div className="flex items-center justify-between py-1 border-b border-gray-700/50 last:border-0">
      <span className="text-xs text-gray-400">{name}</span>
      <div className="flex items-center gap-2">
        {value != null && <span className="text-xs font-mono">{typeof value === 'number' ? value.toFixed(2) : value}</span>}
        <span className={`text-xs font-medium ${color}`}>{sig || '---'}</span>
      </div>
    </div>
  )
}

export default function SignalPanel({ signal }) {
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
        if (data?.signals) setHistory(data.signals.slice(0, 50))
      })
      .catch(() => {})
  }, [])

  const type = signal?.type || 'NEUTRAL'
  const colors = signalColors[type] || signalColors.NEUTRAL
  const Icon = signalIcons[type] || Minus

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
            <span className="text-lg font-bold">{type}</span>
          </div>
          {signal?.confidence != null && (
            <span className="text-sm font-mono">{(signal.confidence * 100).toFixed(0)}%</span>
          )}
        </div>
        {signal?.confidence != null && (
          <div className="mt-2">
            <ConfidenceBar value={signal.confidence} />
          </div>
        )}
      </div>

      {/* Breakdown */}
      {signal?.breakdown && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-1 font-medium">Indicator Breakdown</div>
          {Object.entries(signal.breakdown).map(([name, item]) => (
            <BreakdownItem
              key={name}
              name={name}
              value={item?.value}
              signal={item?.signal}
            />
          ))}
        </div>
      )}

      {/* History Log */}
      {history.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1 font-medium">History</div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {history.map((h, i) => {
              const hColors = signalColors[h.type] || signalColors.NEUTRAL
              return (
                <div key={h.timestamp || i} className="flex items-center justify-between py-1 text-xs">
                  <span className="text-gray-500">
                    {h.timestamp ? new Date(h.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '---'}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${hColors}`}>{h.type}</span>
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
