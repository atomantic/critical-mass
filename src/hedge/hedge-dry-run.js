// @ts-check
/**
 * Hedge Dry-Run Simulator
 *
 * Simulation using real market data with synthetic fill model,
 * path-dependent P&L tracking, per-trade metrics, aggregate statistics,
 * and decision report generation.
 */

const { log } = require('../logger')
const fs = require('fs')
const path = require('path')

const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'hedge')

const ts = () => `[HEDGE] ${new Date().toISOString().slice(11, 23)}`

/**
 * Create a dry-run tracker that wraps around the hedge engine state
 * to capture path-dependent metrics that the live engine doesn't need.
 *
 * @param {Object} state - Hedge engine state reference
 * @returns {Object} Dry-run tracker methods
 */
const createDryRunTracker = (state) => {
  /** @type {Map<string, Object>} Per-pair path tracking */
  const pathTrackers = new Map()

  /**
   * Start tracking a new pair's price path
   * @param {string} pairId
   * @param {number} entryPrice
   * @param {number} stopPrice
   * @param {number} tpPrice
   * @param {string} kalshiTicker
   * @param {number} kalshiEntryPriceCents
   */
  const startTracking = (pairId, entryPrice, stopPrice, tpPrice, kalshiTicker, kalshiEntryPriceCents) => {
    pathTrackers.set(pairId, {
      pairId,
      entryPrice,
      stopPrice,
      tpPrice,
      kalshiTicker,
      kalshiEntryPriceCents,
      pricePath: [{ price: entryPrice, timestamp: Date.now() }],
      slWouldHaveHit: false,
      slHitTimestamp: null,
      tpWouldHaveHit: false,
      tpHitTimestamp: null,
      btcMAE: 0,
      btcMFE: 0,
      kalshiPriceAtEntry: kalshiEntryPriceCents,
      kalshiPriceAtMidpoint: null,
      kalshiPriceAtSettlement: null,
      btcPriceAtSettlement: null,
    })
  }

  /**
   * Record a tick in the price path
   * @param {string} pairId
   * @param {number} price
   */
  const recordTick = (pairId, price) => {
    const tracker = pathTrackers.get(pairId)
    if (!tracker) return

    tracker.pricePath.push({ price, timestamp: Date.now() })

    // Keep path bounded (last 10000 ticks)
    if (tracker.pricePath.length > 10000) {
      tracker.pricePath = tracker.pricePath.slice(-10000)
    }

    const pctFromEntry = ((price - tracker.entryPrice) / tracker.entryPrice) * 100

    // MAE/MFE
    if (pctFromEntry < tracker.btcMAE) tracker.btcMAE = pctFromEntry
    if (pctFromEntry > tracker.btcMFE) tracker.btcMFE = pctFromEntry

    // SL path check
    if (!tracker.slWouldHaveHit && price <= tracker.stopPrice) {
      tracker.slWouldHaveHit = true
      tracker.slHitTimestamp = Date.now()
    }

    // TP path check
    if (!tracker.tpWouldHaveHit && price >= tracker.tpPrice) {
      tracker.tpWouldHaveHit = true
      tracker.tpHitTimestamp = Date.now()
    }
  }

  /**
   * Record settlement data
   * @param {string} pairId
   * @param {number} btcPriceAtSettlement
   * @param {boolean} kalshiSettledDown
   * @param {number} kalshiPriceAtSettlement
   */
  const recordSettlement = (pairId, btcPriceAtSettlement, kalshiSettledDown, kalshiPriceAtSettlement) => {
    const tracker = pathTrackers.get(pairId)
    if (!tracker) return

    tracker.btcPriceAtSettlement = btcPriceAtSettlement
    tracker.kalshiPriceAtSettlement = kalshiPriceAtSettlement
    tracker.kalshiSettledDown = kalshiSettledDown
  }

  /**
   * Get per-trade metrics for a completed pair
   * @param {string} pairId
   * @returns {Object|null}
   */
  const getTradeMetrics = (pairId) => {
    const tracker = pathTrackers.get(pairId)
    if (!tracker) return null

    const pair = [...(state.closedPairs || []), ...(state.activePairs || [])].find(p => p.id === pairId)
    if (!pair) return null

    return {
      pairId,
      kalshiPriceAtEntry: tracker.kalshiEntryPriceCents,
      btcEntryPrice: tracker.entryPrice,
      btcMAE: tracker.btcMAE,
      btcMFE: tracker.btcMFE,
      slWouldHaveHit: tracker.slWouldHaveHit,
      kalshiSettledDown: tracker.kalshiSettledDown ?? pair.kalshi?.settledDown,
      btcPriceAtSettlement: tracker.btcPriceAtSettlement,
      exchangePnl: pair.pnl?.exchangePnl ?? null,
      kalshiPnl: pair.pnl?.kalshiPnl ?? null,
      netPnl: pair.pnl?.netPnl ?? null,
      resultType: pair.resultType,
      pathLength: tracker.pricePath.length,
    }
  }

  /**
   * Clean up tracker for a pair
   * @param {string} pairId
   */
  const stopTracking = (pairId) => {
    pathTrackers.delete(pairId)
  }

  return {
    startTracking,
    recordTick,
    recordSettlement,
    getTradeMetrics,
    stopTracking,
    getActiveTrackers: () => [...pathTrackers.keys()],
  }
}

/**
 * Generate aggregate decision report from state
 * @param {Object} state - Hedge engine state
 * @param {Object} dryRunTracker - Dry-run tracker instance
 * @returns {Object} Report object
 */
const generateDecisionReport = (state, dryRunTracker) => {
  const closedPairs = state.closedPairs || []

  if (closedPairs.length === 0) {
    return { status: 'insufficient_data', message: 'No completed pairs yet', recommendation: 'Continue dry-run' }
  }

  // Classify results
  const tpWins = closedPairs.filter(p => p.resultType === 'tp_win')
  const slHedged = closedPairs.filter(p => p.resultType === 'sl_hedged')
  const doubleLosses = closedPairs.filter(p => p.resultType === 'double_loss')
  const settlementExits = closedPairs.filter(p => p.resultType === 'settlement_exit')

  // P&L analysis
  const totalNetPnl = closedPairs.reduce((s, p) => s + (p.pnl?.netPnl ?? 0), 0)
  const totalExchangePnl = closedPairs.reduce((s, p) => s + (p.pnl?.exchangePnl ?? 0), 0)
  const totalKalshiPnl = closedPairs.reduce((s, p) => s + (p.pnl?.kalshiPnl ?? 0), 0)

  // Hedge drag
  const totalPremiumsPaid = closedPairs.reduce((s, p) => {
    return s + ((p.kalshi?.contracts ?? 0) * (p.kalshi?.entryPriceCents ?? 0)) / 100 + (p.kalshi?.fee ?? 0)
  }, 0)
  const totalPayoutsReceived = closedPairs.reduce((s, p) => s + (p.kalshi?.payout ?? 0), 0)
  const hedgeDrag = totalPremiumsPaid - totalPayoutsReceived

  // Rates
  const doubleLossRate = closedPairs.length > 0 ? doubleLosses.length / closedPairs.length : 0
  const hedgeSuccessRate = closedPairs.length > 0 ? slHedged.length / closedPairs.length : 0
  const winRate = closedPairs.length > 0 ? (tpWins.length + slHedged.length) / closedPairs.length : 0

  // MAE/MFE averages
  const maeValues = closedPairs.filter(p => p.exchange?.mae != null).map(p => p.exchange.mae)
  const mfeValues = closedPairs.filter(p => p.exchange?.mfe != null).map(p => p.exchange.mfe)
  const avgMAE = maeValues.length > 0 ? maeValues.reduce((s, v) => s + v, 0) / maeValues.length : 0
  const avgMFE = mfeValues.length > 0 ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : 0

  // Skip rate
  const skipRate = state.aggregateStats?.skipRate ?? 0

  // Per-trade metrics (if dry-run tracker available)
  const tradeMetrics = closedPairs
    .map(p => dryRunTracker?.getTradeMetrics(p.id))
    .filter(Boolean)

  // Decision criteria
  const issues = []
  if (doubleLossRate > 0.1) issues.push(`Double-loss rate ${(doubleLossRate * 100).toFixed(1)}% > 10% threshold`)
  if (totalNetPnl < 0) issues.push(`Net P&L is negative: $${totalNetPnl.toFixed(2)}`)
  if (hedgeDrag > Math.abs(totalExchangePnl) * 0.5) issues.push(`Hedge drag ($${hedgeDrag.toFixed(2)}) exceeds 50% of exchange P&L`)
  if (closedPairs.length < 20) issues.push(`Only ${closedPairs.length} completed pairs — need more data`)

  let recommendation
  if (issues.length === 0 && closedPairs.length >= 20) {
    recommendation = 'GO — all metrics within acceptable ranges'
  } else if (issues.length > 2) {
    recommendation = 'NO-GO — multiple critical issues detected'
  } else {
    recommendation = 'CAUTION — review issues before proceeding'
  }

  const report = {
    status: recommendation.startsWith('GO') ? 'go' : recommendation.startsWith('NO') ? 'no_go' : 'caution',
    recommendation,
    issues,
    summary: {
      totalPairs: closedPairs.length,
      tpWins: tpWins.length,
      slHedged: slHedged.length,
      doubleLosses: doubleLosses.length,
      settlementExits: settlementExits.length,
    },
    pnl: {
      totalNetPnl,
      totalExchangePnl,
      totalKalshiPnl,
      hedgeDrag,
      avgPnlPerTrade: closedPairs.length > 0 ? totalNetPnl / closedPairs.length : 0,
    },
    rates: {
      doubleLossRate,
      hedgeSuccessRate,
      winRate,
      skipRate,
    },
    excursions: {
      avgMAE,
      avgMFE,
    },
    tradeMetrics,
    generatedAt: new Date().toISOString(),
  }

  return report
}

/**
 * Save decision report to disk
 * @param {Object} report
 * @returns {string} File path
 */
const saveDecisionReport = (report) => {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true })

  const filename = `decision-report-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`
  const filepath = path.join(REPORT_DIR, filename)
  const tmpPath = `${filepath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2))
  fs.renameSync(tmpPath, filepath)

  log('INFO', `[${ts()}] 📄 hedge decision report saved: ${filename}`)
  return filepath
}

module.exports = {
  createDryRunTracker,
  generateDecisionReport,
  saveDecisionReport,
}
