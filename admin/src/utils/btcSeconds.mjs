// Pure helpers behind the UpDown 1s chart. Times are ms; intervals and ranges are seconds.

export const INTERVALS = [1, 5, 15, 30]
export const RANGES = [300, 900, 3600]
export const MAX_CANDLES = 300
export const MOVE_SECONDS = [10, 30, 60]

const AMBER_MS = 3_000
const STALE_MS = 10_000

export const isAllowed = (interval, range) => range / interval <= MAX_CANDLES

// Merge by `t`: incoming wins, entries before `cutoffT` are dropped, ascending.
export function mergeByT(existing, incoming, cutoffT) {
  const byT = new Map()
  for (const item of existing) if (item.t >= cutoffT) byT.set(item.t, item)
  for (const item of incoming) if (item.t >= cutoffT) byT.set(item.t, item)
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

// Fixed slots ending at the one containing `nowMs`, or the newest bar if the gateway
// clock is behind the exchange. A slot nothing traded in stays null, so a stalled feed
// shows a growing gap instead of a frozen last candle.
export function buildSlots({ bars, index, interval, range, nowMs }) {
  const step = interval * 1000
  const count = range / interval
  const end = Math.max(nowMs, bars.at(-1)?.t ?? 0)
  const start = Math.floor(end / step) * step - (count - 1) * step
  const slots = Array.from({ length: count }, (_, i) => ({
    chartIndex: i, t: start + i * step,
    open: null, high: null, low: null, close: null, buyVolume: 0, sellVolume: 0, indexValue: null,
  }))
  const slotFor = (t) => slots[Math.floor((t - start) / step)]
  for (const bar of bars) {
    const slot = slotFor(bar.t)
    if (!slot) continue
    slot.open ??= bar.open
    slot.high = slot.high === null ? bar.high : Math.max(slot.high, bar.high)
    slot.low = slot.low === null ? bar.low : Math.min(slot.low, bar.low)
    slot.close = bar.close
    slot.buyVolume += bar.buyVolume
    slot.sellVolume += bar.sellVolume
  }
  for (const { t, value } of index) {
    const slot = slotFor(t)
    if (slot) slot.indexValue = value
  }
  return slots
}

// Last close minus the close exactly N seconds earlier; null when that second is a gap.
export function priceMoves(bars, { stale }) {
  const last = stale ? null : bars.at(-1)
  const closes = new Map(last ? bars.map(b => [b.t, b.close]) : [])
  return Object.fromEntries(MOVE_SECONDS.map((seconds) => {
    const then = last ? closes.get(last.t - seconds * 1000) : undefined
    return [seconds, then === undefined ? null : last.close - then]
  }))
}

export function freshness(ageMs) {
  if (ageMs === null || ageMs >= STALE_MS) return 'stale'
  return ageMs >= AMBER_MS ? 'amber' : 'live'
}

// Floor and ceiling to measure from: the operator's held contract, else a configured Up
// contract that has not expired. `held` is undefined until it has been read: show nothing
// rather than distances from the wrong contract.
export function contractBounds(held, contract, nowMs = 0) {
  if (held === undefined) return null
  const action = held?.decision?.action
  if (held?.contract && action !== 'EXPIRED') {
    return { floor: held.contract.floor, ceiling: held.contract.ceiling, label: 'your contract', note: action === 'CHECK_APP' ? 'check the app' : null }
  }
  const expired = contract?.expiry != null && contract.expiry <= nowMs
  if (contract?.direction === 'up' && contract.stop && contract.target && !expired) {
    return { floor: contract.stop, ceiling: contract.target, label: 'configured contract', note: null }
  }
  return null
}
