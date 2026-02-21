// @ts-check
/**
 * Kalshi API key loader utility.
 * Eliminates duplicated key loading blocks in hedge-routes and kalshi-routes.
 */

const fs = require('fs');
const path = require('path');
const { KALSHI_DATA_DIR } = require('../paths');

/**
 * Load and parse Kalshi API keys from the data directory.
 * @param {string} [keysPath] - Override path (defaults to data/kalshi/keys.json)
 * @returns {{ keys: Object | null, error: string | null }}
 */
const loadKalshiKeys = (keysPath) => {
  const filepath = keysPath || path.join(KALSHI_DATA_DIR, 'keys.json');
  if (!fs.existsSync(filepath)) {
    return { keys: null, error: 'Kalshi API keys not configured (data/kalshi/keys.json)' };
  }
  const keys = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  return { keys, error: null };
};

module.exports = { loadKalshiKeys };
