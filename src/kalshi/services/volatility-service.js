/**
 * Centralized Volatility Service
 *
 * Shared math and volatility functions extracted from strategies to eliminate DRY violations.
 * Provides: normalCDF, rolling/implied vol, probability calculations, sigma resolution.
 */

const SECONDS_PER_YEAR = 365.25 * 24 * 3600

/**
 * Normal CDF using Abramowitz & Stegun formula 26.2.17
 * Max error ~7.5e-8
 * @param {number} x
 * @returns {number}
 */
const normalCDF = (x) => {
  if (x > 8) return 1
  if (x < -8) return 0

  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1 / (1 + p * absX)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2)

  return 0.5 * (1 + sign * y)
}

/**
 * Calculate rolling volatility from price history
 * @param {Array<{price: number, timestamp: number}>} history
 * @param {number} windowSeconds
 * @returns {{ sigma: number, dataPoints: number } | null}
 */
const calculateRollingVolatility = (history, windowSeconds) => {
  if (!history?.length) return null

  const now = Date.now()
  const cutoff = now - windowSeconds * 1000
  const window = history.filter(h => h.timestamp >= cutoff)

  if (window.length < 2) return null

  const logReturns = []
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1].price <= 0 || window[i].price <= 0) continue
    logReturns.push(Math.log(window[i].price / window[i - 1].price))
  }

  if (logReturns.length < 2) return null

  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1)
  const stdev = Math.sqrt(variance)

  const totalTime = (window[window.length - 1].timestamp - window[0].timestamp) / 1000
  const avgInterval = totalTime / (window.length - 1)

  if (avgInterval < 0.1) return null

  const sigma = stdev * Math.sqrt(SECONDS_PER_YEAR / avgInterval)

  if (!Number.isFinite(sigma)) return null

  return { sigma, dataPoints: window.length }
}

/**
 * Calculate P(spot > strike) using log-normal model
 * @param {number} spot - Current spot price
 * @param {number} strike - Strike price
 * @param {number} secondsToSettlement - Time remaining
 * @param {number} sigma - Annualized volatility
 * @returns {number} Probability (0-1)
 */
const calculateAboveProbability = (spot, strike, secondsToSettlement, sigma) => {
  if (secondsToSettlement <= 1) return spot >= strike ? 0.98 : 0.02
  if (!sigma || sigma <= 0) return spot >= strike ? 0.85 : 0.15

  const tYears = secondsToSettlement / SECONDS_PER_YEAR
  const sqrtT = Math.sqrt(tYears)
  const denominator = sigma * spot * sqrtT

  if (denominator <= 0) return spot >= strike ? 0.85 : 0.15

  const d = (spot - strike) / denominator
  return normalCDF(d)
}

/**
 * Calculate fair probability for a market (bracket or binary)
 * For bracket markets: P(lower <= BTC < upper) = P(above lower) - P(above upper)
 * For binary markets: P(BTC > strike)
 * @param {number} spot
 * @param {number} strike - Midpoint of bracket (or strike for binary)
 * @param {number} secondsToSettlement
 * @param {number} sigma - Annualized volatility
 * @param {number} bracketWidth - Width of bracket ($250 for KXBTC), 0 for binary
 * @returns {number} Probability clamped to [0.02, 0.98]
 */
const calculateFairProbability = (spot, strike, secondsToSettlement, sigma, bracketWidth = 0) => {
  if (bracketWidth > 0) {
    // Strike is the midpoint of the bracket range, not the lower bound.
    // E.g. B67625 = range [$67,500, $67,750) with midpoint $67,625.
    const lowerBound = strike - bracketWidth / 2
    const upperBound = strike + bracketWidth / 2
    const pAboveLower = calculateAboveProbability(spot, lowerBound, secondsToSettlement, sigma)
    const pAboveUpper = calculateAboveProbability(spot, upperBound, secondsToSettlement, sigma)
    const bracketProb = pAboveLower - pAboveUpper
    if (bracketProb > 0.50 && (spot < lowerBound || spot >= upperBound)) {
      console.log(`[VOL] ⚠️ High bracket prob ${(bracketProb*100).toFixed(1)}% but spot $${spot.toFixed(0)} outside [${lowerBound}, ${upperBound})`)
    }
    return Math.max(0.02, Math.min(0.98, bracketProb))
  }
  return Math.max(0.02, Math.min(0.98, calculateAboveProbability(spot, strike, secondsToSettlement, sigma)))
}

/**
 * Resolve sigma with fallback chain:
 *   1. Implied vol from bracket analytics (if reliable)
 *   2. Rolling vol from price history
 *   3. Default fallback (0.55 — better calibrated than the old 0.70)
 *
 * @param {Object} options
 * @param {Object} [options.bracketData] - Bracket analytics data for the ticker
 * @param {Array<{price: number, timestamp: number}>} [options.priceHistory] - Coinbase/composite price history
 * @param {number} [options.volatilityWindow=300] - Rolling vol window in seconds
 * @param {number} [options.minSigma=0.40] - Floor for sigma
 * @returns {{ sigma: number, source: 'implied' | 'rolling' | 'default', dataPoints: number }}
 */
const getSigma = ({ bracketData, priceHistory, volatilityWindow = 300, minSigma = 0.40 } = {}) => {
  // 1a. Skew-adjusted sigma for this specific bracket (most accurate for OTM)
  if (bracketData?.skewSigma && bracketData?.skewParams?.reliable) {
    return {
      sigma: Math.max(bracketData.skewSigma, minSigma),
      source: 'skew',
      dataPoints: bracketData.impliedVol?.bracketCount || 0
    }
  }

  // 1b. Flat implied vol from bracket analytics
  if (bracketData?.impliedVol?.reliable) {
    return {
      sigma: Math.max(bracketData.impliedVol.sigma, minSigma),
      source: 'implied',
      dataPoints: bracketData.impliedVol.bracketCount || 0
    }
  }

  // 2. Rolling vol from price history
  if (priceHistory?.length >= 2) {
    const vol = calculateRollingVolatility(priceHistory, volatilityWindow)
    if (vol) {
      return {
        sigma: Math.max(vol.sigma, minSigma),
        source: 'rolling',
        dataPoints: vol.dataPoints
      }
    }
  }

  // 3. Default fallback (0.55 better calibrated than old 0.70)
  return { sigma: 0.55, source: 'default', dataPoints: 0 }
}

/**
 * Check if market has valid liquidity and determine pricing.
 * Shared between all strategies that need bid/ask/lastPrice validation.
 * @param {Object} priceData - Price data from Kalshi
 * @returns {{ valid: boolean, reason?: string, yesBid: number, yesAsk: number, lastPrice: number, useLastPrice: boolean }}
 */
const checkLiquidity = (priceData) => {
  const yesBid = priceData?.yesBid ?? 0
  const yesAsk = priceData?.yesAsk ?? 100
  const lastPrice = priceData?.lastPrice ?? 0

  const hasBidAsk = yesBid > 1 && yesAsk < 99

  if (hasBidAsk) {
    const spread = yesAsk - yesBid
    if (spread > 30) {
      return { valid: false, reason: `spread too wide: ${spread}¢`, yesBid, yesAsk, lastPrice, useLastPrice: false }
    }
    return { valid: true, yesBid, yesAsk, lastPrice, useLastPrice: false }
  }

  if (lastPrice <= 0) {
    return { valid: false, reason: 'no price data', yesBid, yesAsk, lastPrice, useLastPrice: true }
  }

  if (lastPrice <= 5 || lastPrice >= 95) {
    return { valid: false, reason: `lastPrice ${lastPrice}¢ at extreme (market likely settled)`, yesBid, yesAsk, lastPrice, useLastPrice: true }
  }

  return {
    valid: true,
    yesBid: Math.max(1, lastPrice - 2),
    yesAsk: Math.min(99, lastPrice + 2),
    lastPrice,
    useLastPrice: true
  }
}

/**
 * Kalshi taker fee: roundUp(0.07 × contracts × price × (1 - price))
 * @param {number} contracts
 * @param {number} priceInCents - Price in cents (1-99)
 * @param {'taker' | 'maker'} orderType
 * @returns {number} Fee in dollars
 */
const calculateKalshiFee = (contracts, priceInCents, orderType = 'taker') => {
  const price = priceInCents / 100
  const coefficient = orderType === 'maker' ? 0.0175 : 0.07
  return Math.ceil(coefficient * contracts * price * (1 - price) * 100) / 100
}

/**
 * Calculate net expected profit per contract after fees and slippage.
 *
 * For binary options paying $1: probability edge IS dollars per contract.
 * modelEdge = 0.05 means we expect $0.05/contract gross profit.
 * We subtract per-contract fees (entry + exit) and slippage cost.
 *
 * @param {number} modelEdge - Raw probability edge (e.g., 0.05 = 5%)
 * @param {number} contracts - Planned contracts
 * @param {number} priceInCents - Expected fill price in cents
 * @param {number} [slippageCents=1] - Expected slippage in cents
 * @returns {{ netEdge: number, feePerContract: number, slippagePerContract: number }}
 */
const calculateNetEdge = (modelEdge, contracts, priceInCents, slippageCents = 1) => {
  // Fee per contract (entry + estimated exit) in dollars
  const entryFeeTotal = calculateKalshiFee(contracts, priceInCents)
  const exitFeeTotal = calculateKalshiFee(contracts, priceInCents) // approximate
  const feePerContract = contracts > 0 ? (entryFeeTotal + exitFeeTotal) / contracts : 0

  // Slippage cost per contract in dollars (cents / 100)
  const slippagePerContract = slippageCents / 100

  // modelEdge is probability edge = expected gross $ per contract (binary pays $1)
  const netEdge = modelEdge - feePerContract - slippagePerContract
  return { netEdge, feePerContract, slippagePerContract }
}

module.exports = {
  normalCDF,
  calculateRollingVolatility,
  calculateAboveProbability,
  calculateFairProbability,
  getSigma,
  checkLiquidity,
  calculateKalshiFee,
  calculateNetEdge
}
