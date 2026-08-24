// @ts-check
/**
 * Paper-book profitability snapshot for the UpDown advising engine.
 *
 * 1 BTC long per Open/Add, flatten on Close. Verdict is mark-to-market
 * total P&L (realized closed rounds + open lots at `mark`).
 */

const { createPerpBook } = require('./perp-book')

/**
 * @param {{contracts?: number, rounds?: number, totalPnl?: number}|null|undefined} snap
 * @returns {'NO_FILLS' | 'PROFITABLE' | 'UNDERWATER' | 'FLAT'}
 */
const verdictOf = (snap) => {
  if (!snap || ((snap.contracts ?? 0) === 0 && (snap.rounds ?? 0) === 0)) return 'NO_FILLS'
  if (snap.totalPnl > 0) return 'PROFITABLE'
  if (snap.totalPnl < 0) return 'UNDERWATER'
  return 'FLAT'
}

/**
 * @param {Object} snap - perp-book snapshot
 * @param {{mark?: number|null, lastAction?: string|null, lastType?: string|null, ts?: string}} [extra]
 */
const summarize = (snap, extra = {}) => ({
  ts: extra.ts || new Date().toISOString(),
  verdict: verdictOf(snap),
  mark: extra.mark ?? null,
  contracts: snap.contracts,
  avgEntry: snap.avgEntry,
  realizedPnl: snap.realizedPnl,
  unrealizedPnl: snap.unrealizedPnl,
  totalPnl: snap.totalPnl,
  rounds: snap.rounds,
  wins: snap.wins,
  losses: snap.losses,
  winRate: snap.winRate,
  lastSide: snap.lastSide,
  lastAction: extra.lastAction ?? null,
  lastType: extra.lastType ?? null,
})

/**
 * Nearest price in a sorted [{t, p}] index. Returns null if empty.
 * @param {Array<{t: number, p: number}>} index
 * @param {number} ts
 * @returns {number|null}
 */
const priceAt = (index, ts) => {
  if (!Array.isArray(index) || index.length === 0 || !Number.isFinite(ts)) return null
  let lo = 0
  let hi = index.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (index[mid].t < ts) lo = mid + 1
    else hi = mid - 1
  }
  let best = null
  let bestDt = Infinity
  for (const j of [lo - 1, lo, lo + 1]) {
    if (j < 0 || j >= index.length) continue
    const dt = Math.abs(index[j].t - ts)
    if (dt < bestDt) {
      bestDt = dt
      best = index[j].p
    }
  }
  return best
}

/**
 * Walk engine types through the paper book (same-side skip, 1 BTC per fill).
 * Uses `entry.price` when present, otherwise `lookupPrice(timestamp)`.
 * @param {Array<{type?: string, price?: number, timestamp?: number}>} entries
 * @param {(ts: number) => number|null|undefined} [lookupPrice]
 * @returns {{book: ReturnType<typeof createPerpBook>, fills: Array<Object>}}
 */
const replaySignals = (entries, lookupPrice) => {
  const book = createPerpBook()
  const fills = []
  const sorted = (entries || []).slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  for (const s of sorted) {
    const stored = Number(s.price)
    const price = Number.isFinite(stored) && stored > 0
      ? stored
      : lookupPrice?.(s.timestamp)
    const res = book.applySignal(s.type, price, s.timestamp)
    if (res.fill) {
      fills.push({
        action: res.action,
        price: res.fill.price,
        ts: res.fill.ts,
        contracts: res.fill.contracts,
      })
    }
  }
  return { book, fills }
}

module.exports = { verdictOf, summarize, priceAt, replaySignals }
