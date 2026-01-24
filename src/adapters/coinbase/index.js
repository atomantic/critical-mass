/**
 * Coinbase Advanced Trade API Adapter
 *
 * Implements the exchange adapter interface for Coinbase.
 * Uses JWT ES256 authentication.
 */

const { createCoinbaseAdapter, ...legacyExports } = require('./api');
const { getAuthHeaders, generateJWT } = require('./auth');

module.exports = {
  // Adapter factory
  createAdapter: createCoinbaseAdapter,

  // Auth utilities (for backtest engine compatibility)
  getAuthHeaders,
  generateJWT,

  // Legacy exports for backward compatibility
  ...legacyExports,
};
