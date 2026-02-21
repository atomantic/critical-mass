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
 * Get data directory for an exchange
 * @param {string} exchange - Exchange name
 * @returns {string} Path to exchange data directory
 */
const getExchangeDataDir = (exchange) => {
  const dir = path.join(DATA_DIR, exchange);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  getExchangeKeysPath,
};
