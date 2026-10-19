import { colors } from '../chartUtils'

const WRAPPER_STYLE = { margin: 0, padding: 10, backgroundColor: '#fff', border: '1px solid #ccc', whiteSpace: 'nowrap' }
const ITEM_STYLE = { display: 'block', paddingTop: 4, paddingBottom: 4 }

// Applies the caller's formatter; [value, name] pairs rename the row, a null value drops it.
function formatEntry(entry, index, formatter) {
  if (!formatter) return { ...entry, display: entry.value }
  const formatted = formatter(entry.value, entry.name, entry, index)
  const [display, name] = Array.isArray(formatted) ? formatted : [formatted, entry.name]
  return { ...entry, display, name }
}

/**
 * HTML tooltip body: a label line, then one "name : value" row per series. Renders
 * nothing while inactive or when every series is empty at the hovered point.
 */
export function TooltipContent({ active, label, payload, labelFormatter, formatter, contentStyle, labelStyle, separator = ' : ' }) {
  const entries = (payload || []).filter((entry) => entry?.value != null)
  if (!active || entries.length === 0) return null
  const rows = entries.map((entry, i) => formatEntry(entry, i, formatter)).filter((row) => row.display != null)
  return (
    <div className="chart-tooltip" style={{ ...WRAPPER_STYLE, ...contentStyle }}>
      <p style={{ margin: 0, ...labelStyle }}>{labelFormatter ? labelFormatter(label, entries) : label}</p>
      <ul style={{ padding: 0, margin: 0 }}>
        {rows.map((row) => (
          // A transparent series (e.g. the price line under Heikin-Ashi candles) still reads.
          <li key={row.dataKey} style={{ ...ITEM_STYLE, color: row.color === 'transparent' ? undefined : row.color }}>
            {row.name != null && <><span>{row.name}</span><span>{separator}</span></>}
            <span>{row.display}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * In-SVG hover marker for the time-series charts: a dashed guide line, an optional
 * dot on the hovered sample and a boxed tooltip with one text row per entry.
 */
export function HoverMarker({ x, height, dot, box, rows }) {
  return (
    <g className="focus">
      <line className="hover-line" x1={x} x2={x} y1={0} y2={height} stroke={colors.lightGray} strokeDasharray="3,3" />
      {dot && <circle r={5} cx={x} cy={dot.y} fill={dot.color} stroke="white" strokeWidth={2} />}
      <g className="tooltip-group" transform={`translate(${box.x},${box.y})`}>
        <rect className="tooltip-bg" fill={colors.darkBg} stroke={colors.darkGray} rx={4} width={box.width} height={box.height} />
        {rows.map((row, i) => (
          <text key={i} x={8} y={16 + i * 16} fill={row.color} fontWeight={row.bold ? 'bold' : undefined} style={{ fontSize: row.fontSize }}>
            {row.text}
          </text>
        ))}
      </g>
    </g>
  )
}
