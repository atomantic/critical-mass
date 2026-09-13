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
    // Lazy require avoids circular dep: state-tracker → migration → config-utils
    const configUtils = require('./config-utils');
    resolvedPair = configUtils.getDefaultPair(exchange) || 'default';
  }
  // Resolve the exchange dir via module.exports so tests that patch
  // getExchangeDataDir continue to work. The parent dir gets mkdir'd as
  // a side effect, which is harmless: any non-empty install already has
  // the exchange dir, and the test mock points it at a tmp dir anyway.
  // Crucially, we do NOT mkdir the per-fund subdirectory here — that would
  // turn read-side path resolution into directory creation, which is what
  // caused empty BTC-USDC dirs to appear and mask legacy state.
  return resolveFundPath(module.exports.getExchangeDataDir(exchange), resolvedPair);
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
  // getExchangeDataDir continue to work without also patching getFundDataDir.
  const exchangeDir = module.exports.getExchangeDataDir(exchange);
  let resolvedPair = pair;
  if (!resolvedPair) {
    const configUtils = require('./config-utils');
    resolvedPair = configUtils.getDefaultPair(exchange) || 'default';
  }
  const dir = resolveFundPath(exchangeDir, resolvedPair);
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
 * multi-pair migration. This catches per-product price caches which include
 * the productId in their filename.
 *
 * NOTE: long-term-candles-*.json is deliberately NOT in this list — it is
 * read/written at the exchange level (long-term-candle-store.js:cachePath),
 * not per-fund, even though its filename embeds the productId. See
 * repairStrandedLongTermCandles below for un-stranding installs affected by
 * an earlier version of this migration that moved it incorrectly.
 */
const PER_FUND_FILE_PREFIXES = [
  'btc-price-cache',
  'btcusd-price-cache',
  'btc-usdc-price-cache',
  'cro-usd-price-cache',
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
 * Move every per-fund file sitting directly under `<root>/<exchange>/` into
 * `<root>/<exchange>/<pair>/`, translating a pre-multi-pair tree into the
 * current layout.
 *
 * Pure with respect to `root`, so the live migration (root = DATA_DIR) and a
 * restore's staging directory share one implementation. Idempotent: a tree
 * already in per-fund layout has nothing at the exchange level to move, so the
 * call is a no-op and never creates the pair directory.
 *
 * Conflicts are skipped rather than overwritten, matching the live migration —
 * a file already at the target is the newer generation.
 *
 * @param {Object} params
 * @param {string} params.root - Data-directory root holding `<exchange>/`
 * @param {string} params.exchange - Exchange directory name
 * @param {string} params.pair - Destination fund subdirectory
 * @returns {{moved: string[], skipped: string[]}} File names relocated and skipped
 */
const normalizeExchangeTreeToPairs = ({ root, exchange, pair }) => {
  const exchangeDir = path.join(root, exchange);
  if (!fs.existsSync(exchangeDir)) return { moved: [], skipped: [] };

  const stragglers = fs.readdirSync(exchangeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isPerFundFile(entry.name))
    .map((entry) => entry.name);
  // Return before resolveFundPath/mkdir so an already-migrated tree is left
  // byte-identical — no empty pair directory conjured as a side effect.
  if (stragglers.length === 0) return { moved: [], skipped: [] };

  const fundDir = resolveFundPath(exchangeDir, pair);
  fs.mkdirSync(fundDir, { recursive: true });

  const moved = [];
  const skipped = [];
  for (const name of stragglers) {
    const dst = path.join(fundDir, name);
    if (fs.existsSync(dst)) {
      skipped.push(name);
      continue;
    }
    fs.renameSync(path.join(exchangeDir, name), dst);
    moved.push(name);
  }
  return { moved, skipped };
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
 * Un-strand long-term-candles-*.json files that an earlier version of the
 * pair migration incorrectly relocated into a `data/<exchange>/<pair>/`
 * subdirectory. The store is exchange-level (long-term-candle-store.js
 * cachePath), not per-fund — the productId in the filename already keeps
 * multiple funds on one exchange from colliding, so there's no reason for
 * the file to live under a pair subdirectory.
 *
 * Scans every pair subdirectory under `data/<exchange>/` and renames any
 * `long-term-candles-*.json` file back up to the exchange level. If a file
 * already exists at the exchange-level target (e.g. it was rebuilt from
 * scratch after being stranded), the stranded copy is skipped and logged
 * rather than overwriting — a rebuilt cache is at least as fresh.
 *
 * Idempotent and safe to call unconditionally on every engine startup,
 * independent of whether the rest of the pair migration has anything to do
 * (an install can be fully migrated already and still have a stranded file
 * from before this repair existed).
 *
 * @param {string} exchange
 * @returns {{repairedFiles: number, skippedFiles: string[]}}
 */
const repairStrandedLongTermCandles = (exchange) => {
  const exchangeDir = path.join(DATA_DIR, exchange);
  const skippedFiles = [];
  let repairedFiles = 0;
  if (!fs.existsSync(exchangeDir)) return { repairedFiles, skippedFiles };

  const pairDirs = fs.readdirSync(exchangeDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const pairDir of pairDirs) {
    const pairPath = path.join(exchangeDir, pairDir.name);
    const strandedFiles = fs.readdirSync(pairPath, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith('long-term-candles'));

    for (const file of strandedFiles) {
      const src = path.join(pairPath, file.name);
      const dst = path.join(exchangeDir, file.name);

      if (fs.existsSync(dst)) {
        console.log(`  ⚠️  [Pair Migration] Skip un-stranding (exchange-level file already exists): ${pairDir.name}/${file.name}`);
        skippedFiles.push(file.name);
        continue;
      }

      fs.renameSync(src, dst);
      repairedFiles++;
      console.log(`  ✓ [Pair Migration] Un-stranded ${pairDir.name}/${file.name} → ${exchange}/${file.name}`);
    }
  }

  return { repairedFiles, skippedFiles };
};

/**
 * Split TSV file content into a header line and its data rows, tolerating the
 * edge cases a hand-edited or historically-written log file can have:
 *  - completely empty file (no header at all)
 *  - header-only file, with or without a trailing newline
 *  - CRLF line endings
 *  - a final data row with no trailing newline
 * The trailing-newline handling matters: naively splitting on '\n' and using
 * every element as a row would either invent a bogus empty trailing row (file
 * ends with '\n') or, if a caller then re-joins rows without accounting for
 * that, glue a rowless-file's last real row to the next appended row.
 *
 * @param {string} content
 * @returns {{header: string|null, dataLines: string[]}}
 */
const parseTsvLines = (content) => {
  if (content.length === 0) return { header: null, dataLines: [] };
  const lines = content.split(/\r\n|\r|\n/);
  // A trailing newline produces one bogus empty element at the end — drop it,
  // it is not a data row.
  if (lines[lines.length - 1] === '') lines.pop();
  const [header, ...dataLines] = lines;
  return { header: header ?? null, dataLines };
};

/**
 * True if `arr` ends with exactly the elements of `suffix`, in order.
 * @param {string[]} arr
 * @param {string[]} suffix
 * @returns {boolean}
 */
const endsWithSuffix = (arr, suffix) => {
  if (suffix.length === 0) return true;
  if (arr.length < suffix.length) return false;
  const offset = arr.length - suffix.length;
  return suffix.every((line, i) => arr[offset + i] === line);
};

/**
 * One-time repair for a stranded `data/<exchange>/transactions.tsv` (issue #543).
 *
 * `transactions.tsv` is listed in PER_FUND_FILES, but its accessor
 * (logger.js's getLogFile) historically ignored `pair` and always resolved
 * the exchange level — disagreeing with its own classification. That mismatch
 * produces three possible install states, independent of whether the rest of
 * migrateExchangeToPairs has anything to do (an exchange can be fully migrated
 * — state.json/regime-state.json already per-fund — and still have this
 * left over):
 *
 *  - Neither file exists: nothing to repair.
 *  - Only the exchange-level file exists: it holds the fund's entire history
 *    (never migrated yet, or the generic per-fund-file move above skipped it
 *    due to a same-name collision at the fund directory). Move it into the
 *    fund directory.
 *  - Both exist: the pre-upgrade history was already relocated into the fund
 *    directory, but the unpatched accessor kept resolving the exchange level
 *    and recreated a fresh `transactions.tsv` there on the next write. Every
 *    row in that recreated file was necessarily written AFTER the move (the
 *    accessor could not have written there otherwise), so appending it
 *    verbatim onto the fund file preserves timestamp order. Append its data
 *    rows only — never its header — then delete the exchange-level copy.
 *
 * The merge branch writes through atomicWriteSync (temp file + rename) so a
 * crash mid-repair can never leave a truncated transactions.tsv. The whole
 * function is idempotent, including across a crash landing between the
 * atomic write and the deletion of the stranded copy: on re-entry the rows
 * that would be appended are detected as already present (a trailing suffix
 * of the fund file) and the append is skipped, so a second run never
 * duplicates a row — it only finishes deleting the leftover stranded file.
 *
 * @param {string} exchange
 * @param {string} pair - Resolved default pair for `exchange`; callers must
 *   already have confirmed this is non-empty (config.exchanges.<exchange>.productId).
 * @returns {{repaired: boolean, action: 'none'|'moved'|'merged', rowsAppended: number}}
 */
const repairStrandedTransactionLog = (exchange, pair) => {
  const exchangeDir = path.join(DATA_DIR, exchange);
  const exchangeLevelFile = path.join(exchangeDir, 'transactions.tsv');
  if (!fs.existsSync(exchangeLevelFile)) {
    return { repaired: false, action: 'none', rowsAppended: 0 };
  }

  const fundDir = resolveFundPath(exchangeDir, pair);
  const perFundFile = path.join(fundDir, 'transactions.tsv');

  if (!fs.existsSync(perFundFile)) {
    // Lone exchange-level file: relocate it. A rename is a single atomic
    // filesystem operation — there is no partial state a crash could leave.
    fs.mkdirSync(fundDir, { recursive: true });
    fs.renameSync(exchangeLevelFile, perFundFile);
    console.log(`  ✓ [Transaction Log Repair] Moved stranded ${exchange}/transactions.tsv → ${exchange}/${pair}/transactions.tsv`);
    return { repaired: true, action: 'moved', rowsAppended: 0 };
  }

  // Both exist: reconcile by appending the exchange-level file's data rows
  // (never its header) onto the fund file, then removing the stranded copy.
  const perFundParsed = parseTsvLines(fs.readFileSync(perFundFile, 'utf8'));
  const exchangeParsed = parseTsvLines(fs.readFileSync(exchangeLevelFile, 'utf8'));

  if (exchangeParsed.dataLines.length === 0) {
    // Empty or header-only stray file: nothing to append, just clean it up.
    fs.rmSync(exchangeLevelFile);
    console.log(`  ✓ [Transaction Log Repair] Removed empty stranded ${exchange}/transactions.tsv (no data rows to merge)`);
    return { repaired: true, action: 'merged', rowsAppended: 0 };
  }

  // Resuming after a crash between the write below and the delete: the rows
  // we would append are already the tail of the fund file. Skip the rewrite
  // (it would duplicate them) and just finish the cleanup.
  const alreadyAppended = endsWithSuffix(perFundParsed.dataLines, exchangeParsed.dataLines);

  if (!alreadyAppended) {
    const header = perFundParsed.header ?? exchangeParsed.header;
    const dataLines = [...perFundParsed.dataLines, ...exchangeParsed.dataLines];
    const merged = header === null ? '' : [header, ...dataLines].join('\n') + '\n';
    // Lazy require: state-tracker requires migration at module load, so a
    // top-level require here would form a cycle.
    const { atomicWriteSync } = require('./state-tracker');
    atomicWriteSync(perFundFile, merged);
  }

  fs.rmSync(exchangeLevelFile);
  console.log(`  ✓ [Transaction Log Repair] Merged ${exchangeParsed.dataLines.length} stranded row(s) from ${exchange}/transactions.tsv into ${exchange}/${pair}/transactions.tsv`);
  return { repaired: true, action: 'merged', rowsAppended: exchangeParsed.dataLines.length };
};

/**
 * Migrate an exchange from the legacy single-pair layout to the multi-pair
 * layout by moving all per-fund files into a subdirectory named after the
 * exchange's default pair (read from config).
 *
 * This runs at engine startup BEFORE any other initialization, so by
 * definition no engine is currently running in this process. The previous
 * engine process (if any) is already dead — PM2 wouldn't be spawning a new
 * one otherwise. We do NOT block on the regime-engine-running.json flag
 * because that flag is the auto-resume hint from the previous session and
 * is left intentionally so the engine can resume on restart.
 *
 * Idempotent: if the migration has already happened, this is a no-op.
 * Cleans up empty pre-existing pair subdirectories that may have been
 * accidentally created by the API server before migration ran.
 *
 * Also un-strands any long-term-candles-*.json files a previous version of
 * this migration incorrectly moved into a pair subdirectory (see
 * repairStrandedLongTermCandles), and reconciles a stranded exchange-level
 * transactions.tsv (see repairStrandedTransactionLog) — both run regardless
 * of whether the rest of the migration below has anything to do, so an
 * already-migrated exchange still gets reconciled.
 *
 * @param {string} exchange
 * @returns {{migrated: boolean, defaultPair: string|null, movedFiles: number, reason?: string, skippedFiles?: string[], repairedFiles?: number, skippedRepairFiles?: string[], transactionLogRepair?: {repaired: boolean, action: string, rowsAppended: number}}}
 */
const migrateExchangeToPairs = (exchange) => {
  const { repairedFiles, skippedFiles: skippedRepairFiles } = repairStrandedLongTermCandles(exchange);

  // Resolve the default pair from config (legacy productId field) up front —
  // both the no-op early-return below and the main migration path need it to
  // reconcile a stranded transactions.tsv.
  const configUtils = require('./config-utils');
  const defaultPairForRepair = configUtils.getDefaultPair(exchange);

  if (!needsPairMigration(exchange)) {
    // The rest of the migration has nothing to do, but a stranded
    // transactions.tsv (recreated post-migration by the unpatched accessor)
    // can still exist even on an exchange whose state.json/regime-state.json
    // are already per-fund — reconcile it here (issue #543).
    const transactionLogRepair = defaultPairForRepair
      ? repairStrandedTransactionLog(exchange, defaultPairForRepair)
      : { repaired: false, action: 'none', rowsAppended: 0 };
    return {
      migrated: false,
      defaultPair: null,
      movedFiles: 0,
      reason: 'no-op (already migrated or empty)',
      repairedFiles,
      skippedRepairFiles,
      transactionLogRepair,
    };
  }

  const defaultPair = defaultPairForRepair;
  if (!defaultPair) {
    return {
      migrated: false,
      defaultPair: null,
      movedFiles: 0,
      reason: `Cannot determine default pair for ${exchange} (config.exchanges.${exchange}.productId missing)`,
      repairedFiles,
      skippedRepairFiles,
      transactionLogRepair: { repaired: false, action: 'none', rowsAppended: 0 },
    };
  }

  const exchangeDir = path.join(DATA_DIR, exchange);
  // resolveFundPath (not path.join) so a pair that would escape the exchange
  // directory is rejected BEFORE anything is created on disk.
  const fundDir = resolveFundPath(exchangeDir, defaultPair);

  // If the target subdirectory exists but is empty (e.g. accidentally
  // created by the API server reading per-fund paths before migration ran),
  // it's safe to keep it — the moves below will populate it.
  // If it exists with content, that's a previous partial migration; we
  // skip individual files that already exist at the target.
  fs.mkdirSync(fundDir, { recursive: true });

  console.log(`\n[Pair Migration] ${exchange} → ${exchange}/${defaultPair}`);
  console.log(`  Source: ${exchangeDir}`);
  console.log(`  Target: ${fundDir}`);

  const { moved: movedNames, skipped: skippedFiles } = normalizeExchangeTreeToPairs({
    root: DATA_DIR,
    exchange,
    pair: defaultPair,
  });
  const moved = movedNames.length;
  for (const name of movedNames) console.log(`  ✓ ${name}`);
  for (const name of skippedFiles) console.log(`  ⚠️  Skip (target exists): ${name}`);

  // Clean up any OTHER empty pair subdirectories (e.g. created by the API
  // server using a non-default pair key before migration ran). Only removes
  // dirs that are actually empty — skips the just-populated target.
  const postEntries = fs.readdirSync(exchangeDir, { withFileTypes: true });
  for (const e of postEntries) {
    if (!e.isDirectory()) continue;
    if (e.name === defaultPair) continue;
    const subDir = path.join(exchangeDir, e.name);
    try {
      const contents = fs.readdirSync(subDir);
      if (contents.length === 0) {
        fs.rmdirSync(subDir);
        console.log(`  🧹 Removed empty pair subdir: ${e.name}/`);
      }
    } catch {
      // best-effort cleanup
    }
  }

  console.log(`[Pair Migration] ${exchange}: moved ${moved} files (${skippedFiles.length} skipped)`);

  // Reconcile a stranded exchange-level transactions.tsv (issue #543). Runs
  // AFTER normalizeExchangeTreeToPairs above so the common case — no per-fund
  // copy existed yet — is already handled by the generic per-fund-file move
  // and counted in `moved`; this only has work left when normalizeExchangeTreeToPairs
  // skipped transactions.tsv (both a stranded and a per-fund copy exist).
  const transactionLogRepair = repairStrandedTransactionLog(exchange, defaultPair);

  return { migrated: true, defaultPair, movedFiles: moved, skippedFiles, repairedFiles, skippedRepairFiles, transactionLogRepair };
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
  resolveFundDataDir,
  resolveFundPath,
  migrateExchangeToPairs,
  normalizeExchangeTreeToPairs,
  repairStrandedLongTermCandles,
  repairStrandedTransactionLog,
  isPerFundFile,
  PER_FUND_FILES,
  PER_FUND_FILE_PREFIXES,
  getExchangeKeysPath,
};
