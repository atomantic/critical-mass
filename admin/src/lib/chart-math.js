// Owned chart math for the admin SVG charts: scales, ticks, shapes and binning.
// Each function ports the d3 7.9 algorithm it replaced (d3-array 3.2, d3-scale 4.0,
// d3-shape 3.2, d3-path 3.1, d3-time 3.1) so the charts draw exactly what they drew
// before. tests/fixtures/d3-parity.json is the frozen d3 output this module must match.

// ---------------------------------------------------------------- arrays

// [min, max] of the non-null, non-NaN values (d3.extent); [undefined, undefined] when none.
export function extent(values, valueof) {
  let lo
  let hi
  let index = -1
  for (const item of values) {
    const value = valueof ? valueof(item, ++index, values) : item
    if (value == null) continue
    if (lo === undefined) {
      if (value >= value) lo = hi = value
    } else {
      if (lo > value) lo = value
      if (hi < value) hi = value
    }
  }
  return [lo, hi]
}

export function max(values, valueof) {
  let result
  let index = -1
  for (const item of values) {
    const value = valueof ? valueof(item, ++index, values) : item
    if (value != null && (result < value || (result === undefined && value >= value))) result = value
  }
  return result
}

export function min(values, valueof) {
  let result
  let index = -1
  for (const item of values) {
    const value = valueof ? valueof(item, ++index, values) : item
    if (value != null && (result > value || (result === undefined && value >= value))) result = value
  }
  return result
}

// First index whose value is not below x (d3.bisector(valueof).left).
export function bisectLeft(array, x, valueof = (d) => d, lo = 0, hi = array.length) {
  if (lo < hi && !(x >= x)) return hi
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (valueof(array[mid]) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function bisectRight(array, x, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (array[mid] > x) hi = mid
    else lo = mid + 1
  }
  return lo
}

// ---------------------------------------------------------------- ticks

const E10 = Math.sqrt(50)
const E5 = Math.sqrt(10)
const E2 = Math.sqrt(2)

// Nice step = 10^floor(log10(span / count)) × 1, 2, 5 or 10, rounded at the √2/√10/√50
// error thresholds. A negative increment means "divide by" to keep fractional steps exact.
function tickSpec(start, stop, count) {
  const step = (stop - start) / Math.max(0, count)
  const power = Math.floor(Math.log10(step))
  const error = step / Math.pow(10, power)
  const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1
  let i1, i2, inc
  if (power < 0) {
    inc = Math.pow(10, -power) / factor
    i1 = Math.round(start * inc)
    i2 = Math.round(stop * inc)
    if (i1 / inc < start) ++i1
    if (i2 / inc > stop) --i2
    inc = -inc
  } else {
    inc = Math.pow(10, power) * factor
    i1 = Math.round(start / inc)
    i2 = Math.round(stop / inc)
    if (i1 * inc < start) ++i1
    if (i2 * inc > stop) --i2
  }
  if (i2 < i1 && 0.5 <= count && count < 2) return tickSpec(start, stop, count * 2)
  return [i1, i2, inc]
}

function ticks(start, stop, count) {
  stop = +stop, start = +start, count = +count
  if (!(count > 0)) return []
  if (start === stop) return [start]
  const reverse = stop < start
  const [i1, i2, inc] = reverse ? tickSpec(stop, start, count) : tickSpec(start, stop, count)
  if (!(i2 >= i1)) return []
  const n = i2 - i1 + 1
  const out = new Array(n)
  for (let i = 0; i < n; ++i) {
    const k = reverse ? i2 - i : i1 + i
    out[i] = inc < 0 ? k / -inc : k * inc
  }
  return out
}

function tickIncrement(start, stop, count) {
  return tickSpec(+start, +stop, +count)[2]
}

function tickStep(start, stop, count) {
  stop = +stop, start = +start, count = +count
  const reverse = stop < start
  const inc = reverse ? tickIncrement(stop, start, count) : tickIncrement(start, stop, count)
  return (reverse ? -1 : 1) * (inc < 0 ? 1 / -inc : inc)
}

// ---------------------------------------------------------------- number formatting

// d3-format ",.Nf": fixed precision, comma grouping, U+2212 minus, no "−0".
function formatGroupedFixed(value, precision) {
  if (Number.isNaN(value)) return 'NaN'
  const text = Math.abs(value).toFixed(precision)
  const negative = (value < 0 || 1 / value < 0) && +text !== 0
  const [integer, fraction] = text.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (negative ? '−' : '') + grouped + (fraction == null ? '' : `.${fraction}`)
}

// Default linear tick labels: just enough decimals to distinguish ticks of this step
// (d3 falls back to 6 decimals when the step is zero or not finite).
function linearTickFormat(start, stop, count) {
  const step = Math.abs(tickStep(start, stop, count))
  const precision = Number.isFinite(step) && step !== 0
    ? Math.max(0, -Number(step.toExponential().split('e')[1]))
    : 6
  return (value) => formatGroupedFixed(+value, precision)
}

// ---------------------------------------------------------------- continuous scales

function normalize(a, b) {
  return (b -= a) ? (x) => (x - a) / b : () => (Number.isNaN(b) ? NaN : 0.5)
}

const interpolate = (a, b) => (t) => a * (1 - t) + b * t

function bimap([d0, d1], [r0, r1]) {
  const [toUnit, fromUnit] = d1 < d0
    ? [normalize(d1, d0), interpolate(r1, r0)]
    : [normalize(d0, d1), interpolate(r0, r1)]
  return (x) => fromUnit(toUnit(x))
}

// Two-point domain → two-point range map with invert; values are coerced by toNumber.
function continuous(domain, range, toNumber, fromNumber) {
  const d = Array.from(domain, toNumber)
  const r = Array.from(range, Number)
  const forward = bimap([d[0], d[d.length - 1]], [r[0], r[r.length - 1]])
  const backward = bimap([r[0], r[r.length - 1]], [d[0], d[d.length - 1]])
  const scale = (x) => (x == null || Number.isNaN((x = +x)) ? undefined : forward(x))
  scale.invert = (y) => fromNumber(backward(+y))
  scale.domain = () => d.map(fromNumber)
  scale.range = () => r.slice()
  return { scale, start: d[0], stop: d[d.length - 1] }
}

function niceLinearDomain(domain, count) {
  const d = Array.from(domain, Number)
  let i0 = 0
  let i1 = d.length - 1
  let start = d[i0]
  let stop = d[i1]
  let prestep
  if (stop < start) [start, stop, i0, i1] = [stop, start, i1, i0]
  for (let iter = 0; iter < 10; iter++) {
    const step = tickIncrement(start, stop, count)
    if (step === prestep) {
      d[i0] = start
      d[i1] = stop
      return d
    }
    if (step > 0) {
      start = Math.floor(start / step) * step
      stop = Math.ceil(stop / step) * step
    } else if (step < 0) {
      start = Math.ceil(start * step) / step
      stop = Math.floor(stop * step) / step
    } else {
      break
    }
    prestep = step
  }
  return d
}

export function linearScale(domain = [0, 1], range = [0, 1]) {
  const { scale, start, stop } = continuous(domain, range, Number, (x) => x)
  scale.ticks = (count = 10) => ticks(start, stop, count)
  scale.tickFormat = (count = 10) => linearTickFormat(start, stop, count)
  // Extends the domain outward to round tick values (d3 linear.nice).
  scale.nice = (count = 10) => linearScale(niceLinearDomain([start, stop], count), range)
  return scale
}

// ---------------------------------------------------------------- local-time intervals

const SECOND = 1e3
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

// floor/offset mutate a Date in place; field (when present) supports every(step > 1).
function timeInterval(floori, offseti, field) {
  const interval = {
    ceil(date) {
      date = new Date(date - 1)
      floori(date), offseti(date, 1), floori(date)
      return date
    },
    range(start, stop) {
      const out = []
      start = interval.ceil(start)
      if (!(start < stop)) return out
      let previous
      do out.push((previous = new Date(+start))), offseti(start, 1), floori(start)
      while (previous < start && start < stop)
      return out
    },
    every(step) {
      step = Math.floor(step)
      if (!Number.isFinite(step) || !(step > 0)) return null
      if (!(step > 1)) return interval
      const test = (d) => field(d) % step === 0
      return timeInterval(
        (date) => { if (date >= date) while ((floori(date), !test(date))) date.setTime(date - 1) },
        (date, n) => {
          if (!(date >= date)) return
          while (--n >= 0) while ((offseti(date, 1), !test(date)));
        },
      )
    },
  }
  return interval
}

const timeSecond = timeInterval(
  (date) => date.setTime(date - date.getMilliseconds()),
  (date, step) => date.setTime(+date + step * SECOND),
  (date) => date.getUTCSeconds(),
)
const timeMinute = timeInterval(
  (date) => date.setTime(date - date.getMilliseconds() - date.getSeconds() * SECOND),
  (date, step) => date.setTime(+date + step * MINUTE),
  (date) => date.getMinutes(),
)
const timeHour = timeInterval(
  (date) => date.setTime(date - date.getMilliseconds() - date.getSeconds() * SECOND - date.getMinutes() * MINUTE),
  (date, step) => date.setTime(+date + step * HOUR),
  (date) => date.getHours(),
)
const timeDay = timeInterval(
  (date) => date.setHours(0, 0, 0, 0),
  (date, step) => date.setDate(date.getDate() + step),
  (date) => date.getDate() - 1,
)
const timeSunday = timeInterval(
  (date) => {
    date.setDate(date.getDate() - (date.getDay() + 7) % 7)
    date.setHours(0, 0, 0, 0)
  },
  (date, step) => date.setDate(date.getDate() + step * 7),
)
const timeMonth = timeInterval(
  (date) => {
    date.setDate(1)
    date.setHours(0, 0, 0, 0)
  },
  (date, step) => date.setMonth(date.getMonth() + step),
  (date) => date.getMonth(),
)

function millisecondEvery(k) {
  k = Math.floor(k)
  if (!Number.isFinite(k) || !(k > 0)) return null
  return timeInterval(
    (date) => date.setTime(Math.floor(date / k) * k),
    (date, step) => date.setTime(+date + step * k),
  )
}

function yearEvery(k) {
  k = Math.floor(k)
  if (!Number.isFinite(k) || !(k > 0)) return null
  return timeInterval(
    (date) => {
      date.setFullYear(Math.floor(date.getFullYear() / k) * k)
      date.setMonth(0, 1)
      date.setHours(0, 0, 0, 0)
    },
    (date, step) => date.setFullYear(date.getFullYear() + step * k),
  )
}

const TICK_INTERVALS = [
  [timeSecond, 1, SECOND],
  [timeSecond, 5, 5 * SECOND],
  [timeSecond, 15, 15 * SECOND],
  [timeSecond, 30, 30 * SECOND],
  [timeMinute, 1, MINUTE],
  [timeMinute, 5, 5 * MINUTE],
  [timeMinute, 15, 15 * MINUTE],
  [timeMinute, 30, 30 * MINUTE],
  [timeHour, 1, HOUR],
  [timeHour, 3, 3 * HOUR],
  [timeHour, 6, 6 * HOUR],
  [timeHour, 12, 12 * HOUR],
  [timeDay, 1, DAY],
  [timeDay, 2, 2 * DAY],
  [timeSunday, 1, WEEK],
  [timeMonth, 1, MONTH],
  [timeMonth, 3, 3 * MONTH],
  [null, 1, YEAR],
]

// Picks the fixed calendar interval whose duration is nearest (by ratio) to span / count.
function tickInterval(start, stop, count) {
  const target = Math.abs(stop - start) / count
  let i = 0
  if (target >= target) {
    let hi = TICK_INTERVALS.length
    while (i < hi) {
      const mid = (i + hi) >>> 1
      if (TICK_INTERVALS[mid][2] > target) hi = mid
      else i = mid + 1
    }
  } else {
    i = TICK_INTERVALS.length
  }
  if (i === TICK_INTERVALS.length) return yearEvery(tickStep(start / YEAR, stop / YEAR, count))
  if (i === 0) return millisecondEvery(Math.max(tickStep(start, stop, count), 1))
  const [interval, step] = TICK_INTERVALS[target / TICK_INTERVALS[i - 1][2] < TICK_INTERVALS[i][2] / target ? i - 1 : i]
  return interval ? interval.every(step) : yearEvery(step)
}

function timeTicks(start, stop, count) {
  const reverse = stop < start
  if (reverse) [start, stop] = [stop, start]
  const interval = tickInterval(start, stop, count)
  const out = interval ? interval.range(start, +stop + 1) : []
  return reverse ? out.reverse() : out
}

const toTime = (t) => (t instanceof Date ? +t : +new Date(+t))

export function timeScale(domain = [new Date(2000, 0, 1), new Date(2000, 0, 2)], range = [0, 1]) {
  const { scale, start, stop } = continuous(domain, range, toTime, (t) => new Date(t))
  scale.ticks = (count = 10) => timeTicks(start, stop, count)
  return scale
}

// ---------------------------------------------------------------- band scale

// Evenly spaced bands over the unique domain values (d3.scaleBand().padding(p)).
export function bandScale(domain = [], range = [0, 1], { padding = 0 } = {}) {
  const keyOf = (value) => (value !== null && typeof value === 'object' ? value.valueOf() : value)
  const keys = []
  const index = new Map()
  for (const value of domain) {
    const key = keyOf(value)
    if (!index.has(key)) index.set(key, keys.push(value) - 1)
  }
  const [r0, r1] = range.map(Number)
  const paddingInner = Math.min(1, padding)
  const n = keys.length
  const reverse = r1 < r0
  const stop = reverse ? r0 : r1
  let start = reverse ? r1 : r0
  const step = (stop - start) / Math.max(1, n - paddingInner + padding * 2)
  start += (stop - start - step * (n - paddingInner)) * 0.5
  const bandwidth = step * (1 - paddingInner)
  const starts = keys.map((_, i) => start + step * i)
  if (reverse) starts.reverse()
  const scale = (value) => {
    const i = index.get(keyOf(value))
    return i === undefined ? undefined : starts[i]
  }
  scale.bandwidth = () => bandwidth
  scale.step = () => step
  scale.domain = () => keys.slice()
  scale.range = () => [r0, r1]
  return scale
}

// Evenly spaced positions for `count` categories (indices) across the range, ends included.
export function pointScale(count, range = [0, 1]) {
  const [r0, r1] = range.map(Number)
  const step = count > 1 ? (r1 - r0) / (count - 1) : 0
  const start = count > 1 ? r0 : (r0 + r1) / 2
  const scale = (index) => start + step * index
  scale.step = () => step
  scale.range = () => [r0, r1]
  return scale
}

// ---------------------------------------------------------------- paths

// SVG path builder; coordinates are rounded to 3 decimals like d3-shape's default digits.
function createPath() {
  const round = (v) => Math.round(v * 1000) / 1000
  let text = ''
  let x0 = null
  let y0 = null
  let x1 = null
  return {
    moveTo(x, y) {
      x0 = x1 = +x
      y0 = +y
      text += `M${round(x0)},${round(y0)}`
    },
    lineTo(x, y) {
      x1 = +x
      text += `L${round(x1)},${round(+y)}`
    },
    bezierCurveTo(ax, ay, bx, by, x, y) {
      x1 = +x
      text += `C${round(+ax)},${round(+ay)},${round(+bx)},${round(+by)},${round(x1)},${round(+y)}`
    },
    closePath() {
      if (x1 === null) return
      x1 = x0
      text += 'Z'
    },
    toString: () => text,
  }
}

const sign = (x) => (x < 0 ? -1 : 1)

// Monotone cubic interpolation in x (Steffen 1990), emitted as Bézier segments — the
// d3 curveMonotoneX state machine: lineStart/point/lineEnd, plus areaStart/areaEnd.
function monotoneX(path) {
  let line = NaN
  let x0, y0, x1, y1, t0, count

  // Tangent at (x1, y1) from both neighbouring secants.
  const slope3 = (x2, y2) => {
    const h0 = x1 - x0
    const h1 = x2 - x1
    const s0 = (y1 - y0) / (h0 || (h1 < 0 && -0))
    const s1 = (y2 - y1) / (h1 || (h0 < 0 && -0))
    const p = (s0 * h1 + s1 * h0) / (h0 + h1)
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  }
  // One-sided tangent at an end point.
  const slope2 = (t) => {
    const h = x1 - x0
    return h ? (3 * (y1 - y0) / h - t) / 2 : t
  }
  const segment = (ta, tb) => {
    const dx = (x1 - x0) / 3
    path.bezierCurveTo(x0 + dx, y0 + dx * ta, x1 - dx, y1 - dx * tb, x1, y1)
  }

  return {
    areaStart() { line = 0 },
    areaEnd() { line = NaN },
    lineStart() {
      x0 = x1 = y0 = y1 = t0 = NaN
      count = 0
    },
    lineEnd() {
      if (count === 2) path.lineTo(x1, y1)
      else if (count === 3) segment(t0, slope2(t0))
      if (line || (line !== 0 && count === 1)) path.closePath()
      line = 1 - line
    },
    point(x, y) {
      let t1 = NaN
      x = +x, y = +y
      if (x === x1 && y === y1) return
      if (count === 0) {
        count = 1
        if (line) path.lineTo(x, y)
        else path.moveTo(x, y)
      } else if (count === 1) {
        count = 2
      } else if (count === 2) {
        count = 3
        t1 = slope3(x, y)
        segment(slope2(t1), t1)
      } else {
        t1 = slope3(x, y)
        segment(t0, t1)
      }
      x0 = x1, x1 = x
      y0 = y1, y1 = y
      t0 = t1
    },
  }
}

const always = () => true
const accessor = (f) => (typeof f === 'function' ? f : () => +f)

// Monotone-x line through the defined points; undefined points split it into segments.
export function linePath(data, { x = (d) => d[0], y = (d) => d[1], defined = always } = {}) {
  const path = createPath()
  const curve = monotoneX(path)
  let inside = false
  for (let i = 0, n = data.length; i <= n; ++i) {
    let d
    if (!(i < n && defined((d = data[i]), i, data)) === inside) {
      if ((inside = !inside)) curve.lineStart()
      else curve.lineEnd()
    }
    if (inside) curve.point(+x(d, i, data), +y(d, i, data))
  }
  return String(path) || null
}

// Monotone-x area between y0 (number or accessor) and y1 over the defined points.
export function areaPath(data, { x = (d) => d[0], y0 = 0, y1 = (d) => d[1], defined = always } = {}) {
  const lower = accessor(y0)
  const upper = accessor(y1)
  const path = createPath()
  const curve = monotoneX(path)
  const n = data.length
  const xs = new Array(n)
  const ys = new Array(n)
  let inside = false
  let first
  for (let i = 0; i <= n; ++i) {
    let d
    if (!(i < n && defined((d = data[i]), i, data)) === inside) {
      if ((inside = !inside)) {
        first = i
        curve.areaStart()
        curve.lineStart()
      } else {
        curve.lineEnd()
        curve.lineStart()
        for (let k = i - 1; k >= first; --k) curve.point(xs[k], ys[k])
        curve.lineEnd()
        curve.areaEnd()
      }
    }
    if (inside) {
      xs[i] = +x(d, i, data)
      ys[i] = +lower(d, i, data)
      curve.point(xs[i], +upper(d, i, data))
    }
  }
  return String(path) || null
}

const SQRT3 = Math.sqrt(3)

// Upward equilateral triangle centred on the origin with the given area (d3.symbolTriangle).
export function trianglePath(size) {
  const path = createPath()
  const y = -Math.sqrt(size / (SQRT3 * 3))
  path.moveTo(0, y * 2)
  path.lineTo(-SQRT3 * y, -y)
  path.lineTo(SQRT3 * y, -y)
  path.closePath()
  return String(path) || null
}

// ---------------------------------------------------------------- histogram

// Uniform bins over a fixed [x0, x1] domain at nice thresholds (d3.bin().domain().thresholds(n)).
export function histogram(values, { domain: [x0, x1], thresholds: count }) {
  let tz = ticks(x0, x1, count)
  let step
  if (tz[0] <= x0) step = tickIncrement(x0, x1, count)
  // A threshold on the upper bound would leave a zero-width last bin.
  if (tz[tz.length - 1] >= x1) tz.pop()

  let m = tz.length
  let a = 0
  let b = m
  while (tz[a] <= x0) ++a
  while (tz[b - 1] > x1) --b
  if (a || b < m) tz = tz.slice(a, b), m = b - a

  const bins = Array.from({ length: m + 1 }, (_, i) => ({
    x0: i > 0 ? tz[i - 1] : x0,
    x1: i < m ? tz[i] : x1,
    values: [],
  }))
  for (const x of values) {
    if (x == null || !(x0 <= x && x <= x1)) continue
    let i
    if (!Number.isFinite(step)) {
      i = bisectRight(tz, x, 0, m)
    } else if (step > 0) {
      i = Math.min(m, Math.floor((x - x0) / step))
    } else if (step < 0) {
      const j = Math.floor((x0 - x) * step)
      i = Math.min(m, j + (tz[j] <= x))
    } else {
      continue
    }
    bins[i].values.push(x)
  }
  return bins
}

// ---------------------------------------------------------------- time format

const pad2 = (n) => String(n).padStart(2, '0')
const TIME_FIELDS = { H: (date) => pad2(date.getHours()), M: (date) => pad2(date.getMinutes()) }

// Local-time formatter for the strftime patterns the charts use (%H, %M).
export function formatTime(pattern) {
  return (value) => {
    const date = value instanceof Date ? value : new Date(+value)
    return pattern.replace(/%([HM])/g, (_, field) => TIME_FIELDS[field](date))
  }
}
