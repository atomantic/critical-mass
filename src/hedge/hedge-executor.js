// @ts-check
/**
 * Hedge Executor
 *
 * Coordinated order placement for both legs of a hedge trade:
 * 1. BTC market buy on Coinbase
 * 2. Stop-limit sell on Coinbase (wide SL for catastrophe protection)
 * 3. Kalshi hedge order (buy NO on bracket)
 * 4. Exit handling: TP, settlement-aligned, SL filled
 */

const { log } = require('../logger')
const { createPair } = require('./hedge-state')

/** @type {string} Timestamp for logs */
const ts = () => `[HEDGE] ${new Date().toISOString().slice(11, 23)}`

/**
 * Create a hedge executor with injected dependencies
 * @param {Object} deps
 * @param {Object} deps.exchangeAdapter - Coinbase adapter instance
 * @param {Object} deps.kalshiApi - Kalshi API module { placeOrder }
 * @param {Object} deps.kalshiKeys - Kalshi API keys
 * @param {Object} deps.config - Hedge config
 * @returns {Object} Executor methods
 */
const createHedgeExecutor = ({ exchangeAdapter, kalshiApi, kalshiKeys, config }) => {

  /**
   * Execute a coordinated hedge entry: BTC buy + SL + Kalshi hedge
   * @param {Object} params
   * @param {number} params.btcAmount - BTC amount to buy
   * @param {string} params.productId - Exchange product ID
   * @param {number} params.btcPrice - Current BTC price
   * @param {number} params.stopLossPrice - Stop loss trigger price
   * @param {number} params.takeProfitPrice - Take profit price
   * @param {Object} params.hedgeCandidate - Best bracket from calculator
   * @param {boolean} params.dryRun - Whether in dry-run mode
   * @returns {Promise<{ success: boolean, pair?: Object, error?: string }>}
   */
  const executeEntry = async ({ btcAmount, productId, btcPrice, stopLossPrice, takeProfitPrice, hedgeCandidate, dryRun }) => {
    const quoteAmount = btcAmount * btcPrice

    log('INFO', `[${ts()}] 🔄 hedge entry starting: ${btcAmount} BTC @ ~$${btcPrice.toFixed(0)}, SL=$${stopLossPrice.toFixed(0)}, TP=$${takeProfitPrice.toFixed(0)}`)

    // --- Step 1: Market buy BTC ---
    let buyResult
    let actualEntryPrice = btcPrice
    let entryFee = 0

    if (dryRun) {
      buyResult = {
        orderId: `dry-buy-${Date.now()}`,
        clientOrderId: `dry-${Date.now()}`,
        success: true,
      }
      // Simulate taker fill with small slippage
      actualEntryPrice = btcPrice * 1.0001
      entryFee = quoteAmount * (config.fees.exchangeTakerBps / 10000)
      log('INFO', `[${ts()}] 📋 [dry-run] BTC buy simulated: ${btcAmount} @ $${actualEntryPrice.toFixed(2)}, fee=$${entryFee.toFixed(2)}`)
    } else {
      buyResult = await exchangeAdapter.placeMarketBuy(productId, quoteAmount)
      if (!buyResult.success) {
        log('ERROR', `[${ts()}] ❌ hedge BTC buy failed: ${buyResult.errorMessage}`)
        return { success: false, error: `BTC buy failed: ${buyResult.errorMessage}` }
      }

      // Get actual fill details
      const fillSummary = await exchangeAdapter.getOrderFillSummary(buyResult.orderId)
      actualEntryPrice = fillSummary.averagePrice || btcPrice
      entryFee = fillSummary.netFees || 0
      log('INFO', `[${ts()}] ✅ BTC bought: ${btcAmount} @ $${actualEntryPrice.toFixed(2)}, fee=$${entryFee.toFixed(2)}`)
    }

    // --- Step 2: Place stop-limit sell (catastrophe protection) ---
    let stopOrderId = null
    const slippageFactor = 1 - (config.stopLoss.slippageBps / 10000)
    const limitPrice = stopLossPrice * slippageFactor

    if (dryRun) {
      stopOrderId = `dry-sl-${Date.now()}`
      log('INFO', `[${ts()}] 📋 [dry-run] SL order simulated: stop=$${stopLossPrice.toFixed(2)}, limit=$${limitPrice.toFixed(2)}`)
    } else if (config.exitMode !== 'settlement_aligned') {
      const slResult = await exchangeAdapter.placeStopLimitSell(productId, btcAmount, stopLossPrice, limitPrice)
      if (slResult.success) {
        stopOrderId = slResult.orderId
        log('INFO', `[${ts()}] ✅ SL order placed: stop=$${slResult.stopPrice.toFixed(2)}, limit=$${slResult.limitPrice.toFixed(2)}`)
      } else {
        log('WARN', `[${ts()}] ⚠️ SL order failed: ${slResult.errorMessage} — proceeding without SL protection`)
      }
    }

    // --- Step 3: Place Kalshi hedge order ---
    let kalshiOrderId = null
    let kalshiFee = 0

    if (dryRun) {
      kalshiOrderId = `dry-kalshi-${Date.now()}`
      kalshiFee = hedgeCandidate.kalshiCost.kalshiFee
      log('INFO', `[${ts()}] 📋 [dry-run] Kalshi hedge simulated: ${hedgeCandidate.contractsNeeded} NO @ ${hedgeCandidate.premiumCents}¢ on ${hedgeCandidate.ticker}`)
    } else {
      const kalshiOrder = await kalshiApi.placeOrder(kalshiKeys, {
        ticker: hedgeCandidate.ticker,
        side: 'no',
        action: 'buy',
        count: hedgeCandidate.contractsNeeded,
        type: 'limit',
        no_price: hedgeCandidate.premiumCents,
      })

      if (kalshiOrder?.order_id) {
        kalshiOrderId = kalshiOrder.order_id
        log('INFO', `[${ts()}] ✅ Kalshi hedge placed: ${hedgeCandidate.contractsNeeded} NO @ ${hedgeCandidate.premiumCents}¢ on ${hedgeCandidate.ticker}`)
      } else {
        log('WARN', `[${ts()}] ⚠️ Kalshi hedge failed — proceeding unhedged with BTC position + SL`)
      }
    }

    // --- Step 4: Create pair record ---
    const pair = createPair({
      exitMode: config.exitMode,
      exchange: {
        buyOrderId: buyResult.orderId,
        stopOrderId,
        entryPrice: actualEntryPrice,
        btcAmount,
        stopPrice: stopLossPrice,
        tpPrice: takeProfitPrice,
        entryFee,
      },
      kalshi: {
        ticker: hedgeCandidate.ticker,
        series: hedgeCandidate.series,
        orderId: kalshiOrderId,
        contracts: hedgeCandidate.contractsNeeded,
        entryPriceCents: hedgeCandidate.premiumCents,
        fee: kalshiFee || hedgeCandidate.kalshiCost.kalshiFee,
        closeTime: hedgeCandidate.closeTime,
        bracketStrike: hedgeCandidate.strike,
        bracketWidth: hedgeCandidate.bracketWidth,
      },
    })

    log('INFO', `[${ts()}] ✅ hedge pair created: id=${pair.id}, mode=${config.exitMode}`)

    return { success: true, pair }
  }

  /**
   * Execute a market sell exit for the BTC leg
   * @param {Object} pair - Active pair
   * @param {string} reason - Exit reason
   * @param {boolean} dryRun
   * @returns {Promise<{ exitPrice: number, exitFee: number }>}
   */
  const executeExchangeExit = async (pair, reason, dryRun) => {
    log('INFO', `[${ts()}] 🔄 hedge exchange exit: ${reason}`)

    if (dryRun) {
      // Use current cached price as exit
      const exitPrice = pair.exchange.entryPrice * (reason.includes('tp') ? 1.005 : 0.99)
      const exitFee = pair.exchange.btcAmount * exitPrice * (config.fees.exchangeTakerBps / 10000)
      log('INFO', `[${ts()}] 📋 [dry-run] BTC sell simulated: ${pair.exchange.btcAmount} @ $${exitPrice.toFixed(2)}`)
      return { exitPrice, exitFee }
    }

    const sellResult = await exchangeAdapter.placeMarketSell(config.productId, pair.exchange.btcAmount)
    if (!sellResult.success) {
      log('ERROR', `[${ts()}] ❌ BTC market sell failed: ${sellResult.errorMessage}`)
      return { exitPrice: pair.exchange.entryPrice, exitFee: 0 }
    }

    const fillSummary = await exchangeAdapter.getOrderFillSummary(sellResult.orderId)
    const exitPrice = fillSummary.averagePrice || pair.exchange.entryPrice
    const exitFee = fillSummary.netFees || 0

    log('INFO', `[${ts()}] ✅ BTC sold: ${pair.exchange.btcAmount} @ $${exitPrice.toFixed(2)}, fee=$${exitFee.toFixed(2)}`)
    return { exitPrice, exitFee }
  }

  /**
   * Cancel the stop-limit order on the exchange
   * @param {Object} pair - Active pair
   * @param {boolean} dryRun
   * @returns {Promise<boolean>}
   */
  const cancelStopOrder = async (pair, dryRun) => {
    if (!pair.exchange.stopOrderId) return true

    if (dryRun) {
      log('INFO', `[${ts()}] 📋 [dry-run] SL cancel simulated: ${pair.exchange.stopOrderId}`)
      return true
    }

    const result = await exchangeAdapter.cancelOrder(pair.exchange.stopOrderId)
    if (result.success) {
      log('INFO', `[${ts()}] ✅ SL order cancelled: ${pair.exchange.stopOrderId}`)
    } else {
      log('WARN', `[${ts()}] ⚠️ SL cancel failed (may have already filled)`)
    }
    return result.success
  }

  return {
    executeEntry,
    executeExchangeExit,
    cancelStopOrder,
  }
}

module.exports = { createHedgeExecutor }
