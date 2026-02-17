const { createKrakenWebSocket } = require('../../adapters/kraken/websocket')

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23)

/**
 * @typedef {Object} CachedCryptoPrice
 * @property {number} price - Current price
 * @property {number} bid - Best bid
 * @property {number} ask - Best ask
 * @property {number} volume24h - 24h volume
 * @property {number} previousPrice - Previous price (for momentum)
 * @property {number} priceChange - Price change since last update
 * @property {string} source - 'kraken'
 * @property {number} updatedAt - Timestamp of last update
 */

/** @type {Map<string, CachedCryptoPrice>} */
const priceCache = new Map()

/** @type {import('../adapters/kraken-websocket').KrakenWebSocket | null} */
let wsClient = null

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {boolean} */
let isInitialized = false

/** @type {((ticker: string, price: number, data: Object) => void) | null} */
let priceCallback = null

/** Default tickers to subscribe to (Kraken format) */
const DEFAULT_TICKERS = ['BTC/USD']

/**
 * Initialize the Kraken price service with Socket.IO instance
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {((ticker: string, price: number, data: Object) => void)} [onPriceUpdate] - Callback for price updates
 * @param {string[]} [tickers] - Initial tickers to subscribe (Kraken format)
 * @returns {boolean} Success status
 */
const initKrakenPriceService = (io, onPriceUpdate = null, tickers = DEFAULT_TICKERS) => {
  if (isInitialized) return true

  socketIo = io
  priceCallback = onPriceUpdate
  wsClient = createKrakenWebSocket()

  wsClient.on('connected', () => {
    console.log(`[${ts()}] 🦑 Kraken price service connected`)
    if (tickers.length > 0) {
      wsClient.subscribe(tickers)
    }
  })

  wsClient.on('disconnected', ({ code, reason }) => {
    console.log(`[${ts()}] 🦑 Kraken price service disconnected: ${code} ${reason}`)
  })

  wsClient.on('ticker', (data) => handleTickerUpdate(data))
  wsClient.on('error', (err) => console.log(`[${ts()}] 🦑 Kraken error: ${err.message}`))

  wsClient.connect()
  isInitialized = true
  console.log(`[${ts()}] 🦑 Kraken price service initialized`)
  return true
}

/**
 * Handle ticker update from WebSocket
 * @param {Object} data
 */
const handleTickerUpdate = (data) => {
  const { productId, price, bid, ask, volume24h } = data
  if (!productId || !Number.isFinite(price)) return

  const existing = priceCache.get(productId)
  const previousPrice = existing?.price || price
  const priceChange = price - previousPrice

  const updated = {
    price,
    bid,
    ask,
    volume24h,
    previousPrice,
    priceChange,
    source: 'kraken',
    updatedAt: Date.now()
  }

  priceCache.set(productId, updated)

  // Call price callback for simulation engine
  if (priceCallback) {
    priceCallback(productId, price, updated)
  }

  // Broadcast to Socket.IO clients in the kraken room
  if (socketIo) {
    socketIo.to('kraken').emit('kraken:price', {
      ticker: productId,
      ...updated
    })

    socketIo.to(`kraken:${productId}`).emit('kraken:price', {
      ticker: productId,
      ...updated
    })
  }
}

/**
 * Subscribe to price updates for a ticker
 * @param {string} ticker - Product ID (e.g., 'BTC-USD' or 'BTC/USD')
 */
const subscribeTicker = (ticker) => {
  if (!wsClient) return
  console.log(`[${ts()}] 🦑 Subscribing to: ${ticker}`)
  wsClient.subscribe(ticker)
}

/**
 * Unsubscribe from a ticker
 * @param {string} ticker
 */
const unsubscribeTicker = (ticker) => {
  if (!wsClient) return
  console.log(`[${ts()}] 🦑 Unsubscribing from: ${ticker}`)
  wsClient.unsubscribe(ticker)
  priceCache.delete(ticker)
}

/**
 * Get cached price for a ticker
 * @param {string} ticker
 * @returns {CachedCryptoPrice | null}
 */
const getCachedPrice = (ticker) => priceCache.get(ticker) || null

/**
 * Get all cached prices
 * @returns {Record<string, CachedCryptoPrice>}
 */
const getAllCachedPrices = () => Object.fromEntries(priceCache)

/**
 * Get service status
 * @returns {{ connected: boolean, tickerCount: number, subscriptions: string[] }}
 */
const getStatus = () => {
  const wsStatus = wsClient?.getStatus() || { connected: false, subscriptions: [], reconnectAttempts: 0 }
  return {
    connected: wsStatus.connected,
    tickerCount: priceCache.size,
    subscriptions: wsStatus.subscriptions,
    reconnectAttempts: wsStatus.reconnectAttempts
  }
}

/**
 * Shutdown the Kraken price service
 */
const shutdownKrakenPriceService = () => {
  if (wsClient) {
    wsClient.disconnect()
    wsClient = null
  }
  priceCache.clear()
  isInitialized = false
  console.log(`[${ts()}] 🦑 Kraken price service shutdown`)
}

module.exports = {
  initKrakenPriceService,
  subscribeTicker,
  unsubscribeTicker,
  getCachedPrice,
  getAllCachedPrices,
  getStatus,
  shutdownKrakenPriceService
}
