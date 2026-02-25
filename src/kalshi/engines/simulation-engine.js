/**
 * Simulation Engine
 * Runs strategies in dry-run mode with simulated order fills
 */

const { createStrategies, STRATEGY_INFO } = require('../strategies/index.js')
const { computeBracketAnalytics } = require('../services/cross-market-analytics.js')
const { trackPriceUpdate, settleExpiredTrackedMarkets, recordSettlement } = require('../services/conviction-tracker.js')
const { writeSnapshot } = require('../services/snapshot-writer.js')
const { writeEntry, writeExit, writeSettlement, writeReject, writeSessionSummary, writeShadowEntry, writeShadowExit, writeShadowSettlement, writeWindowSummary } = require('../services/journal-writer.js')
const { calculateKalshiFee, calculateFairProbability, calculateRollingVolatility, getSigma } = require('../services/volatility-service.js')
const { getBracketInfo, parseStrikePrice } = require('../adapters/markets.js')
const { sendAlert } = require('../services/alert-service.js')
const { analyzeTrade } = require('../services/trade-analyst.js')

const { ts } = require('../../time-utils')

/**
 * @typedef {Object} EngineState
 * @property {boolean} running
 * @property {string} mode - 'dry_run' | 'live'
 * @property {{ available: number, inPositions: number }} balance
 * @property {Array<Object>} positions
 * @property {{ trades: number, wins: number, pnl: number, fees: number }} todayStats
 * @property {Array<Object>} trades
 */

/**
 * Simulation Engine class
 */
class SimulationEngine {
  constructor() {
    /** @type {import('../strategies/base-strategy.js').BaseStrategy[]} */
    this.strategies = []
    /** @type {Map<string, Array<Object>>} */
    this.priceHistory = new Map()
    /** @type {Map<string, Object>} */
    this.currentPrices = new Map()
    /** @type {Map<string, number>} Coinbase spot prices by ticker (e.g., 'BTC-USD') */
    this.coinbasePrices = new Map()
    /** @type {Map<string, Array<{price: number, timestamp: number}>>} Coinbase price history for momentum */
    this.coinbasePriceHistory = new Map()
    /** @type {Map<string, Object>} Composite prices from exchange aggregator */
    this.compositePrices = new Map()
    /** @type {Map<string, Array<{price: number, timestamp: number}>>} Composite price history */
    this.compositePriceHistory = new Map()
    /** @type {Map<string, Object>} Order book metrics by ticker */
    this.orderBookMetrics = new Map()
    /** @type {Object | null} Latest Polymarket BTC sentiment */
    this.polymarketSentiment = null
    /** @type {Map<string, Object>} Trade flow imbalance metrics by ticker */
    this.tradeFlowMetrics = new Map()
    /** @type {Map<string, Object>} Kalshi orderbook metrics by ticker */
    this.kalshiBookMetrics = new Map()
    /** @type {Object | null} Live execution service reference */
    this.liveExecution = null
    /** @type {NodeJS.Timeout | null} */
    this.evaluationLoop = null
    /** @type {EngineState | null} */
    this.state = null
    /** @type {Object | null} */
    this.config = null
    /** @type {Function | null} */
    this.onStateChange = null
    /** @type {Function | null} */
    this.onTrade = null
    /** @type {Function | null} */
    this.onLog = null
    /** @type {Function | null} */
    this.saveState = null
    /** @type {Set<string>} */
    this.subscribedTickers = new Set()
    /** @type {Map<string, Object>} Market metadata by ticker (title, close_time, etc) */
    this.marketInfo = new Map()
    /** @type {Map<string, number>} Trade cooldown - ticker -> timestamp when can trade again */
    this.tradeCooldowns = new Map()
    /** @type {Map<string, { ticker: string, side: string, action: string, strategy: string, close_time: string, placedAt: number }>} Pending order reservations to prevent cross-strategy conflicts and duplicate sells before fill */
    this.pendingReservations = new Map()
    /** @type {number} Global max positions across all strategies */
    this.globalMaxPositions = 10
    /** @type {number} Cooldown in ms after any trade (buy or sell) */
    this.tradeCooldownMs = 60000 // 60 seconds
    /** @type {number} Max signals to execute per evaluation cycle */
    this.maxSignalsPerEval = 3
    /** @type {number} Counter for periodic diagnostic logging */
    this.evalCount = 0
    /** @type {import('../strategies/base-strategy.js').BaseStrategy[]} Disabled strategies for shadow evaluation */
    this.shadowStrategies = []
    /** @type {{ balance: { available: number, inPositions: number }, positions: Array<Object>, trades: Array<Object>, stats: Record<string, { trades: number, wins: number, pnl: number, winRate: number }> }} */
    this.shadowState = {
      balance: { available: 1000, inPositions: 0 },
      positions: [],
      trades: [],
      stats: {}
    }
    /** @type {Map<string, Object>} Peak absolute edge seen per ticker across eval cycles */
    this.peakEdges = new Map()
    /** @type {Map<string, Array<{reason: string, ticker: string, strategy: string, ts: number}>>} Rejection reasons grouped by close_time */
    this.windowRejects = new Map()
    /** @type {Array<Object>} Recent window summaries (bounded to last 50) */
    this.windowSummaries = []
    /** @type {Function | null} */
    this.onWindowSummary = null
    /** @type {number} Last time the live/shadow P&L divergence alert fired (epoch ms) */
    this.lastDivergenceAlertAt = 0
  }

  /**
   * Initialize engine with config and state
   * @param {Object} config
   * @param {EngineState} state
   * @param {{ saveState: Function, onTrade: Function, onStateChange: Function, onLog: Function }} callbacks
   */
  init(config, state, callbacks) {
    this.config = config
    this.state = state
    this.saveState = callbacks.saveState
    this.onTrade = callbacks.onTrade
    this.onStateChange = callbacks.onStateChange
    this.onLog = callbacks.onLog
    this.onWindowSummary = callbacks.onWindowSummary || null
    this.liveExecution = callbacks.liveExecution || null

    // Wire risk config to engine limits
    this.globalMaxPositions = config?.risk?.maxOpenPositions || 10
    this.maxSignalsPerEval = config?.risk?.maxSignalsPerEval || 3

    // Create strategy instances — separate into enabled (live) and disabled (shadow)
    // Evaluation order matters: pre-settlement-exit strategies first (lower risk),
    // then settlement-riding strategies (higher risk). This prevents high-risk strategies
    // from grabbing settlement windows before lower-risk alternatives can evaluate.
    const STRATEGY_EVAL_ORDER = [
      'gamma-scalper',      // Lowest risk per trade (~$4), exits before settlement
      'momentum-rider',     // Pre-settlement exit, only consistently profitable strategy
      'swing-flipper',      // Pre-settlement exit via take-profit/stop-loss
      'coinbase-fair-value', // Settlement-riding, higher risk
      'settlement-sniper'   // Settlement-riding, highest risk
    ]
    const allStrategies = createStrategies(config.strategies || {})
    const sortByEvalOrder = (a, b) => {
      const ai = STRATEGY_EVAL_ORDER.indexOf(a.name)
      const bi = STRATEGY_EVAL_ORDER.indexOf(b.name)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    }
    this.strategies = allStrategies.filter(s => s.enabled).sort(sortByEvalOrder)
    this.shadowStrategies = allStrategies.filter(s => !s.enabled).sort(sortByEvalOrder)

    // Restore shadow state from saved state (or initialize fresh)
    if (state.shadowState) {
      this.shadowState = state.shadowState
    } else {
      this.shadowState = { balance: { available: 1000, inPositions: 0 }, positions: [], trades: [], stats: {} }
    }
    // Reset shadow balance at the start of each day
    const today = new Date().toISOString().slice(0, 10)
    if (this.shadowState.lastResetDate !== today) {
      this.shadowState.balance = { available: 1000, inPositions: 0 }
      this.shadowState.lastResetDate = today
    }

    const enabledList = this.strategies.map(s => s.name)
    const shadowList = this.shadowStrategies.map(s => s.name)
    console.log(`[${ts()}] Engine initialized with ${allStrategies.length} strategies`)
    for (const s of this.strategies) {
      console.log(`[${ts()}]    |- ${s.name}: enabled`)
    }
    for (const s of this.shadowStrategies) {
      console.log(`[${ts()}]    |- ${s.name}: shadow`)
    }

    this.log('info', `Engine initialized with ${enabledList.length} live + ${shadowList.length} shadow strategies: ${enabledList.join(', ') || 'none'}`)
  }

  /**
   * Emit a log entry
   * @param {'info' | 'signal' | 'trade' | 'error' | 'eval'} type
   * @param {string} message
   * @param {Object} [data]
   */
  log(type, message, data = {}) {
    if (this.onLog) {
      this.onLog({
        type,
        message,
        data,
        timestamp: new Date().toISOString()
      })
    }
  }

  /**
   * Run startup self-tests to verify core math before trading.
   * Returns true if all tests pass, false otherwise.
   * @returns {boolean}
   */
  runSelfTests() {
    const failures = []

    // Test 1: bracket at midpoint should have moderate-high probability
    // With spot=strike, sigma=0.4, TTL=300s, bracketWidth=250: ~0.87-0.90 is correct
    const bracketMid = calculateFairProbability(67625, 67625, 300, 0.4, 250)
    if (bracketMid < 0.50 || bracketMid > 0.95) {
      failures.push(`calculateFairProbability(bracket at midpoint) = ${bracketMid.toFixed(4)}, expected [0.50, 0.95]`)
    }

    // Test 2: binary at strike should be near 0.50
    const binaryAtStrike = calculateFairProbability(67625, 67625, 300, 0.4, 0)
    if (binaryAtStrike < 0.45 || binaryAtStrike > 0.55) {
      failures.push(`calculateFairProbability(binary at strike) = ${binaryAtStrike.toFixed(4)}, expected [0.45, 0.55]`)
    }

    // Test 3: getBracketInfo for bracket ticker
    const bracketInfo = getBracketInfo('KXBTC-26FEB1611-B67625')
    if (!bracketInfo.isBracket || bracketInfo.bracketWidth !== 250) {
      failures.push(`getBracketInfo(bracket) = ${JSON.stringify(bracketInfo)}, expected { isBracket: true, bracketWidth: 250 }`)
    }

    // Test 4: getBracketInfo for non-bracket ticker
    const thresholdInfo = getBracketInfo('KXBTC-26FEB1611-T67625')
    if (thresholdInfo.isBracket) {
      failures.push(`getBracketInfo(threshold) = ${JSON.stringify(thresholdInfo)}, expected isBracket: false`)
    }

    if (failures.length > 0) {
      console.log(`[${ts()}] Self-tests FAILED (${failures.length}):`)
      for (const f of failures) console.log(`[${ts()}]    |- ${f}`)
      sendAlert('critical', 'Engine self-tests failed', { failures })
      return false
    }

    console.log(`[${ts()}] Self-tests passed (bracketMid=${bracketMid.toFixed(3)}, binaryStrike=${binaryAtStrike.toFixed(3)})`)
    return true
  }

  /**
   * Start the evaluation loop
   * @param {number} intervalMs - Evaluation interval (default 5000ms)
   */
  start(intervalMs = 5000) {
    if (this.evaluationLoop) {
      console.log(`[${ts()}] Engine already running`)
      this.log('info', 'Engine already running')
      return
    }

    // Run self-tests before starting
    if (!this.runSelfTests()) {
      this.log('error', 'Engine refused to start: self-tests failed')
      return
    }

    // Mandatory paper-trade period after strategy changes
    const minDryRunHours = this.config?.risk?.minDryRunHoursAfterChange ?? 0
    const lastChangeAt = this.config?.risk?.lastStrategyChangeAt
    if (minDryRunHours > 0 && lastChangeAt && !this.config.dryRun && this.liveExecution) {
      const hoursSinceChange = (Date.now() - new Date(lastChangeAt).getTime()) / 3_600_000
      if (hoursSinceChange < minDryRunHours) {
        const remaining = (minDryRunHours - hoursSinceChange).toFixed(1)
        console.log(`[${ts()}] Mandatory paper-trade: ${remaining}h remaining (changed ${lastChangeAt})`)
        sendAlert('warning', 'Forced paper-trade mode', { remaining: `${remaining}h`, lastChangeAt })
        this.config.dryRun = true
        this.liveExecution = null
      }
    }

    this.state.engineRunning = true

    console.log(`[${ts()}] Simulation engine started (eval every ${intervalMs}ms)`)
    this.log('info', `Engine started (evaluating every ${intervalMs / 1000}s)`)

    // Run first evaluation immediately
    this.runEvaluation().catch(err =>
      console.log(`[${ts()}] Eval cycle error: ${err.message}`)
    )

    // Then run on interval
    this.evaluationLoop = setInterval(() => {
      this.runEvaluation().catch(err =>
        console.log(`[${ts()}] Eval cycle error: ${err.message}`)
      )
    }, intervalMs)

    if (this.onStateChange) this.onStateChange(this.state)
  }

  /**
   * Stop the evaluation loop
   */
  stop({ preserveRunningFlag = false } = {}) {
    if (this.evaluationLoop) {
      clearInterval(this.evaluationLoop)
      this.evaluationLoop = null
    }

    if (this.state) {
      if (!preserveRunningFlag) this.state.engineRunning = false
      this.state.shadowState = this.shadowState
    }

    this.pendingReservations.clear()
    writeSessionSummary(this.state)

    console.log(`[${ts()}] Simulation engine stopped`)
    this.log('info', 'Engine stopped')

    if (this.onStateChange) this.onStateChange(this.state)
    if (this.saveState) this.saveState(this.state)
  }

  /**
   * Process a price update from WebSocket
   * @param {string} ticker
   * @param {Object} price
   */
  onPriceUpdate(ticker, price) {
    // Merge with stored market info (title, close_time)
    const info = this.marketInfo.get(ticker) || {}

    // Store current price with market info
    this.currentPrices.set(ticker, {
      ...price,
      ...info,
      ticker,
      updatedAt: new Date().toISOString()
    })

    // Add to history (keep last 60 updates)
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, [])
    }
    const history = this.priceHistory.get(ticker)
    history.push({
      ...price,
      ...info,
      ticker,
      updatedAt: new Date().toISOString()
    })
    if (history.length > 60) {
      history.shift()
    }

    this.subscribedTickers.add(ticker)

    // Track conviction thresholds for all markets
    if (info?.close_time) trackPriceUpdate(ticker, price, info)
  }

  /**
   * Set market metadata for a ticker (title, close_time, etc)
   * @param {string} ticker
   * @param {Object} info - Market info including title, close_time
   */
  setMarketInfo(ticker, info) {
    this.marketInfo.set(ticker, info)
  }

  /**
   * Set market info for multiple tickers at once
   * @param {Array<{ticker: string, title: string, close_time: string}>} markets
   */
  setMarketsInfo(markets) {
    for (const market of markets) {
      this.marketInfo.set(market.ticker, {
        title: market.title,
        close_time: market.close_time,
        event_ticker: market.event_ticker,
        type: market.type,
        asset: market.asset,
        timeframe: market.timeframe
      })
    }
  }

  /**
   * Process a Coinbase price update
   * @param {string} ticker - Coinbase ticker (e.g., 'BTC-USD')
   * @param {number} price - Current spot price
   * @param {Object} data - Full price data including bid/ask
   */
  onCoinbasePriceUpdate(ticker, price, data) {
    // Store current price
    this.coinbasePrices.set(ticker, price)

    // Add to history (keep last 900 updates ~15min at 1/sec for rolling volatility)
    if (!this.coinbasePriceHistory.has(ticker)) {
      this.coinbasePriceHistory.set(ticker, [])
    }
    const history = this.coinbasePriceHistory.get(ticker)
    history.push({
      price,
      bid: data.bid,
      ask: data.ask,
      timestamp: Date.now()
    })
    if (history.length > 900) {
      history.shift()
    }
  }

  /**
   * Process a composite price update from exchange aggregator
   * @param {string} ticker
   * @param {Object} composite - Composite price data
   */
  onCompositeUpdate(ticker, composite) {
    this.compositePrices.set(ticker, composite)

    // Maintain composite price history (900 entries like coinbase)
    if (!this.compositePriceHistory.has(ticker)) {
      this.compositePriceHistory.set(ticker, [])
    }
    const history = this.compositePriceHistory.get(ticker)
    history.push({
      price: composite.price,
      timestamp: Date.now()
    })
    if (history.length > 900) {
      history.shift()
    }
  }

  /**
   * Process order book metrics update
   * @param {string} ticker - Product ticker (e.g., 'BTC-USD')
   * @param {Object} metrics - Order book metrics
   */
  onOrderBookMetrics(ticker, metrics) {
    this.orderBookMetrics.set(ticker, metrics)
  }

  /**
   * Process Kalshi orderbook metrics update
   * @param {string} ticker - Market ticker
   * @param {Object} metrics - Kalshi book metrics
   */
  onKalshiOrderBookMetrics(ticker, metrics) {
    this.kalshiBookMetrics.set(ticker, metrics)
  }

  /**
   * Process Polymarket BTC sentiment update
   * @param {Object} sentiment - { upPrice, downPrice, slug, windowStart, windowEnd, ... }
   */
  onPolymarketSentiment(sentiment) {
    this.polymarketSentiment = sentiment
  }

  /**
   * Process trade flow imbalance update from price bridge
   * @param {string} ticker - Product ticker (e.g., 'BTC-USD')
   * @param {Object} tradeFlow - { imbalance60s, imbalance300s, buyVolume60s, sellVolume60s, tradeCount60s, updatedAt }
   */
  onTradeFlowUpdate(ticker, tradeFlow) {
    this.tradeFlowMetrics.set(ticker, tradeFlow)
  }

  /**
   * Determine the winning side for a settled market based on BTC spot
   * @param {string} ticker - Market ticker
   * @param {number} btcSpot - BTC spot price at/near settlement
   * @returns {'yes'|'no'|null} Winning side, or null if unknown market type
   */
  determineBracketOutcome(ticker, btcSpot) {
    const segments = ticker.split('-')
    const bracketSeg = segments[segments.length - 1]

    if (bracketSeg.startsWith('B')) {
      const midpoint = parseInt(bracketSeg.slice(1))
      const { bracketWidth } = getBracketInfo(ticker)
      const halfWidth = (bracketWidth || 250) / 2
      const lowerBound = midpoint - halfWidth
      const upperBound = midpoint + halfWidth
      return (btcSpot >= lowerBound && btcSpot < upperBound) ? 'yes' : 'no'
    } else if (bracketSeg.startsWith('T')) {
      const threshold = parseFloat(bracketSeg.slice(1))
      return btcSpot >= threshold ? 'yes' : 'no'
    }
    return null
  }

  /**
   * Settle positions for markets that have expired.
   * Called at the start of each evaluation cycle.
   */
  async settleExpiredPositions() {
    if (!this.state?.positions?.length) return

    const now = Date.now()
    const toSettle = []

    for (const position of this.state.positions) {
      const info = this.marketInfo.get(position.ticker)
      if (!info?.close_time) continue
      const closeTime = new Date(info.close_time).getTime()
      if (now < closeTime) continue
      toSettle.push(position)
    }

    if (toSettle.length === 0) return

    // Get BTC spot price for settlement determination
    const btcSpot = this.compositePrices.get('BTC-USD')?.price
      || this.coinbasePrices.get('BTC-USD')

    if (!btcSpot) {
      console.log(`[${ts()}] Cannot settle ${toSettle.length} expired position(s): no BTC spot price`)
      return
    }

    for (const position of toSettle) {
      await this.settlePosition(position, btcSpot)
    }
  }

  /**
   * Settle a single expired position based on BTC spot price
   * @param {Object} position - The position to settle
   * @param {number} btcSpot - BTC spot price at settlement
   */
  async settlePosition(position, btcSpot) {
    const ticker = position.ticker
    const segments = ticker.split('-')
    const bracketSeg = segments[segments.length - 1]

    let winningSide = this.determineBracketOutcome(ticker, btcSpot)

    if (bracketSeg.startsWith('B')) {
      const midpoint = parseInt(bracketSeg.slice(1))
      const lowerBound = midpoint - 125
      const upperBound = midpoint + 125
      console.log(`[${ts()}] Settlement: ${ticker} [$${lowerBound.toLocaleString()}, $${upperBound.toLocaleString()})`)
      console.log(`[${ts()}]    |- BTC: $${btcSpot.toLocaleString()} -> ${winningSide === 'yes' ? 'IN bracket -> YES wins' : 'OUTSIDE -> NO wins'}`)
    } else if (bracketSeg.startsWith('T')) {
      const threshold = parseFloat(bracketSeg.slice(1))
      console.log(`[${ts()}] Settlement: ${ticker} threshold $${threshold.toLocaleString()}`)
      console.log(`[${ts()}]    |- BTC: $${btcSpot.toLocaleString()} -> ${winningSide === 'yes' ? 'ABOVE -> YES wins' : 'BELOW -> NO wins'}`)
    } else {
      console.log(`[${ts()}] Unknown market type for ${ticker}, assuming loss`)
      winningSide = position.side === 'yes' ? 'no' : 'yes'
    }

    // Record conviction outcome for this market
    if (winningSide) recordSettlement(ticker, winningSide, btcSpot).catch(() => {})

    const won = position.side === winningSide
    const contracts = position.contracts
    const proceeds = won ? contracts : 0 // $1/contract if won, $0 if lost
    const costBasis = (contracts * position.avgCost) / 100
    const pnl = proceeds - costBasis

    console.log(`[${ts()}]    |- ${contracts}x ${position.side.toUpperCase()} @ ${position.avgCost}c (cost $${costBasis.toFixed(2)})`)
    console.log(`[${ts()}]    |- ${won ? 'WIN' : 'LOSS'}: proceeds $${proceeds.toFixed(2)}, P&L $${pnl.toFixed(2)} (fees paid: $${(position.feesPaid || 0).toFixed(2)})`)

    // Update balance
    this.state.balance.available += proceeds
    this.state.balance.inPositions = Math.max(0, this.state.balance.inPositions - costBasis)

    // Update stats
    this.state.todayStats.trades++
    this.state.todayStats.pnl += pnl
    if (pnl > 0) this.state.todayStats.wins++

    // Push settlement P&L to live execution circuit breaker
    if (this.liveExecution?.addToDailyPnl) {
      this.liveExecution.addToDailyPnl(pnl)
    }

    // Remove position
    this.state.positions = this.state.positions.filter(p => p !== position)

    // Record settlement trade with entry metadata for calibration
    const entryMeta = position.metadata || {}
    const trade = {
      id: `sim-settle-${Date.now()}`,
      ticker,
      side: position.side,
      action: 'settlement',
      count: contracts,
      price: won ? 100 : 0,
      fee: 0,
      costBasis,
      proceeds,
      pnl,
      strategy: entryMeta.strategy || 'unknown',
      reason: `Settlement ${won ? 'WIN' : 'LOSS'}: BTC $${btcSpot.toLocaleString()} ${winningSide === 'yes' ? 'in' : 'outside'} bracket`,
      entryEdge: entryMeta.entryEdge ?? null,
      entrySigma: entryMeta.entrySigma ?? null,
      entryFairProb: entryMeta.entryFairProb ?? null,
      entryMarketProb: entryMeta.entryMarketProb ?? null,
      entryBtcSpot: entryMeta.entryBtcSpot ?? null,
      timestamp: new Date().toISOString()
    }
    if (!this.state.trades) this.state.trades = []
    this.state.trades.push(trade)
    if (this.onTrade) this.onTrade(trade)

    writeSettlement(trade, btcSpot, winningSide)
    analyzeTrade({ trade, resolutionType: 'settlement', btcSpot, winningSide, trades: this.state?.trades }).catch(() => {})

    this.log('trade', `Settlement ${won ? 'WIN' : 'LOSS'}: ${ticker} ${contracts}x ${position.side.toUpperCase()} -- P&L $${pnl.toFixed(2)}`, {
      ticker, action: 'settlement', side: position.side, outcome: winningSide,
      won, contracts, proceeds, costBasis, pnl, btcSpot,
      strategy: position.metadata?.strategy
    })

    if (this.saveState) await this.saveState(this.state)
  }

  /**
   * Run one evaluation cycle
   */
  async runEvaluation() {
    if (!this.state?.engineRunning) return

    // Settle any expired positions first (dry-run only — live mode relies on exchange settlement)
    if (this.config.dryRun || !this.liveExecution) {
      await this.settleExpiredPositions()
    }

    // Compute BTC spot once — used by conviction tracking, window summaries, and strategy eval
    const btcSpot = this.compositePrices.get('BTC-USD')?.price
      || this.coinbasePrices.get('BTC-USD')

    // Update unrealized P&L for circuit breaker early-warning
    if (this.liveExecution?.updateUnrealizedPnl && this.state.positions?.length > 0) {
      this.liveExecution.updateUnrealizedPnl(this.state.positions, this.currentPrices)
    }

    // Settle conviction tracking for ALL expired markets (not just our positions)
    settleExpiredTrackedMarkets(this.marketInfo, btcSpot)

    // Clean up expired market data (60s grace period after close)
    const cleanupThreshold = Date.now() - 60000
    const expiredByWindow = new Map()
    for (const [ticker, info] of this.marketInfo) {
      if (!info?.close_time) continue
      if (new Date(info.close_time).getTime() < cleanupThreshold) {
        if (!expiredByWindow.has(info.close_time)) expiredByWindow.set(info.close_time, [])
        expiredByWindow.get(info.close_time).push(ticker)
      }
    }

    // Generate window summaries before cleanup removes price data
    this.generateWindowSummaries(expiredByWindow, btcSpot)

    // Remove expired data
    for (const tickers of expiredByWindow.values()) {
      for (const ticker of tickers) {
        this.marketInfo.delete(ticker)
        this.currentPrices.delete(ticker)
        this.priceHistory.delete(ticker)
        this.subscribedTickers.delete(ticker)
        this.peakEdges.delete(ticker)
      }
    }

    const enabledStrategies = this.strategies.filter(s => s.enabled)
    if (enabledStrategies.length === 0 && this.shadowStrategies.length === 0) {
      this.log('eval', 'No strategies enabled', { strategiesEnabled: 0 })
      return
    }

    const tickersTracking = Array.from(this.subscribedTickers)
    const pricesAvailable = this.currentPrices.size

    // Compute cross-market bracket analytics (implied vol, bracket sums, mispricing)
    const bracketAnalytics = computeBracketAnalytics(this.currentPrices, this.marketInfo, btcSpot)

    // Build context for strategy evaluation
    const context = {
      prices: this.currentPrices,
      priceHistory: this.priceHistory,
      coinbasePrices: this.coinbasePrices,
      coinbasePriceHistory: this.coinbasePriceHistory,
      compositePrices: this.compositePrices,
      compositePriceHistory: this.compositePriceHistory,
      orderBookMetrics: this.orderBookMetrics,
      kalshiBookMetrics: this.kalshiBookMetrics,
      polymarketSentiment: this.polymarketSentiment,
      tradeFlowMetrics: this.tradeFlowMetrics,
      bracketAnalytics,
      positions: this.state.positions || [],
      balance: this.state.balance,
      config: this.config,
      marketInfo: this.marketInfo
    }

    // Log price history summary for debugging
    const historyStats = Array.from(this.priceHistory.entries()).map(([ticker, history]) => {
      const latest = history[history.length - 1]
      return {
        ticker,
        count: history.length,
        lastPrice: latest?.lastPrice,
        yesBid: latest?.yesBid,
        yesAsk: latest?.yesAsk
      }
    })

    // Evaluate each strategy
    let totalSignals = 0
    let signalsExecuted = 0
    const evaluationResults = []
    const now = Date.now()

    // Clean up expired cooldowns
    for (const [ticker, expiry] of this.tradeCooldowns) {
      if (expiry < now) this.tradeCooldowns.delete(ticker)
    }

    // Prune stale pending reservations (older than 60s — fill should have arrived by then)
    for (const [ticker, res] of this.pendingReservations) {
      if (now - res.placedAt > 60_000) {
        console.log(`[${ts()}] Pruning stale reservation: ${res.side} ${ticker} (${res.strategy}, ${Math.round((now - res.placedAt) / 1000)}s old)`)
        this.pendingReservations.delete(ticker)
      }
    }

    // Store btcSpot for journal access in executeSignal
    this.evalBtcSpot = btcSpot

    for (const strategy of enabledStrategies) {
      strategy.diagnostics = []
      let signals
      try {
        signals = strategy.evaluate(context)
      } catch (err) {
        console.log(`[${ts()}] Strategy ${strategy.name} threw: ${err.message}`)
        this.log('error', `Strategy ${strategy.name} error: ${err.message}`, { strategy: strategy.name, stack: err.stack?.split('\n')[1]?.trim() })
        continue
      }

      // Track peak edges per ticker for window summaries
      for (const d of strategy.diagnostics) {
        if (d.edge == null || d.ticker == null) continue
        const existing = this.peakEdges.get(d.ticker)
        if (!existing || Math.abs(d.edge) > Math.abs(existing.edge)) {
          this.peakEdges.set(d.ticker, {
            edge: d.edge,
            fairProb: d.fairProb,
            marketProb: d.marketProb,
            side: d.edge >= 0 ? 'yes' : 'no',
            strategy: strategy.name,
            strike: d.strike,
            seenAt: Date.now()
          })
        }
      }

      totalSignals += signals.length

      // Build evaluation summary for this strategy
      const evalResult = {
        strategy: strategy.name,
        signalCount: signals.length,
        signals: signals.map(s => ({
          ticker: s.ticker,
          action: s.action,
          side: s.side,
          reason: s.reason,
          confidence: s.confidence
        })),
        diagnostics: strategy.diagnostics || []
      }
      evaluationResults.push(evalResult)

      for (const signal of signals) {
        // Helper to record a rejection reason for this signal's settlement window
        const recordWindowReject = (reason) => {
          const closeTime = this.marketInfo.get(signal.ticker)?.close_time
          if (!closeTime) return
          if (!this.windowRejects.has(closeTime)) this.windowRejects.set(closeTime, [])
          this.windowRejects.get(closeTime).push({ reason, ticker: signal.ticker, strategy: strategy.name, ts: now })
        }

        // Check global limits before executing
        if (signalsExecuted >= this.maxSignalsPerEval) {
          console.log(`[${ts()}] Max signals per eval reached (${this.maxSignalsPerEval})`)
          writeReject(signal, 'max signals per eval', { strategy: strategy.name, positionCount: this.state.positions.length, maxPositions: this.globalMaxPositions })
          recordWindowReject('max signals per eval')
          break
        }

        // Check global position limit for buy signals
        if (signal.action === 'buy' && this.state.positions.length >= this.globalMaxPositions) {
          console.log(`[${ts()}] Global position limit reached (${this.globalMaxPositions})`)
          writeReject(signal, 'global position limit', { strategy: strategy.name, positionCount: this.state.positions.length, maxPositions: this.globalMaxPositions })
          recordWindowReject('position limit')
          continue
        }

        // Check cooldown for this ticker (applies to buys only — we always allow exits)
        const cooldownExpiry = this.tradeCooldowns.get(signal.ticker)
        if (cooldownExpiry && cooldownExpiry > now && signal.action === 'buy') {
          writeReject(signal, 'cooldown active', { strategy: strategy.name, positionCount: this.state.positions.length, maxPositions: this.globalMaxPositions })
          recordWindowReject('cooldown')
          continue
        }

        // Edge sanity cap: reject signals with absurdly high edge (likely a math bug)
        if (signal.action === 'buy') {
          const maxEdgeSanity = this.config?.risk?.maxEdgeSanity ?? 0.50
          const signalEdge = Math.abs(signal.metadata?.edge ?? 0)
          if (signalEdge > maxEdgeSanity) {
            writeReject(signal, 'edge sanity cap', { strategy: strategy.name, edge: signalEdge.toFixed(3), maxEdgeSanity })
            recordWindowReject('edge sanity cap')
            sendAlert('warning', 'Edge sanity cap triggered', { ticker: signal.ticker, edge: signalEdge.toFixed(3), maxEdgeSanity, strategy: strategy.name })
            continue
          }
        }

        // Cross-position conflict: only one position per settlement window
        // Prevents toxic overlaps (e.g., YES on range A + NO on adjacent range B)
        if (signal.action === 'buy') {
          const signalInfo = this.marketInfo.get(signal.ticker)
          if (signalInfo?.close_time) {
            const positionsInWindow = this.state.positions.filter(p => {
              if (p.ticker === signal.ticker) return false // same ticker handled below
              const posInfo = this.marketInfo.get(p.ticker)
              return posInfo?.close_time === signalInfo.close_time
            })
            // Also check pending reservations (orders placed but not yet filled)
            const reservationsInWindow = []
            for (const [rTicker, res] of this.pendingReservations) {
              if (rTicker === signal.ticker) continue
              if (res.close_time === signalInfo.close_time) reservationsInWindow.push(res)
            }
            // Check recent trades for this settlement window (survives restarts)
            const recentTradesInWindow = (this.state.trades || []).filter(t => {
              if (t.action !== 'buy') return false
              if (t.ticker === signal.ticker) return false
              const tradeAge = Date.now() - new Date(t.timestamp).getTime()
              if (tradeAge > 3600_000) return false
              const tradeInfo = this.marketInfo.get(t.ticker)
              return tradeInfo?.close_time === signalInfo.close_time
            })
            if (positionsInWindow.length > 0 || reservationsInWindow.length > 0 || recentTradesInWindow.length > 0) {
              const existingPos = positionsInWindow.map(p => `${p.side} ${p.ticker}`).join(', ')
              const existingRes = reservationsInWindow.map(r => `${r.side} ${r.ticker} (pending)`).join(', ')
              const existingTrades = recentTradesInWindow.map(t => `${t.side} ${t.ticker} (recent trade)`).join(', ')
              const existing = [existingPos, existingRes, existingTrades].filter(Boolean).join(', ')
              writeReject(signal, 'settlement window conflict', { strategy: strategy.name, existing, closeTime: signalInfo.close_time })
              recordWindowReject('window conflict')
              continue
            }
          }
        }

        // Max exposure per settlement window (caps total $ at risk for a single event)
        if (signal.action === 'buy') {
          const maxWindowExposure = this.config?.risk?.maxExposurePerWindow ?? 75
          const signalInfo = this.marketInfo.get(signal.ticker)
          if (signalInfo?.close_time) {
            const windowExposure = this.state.positions
              .filter(p => this.marketInfo.get(p.ticker)?.close_time === signalInfo.close_time)
              .reduce((sum, p) => sum + ((p.contracts || 0) * (p.avgCost || 0)) / 100, 0)
            const signalCost = (signal.count * (signal.price || 50)) / 100
            if (windowExposure + signalCost > maxWindowExposure) {
              writeReject(signal, 'settlement window exposure cap', { strategy: strategy.name, windowExposure: windowExposure.toFixed(2), signalCost: signalCost.toFixed(2), max: maxWindowExposure })
              recordWindowReject('exposure cap')
              continue
            }
          }
        }

        // Enforce per-ticker max contracts and cross-strategy dedup
        if (signal.action === 'buy') {
          const maxContracts = this.config?.risk?.maxPositionContracts || 500
          // Check pending reservations for this ticker (order placed, fill pending)
          const pendingRes = this.pendingReservations.get(signal.ticker)
          if (pendingRes && pendingRes.strategy !== strategy.name && pendingRes.side !== signal.side) {
            writeReject(signal, 'ticker reserved by other strategy (opposite side, pending)', { strategy: strategy.name, reservedBy: pendingRes.strategy, reservedSide: pendingRes.side, signalSide: signal.side })
            recordWindowReject('conflicting order')
            continue
          }
          // Check ALL positions on this ticker (any side, any strategy)
          const existingPos = this.state.positions.find(p => p.ticker === signal.ticker)
          if (existingPos) {
            // If another strategy owns this position on the OPPOSITE side, block it
            if (existingPos.metadata?.strategy !== strategy.name && existingPos.side !== signal.side) {
              writeReject(signal, 'ticker owned by other strategy (opposite side)', { strategy: strategy.name, existingSide: existingPos.side, signalSide: signal.side, positionCount: this.state.positions.length, maxPositions: this.globalMaxPositions })
              recordWindowReject('conflicting order')
              continue
            }
            // Enforce max contracts (regardless of which strategy owns it)
            if (existingPos.contracts >= maxContracts) {
              writeReject(signal, 'max contracts on ticker', { strategy: strategy.name, positionCount: this.state.positions.length, maxPositions: this.globalMaxPositions })
              recordWindowReject('max contracts')
              continue
            }
            const remaining = maxContracts - existingPos.contracts
            if (signal.count > remaining) {
              signal.count = remaining
            }
          }
        }

        // Block duplicate sell orders: if a sell is already pending fill for this ticker, skip
        if (signal.action === 'sell') {
          const pendingRes = this.pendingReservations.get(signal.ticker)
          if (pendingRes && pendingRes.action === 'sell') {
            continue
          }
        }

        const result = await this.executeSignal(signal, strategy.name)
        if (result?.success) {
          signalsExecuted++
          // Set cooldown after successful trade to prevent churn (buy->sell->buy loops)
          this.tradeCooldowns.set(signal.ticker, now + this.tradeCooldownMs)
        }
      }
    }

    // Write snapshot for backtesting data collection
    const allSignals = evaluationResults.flatMap(r => r.signals)
    writeSnapshot(context, bracketAnalytics, allSignals)

    // --- Shadow mode: evaluate disabled strategies ---
    if (this.shadowStrategies.length > 0) {
      // Settle expired shadow positions first
      this.settleExpiredShadowPositions(btcSpot)

      const shadowContext = {
        ...context,
        positions: this.shadowState.positions,
        balance: this.shadowState.balance
      }

      for (const strategy of this.shadowStrategies) {
        strategy.diagnostics = []
        // Temporarily enable strategy for evaluation
        const wasEnabled = strategy.enabled
        strategy.enabled = true
        let signals
        try {
          signals = strategy.evaluate(shadowContext)
        } catch (err) {
          console.log(`[${ts()}] Shadow ${strategy.name} threw: ${err.message}`)
          strategy.enabled = wasEnabled
          continue
        }
        strategy.enabled = wasEnabled

        // Track peak edges from shadow diagnostics too
        for (const d of strategy.diagnostics) {
          if (d.edge == null || d.ticker == null) continue
          const existing = this.peakEdges.get(d.ticker)
          if (!existing || Math.abs(d.edge) > Math.abs(existing.edge)) {
            this.peakEdges.set(d.ticker, {
              edge: d.edge,
              fairProb: d.fairProb,
              marketProb: d.marketProb,
              side: d.edge >= 0 ? 'yes' : 'no',
              strategy: strategy.name,
              strike: d.strike,
              seenAt: Date.now()
            })
          }
        }

        for (const signal of signals) {
          if (signal.action === 'buy') {
            // Apply same guards against shadow state
            const existingShadow = this.shadowState.positions.find(p => p.ticker === signal.ticker)
            if (existingShadow) continue

            // Settlement window conflict in shadow state
            const signalInfo = this.marketInfo.get(signal.ticker)
            if (signalInfo?.close_time) {
              const shadowWindowConflict = this.shadowState.positions.some(p => {
                if (p.ticker === signal.ticker) return false
                const posInfo = this.marketInfo.get(p.ticker)
                return posInfo?.close_time === signalInfo.close_time
              })
              if (shadowWindowConflict) continue
            }
          }

          this.executeShadowSignal(signal, strategy.name)
        }
      }

      // Persist shadow state
      if (this.state && this.saveState) {
        this.state.shadowState = this.shadowState
      }

      // Dry-run parity monitor: alert if live P&L diverges badly from best shadow strategy
      if (!this.config.dryRun && this.liveExecution && Object.keys(this.shadowState.stats).length > 0) {
        const livePnl = this.state.todayStats?.pnl ?? 0
        let bestShadowPnl = -Infinity
        let bestShadowName = ''
        for (const [name, stats] of Object.entries(this.shadowState.stats)) {
          if (stats.pnl > bestShadowPnl) {
            bestShadowPnl = stats.pnl
            bestShadowName = name
          }
        }
        if (bestShadowPnl > -Infinity) {
          const divergence = livePnl - bestShadowPnl
          const maxDivergence = this.config?.risk?.maxLiveDryRunDivergence ?? 100
          if (divergence < -maxDivergence && (Date.now() - this.lastDivergenceAlertAt) > 3_600_000) {
            this.lastDivergenceAlertAt = Date.now()
            sendAlert('warning', 'Live/shadow P&L divergence', {
              livePnl: livePnl.toFixed(2),
              bestShadow: bestShadowName,
              bestShadowPnl: bestShadowPnl.toFixed(2),
              divergence: divergence.toFixed(2),
              threshold: maxDivergence
            })
          }
        }
      }
    }

    // Log the evaluation cycle
    const logMsg = totalSignals > 0
      ? `${totalSignals} signal(s) from ${enabledStrategies.length} strategy(ies)`
      : pricesAvailable === 0
        ? `Waiting for price data (${tickersTracking.length} tickers subscribed)`
        : `${pricesAvailable} prices, no signals (need ${enabledStrategies[0]?.params?.lookbackPeriod || 5}+ history)`

    this.log('eval', logMsg,
      {
        strategiesEvaluated: enabledStrategies.map(s => s.name),
        tickersTracking: tickersTracking.slice(0, 5),
        tickersWithHistory: historyStats.slice(0, 5),
        pricesAvailable,
        positionsHeld: this.state.positions?.length || 0,
        balance: this.state.balance?.available,
        results: evaluationResults
      }
    )

    // Server console log for easier monitoring
    this.evalCount++
    if (totalSignals > 0) {
      console.log(`[${ts()}] Eval: ${pricesAvailable} prices, ${historyStats.filter(h => h.count >= 5).length} ready, ${totalSignals} signals`)
    }

    // Periodic position reconciliation + balance sync in live mode (every ~60s)
    if (this.evalCount % 12 === 0 && !this.config.dryRun && this.liveExecution?.reconcilePositions) {
      this.liveExecution.reconcilePositions(this.state.positions).then(async result => {
        let stateChanged = false

        if (result?.discrepancies?.length) {
          // Auto-clean engine_only positions (settled on Kalshi, stale in engine)
          const settled = result.discrepancies.filter(d => d.type === 'engine_only')
          for (const d of settled) {
            const idx = this.state.positions.findIndex(p => p.ticker === d.ticker && p.side === d.side)
            if (idx >= 0) {
              const pos = this.state.positions[idx]
              const costBasis = ((pos.contracts || 0) * (pos.avgCost || 0)) / 100

              // Determine actual outcome instead of assuming loss
              const reconBtcSpot = this.compositePrices.get('BTC-USD')?.price
                || this.coinbasePrices.get('BTC-USD')
                        const outcome = reconBtcSpot ? this.determineBracketOutcome(d.ticker, reconBtcSpot) : null
              const won = outcome !== null ? (pos.side === outcome) : false
              const proceeds = won ? pos.contracts : 0
              const pnl = proceeds - costBasis

              if (outcome === null) {
                console.log(`[${ts()}] Settlement (unknown outcome): ${pos.contracts}x ${pos.side} ${pos.ticker} -- assuming loss $${costBasis.toFixed(2)}`)
              } else {
                console.log(`[${ts()}] Settlement ${won ? 'WIN' : 'LOSS'}: ${pos.contracts}x ${pos.side} ${pos.ticker} -- P&L $${pnl.toFixed(2)} (BTC $${reconBtcSpot.toLocaleString()})`)
              }

              // Record settlement as a trade
              const reconTrade = {
                id: `settlement-${Date.now()}-${d.ticker}`,
                ticker: d.ticker,
                side: pos.side,
                action: 'settlement',
                count: pos.contracts,
                price: won ? 100 : 0,
                cost: costBasis,
                fee: 0,
                costBasis,
                proceeds,
                pnl,
                strategy: pos.metadata?.strategy || 'unknown',
                timestamp: new Date().toISOString()
              }
              this.state.trades.push(reconTrade)
              analyzeTrade({ trade: reconTrade, resolutionType: 'reconciliation', btcSpot: reconBtcSpot, winningSide: outcome === null ? undefined : (won ? pos.side : (pos.side === 'yes' ? 'no' : 'yes')), trades: this.state?.trades }).catch(() => {})

              // Update stats
              this.state.todayStats.trades = (this.state.todayStats.trades || 0) + 1
              this.state.todayStats.pnl = (this.state.todayStats.pnl || 0) + pnl

              // Credit proceeds to available balance (if won)
              this.state.balance.available += proceeds

              // Update daily P&L circuit breaker
              if (this.liveExecution?.addToDailyPnl) {
                this.liveExecution.addToDailyPnl(pnl)
              }

              this.state.positions.splice(idx, 1)
              stateChanged = true
            }
          }

          // Auto-adopt api_only positions (filled orders the engine lost track of)
          // This prevents the re-ordering loop: fill timeout -> cancel 404 -> engine forgets -> re-orders
          const apiOnly = result.discrepancies.filter(d => d.type === 'api_only' && d.api > 0)
          const maxAdoptContracts = this.config?.risk?.maxPositionContracts || 200
          for (const d of apiOnly) {
            if (d.api > maxAdoptContracts) {
              console.log(`[${ts()}] SKIP adoption: ${d.api}x ${d.side} ${d.ticker} exceeds max ${maxAdoptContracts} contracts — likely from previous engine bug`)
              sendAlert('error', 'Oversized position skipped', { ticker: d.ticker, side: d.side, contracts: d.api, max: maxAdoptContracts })
              continue
            }
            // Estimate avg cost from exposure if available, otherwise use 50c as fallback
            const estimatedAvgCost = d.market_exposure && d.api ? Math.round(d.market_exposure / d.api) : 50
            this.state.positions.push({
              ticker: d.ticker,
              side: d.side,
              contracts: d.api,
              avgCost: estimatedAvgCost,
              metadata: { strategy: 'reconciled', adoptedAt: new Date().toISOString() }
            })
            // Set cooldown to prevent immediate re-ordering
            this.tradeCooldowns.set(d.ticker, Date.now() + 300_000)
            console.log(`[${ts()}] Adopted api_only position: ${d.api}x ${d.side} ${d.ticker} @ ~${estimatedAvgCost}c`)
            sendAlert('warning', 'Position adopted from API', { ticker: d.ticker, side: d.side, contracts: d.api, estimatedAvgCost })
            stateChanged = true
          }

          if (stateChanged) {
            this.state.balance.inPositions = Math.max(0, this.state.positions.reduce(
              (s, p) => s + ((p.contracts || 0) * (p.avgCost || 0)) / 100, 0
            ))
          }
        }

        // Sync engine balance with Kalshi's real balance
        if (this.liveExecution?.getAccountBalance) {
          const realAvailable = await this.liveExecution.getAccountBalance()
          if (realAvailable != null && Math.abs(realAvailable - this.state.balance.available) > 0.01) {
            console.log(`[${ts()}] Balance sync: engine $${this.state.balance.available.toFixed(2)} -> Kalshi $${realAvailable.toFixed(2)}`)
            this.state.balance.available = realAvailable
            stateChanged = true
          }
        }

        if (stateChanged && this.saveState) this.saveState(this.state)
      }).catch(err =>
        console.log(`[${ts()}] Reconciliation error: ${err.message}`)
      )
    }

    // Periodic diagnostic summary (every ~60s)
    if (this.evalCount % 12 === 0) {
      const diagSummary = []
      for (const result of evaluationResults) {
        const diags = result.diagnostics || []
        if (diags.length === 0) {
          diagSummary.push(`  ${result.strategy}: no markets evaluated`)
          continue
        }
        const statuses = {}
        let nearestTTL = Infinity
        let nearestTicker = ''
        for (const d of diags) {
          const key = d.status || d.window || 'unknown'
          statuses[key] = (statuses[key] || 0) + 1
          if (d.ttl < nearestTTL) { nearestTTL = d.ttl; nearestTicker = d.ticker }
        }
        const statusStr = Object.entries(statuses).map(([k, v]) => `${k}:${v}`).join(', ')
        diagSummary.push(`  ${result.strategy}: ${diags.length} markets [${statusStr}] nearest=${nearestTicker} ${nearestTTL}s`)
      }
      // Count markets skipped before reaching strategies (no strike, no coinbase ticker, etc)
      const marketsWithInfo = Array.from(this.currentPrices.values()).filter(p => p.title)
      const marketsWithStrike = marketsWithInfo.filter(p => {
        const title = p.title || ''
        const ticker = p.ticker || ''
        return title.match(/\$([0-9,]+)/) || ticker.split('-').pop()?.match(/^[BT]\d/)
      })
      console.log(`[${ts()}] Diag: ${pricesAvailable} prices, ${marketsWithInfo.length} w/title, ${marketsWithStrike.length} w/strike`)
      for (const line of diagSummary) console.log(`[${ts()}] ${line}`)

      // Bracket analytics summary
      for (const [, group] of bracketAnalytics.groups) {
        if (group.bracketSum.pricedCount > 0) {
          const ivStr = group.impliedVol?.reliable
            ? `IV=${(group.impliedVol.sigma * 100).toFixed(0)}% (RMSE ${(group.impliedVol.rmse * 100).toFixed(1)}%)`
            : `IV=N/A (${group.impliedVol?.bracketCount || 0} priced)`
          const skewStr = group.skewParams?.reliable
            ? `, skew=${group.skewParams.skew.toFixed(2)} base=${(group.skewParams.baseVol * 100).toFixed(0)}% (RMSE ${(group.skewParams.rmse * 100).toFixed(1)}%)`
            : ''
          const sumFlag = group.bracketSum.overpriced ? ' OVER' : group.bracketSum.underpriced ? ' UNDER' : ''
          console.log(`[${ts()}]   brackets ${group.closeTime.slice(11, 16)}: sum=${group.bracketSum.mid.toFixed(0)}c/${group.bracketSum.pricedCount} priced${sumFlag}, ${ivStr}${skewStr}`)
        }
      }
    }
  }

  /**
   * Execute a trading signal
   * @param {import('../strategies/base-strategy.js').Signal} signal
   * @param {string} strategyName
   * @returns {{ success: boolean }}
   */
  async executeSignal(signal, strategyName) {
    // Validate signal has required fields and valid values
    if (!signal.count || !Number.isFinite(signal.count) || signal.count <= 0) {
      console.log(`[${ts()}] Skipping signal with invalid count: ${signal.count}`)
      return { success: false }
    }

    console.log(`[${ts()}] Signal: ${signal.action.toUpperCase()} ${signal.count}x ${signal.side.toUpperCase()} ${signal.ticker}`)
    console.log(`[${ts()}]    |- Reason: ${signal.reason}`)
    console.log(`[${ts()}]    |- Confidence: ${(signal.confidence * 100).toFixed(0)}%`)

    this.log('signal', `${signal.action.toUpperCase()} ${signal.count}x ${signal.side.toUpperCase()} ${signal.ticker}`, {
      ticker: signal.ticker,
      action: signal.action,
      side: signal.side,
      count: signal.count,
      reason: signal.reason,
      confidence: signal.confidence,
      strategy: strategyName
    })

    // Live execution path — place real orders via Kalshi API
    // Do NOT mutate positions/balance here — wait for fill callback via applyFill()
    if (!this.config.dryRun && this.liveExecution) {
      // Pre-trade dollar cap: the lower of configured cap or available balance
      if (signal.action === 'buy') {
        const estCost = (signal.count * (signal.price || 50)) / 100
        const available = this.state.balance.available
        const configCap = this.config?.risk?.maxTradeDollars
        const effectiveCap = configCap ? Math.min(configCap, available) : available
        if (estCost > effectiveCap) {
          const msg = `Live pre-trade cap: est $${estCost.toFixed(2)} > $${effectiveCap.toFixed(2)} limit (available: $${available.toFixed(2)})`
          console.log(`[${ts()}] ${msg}`)
          this.log('error', msg, { estCost, effectiveCap, available })
          return { success: false }
        }
      }

      const bookMetrics = this.kalshiBookMetrics.get(signal.ticker)
      const result = await this.liveExecution.executeOrder(signal, strategyName, bookMetrics, this.state.positions)
      if (result.error) {
        this.log('error', `Live order failed: ${result.error}`, { ticker: signal.ticker })
        return { success: false }
      }
      // Reserve this ticker so other strategies can't conflict before fill arrives
      this.pendingReservations.set(signal.ticker, {
        ticker: signal.ticker,
        side: signal.side,
        action: signal.action,
        strategy: strategyName,
        close_time: this.marketInfo.get(signal.ticker)?.close_time,
        placedAt: Date.now()
      })
      console.log(`[${ts()}] Live order placed for ${signal.ticker}, awaiting fill confirmation (reservation added)`)
      return { success: true }
    }

    // Dry-run: simulate order fill immediately
    const fillPrice = signal.price || this.getMarketPrice(signal.ticker, signal.side, signal.action)

    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      console.log(`[${ts()}] Skipping signal with invalid fill price: ${fillPrice}`)
      return { success: false }
    }

    const fillCost = (signal.count * fillPrice) / 100 // Convert cents to dollars
    if (!Number.isFinite(fillCost)) {
      console.log(`[${ts()}] Skipping signal with invalid fill cost: ${fillCost}`)
      return { success: false }
    }

    // Variables for trade record (populated by sell logic)
    let tradePnl = null
    let tradeProceeds = null
    let tradeCostBasis = null
    let tradeFee = null
    let exitEdgeData = null

    // Calculate taker fee (most orders are market/taker in fast markets)
    const fee = calculateKalshiFee(signal.count, fillPrice, 'taker')

    if (signal.action === 'buy') {
      // Total cost includes fill cost + fee
      const totalCost = fillCost + fee

      // Engine-level per-trade dollar cap: the lower of configured cap or available balance
      const available = this.state.balance.available
      const configCap = this.config?.risk?.maxTradeDollars
      const effectiveCap = configCap ? Math.min(configCap, available) : available
      if (totalCost > effectiveCap) {
        const msg = `Per-trade cap: $${totalCost.toFixed(2)} > $${effectiveCap.toFixed(2)} limit (available: $${available.toFixed(2)})`
        console.log(`[${ts()}] ${msg}`)
        this.log('error', msg, { totalCost, effectiveCap, available })
        return { success: false }
      }

      // Check balance
      if (this.state.balance.available < totalCost) {
        const msg = `Insufficient balance: need $${totalCost.toFixed(2)} (cost $${fillCost.toFixed(2)} + fee $${fee.toFixed(2)}), have $${this.state.balance.available.toFixed(2)}`
        console.log(`[${ts()}] ${msg}`)
        this.log('error', msg, { needed: totalCost, available: this.state.balance.available })
        return { success: false }
      }

      // Deduct from balance (cost + fee)
      this.state.balance.available -= totalCost
      this.state.balance.inPositions += fillCost

      // Track fees
      tradeFee = fee
      if (!this.state.todayStats.fees) this.state.todayStats.fees = 0
      this.state.todayStats.fees += fee

      // Add or update position
      const existingPos = this.state.positions.find(p =>
        p.ticker === signal.ticker && p.side === signal.side
      )

      if (existingPos) {
        // Average into position (track total fees paid)
        const totalCostBasis = existingPos.avgCost * existingPos.contracts + fillPrice * signal.count
        const totalFeesBasis = (existingPos.feesPaid || 0) + fee
        existingPos.contracts += signal.count
        existingPos.avgCost = totalCostBasis / existingPos.contracts
        existingPos.feesPaid = totalFeesBasis
        // Track all contributing strategies
        const strategies = existingPos.metadata?.strategies || [existingPos.metadata?.strategy].filter(Boolean)
        if (!strategies.includes(strategyName)) strategies.push(strategyName)
        existingPos.metadata = { ...existingPos.metadata, strategy: strategies[0], strategies }
      } else {
        const signalMeta = signal.metadata || {}
        this.state.positions.push({
          ticker: signal.ticker,
          side: signal.side,
          contracts: signal.count,
          avgCost: fillPrice,
          feesPaid: fee,
          metadata: {
            strategy: strategyName,
            entryEdge: signalMeta.edge ?? null,
            entrySigma: signalMeta.sigma ?? null,
            entryFairProb: signalMeta.fairProb ?? null,
            entryMarketProb: signalMeta.marketProb ?? null,
            entryBtcSpot: this.evalBtcSpot ?? null,
            entryTTL: signalMeta.ttl ?? null,
            entryTs: Date.now()
          }
        })
      }

      console.log(`[${ts()}] Filled: ${signal.count}x ${signal.side.toUpperCase()} @ ${fillPrice}c ($${fillCost.toFixed(2)} + $${fee.toFixed(2)} fee)`)
      this.log('trade', `Bought ${signal.count}x ${signal.side.toUpperCase()} @ ${fillPrice}c ($${fillCost.toFixed(2)} + $${fee.toFixed(2)} fee)`, {
        ticker: signal.ticker,
        action: 'buy',
        side: signal.side,
        count: signal.count,
        price: fillPrice,
        cost: fillCost,
        fee: fee,
        strategy: strategyName
      })

    } else if (signal.action === 'sell') {
      const position = this.state.positions.find(p =>
        p.ticker === signal.ticker && p.side === signal.side
      )

      if (!position) {
        console.log(`[${ts()}] No position to sell`)
        this.log('error', `No position to sell for ${signal.ticker} ${signal.side}`, { ticker: signal.ticker, side: signal.side })
        return { success: false }
      }

      // Compute exit-time edge before position is modified
      const mInfo = this.marketInfo.get(signal.ticker)
      const strike = mInfo ? parseStrikePrice(mInfo.title, signal.ticker) : null
      const { bracketWidth } = getBracketInfo(signal.ticker)
      if (strike && this.evalBtcSpot) {
        const priceHistory = this.compositePriceHistory?.get('BTC-USD') || this.coinbasePriceHistory?.get('BTC-USD')
        const sigmaResult = getSigma({ priceHistory })
        const secsLeft = mInfo?.close_time ? Math.max(0, (new Date(mInfo.close_time).getTime() - Date.now()) / 1000) : 0
        if (sigmaResult?.sigma && secsLeft > 0) {
          const exitFairProb = calculateFairProbability(this.evalBtcSpot, strike, secsLeft, sigmaResult.sigma, bracketWidth)
          const pd = this.currentPrices.get(signal.ticker)
          const exitMarketProb = pd ? (pd.yesBid + pd.yesAsk) / 200 : null
          exitEdgeData = {
            exitFairProb: Math.round(exitFairProb * 10000) / 10000,
            exitMarketProb: exitMarketProb != null ? Math.round(exitMarketProb * 10000) / 10000 : null,
            exitEdge: exitMarketProb != null ? Math.round((exitFairProb - exitMarketProb) * 10000) / 10000 : null,
            holdDuration: position.metadata?.entryTs ? Math.round((Date.now() - position.metadata.entryTs) / 1000) : null
          }
        }
      }

      const sellCount = Math.min(signal.count, position.contracts)

      // Calculate exit fee
      const exitFee = calculateKalshiFee(sellCount, fillPrice, 'taker')

      // Calculate proportional entry fees for this portion of the position
      const entryFeeProportion = position.feesPaid ? (sellCount / position.contracts) * position.feesPaid : 0

      tradeProceeds = (sellCount * fillPrice) / 100
      tradeCostBasis = (sellCount * position.avgCost) / 100
      tradeFee = exitFee

      // P&L = proceeds - cost basis - exit fee (entry fee already paid)
      // Gross P&L (before fees)
      const grossPnl = tradeProceeds - tradeCostBasis
      // Net P&L (after exit fee)
      tradePnl = grossPnl - exitFee

      // Update balance (receive proceeds minus exit fee)
      this.state.balance.available += (tradeProceeds - exitFee)
      this.state.balance.inPositions -= tradeCostBasis

      // Track exit fee
      if (!this.state.todayStats.fees) this.state.todayStats.fees = 0
      this.state.todayStats.fees += exitFee

      // Update stats
      this.state.todayStats.trades++
      this.state.todayStats.pnl += tradePnl
      if (tradePnl > 0) this.state.todayStats.wins++

      // Update position
      position.contracts -= sellCount
      if (position.contracts <= 0) {
        this.state.positions = this.state.positions.filter(p => p !== position)
      } else {
        // Reduce tracked fees proportionally
        position.feesPaid = (position.feesPaid || 0) - entryFeeProportion
      }

      console.log(`[${ts()}] Sold: ${sellCount}x ${signal.side.toUpperCase()} @ ${fillPrice}c | Gross: $${grossPnl.toFixed(2)}, Fee: $${exitFee.toFixed(2)}, Net P&L: $${tradePnl.toFixed(2)}`)
      this.log('trade', `Sold ${sellCount}x ${signal.side.toUpperCase()} @ ${fillPrice}c | Net P&L: $${tradePnl.toFixed(2)} (fee: $${exitFee.toFixed(2)})`, {
        ticker: signal.ticker,
        action: 'sell',
        side: signal.side,
        count: sellCount,
        price: fillPrice,
        proceeds: tradeProceeds,
        grossPnl,
        exitFee,
        pnl: tradePnl,
        strategy: strategyName
      })
    }

    // Record trade with full details
    const trade = {
      id: `sim-${Date.now()}`,
      ticker: signal.ticker,
      side: signal.side,
      action: signal.action,
      count: signal.count,
      price: fillPrice,
      cost: signal.action === 'buy' ? fillCost : undefined,
      fee: tradeFee,
      costBasis: tradeCostBasis,
      proceeds: tradeProceeds,
      pnl: tradePnl,
      strategy: strategyName,
      reason: signal.reason,
      timestamp: new Date().toISOString()
    }

    if (!this.state.trades) this.state.trades = []
    this.state.trades.push(trade)

    // Journal: record entry or exit
    const enrichedSignal = { ...signal, metadata: { ...signal.metadata, btcSpot: this.evalBtcSpot, ...exitEdgeData } }
    if (signal.action === 'buy') {
      writeEntry(trade, enrichedSignal)
    } else if (signal.action === 'sell') {
      writeExit(trade, enrichedSignal, { avgCost: tradeCostBasis ? (tradeCostBasis / trade.count) * 100 : null })
      analyzeTrade({ trade, resolutionType: 'exit', btcSpot: this.evalBtcSpot, trades: this.state?.trades }).catch(() => {})
    }

    // Emit trade event
    if (this.onTrade) this.onTrade(trade)

    // Save state
    if (this.saveState) await this.saveState(this.state)
    return { success: true }
  }

  /**
   * Apply a confirmed fill from the live execution service
   * Called by the fill callback when broker confirms an order was filled.
   * This is the ONLY path that mutates positions/balance in live mode.
   * @param {{ ticker: string, side: string, action: string, count: number, price: number, strategyName: string }} fill
   */
  async applyFill(fill) {
    // Clear pending reservation now that fill has arrived
    this.pendingReservations.delete(fill.ticker)

    const fillPrice = fill.price
    const fillCount = fill.count
    const strategyName = fill.strategyName

    if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(fillCount) || fillCount <= 0) {
      console.log(`[${ts()}] Invalid fill data: price=${fillPrice}, count=${fillCount}`)
      return
    }

    const fillCost = (fillCount * fillPrice) / 100
    const fee = calculateKalshiFee(fillCount, fillPrice, 'taker')

    let tradePnl = null
    let tradeProceeds = null
    let tradeCostBasis = null

    if (fill.action === 'buy') {
      const totalCost = fillCost + fee

      if (this.state.balance.available < totalCost) {
        console.log(`[${ts()}] Fill BLOCKED: insufficient balance -- need $${totalCost.toFixed(2)}, have $${this.state.balance.available.toFixed(2)} (${fill.ticker})`)
        return
      }

      // Deduct from balance
      this.state.balance.available -= totalCost
      this.state.balance.inPositions += fillCost

      if (!this.state.todayStats.fees) this.state.todayStats.fees = 0
      this.state.todayStats.fees += fee

      // Add or update position
      const existingPos = this.state.positions.find(p =>
        p.ticker === fill.ticker && p.side === fill.side
      )

      if (existingPos) {
        const totalCostBasis = existingPos.avgCost * existingPos.contracts + fillPrice * fillCount
        const totalFeesBasis = (existingPos.feesPaid || 0) + fee
        existingPos.contracts += fillCount
        existingPos.avgCost = totalCostBasis / existingPos.contracts
        existingPos.feesPaid = totalFeesBasis
      } else {
        this.state.positions.push({
          ticker: fill.ticker,
          side: fill.side,
          contracts: fillCount,
          avgCost: fillPrice,
          feesPaid: fee,
          metadata: {
            strategy: strategyName,
            entryEdge: fill.metadata?.edge ?? null,
            entrySigma: fill.metadata?.sigma ?? null,
            entryFairProb: fill.metadata?.fairProb ?? null,
            entryMarketProb: fill.metadata?.marketProb ?? null,
            entryBtcSpot: this.evalBtcSpot ?? null,
            entryTTL: fill.metadata?.ttl ?? null,
            entryTs: Date.now()
          }
        })
      }

      console.log(`[${ts()}] Fill applied: BUY ${fillCount}x ${fill.side.toUpperCase()} ${fill.ticker} @ ${fillPrice}c ($${fillCost.toFixed(2)} + $${fee.toFixed(2)} fee)`)

    } else if (fill.action === 'sell') {
      const position = this.state.positions.find(p =>
        p.ticker === fill.ticker && p.side === fill.side
      )

      if (!position) {
        console.log(`[${ts()}] Fill received for unknown position: ${fill.ticker} ${fill.side}`)
        return
      }

      // Compute exit-time edge before position is modified
      let fillExitEdgeData = null
      const mInfo = this.marketInfo.get(fill.ticker)
      const strike = mInfo ? parseStrikePrice(mInfo.title, fill.ticker) : null
      const { bracketWidth } = getBracketInfo(fill.ticker)
      if (strike && this.evalBtcSpot) {
        const priceHistory = this.compositePriceHistory?.get('BTC-USD') || this.coinbasePriceHistory?.get('BTC-USD')
        const sigmaResult = getSigma({ priceHistory })
        const secsLeft = mInfo?.close_time ? Math.max(0, (new Date(mInfo.close_time).getTime() - Date.now()) / 1000) : 0
        if (sigmaResult?.sigma && secsLeft > 0) {
          const exitFairProb = calculateFairProbability(this.evalBtcSpot, strike, secsLeft, sigmaResult.sigma, bracketWidth)
          const pd = this.currentPrices.get(fill.ticker)
          const exitMarketProb = pd ? (pd.yesBid + pd.yesAsk) / 200 : null
          fillExitEdgeData = {
            exitFairProb: Math.round(exitFairProb * 10000) / 10000,
            exitMarketProb: exitMarketProb != null ? Math.round(exitMarketProb * 10000) / 10000 : null,
            exitEdge: exitMarketProb != null ? Math.round((exitFairProb - exitMarketProb) * 10000) / 10000 : null,
            holdDuration: position.metadata?.entryTs ? Math.round((Date.now() - position.metadata.entryTs) / 1000) : null
          }
        }
      }

      const sellCount = Math.min(fillCount, position.contracts)
      const exitFee = fee
      const entryFeeProportion = position.feesPaid ? (sellCount / position.contracts) * position.feesPaid : 0

      tradeProceeds = (sellCount * fillPrice) / 100
      tradeCostBasis = (sellCount * position.avgCost) / 100
      const grossPnl = tradeProceeds - tradeCostBasis
      tradePnl = grossPnl - exitFee

      this.state.balance.available += (tradeProceeds - exitFee)
      this.state.balance.inPositions -= tradeCostBasis

      if (!this.state.todayStats.fees) this.state.todayStats.fees = 0
      this.state.todayStats.fees += exitFee

      this.state.todayStats.trades++
      this.state.todayStats.pnl += tradePnl
      if (tradePnl > 0) this.state.todayStats.wins++

      position.contracts -= sellCount
      if (position.contracts <= 0) {
        this.state.positions = this.state.positions.filter(p => p !== position)
      } else {
        position.feesPaid = (position.feesPaid || 0) - entryFeeProportion
      }

      // Push realized PnL to live execution circuit breaker
      if (this.liveExecution?.addToDailyPnl) {
        this.liveExecution.addToDailyPnl(tradePnl)
      }

      console.log(`[${ts()}] Fill applied: SELL ${sellCount}x ${fill.side.toUpperCase()} ${fill.ticker} @ ${fillPrice}c | Net P&L: $${tradePnl.toFixed(2)}`)
    }

    // Record trade
    const trade = {
      id: `live-${Date.now()}`,
      ticker: fill.ticker,
      side: fill.side,
      action: fill.action,
      count: fillCount,
      price: fillPrice,
      cost: fill.action === 'buy' ? fillCost : undefined,
      fee,
      costBasis: tradeCostBasis,
      proceeds: tradeProceeds,
      pnl: tradePnl,
      strategy: strategyName,
      timestamp: fill.timestamp || new Date().toISOString()
    }

    if (!this.state.trades) this.state.trades = []
    this.state.trades.push(trade)

    // Journal: record live fill
    const enrichedSignal = { metadata: { strategy: strategyName, btcSpot: this.evalBtcSpot, ...(fill.action === 'sell' ? fillExitEdgeData : null) } }
    if (fill.action === 'buy') {
      writeEntry(trade, enrichedSignal)
    } else if (fill.action === 'sell') {
      writeExit(trade, enrichedSignal, { avgCost: tradeCostBasis ? (tradeCostBasis / fillCount) * 100 : null })
      analyzeTrade({ trade, resolutionType: 'exit', btcSpot: this.evalBtcSpot, trades: this.state?.trades }).catch(() => {})
    }

    if (this.onTrade) this.onTrade(trade)
    if (this.saveState) await this.saveState(this.state)
  }

  /**
   * Execute a shadow signal (paper-trade for disabled strategies).
   * Mirrors the dry-run path but operates on shadowState only.
   * @param {import('../strategies/base-strategy.js').Signal} signal
   * @param {string} strategyName
   */
  executeShadowSignal(signal, strategyName) {
    if (!signal.count || !Number.isFinite(signal.count) || signal.count <= 0) return

    const fillPrice = signal.price || this.getMarketPrice(signal.ticker, signal.side, signal.action)
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return

    const fillCost = (signal.count * fillPrice) / 100
    const fee = calculateKalshiFee(signal.count, fillPrice, 'taker')

    if (signal.action === 'buy') {
      const totalCost = fillCost + fee
      if (this.shadowState.balance.available < totalCost) return

      this.shadowState.balance.available -= totalCost
      this.shadowState.balance.inPositions += fillCost

      this.shadowState.positions.push({
        ticker: signal.ticker,
        side: signal.side,
        contracts: signal.count,
        avgCost: fillPrice,
        feesPaid: fee,
        metadata: { strategy: strategyName }
      })

      const trade = {
        id: `shadow-${Date.now()}`,
        ticker: signal.ticker,
        side: signal.side,
        action: 'buy',
        count: signal.count,
        price: fillPrice,
        cost: fillCost,
        fee,
        strategy: strategyName,
        reason: signal.reason,
        timestamp: new Date().toISOString()
      }
      this.shadowState.trades.push(trade)

      const enrichedSignal = { ...signal, metadata: { ...signal.metadata, btcSpot: this.evalBtcSpot } }
      writeShadowEntry(trade, enrichedSignal)

      console.log(`[${ts()}] Shadow BUY: ${signal.count}x ${signal.side.toUpperCase()} ${signal.ticker} @ ${fillPrice}c (${strategyName})`)
    } else if (signal.action === 'sell') {
      const posIdx = this.shadowState.positions.findIndex(
        p => p.ticker === signal.ticker && p.metadata?.strategy === strategyName
      )
      if (posIdx === -1) return

      const position = this.shadowState.positions[posIdx]
      const contracts = Math.min(signal.count, position.contracts)
      const proceeds = (contracts * fillPrice) / 100
      const costBasis = (contracts * position.avgCost) / 100
      const exitFee = calculateKalshiFee(contracts, fillPrice, 'taker')
      const pnl = proceeds - costBasis - exitFee

      this.shadowState.balance.available += proceeds - exitFee
      this.shadowState.balance.inPositions = Math.max(0, this.shadowState.balance.inPositions - costBasis)

      this.shadowState.positions.splice(posIdx, 1)

      const stratName = position.metadata?.strategy || strategyName
      if (!this.shadowState.stats[stratName]) {
        this.shadowState.stats[stratName] = { trades: 0, wins: 0, pnl: 0, winRate: 0 }
      }
      const stats = this.shadowState.stats[stratName]
      stats.trades++
      if (pnl > 0) stats.wins++
      stats.pnl = Math.round((stats.pnl + pnl) * 100) / 100
      stats.winRate = stats.trades > 0 ? Math.round((stats.wins / stats.trades) * 1000) / 1000 : 0

      const trade = {
        id: `shadow-exit-${Date.now()}`,
        ticker: signal.ticker,
        side: signal.side,
        action: 'sell',
        count: contracts,
        price: fillPrice,
        proceeds,
        costBasis,
        pnl,
        fee: (position.feesPaid || 0) + exitFee,
        strategy: stratName,
        reason: signal.reason,
        timestamp: new Date().toISOString()
      }
      this.shadowState.trades.push(trade)

      const enrichedSignal = { ...signal, metadata: { ...signal.metadata, btcSpot: this.evalBtcSpot } }
      writeShadowExit(trade, enrichedSignal, position)

      console.log(`[${ts()}] Shadow SELL: ${contracts}x ${signal.side.toUpperCase()} ${signal.ticker} @ ${fillPrice}c P&L $${pnl.toFixed(2)} (${stratName})`)
    }
  }

  /**
   * Settle expired shadow positions using BTC spot price.
   * Mirrors settleExpiredPositions but for shadow state.
   * @param {number} btcSpot - Current BTC spot price
   */
  settleExpiredShadowPositions(btcSpot) {
    if (!this.shadowState.positions.length || !btcSpot) return

    const now = Date.now()
    const toSettle = []

    for (const position of this.shadowState.positions) {
      const info = this.marketInfo.get(position.ticker)
      if (!info?.close_time) continue
      const closeTime = new Date(info.close_time).getTime()
      if (now < closeTime) continue
      toSettle.push(position)
    }

    for (const position of toSettle) {
      const ticker = position.ticker

      let winningSide = this.determineBracketOutcome(ticker, btcSpot)
      if (winningSide === null) {
        winningSide = position.side === 'yes' ? 'no' : 'yes'
      }

      const won = position.side === winningSide
      const contracts = position.contracts
      const proceeds = won ? contracts : 0
      const costBasis = (contracts * position.avgCost) / 100
      const pnl = proceeds - costBasis

      // Update shadow balance
      this.shadowState.balance.available += proceeds
      this.shadowState.balance.inPositions = Math.max(0, this.shadowState.balance.inPositions - costBasis)

      // Remove from shadow positions
      this.shadowState.positions = this.shadowState.positions.filter(p => p !== position)

      // Update per-strategy stats
      const stratName = position.metadata?.strategy || 'unknown'
      if (!this.shadowState.stats[stratName]) {
        this.shadowState.stats[stratName] = { trades: 0, wins: 0, pnl: 0, winRate: 0 }
      }
      const stats = this.shadowState.stats[stratName]
      stats.trades++
      if (won) stats.wins++
      stats.pnl = Math.round((stats.pnl + pnl) * 100) / 100
      stats.winRate = stats.trades > 0 ? Math.round((stats.wins / stats.trades) * 1000) / 1000 : 0

      // Record trade
      const trade = {
        id: `shadow-settle-${Date.now()}`,
        ticker,
        side: position.side,
        action: 'settlement',
        count: contracts,
        price: won ? 100 : 0,
        costBasis,
        proceeds,
        pnl,
        strategy: stratName,
        timestamp: new Date().toISOString()
      }
      this.shadowState.trades.push(trade)
      writeShadowSettlement(trade, btcSpot, winningSide)

      console.log(`[${ts()}] Shadow SETTLE: ${ticker} ${contracts}x ${position.side.toUpperCase()} -- ${won ? 'WIN' : 'LOSS'} P&L $${pnl.toFixed(2)} (${stratName})`)
    }
  }

  /**
   * Generate window summaries for expired settlement windows.
   * Called before cleanup removes price data.
   * @param {Map<string, string[]>} expiredByWindow - close_time -> [ticker, ...]
   * @param {number | undefined} btcSpot - BTC spot price
   */
  generateWindowSummaries(expiredByWindow, btcSpot) {
    if (expiredByWindow.size === 0) return

    for (const [closeTime, tickers] of expiredByWindow) {
      // Skip if we already have a summary for this close_time
      if (this.windowSummaries.some(s => s.closeTime === closeTime)) continue

      const brackets = []
      let winningBracket = null
      let bestEdge = null
      let marketsWithPrices = 0

      for (const ticker of tickers) {
        const price = this.currentPrices.get(ticker)
        const segments = ticker.split('-')
        const bracketSeg = segments[segments.length - 1]

        let strike = null
        let won = null

        if (bracketSeg.startsWith('B')) {
          strike = parseInt(bracketSeg.slice(1))
          if (btcSpot != null) {
            const lowerBound = strike - 125
            const upperBound = strike + 125
            won = (btcSpot >= lowerBound && btcSpot < upperBound) ? 'yes' : 'no'
          }
        } else if (bracketSeg.startsWith('T')) {
          strike = parseFloat(bracketSeg.slice(1))
          if (btcSpot != null) {
            won = btcSpot >= strike ? 'yes' : 'no'
          }
        }

        const lastYes = price?.yesBid ?? null
        const lastNo = lastYes != null ? 100 - lastYes : null
        if (lastYes != null) marketsWithPrices++

        brackets.push({ ticker, strike, lastYes, lastNo, won })

        if (won === 'yes') {
          winningBracket = { ticker, strike, side: 'yes' }
        }

        // Check peak edge for this ticker
        const peak = this.peakEdges.get(ticker)
        if (peak && (!bestEdge || Math.abs(peak.edge) > Math.abs(bestEdge.edge))) {
          bestEdge = {
            ticker,
            strike: peak.strike,
            edge: peak.edge,
            fairProb: peak.fairProb,
            marketProb: peak.marketProb,
            strategy: peak.strategy,
            side: peak.side
          }
        }
      }

      // If no tracked bracket matched but we have btcSpot, compute the winner
      // This handles windows with few tracked tickers where BTC lands outside their ranges
      if (!winningBracket && btcSpot != null) {
        const winningStrike = Math.floor(btcSpot / 250) * 250 + 125
        // Derive ticker prefix from any bracket ticker in this window, or build from closeTime
        const sampleTicker = tickers[0]
        const prefix = sampleTicker ? sampleTicker.split('-').slice(0, -1).join('-') : null
        const syntheticTicker = prefix ? `${prefix}-B${winningStrike}` : `B${winningStrike}`
        winningBracket = { ticker: syntheticTicker, strike: winningStrike, side: 'yes' }
      }

      // Check if we had any trades in this window
      let ourAction = null
      const windowTrades = (this.state?.trades || []).filter(t => tickers.includes(t.ticker))
      if (windowTrades.length > 0) {
        const entry = windowTrades.find(t => t.action === 'buy') || windowTrades[0]
        const settlement = windowTrades.find(t => t.action === 'settlement')
        ourAction = {
          ticker: entry.ticker,
          side: entry.side,
          contracts: entry.count,
          pnl: settlement?.pnl ?? windowTrades.reduce((sum, t) => sum + (t.pnl || 0), 0),
          strategy: entry.strategy
        }
      }

      // Classify why we took no action when there was an edge
      let noActionReason = null
      if (!ourAction && bestEdge) {
        const rejects = this.windowRejects.get(closeTime) || []
        if (rejects.length > 0) {
          // Use the most recent reject reason (closest to settlement = most relevant)
          const latest = rejects[rejects.length - 1]
          noActionReason = latest.reason
        } else {
          // No reject recorded — the strategy saw an edge but never generated a signal
          // This typically means the edge appeared outside the entry window (scouting phase)
          // or edge was below the strategy's threshold
          const bestEdgeAbs = Math.abs(bestEdge.edge)
          const edgeThreshold = this.strategies.find(s => s.name === bestEdge.strategy)?.params?.edgeThreshold
          if (edgeThreshold && bestEdgeAbs < edgeThreshold) {
            noActionReason = 'edge below threshold'
          } else {
            noActionReason = 'no signal generated'
          }
        }
      }

      // Sigma calibration: compare predicted vs realized volatility
      let sigmaCalibration = null
      const compositeHistory = this.compositePriceHistory.get('BTC-USD') || this.coinbasePriceHistory.get('BTC-USD')
      if (compositeHistory?.length >= 2) {
        // Predicted sigma: what the model was using (without bracket analytics since they're computed per-eval)
        const predicted = getSigma({ priceHistory: compositeHistory, volatilityWindow: 300 })

        // Realized sigma: actual BTC movement in the last 300s (same window the model uses)
        const realized = calculateRollingVolatility(compositeHistory, 300)

        // Also compute realized price range for intuitive comparison
        const recentPrices = compositeHistory.filter(h => h.timestamp >= Date.now() - 300000)
        const priceRange = recentPrices.length >= 2
          ? { high: Math.max(...recentPrices.map(h => h.price)), low: Math.min(...recentPrices.map(h => h.price)) }
          : null

        sigmaCalibration = {
          predictedSigma: predicted.sigma,
          predictedSource: predicted.source,
          realizedSigma: realized?.sigma ?? null,
          ratio: realized?.sigma ? +(predicted.sigma / realized.sigma).toFixed(2) : null,
          priceRange: priceRange ? { high: priceRange.high, low: priceRange.low, pctRange: +((priceRange.high - priceRange.low) / priceRange.low * 100).toFixed(3) } : null
        }
      }

      const summary = {
        closeTime,
        btcSpot: btcSpot ?? null,
        brackets,
        winningBracket,
        bestEdge,
        ourAction,
        noActionReason,
        marketsEvaluated: tickers.length,
        marketsWithPrices,
        sigmaCalibration,
        settledAt: Date.now()
      }

      this.windowSummaries.push(summary)
      if (this.windowSummaries.length > 50) {
        this.windowSummaries = this.windowSummaries.slice(-50)
      }

      writeWindowSummary(summary)

      // Clean up window rejects for this settled window
      this.windowRejects.delete(closeTime)

      if (this.onWindowSummary) this.onWindowSummary(summary)

      const sigmaLog = sigmaCalibration ? ` | sigma: predicted=${(sigmaCalibration.predictedSigma * 100).toFixed(0)}%(${sigmaCalibration.predictedSource}) realized=${sigmaCalibration.realizedSigma ? (sigmaCalibration.realizedSigma * 100).toFixed(0) + '%' : '?'} ratio=${sigmaCalibration.ratio ?? '?'}` : ''
      console.log(`[${ts()}] Window summary: ${closeTime.slice(11, 16)} UTC | BTC $${btcSpot?.toLocaleString() || '?'} | winner: ${winningBracket?.ticker?.split('-').pop() || 'unknown'} | best edge: ${bestEdge ? `${(bestEdge.edge * 100).toFixed(1)}% (${bestEdge.strategy})` : 'none'} | action: ${ourAction ? `${ourAction.side} ${ourAction.contracts}x -> $${ourAction.pnl?.toFixed(2)}` : noActionReason ? `none (${noActionReason})` : 'none'} | ${marketsWithPrices}/${tickers.length} priced${sigmaLog}`)
    }
  }

  /**
   * Get recent window summaries
   * @returns {Array<Object>}
   */
  getWindowSummaries() {
    return this.windowSummaries
  }

  /**
   * Get current market price for a ticker
   * @param {string} ticker
   * @param {'yes' | 'no'} side
   * @param {'buy' | 'sell'} action
   * @returns {number}
   */
  getMarketPrice(ticker, side, action) {
    const price = this.currentPrices.get(ticker)
    if (!price) return 50 // Default

    // Get bid/ask with fallback to defaults (0 is not a valid price)
    const yesBid = price.yesBid || 50
    const yesAsk = price.yesAsk || 50

    let result
    if (side === 'yes') {
      result = action === 'buy' ? yesAsk : yesBid
    } else {
      result = action === 'buy' ? (100 - yesBid) : (100 - yesAsk)
    }
    // Clamp to valid Kalshi price range (1-99 cents), guard NaN
    if (!Number.isFinite(result)) return 50
    return Math.min(99, Math.max(1, result))
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      running: this.state?.engineRunning || false,
      mode: this.config?.dryRun ? 'dry_run' : 'live',
      liveExecution: !!this.liveExecution,
      strategiesEnabled: this.strategies.filter(s => s.enabled).map(s => s.name),
      shadowStrategies: this.shadowStrategies.map(s => s.name),
      shadowStats: this.shadowState?.stats || {},
      shadowPositions: this.shadowState?.positions?.length || 0,
      shadowBalance: this.shadowState?.balance || null,
      tickersTracking: Array.from(this.subscribedTickers),
      kalshiBookMetrics: this.kalshiBookMetrics.size,
      priceHistorySizes: Object.fromEntries(
        Array.from(this.priceHistory.entries()).map(([k, v]) => [k, v.length])
      )
    }
  }

  /**
   * Update strategy configuration
   * @param {string} name
   * @param {{ enabled: boolean, params: Object }} config
   */
  updateStrategy(name, config) {
    // Check both live and shadow strategy lists
    const liveStrategy = this.strategies.find(s => s.name === name)
    const shadowStrategy = this.shadowStrategies.find(s => s.name === name)
    const strategy = liveStrategy || shadowStrategy

    if (!strategy) return

    strategy.updateConfig(config)

    // Move between live and shadow based on enabled state
    if (config.enabled && shadowStrategy) {
      // Promote from shadow to live
      this.shadowStrategies = this.shadowStrategies.filter(s => s.name !== name)
      this.strategies.push(strategy)
      console.log(`[${ts()}] Strategy ${name} promoted: shadow -> live`)
    } else if (!config.enabled && liveStrategy) {
      // Demote from live to shadow
      this.strategies = this.strategies.filter(s => s.name !== name)
      this.shadowStrategies.push(strategy)
      console.log(`[${ts()}] Strategy ${name} demoted: live -> shadow`)
    } else {
      console.log(`[${ts()}] Strategy ${name} updated: enabled=${config.enabled}`)
    }
  }
}

// Singleton instance
const simulationEngine = new SimulationEngine()

module.exports = simulationEngine
module.exports.SimulationEngine = SimulationEngine
