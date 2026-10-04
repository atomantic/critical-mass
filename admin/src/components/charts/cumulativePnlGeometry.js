// Pure geometry for the cumulative P&L line chart. Maps (timestamp, cumulative)
// points into a fixed viewBox; always includes zero in the vertical domain and
// never returns non-finite coordinates (empty, single-point and all-zero safe).
export const PNL_VIEW = { width: 600, height: 160, padX: 8, padY: 12 }

export function buildPnlGeometry(points, view = PNL_VIEW) {
  const { width, height, padX, padY } = view
  const clean = (points || [])
    .map(p => ({ t: new Date(p.date).getTime(), v: Number(p.cumulative) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v))
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  let min = 0
  let max = 0
  let t0 = Infinity
  let t1 = -Infinity
  for (const p of clean) {
    if (p.v < min) min = p.v
    if (p.v > max) max = p.v
    if (p.t < t0) t0 = p.t
    if (p.t > t1) t1 = p.t
  }
  const vSpan = max - min || 1
  const tSpan = t1 - t0
  const yOf = v => padY + (max - v) / vSpan * innerH
  const coords = clean.map((p, i) => ({
    x: tSpan > 0
      ? padX + (p.t - t0) / tSpan * innerW
      : clean.length > 1 ? padX + i / (clean.length - 1) * innerW : padX + innerW / 2,
    y: yOf(p.v),
    t: p.t,
    v: p.v,
  }))
  return {
    coords,
    zeroY: yOf(0),
    min,
    max,
    path: coords.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' '),
  }
}
