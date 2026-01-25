/**
 * Exchange Adapter Registry
 *
 * Factory for creating and managing exchange adapters.
 * Supports Coinbase and Gemini exchanges.
 */

const { validateAdapter } = require('./base-adapter');

// Adapter modules (lazy loaded to avoid circular dependencies)
const adapters = {
  coinbase: null,
  gemini: null,
  cryptocom: null,
};

/**
 * Load adapter module
 * @param {string} exchange - Exchange name
 * @returns {Object} Adapter module
 */
const loadAdapterModule = (exchange) => {
  const normalized = exchange.toLowerCase();

  if (!adapters[normalized]) {
    switch (normalized) {
      case 'coinbase':
        adapters.coinbase = require('./coinbase');
        break;
      case 'gemini':
        adapters.gemini = require('./gemini');
        break;
      case 'cryptocom':
        adapters.cryptocom = require('./cryptocom');
        break;
      default:
        throw new Error(`Unknown exchange: ${exchange}. Supported: coinbase, gemini, cryptocom`);
    }
  }

  return adapters[normalized];
};

/**
 * Create an exchange adapter instance
 * @param {string} exchange - Exchange name ('coinbase' or 'gemini')
 * @param {Object} options - Adapter options (keysPath, etc.)
 * @returns {Object} Exchange adapter instance
 */
const createAdapter = (exchange, options = {}) => {
  const module = loadAdapterModule(exchange);
  const adapter = module.createAdapter(options.keysPath);

  // Validate adapter implements all required methods
  validateAdapter(adapter, exchange);

  return adapter;
};

/**
 * Get list of supported exchanges
 * @returns {Array<string>} List of exchange names
 */
const getSupportedExchanges = () => ['coinbase', 'gemini', 'cryptocom'];

/**
 * Check if an exchange is supported
 * @param {string} exchange - Exchange name
 * @returns {boolean}
 */
const isSupported = (exchange) =>
  getSupportedExchanges().includes(exchange.toLowerCase());

/**
 * Cache of adapter instances by exchange name
 */
const adapterCache = new Map();

/**
 * Get or create a cached adapter instance
 * @param {string} exchange - Exchange name
 * @param {Object} options - Adapter options
 * @returns {Object} Exchange adapter instance
 */
const getAdapter = (exchange, options = {}) => {
  const normalized = exchange.toLowerCase();
  const cacheKey = `${normalized}:${options.keysPath || 'default'}`;

  if (!adapterCache.has(cacheKey)) {
    adapterCache.set(cacheKey, createAdapter(normalized, options));
  }

  return adapterCache.get(cacheKey);
};

/**
 * Clear adapter cache (useful for testing or config changes)
 */
const clearAdapterCache = () => {
  adapterCache.clear();
};

module.exports = {
  createAdapter,
  getAdapter,
  getSupportedExchanges,
  isSupported,
  clearAdapterCache,
};
