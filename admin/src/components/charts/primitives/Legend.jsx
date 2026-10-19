// Line-with-dot legend glyph on a 32×32 grid, drawn at 14px.
const ICON_PATH = 'M0,16h10.67A5.33,5.33,0,1,1,21.33,16H32M21.33,16A5.33,5.33,0,1,1,10.67,16'

/** Centred HTML legend: one coloured glyph + label per series. */
export function Legend({ items, formatter, style }) {
  return (
    <ul className="chart-legend" style={{ padding: 0, margin: 0, textAlign: 'center', ...style }}>
      {items.map((item) => (
        <li key={item.key} style={{ display: 'inline-block', marginRight: 10 }}>
          <svg width={14} height={14} viewBox="0 0 32 32" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }}>
            <path strokeWidth={4} fill="none" stroke={item.color} d={ICON_PATH} />
          </svg>
          <span style={{ color: item.color }}>{formatter ? formatter(item.value) : item.value}</span>
        </li>
      ))}
    </ul>
  )
}
