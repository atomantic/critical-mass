/**
 * Crypto.com Exchange Adapter
 *
 * Implements the exchange adapter interface for Crypto.com Exchange.
 * Uses HMAC-SHA256 authentication with REST API.
 * Supports spot trading with BTC_USDT style instrument names.
 */

const { createCryptocomAdapter } = require('./api');
const { generateSignature, createAuthenticatedRequest } = require('./auth');

module.exports = {
  // Adapter factory
  createAdapter: createCryptocomAdapter,

  // Auth utilities
  generateSignature,
  createAuthenticatedRequest,
};
