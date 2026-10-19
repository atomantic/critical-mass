import usePriceChartCoordinates from './usePriceChartCoordinates'

/**
 * Render atomoku cloud fills as raw SVG polygons.
 * Uses the chart's coordinate scales for the indexed price axis.
 */
const AtomokuCloudRenderer = ({ data }) => {
  const { points, yScale } = usePriceChartCoordinates(data)
  if (!yScale || points.length < 2) return null

  const n = points.length
  const polygons = []
  let polyKey = 0

  const buildCloud = (key1, key2, bullColor, bearColor) => {
    let segStart = -1
    let segBull = null

    const flush = (end) => {
      if (segStart < 0 || end <= segStart) return
      const top = []
      const bot = []
      for (let i = segStart; i <= end; i++) {
        const d = points[i]?.payload
        const v1 = d?.[key1]
        const v2 = d?.[key2]
        if (v1 == null || v2 == null) continue
        const x = points[i].x
        const yT = yScale(Math.max(v1, v2))
        const yB = yScale(Math.min(v1, v2))
        if (!Number.isFinite(x) || !Number.isFinite(yT) || !Number.isFinite(yB)) continue
        top.push(`${x},${yT}`)
        bot.unshift(`${x},${yB}`)
      }
      if (top.length < 2) return
      polygons.push(
        <polygon key={`cloud-${polyKey++}`} points={[...top, ...bot].join(' ')}
          fill={segBull ? bullColor : bearColor} strokeWidth={0} />
      )
    }

    for (let i = 0; i < n; i++) {
      const d = points[i]?.payload
      const v1 = d?.[key1]
      const v2 = d?.[key2]
      if (v1 == null || v2 == null) {
        flush(i - 1); segStart = -1; segBull = null
        continue
      }
      const bull = v1 >= v2
      if (segStart < 0) {
        segStart = i; segBull = bull
      } else if (bull !== segBull) {
        flush(i); segStart = i; segBull = bull
      }
    }
    flush(n - 1)
  }

  buildCloud('atomokuLead1', 'atomokuLead2', 'rgba(0,128,0,0.4)', 'rgba(255,0,0,0.4)')
  buildCloud('atomokuConv', 'atomokuBase', 'rgba(0,51,51,0.3)', 'rgba(128,0,0,0.3)')

  return <g>{polygons}</g>
}

export default AtomokuCloudRenderer
