import { useState, useEffect, useRef } from 'react'
import { Crosshair, Save, Trash2 } from 'lucide-react'

function formatCurrency(value) {
  if (value == null) return '---'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export default function PositionTracker({ initialPosition, tick }) {
  const [entryPrice, setEntryPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState('Up')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [hasPosition, setHasPosition] = useState(false)

  // Only update form when the server-side position actually changes
  const prevPositionRef = useRef(null)
  useEffect(() => {
    if (!initialPosition?.entryPrice) return
    const key = `${initialPosition.entryPrice}-${initialPosition.contracts}-${initialPosition.direction}`
    if (prevPositionRef.current === key) return
    prevPositionRef.current = key
    setEntryPrice(initialPosition.entryPrice.toString())
    setAmount(initialPosition.contracts?.toString() || '')
    const dir = initialPosition.direction || 'up'
    setDirection(dir.charAt(0).toUpperCase() + dir.slice(1))
    setHasPosition(true)
  }, [initialPosition])

  const handleSave = async () => {
    setSaving(true)
    const res = await fetch('/api/updown/position', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryPrice: parseFloat(entryPrice),
        contracts: parseFloat(amount),
        direction: direction.toLowerCase(),
      }),
    })
    if (res.ok) setHasPosition(true)
    setSaving(false)
  }

  const handleClear = async () => {
    setClearing(true)
    const res = await fetch('/api/updown/position', { method: 'DELETE' })
    if (res.ok) {
      setEntryPrice('')
      setAmount('')
      setDirection('Up')
      setHasPosition(false)
    }
    setClearing(false)
  }

  // Computed P&L
  const currentPrice = tick?.price
  const entry = parseFloat(entryPrice)
  const amt = parseFloat(amount)
  const validCalc = currentPrice > 0 && Number.isFinite(entry) && entry > 0 && Number.isFinite(amt) && amt > 0
  const pnl = validCalc
    ? direction === 'Up'
      ? (currentPrice - entry) * amt
      : (entry - currentPrice) * amt
    : null
  const pnlPct = validCalc
    ? direction === 'Up'
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100
    : null

  const contractPnl = tick?.pnl?.pnl ?? null

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center gap-2 mb-3">
        <Crosshair size={16} className="text-purple-400" />
        <h3 className="text-sm font-semibold">Position Tracker</h3>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Entry Price ($)</label>
          <input
            type="number"
            value={entryPrice}
            onChange={e => setEntryPrice(e.target.value)}
            placeholder="97500"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Amount (contracts)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="10"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Direction</label>
            <div className="flex gap-2">
              <button
                onClick={() => setDirection('Up')}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  direction === 'Up'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                Up
              </button>
              <button
                onClick={() => setDirection('Down')}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  direction === 'Down'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                Down
              </button>
            </div>
          </div>
        </div>

        {/* Computed P&L */}
        {hasPosition && pnl != null && (
          <div className="bg-gray-900 rounded p-3 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">Unrealized P&L</span>
              <span className={`font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {formatCurrency(pnl)} ({pnlPct >= 0 ? '+' : ''}{pnlPct?.toFixed(2)}%)
              </span>
            </div>
            {contractPnl != null && (
              <div className="flex justify-between text-xs">
                <span className="text-gray-400">Contract P&L</span>
                <span className={`font-medium ${contractPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(contractPnl)}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 rounded text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {hasPosition && (
            <button
              onClick={handleClear}
              disabled={clearing}
              className="py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 rounded text-sm text-red-400 transition-colors flex items-center gap-1"
            >
              <Trash2 size={14} />
              {clearing ? '...' : 'Clear'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
