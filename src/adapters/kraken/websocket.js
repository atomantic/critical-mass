const WebSocket = require('ws')
const { EventEmitter } = require('events')

const KRAKEN_WS_URL = 'wss://ws.kraken.com/v2'

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23)

/** Map Kraken symbols to normalized product IDs */
const normalizeSymbol = (symbol) => symbol.replace('/', '-')

/**
 * KrakenWebSocket manages the connection to Kraken public WebSocket v2 feed
 * @extends EventEmitter
 */
class KrakenWebSocket extends EventEmitter {
  constructor() {
    super()
    /** @type {WebSocket | null} */
    this.ws = null
    /** @type {boolean} */
    this.connected = false
    /** @type {Set<string>} Kraken-format symbols (e.g., 'BTC/USD') */
    this.subscriptions = new Set()
    /** @type {number} */
    this.reconnectAttempts = 0
    /** @type {number} */
    this.maxReconnectAttempts = 10
    /** @type {number} */
    this.baseReconnectDelay = 1000
    /** @type {NodeJS.Timeout | null} */
    this.pingInterval = null
    /** @type {NodeJS.Timeout | null} */
    this.reconnectTimeout = null
    /** @type {boolean} */
    this.intentionalClose = false
  }

  /**
   * Connect to the Kraken WebSocket v2 server
   */
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.intentionalClose = false
    console.log(`[${ts()}] 🦑 Connecting to Kraken WebSocket...`)

    this.ws = new WebSocket(KRAKEN_WS_URL)

    this.ws.on('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      console.log(`[${ts()}] 🦑 Kraken WebSocket connected`)

      // Resubscribe pending subscriptions BEFORE emitting connected
      // so that event handlers calling subscribe() see them already in the set
      if (this.subscriptions.size > 0) {
        this._sendSubscribe(Array.from(this.subscriptions))
      }

      this.emit('connected')

      // Start ping interval (30 seconds)
      this.pingInterval = setInterval(() => this._ping(), 30000)
    })

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      this._handleMessage(message)
    })

    this.ws.on('error', (err) => {
      console.log(`[${ts()}] ❌ Kraken WebSocket error: ${err.message}`)
      this.emit('error', err)
    })

    this.ws.on('close', (code, reason) => {
      this.connected = false
      this._clearPingInterval()

      const reasonStr = reason?.toString() || 'unknown'
      console.log(`[${ts()}] 🦑 Kraken WebSocket closed: ${code} ${reasonStr}`)
      this.emit('disconnected', { code, reason: reasonStr })

      // Attempt reconnect with exponential backoff
      if (!this.intentionalClose && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
        console.log(`[${ts()}] 🔄 Kraken reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
        this.reconnectTimeout = setTimeout(() => this.connect(), delay)
      }
    })

    this.ws.on('pong', () => {
      this.emit('pong')
    })
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect() {
    this.intentionalClose = true
    this._clearPingInterval()

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.connected = false
    this.subscriptions.clear()
    console.log(`[${ts()}] 🦑 Kraken WebSocket disconnected`)
  }

  /** @private */
  _clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /** @private */
  _ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'ping' }))
    }
  }

  /**
   * Send subscribe message to Kraken WS v2
   * Subscribes to both 'trade' (real-time trades) and 'ticker' (bid/ask/volume) channels
   * @param {string[]} symbols - Kraken symbols (e.g., ['BTC/USD'])
   * @private
   */
  _sendSubscribe(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    // Trade channel for real-time price updates on every trade
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'trade', symbol: symbols, snapshot: false }
    }))

    // Ticker channel for bid/ask spread and 24h volume
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: symbols }
    }))

    console.log(`[${ts()}] 🦑 Subscribed to trade+ticker: ${symbols.join(', ')}`)
  }

  /**
   * Send unsubscribe message to Kraken WS v2
   * @param {string[]} symbols - Kraken symbols
   * @private
   */
  _sendUnsubscribe(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(JSON.stringify({
      method: 'unsubscribe',
      params: { channel: 'trade', symbol: symbols }
    }))
    this.ws.send(JSON.stringify({
      method: 'unsubscribe',
      params: { channel: 'ticker', symbol: symbols }
    }))

    console.log(`[${ts()}] 🦑 Unsubscribed from: ${symbols.join(', ')}`)
  }

  /**
   * Handle incoming WebSocket message
   * @param {Object} message
   * @private
   */
  _handleMessage(message) {
    // Kraken v2 responses have a 'method' field for subscription confirmations
    if (message.method === 'pong') return

    if (message.method === 'subscribe' || message.method === 'unsubscribe') {
      if (!message.success) {
        console.log(`[${ts()}] ❌ Kraken ${message.method} failed: ${message.error}`)
        this.emit('ws_error', message)
      }
      return
    }

    // Trade data — fires on every individual trade (high frequency)
    if (message.channel === 'trade') {
      for (const trade of message.data) {
        const productId = normalizeSymbol(trade.symbol)
        const cachedTicker = this._tickerCache?.get(productId)
        this.emit('ticker', {
          productId,
          price: trade.price,
          bid: cachedTicker?.bid ?? trade.price,
          ask: cachedTicker?.ask ?? trade.price,
          volume24h: cachedTicker?.volume24h ?? 0,
          timestamp: trade.timestamp || new Date().toISOString(),
          source: 'kraken'
        })
      }
      return
    }

    // Ticker data — used for bid/ask spread and volume (cache it)
    if (message.channel === 'ticker') {
      if (!this._tickerCache) this._tickerCache = new Map()
      for (const tick of message.data) {
        const productId = normalizeSymbol(tick.symbol)
        this._tickerCache.set(productId, {
          bid: tick.bid,
          ask: tick.ask,
          volume24h: tick.volume
        })
        // Also emit a ticker event for the initial snapshot
        if (message.type === 'snapshot') {
          this.emit('ticker', {
            productId,
            price: tick.last,
            bid: tick.bid,
            ask: tick.ask,
            volume24h: tick.volume,
            timestamp: new Date().toISOString(),
            source: 'kraken'
          })
        }
      }
      return
    }

    // Heartbeat or other messages
    if (message.channel === 'heartbeat') return

    this.emit('message', message)
  }

  /**
   * Subscribe to ticker updates for symbol(s)
   * Accepts either Kraken format ('BTC/USD') or normalized ('BTC-USD')
   * @param {string | string[]} symbols
   */
  subscribe(symbols) {
    const ids = Array.isArray(symbols) ? symbols : [symbols]
    // Normalize to Kraken format: BTC-USD -> BTC/USD
    const krakenSymbols = ids.map(s => s.replace('-', '/'))
    const newSymbols = krakenSymbols.filter(s => !this.subscriptions.has(s))

    newSymbols.forEach(s => this.subscriptions.add(s))

    if (this.connected && newSymbols.length > 0) {
      this._sendSubscribe(newSymbols)
    }
  }

  /**
   * Unsubscribe from ticker updates for symbol(s)
   * @param {string | string[]} symbols
   */
  unsubscribe(symbols) {
    const ids = Array.isArray(symbols) ? symbols : [symbols]
    const krakenSymbols = ids.map(s => s.replace('-', '/'))
    const existingSymbols = krakenSymbols.filter(s => this.subscriptions.has(s))

    existingSymbols.forEach(s => this.subscriptions.delete(s))

    if (this.connected && existingSymbols.length > 0) {
      this._sendUnsubscribe(existingSymbols)
    }
  }

  /**
   * Get connection status
   * @returns {{ connected: boolean, subscriptions: string[], reconnectAttempts: number }}
   */
  getStatus() {
    return {
      connected: this.connected,
      subscriptions: Array.from(this.subscriptions),
      reconnectAttempts: this.reconnectAttempts
    }
  }
}

const createKrakenWebSocket = () => new KrakenWebSocket()

module.exports = { KrakenWebSocket, createKrakenWebSocket }
