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
 * Stringify payload converting big integer strings to unquoted numbers
 * Gemini order IDs exceed JavaScript's MAX_SAFE_INTEGER but API expects numbers
 * @param {Object} payload - Payload object
 * @returns {string} JSON string with big integer fields as unquoted numbers
 */
const stringifyPayload = (payload) => {
  // First stringify normally, then convert string order_id back to unquoted number
  const json = JSON.stringify(payload);
  // Match "order_id":"<digits>" and convert to "order_id":<digits>
  return json.replace(/"(order_id)":\s*"(\d+)"/g, '"$1":$2');
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
let lastNonce = 0;

const getRestAuthHeaders = (apiKey, apiSecret, endpoint, requestPayload = {}) => {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  const nonce = lastNonce;
  const payload = {
    request: endpoint,
    nonce,
    ...requestPayload,
  };

  const encodedPayload = Buffer.from(stringifyPayload(payload)).toString('base64');
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
