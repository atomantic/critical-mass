/**
 * Live Execution Service
 * Handles real order placement, fill monitoring, daily loss circuit breaker,
 * and position reconciliation for live trading mode.
 */

const { placeOrder, cancelOrder, getPositions, getFills, getBalance } = require('../adapters/api')
const { canFill, availableContracts, estimatedFillPrice } = require('./kalshi-orderbook-service')
const { sendAlert } = require('./alert-service')
const crypto = require('crypto')

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23)

/** @type {import('../types/kalshi').KalshiKeys | null} */
let keys = null

/** @type {Object | null} */
let config = null

/** @type {Map<string, { signal: Object, strategyName: string, placedAt: number, timeout: NodeJS.Timeout }>} */
const pendingOrders = new Map()

/** @type {number} Running realized P&L for circuit breaker */
let dailyPnl = 0

/** @type {number} Unrealized P&L from open positions (marked to market) */
let unrealizedPnl = 0

/** @type {number[]} Timestamps of recent trade executions for rate limiting */
let recentTradeTimestamps = []

/** @type {number} Timestamp of last daily reset */
let dailyPnlResetAt = 0

/** @type {NodeJS.Timeout | null} */
let midnightResetTimer = null

/** @type {{ onFill?: Function, onError?: Function }} */
let callbacks = {}

/** @type {{ totalSlippage: number, fillCount: number, fills: Array<{ticker: string, expected: number, actual: number, slippage: number, ts: string}> }} */
const executionTelemetry = { totalSlippage: 0, fillCount: 0, fills: [] }

/** @type {Set<string>} Dedup set for fill messages (bounded to last 500 entries) */
const processedFills = new Set()
/** @type {string[]} FIFO queue to evict oldest entries from processedFills */
const processedFillsQueue = []

/**
 * Schedule daily P&L reset at midnight UTC
 */
const scheduleMidnightReset = () => {
  if (midnightResetTimer) clearTimeout(midnightResetTimer)

  const now = new Date()
  const nextMidnight = new Date(now)
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1)
  nextMidnight.setUTCHours(0, 0, 0, 0)
  const msUntil = nextMidnight.getTime() - now.getTime()

  midnightResetTimer = setTimeout(() => {
    resetDailyPnl()
    scheduleMidnightReset() // Reschedule for next day
  }, msUntil)

  console.log(`[${ts()}] 🕛 Daily P&L reset scheduled in ${Math.round(msUntil / 60000)}min`)
}

/**
 * Initialize the live execution service
 * @param {import('../types/kalshi').KalshiKeys} apiKeys
 * @param {Object} engineConfig
 * @param {{ onFill?: Function, onError?: Function }} cbs
 */
const initLiveExecution = (apiKeys, engineConfig, cbs = {}) => {
  keys = apiKeys
  config = engineConfig
  callbacks = cbs
  dailyPnl = 0
  dailyPnlResetAt = Date.now()

  scheduleMidnightReset()
  console.log(`[${ts()}] 🔴 Live execution service initialized (maxDailyLoss: $${config.risk?.maxDailyLoss || 100})`)

  return {
    executeOrder,
    getDailyPnl,
    addToDailyPnl,
    updateUnrealizedPnl,
    getExecutionTelemetry,
    getAccountBalance,
    reconcilePositions,
    shutdownLiveExecution
  }
}

/**
 * Wire up to Kalshi WebSocket for fill notifications
 * @param {import('../adapters/websocket').KalshiWebSocket} wsClient
 */
const connectToWebSocket = (wsClient) => {
  wsClient.on('fill', handleFill)
}

/**
 * Execute a live order with pre-trade checks
 * @param {Object} signal - Trading signal
 * @param {string} strategyName
 * @param {Object | null} bookMetrics - Kalshi orderbook metrics for this ticker
 * @returns {Promise<{ orderId?: string, status: string, estimatedPrice?: number, error?: string }>}
 */
/** Default max slippage in cents above signal.price */
const DEFAULT_MAX_SLIPPAGE = 3

/**
 * Place a limit order, wait up to fillTimeoutMs for fill, then retry once at price+1.
 * Falls back to market orders for sells (guaranteed fill matters more on exits).
 *
 * @param {Object} signal - Trading signal (must include .price for limit orders)
 * @param {string} strategyName
 * @param {Object | null} bookMetrics - Kalshi orderbook metrics for this ticker
 * @returns {Promise<{ orderId?: string, status: string, estimatedPrice?: number, error?: string }>}
 */
const executeOrder = async (signal, strategyName, bookMetrics, enginePositions = []) => {
  // Daily loss circuit breaker (conservative default: $100 if config is missing)
  const maxLoss = config?.risk?.maxDailyLoss || 100

  // Early warning at 70% of max loss using realized + unrealized P&L
  const combinedPnl = dailyPnl + unrealizedPnl
  if (signal.action === 'buy' && combinedPnl <= -(maxLoss * 0.7)) {
    const msg = `Circuit breaker early warning: combined P&L $${combinedPnl.toFixed(2)} (realized $${dailyPnl.toFixed(2)} + unrealized $${unrealizedPnl.toFixed(2)}) <= 70% of -$${maxLoss}`
    console.log(`[${ts()}] 🛑 ${msg}`)
    sendAlert('warning', 'Circuit breaker early warning — blocking new buys', { combinedPnl: combinedPnl.toFixed(2), realized: dailyPnl.toFixed(2), unrealized: unrealizedPnl.toFixed(2), maxLoss })
    return { error: msg, status: 'blocked' }
  }

  // Hard stop at 100% realized loss
  if (dailyPnl <= -maxLoss) {
    const msg = `Circuit breaker: daily loss $${Math.abs(dailyPnl).toFixed(2)} >= limit $${maxLoss}`
    console.log(`[${ts()}] 🛑 ${msg}`)
    sendAlert('critical', 'Circuit breaker triggered', { dailyPnl: dailyPnl.toFixed(2), maxLoss })
    return { error: msg, status: 'blocked' }
  }

  // Rate limiter: max trades per hour
  if (signal.action === 'buy') {
    const maxTradesPerHour = config?.risk?.maxTradesPerHour ?? 10
    const oneHourAgo = Date.now() - 3_600_000
    recentTradeTimestamps = recentTradeTimestamps.filter(t => t > oneHourAgo)
    if (recentTradeTimestamps.length >= maxTradesPerHour) {
      const msg = `Rate limit: ${recentTradeTimestamps.length} trades in last hour >= limit ${maxTradesPerHour}`
      console.log(`[${ts()}] 🛑 ${msg}`)
      return { error: msg, status: 'blocked_rate_limit' }
    }
  }

  // API position check: verify engine state matches Kalshi before buying
  if (signal.action === 'buy' && keys) {
    const apiData = await getPositions(keys, { ticker: signal.ticker }).catch(err => {
      console.log(`[${ts()}] ⚠️ Pre-trade position check failed: ${err.message}`)
      return null
    })
    if (apiData) {
      const apiPositions = apiData?.market_positions || []
      const apiPos = apiPositions.find(p => p.ticker === signal.ticker)
      const apiContracts = apiPos ? Math.abs(apiPos.position || 0) : 0
      const enginePos = enginePositions.find(p => p.ticker === signal.ticker)
      const engineContracts = enginePos?.contracts ?? 0

      if (apiContracts > 0 && engineContracts === 0) {
        const msg = `Position mismatch: API has ${apiContracts} contracts on ${signal.ticker} but engine has 0 — blocking buy`
        console.log(`[${ts()}] 🛑 ${msg}`)
        sendAlert('critical', 'Position mismatch detected', { ticker: signal.ticker, apiContracts, engineContracts: 0, strategy: strategyName })
        if (callbacks.onError) callbacks.onError(new Error(msg), { ticker: signal.ticker, strategyName })
        return { error: msg, status: 'blocked_position_mismatch' }
      }
    }
  }

  // Pre-trade liquidity check with adaptive sizing
  if (bookMetrics) {
    const hasLiquidity = canFill(signal.ticker, signal.side, signal.action, signal.count)
    if (!hasLiquidity) {
      // Widen slippage for low-priced OTM contracts (3¢ on a 5¢ market is 60%)
      const slippage = signal.price < 10 ? 5 : 3
      const available = availableContracts(signal.ticker, signal.side, signal.action, slippage)
      if (available >= 1) {
        console.log(`[${ts()}] 📉 Liquidity sizing: ${signal.count}x → ${available}x ${signal.side} ${signal.action} on ${signal.ticker}`)
        signal.count = available
      } else {
        const msg = `No liquidity for ${signal.side} ${signal.action} on ${signal.ticker}`
        console.log(`[${ts()}] ⚠️ ${msg}`)
        return { error: msg, status: 'skipped_liquidity' }
      }
    }
  } else if (signal.action === 'buy') {
    // No orderbook data available for buy entries — block unless conservative mode allows it
    const requireBook = config?.risk?.requireOrderbookForEntry ?? true
    if (requireBook) {
      const msg = `No orderbook data for ${signal.ticker} — blocking entry (requireOrderbookForEntry=true)`
      console.log(`[${ts()}] ⚠️ ${msg}`)
      return { error: msg, status: 'skipped_no_book' }
    }
    // Conservative fallback: cap entry size at 5 contracts when no book data
    if (signal.count > 5) {
      console.log(`[${ts()}] ⚠️ No orderbook for ${signal.ticker}, capping entry from ${signal.count} to 5 contracts`)
      signal.count = 5
    }
  }

  // Estimate fill price from orderbook
  const estPrice = estimatedFillPrice(signal.ticker, signal.side, signal.action, signal.count)

  // Use market orders for sells/exits (guaranteed fill matters more)
  // Use limit orders for buys (avoid slippage eating edge)
  const useLimitOrder = signal.action === 'buy' && signal.price > 0
  const maxSlippage = config?.risk?.maxSlippage ?? DEFAULT_MAX_SLIPPAGE
  const limitPrice = useLimitOrder ? signal.price : null

  // Slippage guard: never pay more than signal.price + maxSlippage
  if (useLimitOrder && estPrice && estPrice > limitPrice + maxSlippage) {
    const msg = `Slippage guard: est fill ${estPrice}¢ > limit ${limitPrice}¢ + ${maxSlippage}¢ max slippage`
    console.log(`[${ts()}] ⚠️ ${msg}`)
    return { error: msg, status: 'skipped_slippage' }
  }

  const result = await placeLimitWithRetry(signal, limitPrice, maxSlippage, strategyName, estPrice)

  // Record timestamp for rate limiting on successful placement
  if (result.orderId && signal.action === 'buy') {
    recentTradeTimestamps.push(Date.now())
  }

  return result
}

/**
 * Place a limit order with one retry at price+1 on timeout.
 * For market orders (limitPrice === null), places immediately with no retry.
 */
const placeLimitWithRetry = async (signal, limitPrice, maxSlippage, strategyName, estPrice) => {
  const clientOrderId = `kb-${crypto.randomUUID().slice(0, 8)}`
  const isLimit = limitPrice != null

  // Kalshi requires a price on all orders — "market" orders use aggressive limit prices
  // For sells: use 1¢ to guarantee fill at best available price
  const effectivePrice = isLimit ? limitPrice : 1
  const priceField = signal.side === 'yes' ? { yes_price: effectivePrice } : { no_price: effectivePrice }

  const orderReq = {
    ticker: signal.ticker,
    side: signal.side,
    action: signal.action,
    count: signal.count,
    type: 'limit',
    client_order_id: clientOrderId,
    ...priceField
  }

  const typeLabel = isLimit ? `LIMIT @ ${limitPrice}¢` : `MARKET (limit ${effectivePrice}¢)`
  console.log(`[${ts()}] 🔴 Placing LIVE ${typeLabel} order: ${signal.action} ${signal.count}x ${signal.side} ${signal.ticker} (est. ${estPrice ?? '?'}¢)`)

  const result = await placeOrder(keys, orderReq)
  const orderId = result?.order?.order_id

  if (!orderId) {
    const msg = `Order placement returned no order_id`
    console.log(`[${ts()}] ❌ ${msg}`)
    if (callbacks.onError) callbacks.onError(new Error(msg))
    return { error: msg, status: 'failed' }
  }

  console.log(`[${ts()}] ✅ Live order placed: ${orderId}`)

  // For limit buy orders: use a shorter fill timeout (3s) then retry once at price+1
  const fillTimeout = isLimit ? 3_000 : 30_000
  const timeout = setTimeout(
    () => isLimit
      ? handleLimitFillTimeout(orderId, signal, limitPrice, maxSlippage, strategyName)
      : handleFillTimeout(orderId),
    fillTimeout
  )

  pendingOrders.set(orderId, {
    signal,
    strategyName,
    placedAt: Date.now(),
    timeout
  })

  return {
    orderId,
    status: 'placed',
    estimatedPrice: estPrice ?? limitPrice ?? signal.price
  }
}

/**
 * Handle limit order fill timeout — cancel and retry once at price + 1
 * @param {string} orderId
 * @param {Object} signal
 * @param {number} limitPrice - Original limit price
 * @param {number} maxSlippage
 * @param {string} strategyName
 */
const handleLimitFillTimeout = async (orderId, signal, limitPrice, maxSlippage, strategyName) => {
  const pending = pendingOrders.get(orderId)
  if (!pending) return

  pendingOrders.delete(orderId)
  console.log(`[${ts()}] ⏰ Limit fill timeout for ${orderId} @ ${limitPrice}¢, cancelling and retrying at ${limitPrice + 1}¢`)

  await cancelOrder(keys, orderId).catch(err =>
    console.log(`[${ts()}] ⚠️ Cancel failed for ${orderId}: ${err.message}`)
  )

  // Retry once at price + 1 (if still within slippage budget)
  const retryPrice = limitPrice + 1
  if (retryPrice > limitPrice + maxSlippage) {
    console.log(`[${ts()}] 🛑 Retry price ${retryPrice}¢ exceeds max slippage (${limitPrice}¢ + ${maxSlippage}¢), giving up`)
    if (callbacks.onError) callbacks.onError(new Error(`Limit order timeout + slippage guard: ${signal.ticker}`), { ticker: signal.ticker, strategyName })
    return
  }

  const retryClientId = `kb-${crypto.randomUUID().slice(0, 8)}`
  const retryReq = {
    ticker: signal.ticker,
    side: signal.side,
    action: signal.action,
    count: signal.count,
    type: 'limit',
    client_order_id: retryClientId,
    ...(signal.side === 'yes' && { yes_price: retryPrice }),
    ...(signal.side === 'no' && { no_price: retryPrice })
  }

  console.log(`[${ts()}] 🔄 Retry LIMIT order: ${signal.action} ${signal.count}x ${signal.side} ${signal.ticker} @ ${retryPrice}¢`)

  const result = await placeOrder(keys, retryReq).catch(err => {
    console.log(`[${ts()}] ❌ Retry order failed: ${err.message}`)
    return null
  })

  const retryOrderId = result?.order?.order_id
  if (!retryOrderId) {
    if (callbacks.onError) callbacks.onError(new Error(`Limit retry failed for ${signal.ticker}`), { ticker: signal.ticker, strategyName })
    return
  }

  // Track retry with standard 30s timeout (no further retries)
  const timeout = setTimeout(() => handleFillTimeout(retryOrderId), 30_000)
  pendingOrders.set(retryOrderId, {
    signal,
    strategyName,
    placedAt: Date.now(),
    timeout
  })
}

/**
 * Handle a fill notification from WebSocket
 * Supports partial fills — keeps tracking until all contracts are filled.
 * @param {Object} msg - Fill message from Kalshi WS
 */
const handleFill = (msg) => {
  const orderId = msg.order_id
  if (!orderId) {
    console.log(`[${ts()}] ⚠️ Fill message missing order_id, ignoring`)
    return
  }

  // Dedup: skip fills we've already processed (WebSocket can redeliver)
  const dedupKey = `${orderId}:${msg.count || 0}:${msg.yes_price || msg.no_price || 0}:${msg.trade_id || ''}`
  if (processedFills.has(dedupKey)) {
    console.log(`[${ts()}] ⚠️ Duplicate fill skipped: ${dedupKey}`)
    return
  }
  processedFills.add(dedupKey)
  processedFillsQueue.push(dedupKey)
  if (processedFillsQueue.length > 500) {
    processedFills.delete(processedFillsQueue.shift())
  }

  const pending = pendingOrders.get(orderId)

  if (!pending) {
    // Fill for an order we're not tracking (maybe from manual trading)
    console.log(`[${ts()}] 📬 Fill for untracked order: ${orderId}`)
    return
  }

  const fillPrice = msg.yes_price || msg.no_price || 0
  const fillCount = msg.count || pending.remainingCount || pending.signal.count

  // Update remaining count for partial fills
  pending.remainingCount = (pending.remainingCount ?? pending.signal.count) - fillCount
  const fullyFilled = pending.remainingCount <= 0

  if (fullyFilled) {
    clearTimeout(pending.timeout)
    pendingOrders.delete(orderId)
  } else {
    // Partial fill — reset timeout for remaining contracts
    clearTimeout(pending.timeout)
    pending.timeout = setTimeout(() => handleFillTimeout(orderId), 30_000)
    console.log(`[${ts()}] 📬 Partial fill: ${fillCount}x filled, ${pending.remainingCount} remaining for ${orderId}`)
  }

  // Track slippage: expected (signal.price) vs actual fill
  const expectedPrice = pending.signal.price || 0
  const slippage = expectedPrice > 0 ? fillPrice - expectedPrice : 0
  if (expectedPrice > 0) {
    executionTelemetry.totalSlippage += slippage
    executionTelemetry.fillCount++
    executionTelemetry.fills.push({
      ticker: pending.signal.ticker,
      expected: expectedPrice,
      actual: fillPrice,
      slippage,
      ts: new Date().toISOString()
    })
    // Keep last 200 fills to bound memory
    if (executionTelemetry.fills.length > 200) executionTelemetry.fills.shift()
  }

  const slippageStr = expectedPrice > 0 ? ` (slip ${slippage > 0 ? '+' : ''}${slippage}¢)` : ''
  const partialStr = fullyFilled ? '' : ` [partial, ${pending.remainingCount} remaining]`
  console.log(`[${ts()}] 📬 Fill confirmed: ${orderId} — ${fillCount}x @ ${fillPrice}¢${slippageStr}${partialStr}`)

  // Daily P&L is updated via engine.applyFill() -> addToDailyPnl() (single source of truth)

  if (callbacks.onFill) {
    callbacks.onFill({
      orderId,
      ticker: pending.signal.ticker,
      side: pending.signal.side,
      action: pending.signal.action,
      count: fillCount,
      price: fillPrice,
      expectedPrice,
      slippage,
      strategyName: pending.strategyName,
      timestamp: msg.created_time || new Date().toISOString()
    })
  }
}

/**
 * Handle fill timeout — cancel the order if no fill within 30s.
 * If cancel returns 404, the order was already filled — check fills and treat as success.
 * @param {string} orderId
 */
const handleFillTimeout = async (orderId) => {
  const pending = pendingOrders.get(orderId)
  if (!pending) return

  pendingOrders.delete(orderId)
  console.log(`[${ts()}] ⏰ Fill timeout for order ${orderId}, attempting cancel`)

  let cancelFailed404 = false
  await cancelOrder(keys, orderId).catch(err => {
    console.log(`[${ts()}] ⚠️ Cancel failed for ${orderId}: ${err.message}`)
    if (err.message?.includes('not_found') || err.message?.includes('404') || err.message?.includes('not found')) {
      cancelFailed404 = true
    }
  })

  // 404 on cancel means the order was already filled — verify via fills API
  if (cancelFailed404 && keys) {
    console.log(`[${ts()}] 🔍 Cancel 404 — checking if order ${orderId} was filled`)
    const fillsData = await getFills(keys, { order_id: orderId }).catch(() => null)
    const fills = fillsData?.fills || []
    if (fills.length > 0) {
      const totalCount = fills.reduce((sum, f) => sum + (f.count || 0), 0)
      const avgPrice = fills.reduce((sum, f) => sum + (f.yes_price || f.no_price || 0) * (f.count || 0), 0) / (totalCount || 1)
      console.log(`[${ts()}] ✅ Order ${orderId} was filled: ${totalCount}x @ ${Math.round(avgPrice)}¢ (recovered from timeout)`)

      if (callbacks.onFill) {
        callbacks.onFill({
          orderId,
          ticker: pending.signal.ticker,
          side: pending.signal.side,
          action: pending.signal.action,
          count: totalCount,
          price: Math.round(avgPrice),
          expectedPrice: pending.signal.price || 0,
          slippage: pending.signal.price ? Math.round(avgPrice) - pending.signal.price : 0,
          strategyName: pending.strategyName,
          timestamp: fills[0]?.created_time || new Date().toISOString()
        })
      }
      return
    }
  }

  if (callbacks.onError) {
    callbacks.onError(new Error(`Fill timeout: order ${orderId} for ${pending.signal.ticker}`), { ticker: pending.signal.ticker, strategyName: pending.strategyName })
  }
}

/**
 * Get current daily P&L
 * @returns {number}
 */
const getDailyPnl = () => dailyPnl

/**
 * Update daily P&L externally (e.g., from engine fill reconciliation)
 * @param {number} amount
 */
const addToDailyPnl = (amount) => {
  dailyPnl += amount
}

/**
 * Set daily P&L to a specific value (e.g., restoring from persisted state on restart)
 * @param {number} amount
 */
const setDailyPnl = (amount) => {
  dailyPnl = amount
  console.log(`[${ts()}] 💰 Daily P&L restored to $${amount.toFixed(2)}`)
}

/**
 * Reset daily P&L (called at midnight UTC or on restart)
 */
const resetDailyPnl = () => {
  console.log(`[${ts()}] 🕛 Daily P&L reset: was $${dailyPnl.toFixed(2)}`)
  dailyPnl = 0
  unrealizedPnl = 0
  recentTradeTimestamps = []
  dailyPnlResetAt = Date.now()
}

/**
 * Update unrealized P&L from open positions marked to market.
 * Called each eval cycle from simulation-engine.
 * @param {Array<{ ticker: string, side: string, contracts: number, avgCost: number }>} positions
 * @param {Map<string, { yesBid?: number, yesAsk?: number }>} currentPrices
 */
const updateUnrealizedPnl = (positions, currentPrices) => {
  let total = 0
  for (const pos of positions) {
    const price = currentPrices.get(pos.ticker)
    if (!price) continue
    const marketPrice = pos.side === 'yes'
      ? (price.yesBid ?? 50)
      : (100 - (price.yesAsk ?? 50))
    const costBasis = (pos.contracts * pos.avgCost) / 100
    const markValue = (pos.contracts * marketPrice) / 100
    total += markValue - costBasis
  }
  unrealizedPnl = total
}

/**
 * Get execution telemetry (slippage stats)
 * @returns {{ avgSlippage: number, fillCount: number, totalSlippage: number, recentFills: Array }}
 */
const getExecutionTelemetry = () => ({
  avgSlippage: executionTelemetry.fillCount > 0
    ? executionTelemetry.totalSlippage / executionTelemetry.fillCount
    : 0,
  fillCount: executionTelemetry.fillCount,
  totalSlippage: executionTelemetry.totalSlippage,
  recentFills: executionTelemetry.fills.slice(-20)
})

/**
 * Fetch the real Kalshi account balance for engine sync
 * @returns {Promise<number | null>} Available balance in dollars, or null if unavailable
 */
const getAccountBalance = async () => {
  if (!keys) return null
  const balanceData = await getBalance(keys)
  return balanceData?.balance != null ? balanceData.balance / 100 : null
}

/**
 * Reconcile engine positions with actual Kalshi positions
 * Matches on (ticker, side) — not just ticker — to handle YES/NO positions separately.
 * API positions have a signed `position` field: positive = YES, negative = NO.
 * @param {Array<Object>} enginePositions - Current engine position state
 * @returns {Promise<{ matched: number, discrepancies: Array<Object> }>}
 */
const reconcilePositions = async (enginePositions = []) => {
  if (!keys) return { matched: 0, discrepancies: [] }

  const apiData = await getPositions(keys, { settlement_status: 'unsettled' })
  const apiPositions = apiData?.market_positions || []

  const discrepancies = []
  let matched = 0

  // Build a map of API positions by (ticker, side)
  // API `position` is signed: positive = YES, negative = NO
  const apiByKey = new Map()
  for (const pos of apiPositions) {
    const position = pos.position || 0
    if (position === 0) continue
    const side = position > 0 ? 'yes' : 'no'
    const key = `${pos.ticker}:${side}`
    apiByKey.set(key, { ...pos, side, contracts: Math.abs(position) })
  }

  // Check each engine position against API
  for (const enginePos of enginePositions) {
    const key = `${enginePos.ticker}:${enginePos.side}`
    const apiPos = apiByKey.get(key)
    if (!apiPos) {
      discrepancies.push({
        type: 'engine_only',
        ticker: enginePos.ticker,
        side: enginePos.side,
        engine: enginePos.contracts,
        api: 0
      })
      continue
    }

    if (apiPos.contracts !== enginePos.contracts) {
      discrepancies.push({
        type: 'count_mismatch',
        ticker: enginePos.ticker,
        side: enginePos.side,
        engine: enginePos.contracts,
        api: apiPos.contracts
      })
    } else {
      matched++
    }

    apiByKey.delete(key)
  }

  // API positions not in engine
  for (const [key, apiPos] of apiByKey) {
    discrepancies.push({
      type: 'api_only',
      ticker: apiPos.ticker,
      side: apiPos.side,
      engine: 0,
      api: apiPos.contracts,
      market_exposure: apiPos.market_exposure || 0
    })
  }

  if (discrepancies.length > 0) {
    console.log(`[${ts()}] ⚠️ Position reconciliation: ${matched} matched, ${discrepancies.length} discrepancies`)
    for (const d of discrepancies) {
      console.log(`[${ts()}]    ├─ ${d.type}: ${d.ticker} ${d.side} engine=${d.engine} api=${d.api}`)
    }
  } else {
    console.log(`[${ts()}] ✅ Position reconciliation: ${matched} matched, 0 discrepancies`)
  }

  return { matched, discrepancies }
}

/**
 * Shutdown the live execution service
 */
const shutdownLiveExecution = () => {
  // Cancel all pending order timeouts
  for (const [orderId, pending] of pendingOrders) {
    clearTimeout(pending.timeout)
    console.log(`[${ts()}] 🛑 Clearing pending order: ${orderId}`)
  }
  pendingOrders.clear()

  if (midnightResetTimer) {
    clearTimeout(midnightResetTimer)
    midnightResetTimer = null
  }

  keys = null
  config = null
  callbacks = {}
  console.log(`[${ts()}] 🔴 Live execution service shutdown`)
}

module.exports = {
  initLiveExecution,
  connectToWebSocket,
  executeOrder,
  getDailyPnl,
  addToDailyPnl,
  updateUnrealizedPnl,
  setDailyPnl,
  resetDailyPnl,
  getAccountBalance,
  reconcilePositions,
  shutdownLiveExecution
}
