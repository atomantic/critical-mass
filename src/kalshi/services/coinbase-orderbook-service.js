const { ts } = require('../../time-utils')

/** Max levels to keep per side */
const MAX_LEVELS = 50

/** Min interval between metrics recomputation (ms) */
const THROTTLE_MS = 250

/**
 * @typedef {Object} OrderBookMetrics
 * @property {number} midPrice - (bestBid + bestAsk) / 2
 * @property {number} spread - bestAsk - bestBid
 * @property {number} vamp - Volume-adjusted mid price
 * @property {number} imbalance - (bidDepth - askDepth) / (bidDepth + askDepth), range [-1, 1]
 * @property {number | null} strikeImbalance - OBI within $100 of strike
 * @property {number | null} bidDepthNearStrike - Total bid size within $100 of strike
 * @property {number | null} askDepthNearStrike - Total ask size within $100 of strike
 * @property {Array<{side: string, price: number, size: number}>} walls - Levels >3x mean depth
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} OrderBook
 * @property {Map<number, number>} bids - price -> size
 * @property {Map<number, number>} asks - price -> size
 */

/** @type {Map<string, OrderBook>} */
const books = new Map()

/** @type {Map<string, OrderBookMetrics>} */
const metricsCache = new Map()

/** @type {Map<string, number>} Strike prices per product */
const strikePrices = new Map()

/** @type {Map<string, number>} Current prices per product */
const currentPrices = new Map()

/** @type {Map<string, number>} Last metrics computation time */
const lastCompute = new Map()

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {((ticker: string, metrics: OrderBookMetrics) => void) | null} */
let metricsCallback = null

/** @type {boolean} */
let isInitialized = false

/**
 * Trim a book side to MAX_LEVELS entries, keeping the best levels
 * @param {Map<number, number>} levels
 * @param {'bids' | 'asks'} side
 */
const trimLevels = (levels, side) => {
  if (levels.size <= MAX_LEVELS) return

  const sorted = Array.from(levels.keys()).sort((a, b) =>
    side === 'bids' ? b - a : a - b
  )

  const toRemove = sorted.slice(MAX_LEVELS)
  for (const price of toRemove) {
    levels.delete(price)
  }
}

/**
 * Compute order book metrics for a product
 * @param {string} productId
 * @returns {OrderBookMetrics | null}
 */
const computeMetrics = (productId) => {
  const book = books.get(productId)
  if (!book || book.bids.size === 0 || book.asks.size === 0) return null

  // Sort levels
  const bidPrices = Array.from(book.bids.keys()).sort((a, b) => b - a)
  const askPrices = Array.from(book.asks.keys()).sort((a, b) => a - b)

  const bestBid = bidPrices[0]
  const bestAsk = askPrices[0]
  const bestBidSize = book.bids.get(bestBid)
  const bestAskSize = book.asks.get(bestAsk)

  const midPrice = (bestBid + bestAsk) / 2
  const spread = bestAsk - bestBid

  // Volume-adjusted mid: (bid*askQty + ask*bidQty) / (askQty + bidQty)
  const totalTopQty = bestAskSize + bestBidSize
  const vamp = totalTopQty > 0
    ? (bestBid * bestAskSize + bestAsk * bestBidSize) / totalTopQty
    : midPrice

  // Total depth
  let bidDepth = 0
  for (const size of book.bids.values()) bidDepth += size
  let askDepth = 0
  for (const size of book.asks.values()) askDepth += size

  const totalDepth = bidDepth + askDepth
  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0

  // Strike-relative metrics
  const strike = strikePrices.get(productId)
  let strikeImbalance = null
  let bidDepthNearStrike = null
  let askDepthNearStrike = null

  if (strike) {
    const range = 100 // $100 around strike
    let nearBidDepth = 0
    let nearAskDepth = 0

    for (const [price, size] of book.bids) {
      if (Math.abs(price - strike) <= range) nearBidDepth += size
    }
    for (const [price, size] of book.asks) {
      if (Math.abs(price - strike) <= range) nearAskDepth += size
    }

    bidDepthNearStrike = nearBidDepth
    askDepthNearStrike = nearAskDepth
    const nearTotal = nearBidDepth + nearAskDepth
    strikeImbalance = nearTotal > 0 ? (nearBidDepth - nearAskDepth) / nearTotal : 0
  }

  // Liquidity-to-strike: dollar value of orders between current price and strike
  const currentPrice = currentPrices.get(productId)
  let liquidityToStrike = null

  if (strike && currentPrice) {
    let dollarValue = 0
    let levelCount = 0
    let side = null

    if (currentPrice > strike) {
      // Price above strike — sum bid levels between strike and current price
      side = 'bids'
      for (const [price, size] of book.bids) {
        if (price >= strike && price <= currentPrice) {
          dollarValue += price * size
          levelCount++
        }
      }
    } else if (currentPrice < strike) {
      // Price below strike — sum ask levels between current price and strike
      side = 'asks'
      for (const [price, size] of book.asks) {
        if (price >= currentPrice && price <= strike) {
          dollarValue += price * size
          levelCount++
        }
      }
    }

    if (side) {
      liquidityToStrike = { dollarValue, side, levelCount }
    }
  }

  // Wall detection: levels with size > 3x mean depth
  const allSizes = [
    ...Array.from(book.bids.values()),
    ...Array.from(book.asks.values())
  ]
  const meanSize = allSizes.reduce((s, v) => s + v, 0) / allSizes.length
  const wallThreshold = meanSize * 3

  const walls = []
  for (const [price, size] of book.bids) {
    if (size > wallThreshold) walls.push({ side: 'bid', price, size })
  }
  for (const [price, size] of book.asks) {
    if (size > wallThreshold) walls.push({ side: 'ask', price, size })
  }
  // Sort walls by size descending, limit to top 5
  walls.sort((a, b) => b.size - a.size)
  if (walls.length > 5) walls.length = 5

  return {
    midPrice,
    spread,
    vamp,
    imbalance,
    strikeImbalance,
    bidDepthNearStrike,
    askDepthNearStrike,
    walls,
    liquidityToStrike,
    updatedAt: Date.now()
  }
}

/**
 * Throttled metrics computation + broadcast
 * @param {string} productId
 */
const maybeRecomputeMetrics = (productId) => {
  const now = Date.now()
  const last = lastCompute.get(productId) || 0
  if (now - last < THROTTLE_MS) return

  lastCompute.set(productId, now)

  const metrics = computeMetrics(productId)
  if (!metrics) return

  metricsCache.set(productId, metrics)

  if (metricsCallback) {
    metricsCallback(productId, metrics)
  }

  if (socketIo) {
    socketIo.to('coinbase').emit('coinbase:orderbook', {
      ticker: productId,
      ...metrics
    })
  }
}

/**
 * Handle L2 snapshot from Coinbase WebSocket
 * @param {Object} data
 * @param {string} data.productId
 * @param {Array<[string, string]>} data.bids - [[price, size], ...]
 * @param {Array<[string, string]>} data.asks
 */
const handleL2Snapshot = (data) => {
  const { productId, bids, asks } = data

  const book = {
    bids: new Map(),
    asks: new Map()
  }

  for (const [price, size] of bids) {
    const p = parseFloat(price)
    const s = parseFloat(size)
    if (s > 0) book.bids.set(p, s)
  }

  for (const [price, size] of asks) {
    const p = parseFloat(price)
    const s = parseFloat(size)
    if (s > 0) book.asks.set(p, s)
  }

  trimLevels(book.bids, 'bids')
  trimLevels(book.asks, 'asks')

  books.set(productId, book)
  console.log(`[${ts()}] 📖 L2 snapshot ${productId}: ${book.bids.size} bids, ${book.asks.size} asks`)

  maybeRecomputeMetrics(productId)
}

/**
 * Handle L2 update from Coinbase WebSocket
 * @param {Object} data
 * @param {string} data.productId
 * @param {Array<{side: string, price: string, size: string}>} data.changes
 */
const handleL2Update = (data) => {
  const { productId, changes } = data

  const book = books.get(productId)
  if (!book) return

  for (const { side, price, size } of changes) {
    const p = parseFloat(price)
    const s = parseFloat(size)
    const map = side === 'buy' ? book.bids : book.asks

    if (s === 0) {
      map.delete(p)
    } else {
      map.set(p, s)
    }
  }

  trimLevels(book.bids, 'bids')
  trimLevels(book.asks, 'asks')

  maybeRecomputeMetrics(productId)
}

/**
 * Initialize the order book service
 * @param {import('socket.io').Server} io
 * @param {((ticker: string, metrics: OrderBookMetrics) => void)} [onMetricsUpdate]
 */
const initOrderBookService = (io, onMetricsUpdate = null) => {
  if (isInitialized) return

  socketIo = io
  metricsCallback = onMetricsUpdate
  isInitialized = true
  console.log(`[${ts()}] 📖 Coinbase order book service initialized`)
}

/**
 * Wire up to a CoinbaseWebSocket instance for L2 events
 * @param {import('../../adapters/coinbase/websocket').CoinbaseWebSocket} wsClient
 */
const connectToWebSocket = (wsClient) => {
  wsClient.on('l2_snapshot', handleL2Snapshot)
  wsClient.on('l2_update', handleL2Update)
}

/**
 * Set current strike price for near-strike metrics
 * @param {string} productId
 * @param {number} strike
 */
const setStrikePrice = (productId, strike) => {
  strikePrices.set(productId, strike)
}

/**
 * Set current market price for liquidity-to-strike computation
 * @param {string} productId
 * @param {number} price
 */
const setCurrentPrice = (productId, price) => {
  currentPrices.set(productId, price)
}

/**
 * Get latest metrics for a product
 * @param {string} productId
 * @returns {OrderBookMetrics | null}
 */
const getMetrics = (productId) => metricsCache.get(productId) || null

/**
 * Shutdown the order book service
 */
const shutdownOrderBookService = () => {
  books.clear()
  metricsCache.clear()
  strikePrices.clear()
  currentPrices.clear()
  lastCompute.clear()
  isInitialized = false
  console.log(`[${ts()}] 📖 Coinbase order book service shutdown`)
}

module.exports = {
  initOrderBookService,
  connectToWebSocket,
  setStrikePrice,
  setCurrentPrice,
  getMetrics,
  shutdownOrderBookService
}
