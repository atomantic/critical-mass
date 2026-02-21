const crypto = require('crypto')

/**
 * @typedef {import('../types/kalshi').KalshiEnvironment} KalshiEnvironment
 * @typedef {import('../types/kalshi').KalshiKeys} KalshiKeys
 * @typedef {import('../types/kalshi').KeyValidationResult} KeyValidationResult
 */

/** @type {string} */
const DEMO_BASE_URL = 'https://demo-api.kalshi.com'
/** @type {string} */
const PROD_BASE_URL = 'https://api.elections.kalshi.com'

/** @type {string} */
const DEMO_WS_URL = 'wss://demo-api.kalshi.com/trade-api/ws/v2'
/** @type {string} */
const PROD_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2'

/**
 * Get the base URL based on environment
 * @param {KalshiEnvironment} [env='demo'] - API environment
 * @returns {string} Base URL for the environment
 */
const getBaseUrl = (env = 'demo') =>
  env === 'prod' ? PROD_BASE_URL : DEMO_BASE_URL

/**
 * Get WebSocket URL based on environment
 * @param {KalshiEnvironment} [env='demo'] - API environment
 * @returns {string} WebSocket URL for the environment
 */
const getWsUrl = (env = 'demo') =>
  env === 'prod' ? PROD_WS_URL : DEMO_WS_URL

/**
 * Create RSA-PSS signature for Kalshi API requests
 * @param {string} privateKeyPem - Private key in PEM format
 * @param {string} timestamp - Request timestamp
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {string} Base64-encoded signature
 */
const signRequest = (privateKeyPem, timestamp, method, path) => {
  // Strip query parameters from path for signing
  const pathWithoutQuery = path.split('?')[0]
  const message = `${timestamp}${method}${pathWithoutQuery}`

  const privateKey = crypto.createPrivateKey({
    key: privateKeyPem,
    format: 'pem'
  })

  const signature = crypto.sign(
    'sha256',
    Buffer.from(message),
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }
  )

  return signature.toString('base64')
}

/**
 * Create authentication headers for a Kalshi API request
 * @param {KalshiKeys} keys - API keys configuration
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {Record<string, string> | null} Headers object or null if keys invalid
 */
const createAuthHeaders = (keys, method, path) => {
  const { keyId, privateKeyPem } = keys

  if (!keyId || !privateKeyPem) {
    return null
  }

  const timestamp = Date.now().toString()
  const signature = signRequest(privateKeyPem, timestamp, method, path)

  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json'
  }
}

/**
 * Validate that keys are properly formatted
 * @param {Partial<KalshiKeys>} keys - Keys to validate
 * @returns {KeyValidationResult} Validation result with errors array
 */
const validateKeys = (keys) => {
  const errors = []

  if (!keys.keyId || typeof keys.keyId !== 'string' || keys.keyId.trim() === '') {
    errors.push('Key ID is required')
  }

  if (!keys.privateKeyPem || typeof keys.privateKeyPem !== 'string') {
    errors.push('Private key PEM is required')
  } else if (!keys.privateKeyPem.includes('-----BEGIN') || !keys.privateKeyPem.includes('PRIVATE KEY-----')) {
    errors.push('Private key must be in PEM format')
  }

  return { valid: errors.length === 0, errors }
}

module.exports = {
  getBaseUrl,
  getWsUrl,
  signRequest,
  createAuthHeaders,
  validateKeys
}
