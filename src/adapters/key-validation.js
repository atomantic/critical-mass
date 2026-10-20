// @ts-check
/**
 * Pure credential-shape checks shared by key-saving routes and adapters.
 * These checks only establish plausible shape; they never contact an exchange.
 */

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

module.exports = { validateCoinbaseKeys, validateStandardExchangeKeys };
