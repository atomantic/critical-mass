/**
 * Coinbase Fair Value Strategy
 *
 * Core Insight: Kalshi prices are LAGGING indicators. Coinbase spot prices are LEADING indicators.
 * The edge is reacting to Coinbase moves before Kalshi market makers reprice.
 *
 * Entry Logic:
 * 1. Get spot price from Coinbase, strike from market title
 * 2. Calculate distance: (spot - strike) / strike
 * 3. Estimate fair probability based on distance and time to settlement
 * 4. Compare fair probability to Kalshi YES price
 * 5. Enter when divergence > threshold
 */

const BaseStrategy = require('../base-strategy.js')
const { parseStrikePrice, getCoinbaseTickerForKalshi, getBracketInfo } = require('../../adapters/markets.js')
const { calculateFairProbability, getSigma, checkLiquidity, calculateNetEdge } = require('../../services/volatility-service.js')

/**
 * @typedef {Object} FairValueParams
 * @property {number} edgeThreshold - Min divergence to enter (default 0.10 = 10%)
 * @property {number} exitEdgeThreshold - Exit when edge shrinks below this (default 0.05)
 * @property {number} minSecondsToSettlement - Don't trade within this many seconds of settlement
 * @property {number} stopLossPct - Stop loss percentage (default 0.15 = 15%)
 * @property {number} takeProfitPct - Take profit percentage (default 0.20 = 20%)
 * @property {number} positionSize - Default contracts per trade
 * @property {number} maxPositions - Max open positions for this strategy
 * @property {number} minEntryPrice - Minimum entry price in cents (avoid extreme lows)
 * @property {number} maxEntryPrice - Maximum entry price in cents (avoid extreme highs where fees eat profit)
 */

class CoinbaseFairValueStrategy extends BaseStrategy {
  constructor(config) {
    super('coinbase-fair-value', config)
  }

  getDefaultParams() {
    return {
      edgeThreshold: 0.15,        // 15% divergence required (was 25% - too restrictive for efficiently-priced markets)
      exitEdgeThreshold: 0.10,    // Exit when edge shrinks to 10%
      minSecondsToSettlement: 30, // Trade closer to settlement (was 60s)
      maxSecondsToSettlement: 300, // 5 min window to find edge before settlement
      forceExitSeconds: 60,       // Force exit at 60s before settlement to avoid binary risk
      stopLossPct: 0.30,          // 30% stop loss (was 15% - too tight)
      takeProfitPct: 0.15,        // 15% take profit (was 20% - take wins earlier)
      positionSize: 5,            // 5 contracts per trade
      maxPositions: 2,            // Max 2 positions per strategy
      minEntryPrice: 10,          // Don't buy below 10¢ (was 5¢)
      maxEntryPrice: 90,          // Don't buy above 90¢ (was 95¢)
      kellyFraction: 0.15,        // 15% fractional Kelly for edge-proportional sizing
      maxBetPct: 0.03,            // 3% of bankroll max per trade
      maxContracts: 100            // Cap contracts to limit single-trade exposure
    }
  }

  /**
   * Calculate position size using fractional Kelly criterion
   * Matches settlement-sniper's edge-proportional sizing instead of
   * generic confidence scaling that oversizes on marginal edges.
   * @param {number} edge - Our edge (0-1)
   * @param {number} bankroll - Available balance
   * @param {number} entryPrice - Entry price in cents
   * @param {Object} params
   * @returns {number} Number of contracts
   */
  kellySize(edge, bankroll, entryPrice, params) {
    if (edge <= 0 || !Number.isFinite(edge)) return 0

    const fullKelly = edge / (1 - edge)
    const fractionalKelly = (params.kellyFraction ?? 0.15) * fullKelly
    const maxByPct = bankroll * (params.maxBetPct ?? 0.03)
    const dollarBet = Math.min(fractionalKelly * bankroll, maxByPct)

    const pricePerContract = (entryPrice || 50) / 100
    const contracts = Math.floor(dollarBet / pricePerContract)

    return Math.max(1, Math.min(contracts, params.maxContracts ?? 100))
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
      // Get Coinbase ticker for this Kalshi market
      const coinbaseTicker = getCoinbaseTickerForKalshi(ticker)
      if (!coinbaseTicker) continue

      // Use composite price when available, fall back to Coinbase-only
      const spotPrice = context.compositePrices?.get(coinbaseTicker)?.price
        ?? context.coinbasePrices?.get(coinbaseTicker)
      if (!spotPrice) continue

      // Need market title to parse strike price - get from price data or history
      const history = context.priceHistory?.get(ticker)
      const marketInfo = priceData || history?.[history.length - 1]
      if (!marketInfo?.title) continue

      // Parse strike price from title or ticker
      const strikePrice = parseStrikePrice(marketInfo.title, ticker)
      if (!strikePrice) continue

      // Detect bracket market structure (B-prefix tickers are range/bracket markets)
      const { bracketWidth } = getBracketInfo(ticker)

      // Calculate time to settlement
      const closeTime = marketInfo.close_time ? new Date(marketInfo.close_time).getTime() : null
      if (!closeTime) continue

      const secondsToSettlement = Math.max(0, (closeTime - now) / 1000)

      // Skip if too close to settlement
      if (secondsToSettlement < params.minSecondsToSettlement) {
        this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: 'too close to settlement' })
        continue
      }

      // Skip if too far from settlement (edge is uncertain, prices haven't converged)
      if (params.maxSecondsToSettlement && secondsToSettlement > params.maxSecondsToSettlement) {
        this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: `too far (${Math.round(secondsToSettlement)}s > ${params.maxSecondsToSettlement}s)` })
        continue
      }

      // *** LIQUIDITY CHECK - Skip illiquid markets ***
      const liquidity = checkLiquidity(priceData)
      if (!liquidity.valid) {
        this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: `no liquidity: ${liquidity.reason}` })
        continue
      }

      // Resolve sigma via centralized fallback chain
      const bracketData = context.bracketAnalytics?.byTicker?.get(ticker)
      const compositeHistory = context.compositePriceHistory?.get(coinbaseTicker)
      const cbHistory = compositeHistory?.length > 60
        ? compositeHistory
        : context.coinbasePriceHistory?.get(coinbaseTicker)
      const { sigma, source: sigmaSource } = getSigma({ bracketData, priceHistory: cbHistory })

      // Check if we have an existing position (only manage OUR positions)
      const existingPosition = context.positions.find(p => p.ticker === ticker && p.metadata?.strategy === this.name)
      if (existingPosition) {
        const exitSignal = this.checkExitSignal(ticker, priceData, existingPosition, spotPrice, strikePrice, secondsToSettlement, params, liquidity, bracketWidth, sigma)
        if (exitSignal) signals.push(exitSignal)
        continue
      }

      // Skip entry if another strategy already has a position on this ticker
      const otherPosition = context.positions.find(p => p.ticker === ticker)
      if (otherPosition) continue

      // Check position limits
      const strategyPositions = context.positions.filter(p =>
        p.metadata?.strategy === this.name
      ).length
      if (strategyPositions >= params.maxPositions) continue

      // Calculate fair probability using resolved sigma
      const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, sigma, bracketWidth)

      // *** USE REAL LIQUIDITY DATA FOR PRICING ***
      const kalshiYesPrice = liquidity.yesAsk  // Real ask price
      const kalshiProb = kalshiYesPrice / 100

      // Calculate edge (divergence)
      const edge = fairProb - kalshiProb

      // Log for debugging
      this.log(`Evaluating ${ticker}`, {
        spot: spotPrice.toFixed(2),
        strike: strikePrice,
        fair: `${(fairProb * 100).toFixed(1)}%`,
        kalshi: `${(kalshiProb * 100).toFixed(1)}%`,
        edge: `${(edge * 100).toFixed(1)}%`,
        ttl: `${Math.round(secondsToSettlement)}s`,
        sigma: `${(sigma * 100).toFixed(0)}% (${sigmaSource})`,
        yesBid: liquidity.yesBid,
        yesAsk: liquidity.yesAsk
      })

      // Scale edge threshold with time — need more edge further from settlement
      // Capped at 1.3x to avoid making the threshold impossible at 5min TTL
      const timeScale = Math.min(1.3, Math.max(1, 1 + Math.log(Math.max(1, secondsToSettlement / 120))))
      const effectiveThreshold = params.edgeThreshold * timeScale

      // Check for entry signal
      if (Math.abs(edge) >= effectiveThreshold) {
        this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: `SIGNAL edge=${(edge * 100).toFixed(1)}%`, edge })
        const side = edge > 0 ? 'yes' : 'no'

        // Order book imbalance confidence modifier (lighter weight for wider time horizon)
        let bookAdj = 0
        const bookMetrics = context.orderBookMetrics?.get(coinbaseTicker)
        if (bookMetrics) {
          const obi = bookMetrics.imbalance
          if ((side === 'yes' && obi > 0.2) || (side === 'no' && obi < -0.2)) {
            bookAdj = 0.05
          }
        }

        const confidence = Math.max(0, Math.min(1, Math.min(Math.abs(edge) / (params.edgeThreshold * 2), 1) + bookAdj))

        // Entry price with slippage: YES buy at ask+1, NO buy at (100-bid) with conservative pricing
        const price = side === 'yes'
          ? liquidity.yesAsk + 1
          : 100 - liquidity.yesBid - 1

        const count = this.kellySize(Math.abs(edge), context.balance?.available || 0, price, params)

        // Skip if price is too extreme (fees eat profit)
        if (price < params.minEntryPrice || price > params.maxEntryPrice) {
          this.log(`Skip ${ticker}: price ${price}¢ outside bounds ${params.minEntryPrice}-${params.maxEntryPrice}¢`)
          continue
        }

        // Net-edge gating: reject if fees + slippage eat the edge
        const { netEdge, feePerContract } = calculateNetEdge(Math.abs(edge), count, price)
        if (netEdge <= 0) {
          this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: `fees eat edge (gross=$${Math.abs(edge).toFixed(3)}/ct, fees=$${feePerContract.toFixed(3)}/ct)` })
          this.log(`Skip ${ticker}: net $${netEdge.toFixed(3)}/contract after fees (gross $${Math.abs(edge).toFixed(3)})`)
          continue
        }

        this.log(`Entry signal: ${ticker} ${side.toUpperCase()}`, {
          fair: `${(fairProb * 100).toFixed(1)}%`,
          kalshi: `${(kalshiProb * 100).toFixed(1)}%`,
          edge: `${(edge * 100).toFixed(1)}%`,
          netEdge: `${(netEdge * 100).toFixed(1)}%`,
          price: `${price}¢`,
          confidence: confidence.toFixed(2)
        })

        signals.push({
          ticker,
          side,
          action: 'buy',
          count,
          price,
          reason: `Fair value: spot $${spotPrice.toFixed(0)} vs strike $${strikePrice}, fair ${(fairProb * 100).toFixed(0)}% vs market ${(kalshiProb * 100).toFixed(0)}%`,
          confidence,
          metadata: {
            strategy: this.name,
            fairProb,
            kalshiProb,
            spotPrice,
            strikePrice,
            edge,
            compositePrice: context.compositePrices?.get(coinbaseTicker)?.price ?? null,
            exchangeCount: context.compositePrices?.get(coinbaseTicker)?.exchangeCount ?? null,
            bookImbalance: bookMetrics?.imbalance ?? null
          }
        })
      } else {
        this.diagnostics.push({ ticker, ttl: Math.round(secondsToSettlement), status: `edge ${(Math.abs(edge) * 100).toFixed(1)}% < ${(effectiveThreshold * 100).toFixed(1)}% threshold (${timeScale.toFixed(1)}x)`, edge })
      }
    }

    return signals
  }

  /**
   * Check for exit signal on existing position
   * @param {string} ticker
   * @param {Object} priceData
   * @param {Object} position
   * @param {number} spotPrice
   * @param {number} strikePrice
   * @param {number} secondsToSettlement
   * @param {FairValueParams} params
   * @param {{ yesBid: number, yesAsk: number, lastPrice: number }} liquidity
   * @returns {import('../base-strategy.js').Signal | null}
   */
  checkExitSignal(ticker, priceData, position, spotPrice, strikePrice, secondsToSettlement, params, liquidity, bracketWidth = 0, sigma = 0.55) {
    const contractCount = position.contracts || position.count
    if (!contractCount || contractCount <= 0) return null

    const costBasis = position.avgCost || position.price || 50

    // *** USE REAL LIQUIDITY DATA FOR EXIT PRICING ***
    // For YES position: sell at yesBid
    // For NO position: sell at (100 - yesAsk)
    // Use lastPrice as fallback if bid/ask not available
    let exitPrice
    if (position.side === 'yes') {
      exitPrice = liquidity.yesBid > 1 ? liquidity.yesBid : (liquidity.lastPrice || costBasis)
    } else {
      exitPrice = liquidity.yesAsk < 99 ? (100 - liquidity.yesAsk) : (liquidity.lastPrice ? 100 - liquidity.lastPrice : costBasis)
    }

    // Sanity check: don't exit at obviously bad prices (< 5% of cost basis)
    if (exitPrice < costBasis * 0.05 && exitPrice < 5) {
      this.log(`Skip exit ${ticker}: exit price ${exitPrice}¢ too low vs cost ${costBasis}¢ - likely bad data`)
      return null
    }

    const pnlPct = (exitPrice - costBasis) / costBasis

    // Note: No raw price stop loss — we rely on edge-based exits (Exit 4 below).
    // Raw price stop losses caused whipsaw: the model still shows edge after price drops,
    // so the strategy would re-enter immediately after stopping out.

    // Exit 0: Force exit before settlement to avoid binary all-or-nothing risk.
    // Data shows 3/4 CFV settlement rides went to $0. Pre-settlement exits are safer.
    const forceExitSec = params.forceExitSeconds ?? 60
    if (forceExitSec > 0 && secondsToSettlement <= forceExitSec) {
      this.log(`Exit signal (forced pre-settlement): ${ticker}`, { secondsToSettlement: Math.round(secondsToSettlement), exitPrice, pnlPct: `${(pnlPct * 100).toFixed(1)}%` })
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contractCount,
        price: exitPrice,
        reason: `Forced pre-settlement exit (${Math.round(secondsToSettlement)}s remaining, P&L ${(pnlPct * 100).toFixed(1)}%)`,
        confidence: 0.95
      }
    }

    // Exit 1: Take profit
    if (pnlPct > params.takeProfitPct) {
      this.log(`Exit signal (take profit): ${ticker}`, { pnlPct: `${(pnlPct * 100).toFixed(1)}%`, exitPrice })
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contractCount,
        price: exitPrice,
        reason: `Take profit: ${(pnlPct * 100).toFixed(1)}% gain`,
        confidence: 0.85
      }
    }

    // Exit 2: Too close to settlement (avoid binary risk)
    if (secondsToSettlement < params.minSecondsToSettlement) {
      this.log(`Exit signal (near settlement): ${ticker}`, { secondsToSettlement, exitPrice })
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contractCount,
        price: exitPrice,
        reason: `Exiting before settlement (${Math.round(secondsToSettlement)}s remaining)`,
        confidence: 0.9
      }
    }

    // Exit 3: Edge shrunk below threshold (or reversed)
    const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, sigma, bracketWidth)
    const kalshiProb = liquidity.yesAsk / 100
    // YES edge = fairProb - kalshiProb; NO edge = (1 - fairProb) - (1 - kalshiProb) = kalshiProb - fairProb
    const edge = position.side === 'yes'
      ? fairProb - kalshiProb
      : kalshiProb - fairProb

    // Exit if edge reversed (negative = market moved against our thesis)
    if (edge < 0) {
      this.log(`Exit signal (edge reversed): ${ticker}`, { edge: `${(edge * 100).toFixed(1)}%`, exitPrice })
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contractCount,
        price: exitPrice,
        reason: `Edge reversed to ${(edge * 100).toFixed(1)}%`,
        confidence: 0.9
      }
    }

    // Exit if edge shrunk below threshold (our thesis is weakening)
    if (edge < params.exitEdgeThreshold) {
      this.log(`Exit signal (edge shrunk): ${ticker}`, {
        edge: `${(edge * 100).toFixed(1)}%`,
        threshold: `${(params.exitEdgeThreshold * 100).toFixed(1)}%`,
        exitPrice
      })
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contractCount,
        price: exitPrice,
        reason: `Edge shrunk to ${(edge * 100).toFixed(1)}%`,
        confidence: 0.7
      }
    }

    return null
  }

  shouldEvaluate(market) {
    if (!this.enabled) return false
    return market.type === 'crypto'
  }
}

module.exports = CoinbaseFairValueStrategy
