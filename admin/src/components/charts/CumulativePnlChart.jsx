import { useState, useMemo } from 'react'
import { buildPnlGeometry, PNL_VIEW } from './cumulativePnlGeometry'
import { formatCurrency } from './chartUtils'

// Bounded SVG line chart of cumulative P&L with a native range input for
// touch/keyboard point selection. Read-only: selection never mutates anything.
function CumulativePnlChart({ points }) {
  const geo = useMemo(() => buildPnlGeometry(points), [points])
  const [selected, setSelected] = useState(null)
  const n = geo.coords.length
  if (n === 0) return null
  const idx = Math.min(selected ?? n - 1, n - 1)
  const sel = geo.coords[idx]
  const { width, height } = PNL_VIEW
  const last = geo.coords[n - 1]

  return (
    <div>
      <div className="h-32 w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full block"
          role="img"
          aria-label={`Cumulative P&L line chart, ${n} points, latest ${formatCurrency(last.v)}`}
        >
          <line x1="0" x2={width} y1={geo.zeroY} y2={geo.zeroY} stroke="#4b5563" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          {n > 1 && (
            <path d={geo.path} fill="none" stroke={last.v >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )}
          <circle cx={sel.x} cy={sel.y} r="4" fill="#60a5fa" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      {n > 1 && (
        <input
          type="range"
          min={0}
          max={n - 1}
          step={1}
          value={idx}
          onChange={e => setSelected(Number(e.target.value))}
          aria-label="Select cumulative P&L point"
          aria-valuetext={`${new Date(sel.t).toLocaleString()}: ${formatCurrency(sel.v)}`}
          className="w-full h-11 mt-1 cursor-pointer"
        />
      )}
      <div className="text-xs text-gray-300 mt-1" aria-live="polite">
        {new Date(sel.t).toLocaleString()}: <span className={sel.v >= 0 ? 'text-green-400' : 'text-red-400'}>{formatCurrency(sel.v)}</span>
      </div>
    </div>
  )
}

export default CumulativePnlChart
