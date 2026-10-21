// @ts-check
/**
 * Pure credential-shape checks shared by key-saving routes and adapters.
 * These checks only establish plausible shape; they never contact an exchange.
 */

const fs = require('fs');

const validateCoinbaseKeys = (keys) => {
  const apiKey = keys?.name || keys?.apiKey;
  const apiSecret = keys?.privateKey || keys?.apiSecret;
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string') return false;
  if (apiKey.length < 10) return false;
  return apiSecret.includes('-----BEGIN') || apiSecret.length >= 50;
};

const validateStandardExchangeKeys = (keys) => {
  const apiKey = keys?.apiKey || keys?.key;
  const apiSecret = keys?.apiSecret || keys?.secret;
  return typeof apiKey === 'string' && typeof apiSecret === 'string' &&
    apiKey.length >= 10 && apiSecret.length >= 10;
};

/**
 * Build the `hasValidKeys` / `loadCredentials` pair for an adapter that reads
 * a single keys file. Only ever consults `keysPath` (no legacy fallback; see
 * issue #688 in the Coinbase adapter).
 * @param {object} opts
 * @param {string} opts.keysPath - Keys file to read
 * @param {string} opts.label - Exchange display name used in error messages
 * @param {(keys: any) => boolean} opts.validate - Shape check for hasValidKeys
 * @param {(keys: any) => {apiKey: string, apiSecret: string}} opts.pick - Maps the file's fields to credentials (may return falsy fields)
 * @param {string} opts.requiredMessage - Error message when pick yields a missing credential
 */
const createKeyFileLoader = ({ keysPath, label, validate, pick, requiredMessage }) => {
  const readKeys = () => JSON.parse(fs.readFileSync(keysPath, 'utf8'));

  const hasValidKeys = () => {
    if (!fs.existsSync(keysPath)) return false;
    try {
      return validate(readKeys());
    } catch {
      return false;
    }
  };

  const loadCredentials = () => {
    if (!fs.existsSync(keysPath)) {
      throw new Error(`API keys not configured. Please add your ${label} API keys.`);
    }

    let keys;
    try {
      keys = readKeys();
    } catch {
      throw new Error('Failed to parse API keys file: corrupted or invalid JSON');
    }
    const { apiKey, apiSecret } = pick(keys);

    if (!apiKey || !apiSecret) {
      throw new Error(requiredMessage);
    }

    return { apiKey, apiSecret };
  };

  return { hasValidKeys, loadCredentials };
};

module.exports = { validateCoinbaseKeys, validateStandardExchangeKeys, createKeyFileLoader };
