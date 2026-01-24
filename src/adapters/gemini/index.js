/**
 * Gemini Exchange Adapter
 *
 * Implements the exchange adapter interface for Gemini.
 * Uses HMAC-SHA384 authentication with REST API.
 * WebSocket Fast API available for real-time order updates.
 */

const { createGeminiAdapter } = require('./api');
const { getWebSocketAuthHeaders, getRestAuthHeaders, generateSignature } = require('./auth');

module.exports = {
  // Adapter factory
  createAdapter: createGeminiAdapter,

  // Auth utilities
  getWebSocketAuthHeaders,
  getRestAuthHeaders,
  generateSignature,
};
