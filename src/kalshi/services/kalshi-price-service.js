const { createKalshiWebSocket, CHANNELS } = require('../adapters/websocket')
const { readFile } = require('fs/promises')
const path = require('path')
const { ts } = require('../../time-utils')

/**
 * @typedef {import('../types/kalshi').KalshiKeys} KalshiKeys
 * @typedef {import('../types/kalshi').TickerMessage} TickerMessage
 * @typedef {import('../types/kalshi').TradeMessage} TradeMessage
 */

/**
 * @typedef {Object} CachedPrice
 * @property {number} yesBid - Best yes bid
 * @property {number} yesAsk - Best yes ask
 * @property {number} noBid - Best no bid
 * @property {number} noAsk - Best no ask
 * @property {number} lastPrice - Last trade price
 * @property {number} volume - Volume
 * @property {number} updatedAt - Timestamp of last update
 */

const { KALSHI_DATA_DIR } = require('../../paths')
const DATA_DIR = KALSHI_DATA_DIR

/** @type {Map<string, CachedPrice>} */
const priceCache = new Map()

/** @type {import('../adapters/websocket').KalshiWebSocket | null} */
let wsClient = null

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {Set<string>} */
const subscribedTickers = new Set()

/** @type {boolean} */
let isInitialized = false

/** @type {((ticker: string, price: CachedPrice) => void) | null} */
let priceUpdateCallback = null

/**
 * Read keys from file
 * @returns {Promise<KalshiKeys | null>}
 */
const loadKeys = async () => {
  const keysPath = path.join(DATA_DIR, 'keys.json')
  const content = await readFile(keysPath, 'utf-8')
  const keys = JSON.parse(content)
  if (!keys.keyId || !keys.privateKeyPem) return null
  return keys
}

/**
 * Initialize the price service with Socket.IO instance
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {((ticker: string, price: CachedPrice) => void)} [onPriceUpdate] - Callback for price updates
 * @returns {Promise<boolean>} Success status
 */
const initPriceService = async (io, onPriceUpdate = null) => {
  if (isInitialized) return true

  socketIo = io
  priceUpdateCallback = onPriceUpdate
  const keys = await loadKeys()

  if (!keys) {
    console.log(`[${ts()}] ⚠️ Price service: No valid keys configured`)
    return false
  }

  wsClient = createKalshiWebSocket(keys)

  wsClient.on('connected', () => {
    console.log(`[${ts()}] 📡 Price service connected to Kalshi WebSocket`)
    // Resubscribe to all tracked tickers
    subscribedTickers.forEach(ticker => {
      wsClient?.subscribeTicker(ticker)
      wsClient?.subscribeTrades(ticker)
    })
  })

  wsClient.on('disconnected', ({ code, reason }) => {
    console.log(`[${ts()}] 📡 Price service disconnected: ${code} ${reason}`)
  })

  wsClient.on('ticker', (msg) => handleTickerUpdate(msg))
  wsClient.on('trade', (msg) => handleTradeUpdate(msg))
  wsClient.on('error', (err) => console.log(`[${ts()}] 📡 Price service error: ${err.message}`))

  wsClient.connect()
  isInitialized = true
  console.log(`[${ts()}] 📡 Price service initialized`)
  return true
}

/**
 * Handle ticker update from WebSocket
 * @param {TickerMessage} msg - Ticker message
 */
const handleTickerUpdate = (msg) => {
  const ticker = msg.market_ticker
  if (!ticker) return

  const existing = priceCache.get(ticker) || {}
  const yesBid = msg.yes_bid ?? existing.yesBid ?? 0
  const yesAsk = msg.yes_ask ?? existing.yesAsk ?? 0

  // Derive no prices from yes prices when not provided by the API
  // In Kalshi: noBid = 100 - yesAsk, noAsk = 100 - yesBid
  const noBid = msg.no_bid ?? (100 - yesAsk)
  const noAsk = msg.no_ask ?? (100 - yesBid)

  const updated = {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice: msg.last_price ?? existing.lastPrice ?? 0,
    volume: msg.volume ?? existing.volume ?? 0,
    updatedAt: Date.now()
  }

  priceCache.set(ticker, updated)

  // Broadcast to Socket.IO clients subscribed to this ticker
  if (socketIo) {
    socketIo.to(ticker).emit('kalshi:price', { ticker, ...updated })
  }

  // Call price update callback (for simulation engine)
  if (priceUpdateCallback) {
    priceUpdateCallback(ticker, updated)
  }
}

/**
 * Handle trade update from WebSocket
 * @param {TradeMessage} msg - Trade message
 */
const handleTradeUpdate = (msg) => {
  const ticker = msg.market_ticker
  if (!ticker) return

  const existing = priceCache.get(ticker) || {}
  const tradePrice = msg.yes_price ?? msg.no_price ?? existing.lastPrice ?? 0

  priceCache.set(ticker, {
    ...existing,
    lastPrice: tradePrice,
    updatedAt: Date.now()
  })

  // Broadcast trade event
  if (socketIo) {
    socketIo.to(ticker).emit('kalshi:trade', {
      ticker,
      tradeId: msg.trade_id,
      count: msg.count,
      price: tradePrice,
      timestamp: msg.created_time
    })
  }
}

/**
 * Subscribe to price updates for a ticker
 * @param {string} ticker - Market ticker
 */
const subscribeTicker = (ticker, { silent = false } = {}) => {
  if (subscribedTickers.has(ticker)) return

  subscribedTickers.add(ticker)
  if (!silent) console.log(`[${ts()}] 📊 Subscribing to ticker: ${ticker}`)

  if (wsClient?.connected) {
    wsClient.subscribeTicker(ticker)
    wsClient.subscribeTrades(ticker)
  }
}

/**
 * Subscribe to multiple tickers
 * @param {string[]} tickers - Market tickers
 */
const subscribeMany = (tickers) => {
  const newTickers = tickers.filter(t => !subscribedTickers.has(t))
  tickers.forEach(t => subscribeTicker(t, { silent: true }))
  if (newTickers.length > 0) {
    console.log(`[${ts()}] 📊 Subscribed to ${newTickers.length} tickers`)
  }
}

/**
 * Unsubscribe from a ticker
 * @param {string} ticker - Market ticker
 */
const unsubscribeTicker = (ticker) => {
  if (!subscribedTickers.has(ticker)) return

  subscribedTickers.delete(ticker)
  priceCache.delete(ticker)
}

/**
 * Get cached price for a ticker
 * @param {string} ticker - Market ticker
 * @returns {CachedPrice | null} Cached price or null
 */
const getCachedPrice = (ticker) => {
  return priceCache.get(ticker) || null
}

/**
 * Get all cached prices
 * @returns {Record<string, CachedPrice>} All cached prices
 */
const getAllCachedPrices = () => {
  return Object.fromEntries(priceCache)
}

/**
 * Get cache stats
 * @returns {{ tickerCount: number, subscriptionCount: number, connected: boolean }}
 */
const getCacheStats = () => ({
  tickerCount: priceCache.size,
  subscriptionCount: subscribedTickers.size,
  connected: wsClient?.connected ?? false
})

/**
 * Shutdown the price service
 */
const shutdownPriceService = () => {
  if (wsClient) {
    wsClient.disconnect()
    wsClient = null
  }
  priceCache.clear()
  subscribedTickers.clear()
  isInitialized = false
  console.log(`[${ts()}] 📡 Price service shutdown`)
}

/**
 * Get the underlying WebSocket client (for sharing with orderbook/fill services)
 * @returns {import('../adapters/websocket').KalshiWebSocket | null}
 */
const getWsClient = () => wsClient

module.exports = {
  initPriceService,
  subscribeTicker,
  subscribeMany,
  unsubscribeTicker,
  getCachedPrice,
  getAllCachedPrices,
  getCacheStats,
  getWsClient,
  shutdownPriceService
}
