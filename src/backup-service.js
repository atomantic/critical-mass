// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Archive creation uses async spawn for zip/unzip; restore and listing use spawnSync
 * (listing only on a cold cache — see archiveValidityCache).
 * Excludes credentials, live configuration, and the backup directory from archives.
 *
 * Archives also carry a versioned manifest (`backup-manifest.json`) holding a
 * self-contained snapshot of the effective non-secret configuration, so a
 * restore onto a machine with a different base `config.json` reproduces the
 * original funds instead of silently adopting the destination's defaults
 * (issue #430).
 */

const fs = require('fs');
const { BASE_SNAPSHOT_FILENAME, CONFIG_LOCK_DIR } = require('./config-base-drift');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { jsonReadError } = require('./json-diagnostics');
const { fsyncDir } = require('./fsync-dir');
const { fsyncFile } = require('./durable-write');
const { spawnSync, spawn } = require('child_process');
const { DATA_DIR, BACKUP_DIR } = require('./paths');
const { applyStagedFiles, STAGE_PREFIX, ORIGINALS_PREFIX, JOURNAL_FILENAME } = require('./restore-apply');
const { LOCK_FILENAME: LEGACY_MIGRATION_LOCK } = require('./legacy-namespace-migration');
const {
  buildConfigSnapshot,
  reconstructConfigOverride,
  diffSnapshotAgainstConfig,
  resolveBaseConfigFile,
  normalizeToMultiExchange,
  normalizeExchangeBlock,
  invalidateConfigCache,
  deepMerge,
  GLOBAL_DEFAULTS,
} = require('./config-utils');
const { isPerFundFile, normalizeExchangeTreeToPairs } = require('./migration');

const BACKUPS_DIR = BACKUP_DIR;

/** Archive entry holding the configuration snapshot. */
const MANIFEST_FILENAME = 'backup-manifest.json';

/** Manifest envelope version. Restore rejects anything it does not know. */
const MANIFEST_VERSION = 1;

/** Directory and manifest used by the lightweight hourly fund-state snapshots. */
const FUND_STATE_BACKUP_DIRNAME = 'fund-state';
const FUND_STATE_MANIFEST_FILENAME = 'fund-state-manifest.json';
const FUND_STATE_MANIFEST_VERSION = 1;
// manual-trades.json and pending-corrective-buys.json name the open recovery
// buys that engine startup must not cancel as orphans; a fund restored without
// them loses those buys and their sell pairing.
const FUND_STATE_SNAPSHOT_FILENAMES = [
  'fill-ledger.json',
  'regime-state.json',
  'closed-trades.json',
  'state.json',
  'dry-run-state.json',
  'manual-trades.json',
  'pending-corrective-buys.json',
];

// Bounds each zip/unzip child. The archive-creation path uses async spawn, so a
// slow archive no longer blocks the gateway event loop or its shutdown drain;
// the sync callers (restore, listing) still block for up to this long.
const SPAWN_TIMEOUT_MS = 60000;

/**
 * Promise-wrapped spawn with spawnSync's result shape ({status, error, stdout,
 * stderr}), so callers keep the same exit-code and error handling.
 */
const spawnAsync = (command, args, { cwd, timeout = SPAWN_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  const out = [];
  const err = [];
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), ...result });
  };
  const child = spawn(command, args, { cwd });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ status: null, error: new Error(`${command} timed out after ${timeout}ms`) });
  }, timeout);
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  child.on('error', (error) => finish({ status: null, error }));
  child.on('close', (status) => finish({ status, error: undefined }));
});

/** Root-level credential files that must remain machine-local. */
const ROOT_CREDENTIAL_FILES = [
  'operator-auth.json',
  'providers.json',
  'operator-bootstrap-secret',
];

/** Callers that have no context logger (CLI, tests) get silence, not console noise. */
const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Resolve every path the service touches from a single data directory, so
 * temp-directory tests can exercise create/restore without going near the live
 * install.
 * @param {{dataDir?: string, baseConfigFile?: string}} [overrides]
 * @returns {{dataDir: string, backupsDir: string, fundStateBackupsDir: string, baseConfigFile: string, userConfigFile: string}}
 */
const resolvePaths = ({ dataDir = DATA_DIR, baseConfigFile } = {}) => ({
  dataDir,
  backupsDir: path.join(dataDir, 'backups'),
  fundStateBackupsDir: path.join(dataDir, 'backups', FUND_STATE_BACKUP_DIRNAME),
  baseConfigFile: baseConfigFile || resolveBaseConfigFile(),
  userConfigFile: path.join(dataDir, 'config.json'),
});

/**
 * Ensure backups directory exists
 * @param {string} [dir]
 */
const ensureBackupsDir = (dir = BACKUPS_DIR) => {
  fs.mkdirSync(dir, { recursive: true });
};

/**
 * Reject filenames that could escape the backups directory or name something
 * that is not one of our archives. Shared by every filename-taking entrypoint.
 * @param {string} filename
 * @returns {string|null} Error message, or null when the name is acceptable
 */
const backupFilenameError = (filename) => {
  if (typeof filename !== 'string' || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return 'Invalid filename';
  }
  if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) {
    return 'Invalid backup filename format';
  }
  return null;
};

/**
 * Resolve an archive path, rejecting bad names, missing files and non-regular
 * files (symlink protection).
 * @param {string} filename
 * @param {string} backupsDir
 * @returns {{ok: true, zipPath: string} | {ok: false, error: string}}
 */
const resolveArchivePath = (filename, backupsDir) => {
  const nameError = backupFilenameError(filename);
  if (nameError) return { ok: false, error: nameError };

  const zipPath = path.join(backupsDir, filename);
  let stat;
  try {
    stat = fs.lstatSync(zipPath);
  } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'Backup not found' : 'Failed to access backup file' };
  }
  if (!stat.isFile()) return { ok: false, error: 'Invalid backup file' };
  return { ok: true, zipPath };
};

/**
 * Read and parse a JSON file. A missing file is not an error (value is null).
 * @param {string} file
 * @returns {{ok: true, value: Object|null} | {ok: false, error: string}}
 */
const readJsonFile = (file) => {
  if (!fs.existsSync(file)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    const diagnostic = jsonReadError(err, path.basename(file));
    return { ok: false, error: diagnostic.message };
  }
};

/**
 * Read the effective (base + user override) configuration from explicit paths,
 * bypassing the live config cache.
 * @param {{baseConfigFile: string, userConfigFile: string}} paths
 * @returns {{ok: true, config: Object, base: Object} | {ok: false, error: string}}
 */
const readEffectiveConfig = ({ baseConfigFile, userConfigFile }) => {
  const baseRead = readJsonFile(baseConfigFile);
  if (!baseRead.ok) return { ok: false, error: baseRead.error };
  const userRead = readJsonFile(userConfigFile);
  if (!userRead.ok) return { ok: false, error: userRead.error };
  const base = baseRead.value || {};
  return { ok: true, base, config: normalizeToMultiExchange(deepMerge(base, userRead.value || {})) };
};

/** Per-fund state file names whose presence marks a fund as still holding data. */
const FUND_STATE_FILENAMES = ['state.json', 'regime-state.json', 'fill-ledger.json'];

/**
 * Whether (exchange, pair) still has fund-scoped state on disk under `dataDir`.
 *
 * Checked directly against `dataDir` rather than through
 * migration.resolveFundDataDir, which resolves against the module-level
 * DATA_DIR constant and would ignore the `paths` override every restore path
 * here takes for tests — this must see the same directory a restore itself
 * would touch (issue #533).
 * @param {string} dataDir
 * @param {string} exchange
 * @param {string} pair
 * @returns {boolean}
 */
const hasFundStateOnDisk = (dataDir, exchange, pair) =>
  FUND_STATE_FILENAMES.some((name) => fs.existsSync(path.join(dataDir, exchange, pair, name)));

/**
 * Shape the funds a restore would remove for the pre-flight report: identity
 * plus enough of the destination's own settings for the confirmation UI to
 * show what is at stake, and whether it still holds on-disk state.
 * @param {string} dataDir
 * @param {Array<{exchange: string, pair: string, fund: Object}>} removed
 * @returns {Array<Object>}
 */
const buildRemovedFundsReport = (dataDir, removed) => removed.map(({ exchange, pair, fund }) => ({
  exchange,
  pair,
  productId: fund?.productId ?? pair,
  totalAllocation: fund?.totalAllocation ?? null,
  enabled: fund?.enabled === true,
  dryRun: fund?.dryRun !== false,
  hasStateOnDisk: hasFundStateOnDisk(dataDir, exchange, pair),
}));

/**
 * Non-exchange top-level entries a layout scan must never treat as an exchange
 * directory, whatever they happen to contain.
 */
const NON_EXCHANGE_DIRS = new Set(['backups']);

/**
 * Whether `<root>/<exchange>/` holding exactly `filenames` is a pre-multi-pair
 * exchange tree: it has per-fund files at the exchange level, and it is either
 * a configured exchange or carries an unmistakable fund-state file. The second
 * arm keeps an unconfigured directory that merely holds a price cache from
 * being mistaken for an exchange.
 *
 * @param {string} exchange
 * @param {string[]} filenames - File names directly under the exchange directory
 * @param {Set<string>} knownExchanges - Exchanges named by the archive or the destination
 * @returns {boolean}
 */
const isLegacyExchangeLayout = (exchange, filenames, knownExchanges) =>
  filenames.some(isPerFundFile)
  && (knownExchanges.has(exchange) || filenames.some((name) => FUND_STATE_FILENAMES.includes(name)));

/**
 * Group an archive's entry paths by top-level directory, keeping only the file
 * names that sit directly inside it. Shared shape with `collectExchangeFilesFromDir`
 * so one planner serves both the pre-flight (zip listing) and the restore
 * (extracted staging tree).
 *
 * @param {string[]} entries - Archive entry paths (`coinbase/state.json`, ...)
 * @returns {Map<string, string[]>}
 */
const collectExchangeFilesFromEntries = (entries) => {
  const byDir = new Map();
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.length !== 2 || !parts[1]) continue;
    const [dir, name] = parts;
    if (NON_EXCHANGE_DIRS.has(dir) || dir.startsWith('.')) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }
  return byDir;
};

/**
 * Same grouping as `collectExchangeFilesFromEntries`, read from a directory.
 * @param {string} root - Staging (or data) root
 * @returns {Map<string, string[]>}
 */
const collectExchangeFilesFromDir = (root) => {
  const byDir = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || NON_EXCHANGE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    byDir.set(entry.name, fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })
      .filter((child) => child.isFile())
      .map((child) => child.name));
  }
  return byDir;
};

/**
 * First (default) pair an exchange block names, read from an explicit config
 * object rather than the live config cache — every path here takes a `paths`
 * override that the cache would ignore.
 * @param {Object} config - Normalized multi-exchange configuration
 * @param {string} exchange
 * @returns {string|null}
 */
const defaultPairFromConfig = (config, exchange) => {
  const block = config?.exchanges?.[exchange];
  if (!block) return null;
  return Object.keys(normalizeExchangeBlock(block).pairs || {})[0] ?? null;
};

/**
 * Decide, without touching a single file, which staged exchange trees are in
 * the pre-multi-pair layout and which pair each would be relocated into.
 *
 * The archive's own snapshot wins: an archive that carries its configuration
 * knows the pair its data belongs to, and the destination's default may name a
 * different fund entirely. The destination's default is the fallback for the
 * data-only (`acceptLegacyWithoutBase`) path, where no snapshot exists.
 *
 * @param {Object} params
 * @param {Map<string, string[]>} params.exchangeFiles - Exchange dir -> file names at its root
 * @param {Object|null} params.snapshot - Archive configuration snapshot, if any
 * @param {Object} params.destinationConfig - Destination's effective configuration
 * @returns {{translations: Array<{exchange: string, pair: string}>, unresolvable: string[]}}
 */
const planLayoutTranslation = ({ exchangeFiles, snapshot, destinationConfig }) => {
  const knownExchanges = new Set([
    ...Object.keys(snapshot?.exchanges || {}),
    ...Object.keys(destinationConfig?.exchanges || {}),
  ]);
  const translations = [];
  const unresolvable = [];

  for (const [exchange, filenames] of exchangeFiles) {
    if (!isLegacyExchangeLayout(exchange, filenames, knownExchanges)) continue;
    const pair = Object.keys(snapshot?.exchanges?.[exchange]?.pairs || {})[0]
      ?? defaultPairFromConfig(destinationConfig, exchange);
    if (pair) translations.push({ exchange, pair });
    else unresolvable.push(exchange);
  }

  return { translations, unresolvable };
};

/**
 * List an archive's entry paths without extracting it.
 * @param {string} zipPath
 * @returns {string[]} Entry paths, or [] when the listing cannot be read
 */
const listArchiveEntries = (zipPath) => {
  const result = spawnSync('unzip', ['-Z1', zipPath], { timeout: SPAWN_TIMEOUT_MS });
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return result.stdout.toString().split('\n').map((line) => line.trim()).filter(Boolean);
};

/**
 * Pre-flight disclosure of the layout translation a restore of `zipPath` would
 * perform, derived from the archive's entry listing alone — nothing is
 * extracted and no destination is touched.
 *
 * @param {Object} params
 * @param {string} params.zipPath
 * @param {Object|null} params.snapshot - Archive configuration snapshot, if any
 * @param {Object} params.destinationConfig - Destination's effective configuration
 * @returns {{legacyLayout: boolean, layoutTranslations: Array<{exchange: string, pair: string}>,
 *   unresolvableLayoutExchanges: string[]}}
 */
const describeLayoutTranslation = ({ zipPath, snapshot, destinationConfig }) => {
  const { translations, unresolvable } = planLayoutTranslation({
    exchangeFiles: collectExchangeFilesFromEntries(listArchiveEntries(zipPath)),
    snapshot,
    destinationConfig,
  });
  return {
    legacyLayout: translations.length > 0 || unresolvable.length > 0,
    layoutTranslations: translations,
    unresolvableLayoutExchanges: unresolvable,
  };
};

/**
 * Add the manifest to an already-created archive. Written from a staging
 * directory rather than into the data directory so a backup never leaves a
 * stray file behind (or races a concurrent reader of data/).
 * @param {string} zipPath
 * @param {Object} manifest
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const appendManifest = async (zipPath, manifest) => {
  // A staging failure (e.g. a full temp volume) is reported, not thrown: a
  // throw would skip createBackup's cleanup and strand the unlisted
  // .backup-*.tmp.zip in backups/ for good.
  let stagingDir = null;
  let result;
  try {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-manifest-'));
    fs.writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
    result = await spawnAsync('zip', ['-q', '-g', zipPath, MANIFEST_FILENAME], { cwd: stagingDir });
  } catch (error) {
    return { success: false, error: `Failed to write backup manifest: ${error.message}` };
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  if (result.error || result.status !== 0) {
    const error = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : 'Unknown zip error');
    return { success: false, error: `Failed to write backup manifest: ${error}` };
  }
  return { success: true };
};

const checkTailFailure = (result, fallback) => {
  if (!result.error && result.status === 0) return null;
  return { ok: false, error: result.error ? result.error.message : (result.stderr?.toString().trim() || fallback) };
};

/** Shared decision logic once an archive's integrity, listing and manifest reads are in hand. */
const evaluateArchive = ({ entries, readManifest, allowLegacy }) => {
  const manifests = entries.stdout.toString().split('\n').filter((entry) => entry === MANIFEST_FILENAME);
  if (manifests.length === 0 && allowLegacy) return { ok: true };
  if (manifests.length !== 1) return { ok: false, error: `Archive must contain exactly one ${MANIFEST_FILENAME}` };
  const read = readManifest();
  if (read.error || !read.present) return { ok: false, error: read.error || `Missing ${MANIFEST_FILENAME}` };
  const validated = readManifestSnapshot(read.manifest);
  if (!validated.ok) return { ok: false, error: validated.error };
  if (!validated.snapshot || typeof validated.snapshot !== 'object' || Array.isArray(validated.snapshot)) {
    return { ok: false, error: `${MANIFEST_FILENAME} has no valid configuration snapshot` };
  }
  if (typeof read.manifest.createdAt !== 'string' || Number.isNaN(Date.parse(read.manifest.createdAt))) {
    return { ok: false, error: `${MANIFEST_FILENAME} has no valid creation time` };
  }
  return { ok: true };
};

/** Validate an archive; only listing may admit the supported pre-manifest format. */
const validateBackupArchive = (zipPath, { allowLegacy = false } = {}) => {
  const integrity = spawnSync('unzip', ['-tq', zipPath], { timeout: SPAWN_TIMEOUT_MS });
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return integrityFailure;
  const entries = spawnSync('unzip', ['-Z1', zipPath], { timeout: SPAWN_TIMEOUT_MS });
  const entriesFailure = checkTailFailure(entries, 'Unable to read archive entries');
  if (entriesFailure) return entriesFailure;
  return evaluateArchive({ entries, allowLegacy, readManifest: () => readArchiveManifest(zipPath) });
};

/** Non-blocking validateBackupArchive for the backup-creation path. */
const validateBackupArchiveAsync = async (zipPath, { allowLegacy = false } = {}) => {
  const integrity = await spawnAsync('unzip', ['-tq', zipPath]);
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return integrityFailure;
  const entries = await spawnAsync('unzip', ['-Z1', zipPath]);
  const entriesFailure = checkTailFailure(entries, 'Unable to read archive entries');
  if (entriesFailure) return entriesFailure;
  const manifestRead = await spawnAsync('unzip', ['-p', zipPath, MANIFEST_FILENAME]);
  return evaluateArchive({ entries, allowLegacy, readManifest: () => parseManifestRead(manifestRead) });
};

/**
 * Archive verdicts keyed by `path:mtimeMs:size`. A full integrity test
 * (`unzip -tq`) decompresses the whole archive and, run synchronously, stalls
 * the gateway event loop for ~0.5 s per 16 MB — so a given file state is tested
 * at most once per process: createBackup seeds the verdict it already earned
 * before publishing, and listing / scheduling reuse it.
 *
 * Guarantee: an archive is re-tested whenever its path, mtime or size changes,
 * and after a gateway restart. Silent corruption that changes neither mtime nor
 * size (bit rot) is NOT detected until then; verdict age is deliberately not
 * bounded, since a periodic re-test would reintroduce the event-loop stall this
 * cache removes. Restore does not use this cache or validateBackupArchive: it
 * relies on the CRC checks `unzip` performs while extracting.
 */
const archiveValidityCache = new Map();

const archiveValidityKey = (filePath, stats) => `${filePath}:${stats.mtimeMs}:${stats.size}`;

/**
 * Cached validity of an archive file in its current state (legacy pre-manifest
 * archives are admitted, as listing and scheduling always did).
 * @param {string} filePath
 * @param {import('fs').Stats} stats
 * @returns {boolean}
 */
const isArchiveListable = (filePath, stats) => {
  const key = archiveValidityKey(filePath, stats);
  if (!archiveValidityCache.has(key)) {
    archiveValidityCache.set(key, validateBackupArchive(filePath, { allowLegacy: true }).ok);
  }
  return archiveValidityCache.get(key);
};

/** Drop verdicts for archive states that no longer exist so the cache cannot grow without bound. */
const pruneArchiveValidityCache = (liveKeys) => {
  for (const key of archiveValidityCache.keys()) {
    if (!liveKeys.has(key)) archiveValidityCache.delete(key);
  }
};

/**
 * Create a backup of all data files
 * @param {Object} options
 * @param {boolean} [options.includePriceCache=false] - Include price cache files (~45MB per exchange)
 * @param {{dataDir?: string, baseConfigFile?: string}} [options.paths] - Path overrides (tests)
 * @returns {Promise<{ success: boolean, filename?: string, sizeBytes?: number, error?: string }>}
 */
const createBackup = async ({ includePriceCache = false, paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  ensureBackupsDir(paths.backupsDir);

  // Build the manifest BEFORE the archive: an unreadable/corrupt config must
  // not produce an archive that silently lacks configuration portability.
  const effective = readEffectiveConfig(paths);
  if (!effective.ok) return { success: false, error: effective.error };
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    config: buildConfigSnapshot(effective.config),
  };

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const id = crypto.randomUUID();
  const filename = `backup-${timestamp}-${id}.zip`;
  const zipPath = path.join(paths.backupsDir, `.backup-${id}.tmp.zip`);

  // Build exclusion patterns
  const excludes = [
    'backups/*',        // Don't include backups dir in backup
    '*-keys.json',      // Never include API keys
    '*/*-keys.json',    // Keys in subdirectories
    ...ROOT_CREDENTIAL_FILES,
    'config.json',      // Portable configuration is carried by the manifest
    'config.json.*.tmp', // Interrupted atomic writes can contain secrets too
    BASE_SNAPSHOT_FILENAME, // Full local base may contain secrets; rebuild on restore
    `${BASE_SNAPSHOT_FILENAME}.*.tmp`,
    CONFIG_LOCK_DIR, `${CONFIG_LOCK_DIR}/*`,
    MANIFEST_FILENAME,  // The manifest is generated below, never archived from data/
    // Restore bookkeeping (rollback journal, saved originals, extraction
    // staging). Archiving these would ship a stale journal into the next
    // restore, and a startup recovery would then "roll back" a restore that
    // never ran on that machine (issue #431).
    JOURNAL_FILENAME,
    `${STAGE_PREFIX}*`, `${STAGE_PREFIX}*/*`,
    `${ORIGINALS_PREFIX}*`, `${ORIGINALS_PREFIX}*/*`,
    '*.restore-tmp', '*/*.restore-tmp', // Orphaned atomic-replace temp files
    // Legacy namespace migration ownership (issue #971): a captured lock is
    // meaningless on another machine or after a restore.
    `${LEGACY_MIGRATION_LOCK}*`,
  ];

  if (!includePriceCache) {
    excludes.push('*-price-cache*.json');
    excludes.push('*/*-price-cache*.json');
  }

  const excludeArgs = excludes.flatMap(pattern => ['-x', pattern]);

  // Create zip from data directory
  const result = await spawnAsync('zip', [
    '-r',               // Recursive
    '-q',               // Quiet
    zipPath,
    '.',                // Current directory (data/)
    ...excludeArgs,
  ], { cwd: paths.dataDir });

  // zip exits 12 when the live data directory contains no entries after the
  // exclusions. That is a valid backup: appendManifest creates the archive
  // containing the portable configuration snapshot below.
  const noDataFiles = !result.error && result.status === 12;
  if (result.error || (result.status !== 0 && !noDataFiles)) {
    const error = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : 'Unknown zip error');
    fs.rmSync(zipPath, { force: true });
    return { success: false, error };
  }

  const appended = await appendManifest(zipPath, manifest);
  if (!appended.success) {
    // A manifest-less archive is exactly the bug #430 fixes — don't keep one.
    fs.rmSync(zipPath, { force: true });
    return { success: false, error: appended.error };
  }

  const validation = await validateBackupArchiveAsync(zipPath);
  if (!validation.ok) {
    fs.rmSync(zipPath, { force: true });
    return { success: false, error: `Backup validation failed: ${validation.error}` };
  }

  const publishedPath = path.join(paths.backupsDir, filename);
  let published = false;
  try {
    fsyncFile(zipPath);
    fs.renameSync(zipPath, publishedPath);
    published = true;
    fsyncDir(paths.backupsDir);
    // backups/ may have been created by this call.
    fsyncDir(paths.dataDir);
  } catch (error) {
    fs.rmSync(published ? publishedPath : zipPath, { force: true });
    return { success: false, error: `Failed to publish backup archive: ${error.message}` };
  }

  const stats = fs.statSync(path.join(paths.backupsDir, filename));
  // Validated just above (the async check) — listing must not re-test it.
  archiveValidityCache.set(archiveValidityKey(publishedPath, stats), true);
  return { success: true, filename, sizeBytes: stats.size };
};

/**
 * List all backups sorted newest-first
 * @returns {Array<{ filename: string, createdAt: string, sizeBytes: number }>}
 */
const listBackups = () => {
  ensureBackupsDir();

  const liveKeys = new Set();
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
    .filter((filename) => {
      const filePath = path.join(BACKUPS_DIR, filename);
      try {
        const stats = fs.lstatSync(filePath);
        if (!stats.isFile()) return false;
        liveKeys.add(archiveValidityKey(filePath, stats));
        return isArchiveListable(filePath, stats);
      } catch (_error) {
        return false;
      }
    });
  pruneArchiveValidityCache(liveKeys);

  return files
    .map(filename => {
      const filePath = path.join(BACKUPS_DIR, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        createdAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

/**
 * Delete a single backup
 * @param {string} filename - Backup filename to delete
 * @returns {{ success: boolean, error?: string }}
 */
const deleteBackup = (filename) => {
  const resolved = resolveArchivePath(filename, BACKUPS_DIR);
  if (!resolved.ok) return { success: false, error: resolved.error };

  try {
    fs.unlinkSync(resolved.zipPath);
  } catch (err) {
    return { success: false, error: err?.code === 'ENOENT' ? 'Backup not found' : 'Failed to delete backup file' };
  }
  return { success: true };
};

/**
 * Prune old backups to keep only maxBackups. Falls back to
 * `GLOBAL_DEFAULTS.backup.maxBackups` when `maxBackups` is not a positive
 * integer, so an invalid retain count can never delete every archive.
 * @param {number} maxBackups - Maximum number of backups to keep
 * @returns {{ pruned: number, remaining: number }}
 */
const pruneBackups = (maxBackups) => {
  // A hand-edited config file (or a caller bypassing route validation) can
  // hand this a 0/null/-1/non-number. Falling back to the default retain
  // count keeps that from deleting every archive (#547).
  const keep = Number.isInteger(maxBackups) && maxBackups >= 1 ? maxBackups : GLOBAL_DEFAULTS.backup.maxBackups;
  const backups = listBackups(); // sorted newest-first
  let pruned = 0;

  if (backups.length > keep) {
    const toDelete = backups.slice(keep);
    for (const backup of toDelete) {
      const result = deleteBackup(backup.filename);
      if (result.success) pruned++;
    }
  }

  return { pruned, remaining: backups.length - pruned };
};

const isSafeFundStateSegment = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);

/**
 * Return the configured exchange/pair identities without reading the live
 * config cache. The snapshot is deliberately derived from configuration so a
 * fund directory that is no longer configured is never copied back into the
 * recovery set by accident.
 * @param {Object} config
 * @returns {Array<{exchange: string, pair: string}>}
 */
const configuredFundIdentities = (config) => Object.entries(config?.exchanges || {}).flatMap(([exchange, block]) =>
  Object.keys(normalizeExchangeBlock(block).pairs || {}).map((pair) => ({ exchange, pair }))
);

/**
 * Read a fund-state snapshot manifest and reject malformed snapshots before
 * they can be listed or restored.
 * @param {string} snapshotDir
 * @returns {{ok: true, manifest: Object} | {ok: false, error: string}}
 */
const readFundStateManifest = (snapshotDir) => {
  const read = readJsonFile(path.join(snapshotDir, FUND_STATE_MANIFEST_FILENAME));
  if (!read.ok) return read;
  const manifest = read.value;
  if (!manifest || Array.isArray(manifest) || manifest.manifestVersion !== FUND_STATE_MANIFEST_VERSION
    || typeof manifest.snapshotId !== 'string' || !Array.isArray(manifest.funds)) {
    return { ok: false, error: `${FUND_STATE_MANIFEST_FILENAME} is malformed or unsupported` };
  }
  return { ok: true, manifest };
};

/**
 * Calculate a snapshot's size without following symlinks.
 * @param {string} root
 * @returns {number}
 */
const directorySizeBytes = (root) => {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
};

/**
 * List the hourly fund-state snapshots, newest first.
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}}} [options]
 * @returns {Array<{snapshotId: string, createdAt: string, funds: Array<Object>, sizeBytes: number}>}
 */
const listFundStateBackups = ({ paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  if (!fs.existsSync(paths.fundStateBackupsDir)) return [];

  return fs.readdirSync(paths.fundStateBackupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafeFundStateSegment(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => {
      const snapshotDir = path.join(paths.fundStateBackupsDir, entry.name);
      const parsed = readFundStateManifest(snapshotDir);
      if (!parsed.ok) return null;
      const { manifest } = parsed;
      if (manifest.snapshotId !== entry.name || !isSafeFundStateSegment(manifest.snapshotId)) return null;
      return {
        snapshotId: manifest.snapshotId,
        createdAt: manifest.createdAt,
        funds: manifest.funds,
        sizeBytes: directorySizeBytes(snapshotDir),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

/**
 * Epoch ms of the newest valid archive, or null when none exist. Anchors the schedule.
 * @returns {number | null}
 */
const getNewestBackupTime = () => {
  ensureBackupsDir();
  const candidates = [];
  for (const filename of fs.readdirSync(BACKUPS_DIR)) {
    if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) continue;
    const filePath = path.join(BACKUPS_DIR, filename);
    const stats = fs.lstatSync(filePath);
    if (stats.isFile()) candidates.push({ filePath, stats, mtimeMs: Math.round(stats.mtimeMs) });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Only the newest candidates are integrity-tested (not every retained ZIP), and
  // verdicts are cached so a corrupt partial never anchors the schedule nor re-tests.
  for (const { filePath, stats, mtimeMs } of candidates) {
    if (isArchiveListable(filePath, stats)) return mtimeMs;
  }
  return null;
};

/**
 * Epoch ms of the newest fund-state snapshot, or null when none exist.
 * @returns {number | null}
 */
const getNewestFundStateBackupTime = () => {
  const newest = listFundStateBackups()[0];
  const time = newest ? Date.parse(newest.createdAt) : NaN;
  return Number.isNaN(time) ? null : time;
};

/**
 * Prune hourly fund-state snapshots independently from the full archive
 * retention policy.
 * @param {number} [maxBackups]
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}}} [options]
 * @returns {{pruned: number, remaining: number}}
 */
const pruneFundStateBackups = (maxBackups, { paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const keep = Number.isInteger(maxBackups) && maxBackups >= 1
    ? maxBackups
    : GLOBAL_DEFAULTS.backup.fundStateMaxBackups;
  const backups = listFundStateBackups({ paths: pathOverrides });
  let pruned = 0;
  for (const backup of backups.slice(keep)) {
    fs.rmSync(path.join(paths.fundStateBackupsDir, backup.snapshotId), { recursive: true, force: true });
    pruned++;
  }
  return { pruned, remaining: backups.length - pruned };
};

/**
 * Copy the small set of non-reconstructable per-fund state files into a
 * separate rolling snapshot. These snapshots live under data/backups, so
 * deleting a fund directory cannot delete its recovery point.
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}, now?: Date, maxBackups?: number}} [options]
 * @returns {{success: boolean, snapshotId?: string, createdAt?: string, funds?: Array<Object>, files?: number, sizeBytes?: number, pruned?: number, remaining?: number, error?: string}}
 */
const createFundStateBackup = ({ paths: pathOverrides, now = new Date(), maxBackups } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const effective = readEffectiveConfig(paths);
  if (!effective.ok) return { success: false, error: effective.error };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { success: false, error: 'Invalid snapshot time' };

  const identities = configuredFundIdentities(effective.config);
  const unsafe = identities.find(({ exchange, pair }) => !isSafeFundStateSegment(exchange) || !isSafeFundStateSegment(pair));
  if (unsafe) return { success: false, error: `Cannot snapshot unsafe fund path ${unsafe.exchange}/${unsafe.pair}` };

  ensureBackupsDir(paths.backupsDir);
  const createdAt = now.toISOString();
  let snapshotId = `fund-state-${now.getTime()}`;
  let suffix = 0;
  while (fs.existsSync(path.join(paths.fundStateBackupsDir, snapshotId))) snapshotId = `fund-state-${now.getTime()}-${++suffix}`;

  const stageDir = fs.mkdtempSync(path.join(paths.backupsDir, '.fund-state-stage-'));
  const funds = [];
  const snapshotDirs = new Set([stageDir]);
  const publishedPath = path.join(paths.fundStateBackupsDir, snapshotId);
  let published = false;
  let files = 0;
  try {
    for (const { exchange, pair } of identities) {
      const sourceDir = path.join(paths.dataDir, exchange, pair);
      const copied = [];
      for (const name of FUND_STATE_SNAPSHOT_FILENAMES) {
        const source = path.join(sourceDir, name);
        if (!fs.existsSync(source)) continue;
        const stat = fs.lstatSync(source);
        if (!stat.isFile()) continue;
        const target = path.join(stageDir, exchange, pair, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        fsyncFile(target);
        for (let dir = path.dirname(target); dir !== stageDir; dir = path.dirname(dir)) snapshotDirs.add(dir);
        copied.push(name);
        files++;
      }
      if (copied.length > 0) funds.push({ exchange, pair, files: copied });
    }

    if (files === 0) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return { success: true, createdAt, funds: [], files: 0, pruned: 0 };
    }

    fs.writeFileSync(path.join(stageDir, FUND_STATE_MANIFEST_FILENAME), JSON.stringify({
      manifestVersion: FUND_STATE_MANIFEST_VERSION,
      snapshotId,
      createdAt,
      funds,
    }, null, 2), { mode: 0o600 });
    fsyncFile(path.join(stageDir, FUND_STATE_MANIFEST_FILENAME));
    // Persist the whole staged tree, children before parents, before exposing it.
    for (const dir of [...snapshotDirs].sort((a, b) => b.length - a.length)) fsyncDir(dir);
    fs.mkdirSync(paths.fundStateBackupsDir, { recursive: true });
    fs.renameSync(stageDir, publishedPath);
    published = true;
    // Rename crosses directories; persist both parents and any new ancestors.
    fsyncDir(paths.fundStateBackupsDir);
    fsyncDir(paths.backupsDir);
    fsyncDir(paths.dataDir);
  } catch (error) {
    fs.rmSync(published ? publishedPath : stageDir, { recursive: true, force: true });
    return { success: false, error: `Fund-state snapshot failed: ${error.message}` };
  }

  const pruned = pruneFundStateBackups(maxBackups, { paths: pathOverrides });
  return {
    success: true,
    snapshotId,
    createdAt,
    funds,
    files,
    sizeBytes: directorySizeBytes(path.join(paths.fundStateBackupsDir, snapshotId)),
    pruned: pruned.pruned,
    remaining: pruned.remaining,
  };
};

/**
 * Restore one fund from a rolling state snapshot through the same durable
 * transactional applier used by full archives.
 * @param {string} snapshotId
 * @param {string} exchange
 * @param {string} pair
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}, logger?: Object}} [options]
 * @returns {{success: boolean, filesRestored?: number, error?: string, code?: string, rolledBack?: boolean, recovery?: Object}}
 */
const restoreFundStateBackup = (snapshotId, exchange, pair, { paths: pathOverrides, logger = SILENT_LOGGER } = {}) => {
  if (!isSafeFundStateSegment(snapshotId) || !isSafeFundStateSegment(exchange) || !isSafeFundStateSegment(pair)) {
    return { success: false, error: 'Invalid fund-state snapshot or fund identity' };
  }
  const paths = resolvePaths(pathOverrides);
  const snapshotDir = path.join(paths.fundStateBackupsDir, snapshotId);
  let stat;
  try {
    stat = fs.lstatSync(snapshotDir);
  } catch (error) {
    return { success: false, error: error?.code === 'ENOENT' ? 'Fund-state snapshot not found' : error.message };
  }
  if (!stat.isDirectory()) return { success: false, error: 'Fund-state snapshot is invalid' };

  const parsed = readFundStateManifest(snapshotDir);
  if (!parsed.ok) return { success: false, error: parsed.error };
  if (parsed.manifest.snapshotId !== snapshotId) return { success: false, error: 'Fund-state snapshot identity mismatch' };
  const fund = parsed.manifest.funds.find((entry) => entry.exchange === exchange && entry.pair === pair);
  if (!fund || !Array.isArray(fund.files) || fund.files.length === 0) {
    return { success: false, error: `Snapshot does not contain state for ${exchange}/${pair}` };
  }

  const stageDir = fs.mkdtempSync(path.join(paths.dataDir, STAGE_PREFIX));
  try {
    for (const name of fund.files) {
      if (!FUND_STATE_SNAPSHOT_FILENAMES.includes(name)) throw new Error(`Snapshot contains an unsupported state file: ${name}`);
      const source = path.join(snapshotDir, exchange, pair, name);
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile()) throw new Error(`Snapshot state file is not a regular file: ${name}`);
      const target = path.join(stageDir, exchange, pair, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    return { success: false, error: `Fund-state restore staging failed: ${error.message}` };
  }

  const applied = applyStagedFiles({ dataDir: paths.dataDir, stageDir, filename: `${snapshotId}/${exchange}/${pair}`, logger });
  if (!applied.success && applied.rolledBack !== false) fs.rmSync(stageDir, { recursive: true, force: true });
  return applied;
};

/**
 * Read an archive's manifest without extracting the archive.
 * @param {string} zipPath
 * @returns {{present: boolean, manifest?: Object, error?: string}}
 */
const readArchiveManifest = (zipPath) =>
  parseManifestRead(spawnSync('unzip', ['-p', zipPath, MANIFEST_FILENAME], { timeout: SPAWN_TIMEOUT_MS }));

function parseManifestRead(result) {
  if (result.error) return { present: false, error: result.error.message };
  const raw = result.stdout ? result.stdout.toString().trim() : '';
  // `unzip -p` exits non-zero (11) when the entry is absent — a legacy archive.
  if (result.status !== 0 || !raw) return { present: false };
  try {
    return { present: true, manifest: JSON.parse(raw) };
  } catch (err) {
    return { present: true, error: jsonReadError(err, MANIFEST_FILENAME).message };
  }
}

/**
 * Validate a manifest envelope and hand back its configuration snapshot.
 * @param {*} manifest
 * @returns {{ok: true, snapshot: Object, createdAt?: string} | {ok: false, error: string}}
 */
const readManifestSnapshot = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: `${MANIFEST_FILENAME} is malformed (not an object)` };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    return {
      ok: false,
      error: `Backup manifest version ${JSON.stringify(manifest.manifestVersion)} is not supported by this build (expected ${MANIFEST_VERSION}) — upgrade critical-mass before restoring this archive`,
    };
  }
  return {
    ok: true,
    snapshot: manifest.config,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : undefined,
  };
};

/**
 * Describe what a restore of `filename` would do to the destination's
 * configuration, without touching a single destination file.
 *
 * @param {string} filename - Backup filename
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}}} [options]
 * @returns {{success: boolean, filename?: string, legacy?: boolean, compatible?: boolean,
 *   manifestVersion?: number|null, snapshotVersion?: number|null,
 *   snapshotFieldRevision?: number|null, droppedFields?: Array<string>,
 *   createdAt?: string, funds?: Array<Object>, error?: string, code?: string}}
 */
const inspectBackup = (filename, { paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveArchivePath(filename, paths.backupsDir);
  if (!resolved.ok) return { success: false, error: resolved.error };

  const read = readArchiveManifest(resolved.zipPath);
  if (read.error) {
    return { success: true, filename, legacy: !read.present, compatible: false, manifestVersion: null, funds: [], removedFunds: [], error: read.error };
  }
  if (!read.present) {
    const destination = readEffectiveConfig(paths);
    return {
      success: true,
      filename,
      legacy: true,
      compatible: false,
      manifestVersion: null,
      funds: [],
      removedFunds: [],
      ...describeLayoutTranslation({
        zipPath: resolved.zipPath,
        snapshot: null,
        destinationConfig: destination.ok ? destination.config : {},
      }),
      code: 'legacy-archive-missing-base',
      error: `This archive predates configuration manifests, so it does not carry the fund configuration it was taken with. Restoring it replays data files only — the destination keeps its OWN config.json, which may name a different pair or allocation.`,
    };
  }

  const envelope = readManifestSnapshot(read.manifest);
  if (!envelope.ok) {
    return { success: true, filename, legacy: false, compatible: false, manifestVersion: read.manifest?.manifestVersion ?? null, funds: [], removedFunds: [], error: envelope.error };
  }

  const effective = readEffectiveConfig(paths);
  if (!effective.ok) return { success: false, error: effective.error };

  const rebuilt = reconstructConfigOverride({
    snapshot: envelope.snapshot,
    baseConfig: effective.base,
    destinationGlobal: effective.config.global,
  });

  const funds = [];
  for (const [exchange, block] of Object.entries(envelope.snapshot?.exchanges || {})) {
    for (const [pair, fund] of Object.entries(block?.pairs || {})) {
      funds.push({
        exchange,
        pair,
        productId: fund?.productId ?? pair,
        totalAllocation: fund?.totalAllocation ?? null,
        enabled: fund?.enabled === true,
        dryRun: fund?.dryRun !== false,
      });
    }
  }

  // What restoring this archive would remove from the destination — computed
  // against the FULL effective config, so a fund defined only in this
  // machine's data/config.json override is disclosed too (issue #533).
  const removedFunds = buildRemovedFundsReport(
    paths.dataDir,
    diffSnapshotAgainstConfig({ snapshot: envelope.snapshot, effectiveConfig: effective.config }),
  );

  return {
    success: true,
    filename,
    legacy: false,
    compatible: rebuilt.ok,
    manifestVersion: MANIFEST_VERSION,
    snapshotVersion: envelope.snapshot?.version ?? null,
    // An archive from a newer build stays COMPATIBLE (#567): the settings this
    // build has no concept of are listed here as a pre-restore warning instead
    // of blocking the whole restore.
    snapshotFieldRevision: Number.isInteger(envelope.snapshot?.fieldRevision) ? envelope.snapshot.fieldRevision : null,
    droppedFields: rebuilt.droppedFields ?? [],
    createdAt: envelope.createdAt,
    funds,
    removedFunds,
    ...describeLayoutTranslation({
      zipPath: resolved.zipPath,
      snapshot: envelope.snapshot,
      destinationConfig: effective.config,
    }),
    ...(rebuilt.ok ? {} : { error: rebuilt.error }),
  };
};

/**
 * Restore a backup by extracting files to data directory.
 *
 * Skips keys files and the backups directory, and rebuilds `data/config.json`
 * from the archive manifest so the destination reproduces the archived funds
 * rather than its own base defaults. Every failure mode below is decided
 * BEFORE any destination file is written (issue #430).
 *
 * @param {string} filename - Backup filename to restore
 * @param {Object} [options]
 * @param {{dataDir?: string, baseConfigFile?: string}} [options.paths] - Path overrides (tests)
 * @param {Object|null} [options.legacyBaseConfig] - The SOURCE machine's base config.json,
 *   required to make a manifest-less (legacy) archive's configuration portable.
 * @param {boolean} [options.acceptLegacyWithoutBase] - Explicit operator acknowledgement
 *   that a legacy archive is being restored as data-only, keeping destination config.
 * @param {boolean} [options.acceptFundRemoval] - Explicit operator acknowledgement that
 *   funds this machine currently runs but the archive does not carry will be removed
 *   from the destination configuration (issue #533).
 * @param {{info: Function, warn: Function, error: Function}} [options.logger] - Context logger
 * @returns {{ success: boolean, filesRestored?: number, configRestored?: boolean,
 *   legacy?: boolean, droppedFields?: Array<string>, error?: string, code?: string,
 *   rolledBack?: boolean, recovery?: Object }}
 */
const restoreBackup = (filename, { paths: pathOverrides, legacyBaseConfig = null, acceptLegacyWithoutBase = false, acceptFundRemoval = false, logger = SILENT_LOGGER } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveArchivePath(filename, paths.backupsDir);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { zipPath } = resolved;

  if (legacyBaseConfig !== null && (typeof legacyBaseConfig !== 'object' || Array.isArray(legacyBaseConfig))) {
    return { success: false, code: 'legacy-base-invalid', error: 'legacyBaseConfig must be the source machine\'s config.json object' };
  }

  // Destination state read before anything is extracted, so the reconstruction
  // below can preserve this machine's credentials.
  const destination = readEffectiveConfig(paths);
  if (!destination.ok) return { success: false, code: 'destination-config-unreadable', error: destination.error };

  // Create temp directory for extraction
  const tempDir = path.join(paths.dataDir, `${STAGE_PREFIX}${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const abort = (error, code) => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, error, ...(code ? { code } : {}) };
  };

  // Extract to temp directory
  const extractResult = spawnSync('unzip', [
    '-o',               // Overwrite without prompting
    '-q',               // Quiet
    zipPath,
    '-d', tempDir,
  ], {
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (extractResult.error || extractResult.status !== 0) {
    return abort(extractResult.error
      ? extractResult.error.message
      : (extractResult.stderr ? extractResult.stderr.toString().trim() : 'Unknown unzip error'));
  }

  // ---- Decide the configuration outcome before mutating the destination ----
  const manifestPath = path.join(tempDir, MANIFEST_FILENAME);
  const legacy = !fs.existsSync(manifestPath);
  let snapshot = null;

  if (!legacy) {
    const manifestRead = readJsonFile(manifestPath);
    if (!manifestRead.ok) return abort(manifestRead.error, 'manifest-malformed');
    const envelope = readManifestSnapshot(manifestRead.value);
    if (!envelope.ok) return abort(envelope.error, 'manifest-unsupported-version');
    snapshot = envelope.snapshot;
  } else if (legacyBaseConfig) {
    // The archive carries only the base-relative override; pairing it with the
    // source's base reconstructs what the source machine actually ran.
    const archivedOverride = readJsonFile(path.join(tempDir, 'config.json'));
    if (!archivedOverride.ok) return abort(archivedOverride.error, 'manifest-malformed');
    snapshot = buildConfigSnapshot(deepMerge(legacyBaseConfig, archivedOverride.value || {}));
  } else if (!acceptLegacyWithoutBase) {
    return abort(
      `This archive has no ${MANIFEST_FILENAME}, so it does not carry the configuration it was taken with. `
      + 'Supply the source machine\'s config.json (legacyBaseConfig) to make it portable, or explicitly accept a '
      + 'data-only restore (acceptLegacyWithoutBase) that keeps this machine\'s current fund configuration. '
      + 'No files were changed.',
      'legacy-archive-missing-base',
    );
  }

  let override = null;
  /** @type {Array<string>} */
  let droppedFields = [];
  if (snapshot) {
    const rebuilt = reconstructConfigOverride({
      snapshot,
      baseConfig: destination.base,
      destinationGlobal: destination.config.global,
    });
    if (!rebuilt.ok) return abort(rebuilt.error, 'config-snapshot-invalid');
    override = rebuilt.override;
    droppedFields = rebuilt.droppedFields ?? [];
    if (droppedFields.length > 0) {
      logger.warn(`⚠️ 💾 Restore ${filename}: archive written by a newer build — ignoring ${droppedFields.length} setting(s) this build has no concept of, destination keeps its own defaults (${droppedFields.join(', ')})`, {
        action: 'restore-dropped-fields', filename, droppedFields, count: droppedFields.length,
      });
    }

    // The reconstruction above already tombstones base-defined pairs the
    // snapshot lacks; this catches every fund the destination actually runs
    // (base OR override-defined) that would disappear, and refuses unless the
    // operator has explicitly accepted it — mirroring acceptLegacyWithoutBase
    // above rather than inventing a second idiom (issue #533).
    const removedFunds = diffSnapshotAgainstConfig({ snapshot, effectiveConfig: destination.config });
    if (removedFunds.length > 0 && !acceptFundRemoval) {
      const describe = removedFunds.map(({ exchange, pair }) => `${exchange}/${pair}`).join(', ');
      return abort(
        `Restoring this archive would remove ${removedFunds.length} fund${removedFunds.length === 1 ? "" : "s"} this machine currently runs that the archive does not carry (${describe}). `
        + 'They may still hold on-disk state or a live exchange order. Pass acceptFundRemoval to proceed. No files were changed.',
        'fund-removal-unacknowledged',
      );
    }
  }

  if (override) {
    // Stage the reconstruction OVER the archived config.json rather than writing
    // it after the copy: the archived diff was relative to the SOURCE's base and
    // is meaningless against this one, and staging it makes the config
    // replacement part of the same all-or-nothing application below (#431).
    // 0600 because an override can hold secrets (Telegram token) — matching
    // writeUserConfigFile's default for a brand-new file.
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(override, null, 2), { mode: 0o600 });
  }

  // A source baseline is not portable: the reconstructed override is relative
  // to THIS base. Stage both in the same rollback transaction, including for
  // legacy data-only restores, which retain the destination configuration.
  fs.writeFileSync(path.join(tempDir, BASE_SNAPSHOT_FILENAME), JSON.stringify(destination.base, null, 2), { mode: 0o600 });
  fs.chmodSync(path.join(tempDir, BASE_SNAPSHOT_FILENAME), 0o600);

  // ---- Translate a pre-multi-pair archive into the per-fund layout -------
  // Archives predating the multi-pair release hold their per-fund files at
  // `<exchange>/`, where nothing reads them any more. Relocating them inside
  // the STAGING tree — before the applier collects its set — puts the
  // translation inside the same all-or-nothing transaction as every other
  // replacement (#431): the journal records the translated destinations, so a
  // rollback reverts them, and a destination that already holds per-fund files
  // is still replaced rather than shadowed (issue #541).
  const layout = planLayoutTranslation({
    exchangeFiles: collectExchangeFilesFromDir(tempDir),
    snapshot,
    destinationConfig: destination.config,
  });
  if (layout.unresolvable.length > 0) {
    return abort(
      `This archive predates the multi-pair layout and holds per-fund files at the exchange level for ${layout.unresolvable.join(', ')}, `
      + 'but neither the archive nor this machine names a fund for those exchanges, so there is no directory to restore them into. '
      + 'Configure the fund before restoring. No files were changed.',
      'legacy-layout-unresolvable-pair',
    );
  }
  for (const { exchange, pair } of layout.translations) {
    const { moved, skipped } = normalizeExchangeTreeToPairs({ root: tempDir, exchange, pair });
    logger.info(`ℹ️ 💾 Restore translated legacy layout ${exchange}/ → ${exchange}/${pair}: ${moved.length} file(s) relocated, ${skipped.length} skipped (${moved.join(', ') || 'none'})`, {
      action: 'restore-legacy-layout', filename, exchange, pair, moved: moved.length, skipped: skipped.length,
    });
  }

  // ---- Past this point the destination is mutated ----
  // Transactional: the staged set is validated in full, every destination it
  // replaces is copied aside under a durable rollback journal, and each
  // replacement is a same-directory temp-file + rename. A failure reverts every
  // destination; a crash leaves the journal for startup recovery (#431).
  const applied = applyStagedFiles({
    dataDir: paths.dataDir,
    stageDir: tempDir,
    filename,
    logger,
    // Skip the backups directory, root credential files, key files and the
    // archive's own metadata.
    skip: (name, isRoot) => name === 'backups'
      || (isRoot && (name === CONFIG_LOCK_DIR || name.startsWith(`${BASE_SNAPSHOT_FILENAME}.`)))
      || name.endsWith('-keys.json')
      || (isRoot && ROOT_CREDENTIAL_FILES.includes(name))
      || (isRoot && (name === MANIFEST_FILENAME || (legacy && !override && name === 'config.json'))),
  });

  // The applier cleans staging itself once a journal exists; this covers the
  // earlier refusals (invalid staged set, snapshot or journal write failure),
  // which return before one is written.
  if (applied.success || applied.rolledBack) fs.rmSync(tempDir, { recursive: true, force: true });

  if (!applied.success) {
    return { success: false, code: applied.code, error: applied.error, rolledBack: applied.rolledBack, ...(applied.recovery ? { recovery: applied.recovery } : {}) };
  }

  // Only now can a reader see the new config.json.
  if (override) invalidateConfigCache();

  return { success: true, filesRestored: applied.filesRestored, configRestored: Boolean(override), legacy, droppedFields };
};

module.exports = {
  createBackup,
  createFundStateBackup,
  listBackups,
  listFundStateBackups,
  getNewestBackupTime,
  getNewestFundStateBackupTime,
  deleteBackup,
  pruneBackups,
  pruneFundStateBackups,
  restoreBackup,
  restoreFundStateBackup,
  inspectBackup,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
};
