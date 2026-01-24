/**
 * Auth Module - Backward Compatibility Shim
 *
 * This module provides backward compatibility with the original auth module.
 * It exports the Coinbase auth functions directly for existing code.
 *
 * For new code, use the adapter pattern:
 *   const { getAdapter } = require('./adapters');
 *   const adapter = getAdapter('coinbase');
 */

const { getAuthHeaders, generateJWT } = require('./adapters/coinbase/auth');

module.exports = {
  getAuthHeaders,
  generateJWT,
};
