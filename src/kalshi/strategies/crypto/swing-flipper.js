/**
 * Swing Flipper Strategy
 *
 * Rides intra-window volatility on ATM bracket contracts. Instead of predicting
 * the settlement outcome, buys dips and sells rips for small, consistent profits.
 *
 * Philosophy: "Pigs get fat, hogs get slaughtered." Take 8-12 cents per flip.
 *
 * Targets ATM contracts (30-60¢) where oscillation amplitude is highest because
 * BTC spot is near the bracket boundary. Uses Coinbase spot as a leading indicator
 * — spot moves 2-5s before Kalshi reprices.
 *
 * Conservative: 2% max bet, 30 contracts max, 6¢ stop loss, never hold to settlement.
 */

const BaseStrategy = require('../base-strategy.js')
const { parseStrikePrice, getCoinbaseTickerForKalshi, getBracketInfo } = require('../../adapters/markets.js')
const { checkLiquidity } = require('../../services/volatility-service.js')

class SwingFlipperStrategy extends BaseStrategy {
  constructor(config) {
    super('swing-flipper', config)
  }

  getDefaultParams() {
    return {
      // ATM price range (cents) — oscillation amplitude is highest here
      minContractPrice: 30,
      maxContractPrice: 60,

      // Oscillation detection
      minOscillationRange: 12,  // Cents — contract must prove it's swinging
      oscillationLookback: 15,  // Number of recent price snapshots

      // Entry: buy the dip
      pullbackEntry: 8,         // Cents below recent peak to trigger buy

      // Exit targets (cents)
      takeProfitCents: 8,       // Small consistent bite
      stopLossCents: 6,         // Cut losses faster than gains

      // Time window (seconds to settlement)
      minSecondsToSettlement: 90,   // Never hold through settlement
      maxSecondsToSettlement: 540,  // 9 min — oscillation needs time

      // Oscillation collapse detection
      collapseRangeThreshold: 6,    // Cents — if range drops below this, exit
      collapseLookback: 8,          // Ticks to measure collapse

      // Spot confirmation
      minSpotNearBracket: 0.5,  // Spot within 50% of bracket width from edge

      // Conservative sizing
      maxBetPct: 0.02,
      maxContracts: 30,
      maxPositions: 2,
      positionSize: 5
    }
  }

  /**
   * Measure oscillation range (high - low) over recent price history
   * @param {Array<Object>} history - Price snapshots for the ticker
   * @param {number} lookback - Number of snapshots to consider
   * @returns {{ range: number, high: number, low: number, recentPeak: number }}
   */
  measureOscillation(history, lookback) {
    if (!history || history.length < 3) {
      return { range: 0, high: 0, low: Infinity, recentPeak: 0 }
    }

    const recent = history.slice(-lookback)
    let high = 0
    let low = Infinity

    for (const snap of recent) {
      const price = snap.lastPrice ?? snap.yesAsk ?? 0
      if (price > 0) {
        if (price > high) high = price
        if (price < low) low = price
      }
    }

    if (low === Infinity) low = 0

    return {
      range: high - low,
      high,
      low,
      recentPeak: high
    }
  }

  /**
   * Check if Coinbase spot is moving toward the bracket boundary
   * @param {Array<{price: number, timestamp: number}>} spotHistory
   * @param {number} strikePrice - Bracket boundary
   * @param {number} spotPrice - Current spot
   * @returns {boolean}
   */
  isSpotMovingTowardBracket(spotHistory, strikePrice, spotPrice) {
    if (!spotHistory || spotHistory.length < 3) return false

    const recent = spotHistory.slice(-5)
    const oldest = recent[0].price
    const newest = recent[recent.length - 1].price
    const delta = newest - oldest

    // Moving toward = moving down if above strike, up if below strike
    const aboveStrike = spotPrice > strikePrice
    return aboveStrike ? delta < 0 : delta > 0
  }

  /**
   * Check if spot is near the bracket boundary (within threshold of bracket width)
   * @param {number} spotPrice
   * @param {number} strikePrice
   * @param {number} bracketWidth
   * @param {number} threshold - Fraction of bracket width (e.g. 0.5 = 50%)
   * @returns {boolean}
   */
  isSpotNearBracket(spotPrice, strikePrice, bracketWidth, threshold) {
    if (!bracketWidth || !spotPrice || !strikePrice) return false
    const distance = Math.abs(spotPrice - strikePrice)
    return distance <= bracketWidth * threshold
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

      const { isBracket, bracketWidth } = getBracketInfo(ticker)

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
        const exitSignal = this.checkExit(ticker, existingPosition, liquidity, secondsToSettlement, history, params)
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

      // ATM filter: determine which side (YES or NO) is in the 30-60¢ range
      const yesPrice = liquidity.yesAsk
      const noPrice = 100 - liquidity.yesBid

      const yesIsATM = yesPrice >= params.minContractPrice && yesPrice <= params.maxContractPrice
      const noIsATM = noPrice >= params.minContractPrice && noPrice <= params.maxContractPrice

      if (!yesIsATM && !noIsATM) {
        diag.status = `not ATM (YES ${yesPrice}¢, NO ${noPrice}¢)`
        this.diagnostics.push(diag)
        continue
      }

      // Pick the ATM side
      const side = yesIsATM ? 'yes' : 'no'
      const currentPrice = side === 'yes' ? yesPrice : noPrice

      // Oscillation detection: contract must have proven range > threshold
      const oscillation = this.measureOscillation(history, params.oscillationLookback)
      if (oscillation.range < params.minOscillationRange) {
        diag.status = `low oscillation (${oscillation.range}¢ < ${params.minOscillationRange}¢)`
        this.diagnostics.push(diag)
        continue
      }

      // Pullback entry: current price must be below recent peak by pullbackEntry cents
      const pullback = oscillation.recentPeak - currentPrice
      if (pullback < params.pullbackEntry) {
        diag.status = `insufficient pullback (${pullback.toFixed(0)}¢ < ${params.pullbackEntry}¢, peak=${oscillation.recentPeak}¢)`
        this.diagnostics.push(diag)
        continue
      }

      // Spot near bracket: confirms oscillation will continue
      if (isBracket && bracketWidth > 0) {
        if (!this.isSpotNearBracket(spotPrice, strikePrice, bracketWidth, params.minSpotNearBracket)) {
          diag.status = `spot too far from bracket ($${spotPrice.toFixed(0)} vs $${strikePrice} ± ${bracketWidth * params.minSpotNearBracket})`
          this.diagnostics.push(diag)
          continue
        }
      }

      // Spot direction confirmation: spot should be moving toward the bracket
      const compositeHistory = context.compositePriceHistory?.get(coinbaseTicker)
      const spotHistory = compositeHistory?.length > 5
        ? compositeHistory
        : context.coinbasePriceHistory?.get(coinbaseTicker)
      if (!this.isSpotMovingTowardBracket(spotHistory, strikePrice, spotPrice)) {
        diag.status = 'spot moving away from bracket'
        this.diagnostics.push(diag)
        continue
      }

      // Position sizing (conservative)
      const confidence = Math.min(1, 0.5 + (oscillation.range / 40))
      const count = this.calculatePositionSize(confidence, context.balance, context.config?.risk, currentPrice)
      const limitedCount = Math.min(count, params.maxContracts)

      diag.status = `ENTRY ${side.toUpperCase()} ${limitedCount}x @ ${currentPrice}¢ (osc=${oscillation.range}¢, pullback=${pullback.toFixed(0)}¢)`

      this.log(`ENTRY: ${ticker} ${side.toUpperCase()} @ ${currentPrice}¢`, {
        oscillation: `${oscillation.range}¢`,
        pullback: `${pullback.toFixed(0)}¢`,
        peak: `${oscillation.recentPeak}¢`,
        ttl: `${Math.round(secondsToSettlement)}s`,
        spot: `$${spotPrice.toFixed(0)}`
      })

      signals.push({
        ticker,
        side,
        action: 'buy',
        count: limitedCount,
        price: currentPrice,
        reason: `Swing flip: ${side.toUpperCase()} @ ${currentPrice}¢, pullback ${pullback.toFixed(0)}¢ from peak ${oscillation.recentPeak}¢, osc ${oscillation.range}¢`,
        confidence,
        metadata: {
          strategy: this.name,
          entryPrice: currentPrice,
          spotPrice,
          strikePrice,
          secondsToSettlement,
          ttl: Math.round(secondsToSettlement),
          oscillationRange: oscillation.range,
          recentPeak: oscillation.recentPeak,
          pullback,
          btcSpot: spotPrice
        }
      })
      this.diagnostics.push(diag)
    }

    return signals
  }

  /**
   * Check exit conditions for existing swing position
   * @param {string} ticker
   * @param {Object} position
   * @param {{ yesBid: number, yesAsk: number }} liquidity
   * @param {number} secondsToSettlement
   * @param {Array<Object>} history - Price history for oscillation collapse check
   * @param {Object} params
   * @returns {import('../base-strategy.js').Signal | null}
   */
  checkExit(ticker, position, liquidity, secondsToSettlement, history, params) {
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
      metadata: { strategy: this.name, btcSpot: null }
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

    // Time exit: never hold through settlement
    if (secondsToSettlement < params.minSecondsToSettlement) {
      this.log(`EXIT (time) ${ticker}: ${Math.round(secondsToSettlement)}s left`)
      return makeExit(`Time exit: ${Math.round(secondsToSettlement)}s left, P&L ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
    }

    // Oscillation collapse: if volatility dies, exit early
    if (history?.length >= params.collapseLookback) {
      const recent = history.slice(-params.collapseLookback)
      let high = 0
      let low = Infinity
      for (const snap of recent) {
        const price = snap.lastPrice ?? snap.yesAsk ?? 0
        if (price > 0) {
          if (price > high) high = price
          if (price < low) low = price
        }
      }
      if (low !== Infinity) {
        const recentRange = high - low
        if (recentRange < params.collapseRangeThreshold) {
          this.log(`EXIT (collapse) ${ticker}: range ${recentRange}¢ < ${params.collapseRangeThreshold}¢`)
          return makeExit(`Oscillation collapse: range ${recentRange}¢ < ${params.collapseRangeThreshold}¢, P&L ${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(0)}¢`)
        }
      }
    }

    return null
  }

  shouldEvaluate(market) {
    if (!this.enabled) return false
    return market.type === 'crypto'
  }
}

module.exports = SwingFlipperStrategy
