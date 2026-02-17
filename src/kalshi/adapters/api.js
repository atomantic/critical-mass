const { createAuthHeaders, getBaseUrl } = require('./auth')

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23)

/**
 * @typedef {import('../types/kalshi').KalshiKeys} KalshiKeys
 * @typedef {import('../types/kalshi').BalanceResponse} BalanceResponse
 * @typedef {import('../types/kalshi').MarketsResponse} MarketsResponse
 * @typedef {import('../types/kalshi').PositionsResponse} PositionsResponse
 * @typedef {import('../types/kalshi').OrdersResponse} OrdersResponse
 * @typedef {import('../types/kalshi').FillsResponse} FillsResponse
 * @typedef {import('../types/kalshi').EventsResponse} EventsResponse
 * @typedef {import('../types/kalshi').Orderbook} Orderbook
 * @typedef {import('../types/kalshi').KalshiMarket} KalshiMarket
 * @typedef {import('../types/kalshi').KalshiEvent} KalshiEvent
 * @typedef {import('../types/kalshi').KalshiOrder} KalshiOrder
 * @typedef {import('../types/kalshi').OrderRequest} OrderRequest
 * @typedef {import('../types/kalshi').ExchangeStatusResponse} ExchangeStatusResponse
 * @typedef {import('../types/kalshi').ConnectionTestResult} ConnectionTestResult
 * @typedef {import('../types/kalshi').MarketsQueryParams} MarketsQueryParams
 * @typedef {import('../types/kalshi').PositionsQueryParams} PositionsQueryParams
 * @typedef {import('../types/kalshi').OrdersQueryParams} OrdersQueryParams
 * @typedef {import('../types/kalshi').FillsQueryParams} FillsQueryParams
 */

/**
 * Make an authenticated request to the Kalshi API
 * @param {KalshiKeys} keys - API keys
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @param {Record<string, unknown> | null} [body=null] - Request body
 * @returns {Promise<Record<string, unknown>>} API response
 */
const makeRequest = async (keys, method, path, body = null) => {
  if (!keys?.environment) throw new Error('Keys with environment required')

  const baseUrl = getBaseUrl(keys.environment)
  const url = `${baseUrl}${path}`

  const headers = createAuthHeaders(keys, method, path)
  if (!headers) throw new Error('Invalid API keys - cannot create auth headers')

  const options = { method, headers }
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body)
  }

  const start = Date.now()
  const isWrite = method !== 'GET'
  if (isWrite) console.log(`[${ts()}] 🌐 ${method} ${path}`)
  const response = await fetch(url, options)
  const elapsed = Date.now() - start
  if (!response.ok) {
    console.log(`[${ts()}] ❌ ${method} ${path} ${response.status} (${elapsed}ms)`)
  } else if (isWrite || elapsed > 1000) {
    console.log(`[${ts()}] ✅ ${method} ${path} ${response.status} (${elapsed}ms)`)
  }

  // Handle non-JSON responses
  const contentType = response.headers.get('content-type')
  if (!contentType?.includes('application/json')) {
    if (!response.ok) {
      const text = await response.text()
      const error = new Error(text || `API error: ${response.status}`)
      error.status = response.status
      throw error
    }
    return {}
  }

  const data = await response.json()

  if (!response.ok) {
    // Extract error message - handle cases where message/error might be objects
    const rawMessage = data.message || data.error || data.detail
    const message = typeof rawMessage === 'string'
      ? rawMessage
      : rawMessage && typeof rawMessage === 'object'
        ? JSON.stringify(rawMessage)
        : `API error: ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.code = data.code
    throw error
  }

  return data
}

/**
 * Build query string from params object
 * @param {Record<string, string | number | boolean | undefined | null>} params - Query parameters
 * @returns {string} Query string with leading '?' or empty string
 */
const buildQuery = (params) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.append(key, value)
    }
  }
  const str = query.toString()
  return str ? `?${str}` : ''
}

/**
 * Get portfolio balance
 * @param {KalshiKeys} keys - API keys
 * @returns {Promise<BalanceResponse>} Balance response
 */
const getBalance = async (keys) => {
  return /** @type {Promise<BalanceResponse>} */ (makeRequest(keys, 'GET', '/trade-api/v2/portfolio/balance'))
}

/**
 * Get portfolio positions
 * @param {KalshiKeys} keys - API keys
 * @param {PositionsQueryParams} [params={}] - Query parameters
 * @returns {Promise<PositionsResponse>} Positions response
 */
const getPositions = async (keys, params = {}) => {
  const query = buildQuery(params)
  return /** @type {Promise<PositionsResponse>} */ (makeRequest(keys, 'GET', `/trade-api/v2/portfolio/positions${query}`))
}

/**
 * Get markets list
 * @param {KalshiKeys} keys - API keys
 * @param {MarketsQueryParams} [params={}] - Query parameters
 * @returns {Promise<MarketsResponse>} Markets response
 */
const getMarkets = async (keys, params = {}) => {
  const query = buildQuery(params)
  return /** @type {Promise<MarketsResponse>} */ (makeRequest(keys, 'GET', `/trade-api/v2/markets${query}`))
}

/**
 * Get single market details
 * @param {KalshiKeys} keys - API keys
 * @param {string} ticker - Market ticker
 * @returns {Promise<{market: KalshiMarket}>} Market response
 */
const getMarket = async (keys, ticker) => {
  if (!ticker) throw new Error('Ticker required')
  return /** @type {Promise<{market: KalshiMarket}>} */ (makeRequest(keys, 'GET', `/trade-api/v2/markets/${ticker}`))
}

/**
 * Get market orderbook
 * @param {KalshiKeys} keys - API keys
 * @param {string} ticker - Market ticker
 * @param {number} [depth=10] - Orderbook depth
 * @returns {Promise<Orderbook>} Orderbook response
 */
const getOrderbook = async (keys, ticker, depth = 10) => {
  if (!ticker) throw new Error('Ticker required')
  return /** @type {Promise<Orderbook>} */ (makeRequest(keys, 'GET', `/trade-api/v2/markets/${ticker}/orderbook?depth=${depth}`))
}

/**
 * Get events list
 * @param {KalshiKeys} keys - API keys
 * @param {Record<string, string | number>} [params={}] - Query parameters
 * @returns {Promise<EventsResponse>} Events response
 */
const getEvents = async (keys, params = {}) => {
  const query = buildQuery(params)
  return /** @type {Promise<EventsResponse>} */ (makeRequest(keys, 'GET', `/trade-api/v2/events${query}`))
}

/**
 * Get single event details
 * @param {KalshiKeys} keys - API keys
 * @param {string} eventTicker - Event ticker
 * @returns {Promise<{event: KalshiEvent}>} Event response
 */
const getEvent = async (keys, eventTicker) => {
  if (!eventTicker) throw new Error('Event ticker required')
  return /** @type {Promise<{event: KalshiEvent}>} */ (makeRequest(keys, 'GET', `/trade-api/v2/events/${eventTicker}`))
}

/**
 * Place a new order
 * @param {KalshiKeys} keys - API keys
 * @param {OrderRequest} order - Order details
 * @returns {Promise<{order: KalshiOrder}>} Order response
 */
const placeOrder = async (keys, order) => {
  if (!order?.ticker) throw new Error('Order ticker required')
  if (!order?.side) throw new Error('Order side required')
  if (!order?.action) throw new Error('Order action required')
  if (!order?.count) throw new Error('Order count required')
  return /** @type {Promise<{order: KalshiOrder}>} */ (makeRequest(keys, 'POST', '/trade-api/v2/portfolio/orders', order))
}

/**
 * Cancel an existing order
 * @param {KalshiKeys} keys - API keys
 * @param {string} orderId - Order ID to cancel
 * @returns {Promise<{order: KalshiOrder}>} Cancelled order response
 */
const cancelOrder = async (keys, orderId) => {
  if (!orderId) throw new Error('Order ID required')
  return /** @type {Promise<{order: KalshiOrder}>} */ (makeRequest(keys, 'DELETE', `/trade-api/v2/portfolio/orders/${orderId}`))
}

/**
 * Get orders list
 * @param {KalshiKeys} keys - API keys
 * @param {OrdersQueryParams} [params={}] - Query parameters
 * @returns {Promise<OrdersResponse>} Orders response
 */
const getOrders = async (keys, params = {}) => {
  const query = buildQuery(params)
  return /** @type {Promise<OrdersResponse>} */ (makeRequest(keys, 'GET', `/trade-api/v2/portfolio/orders${query}`))
}

/**
 * Get fills list
 * @param {KalshiKeys} keys - API keys
 * @param {FillsQueryParams} [params={}] - Query parameters
 * @returns {Promise<FillsResponse>} Fills response
 */
const getFills = async (keys, params = {}) => {
  const query = buildQuery(params)
  return /** @type {Promise<FillsResponse>} */ (makeRequest(keys, 'GET', `/trade-api/v2/portfolio/fills${query}`))
}

/**
 * Get exchange status (no auth required)
 * @param {KalshiKeys} [keys] - Optional keys for environment
 * @returns {Promise<ExchangeStatusResponse>} Exchange status
 */
const getExchangeStatus = async (keys) => {
  const baseUrl = getBaseUrl(keys?.environment || 'demo')
  const response = await fetch(`${baseUrl}/exchange/status`)
  if (!response.ok) {
    const error = new Error(`Exchange status check failed: ${response.status}`)
    error.status = response.status
    throw error
  }
  return /** @type {Promise<ExchangeStatusResponse>} */ (response.json())
}

/**
 * Test API connection by getting balance
 * @param {KalshiKeys} keys - API keys
 * @returns {Promise<ConnectionTestResult>} Connection test result
 */
const testConnection = async (keys) => {
  if (!keys?.keyId || !keys?.privateKeyPem) {
    throw new Error('API keys not configured')
  }

  const balance = await getBalance(keys)
  return {
    success: true,
    balance: {
      available: (balance.balance || 0) / 100,
      total: ((balance.balance || 0) + (balance.payout || 0)) / 100
    }
  }
}

module.exports = {
  getBalance,
  getPositions,
  getMarkets,
  getMarket,
  getOrderbook,
  getEvents,
  getEvent,
  placeOrder,
  cancelOrder,
  getOrders,
  getFills,
  getExchangeStatus,
  testConnection
}
