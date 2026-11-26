// @ts-check
/**
 * Backup common
 *
 * Plumbing shared by the backup, fund-state snapshot and restore modules: the
 * resolved paths, manifest/credential constants, zip/unzip process helpers and
 * configuration readers. A leaf module, so the others can depend on it without
 * importing each other in a cycle.
 */

const fs = require('fs');
const path = require('path');
const { jsonReadError } = require('./json-diagnostics');
const { spawn } = require('child_process');
const { DATA_DIR, BACKUP_DIR } = require('./paths');
const { resolveBaseConfigFile, normalizeToMultiExchange, deepMerge } = require('./config-utils');

// UpDown scorecard maintenance lock (relative to data/). A backup taken while a
// backfill holds it would carry a lock no live process owns into the restore.
const SCORECARD_MAINTENANCE_LOCK = path.join('updown', 'scorecard', '.maintenance-lock');

// Process ownership is not trading data. Match only the lock component at
// <exchange>/<pair>/, leaving the durable placement-intents.json untouched.
const PLACEMENT_INTENT_LOCK_NAMES = [
  'placement-intents.json.lock',
  'placement-intents.json.lock.new-*',
  'placement-intents.json.lock.reclaim',
];
const isPlacementIntentOwnershipPath = (rel) => {
  const [, , name] = rel.split(path.sep);
  return /^placement-intents\.json\.lock(?:\.new-[^/]+|\.reclaim)?$/.test(name || '');
};

const BACKUPS_DIR = BACKUP_DIR;

/** Archive entry holding the configuration snapshot. */
const MANIFEST_FILENAME = 'backup-manifest.json';

/** Manifest envelope version. Restore rejects anything it does not know. */
const MANIFEST_VERSION = 1;

/** Directory and manifest used by the lightweight hourly fund-state snapshots. */
const FUND_STATE_BACKUP_DIRNAME = 'fund-state';
const FUND_STATE_MANIFEST_FILENAME = 'fund-state-manifest.json';
// Bounds each zip/unzip child. The archive-creation path uses async spawn, so a
// slow archive no longer blocks the gateway event loop or its shutdown drain;
// the sync callers (restore, listing) still block for up to this long.
const SPAWN_TIMEOUT_MS = 60000;
// Largest archive entry the root-collision comparison will buffer from `unzip -p`.
const ROOT_COMPARE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Promise-wrapped spawn with spawnSync's result shape ({status, error, stdout,
 * stderr}), so callers keep the same exit-code and error handling.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number}} [options]
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
  'ipc-secret',
];

/** Root credential writer leftovers are sensitive for the same reason as the target. */
const isRootCredentialArtifact = (name) => ROOT_CREDENTIAL_FILES.some((credential) =>
  name === credential || (name.startsWith(`${credential}.`) && name.endsWith('.tmp')));

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
  if (baseRead.ok === false) return { ok: false, error: baseRead.error };
  const userRead = readJsonFile(userConfigFile);
  if (userRead.ok === false) return { ok: false, error: userRead.error };
  const base = baseRead.value || {};
  return { ok: true, base, config: normalizeToMultiExchange(deepMerge(base, userRead.value || {})) };
};

// unzip treats a member argument as a glob, even when passed as a separate
// argument. Escape metacharacters so a read cannot concatenate other members.
const unzipMember = (name) => name.replace(/[\\*?\[\]]/g, '\\$&');

module.exports = {
  SCORECARD_MAINTENANCE_LOCK,
  PLACEMENT_INTENT_LOCK_NAMES,
  isPlacementIntentOwnershipPath,
  BACKUPS_DIR,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  FUND_STATE_MANIFEST_FILENAME,
  SPAWN_TIMEOUT_MS,
  ROOT_COMPARE_MAX_BYTES,
  spawnAsync,
  ROOT_CREDENTIAL_FILES,
  isRootCredentialArtifact,
  SILENT_LOGGER,
  resolvePaths,
  ensureBackupsDir,
  resolveArchivePath,
  readJsonFile,
  readEffectiveConfig,
  unzipMember,
};
