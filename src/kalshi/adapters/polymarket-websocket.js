/**
 * Polymarket WebSocket adapter
 * Connects to the public CLOB market channel for real-time price updates.
 * No authentication required for the market channel.
 */

const WebSocket = require('ws')
const { EventEmitter } = require('events')

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23)

/**
 * PolymarketWebSocket manages the connection and subscriptions
 * @extends EventEmitter
 *
 * Events emitted:
 *  - 'connected'
 *  - 'disconnected' { code, reason }
 *  - 'price_change' { market, asset_id, price }
 *  - 'book' { market, asset_id, bids, asks, timestamp }
 *  - 'trade' { market, asset_id, price, size, ... }
 *  - 'error' Error
 */
class PolymarketWebSocket extends EventEmitter {
  constructor() {
    super()
    /** @type {WebSocket | null} */
    this.ws = null
    /** @type {boolean} */
    this.connected = false
    /** @type {Set<string>} Subscribed asset (token) IDs */
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

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.intentionalClose = false
    console.log(`[${ts()}] 🟣 Connecting to Polymarket WebSocket...`)

    this.ws = new WebSocket(WS_URL)

    this.ws.on('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      console.log(`[${ts()}] 🟣 Polymarket WebSocket connected`)

      // Resubscribe pending assets BEFORE emitting connected
      // so that event handlers calling subscribe() see them already in the set
      if (this.subscriptions.size > 0) {
        this._sendSubscribe(Array.from(this.subscriptions))
      }

      this.emit('connected')

      // Keepalive ping every 30s
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
      }, 30000)
    })

    this.ws.on('message', (data) => {
      const raw = data.toString()
      // Polymarket may send non-JSON messages (e.g., "INVALID OPERATION")
      if (!raw.startsWith('{') && !raw.startsWith('[')) return
      const msg = JSON.parse(raw)
      this._handleMessage(msg)
    })

    this.ws.on('error', (err) => {
      console.log(`[${ts()}] ❌ Polymarket WS error: ${err.message}`)
      this.emit('error', err)
    })

    this.ws.on('close', (code, reason) => {
      this.connected = false
      this._clearPingInterval()

      const reasonStr = reason?.toString() || 'unknown'
      console.log(`[${ts()}] 🟣 Polymarket WS closed: ${code} ${reasonStr}`)
      this.emit('disconnected', { code, reason: reasonStr })

      if (!this.intentionalClose && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
        console.log(`[${ts()}] 🔄 Polymarket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
        this.reconnectTimeout = setTimeout(() => this.connect(), delay)
      }
    })
  }

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
    console.log(`[${ts()}] 🟣 Polymarket WebSocket disconnected`)
  }

  /** @private */
  _clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * Subscribe to market data for asset IDs (token IDs)
   * @param {string[]} assetIds
   */
  subscribe(assetIds) {
    const newIds = assetIds.filter(id => !this.subscriptions.has(id))
    for (const id of newIds) this.subscriptions.add(id)
    if (this.connected && newIds.length > 0) this._sendSubscribe(newIds)
  }

  /**
   * Unsubscribe from asset IDs
   * @param {string[]} assetIds
   */
  unsubscribe(assetIds) {
    for (const id of assetIds) this.subscriptions.delete(id)
    if (this.connected) this._sendUnsubscribe(assetIds)
  }

  /** @private */
  _sendSubscribe(assetIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      assets_ids: assetIds,
      type: 'market'
    }))
  }

  /** @private */
  _sendUnsubscribe(assetIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      assets_ids: assetIds,
      type: 'market',
      action: 'unsubscribe'
    }))
  }

  /**
   * Handle incoming message — classify and emit typed events
   * @param {Object} msg
   * @private
   */
  _handleMessage(msg) {
    // Price change events: { market, price_changes: [{ asset_id, price }] }
    if (msg.price_changes) {
      for (const pc of msg.price_changes) {
        this.emit('price_change', {
          market: msg.market,
          asset_id: pc.asset_id,
          price: parseFloat(pc.price)
        })
      }
      return
    }

    // Book snapshot: { market, asset_id, bids, asks, timestamp, hash }
    if (msg.bids && msg.asks) {
      this.emit('book', {
        market: msg.market,
        asset_id: msg.asset_id,
        bids: msg.bids,
        asks: msg.asks,
        timestamp: msg.timestamp
      })
      return
    }

    // Trade: { market, asset_id, price, size, ... }
    if (msg.price && msg.size && msg.asset_id) {
      this.emit('trade', {
        market: msg.market,
        asset_id: msg.asset_id,
        price: parseFloat(msg.price),
        size: parseFloat(msg.size)
      })
      return
    }

    // Other / unknown
    this.emit('message', msg)
  }

  getStatus() {
    return {
      connected: this.connected,
      subscriptions: Array.from(this.subscriptions),
      reconnectAttempts: this.reconnectAttempts
    }
  }
}

const createPolymarketWebSocket = () => new PolymarketWebSocket()

module.exports = { PolymarketWebSocket, createPolymarketWebSocket }
