// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Archive creation, listing and the schedule anchor use async spawn for zip/unzip;
 * restore uses spawnSync.
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
const { spawnSync } = require('child_process');
const { classifyPayloadPath } = require('./persisted-payload-validation');
const { applyStagedFiles, STAGE_PREFIX, ORIGINALS_PREFIX, JOURNAL_FILENAME, OWNER_PREFIX } = require('./restore-apply');
const { LOCK_FILENAME: LEGACY_MIGRATION_LOCK, LEGACY_EXCHANGE, discoverLegacyArtifacts } = require('./legacy-namespace-migration');
const {
  buildConfigSnapshot,
  reconstructConfigOverride,
  diffSnapshotAgainstConfig,
  invalidateConfigCache,
  deepMerge,
  GLOBAL_DEFAULTS,
} = require('./config-utils');
const { normalizeExchangeTreeToPairs, normalizeLegacyRootToNamespace } = require('./migration');
const {
  BACKUPS_DIR,
  ensureBackupsDir,
  isPlacementIntentOwnershipPath,
  isRootCredentialArtifact,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  PLACEMENT_INTENT_LOCK_NAMES,
  readEffectiveConfig,
  readJsonFile,
  resolveArchivePath,
  resolvePaths,
  ROOT_CREDENTIAL_FILES,
  SCORECARD_MAINTENANCE_LOCK,
  SILENT_LOGGER,
  SPAWN_TIMEOUT_MS,
  spawnAsync,
  unzipMember,
} = require('./backup-common');
const {
  collectExchangeFilesFromDir,
  collectExchangeFilesFromEntries,
  collectRootFilesFromEntries,
  describeLayoutTranslation,
  findLegacyIntentCollisions,
  findRootCollisions,
  FUND_STATE_FILENAMES,
  intentCollisionError,
  planLayoutTranslation,
  projectedArchivePaths,
  rootCollisionEntries,
} = require('./backup-layout-translation');
const {
  archivedDcaImportRefusal,
  archiveEntryFunds,
  checkFundStateRestorePreconditions,
  checkPersistedPayloads,
  createFundStateBackup,
  dcaImportJournalPaths,
  fundsWithPendingDcaImport,
  getNewestFundStateBackupTime,
  listFundStateBackups,
  listStagedPayloadPaths,
  listTreeFiles,
  pendingDcaImportRefusal,
  planAbsentFundState,
  pruneFundStateBackups,
  restoredArchiveFunds,
  restoreFundStateBackup,
  stageMergedPlacementIntents,
} = require('./fund-state-snapshots');
const {
  checkDestinationAliases,
  checkTailFailure,
  inspectArchivePaths,
  inspectArchivePathsAsync,
  payloadMemberVerdict,
  readArchiveManifest,
  readManifestSnapshot,
  validateBackupArchiveAsync,
} = require('./backup-archive');

/**
 * Whether (exchange, pair) still has fund-scoped state on disk under `dataDir`.
 *
 * Checked directly against `dataDir` rather than through
 * fund-paths.resolveFundDataDir, which resolves against the module-level
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

  const archive = inspectArchivePaths(resolved.zipPath);
  if (!archive.ok) return { success: false, code: archive.code, error: archive.error };
  const inspectLayout = (snapshot, destinationConfig) => {
    const layout = describeLayoutTranslation({ zipPath: resolved.zipPath, archive, snapshot, destinationConfig });
    const pathsToWrite = projectedArchivePaths(archive.entries, {
      translations: layout.layoutTranslations,
      rootTranslation: layout.rootTranslation,
    });
    pathsToWrite.push(BASE_SNAPSHOT_FILENAME);
    if (snapshot) pathsToWrite.push('config.json');
    const aliases = checkDestinationAliases(paths.dataDir, pathsToWrite);
    return { layout, aliases };
  };
  const manifestName = archive.members.get(MANIFEST_FILENAME);
  const read = manifestName ? readArchiveManifest(resolved.zipPath, manifestName) : { present: false };
  if (read.error) {
    return { success: true, filename, legacy: !read.present, compatible: false, manifestVersion: null, funds: [], removedFunds: [], error: read.error };
  }
  if (!read.present) {
    const destination = readEffectiveConfig(paths);
    const { layout, aliases } = inspectLayout(null, destination.ok ? destination.config : {});
    if (!aliases.ok) return { success: false, code: aliases.code, error: aliases.error };
    return {
      success: true,
      filename,
      legacy: true,
      compatible: false,
      manifestVersion: null,
      funds: [],
      removedFunds: [],
      ...layout,
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
  const { layout, aliases } = inspectLayout(envelope.snapshot, effective.config);
  if (!aliases.ok) return { success: false, code: aliases.code, error: aliases.error };

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
    ...layout,
    ...(rebuilt.ok ? {} : { error: rebuilt.error }),
  };
};

/**
 * Work out which configuration snapshot a restore would apply, or why it must
 * refuse. Shared by the applier and its pre-flight so both refuse alike.
 * @param {Object} params
 * @param {boolean} params.legacy - The archive has no manifest
 * @param {() => {ok: boolean, value?: any, error?: string}} params.readManifest - Parsed manifest JSON
 * @param {() => {ok: boolean, value?: any, error?: string}} params.readArchivedOverride - Parsed archived config.json (value null when absent)
 * @param {Object|null} params.legacyBaseConfig
 * @param {boolean} params.acceptLegacyWithoutBase
 * @returns {{ok: true, snapshot: Object|null} | {ok: false, code: string, error: string}}
 */
const resolveRestoreSnapshot = ({ legacy, readManifest, readArchivedOverride, legacyBaseConfig, acceptLegacyWithoutBase }) => {
  if (!legacy) {
    const manifestRead = readManifest();
    if (!manifestRead.ok) return { ok: false, code: 'manifest-malformed', error: manifestRead.error };
    const envelope = readManifestSnapshot(manifestRead.value);
    if (!envelope.ok) return { ok: false, code: 'manifest-unsupported-version', error: envelope.error };
    return { ok: true, snapshot: envelope.snapshot };
  }
  if (legacyBaseConfig) {
    // The archive carries only the base-relative override; pairing it with the
    // source's base reconstructs what the source machine actually ran.
    const archivedOverride = readArchivedOverride();
    if (!archivedOverride.ok) return { ok: false, code: 'manifest-malformed', error: archivedOverride.error };
    return { ok: true, snapshot: buildConfigSnapshot(deepMerge(legacyBaseConfig, archivedOverride.value || {})) };
  }
  if (!acceptLegacyWithoutBase) {
    return {
      ok: false,
      code: 'legacy-archive-missing-base',
      error: `This archive has no ${MANIFEST_FILENAME}, so it does not carry the configuration it was taken with. `
        + 'Supply the source machine\'s config.json (legacyBaseConfig) to make it portable, or explicitly accept a '
        + 'data-only restore (acceptLegacyWithoutBase) that keeps this machine\'s current fund configuration. '
        + 'No files were changed.',
    };
  }
  return { ok: true, snapshot: null };
};

/**
 * Rebuild the destination override from a snapshot and refuse an
 * unacknowledged fund removal.
 *
 * The reconstruction already tombstones base-defined pairs the snapshot lacks;
 * the removal check catches every fund the destination actually runs (base OR
 * override-defined) that would disappear, and refuses unless the operator has
 * explicitly accepted it — mirroring acceptLegacyWithoutBase rather than
 * inventing a second idiom (issue #533).
 * @param {Object} params
 * @param {Object} params.snapshot
 * @param {{config: Object, base: Object}} params.destination - Destination effective + base config
 * @param {boolean} params.acceptFundRemoval
 * @returns {{ok: true, override: Object, droppedFields: Array<string>} | {ok: false, code: string, error: string}}
 */
const planRestoreConfig = ({ snapshot, destination, acceptFundRemoval }) => {
  const rebuilt = reconstructConfigOverride({
    snapshot,
    baseConfig: destination.base,
    destinationGlobal: destination.config.global,
  });
  if (!rebuilt.ok) return { ok: false, code: 'config-snapshot-invalid', error: rebuilt.error };
  const removedFunds = diffSnapshotAgainstConfig({ snapshot, effectiveConfig: destination.config });
  if (removedFunds.length > 0 && !acceptFundRemoval) {
    const describe = removedFunds.map(({ exchange, pair }) => `${exchange}/${pair}`).join(', ');
    return {
      ok: false,
      code: 'fund-removal-unacknowledged',
      error: `Restoring this archive would remove ${removedFunds.length} fund${removedFunds.length === 1 ? "" : "s"} this machine currently runs that the archive does not carry (${describe}). `
        + 'They may still hold on-disk state or a live exchange order. Pass acceptFundRemoval to proceed. No files were changed.',
    };
  }
  return { ok: true, override: rebuilt.override, droppedFields: rebuilt.droppedFields ?? [] };
};

/**
 * @param {string[]} unresolvable - Exchanges with root- or exchange-level fund files and no known pair
 * @returns {string}
 */
const unresolvableLayoutError = (unresolvable) =>
  `This archive predates the multi-pair layout and holds per-fund files at the data root or exchange level for ${unresolvable.join(', ')}, `
  + 'but neither the archive nor this machine names a fund for those exchanges, so there is no directory to restore them into. '
  + 'Configure the fund before restoring. No files were changed.';

/**
 * @param {Array<{artifact: string, existing: string}>} conflicts
 * @returns {string}
 */
const ambiguousLayoutError = (conflicts) =>
  `This archive holds two different generations of the same legacy data (${conflicts.map(({ artifact, existing }) => `${artifact} vs ${existing}`).join(', ')}), `
  + 'and there is no way to tell which one is current. Remove the stale copy from the archive and retry. No files were changed.';

/**
 * Parse JSON read out of an archive entry.
 * @param {Buffer|undefined} raw
 * @param {string} name - Entry name for the diagnostic
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
const parseArchiveJson = (raw, name) => {
  try {
    return { ok: true, value: JSON.parse(raw ? raw.toString() : '') };
  } catch (err) {
    return { ok: false, error: jsonReadError(err, name).message };
  }
};

/**
 * Every refusal `restoreBackup` can make from the archive and the operator's
 * acknowledgements alone — integrity, manifest, legacy acknowledgement, fund
 * removal, legacy layout — decided without extracting the archive or touching a
 * destination file. Restore runs this before it stops any engine, so a request
 * that was always going to be refused leaves every fund running (#1384). The
 * applier still repeats these checks: this only moves the refusal earlier.
 *
 * Async so the full-archive integrity test does not stall the event loop.
 *
 * @param {string} filename - Backup filename
 * @param {Object} [options] - Same acknowledgements as `restoreBackup`
 * @param {{dataDir?: string, baseConfigFile?: string}} [options.paths]
 * @param {Object|null} [options.legacyBaseConfig]
 * @param {boolean} [options.acceptLegacyWithoutBase]
 * @param {boolean} [options.acceptFundRemoval]
 * @returns {Promise<{ok: true} | {ok: false, code?: string, error: string}>}
 */
const checkRestorePreconditions = async (filename, { paths: pathOverrides, legacyBaseConfig = null, acceptLegacyWithoutBase = false, acceptFundRemoval = false } = {}) => {
  if (legacyBaseConfig !== null && (typeof legacyBaseConfig !== 'object' || Array.isArray(legacyBaseConfig))) {
    return { ok: false, code: 'legacy-base-invalid', error: 'legacyBaseConfig must be the source machine\'s config.json object' };
  }
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveArchivePath(filename, paths.backupsDir);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { zipPath } = resolved;

  const destination = readEffectiveConfig(paths);
  if (!destination.ok) return { ok: false, code: 'destination-config-unreadable', error: destination.error };

  const integrity = await spawnAsync('unzip', ['-tq', zipPath]);
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return { ok: false, code: 'archive-corrupt', error: `Archive failed its integrity check: ${integrityFailure.error}. No files were changed.` };
  const archive = await inspectArchivePathsAsync(zipPath);
  if (!archive.ok) return archive;
  const { entries, members } = archive;
  const archivedJournals = dcaImportJournalPaths(entries);
  if (archivedJournals.length > 0) return { ok: false, ...archivedDcaImportRefusal(archivedJournals) };

  const legacy = !members.has(MANIFEST_FILENAME);
  const readEntry = async (name) => (members.has(name) ? spawnAsync('unzip', ['-p', zipPath, unzipMember(members.get(name))]) : null);
  const manifestRaw = legacy ? null : await readEntry(MANIFEST_FILENAME);
  const overrideRaw = legacy && legacyBaseConfig ? await readEntry('config.json') : null;
  const resolvedSnapshot = resolveRestoreSnapshot({
    legacy,
    readManifest: () => parseArchiveJson(manifestRaw?.stdout, MANIFEST_FILENAME),
    readArchivedOverride: () => (overrideRaw ? parseArchiveJson(overrideRaw.stdout, 'config.json') : { ok: true, value: null }),
    legacyBaseConfig,
    acceptLegacyWithoutBase,
  });
  if (!resolvedSnapshot.ok) return resolvedSnapshot;
  const { snapshot } = resolvedSnapshot;

  if (snapshot) {
    const planned = planRestoreConfig({ snapshot, destination, acceptFundRemoval });
    if (!planned.ok) return planned;
  }

  const layout = planLayoutTranslation({
    exchangeFiles: collectExchangeFilesFromEntries(entries),
    rootFiles: collectRootFilesFromEntries(entries),
    snapshot,
    destinationConfig: destination.config,
  });
  if (layout.unresolvable.length > 0) {
    return { ok: false, code: 'legacy-layout-unresolvable-pair', error: unresolvableLayoutError(layout.unresolvable) };
  }
  const bytes = new Map();
  for (const entry of rootCollisionEntries({ entries, rootTranslation: layout.rootTranslation })) {
    const read = await readEntry(entry);
    bytes.set(entry, read.error || read.status !== 0 ? null : read.stdout);
  }
  const conflicts = findRootCollisions({ entries, rootTranslation: layout.rootTranslation, readEntry: (entry) => bytes.get(entry) ?? null });
  if (conflicts.length > 0) {
    return { ok: false, code: 'legacy-layout-ambiguous-generations', error: ambiguousLayoutError(conflicts) };
  }
  const intentConflicts = findLegacyIntentCollisions({ entries, translations: layout.translations });
  if (intentConflicts.length > 0) {
    return { ok: false, code: 'legacy-layout-placement-intents-conflict', error: intentCollisionError(intentConflicts) };
  }
  const pathsToWrite = projectedArchivePaths(entries, layout);
  pathsToWrite.push(BASE_SNAPSHOT_FILENAME);
  if (snapshot) pathsToWrite.push('config.json');
  const aliases = checkDestinationAliases(paths.dataDir, pathsToWrite);
  if (!aliases.ok) return aliases;
  const pending = fundsWithPendingDcaImport(paths.dataDir, archiveEntryFunds(entries, snapshot, layout.translations, layout.rootTranslation));
  if (pending.length > 0) return { ok: false, ...pendingDcaImportRefusal(pending, 'No files were changed.') };

  // Business-format compatibility of the accounting payloads (#1811): the
  // archive is intact, but the readers must be able to cold-start from it.
  // Old root-level files are read at their archive names but validated at the
  // translated paths where restore will place them.
  const rootTargets = new Map((layout.rootTranslation?.files || []).map(({ name, target }) => [name, target]));
  for (const entry of entries) {
    const target = rootTargets.get(entry) || entry;
    if (entry.endsWith('/') || !classifyPayloadPath(target)) continue;
    const verdict = payloadMemberVerdict(entry, target, await readEntry(entry));
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
};

/**
 * Copy the source to a private, excluded staging directory and inspect and
 * extract that same copy. A scheduler, upload, or operator can replace the
 * original archive between calls; validating one generation and extracting
 * another would bypass path and symlink checks.
 */
const extractVerifiedArchive = (sourceZipPath, dataDir, logger) => {
  let pinnedDir = null;
  let stageDir = null;
  try {
    pinnedDir = fs.mkdtempSync(path.join(dataDir, STAGE_PREFIX));
    const pinnedZipPath = path.join(pinnedDir, 'archive.zip');
    fs.copyFileSync(sourceZipPath, pinnedZipPath, fs.constants.COPYFILE_FICLONE);
    const archive = inspectArchivePaths(pinnedZipPath);
    if (!archive.ok) return { ok: false, code: archive.code, error: archive.error };

    stageDir = fs.mkdtempSync(path.join(dataDir, STAGE_PREFIX));
    const extracted = spawnSync('unzip', ['-o', '-q', pinnedZipPath, '-d', stageDir], { timeout: SPAWN_TIMEOUT_MS });
    if (extracted.error || extracted.status !== 0) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      stageDir = null;
      return { ok: false, code: 'archive-corrupt', error: extracted.error
        ? extracted.error.message
        : (extracted.stderr ? extracted.stderr.toString().trim() : 'Unknown unzip error') };
    }
    const inspectTree = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) inspectTree(child);
        else if (!entry.isFile()) throw new Error(`extracted member ${entry.name} is not a regular file`);
      }
    };
    // A second type check protects staging writes even if an extractor uses
    // platform-specific metadata not represented by the ZIP's Unix mode.
    inspectTree(stageDir);
    return { ok: true, stageDir };
  } catch (error) {
    if (stageDir) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* retain for recovery */ }
    }
    return { ok: false, code: 'staging-failed', error: `Could not safely stage the archive: ${error.message}. No files were changed.` };
  } finally {
    if (pinnedDir) {
      try { fs.rmSync(pinnedDir, { recursive: true, force: true }); } catch (error) {
        logger.warn(`⚠️ 💾 Could not remove pinned restore archive: ${error.message}`, { action: 'restore-stage-cleanup', error: error.message });
      }
    }
  }
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
  if (legacyBaseConfig !== null && (typeof legacyBaseConfig !== 'object' || Array.isArray(legacyBaseConfig))) {
    return { success: false, code: 'legacy-base-invalid', error: 'legacyBaseConfig must be the source machine\'s config.json object' };
  }

  const paths = resolvePaths(pathOverrides);
  const resolved = resolveArchivePath(filename, paths.backupsDir);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { zipPath } = resolved;

  // Destination state read before anything is extracted, so the reconstruction
  // below can preserve this machine's credentials.
  const destination = readEffectiveConfig(paths);
  if (!destination.ok) return { success: false, code: 'destination-config-unreadable', error: destination.error };

  const extracted = extractVerifiedArchive(zipPath, paths.dataDir, logger);
  if (!extracted.ok) return { success: false, code: extracted.code, error: extracted.error };
  const tempDir = extracted.stageDir;
  const abort = (error, code) => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, error, ...(code ? { code } : {}) };
  };

  let handedOff = false;
  // Never throws: cleanup failure must not mask the restore outcome.
  const cleanStage = () => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {
      logger.warn(`⚠️ 💾 Could not remove restore staging directory for ${filename}: ${e.message}`, { action: 'restore-stage-cleanup', filename });
    }
  };
  try {
    const archivedJournals = dcaImportJournalPaths(listTreeFiles(tempDir));
    if (archivedJournals.length > 0) {
      const refusal = archivedDcaImportRefusal(archivedJournals);
      return abort(refusal.error, refusal.code);
    }

    // ---- Decide the configuration outcome before mutating the destination ----
    const manifestPath = path.join(tempDir, MANIFEST_FILENAME);
    const legacy = !fs.existsSync(manifestPath);
    const resolvedSnapshot = resolveRestoreSnapshot({
      legacy,
      readManifest: () => readJsonFile(manifestPath),
      readArchivedOverride: () => readJsonFile(path.join(tempDir, 'config.json')),
      legacyBaseConfig,
      acceptLegacyWithoutBase,
    });
    if (!resolvedSnapshot.ok) return abort(resolvedSnapshot.error, resolvedSnapshot.code);
    const { snapshot } = resolvedSnapshot;

    let override = null;
    /** @type {Array<string>} */
    let droppedFields = [];
    if (snapshot) {
      const planned = planRestoreConfig({ snapshot, destination, acceptFundRemoval });
      if (!planned.ok) return abort(planned.error, planned.code);
      override = planned.override;
      droppedFields = planned.droppedFields;
      if (droppedFields.length > 0) {
        logger.warn(`⚠️ 💾 Restore ${filename}: archive written by a newer build — ignoring ${droppedFields.length} setting(s) this build has no concept of, destination keeps its own defaults (${droppedFields.join(', ')})`, {
          action: 'restore-dropped-fields', filename, droppedFields, count: droppedFields.length,
        });
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
      rootFiles: discoverLegacyArtifacts(tempDir),
      snapshot,
      destinationConfig: destination.config,
    });
    if (layout.unresolvable.length > 0) {
      return abort(unresolvableLayoutError(layout.unresolvable), 'legacy-layout-unresolvable-pair');
    }
    const intentConflicts = findLegacyIntentCollisions({ entries: listTreeFiles(tempDir), translations: layout.translations });
    if (intentConflicts.length > 0) {
      return abort(intentCollisionError(intentConflicts), 'legacy-layout-placement-intents-conflict');
    }
    // The oldest layout kept state at the data root. Translate it first, in the
    // staging tree and with the destination never consulted, so it lands exactly
    // where the live root→exchange→pair migrations would put it — and so no
    // stray root artifact survives to make the next startup refuse to boot.
    if (layout.rootTranslation) {
      const { pair } = layout.rootTranslation;
      const rooted = normalizeLegacyRootToNamespace({ root: tempDir, pair });
      if (rooted.conflicts.length > 0) {
        return abort(ambiguousLayoutError(rooted.conflicts), 'legacy-layout-ambiguous-generations');
      }
      logger.info(`ℹ️ 💾 Restore translated legacy root artifacts → ${LEGACY_EXCHANGE}${pair ? `/${pair}` : ''}: ${rooted.moved.length} relocated, ${rooted.reconciled.length} already present (${[...rooted.moved, ...rooted.reconciled].join(', ') || 'none'})`, {
        action: 'restore-legacy-root-layout', filename, exchange: LEGACY_EXCHANGE, pair, moved: rooted.moved.length, reconciled: rooted.reconciled.length,
      });
    }
    for (const { exchange, pair } of layout.translations) {
      const { moved, skipped } = normalizeExchangeTreeToPairs({ root: tempDir, exchange, pair });
      logger.info(`ℹ️ 💾 Restore translated legacy layout ${exchange}/ → ${exchange}/${pair}: ${moved.length} file(s) relocated, ${skipped.length} skipped (${moved.join(', ') || 'none'})`, {
        action: 'restore-legacy-layout', filename, exchange, pair, moved: moved.length, skipped: skipped.length,
      });
    }

    const aliases = checkDestinationAliases(paths.dataDir, listTreeFiles(tempDir));
    if (!aliases.ok) return abort(aliases.error, aliases.code);

    // A restored fund's pending import would roll forward over (or strand) the
    // restored generation; its journal is not ours to discard (#1809).
    const restoredFunds = restoredArchiveFunds(tempDir, snapshot);
    const pending = fundsWithPendingDcaImport(paths.dataDir, restoredFunds);
    if (pending.length > 0) {
      const refusal = pendingDcaImportRefusal(pending, 'No files were changed.');
      return abort(refusal.error, refusal.code);
    }

    // Re-check the extracted generation immediately before the destination is
    // touched (#1811): this covers archives that changed after preflight.
    const compatible = checkPersistedPayloads(tempDir, listStagedPayloadPaths(tempDir));
    if (!compatible.ok) return abort(`Archive accounting is not readable by this build: ${compatible.error}. No files were changed.`, 'payload-incompatible');

    // The archive's intents must never clear a blocker the destination holds
    // (an unresolved order POST made after the archive was taken): merge them
    // into the staged copy so the journal commits them with the accounting.
    stageMergedPlacementIntents(tempDir, paths.dataDir);

    // From here applyStagedFiles owns the staging directory: it removes it on a
    // refusal or rollback, or leaves it for the rollback journal to recover.
    handedOff = true;
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
      absent: planAbsentFundState(tempDir, restoredFunds),
      // Skip the backups directory, root credential files, key files and the
      // archive's own metadata.
      skip: (name, isRoot, rel) => name === 'backups'
        || isPlacementIntentOwnershipPath(rel)
        || rel.startsWith(SCORECARD_MAINTENANCE_LOCK)
        || (isRoot && (name === CONFIG_LOCK_DIR || name.startsWith(`${BASE_SNAPSHOT_FILENAME}.`)))
        || name.endsWith('-keys.json')
        || (isRoot && isRootCredentialArtifact(name))
        || (isRoot && (name === MANIFEST_FILENAME || (legacy && !override && name === 'config.json'))),
    });

    // Post-commit: invalidate first, and never let cleanup fail a committed restore.
    if (applied.success && override) {
      try { invalidateConfigCache(); } catch (e) {
        logger.warn(`⚠️ 💾 Restore ${filename} committed but the config cache could not be invalidated: ${e.message}`, { action: 'restore-cache-invalidate', filename });
      }
    }
    // The applier cleans staging itself once a journal exists; this covers the
    // earlier refusals (invalid staged set, snapshot or journal write failure),
    // which return before one is written.
    if (applied.success || applied.rolledBack) cleanStage();

    if (!applied.success) {
      return { success: false, code: applied.code, error: applied.error, rolledBack: applied.rolledBack, ...(applied.recovery ? { recovery: applied.recovery } : {}) };
    }

    return { success: true, filesRestored: applied.filesRestored, configRestored: Boolean(override), legacy, droppedFields };
  } catch (error) {
    // Once handed off, the applier may have thrown before writing a journal; only
    // a journal on disk means startup recovery owns the staging tree.
    const journaled = handedOff && fs.existsSync(path.join(paths.dataDir, JOURNAL_FILENAME));
    if (!journaled) cleanStage();
    logger.error(`❌ 💾 Restore failed while preparing ${filename}: ${error.message}`, { action: 'restore-stage', filename, error: error.message });
    return { success: false, code: 'staging-failed', error: `Restore failed while preparing the archive: ${error.message}. ${journaled ? 'The rollback journal will recover the data directory on next start.' : 'No files were changed.'}` };
  }
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
