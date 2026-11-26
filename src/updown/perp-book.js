// @ts-check
/**
 * Simulated 0.01-BTC-per-contract perpetual-long book.
 *
 * Every OPEN or ADD buys one 0.01 BTC contract. CLOSE sells the entire book.
 * Same-side repeats (BUY staying BUY, or BUY→STRONG_BUY) do not
 * pyramid — a new fill requires a side change (Hold→Buy while already long
 * is ADD; Buy→Sell is CLOSE).
 *
 * P&L includes adverse execution slippage and a USD fee per contract per side
 * when configured. Open P&L estimates the net proceeds of flattening at the mark.
 */

const { resolveAction, signalSide } = require('./signal-actions')
const { PERP_CONTRACT_SIZE_BTC, calculatePerpPnl } = require('./perp-contract')

const { round2 } = require('../value-guards')
const round8 = (n) => Math.round(n * 1e8) / 1e8

const livePerpCosts = (env = process.env) => {
  const read = (value, fallback, max = Infinity) => {
    const n = value?.trim() ? Number(value) : fallback
    return Number.isFinite(n) && n >= 0 && n < max ? n : fallback
  }
  return {
    feePerContract: read(env.UPDOWN_PERP_FEE_PER_CONTRACT, 0.5),
    slippageBps: read(env.UPDOWN_PERP_SLIPPAGE_BPS, 2, 10000),
  }
}

const cloneLot = (lot) => ({
  entryPrice: lot.entryPrice,
  executionPrice: lot.executionPrice,
  entryFee: lot.entryFee,
  entryTs: lot.entryTs,
  action: lot.action,
})

const normalizeClosedTrade = (trade, pnlScale) => ({
  ...trade,
  pnl: Number.isFinite(trade?.pnl) ? round8(trade.pnl * pnlScale) : trade?.pnl,
})

/**
 * @param {Object} [initial]
 * @param {Array<{entryPrice: number, executionPrice?: number, entryFee?: number, entryTs: number, action?: string}>} [initial.lots]
 * @param {number} [initial.realizedPnl]
 * @param {Array<Object>} [initial.closedTrades]
 * @param {number} [initial.maxContracts]
 * @param {'BUY'|'SELL'|'HOLD'} [initial.lastSide]
 * @param {{feePerContract?: number, slippageBps?: number}} [costs]
 */
const createPerpBook = (initial = {}, { feePerContract = 0, slippageBps = 0 } = {}) => {
  if (!Number.isFinite(feePerContract) || feePerContract < 0 ||
      !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
    throw new RangeError('Invalid perp execution costs')
  }
  let lots = []
  let realizedPnl = 0
  let closedTrades = []
  let maxContracts = 0
  let lastSide = 'HOLD'
  let open = false
  let hasLegacyRealizedPnl = false

  const executionAt = (price, side) => price * (1 + side * slippageBps / 10000)
  const exitFees = () => lots.length * feePerContract
  const entryFees = () => lots.reduce((sum, lot) => sum + lot.entryFee, 0)
  const netAt = (execution) => lots.reduce((sum, lot) =>
    sum + calculatePerpPnl(lot.executionPrice, execution, 1), 0) - entryFees() - exitFees()

  const isLong = () => open || lots.length > 0
  const contracts = () => lots.length

  const avgEntry = () => {
    if (lots.length === 0) return 0
    return lots.reduce((s, l) => s + l.executionPrice, 0) / lots.length
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
    const markAvailable = Number.isFinite(markPrice) && markPrice > 0
    const unrealized = markAvailable ? netAt(executionAt(markPrice, -1)) : 0
    const stats = closedStats()
    return {
      contracts: n,
      contractSizeBtc: PERP_CONTRACT_SIZE_BTC,
      btcSize: round8(n * PERP_CONTRACT_SIZE_BTC),
      avgEntry: n > 0 ? round2(avgEntry()) : 0,
      realizedPnl: round2(realizedPnl),
      unrealizedPnl: round2(unrealized),
      totalPnl: round2(realizedPnl + unrealized),
      markAvailable,
      feePerContract,
      slippageBps,
      hasLegacyRealizedPnl,
      maxContracts,
      lastSide,
      ...stats,
      lots: lots.map(cloneLot),
      closedTrades: closedTrades.slice(-50),
    }
  }

  /**
   * The action for a published type given this book. A same-side repeat fills
   * nothing, so it is HOLD rather than the OPEN/ADD it would otherwise read as.
   * @param {string} type
   * @returns {'OPEN'|'ADD'|'HOLD'|'CLOSE'}
   */
  const actionFor = (type) => {
    const action = resolveAction(type, isLong())
    return action !== 'CLOSE' && signalSide(type) === lastSide ? 'HOLD' : action
  }

  /**
   * Apply a published engine type at `price`. Same-side repeats do not fill.
   * @param {string} type - BUY / STRONG_BUY / NEUTRAL / SELL / STRONG_SELL / NO_TRADE_ZONE
   * @param {number} price
   * @param {number} [ts]
   * @returns {{action: 'OPEN'|'ADD'|'HOLD'|'CLOSE', fill: Object|null, trade: Object|null}}
   */
  const applySignal = (type, price, ts = Date.now()) => {
    const action = actionFor(type)
    // CLOSE must flatten even if lastSide is already HOLD (BUY faded to NEUTRAL).
    if (action === 'CLOSE') return applyFill(action, price, ts)
    if (signalSide(type) === lastSide) {
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
    if (action === 'CLOSE') {
      // An unavailable mark cannot settle or discard an open position.
      if (!Number.isFinite(price) || price <= 0) return { action, fill: null, trade: null }
      lastSide = 'SELL'
      open = false
      if (lots.length === 0) {
        lots = []
        return { action, fill: null, trade: null }
      }
      const n = lots.length
      const avg = avgEntry()
      const executionPrice = executionAt(price, -1)
      const feeUsd = exitFees()
      const pnl = round2(netAt(executionPrice))
      const trade = {
        contracts: n,
        avgEntry: round2(avg),
        exitPrice: executionPrice,
        feesUsd: round8(entryFees() + feeUsd),
        pnl,
        openedAt: lots[0].entryTs,
        closedAt: ts,
        adds: n - 1,
        contractSizeBtc: PERP_CONTRACT_SIZE_BTC,
        btcSize: round8(n * PERP_CONTRACT_SIZE_BTC),
      }
      realizedPnl = round8(realizedPnl + pnl)
      closedTrades.push(trade)
      lots = []
      return {
        action,
        fill: { side: 'sell', action, contracts: n, price, executionPrice, feeUsd, ts, pnl },
        trade,
      }
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { action, fill: null, trade: null }
    }
    if (action === 'OPEN' || action === 'ADD') {
      lastSide = 'BUY'
      open = true
      const executionPrice = executionAt(price, 1)
      lots.push({ entryPrice: price, executionPrice, entryFee: feePerContract, entryTs: ts, action })
      if (lots.length > maxContracts) maxContracts = lots.length
      return {
        action,
        fill: { side: 'buy', action, contracts: 1, price, executionPrice, feeUsd: feePerContract, ts },
        trade: null,
      }
    }
    return { action, fill: null, trade: null }
  }

  /**
   * Replace book state (restart hydration).
   * @param {Object} [next]
   */
  const hydrate = (next = {}) => {
    lots = Array.isArray(next.lots) ? next.lots.filter(l => Number.isFinite(l?.entryPrice)).map(lot => ({
        ...cloneLot(lot),
        executionPrice: Number.isFinite(lot.executionPrice) ? lot.executionPrice : executionAt(lot.entryPrice, 1),
        entryFee: Number.isFinite(lot.entryFee) ? lot.entryFee : feePerContract,
      })) : []
    // Pre-contractSizeBtc state reported dollars as if a contract were 1 BTC.
    const previousContractSize = Number.isFinite(next.contractSizeBtc) && next.contractSizeBtc > 0
      ? next.contractSizeBtc
      : 1
    const pnlScale = PERP_CONTRACT_SIZE_BTC / previousContractSize
    realizedPnl = Number.isFinite(next.realizedPnl) ? next.realizedPnl * pnlScale : 0
    closedTrades = Array.isArray(next.closedTrades)
      ? next.closedTrades.map(trade => normalizeClosedTrade(trade, pnlScale))
      : []
    hasLegacyRealizedPnl = next.hasLegacyRealizedPnl === true ||
      (next.hasLegacyRealizedPnl == null && (realizedPnl !== 0 || closedTrades.some(t => !Number.isFinite(t.feesUsd))))
    maxContracts = Number.isFinite(next.maxContracts) ? next.maxContracts : lots.length
    lastSide = next.lastSide === 'BUY' || next.lastSide === 'SELL' || next.lastSide === 'HOLD'
      ? next.lastSide
      : (lots.length > 0 ? 'BUY' : 'HOLD')
    open = next.open === true || lots.length > 0
  }

  const serialize = () => ({
    contractSizeBtc: PERP_CONTRACT_SIZE_BTC,
    lots: lots.map(cloneLot),
    realizedPnl,
    hasLegacyRealizedPnl,
    closedTrades: closedTrades.slice(-200),
    maxContracts,
    lastSide,
    open: isLong(),
  })

  hydrate(initial)
  return {
    actionFor,
    applySignal,
    applyFill,
    snapshot,
    hydrate,
    serialize,
    isLong,
    contracts,
  }
}

module.exports = { createPerpBook, livePerpCosts }
