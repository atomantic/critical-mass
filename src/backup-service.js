// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Archive creation, listing and the schedule anchor use async spawn for zip/unzip;
 * restore uses spawnSync.
 * Excludes credentials, live configuration, and the backup directory from archives.
 *
 * This module owns create/list/prune and is the public entry point: the rest
 * lives in backup-common (shared paths and helpers), backup-archive (zip
 * parsing and validation), backup-layout-translation (legacy layouts),
 * fund-state-snapshots (hourly per-fund snapshots) and backup-restore (full
 * restore), whose public API is re-exported below.
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
const { fsyncDir } = require('./fsync-dir');
const { fsyncFile } = require('./durable-write');
const { STAGE_PREFIX, ORIGINALS_PREFIX, JOURNAL_FILENAME, OWNER_PREFIX } = require('./restore-apply');
const { LOCK_FILENAME: LEGACY_MIGRATION_LOCK } = require('./legacy-namespace-migration');
const { buildConfigSnapshot, GLOBAL_DEFAULTS } = require('./config-utils');
const {
  BACKUPS_DIR,
  ensureBackupsDir,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  PLACEMENT_INTENT_LOCK_NAMES,
  readEffectiveConfig,
  resolveArchivePath,
  resolvePaths,
  ROOT_CREDENTIAL_FILES,
  SCORECARD_MAINTENANCE_LOCK,
  spawnAsync,
} = require('./backup-common');
const {
  checkFundStateRestorePreconditions,
  createFundStateBackup,
  getNewestFundStateBackupTime,
  listFundStateBackups,
  pruneFundStateBackups,
  restoreFundStateBackup,
} = require('./fund-state-snapshots');
const { validateBackupArchiveAsync } = require('./backup-archive');
const { checkRestorePreconditions, inspectBackup, restoreBackup } = require('./backup-restore');

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
    // A staging dir left in the OS temp dir is harmless; a throw here would
    // strand the archive this function exists to clean up.
    if (stagingDir) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  if (result.error || result.status !== 0) {
    const error = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : 'Unknown zip error');
    return { success: false, error: `Failed to write backup manifest: ${error}` };
  }
  return { success: true };
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
 * cache removes. Restore does not use this cache or validateBackupArchiveAsync:
 * it relies on the CRC checks `unzip` performs while extracting.
 */
const archiveValidityCache = new Map();

const archiveValidityKey = (filePath, stats) => `${filePath}:${stats.mtimeMs}:${stats.size}`;

/** In-flight async validations keyed like archiveValidityCache, so concurrent listings share one test. */
const pendingArchiveValidity = new Map();

/**
 * Cached validity of an archive file in its current state (legacy pre-manifest
 * archives are admitted, as listing and scheduling always did). After a restart
 * every retained archive is cold, and testing them synchronously would stall the
 * gateway for seconds per archive (IPC requests time out meanwhile).
 * @param {string} filePath
 * @param {import('fs').Stats} stats
 * @returns {Promise<boolean>}
 */
const isArchiveListableAsync = async (filePath, stats) => {
  const key = archiveValidityKey(filePath, stats);
  if (archiveValidityCache.has(key)) return archiveValidityCache.get(key);
  if (!pendingArchiveValidity.has(key)) {
    const pending = validateBackupArchiveAsync(filePath, { allowLegacy: true })
      .then(({ ok }) => {
        archiveValidityCache.set(key, ok);
        return ok;
      })
      .finally(() => pendingArchiveValidity.delete(key));
    pendingArchiveValidity.set(key, pending);
  }
  return pendingArchiveValidity.get(key);
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
    ...ROOT_CREDENTIAL_FILES.map((name) => `${name}.*.tmp`),
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
    `${OWNER_PREFIX}*`, `${OWNER_PREFIX}*/*`,
    `${STAGE_PREFIX}*`, `${STAGE_PREFIX}*/*`,
    `${ORIGINALS_PREFIX}*`, `${ORIGINALS_PREFIX}*/*`,
    '*.restore-tmp', '*/*.restore-tmp', // Orphaned atomic-replace temp files
    // Legacy namespace migration ownership (issue #971): a captured lock is
    // meaningless on another machine or after a restore.
    `${LEGACY_MIGRATION_LOCK}*`,
    // Scorecard maintenance ownership (the lock dir, its owner.json, and any
    // stale-reclaim aside copy); a restored lock would stall UpDown for 2 minutes.
    `${SCORECARD_MAINTENANCE_LOCK}*`,
  ];

  if (!includePriceCache) {
    excludes.push('*-price-cache*.json');
    excludes.push('*/*-price-cache*.json');
  }

  // Preserve the old exclusions' cross-directory wildcard behavior, while
  // -ws lets the ownership patterns pin their first two path components.
  const ownershipExcludes = PLACEMENT_INTENT_LOCK_NAMES.flatMap((name) => [
    `*/*/${name}`, `*/*/${name}/**`,
  ]);
  const excludeArgs = [...excludes.map((pattern) => pattern.replace(/\*/g, '**')), ...ownershipExcludes]
    .flatMap((pattern) => ['-x', pattern]);

  // Create zip from data directory
  const result = await spawnAsync('zip', [
    '-r',               // Recursive
    '-q',               // Quiet
    '-ws',              // A single wildcard cannot cross path components
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
 * Recover an archive's creation time from its stable filename timestamp.
 * Legacy or hand-named archives retain their filesystem time fallback.
 * @param {string} filename
 * @param {import('fs').Stats} stats
 * @returns {number}
 */
const archiveCreatedAtMs = (filename, stats) => {
  const match = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(filename);
  if (!match) return stats.mtimeMs;

  const [, date, hours, minutes, seconds] = match;
  const iso = `${date}T${hours}:${minutes}:${seconds}.000Z`;
  const timestamp = Date.parse(iso);
  // Date.parse accepts some out-of-range dates by normalizing them. Require an
  // exact round-trip so malformed names safely use their filesystem time.
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso) return stats.mtimeMs;
  return timestamp;
};

/** Newest-first archive ordering with stable tie breakers. */
const compareArchivesNewestFirst = (a, b) =>
  b.createdAtMs - a.createdAtMs
  || b.mtimeMs - a.mtimeMs
  || b.filename.localeCompare(a.filename);

/**
 * List all backups sorted newest-first
 * @returns {Promise<Array<{ filename: string, createdAt: string, sizeBytes: number }>>}
 */
const listBackups = async () => {
  ensureBackupsDir();

  const liveKeys = new Set();
  const candidates = [];
  for (const filename of fs.readdirSync(BACKUPS_DIR)) {
    if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) continue;
    const filePath = path.join(BACKUPS_DIR, filename);
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile()) continue;
      liveKeys.add(archiveValidityKey(filePath, stats));
      candidates.push({ filename, filePath, stats });
    } catch (_error) {
      // Removed between readdir and lstat.
    }
  }
  pruneArchiveValidityCache(liveKeys);

  const backups = [];
  // One archive at a time: a cold listing after a restart must not fan out an
  // unzip -tq per retained archive at once.
  for (const { filename, filePath, stats } of candidates) {
    if (!(await isArchiveListableAsync(filePath, stats))) continue;
    const createdAtMs = archiveCreatedAtMs(filename, stats);
    backups.push({ filename, createdAtMs, mtimeMs: stats.mtimeMs, createdAt: new Date(createdAtMs).toISOString(), sizeBytes: stats.size });
  }
  return backups.sort(compareArchivesNewestFirst).map(({ filename, createdAt, sizeBytes }) => ({ filename, createdAt, sizeBytes }));
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
 * @returns {Promise<{ pruned: number, remaining: number }>}
 */
const pruneBackups = async (maxBackups) => {
  // A hand-edited config file (or a caller bypassing route validation) can
  // hand this a 0/null/-1/non-number. Falling back to the default retain
  // count keeps that from deleting every archive (#547).
  const keep = Number.isInteger(maxBackups) && maxBackups >= 1 ? maxBackups : GLOBAL_DEFAULTS.backup.maxBackups;
  const backups = await listBackups(); // sorted newest-first
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

/**
 * Epoch ms of the newest valid archive, or null when none exist. Anchors the
 * schedule. A cold gateway start has an empty verdict cache, so only the first
 * look at each candidate runs `unzip` tests, and never on the event loop.
 * Only the newest candidates are integrity-tested (not every retained ZIP), and
 * verdicts are cached so a corrupt partial never anchors the schedule nor re-tests.
 * @returns {Promise<number | null>}
 */
const getNewestBackupTimeAsync = async () => {
  ensureBackupsDir();
  const candidates = [];
  for (const filename of fs.readdirSync(BACKUPS_DIR)) {
    if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) continue;
    const filePath = path.join(BACKUPS_DIR, filename);
    const stats = fs.lstatSync(filePath);
    if (stats.isFile()) candidates.push({ filename, filePath, stats, createdAtMs: archiveCreatedAtMs(filename, stats), mtimeMs: stats.mtimeMs });
  }
  candidates.sort(compareArchivesNewestFirst);
  for (const { filePath, stats, createdAtMs } of candidates) {
    if (await isArchiveListableAsync(filePath, stats)) return Math.round(createdAtMs);
  }
  return null;
};

module.exports = {
  createBackup,
  createFundStateBackup,
  listBackups,
  listFundStateBackups,
  getNewestBackupTimeAsync,
  getNewestFundStateBackupTime,
  deleteBackup,
  pruneBackups,
  pruneFundStateBackups,
  restoreBackup,
  restoreFundStateBackup,
  checkRestorePreconditions,
  checkFundStateRestorePreconditions,
  inspectBackup,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
};
