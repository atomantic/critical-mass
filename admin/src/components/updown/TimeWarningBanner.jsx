import { Clock } from 'lucide-react'

// Warning zone thresholds (must match signal-engine.js)
const WARNING_ZONE_H = 8
const NO_TRADE_ZONE_H = 6

export function getTimeColor(hoursLeft) {
  if (hoursLeft > WARNING_ZONE_H) return { bg: 'bg-green-500', border: 'border-green-500/30', text: 'text-green-400', label: 'Safe' }
  if (hoursLeft >= NO_TRADE_ZONE_H) return { bg: 'bg-yellow-500', border: 'border-yellow-500/30', text: 'text-yellow-400', label: 'Caution' }
  return { bg: 'bg-red-500', border: 'border-red-500/30', text: 'text-red-400', label: 'Critical', pulse: true }
}

export function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Parse expiry to ms timestamp.
 * @param {number | string} expiry - Unix ms timestamp or ISO 8601 date string
 * @returns {number} Epoch ms, or NaN if invalid/missing
 */
export const parseExpiry = (expiry) => {
  if (!expiry) return NaN
  if (typeof expiry === 'number') return expiry
  const ms = new Date(expiry).getTime()
  return Number.isFinite(ms) ? ms : NaN
}

export default function TimeWarningBanner({ timeRemaining, expiry }) {
  if (!timeRemaining && !expiry) return null

  const expiryMs = parseExpiry(expiry)
  const msLeft = timeRemaining ?? (Number.isFinite(expiryMs) ? expiryMs - Date.now() : NaN)
  if (!Number.isFinite(msLeft)) return null
  if (msLeft <= 0) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 flex items-center gap-3">
        <Clock size={16} className="text-gray-500" />
        <span className="text-sm text-gray-400">Contract has expired</span>
      </div>
    )
  }

  const hoursLeft = msLeft / 3600000
  // Progress bar: show time remaining relative to the 8h warning zone reference
  const MAX_DISPLAY_MS = WARNING_ZONE_H * 3600000
  const progressPct = Math.max(0, Math.min(100, (msLeft / MAX_DISPLAY_MS) * 100))
  const colors = getTimeColor(hoursLeft)

  return (
    <div className={`rounded-lg border ${colors.border} bg-gray-800/50 p-3`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Clock size={16} className={colors.text} />
          <span className="text-sm font-medium text-white">Time Remaining</span>
          <span className={`px-1.5 py-0.5 text-xs rounded ${colors.text} bg-gray-700`}>{colors.label}</span>
          {colors.pulse && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
        </div>
        <span className={`text-lg font-mono font-bold ${colors.text}`}>
          {formatCountdown(msLeft)}
        </span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div
          className={`${colors.bg} h-2 rounded-full transition-all duration-1000`}
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  )
}
