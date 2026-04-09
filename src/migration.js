/**
 * Data Migration Script
 *
 * Migrates existing data from flat structure to exchange-namespaced directories.
 * This runs automatically on startup if old structure is detected.
 *
 * Before:
 *   data/state.json
 *   data/transactions.tsv
 *   data/btc-price-cache-*.json
 *   keys.json
 *
 * After:
 *   data/coinbase/state.json
 *   data/coinbase/transactions.tsv
 *   data/coinbase/btc-price-cache-*.json
 *   data/*.backup (originals)
 *   keys/coinbase.json
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const KEYS_DIR = DATA_DIR; // Keys stored alongside data

/**
 * Check if migration is needed
 * @returns {boolean} True if old structure exists and needs migration
 */
const needsMigration = () => {
  const oldStateFile = path.join(DATA_DIR, 'state.json');
  const newStateFile = path.join(DATA_DIR, 'coinbase', 'state.json');

  // Migration needed if old state exists but new doesn't
  return fs.existsSync(oldStateFile) && !fs.existsSync(newStateFile);
};

/**
 * Check if keys migration is needed
 * @returns {boolean} True if old keys.json exists
 */
const needsKeysMigration = () => {
  const oldKeysFile = path.join(__dirname, '..', 'keys.json');
  const newKeysFile = path.join(KEYS_DIR, 'coinbase.json');

  return fs.existsSync(oldKeysFile) && !fs.existsSync(newKeysFile);
};

/**
 * Migrate a single file to exchange namespace
 * @param {string} filename - File name (e.g., 'state.json')
 * @param {string} exchange - Exchange name (e.g., 'coinbase')
 * @param {boolean} move - If true, move file; if false, copy
 */
const migrateFile = (filename, exchange, move = true) => {
  const oldPath = path.join(DATA_DIR, filename);
  const newDir = path.join(DATA_DIR, exchange);
  const newPath = path.join(newDir, filename);
  const backupPath = path.join(DATA_DIR, `${filename}.backup`);

  if (!fs.existsSync(oldPath)) {
    console.log(`  Skip: ${filename} (not found)`);
    return false;
  }

  // Ensure target directory exists
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
  }

  // Create backup first
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(oldPath, backupPath);
    console.log(`  Backup: ${filename} -> ${filename}.backup`);
  }

  // Move or copy the file
  if (move) {
    fs.renameSync(oldPath, newPath);
    console.log(`  Migrate: ${filename} -> ${exchange}/${filename}`);
  } else {
    fs.copyFileSync(oldPath, newPath);
    console.log(`  Copy: ${filename} -> ${exchange}/${filename}`);
  }

  return true;
};

/**
 * Run data migration to exchange-namespaced directories
 * @param {string} exchange - Exchange to migrate to (default: coinbase)
 * @returns {{migrated: number, skipped: number}}
 */
const migrateData = (exchange = 'coinbase') => {
  console.log(`\n=== Data Migration to ${exchange} namespace ===\n`);

  const result = { migrated: 0, skipped: 0 };

  // Files to migrate
  const files = [
    'state.json',
    'transactions.tsv',
    'optimizer-cache.json',
  ];

  // Migrate standard files
  for (const file of files) {
    if (migrateFile(file, exchange)) {
      result.migrated++;
    } else {
      result.skipped++;
    }
  }

  // Migrate price cache files (can be large, use move)
  const cacheFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('btc-price-cache') && f.endsWith('.json'));

  for (const file of cacheFiles) {
    if (migrateFile(file, exchange, true)) {
      result.migrated++;
    } else {
      result.skipped++;
    }
  }

  console.log(`\nMigration complete: ${result.migrated} files migrated, ${result.skipped} skipped`);

  return result;
};

/**
 * Migrate keys.json to data/coinbase-keys.json
 * @returns {boolean} True if migration happened
 */
const migrateKeys = () => {
  const oldKeysFile = path.join(__dirname, '..', 'keys.json');
  const newKeysFile = path.join(KEYS_DIR, 'coinbase-keys.json');

  if (!fs.existsSync(oldKeysFile)) {
    console.log('  Skip: keys.json (not found)');
    return false;
  }

  // Ensure data directory exists
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
  }

  // Copy keys (don't delete original for safety)
  if (!fs.existsSync(newKeysFile)) {
    fs.copyFileSync(oldKeysFile, newKeysFile);
    console.log('  Migrate: keys.json -> data/coinbase-keys.json');
    return true;
  }

  console.log('  Skip: data/coinbase-keys.json already exists');
  return false;
};

/**
 * Create empty directories for other exchanges
 * @param {Array<string>} exchanges - List of exchanges to create directories for
 */
const createExchangeDirectories = (exchanges = ['gemini']) => {
  for (const exchange of exchanges) {
    const dir = path.join(DATA_DIR, exchange);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  Create: data/${exchange}/`);
    }
  }
};

/**
 * Run full migration if needed
 * Called automatically on startup
 * @returns {{dataMigrated: boolean, keysMigrated: boolean}}
 */
const runMigrationIfNeeded = () => {
  const result = {
    dataMigrated: false,
    keysMigrated: false,
  };

  if (needsMigration()) {
    console.log('\n[Migration] Detected old data structure, migrating to exchange namespaces...');
    migrateData('coinbase');
    createExchangeDirectories(['gemini']);
    result.dataMigrated = true;
  }

  if (needsKeysMigration()) {
    console.log('\n[Migration] Migrating API keys to new location...');
    migrateKeys();
    result.keysMigrated = true;
  }

  return result;
};

/**
 * Get data directory for an exchange (exchange-level files only).
 * Use getFundDataDir(exchange, pair) for per-fund files.
 *
 * @param {string} exchange - Exchange name
 * @returns {string} Path to exchange data directory
 */
const getExchangeDataDir = (exchange) => {
  const dir = path.join(DATA_DIR, exchange);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Get the per-fund data directory for (exchange, pair). Each fund has its
 * own subdirectory under the exchange so multiple funds can coexist with
 * independent state, fill ledgers, and price caches.
 *
 * If `pair` is omitted, falls back to the exchange's default pair via
 * config-utils.getDefaultPair (preserves backwards compat for callers that
 * haven't been updated yet). The directory is created on demand.
 *
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name (e.g. 'BTC-USDC'); defaults to the exchange's default pair
 * @returns {string} Path to fund data directory
 */
const getFundDataDir = (exchange, pair) => {
  let resolvedPair = pair;
  if (!resolvedPair) {
    // Lazy require to avoid circular dependency: config-utils → state-tracker → migration
    // (config-utils itself does not require migration, so this is safe.)
    const configUtils = require('./config-utils');
    resolvedPair = configUtils.getDefaultPair(exchange) || 'default';
  }
  // Resolve the exchange dir via module.exports so existing tests that patch
  // getExchangeDataDir continue to work without also patching getFundDataDir.
  const exchangeDir = module.exports.getExchangeDataDir(exchange);
  const dir = path.join(exchangeDir, resolvedPair);
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
];

/**
 * Per-fund file glob prefixes. Any file in data/<exchange>/ whose name starts
 * with one of these prefixes is moved into the fund subdirectory during
 * multi-pair migration. This catches per-product price caches and long-term
 * candle stores which include the productId in their filename.
 */
const PER_FUND_FILE_PREFIXES = [
  'btc-price-cache',
  'btcusd-price-cache',
  'btc-usdc-price-cache',
  'cro-usd-price-cache',
  'long-term-candles',
  'price-cache-',
];

/**
 * Check if a filename should be migrated to a fund subdirectory.
 * Matches:
 *   - Exact PER_FUND_FILES names (state.json, regime-state.json, ...)
 *   - Names starting with a per-fund file followed by '.' or '-' (catches
 *     .bak, .backup, .backup-1234, .tmp, etc.)
 *   - Names starting with a PER_FUND_FILE_PREFIX (price-cache, long-term-candles)
 * @param {string} filename
 * @returns {boolean}
 */
const isPerFundFile = (filename) => {
  if (PER_FUND_FILES.includes(filename)) return true;
  // Match backup/temp variants of per-fund files (e.g. state.json.backup-1234, regime-state.json.bak)
  for (const f of PER_FUND_FILES) {
    if (filename.startsWith(f + '.') || filename.startsWith(f + '-')) return true;
  }
  // Match prefix-based files (price caches, long-term candles, with any suffix)
  for (const prefix of PER_FUND_FILE_PREFIXES) {
    if (filename.startsWith(prefix)) return true;
  }
  return false;
};

/**
 * Detect whether the exchange's data directory is in legacy single-pair
 * layout (files at data/<exchange>/) and needs migration to the per-fund
 * layout (files at data/<exchange>/<pair>/).
 *
 * @param {string} exchange
 * @returns {boolean} True if migration is needed
 */
const needsPairMigration = (exchange) => {
  // Use module.exports so tests that patch getExchangeDataDir take effect.
  // (We don't call getExchangeDataDir directly because it would create the
  // directory as a side-effect; we want a pure existence check.)
  const exchangeDir = path.join(DATA_DIR, exchange);
  if (!fs.existsSync(exchangeDir)) return false;
  // If a state file already lives at the exchange level, migration is needed.
  return fs.existsSync(path.join(exchangeDir, 'state.json'))
      || fs.existsSync(path.join(exchangeDir, 'regime-state.json'));
};

/**
 * Detect whether any regime engine for the given exchange is currently
 * running. We refuse to perform pair migration while engines are live
 * because they periodically save state and would silently overwrite the
 * migrated files.
 *
 * Looks for the regime-engine-running.json flag in either the legacy
 * (data/<exchange>/) or new (data/<exchange>/<pair>/) location.
 *
 * @param {string} exchange
 * @returns {boolean}
 */
const isAnyEngineRunning = (exchange) => {
  const exchangeDir = path.join(DATA_DIR, exchange);
  if (!fs.existsSync(exchangeDir)) return false;
  // Legacy location
  if (fs.existsSync(path.join(exchangeDir, 'regime-engine-running.json'))) return true;
  // Per-fund locations
  try {
    const entries = fs.readdirSync(exchangeDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(exchangeDir, e.name, 'regime-engine-running.json'))) {
          return true;
        }
      }
    }
  } catch {
    // best-effort
  }
  return false;
};

/**
 * Migrate an exchange from the legacy single-pair layout to the multi-pair
 * layout by moving all per-fund files into a subdirectory named after the
 * exchange's default pair (read from config).
 *
 * Refuses to run if the engine is currently running for this exchange (per
 * the project's runtime-state safety rule). Idempotent: if the migration has
 * already happened, this is a no-op.
 *
 * @param {string} exchange
 * @returns {{migrated: boolean, defaultPair: string|null, movedFiles: number, reason?: string}}
 */
const migrateExchangeToPairs = (exchange) => {
  if (!needsPairMigration(exchange)) {
    return { migrated: false, defaultPair: null, movedFiles: 0, reason: 'no-op (already migrated or empty)' };
  }
  if (isAnyEngineRunning(exchange)) {
    return {
      migrated: false,
      defaultPair: null,
      movedFiles: 0,
      reason: `Refusing to migrate ${exchange}: regime engine is running. Stop it first with: pm2 stop ecosystem.config.cjs`,
    };
  }

  // Resolve the default pair from config (legacy productId field).
  const configUtils = require('./config-utils');
  const defaultPair = configUtils.getDefaultPair(exchange);
  if (!defaultPair) {
    return {
      migrated: false,
      defaultPair: null,
      movedFiles: 0,
      reason: `Cannot determine default pair for ${exchange} (config.exchanges.${exchange}.productId missing)`,
    };
  }

  const exchangeDir = path.join(DATA_DIR, exchange);
  const fundDir = path.join(exchangeDir, defaultPair);
  fs.mkdirSync(fundDir, { recursive: true });

  console.log(`\n[Pair Migration] ${exchange} → ${exchange}/${defaultPair}`);
  console.log(`  Source: ${exchangeDir}`);
  console.log(`  Target: ${fundDir}`);

  let moved = 0;
  let skipped = 0;
  const entries = fs.readdirSync(exchangeDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue; // Don't move existing subdirectories
    if (!isPerFundFile(entry.name)) continue;

    const src = path.join(exchangeDir, entry.name);
    const dst = path.join(fundDir, entry.name);

    if (fs.existsSync(dst)) {
      console.log(`  ⚠️  Skip (target exists): ${entry.name}`);
      skipped++;
      continue;
    }

    fs.renameSync(src, dst);
    moved++;
    console.log(`  ✓ ${entry.name}`);
  }

  console.log(`[Pair Migration] ${exchange}: moved ${moved} files (${skipped} skipped)`);
  return { migrated: true, defaultPair, movedFiles: moved };
};

/**
 * Run pair migration for all exchanges configured in the application.
 * Called from engine startup before any state is loaded.
 *
 * @returns {Array<{exchange: string, result: Object}>}
 */
const runPairMigrationIfNeeded = () => {
  const configUtils = require('./config-utils');
  const exchanges = configUtils.getConfiguredExchanges();
  const results = [];
  for (const exchange of exchanges) {
    if (!needsPairMigration(exchange)) continue;
    const result = migrateExchangeToPairs(exchange);
    results.push({ exchange, result });
    if (!result.migrated && result.reason) {
      console.log(`[Pair Migration] ${exchange}: ${result.reason}`);
    }
  }
  return results;
};

/**
 * Get keys file path for an exchange
 * @param {string} exchange - Exchange name
 * @returns {string} Path to exchange keys file
 */
const getExchangeKeysPath = (exchange) => {
  return path.join(KEYS_DIR, `${exchange}-keys.json`);
};

module.exports = {
  needsMigration,
  needsKeysMigration,
  migrateData,
  migrateKeys,
  createExchangeDirectories,
  runMigrationIfNeeded,
  getExchangeDataDir,
  getFundDataDir,
  needsPairMigration,
  isAnyEngineRunning,
  migrateExchangeToPairs,
  runPairMigrationIfNeeded,
  isPerFundFile,
  PER_FUND_FILES,
  PER_FUND_FILE_PREFIXES,
  getExchangeKeysPath,
};
