/**
 * Base Strategy Interface
 * All strategies must implement this interface
 */

/**
 * @typedef {Object} StrategyParams
 * @property {boolean} enabled
 * @property {Object} params - Strategy-specific parameters
 */

/**
 * @typedef {Object} PriceData
 * @property {string} ticker
 * @property {number} yesBid
 * @property {number} yesAsk
 * @property {number} lastPrice
 * @property {number} volume
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Signal
 * @property {string} ticker
 * @property {'yes' | 'no'} side
 * @property {'buy' | 'sell'} action
 * @property {number} count
 * @property {number} [price] - Limit price, omit for market order
 * @property {string} reason
 * @property {number} confidence - 0-1
 */

/**
 * @typedef {Object} StrategyContext
 * @property {Map<string, PriceData>} prices - Current Kalshi prices by ticker
 * @property {Map<string, Array<PriceData>>} priceHistory - Kalshi price history by ticker
 * @property {Map<string, number>} coinbasePrices - Current Coinbase spot prices by ticker (e.g., 'BTC-USD')
 * @property {Map<string, Array<{price: number, bid: number, ask: number, timestamp: number}>>} coinbasePriceHistory - Coinbase price history
 * @property {Array<Object>} positions - Current positions
 * @property {{ available: number, inPositions: number }} balance
 * @property {Object} config - Strategy config
 * @property {{ type: string|null, score: number, confidence: number, trendBias: string|null, stale: boolean, running: boolean, lastPrice: number|null, fetchedAt: number }} [updownSignal] - UpDown directional signal
 */

/**
 * Base strategy class - extend this for all strategies
 */
class BaseStrategy {
  /**
   * @param {string} name - Strategy identifier
   * @param {StrategyParams} config
   */
  constructor(name, config) {
    this.name = name
    this.config = config
    this.enabled = config?.enabled || false
    this.params = config?.params || {}
    /** @type {Array<Object>} Diagnostic entries populated during evaluate() */
    this.diagnostics = []
  }

  /**
   * Evaluate market conditions and return trading signals
   * @param {StrategyContext} context
   * @returns {Signal[]}
   */
  evaluate(context) {
    throw new Error('evaluate() must be implemented')
  }

  /**
   * Check if strategy should evaluate a specific market
   * @param {Object} market
   * @returns {boolean}
   */
  shouldEvaluate(market) {
    return this.enabled
  }

  /**
   * Get default parameters for this strategy
   * @returns {Object}
   */
  getDefaultParams() {
    return {}
  }

  /**
   * Validate parameters
   * @param {Object} params
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateParams(params) {
    return { valid: true, errors: [] }
  }

  /**
   * Update configuration
   * @param {StrategyParams} config
   */
  updateConfig(config) {
    this.config = config
    this.enabled = config?.enabled || false
    this.params = config?.params || this.params
  }

  /**
   * Calculate position size based on confidence, balance, and risk limits
   * High confidence = aggressive sizing (up to maxBetPct of bankroll)
   * @param {number} confidence - 0-1
   * @param {{ available: number }} balance
   * @param {Object} riskLimits
   * @param {number} [entryPriceCents] - Actual entry price in cents (used for accurate dollar conversion)
   * @returns {number}
   */
  calculatePositionSize(confidence, balance, riskLimits = {}, entryPriceCents) {
    const maxContracts = riskLimits?.maxPositionContracts || 500
    const baseSize = this.params?.positionSize || 10
    const maxBetPct = this.params?.maxBetPct || 0.10

    // Ensure confidence is valid (0-1)
    const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5

    // Use actual entry price for dollar conversion; fall back to 50¢ only if unknown
    const pricePerContract = (entryPriceCents > 0 ? entryPriceCents : 50) / 100

    // Scale aggressively with confidence: low confidence = base, high = bankroll %
    const bankroll = balance?.available || 0
    const dollarBet = Math.min(bankroll * maxBetPct * safeConfidence, bankroll * maxBetPct)
    const fromBankroll = Math.floor(dollarBet / pricePerContract)

    // Take the larger of base scaling or bankroll-based sizing
    const scaledSize = Math.max(Math.round(baseSize * safeConfidence), fromBankroll)

    // Apply limits, ensure at least 1 contract
    const result = Math.min(Math.max(1, scaledSize), maxContracts)
    return Number.isFinite(result) ? result : 1
  }

  /**
   * Log strategy activity
   * @param {string} message
   * @param {Object} [data]
   */
  log(message, data = {}) {
    const ts = new Date().toISOString().split('T')[1].slice(0, 12)
    const dataStr = Object.keys(data).length ? ` | ${JSON.stringify(data)}` : ''
    console.log(`[${ts}] [${this.name}] ${message}${dataStr}`)
  }
}

module.exports = BaseStrategy
