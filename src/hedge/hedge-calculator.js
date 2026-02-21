// @ts-check
/**
 * Hedge Calculator
 *
 * Profitability math, hedge ratio, bracket selection (auto-select best across
 * KXBTC15M and KXBTC), coupling score analysis, and entry evaluation logic.
 */

const { calculateRollingVolatility, calculateAboveProbability, calculateKalshiFee } = require('../kalshi/services/volatility-service')
const { parseStrikePrice, getBracketInfo } = require('../kalshi/adapters/markets')

/**
 * Calculate exchange round-trip fees in USD
 * @param {number} positionSizeUsd - Position size in USD
 * @param {{ exchangeMakerBps: number, exchangeTakerBps: number }} fees
 * @returns {{ entryFee: number, exitFee: number, totalFee: number }}
 */
const calculateExchangeFees = (positionSizeUsd, fees) => {
  const entryFee = positionSizeUsd * (fees.exchangeTakerBps / 10000) // market buy = taker
  const exitFee = positionSizeUsd * (fees.exchangeTakerBps / 10000) // market sell = taker
  return { entryFee, exitFee, totalFee: entryFee + exitFee }
}

/**
 * Calculate Kalshi hedge costs
 * @param {number} contracts - Number of contracts
 * @param {number} premiumCents - Premium per contract in cents
 * @param {number} kalshiTakerCoeff - Kalshi taker fee coefficient
 * @returns {{ premiumCost: number, kalshiFee: number, totalCost: number }}
 */
const calculateKalshiHedgeCost = (contracts, premiumCents, kalshiTakerCoeff) => {
  const premiumCost = (contracts * premiumCents) / 100
  const kalshiFee = calculateKalshiFee(contracts, premiumCents, 'taker')
  return { premiumCost, kalshiFee, totalCost: premiumCost + kalshiFee }
}

/**
 * Calculate how many Kalshi contracts are needed to hedge a BTC position
 * @param {number} btcAmount - BTC position size
 * @param {number} btcPrice - Current BTC price
 * @param {number} stopLossPct - Stop loss percentage (e.g., 1.0 for 1%)
 * @param {number} hedgeRatio - Hedge coverage ratio (1.0 = full hedge)
 * @returns {number} Number of contracts needed
 */
const calculateHedgeContracts = (btcAmount, btcPrice, stopLossPct, hedgeRatio) => {
  // Max exchange loss = position size * stop loss %
  const maxExchangeLoss = btcAmount * btcPrice * (stopLossPct / 100)
  // Each Kalshi contract pays $1 on win, so we need maxLoss contracts for full hedge
  const contracts = Math.ceil(maxExchangeLoss * hedgeRatio)
  return contracts
}

/**
 * Calculate coupling score between SL trigger and Kalshi bracket
 *
 * Coupling measures how likely it is that "SL hit" and "Kalshi settles DOWN"
 * are the same event. Higher coupling = better hedge.
 *
 * @param {number} btcPrice - Current BTC price
 * @param {number} stopLossPrice - Stop loss trigger price
 * @param {number} bracketStrike - Kalshi bracket strike/boundary price
 * @param {number} bracketWidth - Width of bracket ($250 for KXBTC)
 * @returns {{ score: number, description: string }}
 */
const calculateCouplingScore = (btcPrice, stopLossPrice, bracketStrike, bracketWidth) => {
  // For a "NO" bet on a bracket, we win when BTC is NOT in the bracket range.
  // For a "YES" bet on a lower bracket, we win when BTC IS in that lower range.
  //
  // The SL triggers at stopLossPrice. The ideal case is when the bracket boundary
  // is at or near the SL price — this maximizes P(SL hit | Kalshi settles in our favor).

  const lowerBound = bracketWidth > 0 ? bracketStrike - bracketWidth / 2 : bracketStrike
  const upperBound = bracketWidth > 0 ? bracketStrike + bracketWidth / 2 : bracketStrike

  // Distance from SL price to the nearest bracket boundary, normalized by price
  const distToLower = Math.abs(stopLossPrice - lowerBound) / btcPrice
  const distToUpper = Math.abs(stopLossPrice - upperBound) / btcPrice
  const minDist = Math.min(distToLower, distToUpper)

  // Score: 1.0 when SL is exactly at bracket boundary, decays with distance
  // At 0.5% distance: score ~0.6; at 1% distance: score ~0.36; at 2%: ~0.13
  const score = Math.exp(-minDist * 200)

  let description
  if (score > 0.8) description = 'excellent — SL aligned with bracket boundary'
  else if (score > 0.5) description = 'good — SL near bracket boundary'
  else if (score > 0.3) description = 'moderate — some coupling mismatch'
  else description = 'poor — significant SL/bracket mismatch'

  return { score, description }
}

/**
 * Evaluate a single Kalshi bracket as a hedge candidate
 * @param {Object} market - Kalshi market object
 * @param {Object} params
 * @param {number} params.btcPrice - Current BTC spot price
 * @param {number} params.stopLossPrice - Stop loss trigger price
 * @param {number} params.btcAmount - BTC position size
 * @param {number} params.hedgeRatio - Hedge coverage ratio
 * @param {number} params.maxPremiumCents - Maximum allowed premium
 * @param {number} params.kalshiTakerCoeff - Kalshi fee coefficient
 * @param {number} params.sigma - Annualized volatility
 * @param {number} params.secondsToSettlement - Time until settlement
 * @returns {Object|null} Candidate evaluation or null if not viable
 */
const evaluateBracketCandidate = (market, params) => {
  const {
    btcPrice, stopLossPrice, btcAmount, hedgeRatio,
    maxPremiumCents, kalshiTakerCoeff, sigma, secondsToSettlement
  } = params

  const strike = parseStrikePrice(market.title, market.ticker)
  if (!strike) return null

  const { isBracket, bracketWidth } = getBracketInfo(market.ticker)

  // Determine hedge approach:
  // If BTC drops to/below SL, which bet pays out?
  // Strategy: Buy NO on current bracket (BTC won't be in this range if it drops below SL)
  // This pays $1 if BTC settles OUTSIDE this bracket

  const lowerBound = isBracket ? strike - bracketWidth / 2 : strike

  // For NO bet: we want BTC to be BELOW lowerBound at settlement
  // NO price = 100 - YES price (in cents)
  const yesAsk = market.yes_ask ?? 0
  const yesBid = market.yes_bid ?? 0
  const noBid = market.no_bid ?? (yesAsk > 0 ? 100 - yesAsk : 0)
  const noAsk = market.no_ask ?? (yesBid > 0 ? 100 - yesBid : 0)

  // We're buying NO, so we pay the NO ask price
  const premiumCents = noAsk
  if (premiumCents <= 0 || premiumCents > maxPremiumCents) return null

  // Calculate how many contracts we need
  const contractsNeeded = calculateHedgeContracts(btcAmount, btcPrice, (1 - stopLossPrice / btcPrice) * 100, hedgeRatio)

  // Calculate costs
  const kalshiCost = calculateKalshiHedgeCost(contractsNeeded, premiumCents, kalshiTakerCoeff)

  // Calculate coupling
  const coupling = calculateCouplingScore(btcPrice, stopLossPrice, strike, bracketWidth)

  // Calculate probability that the hedge pays out (P(BTC < lowerBound at settlement))
  const pAboveLower = calculateAboveProbability(btcPrice, lowerBound, secondsToSettlement, sigma)
  const pBelowLower = 1 - pAboveLower

  // Expected payout: contracts * $1 * P(settling below bracket)
  const expectedPayout = contractsNeeded * pBelowLower

  // Hedge coverage score: (expected payout * coupling) / cost
  const hedgeCoverage = contractsNeeded // max possible payout in $
  const score = hedgeCoverage > 0 && kalshiCost.totalCost > 0
    ? (hedgeCoverage * coupling.score) / kalshiCost.totalCost
    : 0

  return {
    ticker: market.ticker,
    series: market.event_ticker,
    closeTime: market.close_time,
    strike,
    bracketWidth,
    isBracket,
    lowerBound,
    premiumCents,
    noBid,
    noAsk,
    contractsNeeded,
    kalshiCost,
    coupling,
    pBelowLower,
    expectedPayout,
    hedgeCoverage,
    score,
    secondsToSettlement,
  }
}

/**
 * Find the best hedge bracket across all allowed series
 * @param {Object[]} markets - Available Kalshi markets
 * @param {Object} params
 * @param {number} params.btcPrice - Current BTC spot price
 * @param {number} params.stopLossPrice - Stop loss trigger price
 * @param {number} params.btcAmount - BTC position size
 * @param {number} params.hedgeRatio - Hedge coverage ratio
 * @param {number} params.maxPremiumCents - Maximum allowed premium
 * @param {number} params.kalshiTakerCoeff - Kalshi fee coefficient
 * @param {number} params.sigma - Annualized volatility
 * @param {Function} params.canFillCheck - Function to verify orderbook depth: (ticker, side, action, count, slippage) => boolean
 * @param {number} params.maxSlippageCents - Max slippage for canFill check
 * @returns {Object|null} Best hedge candidate or null
 */
const selectBestBracket = (markets, params) => {
  const { canFillCheck, maxSlippageCents } = params

  const candidates = []

  for (const market of markets) {
    if (!market.close_time) continue

    const secondsToSettlement = (new Date(market.close_time).getTime() - Date.now()) / 1000
    if (secondsToSettlement < 60) continue // too close to settlement

    const candidate = evaluateBracketCandidate(market, {
      ...params,
      secondsToSettlement,
    })

    if (!candidate) continue
    if (candidate.coupling.score < 0.2) continue // coupling too low

    // Check orderbook depth if canFill function provided
    if (canFillCheck) {
      const hasLiquidity = canFillCheck(market.ticker, 'no', 'buy', candidate.contractsNeeded, maxSlippageCents)
      if (!hasLiquidity) continue
    }

    candidates.push(candidate)
  }

  if (candidates.length === 0) return null

  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

/**
 * Full profitability evaluation for a potential hedge trade
 * @param {Object} params
 * @param {number} params.btcPrice - Current BTC spot price
 * @param {number} params.btcAmount - BTC position size
 * @param {Object} params.hedgeCandidate - Best bracket candidate from selectBestBracket
 * @param {Object} params.fees - Fee config { exchangeMakerBps, exchangeTakerBps, kalshiTakerCoeff }
 * @param {number} params.stopLossPct - Stop loss %
 * @param {number} params.takeProfitPct - Take profit %
 * @param {number} params.sigma - Annualized volatility
 * @param {number} params.minExpectedProfit - Minimum expected profit in USD
 * @returns {{ profitable: boolean, metrics: Object }}
 */
const evaluateProfitability = (params) => {
  const {
    btcPrice, btcAmount, hedgeCandidate, fees,
    stopLossPct, takeProfitPct, sigma, minExpectedProfit
  } = params

  const positionSizeUsd = btcAmount * btcPrice
  const exchangeFees = calculateExchangeFees(positionSizeUsd, fees)

  // Scenario analysis
  const tpProfit = positionSizeUsd * (takeProfitPct / 100) - exchangeFees.totalFee
  const slLoss = positionSizeUsd * (stopLossPct / 100) + exchangeFees.totalFee

  const kalshiCost = hedgeCandidate.kalshiCost.totalCost
  const kalshiPayout = hedgeCandidate.contractsNeeded // $1 per contract if hedge fires

  // Probability estimates using log-normal model
  const secondsToSettlement = hedgeCandidate.secondsToSettlement
  const pTP = calculateTPProbability(btcPrice, takeProfitPct, secondsToSettlement, sigma)
  const pSL = calculateSLProbability(btcPrice, stopLossPct, secondsToSettlement, sigma)
  const pFlat = Math.max(0, 1 - pTP - pSL) // neither TP nor SL hit

  // Expected P&L per scenario
  const scenarioTP = tpProfit - kalshiCost // TP hit, hedge expires worthless
  const scenarioSLHedged = -slLoss + kalshiPayout - kalshiCost // SL hit, hedge fires
  const scenarioDoubleLoss = -slLoss - kalshiCost // SL hit, hedge doesn't fire
  const scenarioFlat = -kalshiCost // Settlement exit, roughly flat on exchange

  // Coupling determines split between hedged loss and double loss
  const couplingScore = hedgeCandidate.coupling.score
  const pSLHedged = pSL * couplingScore
  const pDoubleLoss = pSL * (1 - couplingScore)

  // Expected value
  const expectedPnl = (pTP * scenarioTP) +
    (pSLHedged * scenarioSLHedged) +
    (pDoubleLoss * scenarioDoubleLoss) +
    (pFlat * scenarioFlat)

  const totalFriction = exchangeFees.totalFee + kalshiCost
  const breakEvenMove = totalFriction / positionSizeUsd

  const metrics = {
    positionSizeUsd,
    exchangeFees,
    kalshiCost,
    kalshiPayout,
    totalFriction,
    breakEvenMovePct: breakEvenMove * 100,
    scenarioTP,
    scenarioSLHedged,
    scenarioDoubleLoss,
    scenarioFlat,
    pTP,
    pSL,
    pSLHedged,
    pDoubleLoss,
    pFlat,
    expectedPnl,
    couplingScore,
  }

  return {
    profitable: expectedPnl >= minExpectedProfit,
    metrics,
  }
}

/**
 * Approximate probability of hitting TP before settlement
 * Uses simplified barrier-crossing probability
 * @param {number} btcPrice - Current price
 * @param {number} tpPct - Take profit % from entry
 * @param {number} seconds - Seconds to settlement
 * @param {number} sigma - Annualized vol
 * @returns {number} Probability 0-1
 */
const calculateTPProbability = (btcPrice, tpPct, seconds, sigma) => {
  const tpPrice = btcPrice * (1 + tpPct / 100)
  return 1 - calculateAboveProbability(btcPrice, tpPrice, seconds, sigma)
    ? calculateAboveProbability(btcPrice, tpPrice, seconds, sigma) * 0.8 // discount for path dependency
    : 0.05
}

/**
 * Approximate probability of hitting SL before settlement
 * @param {number} btcPrice - Current price
 * @param {number} slPct - Stop loss % from entry
 * @param {number} seconds - Seconds to settlement
 * @param {number} sigma - Annualized vol
 * @returns {number} Probability 0-1
 */
const calculateSLProbability = (btcPrice, slPct, seconds, sigma) => {
  const slPrice = btcPrice * (1 - slPct / 100)
  // P(price drops below SL) = P(NOT above SL)
  const pAboveSL = calculateAboveProbability(btcPrice, slPrice, seconds, sigma)
  // Barrier crossing probability is higher than point-in-time probability
  // Approximate with reflection principle: P(min <= barrier) ≈ 2 * P(final <= barrier)
  const pFinalBelowSL = 1 - pAboveSL
  return Math.min(0.95, 2 * pFinalBelowSL) // cap at 95%
}

/**
 * Check if entry conditions are met
 * @param {Object} params
 * @param {number} params.volatility15m - 15-min rolling volatility (sigma)
 * @param {number} params.lastEntryTime - Timestamp of last entry
 * @param {number} params.consecutiveLosses - Current consecutive loss count
 * @param {Object} params.dailyStats - Today's stats
 * @param {Object} params.config - Hedge config
 * @returns {{ canEnter: boolean, reason?: string }}
 */
const checkEntryConditions = (params) => {
  const { volatility15m, lastEntryTime, consecutiveLosses, dailyStats, config } = params

  // Circuit breaker: consecutive losses
  if (consecutiveLosses >= config.risk.circuitBreakerConsecutiveLosses) {
    return { canEnter: false, reason: `circuit breaker: ${consecutiveLosses} consecutive losses` }
  }

  // Daily loss limit
  if ((dailyStats?.pnl ?? 0) <= -config.risk.maxDailyLoss) {
    return { canEnter: false, reason: `daily loss limit hit: $${Math.abs(dailyStats.pnl).toFixed(2)}` }
  }

  // Daily pairs limit
  if ((dailyStats?.pairs ?? 0) >= config.risk.maxDailyPairs) {
    return { canEnter: false, reason: `daily pairs limit: ${dailyStats.pairs}/${config.risk.maxDailyPairs}` }
  }

  // Cooldown
  if (lastEntryTime && Date.now() - lastEntryTime < config.entry.cooldownMs) {
    const remainSec = Math.ceil((config.entry.cooldownMs - (Date.now() - lastEntryTime)) / 1000)
    return { canEnter: false, reason: `cooldown: ${remainSec}s remaining` }
  }

  // Volatility band
  if (volatility15m !== null && volatility15m < config.entry.minVolatility15m) {
    return { canEnter: false, reason: `vol too low: ${(volatility15m * 100).toFixed(3)}% < ${(config.entry.minVolatility15m * 100).toFixed(3)}%` }
  }

  if (volatility15m !== null && volatility15m > config.entry.maxVolatility15m) {
    return { canEnter: false, reason: `vol too high: ${(volatility15m * 100).toFixed(3)}% > ${(config.entry.maxVolatility15m * 100).toFixed(3)}%` }
  }

  return { canEnter: true }
}

module.exports = {
  calculateExchangeFees,
  calculateKalshiHedgeCost,
  calculateHedgeContracts,
  calculateCouplingScore,
  evaluateBracketCandidate,
  selectBestBracket,
  evaluateProfitability,
  calculateTPProbability,
  calculateSLProbability,
  checkEntryConditions,
}
