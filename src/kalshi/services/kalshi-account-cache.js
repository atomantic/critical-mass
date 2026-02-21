/**
 * Kalshi Account Cache Service
 * Caches balance and positions to reduce API calls
 */

const { api } = require('../adapters/index')
const { readFile } = require('fs/promises')
const path = require('path')
const { ts } = require('../../time-utils')
const { KALSHI_DATA_DIR } = require('../../paths')

const DATA_DIR = KALSHI_DATA_DIR

/** @type {import('socket.io').Server | null} */
let io = null

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL = 5 * 60 * 1000

/** @type {{ data: Object | null, fetchedAt: number }} */
let balanceCache = { data: null, fetchedAt: 0 }

/** @type {{ data: Array | null, fetchedAt: number }} */
let positionsCache = { data: null, fetchedAt: 0 }

/**
 * Read keys from file
 * @returns {Promise<Object | null>}
 */
const loadKeys = async () => {
  const keysPath = path.join(DATA_DIR, 'keys.json')
  const content = await readFile(keysPath, 'utf-8')
  const keys = JSON.parse(content)
  if (!keys.keyId || !keys.privateKeyPem) return null
  return keys
}

/**
 * Check if cache is still valid
 * @param {{ fetchedAt: number }} cache
 * @returns {boolean}
 */
const isCacheValid = (cache) => {
  return cache.data !== null && (Date.now() - cache.fetchedAt) < CACHE_TTL
}

/**
 * Set the Socket.IO instance for broadcasting updates
 * @param {import('socket.io').Server} ioServer
 */
const setAccountCacheIO = (ioServer) => {
  io = ioServer
}

/**
 * Get balance (cached or fresh)
 * @param {Object} [keys] - Optional keys, will load from file if not provided
 * @param {boolean} [forceRefresh=false] - Force a fresh fetch
 * @returns {Promise<{ available: number, inPositions: number } | null>}
 */
const getBalance = async (keys, forceRefresh = false) => {
  if (!forceRefresh && isCacheValid(balanceCache)) {
    return balanceCache.data
  }

  const apiKeys = keys || await loadKeys()
  if (!apiKeys) return null

  console.log(`[${ts()}] 💰 Fetching balance from API`)
  const balanceData = await api.getBalance(apiKeys)

  const balance = {
    available: balanceData.balance / 100,
    portfolioValue: balanceData.portfolio_value / 100
  }

  balanceCache = { data: balance, fetchedAt: Date.now() }

  // Broadcast update
  if (io) io.emit('kalshi:balance', balance)

  return balance
}

/**
 * Get positions (cached or fresh)
 * @param {Object} [keys] - Optional keys, will load from file if not provided
 * @param {boolean} [forceRefresh=false] - Force a fresh fetch
 * @returns {Promise<Array | null>}
 */
const getPositions = async (keys, forceRefresh = false) => {
  if (!forceRefresh && isCacheValid(positionsCache)) {
    return positionsCache.data
  }

  const apiKeys = keys || await loadKeys()
  if (!apiKeys) return null

  console.log(`[${ts()}] 📊 Fetching positions from API`)
  const positionsData = await api.getPositions(apiKeys, { settlement_status: 'unsettled' })

  const positions = positionsData.market_positions || []

  positionsCache = { data: positions, fetchedAt: Date.now() }

  // Broadcast update
  if (io) io.emit('kalshi:positions', positions)

  return positions
}

/**
 * Get both balance and positions (uses cache)
 * @param {Object} [keys] - Optional keys
 * @param {boolean} [forceRefresh=false] - Force refresh both
 * @returns {Promise<{ balance: Object | null, positions: Array | null }>}
 */
const getAccountData = async (keys, forceRefresh = false) => {
  const apiKeys = keys || await loadKeys()

  // If forcing refresh, fetch both in parallel
  if (forceRefresh || !isCacheValid(balanceCache) || !isCacheValid(positionsCache)) {
    const [balance, positions] = await Promise.all([
      getBalance(apiKeys, forceRefresh),
      getPositions(apiKeys, forceRefresh)
    ])
    return { balance, positions }
  }

  return {
    balance: balanceCache.data,
    positions: positionsCache.data
  }
}

/**
 * Invalidate the cache (call after trades)
 */
const invalidateCache = () => {
  console.log(`[${ts()}] 🔄 Account cache invalidated`)
  balanceCache = { data: null, fetchedAt: 0 }
  positionsCache = { data: null, fetchedAt: 0 }
}

/**
 * Get cache status for debugging
 * @returns {{ balanceAge: number | null, positionsAge: number | null, ttl: number }}
 */
const getCacheStatus = () => {
  return {
    balanceAge: balanceCache.data ? Date.now() - balanceCache.fetchedAt : null,
    positionsAge: positionsCache.data ? Date.now() - positionsCache.fetchedAt : null,
    ttl: CACHE_TTL
  }
}

module.exports = {
  setAccountCacheIO,
  getBalance,
  getPositions,
  getAccountData,
  invalidateCache,
  getCacheStatus
}
