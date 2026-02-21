import { useRef, useEffect } from 'react'

/**
 * Format a close_time into a short time label like "2:30 AM"
 * @param {string} closeTime - ISO timestamp
 * @returns {string}
 */
const formatTimeLabel = (closeTime) => {
  const d = new Date(closeTime)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/**
 * Determine market status based on close time
 * @param {string} closeTime - ISO timestamp
 * @returns {'settled' | 'active' | 'upcoming'}
 */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

const getMarketStatus = (closeTime) => {
  const now = Date.now()
  const close = new Date(closeTime).getTime()
  const diff = close - now
  if (diff <= 0) return 'settled'
  if (diff <= ACTIVE_WINDOW_MS) return 'active'
  return 'upcoming'
}

const statusStyles = {
  settled: 'bg-gray-700/50 text-gray-500 border-gray-600',
  active: 'bg-green-900/40 text-green-400 border-green-500/50 ring-1 ring-green-500/30',
  upcoming: 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-500'
}

const selectedStyles = 'bg-blue-900/50 text-blue-300 border-blue-500/60 ring-1 ring-blue-500/40'

/**
 * Horizontal scrollable row of 15-min settlement windows
 * @param {Object} props
 * @param {Array} props.markets - BTC markets sorted by close_time
 * @param {string | null} props.activeMarketTicker - Currently selected market ticker
 * @param {(market: Object) => void} props.onSelect - Market selection handler
 */
export default function TimePeriodSelector({ markets, activeMarketTicker, onSelect }) {
  const scrollRef = useRef(null)
  const activeRef = useRef(null)

  // Scroll active market into view on mount / change
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }, [activeMarketTicker])

  if (!markets?.length) return null

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="flex gap-1.5 overflow-x-auto scrollbar-hide py-1 px-0.5"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {markets.map((m) => {
          const status = getMarketStatus(m.close_time)
          const isSelected = m.ticker === activeMarketTicker
          const label = formatTimeLabel(m.close_time)

          return (
            <button
              key={m.ticker}
              ref={isSelected ? activeRef : null}
              onClick={() => onSelect(m)}
              disabled={status === 'settled'}
              className={`shrink-0 px-3 py-2 min-h-[44px] md:py-1.5 md:min-h-[40px] rounded border text-xs font-medium transition-all touch-manipulation ${
                isSelected ? selectedStyles : statusStyles[status]
              } ${status === 'settled' ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
