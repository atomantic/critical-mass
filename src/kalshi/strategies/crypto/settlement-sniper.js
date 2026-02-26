/**
 * Settlement Sniper Strategy
 *
 * Volatility-adjusted probability model (pseudo Black-Scholes) that trades
 * the 2-5 minute sweet spot before settlement, where edge is clearest but
 * the market hasn't fully repriced.
 *
 * Core edge: Coinbase spot moves first (sub-second), CF Benchmarks RTI follows
 * (seconds delay), Kalshi market price reprices last (seconds to minutes delay).
 *
 * P(BTC > strike) = Phi((spot - strike) / (sigma * spot * sqrt(T)))
 */

const BaseStrategy = require('../base-strategy.js')
const { parseStrikePrice, getCoinbaseTickerForKalshi, getBracketInfo } = require('../../adapters/markets.js')
const {
  calculateRollingVolatility,
  calculateFairProbability,
  checkLiquidity,
  calculateNetEdge
} = require('../../services/volatility-service.js')
const { isBullish } = require('../../services/updown-signal-fetcher.js')

/**
 * Determine time window based on seconds to settlement
 * @param {number} seconds
 * @param {Object} params
 * @returns {'no_trade' | 'exit' | 'primary' | 'scout' | 'monitor'}
 */
const getTimeWindow = (seconds, params) => {
  if (seconds < params.noTradeBelow) return 'no_trade'
  if (seconds < params.exitWindowMin) return 'exit'  // this won't trigger since noTradeBelow === exitWindowMin by default, but allows config separation
  if (seconds < params.primaryEntryMin + 180) return 'primary' // 120-300s
  if (seconds < params.monitorOnlyAbove) return 'scout'
  return 'monitor'
}

class SettlementSniperStrategy extends BaseStrategy {
  constructor(config) {
    super('settlement-sniper', config)
    /** @type {Map<string, {sigma: number, updatedAt: number, dataPoints: number}>} */
    this.volCache = new Map()
  }

  getDefaultParams() {
    return {
      volatilityWindow: 300,
      minVolatilityDataPoints: 30,
      edgeThreshold: 0.12,
      minEntryPrice: 15,
      maxEntryPrice: 85,
      minMomentumConfirm: 3,
      monitorOnlyAbove: 3600,
      primaryEntryMin: 300,
      exitWindowMin: 60,
      noTradeBelow: 45,
      kellyFraction: 0.20,
      maxBetPct: 0.05,
      maxContracts: 200,
      maxPositions: 3,
      stopLossEdge: 0.08,
      settlementRideThreshold: 0.40,
      settlementRideMaxSeconds: 180,
      minSigma: 0.18,
      bullishOnly: true,
      updownGating: true,
      maxBetPctCeiling: 0.30
    }
  }

  /**
   * Check momentum confirmation from Coinbase price history
   * Returns fraction of recent ticks trending toward our side
   * @param {Array<{price: number, timestamp: number}>} history
   * @param {'yes' | 'no'} side - yes = expecting price up, no = expecting price down
   * @param {number} lookback - Number of recent ticks to check
   * @returns {number} Fraction of ticks confirming (0-1)
   */
  checkMomentumConfirmation(history, side, lookback = 10) {
    if (!history || history.length < lookback + 1) return 0

    const recent = history.slice(-(lookback + 1))
    let confirming = 0

    for (let i = 1; i < recent.length; i++) {
      const delta = recent[i].price - recent[i - 1].price
      if (side === 'yes' && delta > 0) confirming++
      if (side === 'no' && delta < 0) confirming++
    }

    return confirming / lookback
  }

  /**
   * Calculate position size using fractional Kelly criterion
   * f* = edge / (1 - edge) for binary outcomes
   * @param {number} edge - Our edge (0-1)
   * @param {number} bankroll - Available balance
   * @param {number} entryPrice - Entry price in cents (for dollar conversion)
   * @param {Object} params
   * @returns {number} Number of contracts
   */
  kellySize(edge, bankroll, entryPrice, params) {
    if (edge <= 0 || !Number.isFinite(edge)) return 0

    const fullKelly = edge / (1 - edge)
    const fractionalKelly = params.kellyFraction * fullKelly
    const maxByPct = bankroll * params.maxBetPct
    const dollarBet = Math.min(fractionalKelly * bankroll, maxByPct)

    // Convert dollar bet to contracts using actual entry price
    const pricePerContract = (entryPrice || 50) / 100
    const contracts = Math.floor(dollarBet / pricePerContract)

    return Math.max(1, Math.min(contracts, params.maxContracts))
  }

  /**
   * Get or calculate cached volatility
   * @param {string} coinbaseTicker
   * @param {Array<{price: number, timestamp: number}>} history
   * @param {Object} params
   * @returns {{ sigma: number, dataPoints: number } | null}
   */
  getVolatility(coinbaseTicker, history, params) {
    const cached = this.volCache.get(coinbaseTicker)
    const now = Date.now()

    // Recalculate every 30 seconds
    if (cached && now - cached.updatedAt < 30000) {
      return { sigma: cached.sigma, dataPoints: cached.dataPoints }
    }

    const vol = calculateRollingVolatility(history, params.volatilityWindow)
    if (!vol) return null

    // Apply volatility floor — calibrated from 170 data points (realized ~0.16-0.20 annualized)
    vol.sigma = Math.max(vol.sigma, params.minSigma || 0.18)

    this.volCache.set(coinbaseTicker, { ...vol, updatedAt: now })
    return vol
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
      // Skip daily markets — Black-Scholes model with sigma=0.4 and T=14400s
      // pushes all probabilities toward 0.50; sniper edge model is not calibrated
      // for daily horizons. Swing-flipper handles daily markets instead.
      const tickerTimeframe = context.marketInfo?.get(ticker)?.timeframe
      if (tickerTimeframe === 'daily') continue

      const coinbaseTicker = getCoinbaseTickerForKalshi(ticker)
      if (!coinbaseTicker) continue

      // Use composite price when available, fall back to Coinbase-only
      const spotPrice = context.compositePrices?.get(coinbaseTicker)?.price
        ?? context.coinbasePrices?.get(coinbaseTicker)
      if (!spotPrice) continue

      const history = context.priceHistory?.get(ticker)
      const marketInfo = priceData || history?.[history.length - 1]
      if (!marketInfo?.title) continue

      const strikePrice = parseStrikePrice(marketInfo.title, ticker)
      if (!strikePrice) continue

      // Detect bracket market structure (B-prefix tickers are range/bracket markets)
      const { isBracket, bracketWidth } = getBracketInfo(ticker)

      const closeTime = marketInfo.close_time ? new Date(marketInfo.close_time).getTime() : null
      if (!closeTime) continue

      const secondsToSettlement = Math.max(0, (closeTime - now) / 1000)
      const timeWindow = getTimeWindow(secondsToSettlement, params)

      // Get price history for volatility and momentum (prefer composite, fall back to Coinbase)
      const compositeHistory = context.compositePriceHistory?.get(coinbaseTicker)
      const cbHistory = compositeHistory?.length > 60
        ? compositeHistory
        : context.coinbasePriceHistory?.get(coinbaseTicker)

      // Calculate volatility (needed for all windows except no_trade)
      let vol = timeWindow !== 'no_trade'
        ? this.getVolatility(coinbaseTicker, cbHistory, params)
        : null

      // Prefer market-implied vol from cross-bracket analytics when reliable
      const bracketData = context.bracketAnalytics?.byTicker?.get(ticker)
      if (vol && bracketData?.impliedVol?.reliable) {
        vol = {
          sigma: Math.max(bracketData.impliedVol.sigma, params.minSigma || 0.18),
          dataPoints: vol.dataPoints,
          source: 'implied'
        }
      }

      // Base diagnostic for this market
      const diag = {
        ticker,
        strike: strikePrice,
        spot: spotPrice,
        ttl: Math.round(secondsToSettlement),
        window: timeWindow,
        vol: vol?.sigma ?? null,
        volSource: vol?.source || 'historical',
        volPoints: vol?.dataPoints ?? 0,
        impliedVol: bracketData?.impliedVol?.sigma ?? null,
        bracketSum: bracketData?.bracketSum?.mid ?? null,
        mispricing: bracketData?.mispricing ?? null,
        fairProb: null,
        marketProb: null,
        edge: null,
        status: ''
      }

      // --- no_trade: settlement averaging begun ---
      if (timeWindow === 'no_trade') {
        diag.status = 'settlement averaging'
        this.diagnostics.push(diag)
        const existingPosition = context.positions.find(p => p.ticker === ticker && p.metadata?.strategy === this.name)
        if (existingPosition) {
          const liquidity = checkLiquidity(priceData)
          if (liquidity.valid) {
            const exitPrice = existingPosition.side === 'yes'
              ? liquidity.yesBid
              : 100 - liquidity.yesAsk

            this.log(`FORCED EXIT ${ticker}: settlement averaging begun (${Math.round(secondsToSettlement)}s)`)
            signals.push({
              ticker,
              side: existingPosition.side,
              action: 'sell',
              count: existingPosition.contracts,
              price: exitPrice,
              reason: `Forced exit: settlement averaging begun (${Math.round(secondsToSettlement)}s left)`,
              confidence: 0.95,
              metadata: { strategy: this.name }
            })
          }
        }
        continue
      }

      // --- monitor: collect vol data only ---
      if (timeWindow === 'monitor') {
        diag.status = vol ? `collecting vol (${vol.dataPoints} pts)` : 'waiting for vol data'
        this.diagnostics.push(diag)
        continue
      }

      // Compute fair probability early (useful even without liquidity)
      if (vol && vol.dataPoints >= params.minVolatilityDataPoints) {
        diag.fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, vol.sigma, bracketWidth)
      }

      // Below here we need liquidity and volatility
      const liquidity = checkLiquidity(priceData)

      // --- Check existing positions for exit signals ---
      const existingPosition = context.positions.find(p => p.ticker === ticker && p.metadata?.strategy === this.name)
      if (existingPosition) {
        const exitSignal = this.checkExitConditions(
          ticker, existingPosition, spotPrice, strikePrice,
          secondsToSettlement, timeWindow, vol, liquidity, cbHistory, params, bracketWidth
        )
        if (exitSignal) signals.push(exitSignal)
        diag.status = exitSignal ? `EXIT: ${exitSignal.reason}` : 'holding position'
        this.diagnostics.push(diag)
        continue
      }

      if (!liquidity.valid) {
        diag.status = `no liquidity: ${liquidity.reason}`
        this.diagnostics.push(diag)
        continue
      }

      // --- scout: calculate edge, log, don't trade ---
      if (timeWindow === 'scout') {
        if (vol && vol.dataPoints >= params.minVolatilityDataPoints) {
          const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, vol.sigma, bracketWidth)
          const marketProb = liquidity.yesAsk / 100
          const edge = fairProb - marketProb
          diag.fairProb = fairProb
          diag.marketProb = marketProb
          diag.edge = edge
          diag.status = 'scouting (not in entry window)'
        } else {
          diag.status = `need ${params.minVolatilityDataPoints} vol pts (have ${vol?.dataPoints || 0})`
        }
        this.diagnostics.push(diag)
        continue
      }

      // --- primary: ENTRY ZONE ---
      if (timeWindow !== 'primary') continue

      // Need sufficient volatility data
      if (!vol || vol.dataPoints < params.minVolatilityDataPoints) {
        diag.status = `insufficient vol (${vol?.dataPoints || 0}/${params.minVolatilityDataPoints})`
        this.diagnostics.push(diag)
        continue
      }

      // Check position limits
      const strategyPositions = context.positions.filter(p =>
        p.metadata?.strategy === this.name
      ).length
      if (strategyPositions >= params.maxPositions) {
        diag.status = 'max positions reached'
        this.diagnostics.push(diag)
        continue
      }

      // UpDown signal gating — require bullish signal for new entries
      const updownSignal = context.updownSignal
      if (params.updownGating) {
        if (!updownSignal || updownSignal.stale || !isBullish(updownSignal)) {
          const reason = !updownSignal ? 'no signal' : updownSignal.stale ? 'stale signal' : `signal=${updownSignal.type}`
          diag.status = `updown gate: ${reason}`
          diag.updownType = updownSignal?.type ?? null
          this.diagnostics.push(diag)
          continue
        }
      }

      // Calculate fair probability
      const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, vol.sigma, bracketWidth)
      const marketProb = liquidity.yesAsk / 100
      const edge = fairProb - marketProb

      diag.fairProb = fairProb
      diag.marketProb = marketProb
      diag.edge = edge

      this.log(`ENTRY eval ${ticker}`, {
        ttl: `${Math.round(secondsToSettlement)}s`,
        spot: spotPrice.toFixed(2),
        strike: strikePrice,
        fair: `${(fairProb * 100).toFixed(1)}%`,
        market: `${(marketProb * 100).toFixed(1)}%`,
        edge: `${(edge * 100).toFixed(1)}%`,
        vol: `${(vol.sigma * 100).toFixed(1)}%`
      })

      // 1. Edge must exceed threshold
      if (Math.abs(edge) < params.edgeThreshold) {
        diag.status = `edge ${(Math.abs(edge) * 100).toFixed(1)}% < ${(params.edgeThreshold * 100).toFixed(0)}% threshold`
        this.diagnostics.push(diag)
        continue
      }

      const side = edge > 0 ? 'yes' : 'no'

      // Bullish-only: never bet NO (betting against BTC)
      if (params.bullishOnly && side === 'no') {
        diag.status = 'bullish-only: skip NO side'
        this.diagnostics.push(diag)
        continue
      }

      // Bullish bracket filter: only trade brackets where midpoint >= spot
      // Brackets below spot require BTC to fall to settle in-range = bearish bet
      if (params.bullishOnly && isBracket && bracketWidth > 0) {
        const bracketMidpoint = strikePrice + bracketWidth / 2
        if (bracketMidpoint < spotPrice) {
          diag.status = `bullish filter: bracket mid $${bracketMidpoint.toFixed(0)} < spot $${spotPrice.toFixed(0)}`
          this.diagnostics.push(diag)
          continue
        }
      }

      // 2. Momentum confirmation
      const momentumConfirm = this.checkMomentumConfirmation(cbHistory, side)
      if (momentumConfirm < 0.4) {
        diag.status = `momentum ${(momentumConfirm * 100).toFixed(0)}% < 40%`
        this.diagnostics.push(diag)
        this.log(`Skip ${ticker}: momentum ${(momentumConfirm * 100).toFixed(0)}% < 40%`)
        continue
      }

      // 3. Order book imbalance boost/penalty
      const bookMetrics = context.orderBookMetrics?.get(coinbaseTicker)
      let bookConfidenceAdj = 0
      let bookNote = ''

      if (bookMetrics) {
        const obi = bookMetrics.strikeImbalance ?? bookMetrics.imbalance
        // Imbalance > 0.2 in our direction: boost
        if ((side === 'yes' && obi > 0.2) || (side === 'no' && obi < -0.2)) {
          bookConfidenceAdj += 0.10
          bookNote = `OBI ${(obi * 100).toFixed(0)}% confirms`
        }

        // Wall detection near strike
        if (bookMetrics.walls?.length > 0) {
          for (const wall of bookMetrics.walls) {
            const wallBlocksUs = (side === 'yes' && wall.side === 'ask' && wall.price <= strikePrice + 100)
              || (side === 'no' && wall.side === 'bid' && wall.price >= strikePrice - 100)
            const wallSupportsUs = (side === 'yes' && wall.side === 'bid' && wall.price >= strikePrice - 100)
              || (side === 'no' && wall.side === 'ask' && wall.price <= strikePrice + 100)

            if (wallBlocksUs) {
              bookConfidenceAdj -= 0.15
              bookNote += ` | wall blocks @ $${wall.price.toFixed(0)}`
              break
            }
            if (wallSupportsUs) {
              bookConfidenceAdj += 0.10
              bookNote += ` | wall supports @ $${wall.price.toFixed(0)}`
              break
            }
          }
        }

        diag.bookImbalance = obi
        diag.bookNote = bookNote || null
      }

      // 4. Cross-bracket mispricing confirmation
      if (bracketData?.mispricing != null) {
        const mispricingConfirms = (side === 'yes' && bracketData.mispricing > 0.02)
          || (side === 'no' && bracketData.mispricing < -0.02)
        const mispricingConflicts = (side === 'yes' && bracketData.mispricing < -0.03)
          || (side === 'no' && bracketData.mispricing > 0.03)

        if (mispricingConfirms) {
          bookConfidenceAdj += 0.08
          bookNote += ` | IV mispricing ${(bracketData.mispricing * 100).toFixed(1)}% confirms`
        }
        if (mispricingConflicts) {
          bookConfidenceAdj -= 0.10
          bookNote += ` | IV mispricing ${(bracketData.mispricing * 100).toFixed(1)}% conflicts`
        }
        diag.mispricingAdj = mispricingConfirms ? 'confirm' : mispricingConflicts ? 'conflict' : 'neutral'
      }

      // 5. Polymarket sentiment confirmation
      let sentimentNote = ''
      const sentiment = context.polymarketSentiment
      if (sentiment && Date.now() - sentiment.updatedAt < 120_000) {
        const upPrice = sentiment.upPrice ?? 0
        const downPrice = sentiment.downPrice ?? 0
        if (side === 'yes' && upPrice > 0.60) {
          bookConfidenceAdj += 0.08
          sentimentNote = `crowd YES ${(upPrice * 100).toFixed(0)}% confirms`
        } else if (side === 'no' && downPrice > 0.60) {
          bookConfidenceAdj += 0.08
          sentimentNote = `crowd NO ${(downPrice * 100).toFixed(0)}% confirms`
        } else if (side === 'yes' && downPrice > 0.65) {
          bookConfidenceAdj -= 0.10
          sentimentNote = `crowd opposes YES (down=${(downPrice * 100).toFixed(0)}%)`
        } else if (side === 'no' && upPrice > 0.65) {
          bookConfidenceAdj -= 0.10
          sentimentNote = `crowd opposes NO (up=${(upPrice * 100).toFixed(0)}%)`
        }
        diag.sentimentNote = sentimentNote || 'neutral'
      }

      // 6. Trade flow imbalance confirmation
      let tradeFlowNote = ''
      const tradeFlow = context.tradeFlowMetrics?.get('BTC-USD')
      if (tradeFlow && tradeFlow.tradeCount60s > 0) {
        const imb = tradeFlow.imbalance60s
        if ((side === 'yes' && imb > 0.3) || (side === 'no' && imb < -0.3)) {
          bookConfidenceAdj += 0.08
          tradeFlowNote = `flow ${(imb * 100).toFixed(0)}% confirms`
        } else if ((side === 'yes' && imb < -0.3) || (side === 'no' && imb > 0.3)) {
          bookConfidenceAdj -= 0.08
          tradeFlowNote = `flow ${(imb * 100).toFixed(0)}% opposes`
        }
        diag.tradeFlowNote = tradeFlowNote || 'neutral'
        diag.tradeFlowImbalance60s = imb
      }

      // 7. Cross-exchange divergence signal
      const composite = context.compositePrices?.get(coinbaseTicker)
      if (composite?.maxDivergence > 0.001) {
        diag.exchangeDivergence = composite.maxDivergence
        diag.exchangeCount = composite.exchangeCount
      }

      // 8. Price in range (YES: buy at ask+1, NO: buy at 100-bid with conservative pricing)
      const entryPrice = side === 'yes'
        ? liquidity.yesAsk + 1
        : 100 - liquidity.yesBid - 1

      if (entryPrice < params.minEntryPrice || entryPrice > params.maxEntryPrice) {
        diag.status = `price ${entryPrice}c outside ${params.minEntryPrice}-${params.maxEntryPrice}c`
        this.diagnostics.push(diag)
        this.log(`Skip ${ticker}: price ${entryPrice}c outside ${params.minEntryPrice}-${params.maxEntryPrice}c`)
        continue
      }

      // Position sizing via fractional Kelly with UpDown confidence scaling
      const absEdge = Math.abs(edge)
      let sizingParams = params
      if (params.updownGating && updownSignal && !updownSignal.stale) {
        const udConf = updownSignal.confidence ?? 0
        let multiplier = 1.0
        if (updownSignal.type === 'STRONG_BUY' && udConf >= 0.7) multiplier = 2.5
        else if (updownSignal.type === 'STRONG_BUY' && udConf >= 0.5) multiplier = 2.0
        else if (updownSignal.type === 'BUY' && udConf >= 0.5) multiplier = 1.0
        else if (updownSignal.type === 'BUY' && udConf >= 0.3) multiplier = 0.7

        const scaledMaxBetPct = Math.min(params.maxBetPct * multiplier, params.maxBetPctCeiling || 0.30)
        sizingParams = { ...params, maxBetPct: scaledMaxBetPct }
      }
      const count = this.kellySize(absEdge, context.balance?.available || 0, entryPrice, sizingParams)

      // Net-edge gating: reject if fees + slippage eat the edge
      const { netEdge, feePerContract } = calculateNetEdge(absEdge, count, entryPrice)
      if (netEdge <= 0) {
        diag.status = `fees eat edge (gross=$${absEdge.toFixed(3)}/ct, fees=$${feePerContract.toFixed(3)}/ct)`
        this.diagnostics.push(diag)
        this.log(`Skip ${ticker}: net $${netEdge.toFixed(3)}/contract after fees (gross $${absEdge.toFixed(3)})`)
        continue
      }

      const confidence = Math.max(0, Math.min(1, Math.min(absEdge / (params.edgeThreshold * 2), 1) + bookConfidenceAdj))

      diag.status = `ENTRY ${side.toUpperCase()} ${count}x @ ${entryPrice}c`

      this.log(`ENTRY signal: ${ticker} ${side.toUpperCase()}`, {
        edge: `${(edge * 100).toFixed(1)}%`,
        momentum: `${(momentumConfirm * 100).toFixed(0)}%`,
        price: `${entryPrice}c`,
        count,
        kelly: `${(absEdge / (1 - absEdge) * params.kellyFraction * 100).toFixed(1)}%`
      })

      signals.push({
        ticker,
        side,
        action: 'buy',
        count,
        price: entryPrice,
        reason: `Sniper: edge ${(edge * 100).toFixed(1)}%, vol ${(vol.sigma * 100).toFixed(0)}%, momentum ${(momentumConfirm * 100).toFixed(0)}%, ${Math.round(secondsToSettlement)}s to settle`,
        confidence,
        metadata: {
          strategy: this.name,
          fairProb,
          marketProb,
          edge,
          sigma: vol.sigma,
          ttl: Math.round(secondsToSettlement),
          momentumConfirm,
          secondsToSettlement,
          bookImbalance: bookMetrics?.imbalance ?? null,
          compositePrice: composite?.price ?? null,
          exchangeCount: composite?.exchangeCount ?? null,
          updownType: updownSignal?.type ?? null,
          updownScore: updownSignal?.score ?? null,
          updownConfidence: updownSignal?.confidence ?? null,
          updownTrendBias: updownSignal?.trendBias ?? null
        }
      })
      this.diagnostics.push(diag)
    }

    return signals
  }

  /**
   * Check exit conditions for an existing position
   * @param {string} ticker
   * @param {Object} position
   * @param {number} spotPrice
   * @param {number} strikePrice
   * @param {number} secondsToSettlement
   * @param {string} timeWindow
   * @param {{ sigma: number, dataPoints: number } | null} vol
   * @param {{ valid: boolean, yesBid: number, yesAsk: number, lastPrice: number }} liquidity
   * @param {Array<{price: number, timestamp: number}>} cbHistory
   * @param {Object} params
   * @returns {import('../base-strategy.js').Signal | null}
   */
  checkExitConditions(ticker, position, spotPrice, strikePrice, secondsToSettlement, timeWindow, vol, liquidity, cbHistory, params, bracketWidth = 0) {
    const contracts = position.contracts || 0
    if (contracts <= 0) return null

    if (!liquidity.valid) return null

    const exitPrice = position.side === 'yes'
      ? liquidity.yesBid
      : 100 - liquidity.yesAsk

    // Recalculate current edge from our position's perspective
    let currentEdge = 0
    if (vol?.sigma) {
      const fairProb = calculateFairProbability(spotPrice, strikePrice, secondsToSettlement, vol.sigma, bracketWidth)
      const marketProb = liquidity.yesAsk / 100
      currentEdge = position.side === 'yes'
        ? fairProb - marketProb
        : (1 - fairProb) - (1 - marketProb)
    }

    // Exit in exit window (< 60s) unless settlement ride
    if (timeWindow === 'exit') {
      // Exception: ride to settlement if edge is very strong and near settlement
      if (currentEdge > params.settlementRideThreshold && secondsToSettlement <= params.settlementRideMaxSeconds) {
        this.log(`SETTLEMENT RIDE ${ticker}: edge ${(currentEdge * 100).toFixed(1)}% > ${(params.settlementRideThreshold * 100).toFixed(0)}%, holding for $1 payout`)
        return null
      }

      this.log(`EXIT (time) ${ticker}: ${Math.round(secondsToSettlement)}s to settlement`)
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contracts,
        price: exitPrice,
        reason: `Time exit: ${Math.round(secondsToSettlement)}s to settlement`,
        confidence: 0.9,
        metadata: { strategy: this.name }
      }
    }

    // Edge reversed beyond stop loss threshold (our thesis is wrong)
    if (currentEdge < -params.stopLossEdge) {
      this.log(`EXIT (stop loss) ${ticker}: edge ${(currentEdge * 100).toFixed(1)}% < -${(params.stopLossEdge * 100).toFixed(0)}%`)
      return {
        ticker,
        side: position.side,
        action: 'sell',
        count: contracts,
        price: exitPrice,
        reason: `Stop loss: edge reversed to ${(currentEdge * 100).toFixed(1)}%`,
        confidence: 0.95,
        metadata: { strategy: this.name }
      }
    }

    return null
  }

  shouldEvaluate(market) {
    if (!this.enabled) return false
    return market.type === 'crypto'
  }
}

module.exports = SettlementSniperStrategy
