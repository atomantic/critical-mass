/**
 * Momentum Rider Strategy (v2)
 *
 * Rides price momentum on Kalshi binary/bracket markets with Coinbase spot confirmation.
 * When a YES or NO side reaches a conviction threshold (e.g., 65¢),
 * buys that side and rides to settlement — no stop loss, no forced exit.
 *
 * Thesis: once a Kalshi market shows 65%+ conviction in one direction AND
 * Coinbase spot is moving the same way, the market tends to settle in-the-money
 * because the underlying (BTC spot) momentum is genuine, not a stale reprice.
 *
 * Key changes from v1:
 * - Requires Coinbase spot momentum confirmation before entry
 * - Fair value sanity check (don't buy overpriced markets)
 * - Wider entry range (65-80¢), no stop loss, ride to settlement
 * - Profit target only triggers on large moves (15¢+) to clear fees
 */

const BaseStrategy = require('../base-strategy.js')
const { getCoinbaseTickerForKalshi, parseStrikePrice, getBracketInfo } = require('../../adapters/markets.js')
const { calculateFairProbability, getSigma } = require('../../services/volatility-service.js')

class MomentumRiderStrategy extends BaseStrategy {
  constructor(config) {
    super('momentum-rider', config)
  }

  getDefaultParams() {
    return {
      // Entry thresholds (cents)
      entryThreshold: 65,       // Buy earlier to capture more upside
      maxEntryPrice: 80,        // Cap lower — above 80¢ the risk/reward inverts

      // Exit thresholds (cents delta from entry)
      profitTarget: 15,         // Only take profit on big moves (> fees)
      stopLoss: 0,              // 0 = disabled, ride to settlement

      // Momentum confirmation
      minTrendTicks: 3,         // Require N consecutive ticks in our direction
      trendLookback: 8,         // Look at last N Kalshi price snapshots

      // Coinbase spot confirmation
      minSpotMomentum: 0.05,    // Min 0.05% spot move confirming direction
      spotLookbackSec: 60,      // Look at last 60s of Coinbase spot

      // Fair value guard
      maxFairValuePremium: 15,  // Skip if market price > fair value + 15¢

      // Time filters (seconds to settlement)
      minSecondsToSettlement: 60,   // Don't enter <1 min
      maxSecondsToSettlement: 300,  // Tighter window (was 600)
      exitBeforeSettlement: 0,      // Don't force exit — let it settle

      // Position limits
      positionSize: 5,
      maxBetPct: 0.02,
      maxContracts: 50,
      maxPositions: 2
    }
  }

  /**
   * Check Kalshi price trend from priceHistory
   * Returns { trending: bool, side: 'yes'|'no', trendTicks: number, currentPrice: number }
   * @param {Array} history - Kalshi price history for a ticker
   * @param {Object} params
   * @returns {{ trending: boolean, side: 'yes'|'no'|null, trendTicks: number, yesPrice: number, noPrice: number }}
   */
  checkKalshiTrend(history, params) {
    const result = { trending: false, side: null, trendTicks: 0, yesPrice: 0, noPrice: 0 }
    if (!history || history.length < 3) return result

    const recent = history.slice(-params.trendLookback)
    const latest = recent[recent.length - 1]

    // Use mid price (average of bid/ask) for trend, fall back to lastPrice
    const getYesPrice = (h) => {
      if (h.yesBid > 0 && h.yesAsk < 100) return (h.yesBid + h.yesAsk) / 2
      return h.lastPrice || 0
    }

    result.yesPrice = getYesPrice(latest)
    result.noPrice = 100 - result.yesPrice

    // Count consecutive ticks trending in one direction
    let yesTrend = 0
    let noTrend = 0
    for (let i = recent.length - 1; i > 0; i--) {
      const curr = getYesPrice(recent[i])
      const prev = getYesPrice(recent[i - 1])
      if (curr > prev) {
        if (noTrend > 0) break // direction changed
        yesTrend++
      } else if (curr < prev) {
        if (yesTrend > 0) break
        noTrend++
      } else {
        break // flat
      }
    }

    if (yesTrend >= params.minTrendTicks) {
      result.trending = true
      result.side = 'yes'
      result.trendTicks = yesTrend
    } else if (noTrend >= params.minTrendTicks) {
      result.trending = true
      result.side = 'no'
      result.trendTicks = noTrend
    }

    return result
  }

  /**
   * Check Coinbase spot momentum to confirm Kalshi trend direction.
   * @param {Array<{price: number, timestamp: number}>} spotHistory - Coinbase price history
   * @param {'yes'|'no'} side - Which side we're looking to buy
   * @param {number} strike - Strike price for the market
   * @param {Object} params
   * @returns {{ confirmed: boolean, spotDelta: number, spotDeltaPct: number }}
   */
  checkSpotMomentum(spotHistory, side, strike, params) {
    const result = { confirmed: false, spotDelta: 0, spotDeltaPct: 0 }
    if (!spotHistory?.length || spotHistory.length < 2) return result

    const now = Date.now()
    const cutoff = now - params.spotLookbackSec * 1000
    const window = spotHistory.filter(h => h.timestamp >= cutoff)
    if (window.length < 2) return result

    const oldest = window[0].price
    const latest = window[window.length - 1].price
    if (!oldest || oldest <= 0) return result

    result.spotDelta = latest - oldest
    result.spotDeltaPct = (result.spotDelta / oldest) * 100

    // For YES side: spot should be rising (moving toward/above strike)
    // For NO side: spot should be falling (moving away from/below strike)
    if (side === 'yes') {
      result.confirmed = result.spotDeltaPct >= params.minSpotMomentum
    } else {
      result.confirmed = result.spotDeltaPct <= -params.minSpotMomentum
    }

    return result
  }

  /**
   * @param {import('../base-strategy.js').StrategyContext} context
   * @returns {import('../base-strategy.js').Signal[]}
   */
  evaluate(context) {
    if (!this.enabled) return []

    const signals = []
    const params = { ...this.getDefaultParams(), ...this.params }
    const now = Date.now()
    this.diagnostics = []

    for (const [ticker, priceData] of context.prices) {
      const coinbaseTicker = getCoinbaseTickerForKalshi(ticker)
      if (!coinbaseTicker) continue

      const history = context.priceHistory?.get(ticker)
      const marketInfo = priceData || history?.[history?.length - 1]
      if (!marketInfo?.close_time) continue

      const closeTime = new Date(marketInfo.close_time).getTime()
      const secondsToSettlement = Math.max(0, (closeTime - now) / 1000)

      // Base diagnostic
      const diag = {
        ticker,
        ttl: Math.round(secondsToSettlement),
        window: 'monitor',
        status: ''
      }

      // --- Check existing positions for exit ---
      const existingPosition = context.positions.find(p =>
        p.ticker === ticker && p.metadata?.strategy === this.name
      )

      if (existingPosition) {
        const exitSignal = this.checkExit(ticker, existingPosition, priceData, secondsToSettlement, params)
        if (exitSignal) signals.push(exitSignal)
        diag.window = 'primary'
        diag.status = exitSignal ? `EXIT: ${exitSignal.reason}` : 'holding (ride to settlement)'
        this.diagnostics.push(diag)
        continue
      }

      // --- Time filter ---
      if (secondsToSettlement < params.minSecondsToSettlement) {
        diag.status = 'too close to settlement'
        this.diagnostics.push(diag)
        continue
      }
      if (secondsToSettlement > params.maxSecondsToSettlement) {
        diag.status = 'too far from settlement'
        this.diagnostics.push(diag)
        continue
      }
      diag.window = 'scout'

      // --- Position limit ---
      const myPositions = context.positions.filter(p => p.metadata?.strategy === this.name).length
      if (myPositions >= params.maxPositions) {
        diag.status = 'max positions'
        this.diagnostics.push(diag)
        continue
      }

      // --- Check Kalshi price trend ---
      const trend = this.checkKalshiTrend(history, params)
      if (!trend.trending) {
        diag.status = `no momentum (need ${params.minTrendTicks} consecutive ticks)`
        this.diagnostics.push(diag)
        continue
      }

      // --- Check if the trending side has reached entry threshold ---
      const trendingPrice = trend.side === 'yes' ? trend.yesPrice : trend.noPrice
      if (trendingPrice < params.entryThreshold) {
        diag.status = `${trend.side.toUpperCase()} at ${trendingPrice.toFixed(0)}¢ < ${params.entryThreshold}¢ threshold (${trend.trendTicks} tick trend)`
        this.diagnostics.push(diag)
        continue
      }
      if (trendingPrice > params.maxEntryPrice) {
        diag.status = `${trend.side.toUpperCase()} at ${trendingPrice.toFixed(0)}¢ > ${params.maxEntryPrice}¢ max`
        this.diagnostics.push(diag)
        continue
      }

      // --- Coinbase spot momentum confirmation ---
      const spotHistory = context.coinbasePriceHistory?.get(coinbaseTicker)
      const strike = parseStrikePrice(marketInfo.title, ticker)
      if (!strike) {
        diag.status = 'no strike price found'
        this.diagnostics.push(diag)
        continue
      }

      const spotMomentum = this.checkSpotMomentum(spotHistory, trend.side, strike, params)
      if (!spotMomentum.confirmed) {
        diag.status = `spot not confirming ${trend.side.toUpperCase()} (delta ${spotMomentum.spotDeltaPct.toFixed(3)}%, need ${trend.side === 'yes' ? '+' : '-'}${params.minSpotMomentum}%)`
        this.diagnostics.push(diag)
        continue
      }

      // --- Fair value sanity check ---
      const btcSpot = context.compositePrices?.get(coinbaseTicker)?.price
        || context.coinbasePrices?.get(coinbaseTicker)
      if (btcSpot) {
        const { isBracket, bracketWidth } = getBracketInfo(ticker)
        const bracketData = context.bracketAnalytics?.tickers?.get(ticker)
        const priceHistory = context.compositePriceHistory?.get(coinbaseTicker)
          || context.coinbasePriceHistory?.get(coinbaseTicker)
        const { sigma } = getSigma({ bracketData, priceHistory })
        const fairProb = calculateFairProbability(btcSpot, strike, secondsToSettlement, sigma, isBracket ? bracketWidth : 0)
        const fairPriceCents = fairProb * 100
        const marketPriceCents = trend.side === 'yes' ? trend.yesPrice : trend.noPrice
        const premium = marketPriceCents - fairPriceCents

        if (premium > params.maxFairValuePremium) {
          diag.status = `overpriced: market ${marketPriceCents.toFixed(0)}¢ vs fair ${fairPriceCents.toFixed(0)}¢ (+${premium.toFixed(0)}¢ premium)`
          diag.fairProb = fairProb
          diag.marketProb = marketPriceCents / 100
          this.diagnostics.push(diag)
          continue
        }
      }

      // --- Liquidity check ---
      const yesBid = priceData.yesBid ?? 0
      const yesAsk = priceData.yesAsk ?? 100
      if (yesBid < 1 || yesAsk > 99) {
        diag.status = 'no liquidity'
        this.diagnostics.push(diag)
        continue
      }
      const spread = yesAsk - yesBid
      if (spread > 20) {
        diag.status = `spread ${spread}¢ too wide`
        this.diagnostics.push(diag)
        continue
      }

      // --- Entry signal ---
      const side = trend.side
      // Buy at the ask: YES side buys at yesAsk, NO side buys at (100 - yesBid)
      const entryPrice = side === 'yes' ? yesAsk : 100 - yesBid

      if (entryPrice < params.entryThreshold || entryPrice > params.maxEntryPrice) {
        diag.status = `entry price ${entryPrice}¢ outside range`
        this.diagnostics.push(diag)
        continue
      }

      // Confidence based on how far above threshold and how strong the trend is
      const priceConfidence = Math.min(1, (trendingPrice - params.entryThreshold) / 20 + 0.5)
      const trendConfidence = Math.min(1, trend.trendTicks / (params.minTrendTicks * 2))
      // Spot momentum adds confidence — stronger spot move = higher confidence
      const spotConfidence = Math.min(1, Math.abs(spotMomentum.spotDeltaPct) / (params.minSpotMomentum * 3))
      const confidence = (priceConfidence + trendConfidence + spotConfidence) / 3

      const count = this.calculatePositionSize(confidence, context.balance, context.config?.risk, entryPrice)
      const limitedCount = Math.min(count, params.maxContracts)

      diag.window = 'primary'
      diag.status = `ENTRY ${side.toUpperCase()} ${limitedCount}x @ ${entryPrice}¢`

      this.log(`ENTRY: ${ticker} ${side.toUpperCase()} @ ${entryPrice}¢`, {
        trend: `${trend.trendTicks} ticks`,
        price: `${trendingPrice.toFixed(0)}¢`,
        spot: `${spotMomentum.spotDeltaPct.toFixed(3)}%`,
        ttl: `${Math.round(secondsToSettlement)}s`,
        count: limitedCount
      })

      signals.push({
        ticker,
        side,
        action: 'buy',
        count: limitedCount,
        price: entryPrice,
        reason: `Momentum: ${side.toUpperCase()} at ${trendingPrice.toFixed(0)}¢ with ${trend.trendTicks}-tick trend, spot ${spotMomentum.spotDeltaPct >= 0 ? '+' : ''}${spotMomentum.spotDeltaPct.toFixed(3)}%, ${Math.round(secondsToSettlement)}s to settle`,
        confidence,
        metadata: {
          strategy: this.name,
          entryPrice,
          trendTicks: trend.trendTicks,
          spotDeltaPct: spotMomentum.spotDeltaPct,
          secondsToSettlement
        }
      })
      this.diagnostics.push(diag)
    }

    return signals
  }

  /**
   * Check exit conditions for an existing momentum position.
   * With stopLoss=0: no stop loss, only profit target if set and large enough.
   * With exitBeforeSettlement=0: no forced exit, ride to settlement.
   * @param {string} ticker
   * @param {Object} position
   * @param {Object} priceData - Current Kalshi price data
   * @param {number} secondsToSettlement
   * @param {Object} params
   * @returns {import('../base-strategy.js').Signal | null}
   */
  checkExit(ticker, position, priceData, secondsToSettlement, params) {
    const contracts = position.contracts || 0
    if (contracts <= 0) return null

    const yesBid = priceData?.yesBid ?? 0
    const yesAsk = priceData?.yesAsk ?? 100

    // Current exit price (what we'd get if we sold now)
    const exitPrice = position.side === 'yes' ? yesBid : 100 - yesAsk
    const entryAvg = position.avgCost || 0
    const priceDelta = exitPrice - entryAvg

    const makeExit = (reason) => ({
      ticker,
      side: position.side,
      action: 'sell',
      count: contracts,
      price: exitPrice,
      reason,
      confidence: 0.9,
      metadata: { strategy: this.name }
    })

    // 1a. Force exit before settlement (configurable)
    if (params.exitBeforeSettlement > 0 && secondsToSettlement <= params.exitBeforeSettlement) {
      this.log(`EXIT (time) ${ticker}: ${Math.round(secondsToSettlement)}s to settlement, delta ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
      return makeExit(`Time exit: ${Math.round(secondsToSettlement)}s left, P&L ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
    }

    // 1b. Safety net: always exit at 45s before settlement regardless of config.
    // Settlement-riding strategies have 0% win rate on live trades. Binary risk
    // (all-or-nothing at $0/$1) is too high. Pre-settlement exits preserve capital.
    if (secondsToSettlement <= 45) {
      this.log(`EXIT (safety) ${ticker}: ${Math.round(secondsToSettlement)}s to settlement, delta ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
      return makeExit(`Safety exit: ${Math.round(secondsToSettlement)}s before settlement, P&L ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
    }

    // 2. Take profit (only if profitTarget > 0 and delta exceeds it)
    if (params.profitTarget > 0 && priceDelta >= params.profitTarget) {
      this.log(`EXIT (profit) ${ticker}: +${priceDelta.toFixed(0)}¢ >= ${params.profitTarget}¢ target`)
      return makeExit(`Take profit: +${priceDelta.toFixed(0)}¢ (target ${params.profitTarget}¢)`)
    }

    // 3. Stop loss (only if stopLoss > 0)
    if (params.stopLoss > 0 && priceDelta <= -params.stopLoss) {
      this.log(`EXIT (stop) ${ticker}: ${priceDelta.toFixed(0)}¢ <= -${params.stopLoss}¢ stop`)
      return makeExit(`Stop loss: ${priceDelta.toFixed(0)}¢ (limit -${params.stopLoss}¢)`)
    }

    return null
  }

  shouldEvaluate(market) {
    if (!this.enabled) return false
    return market.type === 'crypto'
  }
}

module.exports = MomentumRiderStrategy
