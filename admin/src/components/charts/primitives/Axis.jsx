// Crisp 1px lines on standard-density screens (d3-axis applies the same half-pixel shift).
const pixelOffset = () => (typeof window !== 'undefined' && window.devicePixelRatio > 1 ? 0 : 0.5)

// One colour for the domain bar (filled), tick lines and outlined labels.
export const solidAxis = (color) => ({ stroke: color, domainFill: color, textFill: color, textStroke: color })

const ANCHOR = { left: 'end', right: 'start', top: 'middle', bottom: 'middle' }
const DY = { left: '0.32em', right: '0.32em', top: '0em', bottom: '0.71em' }

/**
 * SVG axis with the d3-axis layout: a domain path with outer ticks, then one
 * `g.tick` (line + label) per value. `scale` maps a value to a position and exposes
 * range(); band scales are centred on the band. Colours default to currentColor.
 */
export function Axis({
  scale,
  orient = 'bottom',
  ticks,
  format = String,
  transform,
  stroke = 'currentColor',
  domainFill,
  textFill = 'currentColor',
  textStroke,
  fontSize,
  fontWeight,
  textTransform,
  textAnchor,
  labelDx,
  tickSize = 6,
  tickSizeOuter = 6,
  tickPadding = 3,
  offset = pixelOffset(),
}) {
  const vertical = orient === 'left' || orient === 'right'
  const k = orient === 'top' || orient === 'left' ? -1 : 1
  const range = scale.range()
  const range0 = +range[0] + offset
  const range1 = +range[range.length - 1] + offset
  const band = scale.bandwidth ? Math.max(0, scale.bandwidth() - offset * 2) / 2 : 0
  const outer = k * tickSizeOuter
  const domain = vertical
    ? (tickSizeOuter ? `M${outer},${range0}H${offset}V${range1}H${outer}` : `M${offset},${range0}V${range1}`)
    : (tickSizeOuter ? `M${range0},${outer}V${offset}H${range1}V${outer}` : `M${range0},${offset}H${range1}`)
  const lineEnd = vertical ? { x2: k * tickSize } : { y2: k * tickSize }
  const labelAt = vertical ? { x: k * (tickSize + tickPadding) } : { y: k * (tickSize + tickPadding) }

  return (
    <g transform={transform} fill="none" fontSize={10} fontFamily="sans-serif" textAnchor={ANCHOR[orient]}>
      <path className="domain" stroke={stroke} fill={domainFill} d={domain} />
      {ticks.map((value, i) => {
        const position = scale(value) + band + offset
        return (
          <g key={i} className="tick" opacity={1} transform={vertical ? `translate(0,${position})` : `translate(${position},0)`}>
            <line stroke={stroke} {...lineEnd} />
            <text
              fill={textFill}
              stroke={textStroke}
              {...labelAt}
              dx={labelDx?.(value, i)}
              dy={DY[orient]}
              transform={textTransform}
              textAnchor={textAnchor}
              fontWeight={fontWeight}
              style={fontSize ? { fontSize } : undefined}
            >
              {format(value, i)}
            </text>
          </g>
        )
      })}
    </g>
  )
}
