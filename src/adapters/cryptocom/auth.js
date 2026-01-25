const crypto = require('crypto');

/**
 * Sort object keys alphabetically (recursive up to 3 levels)
 * @param {any} obj - Object to sort
 * @param {number} [depth=0] - Current recursion depth
 * @returns {any} Sorted object or original value
 */
const sortParams = (obj, depth = 0) => {
  if (depth > 3 || obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sortParams(item, depth + 1));
  }

  const sorted = {};
  Object.keys(obj).sort().forEach(key => {
    sorted[key] = sortParams(obj[key], depth + 1);
  });
  return sorted;
};

/**
 * Build parameter string for signature (key + value concatenated)
 * @param {any} obj - Object to stringify
 * @param {number} [depth=0] - Current recursion depth
 * @returns {string} Parameter string
 */
const buildParamString = (obj, depth = 0) => {
  if (depth > 3 || obj === null || typeof obj !== 'object') {
    // Strip trailing zeros for decimals as per Crypto.com spec
    if (typeof obj === 'number') {
      return obj.toString().replace(/\.?0+$/, '');
    }
    return String(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => buildParamString(item, depth + 1)).join('');
  }

  const sorted = sortParams(obj, depth);
  return Object.keys(sorted)
    .map(key => key + buildParamString(sorted[key], depth + 1))
    .join('');
};

/**
 * Generate HMAC-SHA256 signature for Crypto.com Exchange API
 * @param {string} method - API method (e.g., 'private/create-order')
 * @param {number} id - Request ID
 * @param {string} apiKey - API key
 * @param {Object} params - Request parameters
 * @param {number} nonce - Request nonce (timestamp in ms)
 * @param {string} secret - API secret
 * @returns {string} Hex-encoded signature
 */
const generateSignature = (method, id, apiKey, params, nonce, secret) => {
  // Build parameter string from sorted params
  const paramString = buildParamString(params);

  // Construct signing payload: method + id + api_key + params_string + nonce
  const sigPayload = method + id + apiKey + paramString + nonce;

  // Generate HMAC-SHA256 signature
  return crypto
    .createHmac('sha256', secret)
    .update(sigPayload)
    .digest('hex');
};

/**
 * Create authenticated request body for Crypto.com API
 * @param {string} method - API method
 * @param {Object} params - Request parameters
 * @param {string} apiKey - API key
 * @param {string} apiSecret - API secret
 * @returns {Object} Complete request body with authentication
 */
const createAuthenticatedRequest = (method, params, apiKey, apiSecret) => {
  const id = Date.now();
  const nonce = Date.now();

  const sig = generateSignature(method, id, apiKey, params, nonce, apiSecret);

  return {
    id,
    method,
    params,
    nonce,
    api_key: apiKey,
    sig,
  };
};

module.exports = {
  generateSignature,
  createAuthenticatedRequest,
  sortParams,
  buildParamString,
};
