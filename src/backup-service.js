// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Uses spawnSync for zip/unzip operations.
 * Excludes API keys and backup directory from archives.
 *
 * Archives also carry a versioned manifest (`backup-manifest.json`) holding a
 * self-contained snapshot of the effective non-secret configuration, so a
 * restore onto a machine with a different base `config.json` reproduces the
 * original funds instead of silently adopting the destination's defaults
 * (issue #430).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DATA_DIR, BACKUP_DIR } = require('./paths');
const {
  buildConfigSnapshot,
  reconstructConfigOverride,
  writeUserConfigFile,
  resolveBaseConfigFile,
  normalizeToMultiExchange,
  invalidateConfigCache,
  deepMerge,
} = require('./config-utils');

const BACKUPS_DIR = BACKUP_DIR;

/** Archive entry holding the configuration snapshot. */
const MANIFEST_FILENAME = 'backup-manifest.json';

/** Manifest envelope version. Restore rejects anything it does not know. */
const MANIFEST_VERSION = 1;

const SPAWN_TIMEOUT_MS = 60000;

/**
 * Resolve every path the service touches from a single data directory, so
 * temp-directory tests can exercise create/restore without going near the live
 * install.
 * @param {{dataDir?: string, baseConfigFile?: string}} [overrides]
 * @returns {{dataDir: string, backupsDir: string, baseConfigFile: string, userConfigFile: string}}
 */
const resolvePaths = ({ dataDir = DATA_DIR, baseConfigFile } = {}) => ({
  dataDir,
  backupsDir: path.join(dataDir, 'backups'),
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
    return { ok: false, error: `${path.basename(file)} is unreadable or not valid JSON: ${err.message}` };
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

/**
 * Add the manifest to an already-created archive. Written from a staging
 * directory rather than into the data directory so a backup never leaves a
 * stray file behind (or races a concurrent reader of data/).
 * @param {string} zipPath
 * @param {Object} manifest
 * @returns {{success: boolean, error?: string}}
 */
const appendManifest = (zipPath, manifest) => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-manifest-'));
  fs.writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  const result = spawnSync('zip', ['-q', '-g', zipPath, MANIFEST_FILENAME], {
    cwd: stagingDir,
    timeout: SPAWN_TIMEOUT_MS,
  });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  if (result.error || result.status !== 0) {
    const error = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : 'Unknown zip error');
    return { success: false, error: `Failed to write backup manifest: ${error}` };
  }
  return { success: true };
};

/**
 * Create a backup of all data files
 * @param {Object} options
 * @param {boolean} [options.includePriceCache=false] - Include price cache files (~45MB per exchange)
 * @param {{dataDir?: string, baseConfigFile?: string}} [options.paths] - Path overrides (tests)
 * @returns {{ success: boolean, filename?: string, sizeBytes?: number, error?: string }}
 */
const createBackup = ({ includePriceCache = false, paths: pathOverrides } = {}) => {
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
  const filename = `backup-${timestamp}.zip`;
  const zipPath = path.join(paths.backupsDir, filename);

  // Build exclusion patterns
  const excludes = [
    'backups/*',        // Don't include backups dir in backup
    '*-keys.json',      // Never include API keys
    '*/*-keys.json',    // Keys in subdirectories
    MANIFEST_FILENAME,  // The manifest is generated below, never archived from data/
  ];

  if (!includePriceCache) {
    excludes.push('*-price-cache*.json');
    excludes.push('*/*-price-cache*.json');
  }

  const excludeArgs = excludes.flatMap(pattern => ['-x', pattern]);

  // Create zip from data directory
  const result = spawnSync('zip', [
    '-r',               // Recursive
    '-q',               // Quiet
    zipPath,
    '.',                // Current directory (data/)
    ...excludeArgs,
  ], {
    cwd: paths.dataDir,
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0) {
    const error = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : 'Unknown zip error');
    return { success: false, error };
  }

  const appended = appendManifest(zipPath, manifest);
  if (!appended.success) {
    // A manifest-less archive is exactly the bug #430 fixes — don't keep one.
    fs.rmSync(zipPath, { force: true });
    return { success: false, error: appended.error };
  }

  const stats = fs.statSync(zipPath);
  return { success: true, filename, sizeBytes: stats.size };
};

/**
 * List all backups sorted newest-first
 * @returns {Array<{ filename: string, createdAt: string, sizeBytes: number }>}
 */
const listBackups = () => {
  ensureBackupsDir();

  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.zip'));

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
 * Prune old backups to keep only maxBackups
 * @param {number} maxBackups - Maximum number of backups to keep
 * @returns {{ pruned: number, remaining: number }}
 */
const pruneBackups = (maxBackups) => {
  const backups = listBackups(); // sorted newest-first
  let pruned = 0;

  if (backups.length > maxBackups) {
    const toDelete = backups.slice(maxBackups);
    for (const backup of toDelete) {
      const result = deleteBackup(backup.filename);
      if (result.success) pruned++;
    }
  }

  return { pruned, remaining: backups.length - pruned };
};

/**
 * Read an archive's manifest without extracting the archive.
 * @param {string} zipPath
 * @returns {{present: boolean, manifest?: Object, error?: string}}
 */
const readArchiveManifest = (zipPath) => {
  const result = spawnSync('unzip', ['-p', zipPath, MANIFEST_FILENAME], { timeout: SPAWN_TIMEOUT_MS });
  if (result.error) return { present: false, error: result.error.message };
  const raw = result.stdout ? result.stdout.toString().trim() : '';
  // `unzip -p` exits non-zero (11) when the entry is absent — a legacy archive.
  if (result.status !== 0 || !raw) return { present: false };
  try {
    return { present: true, manifest: JSON.parse(raw) };
  } catch (err) {
    return { present: true, error: `${MANIFEST_FILENAME} is not valid JSON: ${err.message}` };
  }
};

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
 *   manifestVersion?: number|null, snapshotVersion?: number|null, createdAt?: string,
 *   funds?: Array<Object>, error?: string, code?: string}}
 */
const inspectBackup = (filename, { paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveArchivePath(filename, paths.backupsDir);
  if (!resolved.ok) return { success: false, error: resolved.error };

  const read = readArchiveManifest(resolved.zipPath);
  if (read.error) {
    return { success: true, filename, legacy: !read.present, compatible: false, manifestVersion: null, funds: [], error: read.error };
  }
  if (!read.present) {
    return {
      success: true,
      filename,
      legacy: true,
      compatible: false,
      manifestVersion: null,
      funds: [],
      code: 'legacy-archive-missing-base',
      error: `This archive predates configuration manifests, so it does not carry the fund configuration it was taken with. Restoring it replays data files only — the destination keeps its OWN config.json, which may name a different pair or allocation.`,
    };
  }

  const envelope = readManifestSnapshot(read.manifest);
  if (!envelope.ok) {
    return { success: true, filename, legacy: false, compatible: false, manifestVersion: read.manifest?.manifestVersion ?? null, funds: [], error: envelope.error };
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

  return {
    success: true,
    filename,
    legacy: false,
    compatible: rebuilt.ok,
    manifestVersion: MANIFEST_VERSION,
    snapshotVersion: envelope.snapshot?.version ?? null,
    createdAt: envelope.createdAt,
    funds,
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
 * @returns {{ success: boolean, filesRestored?: number, configRestored?: boolean,
 *   legacy?: boolean, error?: string, code?: string }}
 */
const restoreBackup = (filename, { paths: pathOverrides, legacyBaseConfig = null, acceptLegacyWithoutBase = false } = {}) => {
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
  const tempDir = path.join(paths.dataDir, `.restore-temp-${Date.now()}`);
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
  if (snapshot) {
    const rebuilt = reconstructConfigOverride({
      snapshot,
      baseConfig: destination.base,
      destinationGlobal: destination.config.global,
    });
    if (!rebuilt.ok) return abort(rebuilt.error, 'config-snapshot-invalid');
    override = rebuilt.override;
  }

  // ---- Past this point the destination is mutated ----
  let filesRestored = 0;
  const copyFiles = (srcDir, destDir, isRoot = true) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      // Skip backups directory, keys files and the manifest (archive metadata)
      if (entry.name === 'backups') continue;
      if (entry.name.endsWith('-keys.json')) continue;
      if (isRoot && entry.name === MANIFEST_FILENAME) continue;

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        copyFiles(srcPath, destPath, false);
      } else {
        fs.copyFileSync(srcPath, destPath);
        filesRestored++;
      }
    }
  };

  copyFiles(tempDir, paths.dataDir);

  if (override) {
    // Replaces whatever override the archive just dropped in: the archived diff
    // was relative to the SOURCE's base and is meaningless against this one.
    writeUserConfigFile(override, paths.userConfigFile);
    invalidateConfigCache();
  }

  // Clean up temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });

  return { success: true, filesRestored, configRestored: Boolean(override), legacy };
};

module.exports = {
  createBackup,
  listBackups,
  deleteBackup,
  pruneBackups,
  restoreBackup,
  inspectBackup,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
};
