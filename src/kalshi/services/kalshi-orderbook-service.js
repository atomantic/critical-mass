/**
 * Kalshi Orderbook Service
 * Maintains local order books per market from WebSocket orderbook_delta events.
 * Computes liquidity metrics (spread, depth, fill estimates) for pre-trade checks.
 */

const { getOrderbook } = require('../adapters/api')
const { readFile } = require('fs/promises')
const path = require('path')
const { ts } = require('../../time-utils')
const { KALSHI_DATA_DIR } = require('../../paths')

const DATA_DIR = KALSHI_DATA_DIR
const MAX_LEVELS = 50
const THROTTLE_MS = 250

/**
 * @typedef {Object} KalshiBookMetrics
 * @property {number} bestYesBid
 * @property {number} bestYesAsk
 * @property {number} yesSpread
 * @property {number} bestNoBid
 * @property {number} bestNoAsk
 * @property {number} noSpread
 * @property {number} yesDepth5 - Total qty in top 5 yes bid levels
 * @property {number} noDepth5 - Total qty in top 5 no bid levels
 * @property {number} updatedAt
 */

/** @type {Map<string, { yes: Map<number, number>, no: Map<number, number> }>} */
const books = new Map()

/** @type {Map<string, KalshiBookMetrics>} */
const metricsCache = new Map()

/** @type {Map<string, number>} */
const lastCompute = new Map()

/** @type {Set<string>} Tickers with a REST snapshot already seeded */
const seeded = new Set()

/** Staggered seed queue to avoid 429s from Kalshi */
const seedQueue = []
let seedRunning = false
const SEED_DELAY_MS = 150 // ms between REST orderbook requests

/** Batch counters for seed summary logging */
let seedBatchCount = 0
let seedBatchErrors = 0
let seedBatchStart = 0

const drainSeedQueue = async () => {
  if (seedRunning) return
  seedRunning = true
  seedBatchCount = 0
  seedBatchErrors = 0
  seedBatchStart = Date.now()
  const batchSize = seedQueue.length
  while (seedQueue.length > 0) {
    const ticker = seedQueue.shift()
    await seedFromRest(ticker).catch(err => {
      seedBatchErrors++
      console.log(`[${ts()}] ⚠️ Orderbook seed failed for ${ticker}: ${err.message}`)
    })
    if (seedQueue.length > 0) await new Promise(r => setTimeout(r, SEED_DELAY_MS))
  }
  if (batchSize > 1) {
    const elapsed = ((Date.now() - seedBatchStart) / 1000).toFixed(1)
    console.log(`[${ts()}] 📖 Seeded ${seedBatchCount} orderbooks in ${elapsed}s${seedBatchErrors > 0 ? ` (${seedBatchErrors} failed)` : ''}`)
  }
  seedRunning = false
}

const enqueueSeed = (ticker) => {
  if (seeded.has(ticker) || seedQueue.includes(ticker)) return
  seedQueue.push(ticker)
  drainSeedQueue()
}

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {((ticker: string, metrics: KalshiBookMetrics) => void) | null} */
let metricsCallback = null

/** @type {import('../adapters/websocket').KalshiWebSocket | null} */
let wsRef = null

/** @type {boolean} */
let isInitialized = false

/**
 * Load API keys from disk
 * @returns {Promise<import('../types/kalshi').KalshiKeys | null>}
 */
const loadKeys = async () => {
  const content = await readFile(path.join(DATA_DIR, 'keys.json'), 'utf-8')
  const keys = JSON.parse(content)
  if (!keys.keyId || !keys.privateKeyPem) return null
  return keys
}

/**
 * Seed a ticker's book from the REST orderbook snapshot
 * @param {string} ticker
 */
const seedFromRest = async (ticker) => {
  if (seeded.has(ticker)) return
  seeded.add(ticker)

  const keys = await loadKeys()
  if (!keys) return

  const snapshot = await getOrderbook(keys, ticker, MAX_LEVELS)
  const book = { yes: new Map(), no: new Map() }

  // Kalshi REST orderbook: { orderbook: { yes: [[price, qty], ...], no: [[price, qty], ...] } }
  const ob = snapshot?.orderbook || snapshot
  if (ob?.yes) {
    for (const [price, qty] of ob.yes) {
      if (qty > 0) book.yes.set(Number(price), Number(qty))
    }
  }
  if (ob?.no) {
    for (const [price, qty] of ob.no) {
      if (qty > 0) book.no.set(Number(price), Number(qty))
    }
  }

  books.set(ticker, book)
  seedBatchCount++
  maybeRecomputeMetrics(ticker)
}

/**
 * Apply an orderbook_delta message to the local book
 * @param {Object} msg - { market_ticker, yes: [[price, qty], ...], no: [[price, qty], ...] }
 */
const handleOrderbookDelta = (msg) => {
  const ticker = msg.market_ticker
  if (!ticker) return

  // Seed from REST on first delta if we haven't already
  if (!books.has(ticker)) {
    enqueueSeed(ticker)
    return
  }

  const book = books.get(ticker)

  // Apply yes side deltas
  if (msg.yes) {
    for (const [price, qty] of msg.yes) {
      const p = Number(price)
      const q = Number(qty)
      if (q === 0) {
        book.yes.delete(p)
      } else {
        book.yes.set(p, q)
      }
    }
  }

  // Apply no side deltas
  if (msg.no) {
    for (const [price, qty] of msg.no) {
      const p = Number(price)
      const q = Number(qty)
      if (q === 0) {
        book.no.delete(p)
      } else {
        book.no.set(p, q)
      }
    }
  }

  maybeRecomputeMetrics(ticker)
}

/**
 * Compute metrics for a ticker's book
 * @param {string} ticker
 * @returns {KalshiBookMetrics | null}
 */
const computeMetrics = (ticker) => {
  const book = books.get(ticker)
  if (!book) return null

  // Yes side: bids are sorted descending, asks ascending
  const yesBids = Array.from(book.yes.entries())
    .filter(([p]) => p > 0)
    .sort(([a], [b]) => b - a)

  // For yes: bids are the "buy yes" prices, asks are 100 - noBids
  // In Kalshi, the yes and no sides of the orderbook are separate
  // yes side levels are yes contract orders
  // no side levels are no contract orders
  const noBids = Array.from(book.no.entries())
    .filter(([p]) => p > 0)
    .sort(([a], [b]) => b - a)

  // Best yes bid = highest price someone will pay for yes
  const bestYesBid = yesBids.length > 0 ? yesBids[0][0] : 0
  // Best yes ask = 100 - best no bid (someone selling yes is buying no)
  const bestYesAsk = noBids.length > 0 ? (100 - noBids[0][0]) : 0
  const yesSpread = bestYesAsk > 0 && bestYesBid > 0 ? bestYesAsk - bestYesBid : 0

  // Best no bid = highest price someone will pay for no
  const bestNoBid = noBids.length > 0 ? noBids[0][0] : 0
  // Best no ask = 100 - best yes bid
  const bestNoAsk = yesBids.length > 0 ? (100 - yesBids[0][0]) : 0
  const noSpread = bestNoAsk > 0 && bestNoBid > 0 ? bestNoAsk - bestNoBid : 0

  // Depth: sum of top 5 levels
  const yesDepth5 = yesBids.slice(0, 5).reduce((sum, [, qty]) => sum + qty, 0)
  const noDepth5 = noBids.slice(0, 5).reduce((sum, [, qty]) => sum + qty, 0)

  return {
    bestYesBid,
    bestYesAsk,
    yesSpread,
    bestNoBid,
    bestNoAsk,
    noSpread,
    yesDepth5,
    noDepth5,
    updatedAt: Date.now()
  }
}

/**
 * Check if we can fill `count` contracts at acceptable slippage
 * @param {string} ticker
 * @param {'yes' | 'no'} side
 * @param {'buy' | 'sell'} action
 * @param {number} count
 * @param {number} [maxSlippageCents=3] - Max acceptable price deviation from best level
 * @returns {boolean}
 */
const canFill = (ticker, side, action, count, maxSlippageCents = 3) => {
  const book = books.get(ticker)
  if (!book) return false

  // Determine which levels to walk
  // Buy yes -> walk yes asks (ascending) = walk no bids (descending), price = 100 - noPrice
  // Sell yes -> walk yes bids (descending)
  // Buy no -> walk no asks (ascending) = walk yes bids (descending), price = 100 - yesPrice
  // Sell no -> walk no bids (descending)
  let levels
  if (side === 'yes' && action === 'buy') {
    // Walk no bids descending (best no bid = best yes ask at 100-price)
    levels = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
  } else if (side === 'yes' && action === 'sell') {
    levels = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
  } else if (side === 'no' && action === 'buy') {
    levels = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
  } else {
    levels = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
  }

  if (levels.length === 0) return false

  const bestPrice = levels[0][0]
  let remaining = count

  for (const [price, qty] of levels) {
    if (Math.abs(price - bestPrice) > maxSlippageCents) break
    remaining -= qty
    if (remaining <= 0) return true
  }

  return false
}

/**
 * Count how many contracts are available within slippage tolerance.
 * Used for liquidity-aware sizing when canFill rejects the full order.
 * @param {string} ticker
 * @param {'yes' | 'no'} side
 * @param {'buy' | 'sell'} action
 * @param {number} [maxSlippageCents=3]
 * @returns {number} Available contracts within slippage window
 */
const availableContracts = (ticker, side, action, maxSlippageCents = 3) => {
  const book = books.get(ticker)
  if (!book) return 0

  let levels
  if (side === 'yes' && action === 'buy') {
    levels = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
  } else if (side === 'yes' && action === 'sell') {
    levels = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
  } else if (side === 'no' && action === 'buy') {
    levels = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
  } else {
    levels = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
  }

  if (levels.length === 0) return 0

  const bestPrice = levels[0][0]
  let available = 0

  for (const [price, qty] of levels) {
    if (Math.abs(price - bestPrice) > maxSlippageCents) break
    available += qty
  }

  return available
}

/**
 * Walk the book to estimate VWAP fill price for `count` contracts
 * @param {string} ticker
 * @param {'yes' | 'no'} side
 * @param {'buy' | 'sell'} action
 * @param {number} count
 * @returns {number | null} Estimated fill price in cents, or null if insufficient liquidity
 */
const estimatedFillPrice = (ticker, side, action, count) => {
  const book = books.get(ticker)
  if (!book) return null

  let levels
  if (side === 'yes' && action === 'buy') {
    // Walking no bids, effective yes price = 100 - noPrice
    const raw = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
    levels = raw.map(([p, q]) => [100 - p, q])
    // Re-sort ascending for buy (cheapest first)
    levels.sort(([a], [b]) => a - b)
  } else if (side === 'yes' && action === 'sell') {
    levels = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
  } else if (side === 'no' && action === 'buy') {
    const raw = Array.from(book.yes.entries()).sort(([a], [b]) => b - a)
    levels = raw.map(([p, q]) => [100 - p, q])
    levels.sort(([a], [b]) => a - b)
  } else {
    levels = Array.from(book.no.entries()).sort(([a], [b]) => b - a)
  }

  let remaining = count
  let totalCost = 0

  for (const [price, qty] of levels) {
    const fill = Math.min(remaining, qty)
    totalCost += fill * price
    remaining -= fill
    if (remaining <= 0) break
  }

  if (remaining > 0) return null // Not enough liquidity
  return Math.round(totalCost / count)
}

/**
 * Throttled metrics computation + broadcast
 * @param {string} ticker
 */
const maybeRecomputeMetrics = (ticker) => {
  const now = Date.now()
  const last = lastCompute.get(ticker) || 0
  if (now - last < THROTTLE_MS) return

  lastCompute.set(ticker, now)

  const metrics = computeMetrics(ticker)
  if (!metrics) return

  metricsCache.set(ticker, metrics)

  if (metricsCallback) metricsCallback(ticker, metrics)

  if (socketIo) {
    socketIo.to('kalshi-orderbook').emit('kalshi:orderbook', { ticker, ...metrics })
  }
}

/**
 * Initialize the Kalshi order book service
 * @param {import('socket.io').Server} io
 * @param {((ticker: string, metrics: KalshiBookMetrics) => void)} [onMetricsUpdate]
 */
const initKalshiOrderBookService = (io, onMetricsUpdate = null) => {
  if (isInitialized) return

  socketIo = io
  metricsCallback = onMetricsUpdate
  isInitialized = true
  console.log(`[${ts()}] 📖 Kalshi order book service initialized`)
}

/**
 * Wire up to the Kalshi WebSocket client for orderbook_delta events
 * @param {import('../adapters/websocket').KalshiWebSocket} wsClient
 */
const connectToWebSocket = (wsClient) => {
  wsRef = wsClient
  wsClient.on('orderbook', handleOrderbookDelta)
}

/**
 * Subscribe a ticker to orderbook deltas + seed from REST
 * @param {string} ticker
 */
const subscribeTicker = (ticker) => {
  if (wsRef?.connected) {
    wsRef.subscribeOrderbook(ticker)
  }
  enqueueSeed(ticker)
}

/**
 * Unsubscribe a ticker and clean up local state
 * @param {string} ticker
 */
const unsubscribeTicker = (ticker) => {
  books.delete(ticker)
  metricsCache.delete(ticker)
  lastCompute.delete(ticker)
  seeded.delete(ticker)
}

/**
 * Get cached book metrics for a ticker
 * @param {string} ticker
 * @returns {KalshiBookMetrics | null}
 */
const getBookMetrics = (ticker) => metricsCache.get(ticker) || null

/**
 * Shutdown the Kalshi order book service
 */
const shutdownKalshiOrderBookService = () => {
  books.clear()
  metricsCache.clear()
  lastCompute.clear()
  seeded.clear()
  seedQueue.length = 0
  wsRef = null
  isInitialized = false
  console.log(`[${ts()}] 📖 Kalshi order book service shutdown`)
}

module.exports = {
  initKalshiOrderBookService,
  connectToWebSocket,
  subscribeTicker,
  unsubscribeTicker,
  getBookMetrics,
  canFill,
  availableContracts,
  estimatedFillPrice,
  shutdownKalshiOrderBookService
}
