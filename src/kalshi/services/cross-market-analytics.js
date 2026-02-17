/**
 * Cross-Market Analytics
 *
 * Computes analytics across related bracket markets for the same settlement:
 * 1. Bracket sum — total YES probability (should be ~100%, deviation = mispricing signal)
 * 2. Implied volatility — market-consensus sigma backed out from bracket prices
 * 3. Per-bracket mispricing — model vs market probability using implied vol
 * 4. Adjacent bracket context — neighboring bracket prices
 */

const { normalCDF } = require('./volatility-service')

const SECONDS_PER_YEAR = 365.25 * 24 * 3600

/**
 * Model probability for a bracket [lower, lower+width)
 * @param {number} spot - Current spot price
 * @param {number} lower - Lower bound of bracket
 * @param {number} width - Bracket width (e.g., 250)
 * @param {number} sigma - Annualized volatility
 * @param {number} T - Seconds to settlement
 * @returns {number}
 */
const bracketProbability = (spot, lower, width, sigma, T) => {
  if (T <= 1) return (spot >= lower && spot < lower + width) ? 0.98 : 0.02
  const tYears = T / SECONDS_PER_YEAR
  const sqrtT = Math.sqrt(tYears)
  const denom = sigma * spot * sqrtT
  if (denom <= 0) return 0.02
  const dLower = (spot - lower) / denom
  const dUpper = (spot - (lower + width)) / denom
  return Math.max(0.001, normalCDF(dLower) - normalCDF(dUpper))
}

/**
 * Fit implied volatility via grid search over sigma.
 * Minimizes sum of squared errors between model and market bracket probabilities.
 * @param {Array<{lower: number, width: number, marketProb: number}>} brackets
 * @param {number} spot
 * @param {number} secondsToSettlement
 * @returns {{ sigma: number, rmse: number, bracketCount: number, reliable: boolean } | null}
 */
const fitImpliedVol = (brackets, spot, secondsToSettlement) => {
  if (brackets.length < 3 || secondsToSettlement <= 5) return null

  const priced = brackets.filter(b => b.marketProb > 0.01 && b.marketProb < 0.99)
  if (priced.length < 3) return null

  let bestSigma = 0.50
  let bestError = Infinity

  // Grid search: 20% to 200% annualized vol in 2% steps
  for (let sigma = 0.20; sigma <= 2.0; sigma += 0.02) {
    let error = 0
    for (const b of priced) {
      const modelProb = bracketProbability(spot, b.lower, b.width, sigma, secondsToSettlement)
      error += (modelProb - b.marketProb) ** 2
    }
    if (error < bestError) {
      bestError = error
      bestSigma = sigma
    }
  }

  const rmse = Math.sqrt(bestError / priced.length)

  return {
    sigma: bestSigma,
    rmse,
    bracketCount: priced.length,
    reliable: rmse < 0.10 && priced.length >= 5
  }
}

/**
 * Fit implied volatility with linear skew: sigma(strike) = baseVol + skew * moneyness
 * where moneyness = (strikeMid - spot) / spot.
 * Only used when flat-fit RMSE is high (>= 0.08), indicating vol smile/skew.
 * @param {Array<{lower: number, width: number, marketProb: number}>} brackets
 * @param {number} spot
 * @param {number} secondsToSettlement
 * @param {{ sigma: number, rmse: number }} flatFit - Result of flat fitImpliedVol
 * @returns {{ baseVol: number, skew: number, rmse: number, reliable: boolean } | null}
 */
const fitImpliedVolWithSkew = (brackets, spot, secondsToSettlement, flatFit) => {
  if (!flatFit || flatFit.rmse < 0.08) return null // flat model is good enough

  const priced = brackets.filter(b => b.marketProb > 0.01 && b.marketProb < 0.99)
  if (priced.length < 5) return null // need enough points to justify 2 params

  let bestBase = flatFit.sigma
  let bestSkew = 0
  let bestError = Infinity

  // Grid search: baseVol 20-200%, skew -1.0 to +1.0
  for (let base = 0.20; base <= 2.0; base += 0.04) {
    for (let skew = -1.0; skew <= 1.0; skew += 0.05) {
      let error = 0
      for (const b of priced) {
        const strikeMid = b.lower + b.width / 2
        const moneyness = (strikeMid - spot) / spot
        const localSigma = Math.max(0.10, base + skew * moneyness)
        const modelProb = bracketProbability(spot, b.lower, b.width, localSigma, secondsToSettlement)
        error += (modelProb - b.marketProb) ** 2
      }
      if (error < bestError) {
        bestError = error
        bestBase = base
        bestSkew = skew
      }
    }
  }

  const rmse = Math.sqrt(bestError / priced.length)

  // Only use skew model if it materially improves on flat fit
  if (rmse >= flatFit.rmse * 0.85) return null // not enough improvement

  return {
    baseVol: bestBase,
    skew: bestSkew,
    rmse,
    reliable: rmse < 0.10 && priced.length >= 5
  }
}

/**
 * Get sigma for a specific strike using skew model
 * @param {{ baseVol: number, skew: number }} skewParams
 * @param {number} strikeMid - Midpoint of the bracket
 * @param {number} spot - Current spot price
 * @returns {number}
 */
const getSkewSigma = (skewParams, strikeMid, spot) => {
  const moneyness = (strikeMid - spot) / spot
  return Math.max(0.10, skewParams.baseVol + skewParams.skew * moneyness)
}

/**
 * Compute cross-market analytics for all settlement groups.
 *
 * @param {Map<string, Object>} currentPrices - Price data by ticker
 * @param {Map<string, Object>} marketInfo - Market metadata by ticker
 * @param {number} spotPrice - Current BTC spot price
 * @returns {{ groups: Map, byTicker: Map }}
 */
const computeBracketAnalytics = (currentPrices, marketInfo, spotPrice) => {
  const result = { groups: new Map(), byTicker: new Map() }
  if (!spotPrice) return result

  const now = Date.now()

  // Group bracket markets by close_time (settlement)
  const groups = new Map()

  for (const [ticker, info] of marketInfo) {
    if (!info?.close_time) continue
    const segments = ticker.split('-')
    const bracketSeg = segments[segments.length - 1]
    if (!bracketSeg.startsWith('B')) continue

    const midpoint = parseInt(bracketSeg.slice(1))
    if (isNaN(midpoint)) continue

    const width = 250 // KXBTC brackets are $250 wide
    const lower = midpoint - width / 2
    const closeTime = info.close_time
    const priceData = currentPrices.get(ticker)

    if (!groups.has(closeTime)) {
      groups.set(closeTime, { brackets: [], closeTime })
    }

    const yesAsk = priceData?.yesAsk ?? 0
    const yesBid = priceData?.yesBid ?? 0
    const lastPrice = priceData?.lastPrice ?? 0
    const marketPrice = (yesBid > 1 && yesAsk < 99)
      ? (yesBid + yesAsk) / 2
      : lastPrice

    groups.get(closeTime).brackets.push({
      ticker, lower, upper: lower + width, width,
      yesBid, yesAsk, lastPrice, marketPrice,
      marketProb: marketPrice / 100
    })
  }

  // Compute analytics per settlement group
  for (const [closeTime, group] of groups) {
    const secondsToSettlement = Math.max(0, (new Date(closeTime).getTime() - now) / 1000)
    group.brackets.sort((a, b) => a.lower - b.lower)

    // 1. Bracket sum — all priced brackets should sum to ~100¢
    const priced = group.brackets.filter(b => b.marketPrice > 0)
    const sumMid = priced.reduce((s, b) => s + b.marketPrice, 0)
    group.bracketSum = {
      ask: priced.reduce((s, b) => s + (b.yesAsk || 0), 0),
      bid: priced.reduce((s, b) => s + (b.yesBid || 0), 0),
      mid: sumMid,
      pricedCount: priced.length,
      totalCount: group.brackets.length,
      overpriced: sumMid > 105,
      underpriced: sumMid < 95
    }

    // 2. Implied volatility (flat model)
    group.impliedVol = fitImpliedVol(group.brackets, spotPrice, secondsToSettlement)
    group.secondsToSettlement = secondsToSettlement

    // 2b. Try skew model if flat RMSE is high (vol smile/skew detected)
    group.skewParams = fitImpliedVolWithSkew(group.brackets, spotPrice, secondsToSettlement, group.impliedVol)

    // 3. Per-bracket: adjacent context + model mispricing
    for (let i = 0; i < group.brackets.length; i++) {
      const b = group.brackets[i]
      const prev = i > 0 ? group.brackets[i - 1] : null
      const next = i < group.brackets.length - 1 ? group.brackets[i + 1] : null

      let modelProb = null
      let mispricing = null
      let skewSigma = null

      if (secondsToSettlement > 5) {
        // Prefer skew-adjusted sigma for this specific bracket when available
        if (group.skewParams?.reliable) {
          const strikeMid = b.lower + b.width / 2
          skewSigma = getSkewSigma(group.skewParams, strikeMid, spotPrice)
          modelProb = bracketProbability(spotPrice, b.lower, b.width, skewSigma, secondsToSettlement)
        } else if (group.impliedVol?.sigma) {
          modelProb = bracketProbability(spotPrice, b.lower, b.width, group.impliedVol.sigma, secondsToSettlement)
        }

        if (modelProb != null && b.marketProb > 0.01) {
          mispricing = modelProb - b.marketProb // positive = market underpricing YES
        }
      }

      result.byTicker.set(b.ticker, {
        closeTime,
        secondsToSettlement,
        bracketSum: group.bracketSum,
        impliedVol: group.impliedVol,
        skewParams: group.skewParams,
        skewSigma,
        lower: b.lower,
        upper: b.upper,
        bracketIndex: i,
        totalBrackets: group.brackets.length,
        prevBracket: prev ? { ticker: prev.ticker, lower: prev.lower, marketPrice: prev.marketPrice } : null,
        nextBracket: next ? { ticker: next.ticker, lower: next.lower, marketPrice: next.marketPrice } : null,
        modelProb,
        mispricing,
        spotDistance: spotPrice - b.lower,
        spotInBracket: spotPrice >= b.lower && spotPrice < b.upper
      })
    }
  }

  result.groups = groups
  return result
}

module.exports = { computeBracketAnalytics }
