/**
 * Fund data-directory resolution.
 *
 * Where a fund's files live under data/<exchange>/<pair>/, plus the scoped
 * per-fund redirection used by the DCA import transaction. Extracted from
 * migration.js (issue #1973) so the ~25 modules that only need a path do not
 * import the one-shot migration code.
 *
 * **Test seam — do not break.** Tests redirect the data directory by
 * patching `fundPaths.getExchangeDataDir` (about 124 sites), which only works
 * because every internal call below goes through `module.exports.<fn>`
 * rather than the local binding. Keep that indirection when editing this file:
 * a direct call would silently stop honouring the patch and a test would read
 * or write the real data/ tree. tests/fund-paths.test.js guards it.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

/**
 * Get data directory for an exchange (exchange-level files only).
 * Use getFundDataDir(exchange, pair) for per-fund files.
 *
 * @param {string} exchange - Exchange name
 * @returns {string} Path to exchange data directory
 */
const getExchangeDataDir = (exchange) => {
  // NOTE: this mkdirs the exchange directory on every call, even for callers
  // that only want a path (resolveFundDataDir below is documented as
  // non-creating but reaches it). Kept as-is when this code moved out of
  // migration.js (issue #1973); changing who creates directories is a
  // separate piece of work.
  const dir = path.join(DATA_DIR, exchange);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** @type {Map<string, string>} fund key -> redirected data dir (see withFundDataDirOverride) */
const fundDataDirOverrides = new Map();
const fundOverrideKey = (exchange, pair) => `${exchange}\u0000${pair}`;

/**
 * Resolve the per-fund data directory PATH for (exchange, pair) WITHOUT
 * creating it. Use this on read paths (loadState, loadRegimeState, etc.)
 * so we never accidentally create empty subdirectories that subsequent
 * reads then mistake for "no data". Use getFundDataDir for write paths.
 *
 * If `pair` is omitted, falls back to the exchange's default pair via
 * config-utils.getDefaultPair.
 *
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {string}
 */
const resolveFundDataDir = (exchange, pair) => {
  let resolvedPair = pair;
  if (!resolvedPair) {
    // Lazy on purpose: config-utils → logger → fund-paths, so a top-level
    // require here would be a circular import (partial export).
    const configUtils = require('./config-utils');
    resolvedPair = configUtils.getDefaultPair(exchange) || 'default';
  }
  // Resolve the exchange dir via module.exports so tests that patch
  // fundPaths.getExchangeDataDir continue to work. The parent dir gets mkdir'd as
  // a side effect, which is harmless: any non-empty install already has
  // the exchange dir, and the test mock points it at a tmp dir anyway.
  // Crucially, we do NOT mkdir the per-fund subdirectory here — that would
  // turn read-side path resolution into directory creation, which is what
  // caused empty BTC-USDC dirs to appear and mask legacy state.
  const override = fundDataDirOverrides.get(fundOverrideKey(exchange, resolvedPair));
  if (override) return override;
  return module.exports.resolveFundPath(module.exports.getExchangeDataDir(exchange), resolvedPair);
};

/**
 * Scoped, synchronous redirection of ONE fund's data directory (issue #860).
 *
 * The DCA import transaction (src/dca-conversion-transaction.js) runs the
 * converter's ordinary load/save code against a private staging copy of the
 * fund's files, so the complete target generation (ledger, regime position,
 * consumed DCA source state) exists and is validated before any live file is
 * replaced. Every per-fund path in state-tracker / fill-ledger resolves through
 * resolveFundDataDir / getFundDataDir, so redirecting here covers them all.
 *
 * The callback must be synchronous: an async callback would let unrelated
 * work for this fund run while the redirection is active.
 *
 * @template T
 * @param {string} exchange
 * @param {string} pair - Resolved fund pair
 * @param {string} dir - Directory to use for the fund's files
 * @param {() => T} fn
 * @returns {T}
 */
const withFundDataDirOverride = (exchange, pair, dir, fn) => {
  const key = fundOverrideKey(exchange, pair);
  if (fundDataDirOverrides.has(key)) {
    throw new Error(`Fund data directory for ${exchange}/${pair} is already redirected`);
  }
  fundDataDirOverrides.set(key, dir);
  try {
    const result = fn();
    if (result && typeof (/** @type {any} */ (result)).then === 'function') {
      throw new Error('withFundDataDirOverride callback must be synchronous');
    }
    return result;
  } finally {
    fundDataDirOverrides.delete(key);
  }
};

/**
 * Resolve a fund path without allowing a pair to escape its exchange directory.
 * This is a defense-in-depth boundary for direct callers outside the gateway.
 *
 * @param {string} exchangeDir
 * @param {unknown} pair
 * @returns {string}
 */
const resolveFundPath = (exchangeDir, pair) => {
  if (typeof pair !== 'string' || pair.length === 0) {
    throw new Error('Fund pair must be a non-empty string');
  }
  const baseDir = path.resolve(exchangeDir);
  const candidate = path.resolve(baseDir, pair);
  const relative = path.relative(baseDir, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Fund path escapes exchange data directory: ${pair}`);
  }
  return candidate;
};

/**
 * Get the per-fund data directory for (exchange, pair). Each fund has its
 * own subdirectory under the exchange so multiple funds can coexist with
 * independent state, fill ledgers, and price caches.
 *
 * **Side effect: creates the directory tree on disk.** Use this only on
 * WRITE paths. For read-only path resolution, use resolveFundDataDir.
 *
 * If `pair` is omitted, falls back to the exchange's default pair via
 * config-utils.getDefaultPair (preserves backwards compat for callers that
 * haven't been updated yet).
 *
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name (e.g. 'BTC-USDC'); defaults to the exchange's default pair
 * @returns {string} Path to fund data directory
 */
const getFundDataDir = (exchange, pair) => {
  // Resolve the exchange dir via module.exports so existing tests that patch
  // fundPaths.getExchangeDataDir continue to work without also patching getFundDataDir.
  const exchangeDir = module.exports.getExchangeDataDir(exchange);
  let resolvedPair = pair;
  if (!resolvedPair) {
    const configUtils = require('./config-utils');
    resolvedPair = configUtils.getDefaultPair(exchange) || 'default';
  }
  const dir = fundDataDirOverrides.get(fundOverrideKey(exchange, resolvedPair))
    || module.exports.resolveFundPath(exchangeDir, resolvedPair);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Per-fund file names. These files live under data/<exchange>/<pair>/ in the
 * multi-pair layout. The legacy layout had them at data/<exchange>/.
 */
const PER_FUND_FILES = [
  'state.json',
  'regime-state.json',
  'fill-ledger.json',
  'transactions.tsv',
  'chart-data-buffer.json',
  'optimizer-cache.json',
  'pending-corrective-buys.json',
  'regime-engine-running.json',
  'dry-run-state.json',
  'closed-trades.json',
  'manual-trades.json',
  'placement-intents.json',
];

/**
 * Get keys file path for an exchange
 * @param {string} exchange - Exchange name
 * @returns {string} Path to exchange keys file
 */
const getExchangeKeysPath = (exchange) => {
  // Keys are stored alongside data.
  return path.join(DATA_DIR, `${exchange}-keys.json`);
};

module.exports = {
  getExchangeDataDir,
  resolveFundDataDir,
  getFundDataDir,
  resolveFundPath,
  withFundDataDirOverride,
  PER_FUND_FILES,
  getExchangeKeysPath,
};
