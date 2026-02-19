// @ts-check
/**
 * Hedge State Manager
 *
 * Paired position state persistence using atomic JSON writes.
 * Tracks active pairs, closed pairs, daily stats, aggregate stats, MAE/MFE.
 */

const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'hedge', 'state.json')

/**
 * Atomic write: .tmp then rename
 * @param {string} filePath
 * @param {string} data
 */
const atomicWriteSync = (filePath, data) => {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, data)
  fs.renameSync(tmpPath, filePath)
}

/**
 * Create empty initial state
 * @returns {Object}
 */
const createInitialState = () => ({
  activePairs: [],
  closedPairs: [],
  dailyStats: {
    date: new Date().toISOString().slice(0, 10),
    pairs: 0,
    pnl: 0,
    wins: 0,
    losses: 0,
    doubleLosses: 0,
    hedgeSuccesses: 0,
    skipped: 0,
    evaluated: 0,
  },
  aggregateStats: {
    totalPairs: 0,
    totalPnl: 0,
    hedgeDrag: 0,
    doubleLossRate: 0,
    hedgeSuccessRate: 0,
    avgMAE: 0,
    avgMFE: 0,
    skipRate: 0,
    totalKalshiPremiumsPaid: 0,
    totalKalshiPayoutsReceived: 0,
  },
  consecutiveLosses: 0,
  lastEntryTime: null,
  engineRunning: false,
})

/**
 * Load state from disk
 * @returns {Object}
 */
const loadState = () => {
  if (!fs.existsSync(STATE_FILE)) return createInitialState()
  const raw = fs.readFileSync(STATE_FILE, 'utf8').trim()
  if (!raw) return createInitialState()
  const state = JSON.parse(raw)

  // Reset daily stats if date changed
  const today = new Date().toISOString().slice(0, 10)
  if (state.dailyStats?.date !== today) {
    state.dailyStats = { ...createInitialState().dailyStats, date: today }
  }

  return state
}

/**
 * Save state to disk atomically
 * @param {Object} state
 */
const saveState = (state) => {
  atomicWriteSync(STATE_FILE, JSON.stringify(state, null, 2))
}

/**
 * Create a new hedge pair entry
 * @param {Object} params
 * @param {string} params.exitMode - 'hybrid'|'settlement_aligned'|'exchange_native'
 * @param {Object} params.exchange - Exchange leg details
 * @param {Object} params.kalshi - Kalshi leg details
 * @returns {Object} New pair object
 */
const createPair = ({ exitMode, exchange, kalshi }) => ({
  id: uuidv4(),
  openedAt: new Date().toISOString(),
  status: 'active',
  exitMode,
  exchange: {
    buyOrderId: exchange.buyOrderId,
    stopOrderId: exchange.stopOrderId || null,
    entryPrice: exchange.entryPrice,
    btcAmount: exchange.btcAmount,
    stopPrice: exchange.stopPrice || null,
    tpPrice: exchange.tpPrice || null,
    entryFee: exchange.entryFee || 0,
    exitPrice: null,
    exitFee: null,
    mae: 0,
    mfe: 0,
  },
  kalshi: {
    ticker: kalshi.ticker,
    series: kalshi.series,
    orderId: kalshi.orderId,
    contracts: kalshi.contracts,
    entryPriceCents: kalshi.entryPriceCents,
    fee: kalshi.fee || 0,
    closeTime: kalshi.closeTime,
    bracketStrike: kalshi.bracketStrike,
    bracketWidth: kalshi.bracketWidth || 0,
    outcome: null,
    payout: null,
    settledDown: null,
  },
  pnl: {
    exchangePnl: null,
    kalshiPnl: null,
    totalFees: null,
    netPnl: null,
  },
  resultType: null,
})

/**
 * Add a new active pair
 * @param {Object} state
 * @param {Object} pair
 * @returns {Object} Updated state
 */
const addActivePair = (state, pair) => {
  state.activePairs.push(pair)
  state.lastEntryTime = Date.now()
  state.dailyStats.pairs++
  state.dailyStats.evaluated++
  saveState(state)
  return state
}

/**
 * Update MAE/MFE for an active pair based on current price
 * @param {Object} state
 * @param {string} pairId
 * @param {number} currentPrice - Current BTC price
 * @returns {Object} Updated state
 */
const updateExcursions = (state, pairId, currentPrice) => {
  const pair = state.activePairs.find(p => p.id === pairId)
  if (!pair) return state

  const entryPrice = pair.exchange.entryPrice
  const pctChange = ((currentPrice - entryPrice) / entryPrice) * 100

  // MAE: maximum adverse excursion (most negative move)
  if (pctChange < pair.exchange.mae) {
    pair.exchange.mae = pctChange
  }

  // MFE: maximum favorable excursion (most positive move)
  if (pctChange > pair.exchange.mfe) {
    pair.exchange.mfe = pctChange
  }

  // Don't save on every tick — caller batches saves
  return state
}

/**
 * Close an active pair and move to closed pairs
 * @param {Object} state
 * @param {string} pairId
 * @param {Object} result
 * @param {number} result.exitPrice - BTC exit price
 * @param {number} result.exitFee - Exchange exit fee
 * @param {string} result.resultType - 'tp_win'|'sl_hedged'|'double_loss'|'settlement_exit'|'manual_exit'
 * @param {boolean|null} result.kalshiSettledDown - Whether Kalshi settled down
 * @param {number|null} result.kalshiPayout - Kalshi payout in USD
 * @returns {Object} Updated state
 */
const closePair = (state, pairId, result) => {
  const idx = state.activePairs.findIndex(p => p.id === pairId)
  if (idx === -1) return state

  const pair = state.activePairs[idx]

  // Exchange P&L
  const entryValue = pair.exchange.btcAmount * pair.exchange.entryPrice
  const exitValue = pair.exchange.btcAmount * result.exitPrice
  const exchangePnl = exitValue - entryValue - pair.exchange.entryFee - (result.exitFee || 0)

  // Kalshi P&L
  const kalshiCost = (pair.kalshi.contracts * pair.kalshi.entryPriceCents) / 100 + pair.kalshi.fee
  const kalshiPayout = result.kalshiPayout ?? 0
  const kalshiPnl = kalshiPayout - kalshiCost

  // Total P&L
  const totalFees = pair.exchange.entryFee + (result.exitFee || 0) + pair.kalshi.fee
  const netPnl = exchangePnl + kalshiPnl

  // Update pair
  pair.exchange.exitPrice = result.exitPrice
  pair.exchange.exitFee = result.exitFee || 0
  pair.kalshi.outcome = result.resultType
  pair.kalshi.settledDown = result.kalshiSettledDown
  pair.kalshi.payout = kalshiPayout
  pair.pnl = { exchangePnl, kalshiPnl, totalFees, netPnl }
  pair.resultType = result.resultType
  pair.status = 'closed'
  pair.closedAt = new Date().toISOString()

  // Move from active to closed
  state.activePairs.splice(idx, 1)
  state.closedPairs.push(pair)

  // Keep closed pairs bounded (last 500)
  if (state.closedPairs.length > 500) {
    state.closedPairs = state.closedPairs.slice(-500)
  }

  // Update daily stats
  state.dailyStats.pnl += netPnl
  if (netPnl >= 0) {
    state.dailyStats.wins++
    state.consecutiveLosses = 0
  } else {
    state.dailyStats.losses++
    state.consecutiveLosses++
  }

  if (result.resultType === 'double_loss') {
    state.dailyStats.doubleLosses++
  }
  if (result.resultType === 'sl_hedged') {
    state.dailyStats.hedgeSuccesses++
  }

  // Update aggregate stats
  updateAggregateStats(state)

  saveState(state)
  return state
}

/**
 * Record a skipped evaluation
 * @param {Object} state
 * @returns {Object} Updated state
 */
const recordSkip = (state) => {
  state.dailyStats.evaluated++
  state.dailyStats.skipped++
  // Don't save on every skip — too noisy. Caller saves periodically.
  return state
}

/**
 * Recalculate aggregate stats from closed pairs
 * @param {Object} state
 */
const updateAggregateStats = (state) => {
  const pairs = state.closedPairs
  if (pairs.length === 0) return

  const totalPairs = pairs.length
  const totalPnl = pairs.reduce((sum, p) => sum + (p.pnl?.netPnl ?? 0), 0)
  const doubleLosses = pairs.filter(p => p.resultType === 'double_loss').length
  const hedgeSuccesses = pairs.filter(p => p.resultType === 'sl_hedged').length
  const totalKalshiPremiumsPaid = pairs.reduce((sum, p) => {
    return sum + ((p.kalshi.contracts * p.kalshi.entryPriceCents) / 100 + p.kalshi.fee)
  }, 0)
  const totalKalshiPayoutsReceived = pairs.reduce((sum, p) => sum + (p.kalshi.payout ?? 0), 0)

  const maeValues = pairs.filter(p => p.exchange?.mae != null).map(p => p.exchange.mae)
  const mfeValues = pairs.filter(p => p.exchange?.mfe != null).map(p => p.exchange.mfe)

  const totalEvaluated = state.dailyStats.evaluated || 1

  state.aggregateStats = {
    totalPairs,
    totalPnl,
    hedgeDrag: totalKalshiPremiumsPaid - totalKalshiPayoutsReceived,
    doubleLossRate: totalPairs > 0 ? doubleLosses / totalPairs : 0,
    hedgeSuccessRate: totalPairs > 0 ? hedgeSuccesses / totalPairs : 0,
    avgMAE: maeValues.length > 0 ? maeValues.reduce((s, v) => s + v, 0) / maeValues.length : 0,
    avgMFE: mfeValues.length > 0 ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : 0,
    skipRate: totalEvaluated > 0 ? (state.dailyStats.skipped || 0) / totalEvaluated : 0,
    totalKalshiPremiumsPaid,
    totalKalshiPayoutsReceived,
  }
}

/**
 * Get the active pair (if any)
 * @param {Object} state
 * @returns {Object|null}
 */
const getActivePair = (state) => state.activePairs[0] || null

/**
 * Set engine running flag
 * @param {Object} state
 * @param {boolean} running
 * @returns {Object} Updated state
 */
const setEngineRunning = (state, running) => {
  state.engineRunning = running
  saveState(state)
  return state
}

module.exports = {
  createInitialState,
  loadState,
  saveState,
  createPair,
  addActivePair,
  updateExcursions,
  closePair,
  recordSkip,
  updateAggregateStats,
  getActivePair,
  setEngineRunning,
}
