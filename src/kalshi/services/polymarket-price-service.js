/**
 * Polymarket Price Service
 * Tracks Polymarket 5-minute BTC Up/Down markets as a crowd-sentiment signal.
 * Auto-discovers the current market every 5 minutes via Gamma API and
 * subscribes to real-time price updates via WebSocket.
 */

const { createPolymarketWebSocket } = require('../adapters/polymarket-websocket')
const { ts } = require('../../time-utils')

const GAMMA_API = 'https://gamma-api.polymarket.com'

/** Interval for market windows in seconds (5 min = 300s) */
const WINDOW_SECONDS = 300

/**
 * @typedef {Object} PolymarketSentiment
 * @property {number} upPrice - "Up" token price (0-1), e.g., 0.65 = 65% crowd says up
 * @property {number} downPrice - "Down" token price (0-1)
 * @property {string} slug - Current market slug
 * @property {string} conditionId - Market condition ID
 * @property {string} upTokenId - Token ID for "Up" outcome
 * @property {string} downTokenId - Token ID for "Down" outcome
 * @property {number} windowStart - Unix timestamp of current 5-min window start
 * @property {number} windowEnd - Unix timestamp of current 5-min window end
 * @property {number} updatedAt - Timestamp of last price update
 */

/** @type {import('../adapters/polymarket-websocket').PolymarketWebSocket | null} */
let wsClient = null

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {boolean} */
let isInitialized = false

/** @type {((sentiment: PolymarketSentiment) => void) | null} */
let sentimentCallback = null

/** @type {PolymarketSentiment | null} */
let currentSentiment = null

/** @type {NodeJS.Timeout | null} */
let rotationTimer = null

/** @type {string | null} Current Up token ID */
let currentUpTokenId = null

/** @type {string | null} Current Down token ID */
let currentDownTokenId = null

/**
 * History of settled 5-min windows (most recent last, capped at 50)
 * @type {Array<{ windowStart: number, windowEnd: number, slug: string, finalUpPrice: number, finalDownPrice: number, result: 'up'|'down'|'unknown', settledAt: number }>}
 */
let windowHistory = []
const MAX_HISTORY = 50

/**
 * Compute the current 5-min window timestamp
 * @returns {number} Unix timestamp aligned to 5-min boundary
 */
const currentWindowTs = () => Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS

/**
 * Fetch the current 5-min BTC market from Gamma API
 * @param {number} windowTs - Window timestamp
 * @returns {Promise<{ slug: string, conditionId: string, upTokenId: string, downTokenId: string } | null>}
 */
const fetchMarketDetails = async (windowTs) => {
  const slug = `btc-updown-5m-${windowTs}`
  const url = `${GAMMA_API}/events?slug=${slug}`

  const response = await fetch(url)
  if (!response.ok) {
    console.log(`[${ts()}] ⚠️ Polymarket Gamma API ${response.status} for ${slug}`)
    return null
  }

  const events = await response.json()
  const event = events?.[0]
  const market = event?.markets?.[0]
  if (!market) {
    console.log(`[${ts()}] ⚠️ No Polymarket market found for ${slug}`)
    return null
  }

  // Parse token IDs — outcomes are ["Up", "Down"], token IDs are parallel
  const outcomes = JSON.parse(market.outcomes || '[]')
  const tokenIds = JSON.parse(market.clobTokenIds || '[]')
  const upIdx = outcomes.indexOf('Up')
  const downIdx = outcomes.indexOf('Down')

  if (upIdx === -1 || downIdx === -1 || !tokenIds[upIdx] || !tokenIds[downIdx]) {
    console.log(`[${ts()}] ⚠️ Could not parse Polymarket token IDs for ${slug}`)
    return null
  }

  // Parse initial prices
  const prices = JSON.parse(market.outcomePrices || '[]')
  const upPrice = parseFloat(prices[upIdx]) || 0.5
  const downPrice = parseFloat(prices[downIdx]) || 0.5

  return {
    slug,
    conditionId: market.conditionId,
    upTokenId: tokenIds[upIdx],
    downTokenId: tokenIds[downIdx],
    upPrice,
    downPrice
  }
}

/**
 * Rotate to the current 5-min market window
 * Unsubscribes from old tokens, fetches new market, subscribes to new tokens
 */
const rotateToCurrentMarket = async () => {
  const windowTs = currentWindowTs()
  const details = await fetchMarketDetails(windowTs)

  if (!details) return

  // Snapshot the outgoing window into history before switching
  if (currentSentiment && currentSentiment.windowStart !== windowTs) {
    const result = currentSentiment.upPrice > 0.5 ? 'up'
      : currentSentiment.downPrice > 0.5 ? 'down'
      : 'unknown'
    windowHistory.push({
      windowStart: currentSentiment.windowStart,
      windowEnd: currentSentiment.windowEnd,
      slug: currentSentiment.slug,
      finalUpPrice: currentSentiment.upPrice,
      finalDownPrice: currentSentiment.downPrice,
      result,
      settledAt: Date.now()
    })
    if (windowHistory.length > MAX_HISTORY) windowHistory.shift()

    // Broadcast settled window to clients
    if (socketIo) {
      socketIo.to('polymarket').emit('polymarket:window_settled', windowHistory[windowHistory.length - 1])
    }
  }

  // Unsubscribe from previous tokens
  const oldTokens = []
  if (currentUpTokenId) oldTokens.push(currentUpTokenId)
  if (currentDownTokenId) oldTokens.push(currentDownTokenId)
  if (oldTokens.length > 0 && wsClient) {
    wsClient.unsubscribe(oldTokens)
  }

  // Update state
  currentUpTokenId = details.upTokenId
  currentDownTokenId = details.downTokenId

  currentSentiment = {
    upPrice: details.upPrice,
    downPrice: details.downPrice,
    slug: details.slug,
    conditionId: details.conditionId,
    upTokenId: details.upTokenId,
    downTokenId: details.downTokenId,
    windowStart: windowTs,
    windowEnd: windowTs + WINDOW_SECONDS,
    updatedAt: Date.now()
  }

  // Subscribe to new tokens
  if (wsClient) {
    wsClient.subscribe([details.upTokenId, details.downTokenId])
  }

  console.log(`[${ts()}] 🟣 Polymarket rotated to ${details.slug} — Up: ${(details.upPrice * 100).toFixed(0)}% Down: ${(details.downPrice * 100).toFixed(0)}%`)

  // Broadcast initial sentiment
  emitSentiment()
}

/**
 * Handle price_change from WebSocket
 * @param {{ market: string, asset_id: string, price: number }} data
 */
const handlePriceChange = (data) => {
  if (!currentSentiment) return

  if (data.asset_id === currentUpTokenId) {
    currentSentiment.upPrice = data.price
    currentSentiment.downPrice = Math.round((1 - data.price) * 100) / 100
    currentSentiment.updatedAt = Date.now()
    emitSentiment()
  } else if (data.asset_id === currentDownTokenId) {
    currentSentiment.downPrice = data.price
    currentSentiment.upPrice = Math.round((1 - data.price) * 100) / 100
    currentSentiment.updatedAt = Date.now()
    emitSentiment()
  }
}

/**
 * Emit current sentiment to callback and Socket.IO
 */
const emitSentiment = () => {
  if (!currentSentiment) return

  if (sentimentCallback) sentimentCallback(currentSentiment)

  if (socketIo) {
    socketIo.to('polymarket').emit('polymarket:sentiment', currentSentiment)
  }
}

/**
 * Schedule rotation at the next 5-min boundary (+ 5s offset to let market populate)
 */
const scheduleNextRotation = () => {
  if (rotationTimer) clearTimeout(rotationTimer)

  const now = Date.now()
  const currentWindow = currentWindowTs()
  const nextWindow = (currentWindow + WINDOW_SECONDS) * 1000
  const delay = Math.max(0, nextWindow - now + 5000) // 5s after boundary

  rotationTimer = setTimeout(async () => {
    await rotateToCurrentMarket().catch(err =>
      console.log(`[${ts()}] ⚠️ Polymarket rotation failed: ${err.message}`)
    )
    scheduleNextRotation()
  }, delay)

  const nextTime = new Date(now + delay).toISOString().slice(11, 19)
  console.log(`[${ts()}] 🟣 Next Polymarket rotation in ${Math.round(delay / 1000)}s (at ${nextTime})`)
}

/**
 * Initialize the Polymarket price service
 * @param {import('socket.io').Server} io
 * @param {((sentiment: PolymarketSentiment) => void)} [onSentimentUpdate]
 * @returns {Promise<boolean>}
 */
const initPolymarketPriceService = async (io, onSentimentUpdate = null) => {
  if (isInitialized) return true

  socketIo = io
  sentimentCallback = onSentimentUpdate

  // Create WebSocket connection
  wsClient = createPolymarketWebSocket()

  wsClient.on('connected', () => {
    console.log(`[${ts()}] 🟣 Polymarket price service connected`)
    // Resubscribe to current tokens if we have them
    const tokens = []
    if (currentUpTokenId) tokens.push(currentUpTokenId)
    if (currentDownTokenId) tokens.push(currentDownTokenId)
    if (tokens.length > 0) wsClient.subscribe(tokens)
  })

  wsClient.on('disconnected', ({ code, reason }) => {
    console.log(`[${ts()}] 🟣 Polymarket disconnected: ${code} ${reason}`)
  })

  wsClient.on('price_change', handlePriceChange)
  wsClient.on('error', (err) => console.log(`[${ts()}] 🟣 Polymarket error: ${err.message}`))

  wsClient.connect()

  // Fetch initial market
  await rotateToCurrentMarket().catch(err =>
    console.log(`[${ts()}] ⚠️ Polymarket initial market fetch failed: ${err.message}`)
  )

  // Schedule future rotations
  scheduleNextRotation()

  isInitialized = true
  console.log(`[${ts()}] 🟣 Polymarket price service initialized`)
  return true
}

/**
 * Get current sentiment data
 * @returns {PolymarketSentiment | null}
 */
const getCurrentSentiment = () => currentSentiment

/**
 * Get recent window history
 * @param {number} [limit=20]
 * @returns {Array}
 */
const getWindowHistory = (limit = 20) => windowHistory.slice(-limit)

/**
 * Get windows within a time range (for mapping 5-min windows to a Kalshi 15-min window)
 * @param {number} rangeStart - Unix timestamp (seconds)
 * @param {number} rangeEnd - Unix timestamp (seconds)
 * @returns {{ settled: Array, live: Object | null }}
 */
const getWindowsInRange = (rangeStart, rangeEnd) => {
  const settled = windowHistory.filter(w => w.windowStart >= rangeStart && w.windowStart < rangeEnd)
  const live = currentSentiment?.windowStart >= rangeStart && currentSentiment?.windowStart < rangeEnd
    ? currentSentiment
    : null
  return { settled, live }
}

/**
 * Get service status
 * @returns {{ connected: boolean, currentSlug: string | null, upPrice: number | null, downPrice: number | null }}
 */
const getStatus = () => ({
  connected: wsClient?.connected ?? false,
  currentSlug: currentSentiment?.slug ?? null,
  upPrice: currentSentiment?.upPrice ?? null,
  downPrice: currentSentiment?.downPrice ?? null,
  windowStart: currentSentiment?.windowStart ?? null,
  windowEnd: currentSentiment?.windowEnd ?? null,
  updatedAt: currentSentiment?.updatedAt ?? null
})

/**
 * Shutdown the Polymarket price service
 */
const shutdownPolymarketPriceService = () => {
  if (rotationTimer) {
    clearTimeout(rotationTimer)
    rotationTimer = null
  }
  if (wsClient) {
    wsClient.disconnect()
    wsClient = null
  }
  currentSentiment = null
  currentUpTokenId = null
  currentDownTokenId = null
  windowHistory = []
  isInitialized = false
  console.log(`[${ts()}] 🟣 Polymarket price service shutdown`)
}

module.exports = {
  initPolymarketPriceService,
  getCurrentSentiment,
  getWindowHistory,
  getWindowsInRange,
  getStatus,
  shutdownPolymarketPriceService
}
