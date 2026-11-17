/**
 * Coinbase Advanced Trade API Adapter
 *
 * Implements the exchange adapter interface for Coinbase.
 * Uses JWT ES256 authentication.
 */

const { createCoinbaseAdapter } = require('./api');

module.exports = {
  // Adapter factory
  createAdapter: createCoinbaseAdapter,
};
