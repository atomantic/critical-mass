/**
 * Gamma Scalper Strategy
 *
 * Targets OTM (out-of-the-money) Kalshi brackets priced 5-15 cents where
 * spot is trending toward the bracket range. These contracts have asymmetric
 * payoff: buy at 10¢, take profit at 20¢ = 100% return, stop loss at 5¢ = 50% loss.
 * After fees (~2¢ round-trip), effective reward/risk is ~1.4:1.
 *
 * Edge: Kalshi repricing lags Coinbase by seconds. When BTC spot moves toward
 * a bracket range, the market maker hasn't repriced yet — we buy cheap before
 * the probability catches up.
 *
 * Conservative sizing (2% max bet) since these are speculative OTM plays.
 */

const BaseStrategy = require('../base-strategy.js')
const { parseStrikePrice, getCoinbaseTickerForKalshi, getBracketInfo } = require('../../adapters/markets.js')
const { calculateFairProbability, getSigma, checkLiquidity, calculateNetEdge } = require('../../services/volatility-service.js')

class GammaScalperStrategy extends BaseStrategy {
  constructor(config) {
    super('gamma-scalper', config)
  }

  getDefaultParams() {
    return {
      // OTM price range (cents) — the sweet spot for asymmetric payoff
      minEntryPrice: 5,
      maxEntryPrice: 15,

      // Time window (seconds to settlement)
      minSecondsToSettlement: 120,  // Need enough time for repricing
      maxSecondsToSettlement: 600,  // Don't enter too early (OTM value decays)

      // Exit targets (cents)
      takeProfitCents: 10,   // Exit at entry + 10¢ (100% on a 10¢ entry)
      stopLossCents: 5,      // Max loss per contract

      // Momentum confirmation — spot must be trending toward strike
      minMomentumTicks: 4,   // Need 4+ of last 8 ticks moving toward strike
      momentumLookback: 8,

      // Edge threshold — fair prob must exceed market prob by this much
      edgeThreshold: 0.08,   // 8% edge on OTM is significant

      // Conservative sizing
      maxBetPct: 0.02,       // 2% of bankroll max
      maxContracts: 50,
      maxPositions: 2,
      positionSize: 5
    }
  }

  /**
   * Check if spot is trending toward strike
   * @param {Array<{price: number, timestamp: number}>} history
   * @param {number} strikePrice
   * @param {number} spotPrice
   * @param {Object} params
   * @returns {{ trending: boolean, fraction: number }}
   */
  checkSpotTrendTowardStrike(history, strikePrice, spotPrice, params) {
    if (!history || history.length < params.momentumLookback + 1) {
      return { trending: false, fraction: 0 }
    }

    const recent = history.slice(-(params.momentumLookback + 1))
    const spotAboveStrike = spotPrice > strikePrice
    let towardStrike = 0

    for (let i = 1; i < recent.length; i++) {
      const delta = recent[i].price - recent[i - 1].price
      // Toward strike = moving down if above, moving up if below
      if (spotAboveStrike && delta < 0) towardStrike++
      if (!spotAboveStrike && delta > 0) towardStrike++
    }

    const fraction = towardStrike / params.momentumLookback
    return {
      trending: towardStrike >= params.minMomentumTicks,
      fraction
    }
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

      const spotPrice = context.compositePrices?.get(coinbaseTicker)?.price
        ?? context.coinbasePrices?.get(coinbaseTicker)
      if (!spotPrice) continue

      const history = context.priceHistory?.get(ticker)
      const marketInfo = priceData || history?.[history.length - 1]
      if (!marketInfo?.title) continue

      const strikePrice = parseStrikePrice(marketInfo.title, ticker)
      if (!strikePrice) continue

      const { bracketWidth } = getBracketInfo(ticker)

      const closeTime = marketInfo.close_time ? new Date(marketInfo.close_time).getTime() : null
      if (!closeTime) continue

      const secondsToSettlement = Math.max(0, (closeTime - now) / 1000)

      const diag = { ticker, ttl: Math.round(secondsToSettlement), status: '' }

      // Time filter
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

      // Liquidity check
      const liquidity = checkLiquidity(priceData)
      if (!liquidity.valid) {
        diag.status = `no liquidity: ${liquidity.reason}`
        this.diagnostics.push(diag)
        continue
      }

      // Check existing positions for exit
      const existingPosition = context.positions.find(p => p.ticker === ticker && p.metadata?.strategy === this.name)
      if (existingPosition) {
        const exitSignal = this.checkExit(ticker, existingPosition, liquidity, secondsToSettlement, params)
        if (exitSignal) signals.push(exitSignal)
        diag.status = exitSignal ? `EXIT: ${exitSignal.reason}` : 'holding'
        this.diagnostics.push(diag)
        continue
      }

      // Skip if another strategy owns this ticker
      if (context.positions.find(p => p.ticker === ticker)) continue

      // Position limit
      const myPositions = context.positions.filter(p => p.metadata?.strategy === this.name).length
      if (myPositions >= params.maxPositions) continue

      // OTM filter: YES price must be in the cheap range (5-15¢)
      const yesPrice = liquidity.yesAsk
      const noPrice = 100 - liquidity.yesBid

      const yesIsOTM = yesPrice >= params.minEntryPrice && yesPrice <= params.maxEntryPrice
      const noIsOTM = noPrice >= params.minEntryPrice && noPrice <= params.maxEntryPrice

      if (!yesIsOTM && !noIsOTM) {
        diag.status = `not OTM (YES ${yesPrice}¢, NO ${noPrice}¢)`
        this.diagnostics.push(diag)
        continue
      }

      // Resolve sigma for fair probability
      const bracketData = context.bracketAnalytics?.byTicker?.get(ticker)
      const compositeHistory = context.compositePriceHistory?.get(coinbaseTicker)
      const cbHistory = compositeHistory?.length > 60
        ? compositeHistory
        : context.coinbasePriceHistory?.get(coinbaseTicker)
      const { sigma } = getSigma({ bracketData, priceHistory: cbHistory })

      // Calculate fair probability
      const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, sigma, bracketWidth)

      // Determine which side is OTM and has edge
      let side = null
      let entryPrice = 0
      let edge = 0

      if (yesIsOTM) {
        const kalshiProb = yesPrice / 100
        const yesEdge = fairProb - kalshiProb
        if (yesEdge >= params.edgeThreshold) {
          side = 'yes'
          entryPrice = yesPrice
          edge = yesEdge
        }
      }

      if (!side && noIsOTM) {
        const noKalshiProb = noPrice / 100
        const noFairProb = 1 - fairProb
        const noEdge = noFairProb - noKalshiProb
        if (noEdge >= params.edgeThreshold) {
          side = 'no'
          entryPrice = noPrice
          edge = noEdge
        }
      }

      if (!side) {
        diag.status = `no edge (fair=${(fairProb * 100).toFixed(0)}%, YES=${yesPrice}¢, NO=${noPrice}¢)`
        this.diagnostics.push(diag)
        continue
      }

      // Momentum confirmation — spot must be trending toward strike
      const momentum = this.checkSpotTrendTowardStrike(cbHistory, strikePrice, spotPrice, params)
      if (!momentum.trending) {
        diag.status = `no momentum toward strike (${(momentum.fraction * 100).toFixed(0)}% < ${(params.minMomentumTicks / params.momentumLookback * 100).toFixed(0)}%)`
        this.diagnostics.push(diag)
        continue
      }

      // Position sizing (conservative)
      const confidence = Math.min(1, edge / (params.edgeThreshold * 2) + 0.3)
      const count = this.calculatePositionSize(confidence, context.balance, context.config?.risk, entryPrice)
      const limitedCount = Math.min(count, params.maxContracts)

      // Net-edge gating: reject if fees + slippage eat the edge
      const { netEdge, feePerContract } = calculateNetEdge(edge, limitedCount, entryPrice)
      if (netEdge <= 0) {
        diag.status = `fees eat edge (gross=$${edge.toFixed(3)}/ct, fees=$${feePerContract.toFixed(3)}/ct)`
        this.diagnostics.push(diag)
        continue
      }

      diag.status = `ENTRY ${side.toUpperCase()} ${limitedCount}x @ ${entryPrice}¢ (edge ${(edge * 100).toFixed(1)}%)`

      this.log(`ENTRY: ${ticker} ${side.toUpperCase()} @ ${entryPrice}¢`, {
        edge: `${(edge * 100).toFixed(1)}%`,
        fair: `${(fairProb * 100).toFixed(1)}%`,
        momentum: `${(momentum.fraction * 100).toFixed(0)}%`,
        ttl: `${Math.round(secondsToSettlement)}s`,
        sigma: `${(sigma * 100).toFixed(0)}%`
      })

      signals.push({
        ticker,
        side,
        action: 'buy',
        count: limitedCount,
        price: entryPrice,
        reason: `Gamma scalp: OTM ${side.toUpperCase()} @ ${entryPrice}¢, edge ${(edge * 100).toFixed(1)}%, spot trending toward $${strikePrice}`,
        confidence,
        metadata: {
          strategy: this.name,
          fairProb,
          edge,
          entryPrice,
          spotPrice,
          strikePrice,
          secondsToSettlement,
          momentumFraction: momentum.fraction
        }
      })
      this.diagnostics.push(diag)
    }

    return signals
  }

  /**
   * Check exit conditions for existing gamma position
   * @param {string} ticker
   * @param {Object} position
   * @param {{ yesBid: number, yesAsk: number }} liquidity
   * @param {number} secondsToSettlement
   * @param {Object} params
   * @returns {import('../base-strategy.js').Signal | null}
   */
  checkExit(ticker, position, liquidity, secondsToSettlement, params) {
    const contracts = position.contracts || 0
    if (contracts <= 0) return null

    const exitPrice = position.side === 'yes'
      ? liquidity.yesBid
      : 100 - liquidity.yesAsk
    const costBasis = position.avgCost || 0
    const priceDelta = exitPrice - costBasis

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

    // Take profit
    if (priceDelta >= params.takeProfitCents) {
      this.log(`EXIT (profit) ${ticker}: +${priceDelta.toFixed(0)}¢`)
      return makeExit(`Take profit: +${priceDelta.toFixed(0)}¢ (target ${params.takeProfitCents}¢)`)
    }

    // Stop loss
    if (priceDelta <= -params.stopLossCents) {
      this.log(`EXIT (stop) ${ticker}: ${priceDelta.toFixed(0)}¢`)
      return makeExit(`Stop loss: ${priceDelta.toFixed(0)}¢ (limit -${params.stopLossCents}¢)`)
    }

    // Force exit before settlement
    if (secondsToSettlement < params.minSecondsToSettlement) {
      this.log(`EXIT (time) ${ticker}: ${Math.round(secondsToSettlement)}s left`)
      return makeExit(`Time exit: ${Math.round(secondsToSettlement)}s left, P&L ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
    }

    return null
  }

  shouldEvaluate(market) {
    if (!this.enabled) return false
    return market.type === 'crypto'
  }
}

module.exports = GammaScalperStrategy
