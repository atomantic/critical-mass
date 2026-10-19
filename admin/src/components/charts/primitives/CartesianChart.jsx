import { useMemo, useState } from 'react'
import { areaPath, extent, linePath, linearScale, pointScale } from '../../../lib/chart-math'
import { Axis } from './Axis'
import { ChartContext } from './chartContext'
import { Grid } from './Grid'
import { Legend } from './Legend'
import { ReferenceLine } from './ReferenceLine'
import { Responsive, localPoint } from './Responsive'
import { TooltipContent } from './Tooltip'

const DEFAULT_MARGIN = { top: 5, right: 5, bottom: 5, left: 5 }
const X_AXIS_HEIGHT = 30
const Y_AXIS_WIDTH = 60
const LEGEND_HEIGHT = 24
const AXIS_STROKE = '#666'
const DEFAULT_COLOR = '#3182bd'
const TICK_COUNT = 5
const TICK_GAP = 5
const FONT_SIZE = 12

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const seriesColor = (s) => s.stroke ?? s.fill ?? DEFAULT_COLOR

// Indices of ticks whose labels (extent `sizes[i]` along the axis) do not collide.
// preserveEnd keeps the last tick and walks back; preserveStartEnd keeps both ends.
function selectTicks(positions, sizes, interval) {
  const n = positions.length
  if (n === 0) return []
  const clear = (a, b) => Math.abs(positions[b] - positions[a]) >= (sizes[a] + sizes[b]) / 2 + TICK_GAP
  if (interval === 'preserveStartEnd') {
    const kept = [0]
    for (let i = 1; i < n - 1; i++) {
      if (clear(kept[kept.length - 1], i) && clear(i, n - 1)) kept.push(i)
    }
    if (n > 1) kept.push(n - 1)
    return kept
  }
  const kept = [n - 1]
  for (let i = n - 2; i >= 0; i--) {
    if (clear(i, kept[kept.length - 1])) kept.push(i)
  }
  return kept.reverse()
}

// Recharts' default orderings: legend entries by value, tooltip rows by series name.
const sortBy = (items, key) => [...items].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0))

// Rough rendered width of a tick label (no layout engine to measure with).
const labelWidth = (label, fontSize) => String(label).length * fontSize * 0.6

// Numeric y scale: an explicit [min, max] is kept (and only widened to fit the data unless
// allowDataOverflow). An 'auto' bound is the data extreme; an omitted bound is the data
// extreme with zero included. Any data-driven bound is niced.
function yScaleFor({ domain = [], allowDataOverflow }, values, range) {
  const [dataMin = 0, dataMax = 0] = extent(values)
  const fixedMin = finite(domain[0])
  const fixedMax = finite(domain[1])
  let lo = fixedMin ?? (domain[0] === 'auto' ? dataMin : Math.min(0, dataMin))
  let hi = fixedMax ?? (domain[1] === 'auto' ? dataMax : Math.max(0, dataMax))
  if (!allowDataOverflow && values.length) {
    lo = Math.min(lo, dataMin)
    hi = Math.max(hi, dataMax)
  }
  if (lo === hi) hi = lo + 1
  const scale = linearScale([lo, hi], range)
  return fixedMin != null && fixedMax != null ? scale : scale.nice(TICK_COUNT)
}

// Stacked series (same stackId) sit on the running total; empty samples stack as zero.
function resolveSeries(series, data) {
  const totals = {}
  return series.map((s) => {
    const values = data.map((d) => finite(d[s.dataKey]))
    if (!s.stackId) return { ...s, values, upper: values, lower: null }
    const base = (totals[s.stackId] ??= data.map(() => 0))
    const lower = base.slice()
    const upper = values.map((v, i) => (base[i] += v ?? 0))
    return { ...s, values, upper, lower }
  })
}

function Plot({
  width, height, data, margin: marginOverride, xAxis = {}, yAxes = [{}], series = [],
  referenceLines = [], grid, tooltip, legend, underlay, overlay,
}) {
  const [active, setActive] = useState(null)
  const margin = { ...DEFAULT_MARGIN, ...marginOverride }
  const svgHeight = height - (legend ? LEGEND_HEIGHT : 0)

  const geometry = useMemo(() => {
    const axes = yAxes.map((axis, i) => ({ id: i, orientation: 'left', width: Y_AXIS_WIDTH, ...axis }))
    const axisFor = (id) => axes.find((axis) => axis.id === id) ?? axes[0]
    const sideWidth = (side) => axes.filter((a) => a.orientation === side && !a.hide).reduce((sum, a) => sum + a.width, 0)
    const left = sideWidth('left')
    const plot = {
      x: margin.left + left,
      y: margin.top,
      width: Math.max(0, width - margin.left - margin.right - left - sideWidth('right')),
      height: Math.max(0, svgHeight - margin.top - margin.bottom - (xAxis.hide ? 0 : X_AXIS_HEIGHT)),
    }
    const x = pointScale(data.length, [plot.x, plot.x + plot.width])
    const resolved = resolveSeries(series, data)
    const yRange = [plot.y + plot.height, plot.y]
    const scales = new Map(axes.map((axis) => {
      const values = resolved
        .filter((s) => axisFor(s.yAxisId) === axis)
        .flatMap((s) => [...s.upper, ...(s.lower ?? [])])
        .filter((v) => v != null)
      return [axis, yScaleFor(axis, values, yRange)]
    }))
    const y = (id) => scales.get(axisFor(id))
    // Explicit ticks are kept; generated ones are thinned so stacked labels never overlap.
    const tickSets = new Map(axes.map((axis) => {
      if (axis.ticks) return [axis, axis.ticks]
      const scale = scales.get(axis)
      const values = scale.ticks(TICK_COUNT)
      const fontSize = axis.tick?.fontSize ?? FONT_SIZE
      const kept = selectTicks(values.map(scale), values.map(() => fontSize), axis.interval)
      return [axis, kept.map((i) => values[i])]
    }))
    const yTicks = (id) => tickSets.get(axisFor(id))

    const xFontSize = xAxis.tick?.fontSize ?? FONT_SIZE
    const categoryOf = (i) => (xAxis.dataKey ? data[i]?.[xAxis.dataKey] : i)
    const labels = data.map((_, i) => (xAxis.tickFormatter ? xAxis.tickFormatter(categoryOf(i), i) : categoryOf(i)))
    const widths = labels.map((label) => labelWidth(label, xFontSize))
    // Edge labels slide inward to stay within the plot; collisions use the slid centres.
    const centers = data.map((_, i) => Math.min(Math.max(x(i), plot.x + widths[i] / 2), plot.x + plot.width - widths[i] / 2))
    const xTicks = xAxis.hide ? [] : selectTicks(centers, widths, xAxis.interval)
    const xLabelDx = (i) => (centers[i] === x(i) ? undefined : centers[i] - x(i))

    const layers = resolved.map((s) => {
      const scale = y(s.yAxisId)
      const [d0, d1] = scale.domain()
      // Unstacked areas fill down to zero, or to the nearest domain edge when zero is off-axis.
      const base = scale(Math.max(Math.min(d0, d1), Math.min(0, Math.max(d0, d1))))
      const points = s.upper.map((v, i) => ({
        x: x(i),
        y1: v == null ? null : scale(v),
        y0: s.lower ? scale(s.lower[i]) : base,
      }))
      const shown = s.connectNulls ? points.filter((p) => p.y1 != null) : points
      const shape = { x: (p) => p.x, defined: (p) => p.y1 != null }
      return {
        ...s,
        scale,
        line: linePath(shown, { ...shape, y: (p) => p.y1 }),
        area: s.type === 'area' ? areaPath(shown, { ...shape, y0: (p) => p.y0, y1: (p) => p.y1 }) : null,
      }
    })
    return { axes, plot, x, y, yTicks, layers, labels, xTicks, xLabelDx, xFontSize, categoryOf }
  }, [width, svgHeight, data, margin.top, margin.right, margin.bottom, margin.left, xAxis, yAxes, series])

  const { axes, plot, x, y, yTicks, layers, labels, xTicks, xLabelDx, xFontSize, categoryOf } = geometry
  const context = useMemo(() => ({ plot, x, y }), [plot, x, y])
  const index = active?.index

  const onMouseMove = (event) => {
    if (!data.length) return
    const [px, py] = localPoint(event)
    const step = x.step()
    const i = step ? Math.round(px / step) : 0
    setActive({ index: Math.max(0, Math.min(data.length - 1, i)), y: plot.y + py })
  }

  const payload = index == null ? [] : sortBy(layers
    .filter((s) => s.values[index] != null)
    .map((s) => ({ dataKey: s.dataKey, name: s.name ?? s.dataKey, value: s.values[index], color: seriesColor(s) })), 'name')
  const activeX = index == null ? 0 : x(index)

  return (
    <ChartContext.Provider value={context}>
      <svg width={width} height={svgHeight} className="cartesian-chart">
        {grid && (
          <Grid
            x={plot.x}
            y={plot.y}
            width={plot.width}
            height={plot.height}
            rows={yTicks(grid.yAxisId).map(y(grid.yAxisId))}
            columns={xTicks.map(x)}
            stroke={grid.stroke}
            strokeDasharray={grid.strokeDasharray}
          />
        )}
        {!xAxis.hide && (
          <Axis
            orient="bottom"
            transform={`translate(0,${plot.y + plot.height})`}
            scale={x}
            ticks={xTicks}
            format={(i) => labels[i]}
            labelDx={xLabelDx}
            stroke={xAxis.stroke ?? AXIS_STROKE}
            textFill={xAxis.tick?.fill ?? xAxis.stroke ?? AXIS_STROKE}
            fontSize={xFontSize}
            tickSizeOuter={0}
            tickPadding={2}
            offset={0}
          />
        )}
        {axes.filter((axis) => !axis.hide).map((axis) => {
          const scale = y(axis.id)
          const right = axis.orientation === 'right'
          const stroke = axis.stroke ?? AXIS_STROKE
          return (
            <Axis
              key={axis.id}
              orient={right ? 'right' : 'left'}
              transform={`translate(${right ? plot.x + plot.width : plot.x},0)`}
              scale={scale}
              ticks={yTicks(axis.id)}
              format={axis.tickFormatter ?? String}
              stroke={stroke}
              textFill={axis.tick?.fill ?? stroke}
              fontSize={axis.tick?.fontSize ?? FONT_SIZE}
              tickSizeOuter={0}
              tickPadding={2}
              offset={0}
            />
          )
        })}
        {index != null && <line className="cursor" x1={activeX} x2={activeX} y1={plot.y} y2={plot.y + plot.height} stroke="#ccc" />}
        {underlay}
        {layers.map((s) => (
          <g key={s.dataKey} className={`series series-${s.type ?? 'line'}`}>
            {s.area && <path d={s.area} fill={s.fill ?? DEFAULT_COLOR} fillOpacity={s.fillOpacity ?? 0.6} stroke="none" />}
            <path d={s.line} fill="none" stroke={s.stroke ?? DEFAULT_COLOR} strokeWidth={s.strokeWidth ?? 1} strokeDasharray={s.strokeDasharray} />
          </g>
        ))}
        {referenceLines.map((line, i) => <ReferenceLine key={i} {...line} />)}
        {overlay}
        {index != null && layers.filter((s) => s.values[index] != null).map((s) => (
          <circle key={s.dataKey} className="active-dot" cx={activeX} cy={s.scale(s.upper[index])} r={4} fill={seriesColor(s)} stroke="#fff" strokeWidth={2} />
        ))}
        {tooltip && (
          <rect
            className="overlay"
            x={plot.x}
            y={plot.y}
            width={plot.width}
            height={plot.height}
            fill="none"
            pointerEvents="all"
            onMouseMove={onMouseMove}
            onMouseLeave={() => setActive(null)}
          />
        )}
      </svg>
      {tooltip && index != null && (
        <div
          className="pointer-events-none absolute left-0 top-0 z-10"
          style={{
            transform: `translate(${activeX > width / 2 ? `calc(${activeX - 10}px - 100%)` : `${activeX + 10}px`}, ${active.y > svgHeight / 2 ? `calc(${active.y - 10}px - 100%)` : `${active.y + 10}px`})`,
          }}
        >
          <TooltipContent active label={categoryOf(index)} payload={payload} {...tooltip} />
        </div>
      )}
      {legend && (
        <div style={{ height: LEGEND_HEIGHT }}>
          <Legend
            items={sortBy(layers.map((s) => ({ key: s.dataKey, value: s.name ?? s.dataKey, color: seriesColor(s) })), 'value')}
            formatter={legend.formatter}
            style={legend.wrapperStyle}
          />
        </div>
      )}
    </ChartContext.Provider>
  )
}

/**
 * Responsive line/area chart over indexed categories — the subset of a Recharts
 * ComposedChart the admin uses. `series` entries are { type: 'line' | 'area', dataKey,
 * name, stroke, fill, fillOpacity, strokeWidth, strokeDasharray, connectNulls, stackId,
 * yAxisId }; `yAxes` entries are { id, orientation, domain, allowDataOverflow, ticks,
 * tickFormatter, width, stroke, tick }. `underlay`/`overlay` are extra SVG layers drawn
 * below/above the series that read the shared scales through useChartContext().
 * `height` is a pixel height or "100%" of the parent.
 */
export function CartesianChart({ height, ...props }) {
  return (
    <Responsive height={height} className="relative">
      {(size) => <Plot {...size} {...props} />}
    </Responsive>
  )
}
