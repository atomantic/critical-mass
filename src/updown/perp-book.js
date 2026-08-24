// @ts-check
/**
 * Simulated 1-BTC perpetual-long book.
 *
 * Every OPEN or ADD buys 1 BTC at the mark. CLOSE sells the entire book at
 * the mark. Same-side repeats (BUY staying BUY, or BUY→STRONG_BUY) do not
 * pyramid — a new fill requires a side change (Hold→Buy while already long
 * is ADD; Buy→Sell is CLOSE).
 *
 * P&L is mark-to-market USD with 1 BTC notional per contract: Δprice × contracts.
 * No fees, no funding — this is the scorecard's "if we followed the signals" book.
 */

const { resolveAction, signalSide } = require('./signal-actions')

const round2 = (n) => Math.round(n * 100) / 100
const round8 = (n) => Math.round(n * 1e8) / 1e8

const cloneLot = (lot) => ({
  entryPrice: lot.entryPrice,
  entryTs: lot.entryTs,
  action: lot.action,
})

/**
 * @param {Object} [initial]
 * @param {Array<{entryPrice: number, entryTs: number, action?: string}>} [initial.lots]
 * @param {number} [initial.realizedPnl]
 * @param {Array<Object>} [initial.closedTrades]
 * @param {number} [initial.maxContracts]
 * @param {'BUY'|'SELL'|'HOLD'} [initial.lastSide]
 */
const createPerpBook = (initial = {}) => {
  let lots = Array.isArray(initial.lots) ? initial.lots.filter(l => Number.isFinite(l?.entryPrice)).map(cloneLot) : []
  let realizedPnl = Number.isFinite(initial.realizedPnl) ? initial.realizedPnl : 0
  let closedTrades = Array.isArray(initial.closedTrades) ? initial.closedTrades.slice() : []
  let maxContracts = Number.isFinite(initial.maxContracts) ? initial.maxContracts : lots.length
  let lastSide = initial.lastSide === 'BUY' || initial.lastSide === 'SELL' || initial.lastSide === 'HOLD'
    ? initial.lastSide
    : (lots.length > 0 ? 'BUY' : 'HOLD')

  const contracts = () => lots.length

  const avgEntry = () => {
    if (lots.length === 0) return 0
    return lots.reduce((s, l) => s + l.entryPrice, 0) / lots.length
  }

  const unrealizedAt = (price) => {
    if (!Number.isFinite(price) || lots.length === 0) return 0
    return lots.reduce((s, l) => s + (price - l.entryPrice), 0)
  }

  const closedStats = () => {
    const wins = closedTrades.filter(t => t.pnl > 0)
    const losses = closedTrades.filter(t => t.pnl <= 0)
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0
    return {
      rounds: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedTrades.length > 0
        ? Math.round(wins.length / closedTrades.length * 10000) / 100
        : null,
      avgWin: round2(avgWin),
      avgLoss: round2(avgLoss),
    }
  }

  /**
   * @param {number} [markPrice]
   */
  const snapshot = (markPrice) => {
    const n = contracts()
    const unrealized = Number.isFinite(markPrice) ? unrealizedAt(markPrice) : 0
    const stats = closedStats()
    return {
      contracts: n,
      avgEntry: n > 0 ? round2(avgEntry()) : 0,
      realizedPnl: round2(realizedPnl),
      unrealizedPnl: round2(unrealized),
      totalPnl: round2(realizedPnl + unrealized),
      maxContracts,
      lastSide,
      ...stats,
      lots: lots.map(cloneLot),
      closedTrades: closedTrades.slice(-50),
    }
  }

  /**
   * Apply a published engine type at `price`. Same-side repeats do not fill.
   * @param {string} type - BUY / STRONG_BUY / NEUTRAL / SELL / STRONG_SELL / NO_TRADE_ZONE
   * @param {number} price
   * @param {number} [ts]
   * @returns {{action: 'OPEN'|'ADD'|'HOLD'|'CLOSE', fill: Object|null, trade: Object|null}}
   */
  const applySignal = (type, price, ts = Date.now()) => {
    const action = resolveAction(type, lots.length > 0)
    const side = signalSide(type)

    if (side === lastSide) {
      return { action, fill: null, trade: null }
    }
    return applyFill(action, price, ts)
  }

  /**
   * Replay a journaled fill. Unlike applySignal this does not skip same-side
   * repeats — JSONL only records actual fills, so OPEN then ADD must both land
   * even with no intervening HOLD row.
   * @param {'OPEN'|'ADD'|'HOLD'|'CLOSE'} action
   * @param {number} price
   * @param {number} [ts]
   */
  const applyFill = (action, price, ts = Date.now()) => {
    if (action === 'HOLD') {
      lastSide = 'HOLD'
      return { action, fill: null, trade: null }
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { action, fill: null, trade: null }
    }
    if (action === 'OPEN' || action === 'ADD') {
      lastSide = 'BUY'
      lots.push({ entryPrice: price, entryTs: ts, action })
      if (lots.length > maxContracts) maxContracts = lots.length
      return {
        action,
        fill: { side: 'buy', action, contracts: 1, price, ts },
        trade: null,
      }
    }
    if (action === 'CLOSE' && lots.length > 0) {
      lastSide = 'SELL'
      const n = lots.length
      const avg = avgEntry()
      const pnl = round2(unrealizedAt(price))
      const trade = {
        contracts: n,
        avgEntry: round2(avg),
        exitPrice: price,
        pnl,
        openedAt: lots[0].entryTs,
        closedAt: ts,
        adds: n - 1,
      }
      realizedPnl = round8(realizedPnl + pnl)
      closedTrades.push(trade)
      lots = []
      return {
        action,
        fill: { side: 'sell', action, contracts: n, price, ts, pnl },
        trade,
      }
    }
    return { action, fill: null, trade: null }
  }

  /**
   * Replace book state (restart hydration).
   * @param {Object} [next]
   */
  const hydrate = (next = {}) => {
    lots = Array.isArray(next.lots) ? next.lots.filter(l => Number.isFinite(l?.entryPrice)).map(cloneLot) : []
    realizedPnl = Number.isFinite(next.realizedPnl) ? next.realizedPnl : 0
    closedTrades = Array.isArray(next.closedTrades) ? next.closedTrades.slice() : []
    maxContracts = Number.isFinite(next.maxContracts) ? next.maxContracts : lots.length
    lastSide = next.lastSide === 'BUY' || next.lastSide === 'SELL' || next.lastSide === 'HOLD'
      ? next.lastSide
      : (lots.length > 0 ? 'BUY' : 'HOLD')
  }

  const serialize = () => ({
    lots: lots.map(cloneLot),
    realizedPnl,
    closedTrades: closedTrades.slice(-200),
    maxContracts,
    lastSide,
  })

  return {
    applySignal,
    applyFill,
    snapshot,
    hydrate,
    serialize,
    isLong: () => lots.length > 0,
    contracts,
  }
}

module.exports = { createPerpBook }
