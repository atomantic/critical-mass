const WebSocket = require('ws')
const { signRequest, getWsUrl } = require('./auth')
const { EventEmitter } = require('events')

/**
 * @typedef {import('../types/kalshi').KalshiKeys} KalshiKeys
 * @typedef {import('../types/kalshi').WebSocketChannel} WebSocketChannel
 * @typedef {import('../types/kalshi').WebSocketMessage} WebSocketMessage
 * @typedef {import('../types/kalshi').TickerUpdate} TickerUpdate
 * @typedef {import('../types/kalshi').TradeUpdate} TradeUpdate
 * @typedef {import('../types/kalshi').OrderbookDelta} OrderbookDelta
 * @typedef {import('../types/kalshi').FillNotification} FillNotification
 * @typedef {import('../types/kalshi').PositionUpdate} PositionUpdate
 */

/** @type {Record<string, WebSocketChannel>} */
const CHANNELS = {
  // Public channels (no auth required)
  TICKER: 'ticker',
  TICKER_V2: 'ticker_v2',
  TRADE: 'trade',
  MARKET_LIFECYCLE: 'market_lifecycle_v2',
  MULTIVARIATE: 'multivariate',

  // Private channels (auth required)
  ORDERBOOK_DELTA: 'orderbook_delta',
  FILL: 'fill',
  MARKET_POSITIONS: 'market_positions',
  COMMUNICATIONS: 'communications',
  ORDER_GROUP_UPDATES: 'order_group_updates'
}

/**
 * Create WebSocket authentication headers
 * @param {KalshiKeys} keys - API keys
 * @returns {Record<string, string>} Authentication headers
 */
const createWsAuthHeaders = (keys) => {
  const timestamp = Date.now().toString()
  const path = '/trade-api/ws/v2'
  const signature = signRequest(keys.privateKeyPem, timestamp, 'GET', path)

  return {
    'KALSHI-ACCESS-KEY': keys.keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp
  }
}

/**
 * KalshiWebSocket class manages the connection and subscriptions
 * @extends EventEmitter
 */
class KalshiWebSocket extends EventEmitter {
  /**
   * Create a new KalshiWebSocket instance
   * @param {KalshiKeys} keys - API keys for authentication
   */
  constructor(keys) {
    super()
    /** @type {KalshiKeys} */
    this.keys = keys
    /** @type {WebSocket | null} */
    this.ws = null
    /** @type {boolean} */
    this.connected = false
    /** @type {Map<WebSocketChannel, Set<string>>} */
    this.subscriptions = new Map()
    /** @type {number} */
    this.messageId = 0
    /** @type {number} */
    this.reconnectAttempts = 0
    /** @type {number} */
    this.maxReconnectAttempts = 5
    /** @type {number} */
    this.reconnectDelay = 1000
    /** @type {NodeJS.Timeout | null} */
    this.pingInterval = null
  }

  /**
   * Connect to the WebSocket server
   * @returns {void}
   */
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const wsUrl = getWsUrl(this.keys.environment)
    const headers = createWsAuthHeaders(this.keys)

    console.log(`🔌 Connecting to Kalshi WebSocket (${this.keys.environment})...`)

    this.ws = new WebSocket(wsUrl, { headers })

    this.ws.on('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      console.log('🔌 Kalshi WebSocket connected')

      // Resubscribe pending channels BEFORE emitting connected
      // so that event handlers don't duplicate subscriptions
      this.subscriptions.forEach((tickers, channel) => {
        tickers.forEach(ticker => this._subscribe(channel, ticker))
      })

      this.emit('connected')

      // Start ping interval
      this.pingInterval = setInterval(() => this.ping(), 30000)
    })

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      this._handleMessage(message)
    })

    this.ws.on('error', (err) => {
      console.log(`❌ WebSocket error: ${err.message}`)
      this.emit('error', err)
    })

    this.ws.on('close', (code, reason) => {
      this.connected = false
      if (this.pingInterval) {
        clearInterval(this.pingInterval)
        this.pingInterval = null
      }

      console.log(`🔌 WebSocket closed: ${code} ${reason}`)
      this.emit('disconnected', { code, reason: reason.toString() })

      // Attempt reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        const delay = this.reconnectDelay * this.reconnectAttempts
        console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
        setTimeout(() => this.connect(), delay)
      }
    })
  }

  /**
   * Disconnect from the WebSocket server
   * @returns {void}
   */
  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.subscriptions.clear()
  }

  /**
   * Send a ping to keep the connection alive
   * @returns {void}
   */
  ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.ping()
    }
  }

  /**
   * Send a message to the WebSocket server
   * @param {string} cmd - Command to send
   * @param {Record<string, unknown>} [params={}] - Command parameters
   * @returns {number | null} Message ID or null if not connected
   * @private
   */
  _send(cmd, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ WebSocket not connected, cannot send message')
      return null
    }

    const id = ++this.messageId
    const message = { id, cmd, params }
    this.ws.send(JSON.stringify(message))
    return id
  }

  /**
   * Subscribe to a channel for a market
   * @param {WebSocketChannel} channel - Channel to subscribe to
   * @param {string} marketTicker - Market ticker
   * @returns {number | null} Message ID or null
   * @private
   */
  _subscribe(channel, marketTicker) {
    return this._send('subscribe', {
      channels: [channel],
      market_ticker: marketTicker
    })
  }

  /**
   * Unsubscribe from a channel for a market
   * @param {WebSocketChannel} channel - Channel to unsubscribe from
   * @param {string} marketTicker - Market ticker
   * @returns {number | null} Message ID or null
   * @private
   */
  _unsubscribe(channel, marketTicker) {
    return this._send('unsubscribe', {
      channels: [channel],
      market_ticker: marketTicker
    })
  }

  /**
   * Handle incoming WebSocket message
   * @param {WebSocketMessage} message - Incoming message
   * @returns {void}
   * @private
   */
  _handleMessage(message) {
    const { type, msg, id } = message

    // Command response
    if (id && type === 'subscribed') {
      this.emit('subscribed', { id, channels: msg?.channels })
      return
    }

    if (id && type === 'unsubscribed') {
      this.emit('unsubscribed', { id, channels: msg?.channels })
      return
    }

    if (type === 'error') {
      // Suppress code 4 ("Subscription IDs required") — expected when unsubscribing without SIDs
      if (msg?.code === 4) return
      console.log(`❌ WebSocket error: ${msg?.msg || 'Unknown error'} (code: ${msg?.code})`)
      this.emit('ws_error', msg)
      return
    }

    // Data messages
    if (type === 'ticker' || type === 'ticker_v2') {
      this.emit('ticker', msg)
      return
    }

    if (type === 'trade') {
      this.emit('trade', msg)
      return
    }

    if (type === 'orderbook_delta') {
      this.emit('orderbook', msg)
      return
    }

    if (type === 'fill') {
      this.emit('fill', msg)
      return
    }

    if (type === 'market_positions') {
      this.emit('position', msg)
      return
    }

    if (type === 'market_lifecycle_v2') {
      this.emit('lifecycle', msg)
      return
    }

    // Unknown message type
    this.emit('message', message)
  }

  /**
   * Subscribe to ticker updates for a market
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  subscribeTicker(marketTicker) {
    if (!this.subscriptions.has(CHANNELS.TICKER)) {
      this.subscriptions.set(CHANNELS.TICKER, new Set())
    }
    this.subscriptions.get(CHANNELS.TICKER).add(marketTicker)

    if (this.connected) {
      return this._subscribe(CHANNELS.TICKER, marketTicker)
    }
  }

  /**
   * Subscribe to trade updates for a market
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  subscribeTrades(marketTicker) {
    if (!this.subscriptions.has(CHANNELS.TRADE)) {
      this.subscriptions.set(CHANNELS.TRADE, new Set())
    }
    this.subscriptions.get(CHANNELS.TRADE).add(marketTicker)

    if (this.connected) {
      return this._subscribe(CHANNELS.TRADE, marketTicker)
    }
  }

  /**
   * Subscribe to orderbook deltas (requires auth)
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  subscribeOrderbook(marketTicker) {
    if (!this.subscriptions.has(CHANNELS.ORDERBOOK_DELTA)) {
      this.subscriptions.set(CHANNELS.ORDERBOOK_DELTA, new Set())
    }
    this.subscriptions.get(CHANNELS.ORDERBOOK_DELTA).add(marketTicker)

    if (this.connected) {
      return this._subscribe(CHANNELS.ORDERBOOK_DELTA, marketTicker)
    }
  }

  /**
   * Subscribe to fill notifications (requires auth)
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  subscribeFills(marketTicker) {
    if (!this.subscriptions.has(CHANNELS.FILL)) {
      this.subscriptions.set(CHANNELS.FILL, new Set())
    }
    this.subscriptions.get(CHANNELS.FILL).add(marketTicker)

    if (this.connected) {
      return this._subscribe(CHANNELS.FILL, marketTicker)
    }
  }

  /**
   * Subscribe to position updates (requires auth)
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  subscribePositions(marketTicker) {
    if (!this.subscriptions.has(CHANNELS.MARKET_POSITIONS)) {
      this.subscriptions.set(CHANNELS.MARKET_POSITIONS, new Set())
    }
    this.subscriptions.get(CHANNELS.MARKET_POSITIONS).add(marketTicker)

    if (this.connected) {
      return this._subscribe(CHANNELS.MARKET_POSITIONS, marketTicker)
    }
  }

  /**
   * Unsubscribe from a channel
   * @param {WebSocketChannel} channel - Channel to unsubscribe from
   * @param {string} marketTicker - Market ticker
   * @returns {number | null | undefined} Message ID or undefined if not connected
   */
  unsubscribe(channel, marketTicker) {
    const channelSubs = this.subscriptions.get(channel)
    if (channelSubs) {
      channelSubs.delete(marketTicker)
      if (channelSubs.size === 0) {
        this.subscriptions.delete(channel)
      }
    }
    // Skip WS unsubscribe — Kalshi v2 requires subscription IDs we don't track.
    // Subscriptions are connection-scoped so local cleanup is sufficient.
  }

  /**
   * Subscribe to multiple tickers at once
   * @param {WebSocketChannel} channel - Channel to subscribe to
   * @param {string[]} marketTickers - Array of market tickers
   * @returns {void}
   */
  subscribeMany(channel, marketTickers) {
    marketTickers.forEach(ticker => {
      if (channel === CHANNELS.TICKER) this.subscribeTicker(ticker)
      else if (channel === CHANNELS.TRADE) this.subscribeTrades(ticker)
      else if (channel === CHANNELS.ORDERBOOK_DELTA) this.subscribeOrderbook(ticker)
      else if (channel === CHANNELS.FILL) this.subscribeFills(ticker)
      else if (channel === CHANNELS.MARKET_POSITIONS) this.subscribePositions(ticker)
    })
  }
}

/**
 * Create and return a KalshiWebSocket instance
 * @param {KalshiKeys} keys - API keys for authentication
 * @returns {KalshiWebSocket} New WebSocket instance
 * @throws {Error} If keys are invalid
 */
const createKalshiWebSocket = (keys) => {
  if (!keys?.keyId || !keys?.privateKeyPem) {
    throw new Error('Valid keys required for WebSocket connection')
  }
  return new KalshiWebSocket(keys)
}

module.exports = {
  KalshiWebSocket,
  createKalshiWebSocket,
  CHANNELS
}
