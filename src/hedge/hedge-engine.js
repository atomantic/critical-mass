// @ts-check
/**
 * Hedge Engine
 *
 * Main loop: evaluate entry conditions, enter hedged positions,
 * monitor active pairs via price updates, handle all exit modes.
 *
 * Runs every 5 seconds when active.
 */

const { log } = require('../logger')
const { getHedgeConfig } = require('../config-utils')
const { calculateRollingVolatility } = require('../kalshi/services/volatility-service')
const { getCryptoMarkets } = require('../kalshi/adapters/markets')
const {
  selectBestBracket,
  evaluateProfitability,
  checkEntryConditions,
} = require('./hedge-calculator')
const {
  loadState,
  saveState,
  addActivePair,
  updateExcursions,
  closePair,
  recordSkip,
  getActivePair,
  setEngineRunning,
} = require('./hedge-state')
const { createHedgeExecutor } = require('./hedge-executor')

const { prefixedTs } = require('../time-utils')

const EVAL_INTERVAL_MS = 5000
const SAVE_INTERVAL_MS = 30000 // batch-save excursion updates

const ts = () => prefixedTs('HEDGE')

/**
 * Create and return a hedge engine instance
 * @param {Object} deps
 * @param {Object} deps.exchangeAdapter - Coinbase adapter
 * @param {Object} deps.kalshiApi - Kalshi API { placeOrder, getPositions }
 * @param {Object} deps.kalshiKeys - Kalshi API keys
 * @param {Function} deps.getPriceBridgePrice - () => number|null — live BTC price from price-bridge
 * @param {Function} deps.getPriceHistory - () => Array<{price,timestamp}> — recent price history
 * @param {Function} deps.canFillCheck - (ticker, side, action, count, slippage) => boolean
 * @param {Object} [deps.callbacks] - { onStateChange, onPairOpened, onPairClosed }
 * @returns {Object} Engine interface { start, stop, getState, getStatus, updatePrice }
 */
const createHedgeEngine = (deps) => {
  const {
    exchangeAdapter,
    kalshiApi,
    kalshiKeys,
    getPriceBridgePrice,
    getPriceHistory,
    canFillCheck,
    callbacks = {},
  } = deps

  let config = getHedgeConfig()
  let state = loadState()
  let evalTimer = null
  let saveTimer = null
  let running = false
  let lastBtcPrice = null
  let lastEvalTime = 0
  let noPriceLogCount = 0
  let marketsCache = null
  let marketsCacheTime = 0
  const MARKETS_CACHE_TTL = 60000 // refresh markets list every 60s

  const executor = createHedgeExecutor({
    exchangeAdapter,
    kalshiApi,
    kalshiKeys,
    config,
  })

  /**
   * Fetch markets from Kalshi for allowed series
   * @returns {Promise<Object[]>}
   */
  const fetchMarkets = async () => {
    const now = Date.now()
    if (marketsCache && now - marketsCacheTime < MARKETS_CACHE_TTL) {
      return marketsCache
    }

    const timeframes = []
    for (const series of config.kalshi.allowedSeries) {
      if (series.includes('15M')) timeframes.push('15min')
      else if (series.includes('KXBTCD')) timeframes.push('daily')
      else timeframes.push('hourly')
    }

    const markets = await getCryptoMarkets(kalshiKeys, {
      assets: ['BTC'],
      timeframes: [...new Set(timeframes)],
    })

    marketsCache = markets
    marketsCacheTime = now
    return markets
  }

  /**
   * Single evaluation cycle
   */
  const evaluate = async () => {
    config = getHedgeConfig()
    if (!config.enabled) return

    const btcPrice = getPriceBridgePrice()
    if (!btcPrice || btcPrice <= 0) {
      if (noPriceLogCount++ < 5) log('WARN', `[${ts()}] ⚠️ hedge eval skipped: no BTC price from bridge (attempt ${noPriceLogCount})`)
      return
    }
    noPriceLogCount = 0
    lastBtcPrice = btcPrice

    const activePair = getActivePair(state)

    // --- Monitor active pair ---
    if (activePair) {
      await monitorActivePair(activePair, btcPrice)
      return
    }

    // --- Evaluate new entry ---
    if (state.activePairs.length >= config.risk.maxOpenPairs) return

    // Check basic entry conditions
    const priceHistory = getPriceHistory()
    const volResult = calculateRollingVolatility(priceHistory, 900) // 15-min window
    const volatility15m = volResult?.sigma ?? null

    // Convert annualized sigma to 15-min realized vol for entry filter
    const vol15m = volatility15m
      ? volatility15m * Math.sqrt(900 / (365.25 * 24 * 3600))
      : null

    const entryCheck = checkEntryConditions({
      volatility15m: vol15m,
      lastEntryTime: state.lastEntryTime,
      consecutiveLosses: state.consecutiveLosses,
      dailyStats: state.dailyStats,
      config,
    })

    if (!entryCheck.canEnter) {
      recordSkip(state)
      if (state.dailyStats.skipped % 60 === 1) log('INFO', `[${ts()}] 📊 hedge skip: ${entryCheck.reason}`)
      return
    }

    // Fetch Kalshi markets and find best bracket
    let markets
    try {
      markets = await fetchMarkets()
    } catch (err) {
      log('WARN', `[${ts()}] ⚠️ hedge market fetch failed: ${err.message}`)
      return
    }

    if (!markets?.length) {
      recordSkip(state)
      return
    }

    const stopLossPrice = btcPrice * (1 - config.stopLoss.percentFromEntry / 100)
    const takeProfitPrice = btcPrice * (1 + config.takeProfit.percentFromEntry / 100)

    const sigma = volatility15m || 0.55

    const bestBracket = selectBestBracket(markets, {
      btcPrice,
      stopLossPrice,
      btcAmount: config.position.btcAmount,
      hedgeRatio: config.kalshi.hedgeRatio,
      maxPremiumCents: config.kalshi.maxPremiumCents,
      kalshiTakerCoeff: config.fees.kalshiTakerCoeff,
      sigma,
      canFillCheck,
      maxSlippageCents: config.kalshi.maxSlippageCents,
    })

    if (!bestBracket) {
      recordSkip(state)
      return
    }

    // Profitability check
    const profitEval = evaluateProfitability({
      btcPrice,
      btcAmount: config.position.btcAmount,
      hedgeCandidate: bestBracket,
      fees: config.fees,
      stopLossPct: config.stopLoss.percentFromEntry,
      takeProfitPct: config.takeProfit.percentFromEntry,
      sigma,
      minExpectedProfit: config.entry.minExpectedProfit,
    })

    if (!profitEval.profitable) {
      recordSkip(state)
      log('INFO', `[${ts()}] 📊 hedge skip: EV=$${profitEval.metrics.expectedPnl.toFixed(2)} < min $${config.entry.minExpectedProfit}, friction=$${profitEval.metrics.totalFriction.toFixed(2)}`)
      return
    }

    // --- Execute entry ---
    log('INFO', `[${ts()}] 🎯 hedge entry signal: EV=$${profitEval.metrics.expectedPnl.toFixed(2)}, coupling=${bestBracket.coupling.score.toFixed(2)}, bracket=${bestBracket.ticker}`)

    const entryResult = await executor.executeEntry({
      btcAmount: config.position.btcAmount,
      productId: config.productId,
      btcPrice,
      stopLossPrice,
      takeProfitPrice,
      hedgeCandidate: bestBracket,
      dryRun: config.dryRun,
    })

    if (entryResult.success && entryResult.pair) {
      addActivePair(state, entryResult.pair)
      callbacks.onPairOpened?.(entryResult.pair)
      callbacks.onStateChange?.(state)
      log('INFO', `[${ts()}] ✅ hedge pair opened: ${entryResult.pair.id}`)
    }
  }

  /**
   * Monitor an active pair and handle exits
   * @param {Object} pair - Active pair
   * @param {number} btcPrice - Current BTC price
   */
  const monitorActivePair = async (pair, btcPrice) => {
    // Update MAE/MFE
    updateExcursions(state, pair.id, btcPrice)

    const entryPrice = pair.exchange.entryPrice
    const pctFromEntry = ((btcPrice - entryPrice) / entryPrice) * 100

    // --- Check TP ---
    if (pair.exchange.tpPrice && btcPrice >= pair.exchange.tpPrice) {
      log('INFO', `[${ts()}] 🎉 hedge TP hit: price=$${btcPrice.toFixed(2)} >= TP=$${pair.exchange.tpPrice.toFixed(2)}`)

      // Cancel SL order
      await executor.cancelStopOrder(pair, config.dryRun)

      // Market sell
      const exitResult = await executor.executeExchangeExit(pair, 'tp_hit', config.dryRun)

      closePair(state, pair.id, {
        exitPrice: exitResult.exitPrice,
        exitFee: exitResult.exitFee,
        resultType: 'tp_win',
        kalshiSettledDown: null, // will be determined at settlement
        kalshiPayout: 0, // TP win means hedge likely expires worthless
      })

      callbacks.onPairClosed?.(pair)
      callbacks.onStateChange?.(state)
      return
    }

    // --- Check SL (for exchange_native mode, SL is on exchange) ---
    // For hybrid/settlement_aligned, SL is only catastrophe protection
    // We don't check it here — the exchange handles it

    // --- Check settlement approach ---
    if (pair.kalshi.closeTime) {
      const msToSettlement = new Date(pair.kalshi.closeTime).getTime() - Date.now()

      // Exit 10 seconds before settlement for settlement-aligned and hybrid modes
      if (msToSettlement <= 10000 && config.exitMode !== 'exchange_native') {
        log('INFO', `[${ts()}] ⏰ hedge settlement exit: ${(msToSettlement / 1000).toFixed(0)}s to settlement`)

        // Cancel SL order
        await executor.cancelStopOrder(pair, config.dryRun)

        // Market sell at settlement time
        const exitResult = await executor.executeExchangeExit(pair, 'settlement_aligned', config.dryRun)

        // Determine Kalshi outcome: will settle based on the settlement price
        // For now, mark as pending — actual outcome determined in handleKalshiSettlement
        closePair(state, pair.id, {
          exitPrice: exitResult.exitPrice,
          exitFee: exitResult.exitFee,
          resultType: 'settlement_exit',
          kalshiSettledDown: null,
          kalshiPayout: null,
        })

        callbacks.onPairClosed?.(pair)
        callbacks.onStateChange?.(state)
        return
      }
    }

    // --- Check if SL filled (for hybrid/exchange_native modes) ---
    if (pair.exchange.stopOrderId && !config.dryRun) {
      try {
        const slOrder = await exchangeAdapter.getOrder(pair.exchange.stopOrderId)
        if (slOrder.status === 'FILLED') {
          log('INFO', `[${ts()}] 🛑 hedge SL filled on exchange: ${pair.exchange.stopOrderId}`)

          const exitPrice = slOrder.averageFilledPrice || pair.exchange.stopPrice
          const exitFee = slOrder.totalFees || 0

          // Determine result type based on Kalshi outcome
          // For now, mark as SL hit — Kalshi outcome determined at settlement
          closePair(state, pair.id, {
            exitPrice,
            exitFee,
            resultType: 'sl_hedged', // optimistic — will be corrected if Kalshi doesn't pay
            kalshiSettledDown: null,
            kalshiPayout: null,
          })

          callbacks.onPairClosed?.(pair)
          callbacks.onStateChange?.(state)
          return
        }
      } catch {
        // Order check failed — non-critical, will retry next cycle
      }
    }
  }

  /**
   * Handle Kalshi settlement outcome for a recently closed pair
   * Called externally when settlement data becomes available
   * @param {string} pairId - Pair ID
   * @param {boolean} settledDown - Whether Kalshi settled "down" (NO wins)
   * @param {number} btcPriceAtSettlement - BTC price at settlement time
   */
  const handleKalshiSettlement = (pairId, settledDown, btcPriceAtSettlement) => {
    const pair = state.closedPairs.find(p => p.id === pairId)
    if (!pair) return

    pair.kalshi.settledDown = settledDown
    const payout = settledDown ? pair.kalshi.contracts : 0 // $1 per contract if NO wins
    pair.kalshi.payout = payout

    // Recalculate Kalshi P&L
    const kalshiCost = (pair.kalshi.contracts * pair.kalshi.entryPriceCents) / 100 + pair.kalshi.fee
    pair.pnl.kalshiPnl = payout - kalshiCost
    pair.pnl.netPnl = pair.pnl.exchangePnl + pair.pnl.kalshiPnl

    // Reclassify result type
    if (pair.resultType === 'sl_hedged' || pair.resultType === 'settlement_exit') {
      const slHit = pair.pnl.exchangePnl < 0
      if (slHit && !settledDown) {
        pair.resultType = 'double_loss'
        state.dailyStats.doubleLosses = (state.dailyStats.doubleLosses || 0) + 1
      } else if (slHit && settledDown) {
        pair.resultType = 'sl_hedged'
      }
    }

    saveState(state)
    callbacks.onStateChange?.(state)
    log('INFO', `[${ts()}] 📊 Kalshi settlement: pair=${pairId}, settled_down=${settledDown}, payout=$${payout}, net_pnl=$${pair.pnl.netPnl.toFixed(2)}`)
  }

  /**
   * Start the engine
   * @returns {{ success: boolean, error?: string }}
   */
  const start = () => {
    if (running) return { success: false, error: 'Engine already running' }

    config = getHedgeConfig()
    if (!config.enabled) return { success: false, error: 'Hedge engine is not enabled in config' }

    state = loadState()
    running = true
    setEngineRunning(state, true)

    evalTimer = setInterval(async () => {
      try {
        await evaluate()
      } catch (err) {
        log('ERROR', `[${ts()}] ❌ hedge eval error: ${err.message}`)
      }
    }, EVAL_INTERVAL_MS)

    saveTimer = setInterval(() => {
      saveState(state)
    }, SAVE_INTERVAL_MS)

    log('INFO', `[${ts()}] 🚀 hedge engine started: mode=${config.dryRun ? 'dry-run' : 'LIVE'}, exitMode=${config.exitMode}, btc=${config.position.btcAmount}`)
    return { success: true }
  }

  /**
   * Stop the engine
   */
  const stop = () => {
    if (evalTimer) {
      clearInterval(evalTimer)
      evalTimer = null
    }
    if (saveTimer) {
      clearInterval(saveTimer)
      saveTimer = null
    }
    running = false
    setEngineRunning(state, false)
    saveState(state)
    log('INFO', `[${ts()}] 🛑 hedge engine stopped`)
  }

  /**
   * Get engine status
   * @returns {Object}
   */
  const getStatus = () => ({
    running,
    dryRun: config.dryRun,
    exitMode: config.exitMode,
    lastBtcPrice,
    activePair: getActivePair(state),
    dailyStats: state.dailyStats,
    aggregateStats: state.aggregateStats,
    consecutiveLosses: state.consecutiveLosses,
    config: {
      btcAmount: config.position.btcAmount,
      maxPremiumCents: config.kalshi.maxPremiumCents,
      stopLossPct: config.stopLoss.percentFromEntry,
      takeProfitPct: config.takeProfit.percentFromEntry,
    },
  })

  /**
   * Get full state
   * @returns {Object}
   */
  const getState = () => state

  /**
   * Reload config from disk
   */
  const reloadConfig = () => {
    config = getHedgeConfig()
    log('INFO', `[${ts()}] 🔄 hedge config reloaded`)
  }

  return {
    start,
    stop,
    getStatus,
    getState,
    handleKalshiSettlement,
    reloadConfig,
  }
}

module.exports = { createHedgeEngine }
