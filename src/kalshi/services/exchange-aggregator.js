const { ts } = require('../../time-utils')

/** Max age for data to be included in composite (ms) */
const STALENESS_LIMIT = 10000

/**
 * @typedef {Object} ExchangePrice
 * @property {number} price
 * @property {number} bid
 * @property {number} ask
 * @property {number} volume24h
 * @property {string} source
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} CompositePrice
 * @property {number} price - Volume-weighted average price
 * @property {number} bid - Best bid across all exchanges
 * @property {number} ask - Best ask across all exchanges
 * @property {number} spread - Tightest spread
 * @property {number} exchangeCount - Exchanges with fresh data
 * @property {number} maxDivergence - Max price diff between exchanges (fractional)
 * @property {Record<string, ExchangePrice>} byExchange
 * @property {number} updatedAt
 */

/** @type {Map<string, Map<string, ExchangePrice>>} ticker -> source -> price */
const exchangeData = new Map()

/** @type {Map<string, CompositePrice>} ticker -> composite */
const compositeCache = new Map()

/** @type {import('socket.io').Server | null} */
let socketIo = null

/** @type {((ticker: string, composite: CompositePrice) => void) | null} */
let compositeCallback = null

/** @type {boolean} */
let isInitialized = false

/**
 * Recompute composite price for a ticker
 * @param {string} ticker
 * @returns {CompositePrice | null}
 */
const recompute = (ticker) => {
  const sources = exchangeData.get(ticker)
  if (!sources || sources.size === 0) return null

  const now = Date.now()
  const fresh = []

  for (const [source, data] of sources) {
    if (now - data.updatedAt < STALENESS_LIMIT) {
      fresh.push({ source, ...data })
    }
  }

  if (fresh.length === 0) return null

  // Volume-weighted average price
  let totalVolume = 0
  let weightedSum = 0
  let bestBid = 0
  let bestAsk = Infinity
  const prices = []

  for (const ex of fresh) {
    const vol = ex.volume24h || 1 // fallback weight of 1 if no volume
    totalVolume += vol
    weightedSum += ex.price * vol
    if (ex.bid > bestBid) bestBid = ex.bid
    if (ex.ask < bestAsk) bestAsk = ex.ask
    prices.push(ex.price)
  }

  const compositePrice = totalVolume > 0 ? weightedSum / totalVolume : prices[0]

  // If bestAsk is still Infinity (no valid asks), use simple fallback
  if (bestAsk === Infinity) bestAsk = compositePrice

  const spread = bestAsk - bestBid

  // Max divergence between any two exchanges (as fraction of composite price)
  let maxDivergence = 0
  if (prices.length >= 2 && compositePrice > 0) {
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    maxDivergence = (maxPrice - minPrice) / compositePrice
  }

  // Build byExchange map
  const byExchange = {}
  for (const ex of fresh) {
    byExchange[ex.source] = {
      price: ex.price,
      bid: ex.bid,
      ask: ex.ask,
      volume24h: ex.volume24h,
      source: ex.source,
      updatedAt: ex.updatedAt
    }
  }

  return {
    price: compositePrice,
    bid: bestBid,
    ask: bestAsk,
    spread,
    exchangeCount: fresh.length,
    maxDivergence,
    byExchange,
    updatedAt: now
  }
}

/**
 * Called by each price service when it gets an update
 * @param {string} source - Exchange name ('coinbase', 'kraken')
 * @param {string} ticker - Normalized ticker ('BTC-USD')
 * @param {number} price
 * @param {Object} data - Full price data with bid, ask, volume24h
 */
const onExchangeUpdate = (source, ticker, price, data) => {
  if (!exchangeData.has(ticker)) {
    exchangeData.set(ticker, new Map())
  }

  exchangeData.get(ticker).set(source, {
    price,
    bid: data.bid ?? price,
    ask: data.ask ?? price,
    volume24h: data.volume24h ?? 0,
    source,
    updatedAt: Date.now()
  })

  const composite = recompute(ticker)
  if (!composite) return

  compositeCache.set(ticker, composite)

  if (compositeCallback) {
    compositeCallback(ticker, composite)
  }

  if (socketIo) {
    socketIo.to('composite').emit('composite:price', {
      ticker,
      ...composite
    })
  }
}

/**
 * Get latest composite price for a ticker
 * @param {string} ticker
 * @returns {CompositePrice | null}
 */
const getComposite = (ticker) => compositeCache.get(ticker) || null

/**
 * Get all composite prices
 * @returns {Record<string, CompositePrice>}
 */
const getAllComposites = () => Object.fromEntries(compositeCache)

/**
 * Initialize the exchange aggregator
 * @param {import('socket.io').Server} io
 * @param {((ticker: string, composite: CompositePrice) => void)} [onCompositeUpdate]
 */
const initAggregator = (io, onCompositeUpdate = null) => {
  if (isInitialized) return

  socketIo = io
  compositeCallback = onCompositeUpdate
  isInitialized = true
  console.log(`[${ts()}] 🔀 Exchange aggregator initialized`)
}

/**
 * Update the composite callback (e.g., when simulation engine starts after init)
 * @param {((ticker: string, composite: CompositePrice) => void) | null} cb
 */
const setCompositeCallback = (cb) => {
  compositeCallback = cb
}

/**
 * Shutdown the aggregator
 */
const shutdownAggregator = () => {
  exchangeData.clear()
  compositeCache.clear()
  isInitialized = false
  console.log(`[${ts()}] 🔀 Exchange aggregator shutdown`)
}

module.exports = {
  initAggregator,
  onExchangeUpdate,
  getComposite,
  getAllComposites,
  setCompositeCallback,
  shutdownAggregator
}
