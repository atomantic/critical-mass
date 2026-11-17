// @ts-check
/**
 * Bind fund-data resolution to a disposable root for integration tests.
 *
 * The production migration module resolves every per-fund path through
 * getExchangeDataDir. Replacing that exported seam keeps engine, ledger, and
 * closed-trade fixtures out of the checkout's real data/ tree without making
 * the production modules test-aware.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const fundPaths = require('../src/fund-paths');

/**
 * @param {string} prefix
 * @returns {{root: string, fundDir: (exchange: string, pair: string) => string, restore: () => void, cleanup: () => void}}
 */
const createIsolatedDataDir = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const originalGetExchangeDataDir = fundPaths.getExchangeDataDir;
  let restored = false;

  fundPaths.getExchangeDataDir = (exchange) => {
    const exchangeDir = path.join(root, exchange);
    fs.mkdirSync(exchangeDir, { recursive: true });
    return exchangeDir;
  };

  const restore = () => {
    if (restored) return;
    fundPaths.getExchangeDataDir = originalGetExchangeDataDir;
    restored = true;
  };

  const cleanup = () => {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    fundDir: (exchange, pair) => path.join(root, exchange, pair),
    restore,
    cleanup,
  };
};

module.exports = { createIsolatedDataDir };
