const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Prepare private key for JWT signing
 * Normalizes PEM format to ensure proper structure for ES256
 * @param {string} rawKey - Private key (PEM format or base64)
 * @returns {string} Key ready for JWT signing
 */
const preparePrivateKey = (rawKey) => {
  // If not PEM format, return as-is (will fail with descriptive error)
  if (!rawKey.includes('-----BEGIN')) {
    return rawKey;
  }

  // Normalize PEM format - extract header, content, and footer
  const pemMatch = rawKey.match(/(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)/s);
  if (!pemMatch) {
    return rawKey;
  }

  const [, header, content, footer] = pemMatch;

  // Clean the content: remove all whitespace/newlines, then format properly
  const cleanContent = content.replace(/[\s\n\r]/g, '');

  // Split into 64-character lines (standard PEM line length)
  const lines = [];
  for (let i = 0; i < cleanContent.length; i += 64) {
    lines.push(cleanContent.substring(i, i + 64));
  }

  // Reconstruct proper PEM format
  return `${header}\n${lines.join('\n')}\n${footer}\n`;
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
