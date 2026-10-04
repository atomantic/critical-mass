// Text-equivalent helpers for the regime charts (price/ATR, volatility, regime timeline).
// Every helper takes the exact filtered/sorted samples the D3 code plots so the visual and the
// text alternative cannot drift apart. Missing values (null/undefined/NaN) stay distinct from 0.

import { formatPrice } from './chartUtils'

export const TABLE_PAGE_SIZE = 100

const pad2 = (n) => String(n).padStart(2, '0')

export const isValidTimestamp = (ts) => typeof ts === 'number' && Number.isFinite(ts) && !Number.isNaN(new Date(ts).getTime())

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

// Local time, matching the HH:MM axis labels the charts draw.
export function formatClock(ts) {
  if (!isValidTimestamp(ts)) return 'unknown time'
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatStamp(ts) {
  if (!isValidTimestamp(ts)) return 'unknown time'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(ts)}`
}

export function formatSpan(ms) {
  if (!isNum(ms) || ms < 0) return 'unknown duration'
  const totalSeconds = Math.round(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export const formatUsd = (v) => (isNum(v) ? formatPrice(v) : 'missing')
export const formatPct = (v) => (isNum(v) ? `${v.toFixed(2)}%` : 'missing')

/**
 * Summarize one numeric series. Missing values are counted but excluded from first/latest/min/max.
 * Returns null when the series has no numeric sample at all.
 */
export function summarizeSeries(samples, key) {
  let first = null
  let latest = null
  let min = null
  let max = null
  let missing = 0
  let present = 0
  for (const sample of samples) {
    const value = sample?.[key]
    if (!isNum(value)) {
      missing++
      continue
    }
    present++
    if (first === null) first = { value, timestamp: sample.timestamp }
    latest = { value, timestamp: sample.timestamp }
    if (min === null || value < min.value) min = { value, timestamp: sample.timestamp }
    if (max === null || value > max.value) max = { value, timestamp: sample.timestamp }
  }
  if (present === 0) return { count: samples.length, present, missing, first: null, latest: null, min: null, max: null, trend: 'unavailable' }
  const trend = latest.value > first.value ? 'rose' : latest.value < first.value ? 'fell' : 'was unchanged'
  return { count: samples.length, present, missing, first, latest, min, max, trend }
}

/** One-sentence description of a series: "Price rose from $1 to $2 (low $0.5 at 10:00:00, high ...)". */
export function describeSeries(label, summary, format) {
  if (!summary || summary.present === 0) return `${label}: no values available.`
  const { first, latest, min, max, trend, missing } = summary
  const parts = [
    `${label} ${trend}${trend === 'was unchanged' ? ` at ${format(first.value)}` : ` from ${format(first.value)} to ${format(latest.value)}`}`,
    `(low ${format(min.value)} at ${formatClock(min.timestamp)}, high ${format(max.value)} at ${formatClock(max.timestamp)})`,
  ]
  const tail = missing > 0 ? `; ${missing} of ${summary.count} samples have no value.` : '.'
  return `${parts.join(' ')}${tail}`
}

/** Describe the plotted time window of already-sorted samples. */
export function describeWindow(samples, label = 'samples') {
  if (samples.length === 0) return `No ${label} in the window.`
  const start = samples[0].timestamp
  const end = samples[samples.length - 1].timestamp
  return `${samples.length} ${label} from ${formatClock(start)} to ${formatClock(end)} (${formatSpan(end - start)}).`
}

/**
 * Regime intervals visible in [windowStart, windowEnd], using the same boundary rules as the
 * visual: an interval runs from its timestamp to the next entry's timestamp (the last one runs
 * to windowEnd); the start is clamped to the window; intervals with no visible width are dropped.
 * `regimes` must already be sorted ascending by timestamp.
 */
export function buildRegimeIntervals(regimes, windowStart, windowEnd) {
  const intervals = []
  regimes.forEach((regime, i) => {
    const rawStart = regime.timestamp
    const end = i < regimes.length - 1 ? regimes[i + 1].timestamp : windowEnd
    const start = Math.max(rawStart, windowStart)
    if (!(start < windowEnd && end > windowStart && end > start)) return
    intervals.push({
      mode: regime.mode || 'Unknown',
      start,
      end,
      beganBeforeWindow: rawStart < windowStart,
      ongoing: i === regimes.length - 1,
    })
  })
  return intervals
}

// `endLabel` names where the last (open-ended) interval stops: "now" for the timeline, the
// latest plotted sample for the price/volatility charts, whose x-axis ends at that sample.
export function describeInterval(interval, endLabel = 'now') {
  const began = interval.beganBeforeWindow ? ' (began before the window)' : ''
  const end = interval.ongoing ? endLabel : formatClock(interval.end)
  return `${interval.mode} from ${formatClock(interval.start)} to ${end}${began}`
}

export function describeRegimeIntervals(intervals, endLabel = 'now') {
  if (intervals.length === 0) return 'No regime history in the window.'
  const lead = `${intervals.length} regime ${intervals.length === 1 ? 'interval' : 'intervals'}: `
  return `${lead}${intervals.map(i => describeInterval(i, endLabel)).join('; ')}.`
}

export const REGIME_INTERVAL_COLUMNS = [
  { key: 'mode', label: 'Regime' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End' },
  { key: 'duration', label: 'Duration' },
]

export function regimeIntervalRows(intervals, endLabel = 'Now') {
  return intervals.map(i => ({
    mode: i.mode,
    start: `${formatStamp(i.start)}${i.beganBeforeWindow ? ' (clipped to window start)' : ''}`,
    end: i.ongoing ? `${endLabel} (${formatStamp(i.end)})` : formatStamp(i.end),
    duration: formatSpan(i.end - i.start),
  }))
}
