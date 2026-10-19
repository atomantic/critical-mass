/**
 * Grid lines across a plot: one horizontal line per `rows` y position and one vertical
 * line per `columns` x position. Remaining props (stroke, dash, opacity) style every line.
 */
export function Grid({ x = 0, y = 0, width = 0, height = 0, rows = [], columns = [], ...line }) {
  return (
    <g className="grid">
      {rows.map((ry, i) => <line key={`r${i}`} x1={x} x2={x + width} y1={ry} y2={ry} {...line} />)}
      {columns.map((cx, i) => <line key={`c${i}`} x1={cx} x2={cx} y1={y} y2={y + height} {...line} />)}
    </g>
  )
}

/** clipPath holding one rect, so plot layers can be clipped to the drawing area. */
export function ClipRect({ id, width, height }) {
  return (
    <defs>
      <clipPath id={id}>
        <rect x={0} y={0} width={width} height={height} />
      </clipPath>
    </defs>
  )
}
