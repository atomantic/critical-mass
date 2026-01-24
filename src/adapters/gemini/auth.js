const crypto = require('crypto');

/**
 * Generate HMAC-SHA384 signature for Gemini API
 * @param {string} payload - Base64 encoded payload
 * @param {string} secret - API secret
 * @returns {string} Hex-encoded signature
 */
const generateSignature = (payload, secret) => {
  return crypto
    .createHmac('sha384', secret)
    .update(payload)
    .digest('hex');
};

/**
 * Get WebSocket authentication headers for Gemini Fast API
 * Authentication is done during WebSocket handshake only
 * @param {string} apiKey - Gemini API key
 * @param {string} apiSecret - Gemini API secret
 * @returns {Object} Headers for WebSocket connection
 */
const getWebSocketAuthHeaders = (apiKey, apiSecret) => {
  const nonce = Math.floor(Date.now() / 1000).toString();
  const payload = Buffer.from(nonce).toString('base64');
  const signature = generateSignature(payload, apiSecret);

  return {
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-NONCE': nonce,
    'X-GEMINI-PAYLOAD': payload,
    'X-GEMINI-SIGNATURE': signature,
  };
};

/**
 * Get REST API authentication headers for Gemini
 * Used for endpoints not available via WebSocket
 * @param {string} apiKey - Gemini API key
 * @param {string} apiSecret - Gemini API secret
 * @param {string} endpoint - API endpoint path
 * @param {Object} requestPayload - Request payload object
 * @returns {Object} Headers for REST API request
 */
const getRestAuthHeaders = (apiKey, apiSecret, endpoint, requestPayload = {}) => {
  const nonce = Date.now();
  const payload = {
    request: endpoint,
    nonce,
    ...requestPayload,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = generateSignature(encodedPayload, apiSecret);

  return {
    'Content-Type': 'text/plain',
    'Content-Length': '0',
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-PAYLOAD': encodedPayload,
    'X-GEMINI-SIGNATURE': signature,
    'Cache-Control': 'no-cache',
  };
};

module.exports = {
  generateSignature,
  getWebSocketAuthHeaders,
  getRestAuthHeaders,
};
