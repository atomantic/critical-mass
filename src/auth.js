const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Prepare private key for JWT signing
 * @param {string} rawKey - Private key (PEM format or base64)
 * @returns {string|Buffer} Key ready for JWT signing
 */
const preparePrivateKey = (rawKey) => {
  // Check if already in PEM format
  if (rawKey.includes('-----BEGIN')) {
    return rawKey;
  }

  // New Coinbase format: The base64 string might be the hex-encoded private key
  // Try decoding as hex first, then as base64
  // The new API might use the raw key directly
  return rawKey;
};

/**
 * Generate JWT token for Coinbase Advanced Trade API authentication
 * @param {string} apiKey - Coinbase API key
 * @param {string} apiSecret - Coinbase API secret (PEM or base64 format)
 * @param {string} requestMethod - HTTP method (GET, POST, etc.)
 * @param {string} requestPath - API endpoint path
 * @returns {string} JWT token
 */
const generateJWT = (apiKey, apiSecret, requestMethod, requestPath) => {
  const algorithm = 'ES256';
  // Strip query parameters from path for JWT URI
  const pathWithoutQuery = requestPath.split('?')[0];
  const uri = `${requestMethod} api.coinbase.com${pathWithoutQuery}`;

  // Prepare the key
  const pemKey = preparePrivateKey(apiSecret);

  const token = jwt.sign(
    {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120, // 2 minutes
      sub: apiKey,
      uri,
    },
    pemKey,
    {
      algorithm,
      header: {
        kid: apiKey,
        nonce: crypto.randomBytes(16).toString('hex'),
      },
    }
  );

  return token;
};

/**
 * Get authentication headers for Coinbase API requests
 * @param {string} apiKey - Coinbase API key
 * @param {string} apiSecret - Coinbase API secret
 * @param {string} requestMethod - HTTP method (GET, POST, etc.)
 * @param {string} requestPath - API endpoint path
 * @returns {Object} Headers object with Authorization
 */
const getAuthHeaders = (apiKey, apiSecret, requestMethod, requestPath) => ({
  'Authorization': `Bearer ${generateJWT(apiKey, apiSecret, requestMethod, requestPath)}`,
  'Content-Type': 'application/json',
});

module.exports = {
  generateJWT,
  getAuthHeaders,
};
