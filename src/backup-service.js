// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Archive creation and listing use async spawn for zip/unzip; restore uses spawnSync
 * (and the schedule anchor, for the newest archive on a cold cache — see archiveValidityCache).
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
const { validatePersistedPayload, classifyPayloadPath } = require('./persisted-payload-validation');
const { applyStagedFiles, STAGE_PREFIX, ORIGINALS_PREFIX, JOURNAL_FILENAME, OWNER_PREFIX } = require('./restore-apply');
const {
  LOCK_FILENAME: LEGACY_MIGRATION_LOCK,
  LEGACY_EXCHANGE,
  isLegacyRootArtifact,
  discoverLegacyArtifacts,
} = require('./legacy-namespace-migration');

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
const {
  isPerFundFile,
  normalizeExchangeTreeToPairs,
  normalizeLegacyRootToNamespace,
  legacyRootArtifactTarget,
  legacyRootArtifactCandidates,
  PER_FUND_FILES,
  PAIR_MIGRATION_CONFLICT_FILES,
} = require('./migration');
const { serializeFundState } = require('./dry-run-state');
const { JOURNAL_FILENAME: DCA_IMPORT_JOURNAL_FILENAME } = require('./dca-conversion-transaction');
const { PLACEMENT_INTENTS_FILENAME, parsePlacementIntentsDocument, assertPlacementIntentRows } = require('./placement-intent-document');

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
// Placement intents are safety metadata, not accounting: a missing file means
// "no intents at snapshot time", never "erase the destination's blockers". They
// are therefore copied and validated with the snapshot but kept out of
// FUND_STATE_SNAPSHOT_FILENAMES, which drives absence operations and discovery
// of restored funds in full archives.
const FUND_STATE_CAPTURED_FILENAMES = [...FUND_STATE_SNAPSHOT_FILENAMES, PLACEMENT_INTENTS_FILENAME];

// Bounds each zip/unzip child. The archive-creation path uses async spawn, so a
// slow archive no longer blocks the gateway event loop or its shutdown drain;
// the sync callers (restore, listing) still block for up to this long.
const SPAWN_TIMEOUT_MS = 60000;
// Largest archive entry the root-collision comparison will buffer from `unzip -p`.
const ROOT_COMPARE_MAX_BYTES = 512 * 1024 * 1024;

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
 * The pair an exchange's legacy data belongs to: the archive's own snapshot
 * wins, the destination's default is the fallback (see `planLayoutTranslation`).
 * @param {string} exchange
 * @param {Object|null} snapshot
 * @param {Object} destinationConfig
 * @returns {string|null}
 */
const resolveLegacyPair = (exchange, snapshot, destinationConfig) =>
  Object.keys(snapshot?.exchanges?.[exchange]?.pairs || {})[0]
    ?? defaultPairFromConfig(destinationConfig, exchange);

/**
 * Pre-namespace artifacts an archive entry listing holds directly at its root.
 * @param {string[]} entries
 * @returns {string[]}
 */
const collectRootFilesFromEntries = (entries) =>
  [...new Set(entries.filter((entry) => !entry.includes('/') && isLegacyRootArtifact(entry)))];

/**
 * Decide, without touching a single file, which staged exchange trees are in
 * the pre-multi-pair layout and which pair each would be relocated into, and
 * where artifacts from the oldest (pre-exchange-namespace) layout — kept
 * directly at the data root — would land.
 *
 * The archive's own snapshot wins: an archive that carries its configuration
 * knows the pair its data belongs to, and the destination's default may name a
 * different fund entirely. The destination's default is the fallback for the
 * data-only (`acceptLegacyWithoutBase`) path, where no snapshot exists. The
 * historic root namespace is always coinbase, the only exchange that existed.
 *
 * @param {Object} params
 * @param {Map<string, string[]>} params.exchangeFiles - Exchange dir -> file names at its root
 * @param {string[]} [params.rootFiles] - Pre-namespace artifact names at the data root
 * @param {Object|null} params.snapshot - Archive configuration snapshot, if any
 * @param {Object} params.destinationConfig - Destination's effective configuration
 * @returns {{translations: Array<{exchange: string, pair: string}>, unresolvable: string[],
 *   rootTranslation: {exchange: string, pair: string|null, files: Array<{name: string, target: string}>}|null}}
 */
const planLayoutTranslation = ({ exchangeFiles, rootFiles = [], snapshot, destinationConfig }) => {
  const knownExchanges = new Set([
    ...Object.keys(snapshot?.exchanges || {}),
    ...Object.keys(destinationConfig?.exchanges || {}),
  ]);
  const translations = [];
  const unresolvable = [];

  for (const [exchange, filenames] of exchangeFiles) {
    if (!isLegacyExchangeLayout(exchange, filenames, knownExchanges)) continue;
    const pair = resolveLegacyPair(exchange, snapshot, destinationConfig);
    if (pair) translations.push({ exchange, pair });
    else unresolvable.push(exchange);
  }

  let rootTranslation = null;
  if (rootFiles.length > 0) {
    // Only per-fund artifacts need a fund directory; price caches stay at exchange level.
    const pair = rootFiles.some(isPerFundFile) ? resolveLegacyPair(LEGACY_EXCHANGE, snapshot, destinationConfig) : null;
    if (pair || !rootFiles.some(isPerFundFile)) {
      rootTranslation = {
        exchange: LEGACY_EXCHANGE,
        pair,
        files: rootFiles.map((name) => ({ name, target: legacyRootArtifactTarget(name, pair) })),
      };
    } else if (!unresolvable.includes(LEGACY_EXCHANGE)) {
      unresolvable.push(LEGACY_EXCHANGE);
    }
  }

  return { translations, unresolvable, rootTranslation };
};

/**
 * Root artifacts that collide with a DIFFERENT generation elsewhere in the same
 * archive, judged from archive entries alone (nothing is extracted to disk).
 * `readEntry` returns an entry's bytes, or null when it is unreadable.
 * @param {Object} params
 * @param {string[]} params.entries
 * @param {{pair: string|null, files: Array<{name: string}>}|null} params.rootTranslation
 * @param {(entry: string) => Buffer|null} params.readEntry
 * @returns {Array<{artifact: string, existing: string}>}
 */
const findRootCollisions = ({ entries, rootTranslation, readEntry }) => {
  if (!rootTranslation) return [];
  const present = new Set(entries);
  const collisions = [];
  for (const { name } of rootTranslation.files) {
    const rootBytes = readEntry(name);
    for (const candidate of legacyRootArtifactCandidates(name, rootTranslation.pair)) {
      if (!present.has(candidate)) continue;
      const other = readEntry(candidate);
      if (!rootBytes || !other || !rootBytes.equals(other)) collisions.push({ artifact: name, existing: candidate });
    }
  }
  return collisions;
};

/** Archive entries `findRootCollisions` needs the bytes of. */
const rootCollisionEntries = ({ entries, rootTranslation }) => {
  if (!rootTranslation) return [];
  const present = new Set(entries);
  return rootTranslation.files.flatMap(({ name }) => {
    const others = legacyRootArtifactCandidates(name, rootTranslation.pair)
      .filter((rel) => present.has(rel));
    return others.length > 0 ? [name, ...others] : [];
  });
};

// Two generations of a guarded accounting file cannot be discarded during
// layout translation: the exchange-level and per-fund copies may differ, and
// placement intents may hold an unresolved exchange order. Mirrors the startup
// refusal (`findPairMigrationConflicts`), so identical bytes still conflict.
const findLegacyIntentCollisions = ({ entries, translations }) => {
  const present = new Set(entries);
  return translations.flatMap(({ exchange, pair }) => PAIR_MIGRATION_CONFLICT_FILES.flatMap((file) => {
    const artifact = `${exchange}/${file}`;
    const existing = `${exchange}/${pair}/${file}`;
    return present.has(artifact) && present.has(existing) ? [{ artifact, existing }] : [];
  }));
};

const intentCollisionError = (conflicts) =>
  `This archive contains both legacy and per-fund copies of guarded accounting files (${conflicts.map(({ artifact, existing }) => `${artifact} and ${existing}`).join(', ')}). `
  + 'Preserve both copies and reconcile them (including all unresolved placement intents against the exchange) before restoring. No files were changed.';

// Protected names have case-sensitive meaning to the readers and exclusions.
// A differently-cased spelling can alias them on a case-insensitive disk
// without being recognized as accounting, credentials, a journal, or a lock.
const PROTECTED_ARCHIVE_NAMES = new Set([
  ...PER_FUND_FILES, ...ROOT_CREDENTIAL_FILES,
  MANIFEST_FILENAME, FUND_STATE_MANIFEST_FILENAME, BASE_SNAPSHOT_FILENAME,
  CONFIG_LOCK_DIR, JOURNAL_FILENAME, DCA_IMPORT_JOURNAL_FILENAME,
  LEGACY_MIGRATION_LOCK, 'config.json', 'updown-state.json', 'backups',
  '.maintenance-lock',
].map((name) => name.normalize('NFC').toLowerCase()));
const PROTECTED_ARCHIVE_PREFIXES = [
  ...ROOT_CREDENTIAL_FILES.map((name) => `${name}.`),
  'placement-intents.json.lock', LEGACY_MIGRATION_LOCK,
  STAGE_PREFIX, ORIGINALS_PREFIX, OWNER_PREFIX, `${BASE_SNAPSHOT_FILENAME}.`,
].map((name) => name.normalize('NFC').toLowerCase());

/**
 * Validate member destinations before extraction. unzip collapses dot and
 * repeated-slash components, so two differently-spelled names can overwrite
 * the same staged file. Retain the original spelling for unzip -p while using
 * the normalized path for every layout, manifest and payload decision.
 *
 * Reject links (including parent-directory links), path traversal, ambiguous
 * names, and file/directory collisions before unzip can touch staging. Case
 * and Unicode-equivalent spellings are refused for portable restores on
 * case-insensitive or normalization-insensitive filesystems.
 */
const parseArchivePaths = (records) => {
  const refuse = (detail) => ({
    ok: false,
    code: 'archive-unsafe-paths',
    error: `Archive contains unsafe or ambiguous paths: ${detail}. No files were changed.`,
  });
  const entries = [];
  const members = new Map();
  const destinations = new Map();
  for (const { name, directory } of records) {
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\\\x00-\x1f\x7f\ufffd]/.test(name)) {
      return refuse(`unsafe member ${JSON.stringify(name)}`);
    }
    const parts = name.split('/');
    if (parts.includes('..')) return refuse(`unsafe member ${JSON.stringify(name)}`);
    const segments = parts.filter((part) => part && part !== '.');
    if (!segments.length) {
      if (directory) continue;
      return refuse(`unsafe member ${JSON.stringify(name)}`);
    }
    for (const segment of segments) {
      const folded = segment.normalize('NFC').toLowerCase();
      const protectedName = PROTECTED_ARCHIVE_NAMES.has(folded)
        || folded.endsWith('-keys.json') || folded.endsWith('.restore-tmp')
        || PROTECTED_ARCHIVE_PREFIXES.some((prefix) => folded.startsWith(prefix));
      if (protectedName && segment !== folded) return refuse(`ambiguous protected name ${JSON.stringify(name)}`);
    }
    const canonical = segments.join('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      const kind = i < segments.length || directory ? 'directory' : 'file';
      const previous = destinations.get(key);
      if (previous && (previous.path !== prefix || previous.kind !== kind || kind === 'file')) {
        return refuse(`conflicting members ${JSON.stringify(previous.name)} and ${JSON.stringify(name)}`);
      }
      destinations.set(key, { path: prefix, kind, name });
    }
    entries.push(directory ? `${canonical}/` : canonical);
    if (!directory) members.set(canonical, name);
  }
  return { ok: true, entries, members };
};

// Info-ZIP's text listing can render valid UTF-8 names lossily on macOS.
// Parse the bounded central directory and verify each local name instead:
// the same bytes drive both collision checks and unzip's eventual extraction.
// The generator lets backup creation/preflight use async file reads while the
// existing synchronous restore/inspection APIs share exactly the same rules.
function* readArchiveDirectory(size) {
  const fail = (reason) => { throw new Error(reason); };
  if (size < 22) fail('missing end-of-directory record');
  const tailStart = Math.max(0, size - 65557);
  const tail = yield { position: tailStart, length: size - tailStart };
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) fail('missing end-of-directory record');
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) fail('multi-disk ZIP is unsupported');
  let count = tail.readUInt16LE(end + 10);
  let centralSize = tail.readUInt32LE(end + 12);
  let centralOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locatorPos = tailStart + end - 20;
    if (locatorPos < 0) fail('missing ZIP64 locator');
    const locator = yield { position: locatorPos, length: 20 };
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) fail('invalid ZIP64 locator');
    const zip64Offset = Number(locator.readBigUInt64LE(8));
    if (!Number.isSafeInteger(zip64Offset) || zip64Offset + 56 > locatorPos) fail('invalid ZIP64 directory');
    const zip64 = yield { position: zip64Offset, length: 56 };
    if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) fail('invalid ZIP64 directory');
    count = Number(zip64.readBigUInt64LE(32));
    centralSize = Number(zip64.readBigUInt64LE(40));
    centralOffset = Number(zip64.readBigUInt64LE(48));
  } else if (tail.readUInt16LE(end + 8) !== count) fail('multi-disk ZIP is unsupported');
  if (![count, centralSize, centralOffset].every(Number.isSafeInteger)
    || count < 1 || centralSize > ROOT_COMPARE_MAX_BYTES
    || centralOffset < 0 || centralOffset + centralSize > tailStart + end) fail('invalid central directory bounds');
  const central = yield { position: centralOffset, length: centralSize };
  // A leading UTF-8 BOM is part of a ZIP member name, not a text-file marker.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (bytes) => { try { return decoder.decode(bytes); } catch { return fail('member name is not valid UTF-8'); } };
  const checkExtras = (extra, name) => {
    for (let pos = 0; pos < extra.length;) {
      if (pos + 4 > extra.length) fail('malformed member metadata');
      const kind = extra.readUInt16LE(pos);
      const length = extra.readUInt16LE(pos + 2);
      pos += 4;
      if (pos + length > extra.length) fail('malformed member metadata');
      // Reject a competing Unicode path: unzip versions differ on which name
      // they select. Identical names are unambiguous.
      if (kind === 0x7075 && (length < 5 || extra[pos] !== 1 || decode(extra.subarray(pos + 5, pos + length)) !== name)) {
        fail('ambiguous Unicode member name');
      }
      pos += length;
    }
  };
  const records = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) fail('malformed central directory');
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const endEntry = cursor + 46 + nameLength + extraLength + commentLength;
    if (endEntry > central.length) fail('malformed central directory');
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decode(rawName);
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    checkExtras(extra, name);
    const attributes = central.readUInt32LE(cursor + 38);
    const modeType = (attributes >>> 16) & 0o170000;
    const host = central.readUInt16LE(cursor + 4) >>> 8;
    if (modeType === 0o120000) fail('symbolic links are not supported');
    if (host === 3 && modeType !== 0 && modeType !== 0o100000 && modeType !== 0o040000) fail('unsupported member type');
    let localOffset = central.readUInt32LE(cursor + 42);
    if (localOffset === 0xffffffff) {
      let found = false;
      for (let pos = 0; pos < extra.length;) {
        const kind = extra.readUInt16LE(pos), length = extra.readUInt16LE(pos + 2);
        pos += 4;
        if (kind === 1) {
          let value = pos;
          if (central.readUInt32LE(cursor + 24) === 0xffffffff) value += 8;
          if (central.readUInt32LE(cursor + 20) === 0xffffffff) value += 8;
          if (value + 8 > pos + length) fail('invalid ZIP64 member offset');
          localOffset = Number(extra.readBigUInt64LE(value));
          found = true;
          break;
        }
        pos += length;
      }
      if (!found) fail('missing ZIP64 member offset');
    }
    if (!Number.isSafeInteger(localOffset) || localOffset + 30 > centralOffset) fail('invalid local member offset');
    const local = yield { position: localOffset, length: 30 };
    if (local.readUInt32LE(0) !== 0x04034b50) fail('invalid local member header');
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) fail('invalid local member bounds');
    const localFields = yield { position: localOffset + 30, length: localNameLength + localExtraLength };
    if (!localFields.subarray(0, localNameLength).equals(rawName)
      || local.readUInt16LE(6) !== central.readUInt16LE(cursor + 8)) fail('local and central member names or flags differ');
    checkExtras(localFields.subarray(localNameLength), name);
    records.push({ name, directory: name.endsWith('/') });
    cursor = endEntry;
  }
  if (cursor !== central.length) fail('unexpected central directory data');
  return parseArchivePaths(records);
}

const archiveReadFailure = (error) => ({
  ok: false, code: 'archive-unsafe-paths',
  error: `Archive member metadata could not be verified: ${error.message}. No files were changed.`,
});

const inspectArchivePaths = (zipPath) => {
  let fd;
  try {
    fd = fs.openSync(zipPath, 'r');
    const reader = readArchiveDirectory(fs.fstatSync(fd).size);
    let step = reader.next();
    while (!step.done) {
      const data = Buffer.alloc(step.value.length);
      if (fs.readSync(fd, data, 0, data.length, step.value.position) !== data.length) throw new Error('truncated archive');
      step = reader.next(data);
    }
    return step.value;
  } catch (error) { return archiveReadFailure(error); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};

const inspectArchivePathsAsync = async (zipPath) => {
  let fd;
  try {
    fd = await fs.promises.open(zipPath, 'r');
    const reader = readArchiveDirectory((await fd.stat()).size);
    let step = reader.next();
    while (!step.done) {
      const data = Buffer.alloc(step.value.length);
      if ((await fd.read(data, 0, data.length, step.value.position)).bytesRead !== data.length) throw new Error('truncated archive');
      step = reader.next(data);
    }
    return step.value;
  } catch (error) { return archiveReadFailure(error); }
  finally { if (fd) await fd.close(); }
};

// unzip treats a member argument as a glob, even when passed as a separate
// argument. Escape metacharacters so a read cannot concatenate other members.
const unzipMember = (name) => name.replace(/[\\*?\[\]]/g, '\\$&');

/**
 * A path may alias an existing destination even when it has no duplicate in
 * the archive. Refuse differing case/Unicode spelling at every existing
 * component on all hosts, so a restore cannot overwrite a protected file on
 * a case-insensitive disk while bypassing the reader's exact-name rules.
 */
const checkDestinationAliases = (dataDir, entries) => {
  const cached = new Map();
  for (const entry of entries) {
    const parts = entry.replace(/\/$/, '').split('/');
    let dir = dataDir;
    for (let index = 0; index < parts.length; index++) {
      let names = cached.get(dir);
      if (!names) {
        try {
          names = fs.readdirSync(dir);
        } catch (error) {
          if (error.code === 'ENOENT') break;
          return { ok: false, code: 'destination-path-unsafe', error: `Cannot inspect restore destination ${dir}: ${error.message}. No files were changed.` };
        }
        cached.set(dir, names);
      }
      const segment = parts[index];
      const folded = segment.normalize('NFC').toLowerCase();
      const matches = names.filter((name) => name.normalize('NFC').toLowerCase() === folded);
      if (matches.some((name) => name !== segment)) {
        return { ok: false, code: 'destination-path-unsafe', error: `Archive path ${entry} aliases an existing destination with different spelling (${matches.join(', ')}). No files were changed.` };
      }
      if (!matches.length) break;
      const next = path.join(dir, segment);
      if (index < parts.length - 1) {
        let stat;
        try { stat = fs.lstatSync(next); } catch (error) {
          return { ok: false, code: 'destination-path-unsafe', error: `Cannot inspect restore destination ${next}: ${error.message}. No files were changed.` };
        }
        if (!stat.isDirectory()) {
          return { ok: false, code: 'destination-path-unsafe', error: `Restore destination parent ${next} is not a directory. No files were changed.` };
        }
      }
      dir = next;
    }
  }
  return { ok: true };
};

/** Include paths the layout translation will actually write to the fund. */
const projectedArchivePaths = (entries, { translations, rootTranslation }) => {
  const projected = entries.filter((entry) => !entry.endsWith('/'));
  for (const { exchange, pair } of translations) {
    for (const entry of entries) {
      const parts = entry.split('/');
      if (parts.length === 2 && parts[0] === exchange && isPerFundFile(parts[1])) {
        projected.push(`${exchange}/${pair}/${parts[1]}`);
      }
    }
  }
  for (const file of rootTranslation?.files || []) projected.push(file.target);
  return projected;
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
 *   rootTranslation: Object|null, layoutConflicts: Array<{artifact: string, existing: string}>,
 *   unresolvableLayoutExchanges: string[]}}
 */
const describeLayoutTranslation = ({ zipPath, archive, snapshot, destinationConfig }) => {
  const { entries, members } = archive;
  const { translations, unresolvable, rootTranslation } = planLayoutTranslation({
    exchangeFiles: collectExchangeFilesFromEntries(entries),
    rootFiles: collectRootFilesFromEntries(entries),
    snapshot,
    destinationConfig,
  });
  const layoutConflicts = [...findLegacyIntentCollisions({ entries, translations }), ...findRootCollisions({
    entries,
    rootTranslation,
    readEntry: (entry) => {
      const result = spawnSync('unzip', ['-p', zipPath, unzipMember(members.get(entry))], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: ROOT_COMPARE_MAX_BYTES });
      return result.error || result.status !== 0 ? null : result.stdout;
    },
  })];
  return {
    legacyLayout: translations.length > 0 || unresolvable.length > 0 || rootTranslation !== null,
    layoutTranslations: translations,
    rootTranslation,
    layoutConflicts,
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

const checkTailFailure = (result, fallback) => {
  if (!result.error && result.status === 0) return null;
  return { ok: false, error: result.error ? result.error.message : (result.stderr?.toString().trim() || fallback) };
};

/** Shared decision logic once an archive's integrity, listing and manifest reads are in hand. */
const evaluateArchive = ({ archive, readManifest, allowLegacy }) => {
  const manifestName = archive.members.get(MANIFEST_FILENAME);
  if (!manifestName && allowLegacy) return { ok: true };
  if (!manifestName) return { ok: false, error: `Archive must contain exactly one ${MANIFEST_FILENAME}` };
  const read = readManifest(manifestName);
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

/**
 * Pre-namespace root artifacts have no fund directory in the archive; their
 * restored location depends on the destination's pair, which is a restore-time
 * choice and not a property of the archive. Payload rules depend only on path
 * depth, so any stand-in pair yields the same verdict the real restore reaches.
 */
const INTRINSIC_LEGACY_PAIR = '_legacy';

/**
 * Accounting members of an archive paired with the path restore validates them
 * at (supported legacy root files are judged at their translated location).
 * @param {string[]} entries
 * @returns {Array<{entry: string, target: string}>}
 */
const archivePayloadMembers = (entries) => {
  const rootTargets = new Map(collectRootFilesFromEntries(entries)
    .map((name) => [name, legacyRootArtifactTarget(name, INTRINSIC_LEGACY_PAIR)]));
  return entries.flatMap((entry) => {
    const target = rootTargets.get(entry) || entry;
    return entry.endsWith('/') || !classifyPayloadPath(target) ? [] : [{ entry, target }];
  });
};

/** Restore's verdict on one accounting member read from an archive. */
const payloadMemberVerdict = (entry, target, read) => {
  if (read.error || read.status !== 0) {
    return { ok: false, code: 'archive-corrupt', error: `Unable to read ${entry} from the archive. No files were changed.` };
  }
  const checked = validatePersistedPayload(target, read.stdout);
  return checked.ok
    ? { ok: true }
    : { ok: false, code: 'payload-incompatible', error: `Archive accounting is not readable by this build: ${checked.error}. No files were changed.` };
};

/** Largest accounting member the synchronous validity pass will buffer. */
const PAYLOAD_VALIDATION_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Archive-local restorability (#1885): the refusals restore applies that depend
 * only on the archive itself. Destination choices (fund removal, legacy base
 * configuration) are deliberately absent, so one verdict serves publication,
 * listing, retention and the schedule anchor.
 * @param {string} zipPath
 * @param {{entries: string[], members: Map<string, string>}} archive
 */
const checkArchiveRestorable = (zipPath, { entries, members }) => {
  const journals = dcaImportJournalPaths(entries);
  if (journals.length > 0) return { ok: false, ...archivedDcaImportRefusal(journals) };
  for (const { entry, target } of archivePayloadMembers(entries)) {
    const read = spawnSync('unzip', ['-p', zipPath, unzipMember(members.get(entry))], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: PAYLOAD_VALIDATION_MAX_BYTES });
    const verdict = payloadMemberVerdict(entry, target, read);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
};

/** Non-blocking checkArchiveRestorable for the backup-creation path. */
const checkArchiveRestorableAsync = async (zipPath, { entries, members }) => {
  const journals = dcaImportJournalPaths(entries);
  if (journals.length > 0) return { ok: false, ...archivedDcaImportRefusal(journals) };
  for (const { entry, target } of archivePayloadMembers(entries)) {
    const read = await spawnAsync('unzip', ['-p', zipPath, unzipMember(members.get(entry))]);
    const verdict = payloadMemberVerdict(entry, target, read);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
};

/** Validate an archive; only listing may admit the supported pre-manifest format. */
const validateBackupArchive = (zipPath, { allowLegacy = false } = {}) => {
  const integrity = spawnSync('unzip', ['-tq', zipPath], { timeout: SPAWN_TIMEOUT_MS });
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return integrityFailure;
  const archive = inspectArchivePaths(zipPath);
  if (!archive.ok) return archive;
  const evaluated = evaluateArchive({ archive, allowLegacy, readManifest: (name) => readArchiveManifest(zipPath, name) });
  return evaluated.ok ? checkArchiveRestorable(zipPath, archive) : evaluated;
};

/** Non-blocking validateBackupArchive for the backup-creation path. */
const validateBackupArchiveAsync = async (zipPath, { allowLegacy = false } = {}) => {
  const integrity = await spawnAsync('unzip', ['-tq', zipPath]);
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return integrityFailure;
  const archive = await inspectArchivePathsAsync(zipPath);
  if (!archive.ok) return archive;
  const manifestName = archive.members.get(MANIFEST_FILENAME);
  const manifestRead = manifestName ? await spawnAsync('unzip', ['-p', zipPath, unzipMember(manifestName)]) : null;
  const evaluated = evaluateArchive({ archive, allowLegacy, readManifest: () => parseManifestRead(manifestRead) });
  return evaluated.ok ? checkArchiveRestorableAsync(zipPath, archive) : evaluated;
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

/** In-flight async validations keyed like archiveValidityCache, so concurrent listings share one test. */
const pendingArchiveValidity = new Map();

/**
 * Non-blocking isArchiveListable for listing and pruning. After a restart every
 * retained archive is cold, and testing them all synchronously stalls the
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

const isSafeFundStateSegment = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
  && value !== '.' && value !== '..';

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
 * Complete the accounting generation for precisely the restored funds. Missing
 * sidecars mean absence, except dry-run state which needs a tombstone to prevent
 * the legacy application-root importer resurrecting a newer simulation.
 */
const planAbsentFundState = (stageDir, funds) => funds.flatMap(({ exchange, pair }) => {
  if ([exchange, pair].some((segment) => !isSafeFundStateSegment(segment) || segment === '.' || segment === '..')) {
    throw new Error('Unsafe fund identity in restore plan');
  }
  return FUND_STATE_SNAPSHOT_FILENAMES.flatMap((name) => {
    const dest = path.join(exchange, pair, name);
    if (fs.existsSync(path.join(stageDir, dest))) return [];
    return [{ dest, operation: name === 'dry-run-state.json' ? 'reset' : 'remove',
      ...(name === 'dry-run-state.json' ? { contents: serializeFundState() } : {}) }];
  });
});

/**
 * Full archives can include retired funds and pre-manifest layouts. After layout
 * translation, discover only directories carrying authoritative accounting files;
 * also include the archive's configured funds, including entirely empty ones.
 * Never infer a restored fund from destination state or a cache-only directory.
 */
const restoredArchiveFunds = (stageDir, snapshot) => {
  const funds = new Map(configuredFundIdentities(snapshot).map((fund) => [path.join(fund.exchange, fund.pair), fund]));
  for (const exchange of fs.readdirSync(stageDir, { withFileTypes: true })) {
    if (!exchange.isDirectory() || NON_EXCHANGE_DIRS.has(exchange.name) || exchange.name.startsWith('.')) continue;
    for (const pair of fs.readdirSync(path.join(stageDir, exchange.name), { withFileTypes: true })) {
      if (!pair.isDirectory() || pair.name.startsWith('.')) continue;
      const fundDir = path.join(stageDir, exchange.name, pair.name);
      if (fs.readdirSync(fundDir).some((name) => FUND_STATE_SNAPSHOT_FILENAMES.includes(name))) {
        funds.set(path.join(exchange.name, pair.name), { exchange: exchange.name, pair: pair.name });
      }
    }
  }
  return [...funds.values()];
};

/**
 * Funds whose directory under `dataDir` still holds an interrupted DCA import
 * journal (#1809). Its accounting files may be a partially published
 * generation, and the next recovery pass rolls the journal's target bytes
 * forward over any file still matching the recorded originals — so a snapshot
 * of that fund is not a recovery point, and a restore under it is either
 * replayed or stranded. Resolved against `dataDir` rather than through
 * hasPendingDcaImport (which uses the live DATA_DIR) so it sees exactly the
 * directories this backup or restore touches.
 * @param {string} dataDir
 * @param {Array<{exchange: string, pair: string}>} funds
 * @returns {Array<{exchange: string, pair: string}>}
 */
const fundsWithPendingDcaImport = (dataDir, funds) => funds.filter(({ exchange, pair }) =>
  fs.existsSync(path.join(dataDir, exchange, pair, DCA_IMPORT_JOURNAL_FILENAME)));

/**
 * Refusal for a pending import. The journal and every accounting byte are left
 * untouched: recovery, not the backup service, decides that import's outcome.
 * @param {Array<{exchange: string, pair: string}>} funds
 * @param {string} consequence - What was not done
 * @returns {{code: string, error: string}}
 */
const pendingDcaImportRefusal = (funds, consequence) => ({
  code: 'dca-import-pending',
  error: `${funds.map(({ exchange, pair }) => `${exchange}/${pair}`).join(', ')} ${funds.length === 1 ? 'has' : 'have'} an interrupted DCA import awaiting recovery (${DCA_IMPORT_JOURNAL_FILENAME}). `
    + 'Finish import recovery first — start the fund or retry the import so the journal is completed and removed — then try again. '
    + consequence,
});

/**
 * Archive-relative paths (any depth) that are DCA import journals. An archive
 * carrying one was taken mid-import: restoring it would reinstate the journal,
 * and recovery would then replay that import over the restored state.
 * @param {string[]} relPaths - `/`-separated paths
 * @returns {string[]}
 */
const dcaImportJournalPaths = (relPaths) => relPaths.filter((rel) => rel.split('/').pop() === DCA_IMPORT_JOURNAL_FILENAME);

/** @param {string[]} journals */
const archivedDcaImportRefusal = (journals) => ({
  code: 'archive-dca-import-pending',
  error: `This archive was taken while a DCA import was unresolved (${journals.join(', ')}), so its accounting files may be a partially published generation. `
    + 'Restore an archive taken after that import\'s recovery completed. No files were changed.',
});

/**
 * Every regular file below `root`, as `/`-separated relative paths, without
 * following symlinks.
 * @param {string} root
 * @param {string} [prefix]
 * @returns {string[]}
 */
const listTreeFiles = (root, prefix = '') => fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return listTreeFiles(path.join(root, entry.name), rel);
  return entry.isFile() ? [rel] : [];
});

/**
 * The funds a full restore of `entries` would write or reset, decided from the
 * archive listing alone: `restoredArchiveFunds` over the extracted tree, with
 * every legacy exchange-level and root-level translation counted (a superset,
 * so the pre-flight never admits a restore the applier would refuse).
 * @param {string[]} entries
 * @param {Object|null} snapshot
 * @param {Array<{exchange: string, pair: string}>} translations
 * @param {{exchange: string, pair: string|null}|null} [rootTranslation]
 * @returns {Array<{exchange: string, pair: string}>}
 */
const archiveEntryFunds = (entries, snapshot, translations, rootTranslation) => {
  const funds = new Map(configuredFundIdentities(snapshot).map((fund) => [`${fund.exchange}/${fund.pair}`, fund]));
  for (const entry of entries) {
    const [exchange, pair, name, ...rest] = entry.split('/');
    if (rest.length > 0 || !name || NON_EXCHANGE_DIRS.has(exchange) || exchange.startsWith('.') || pair.startsWith('.')) continue;
    if (FUND_STATE_SNAPSHOT_FILENAMES.includes(name)) funds.set(`${exchange}/${pair}`, { exchange, pair });
  }
  for (const { exchange, pair } of translations) funds.set(`${exchange}/${pair}`, { exchange, pair });
  if (rootTranslation?.pair) {
    funds.set(`${rootTranslation.exchange}/${rootTranslation.pair}`, { exchange: rootTranslation.exchange, pair: rootTranslation.pair });
  }
  return [...funds.values()];
};

/**
 * Apply the accounting readers' compatibility rules to files already on disk
 * (a snapshot or a staging tree), read-only. The caller supplies the paths to
 * check, relative to `root`.
 * @param {string} root
 * @param {Array<string>} relPaths - forward-slash relative paths
 * @returns {{ok: true} | {ok: false, error: string}}
 */
const checkPersistedPayloads = (root, relPaths) => {
  for (const rel of relPaths) {
    if (!classifyPayloadPath(rel)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    } catch (error) {
      return { ok: false, error: `${rel} is not readable: ${error.message}` };
    }
    const checked = validatePersistedPayload(rel, content);
    if (!checked.ok) return checked;
  }
  return { ok: true };
};

/**
 * Relative paths of the accounting files in an extracted staging tree: the
 * data-root files plus `<exchange>/<file>` and `<exchange>/<pair>/<file>`.
 * @param {string} root
 * @returns {Array<string>}
 */
const listStagedPayloadPaths = (root) => {
  const found = [];
  const walk = (dir, segments) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = [...segments, entry.name];
      if (entry.isFile() && classifyPayloadPath(next.join('/'))) found.push(next.join('/'));
      else if (entry.isDirectory() && next.length < 3 && !(next.length === 1 && NON_EXCHANGE_DIRS.has(entry.name))) walk(path.join(dir, entry.name), next);
    }
  };
  walk(root, []);
  return found;
};

/**
 * Validate a complete recovery point without mutating it. Restore stages use
 * the selected fund's manifest in memory so it is never applied as live state.
 * @param {string} snapshotDir
 * @param {string} snapshotId
 * @param {Object} [stagedManifest]
 * @returns {{ok: true, manifest: Object} | {ok: false, error: string}}
 */
const validateFundStateSnapshot = (snapshotDir, snapshotId, stagedManifest) => {
  // lstat every component: checking only the leaf permits an exchange or pair
  // symlink to make an otherwise supported filename escape the recovery tree.
  const checkPath = (segments, directory = false, readContents = false) => {
    let current = snapshotDir;
    for (let i = -1; i < segments.length; i++) {
      if (i >= 0) current = path.join(current, segments[i]);
      const stat = fs.lstatSync(current);
      const expectDirectory = i < segments.length - 1 || directory;
      if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`${segments.join('/') || 'snapshot directory'} must be a regular ${expectDirectory ? 'directory' : 'file'} (symlinks are not supported)`);
      }
    }
    if (!directory) {
      // Opening with no-follow also refuses a leaf replaced after lstat. An
      // actual read detects unreadable storage, rather than trusting mode bits.
      const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!fs.fstatSync(fd).isFile()) throw new Error(`${segments.join('/')} must be a regular file`);
        if (readContents) return fs.readFileSync(fd, 'utf8');
        fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  try {
    checkPath([], true);
    let manifest = stagedManifest;
    if (!manifest) {
      manifest = JSON.parse(checkPath([FUND_STATE_MANIFEST_FILENAME], false, true));
    }
    if (!manifest || Array.isArray(manifest) || manifest.manifestVersion !== FUND_STATE_MANIFEST_VERSION
      || !isSafeFundStateSegment(manifest.snapshotId) || manifest.snapshotId !== snapshotId
      || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
      || !Array.isArray(manifest.funds) || manifest.funds.length === 0
      || (manifest.placementIntentsCaptured !== undefined && manifest.placementIntentsCaptured !== true)) {
      throw new Error(`${FUND_STATE_MANIFEST_FILENAME} is malformed or unsupported (check identity, creation time and funds)`);
    }
    const identities = new Set();
    for (const fund of manifest.funds) {
      if (!fund || !isSafeFundStateSegment(fund.exchange) || !isSafeFundStateSegment(fund.pair)
        || !Array.isArray(fund.files) || fund.files.length === 0) {
        throw new Error('Snapshot contains a malformed fund identity or empty state file list');
      }
      const identity = `${fund.exchange}/${fund.pair}`;
      if (identities.has(identity)) throw new Error(`Snapshot contains duplicate fund identity: ${identity}`);
      identities.add(identity);
      const filenames = new Set();
      for (const name of fund.files) {
        if (!FUND_STATE_CAPTURED_FILENAMES.includes(name) || filenames.has(name)) {
          throw new Error(`Snapshot contains an unsupported or duplicate state file for ${identity}`);
        }
        filenames.add(name);
        if (name === PLACEMENT_INTENTS_FILENAME) {
          const file = `${identity}/${name}`;
          assertPlacementIntentRows(parsePlacementIntentsDocument(checkPath([fund.exchange, fund.pair, name], false, true), file), file);
        } else if (classifyPayloadPath(`${fund.exchange}/${fund.pair}/${name}`) === 'manual-trades'
          || classifyPayloadPath(`${fund.exchange}/${fund.pair}/${name}`) === 'corrective-buys') {
          // Recovery-buy ownership sidecars: unreadable content would make
          // startup cancel the open recovery buy they name.
          const file = `${identity}/${name}`;
          const checked = validatePersistedPayload(file, checkPath([fund.exchange, fund.pair, name], false, true));
          if (!checked.ok) throw new Error(checked.error);
        } else {
          checkPath([fund.exchange, fund.pair, name]);
        }
      }
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, error: `Fund-state snapshot is incomplete or invalid: ${error.message}` };
  }
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
 * @returns {Array<{snapshotId: string, createdAt: string, funds: Array<Object>, placementIntentsCaptured: boolean, sizeBytes: number}>}
 */
const listFundStateBackups = ({ paths: pathOverrides } = {}) => {
  const paths = resolvePaths(pathOverrides);
  if (!fs.existsSync(paths.fundStateBackupsDir)) return [];

  return fs.readdirSync(paths.fundStateBackupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafeFundStateSegment(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => {
      const snapshotDir = path.join(paths.fundStateBackupsDir, entry.name);
      const parsed = validateFundStateSnapshot(snapshotDir, entry.name);
      if (!parsed.ok) return null;
      const { manifest } = parsed;
      try {
        return {
          snapshotId: manifest.snapshotId,
          createdAt: manifest.createdAt,
          funds: manifest.funds,
          // Snapshots from before intents were captured cannot recover them.
          placementIntentsCaptured: manifest.placementIntentsCaptured === true,
          sizeBytes: directorySizeBytes(snapshotDir),
        };
      } catch (_error) {
        return null; // A snapshot may disappear while it is being listed.
      }
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
    if (stats.isFile()) candidates.push({ filename, filePath, stats, createdAtMs: archiveCreatedAtMs(filename, stats), mtimeMs: stats.mtimeMs });
  }
  candidates.sort(compareArchivesNewestFirst);
  // Only the newest candidates are integrity-tested (not every retained ZIP), and
  // verdicts are cached so a corrupt partial never anchors the schedule nor re-tests.
  for (const { filePath, stats, createdAtMs } of candidates) {
    if (isArchiveListable(filePath, stats)) return Math.round(createdAtMs);
  }
  return null;
};

/**
 * Non-blocking getNewestBackupTime for the scheduler. A cold gateway start has
 * an empty verdict cache, so the sync variant would run unzip tests on the
 * event loop for every candidate it walks past.
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

  // A fund mid-import would be captured as a mixed generation without the
  // journal that completes it (#1809): refuse, publishing and pruning nothing.
  const snapshotRefusal = (pending) => ({ success: false,
    ...pendingDcaImportRefusal(pending, 'No fund-state snapshot was published or pruned.') });
  const pendingBefore = fundsWithPendingDcaImport(paths.dataDir, identities);
  if (pendingBefore.length > 0) return snapshotRefusal(pendingBefore);

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
      for (const name of FUND_STATE_CAPTURED_FILENAMES) {
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

    // An import that began while the files were being copied.
    const pendingAfter = fundsWithPendingDcaImport(paths.dataDir, identities);
    if (pendingAfter.length > 0) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return snapshotRefusal(pendingAfter);
    }

    if (files === 0) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return { success: true, createdAt, funds: [], files: 0, pruned: 0 };
    }

    fs.writeFileSync(path.join(stageDir, FUND_STATE_MANIFEST_FILENAME), JSON.stringify({
      manifestVersion: FUND_STATE_MANIFEST_VERSION,
      snapshotId,
      createdAt,
      placementIntentsCaptured: true,
      funds,
    }, null, 2), { mode: 0o600 });
    fsyncFile(path.join(stageDir, FUND_STATE_MANIFEST_FILENAME));
    // Persist the whole staged tree, children before parents, before exposing it.
    for (const dir of [...snapshotDirs].sort((a, b) => b.length - a.length)) fsyncDir(dir);
    const validated = validateFundStateSnapshot(stageDir, snapshotId);
    if (!validated.ok) throw new Error(validated.error);
    // Never publish (and so never prune older points in favour of) a snapshot
    // whose accounting the readers would refuse (#1811).
    const compatible = checkPersistedPayloads(stageDir, funds.flatMap(({ exchange, pair, files: names }) => names.map((name) => `${exchange}/${pair}/${name}`)));
    if (!compatible.ok) throw new Error(compatible.error);
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
 * Validate a fund-state snapshot's identity and manifest and list the state
 * files it holds for one fund, without staging anything.
 * @param {string} snapshotId
 * @param {string} exchange
 * @param {string} pair
 * @param {{fundStateBackupsDir: string}} paths - Resolved paths
 * @returns {{ok: true, snapshotDir: string, files: Array<string>, manifest: Object} | {ok: false, error: string}}
 */
const resolveFundStateSnapshot = (snapshotId, exchange, pair, paths) => {
  if (!isSafeFundStateSegment(snapshotId) || !isSafeFundStateSegment(exchange) || !isSafeFundStateSegment(pair)) {
    return { ok: false, error: 'Invalid fund-state snapshot or fund identity' };
  }
  const snapshotDir = path.join(paths.fundStateBackupsDir, snapshotId);
  let stat;
  try {
    stat = fs.lstatSync(snapshotDir);
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? 'Fund-state snapshot not found' : error.message };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'Fund-state snapshot is invalid' };

  const parsed = validateFundStateSnapshot(snapshotDir, snapshotId);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const fund = parsed.manifest.funds.find((entry) => entry.exchange === exchange && entry.pair === pair);
  if (!fund) {
    return { ok: false, error: `Snapshot does not contain state for ${exchange}/${pair}` };
  }
  const compatible = checkPersistedPayloads(snapshotDir, fund.files.map((name) => `${exchange}/${pair}/${name}`));
  if (!compatible.ok) return { ok: false, error: `Fund-state snapshot is not restorable: ${compatible.error}. No files were changed.` };
  return { ok: true, snapshotDir, files: fund.files, manifest: parsed.manifest };
};

/**
 * A snapshot taken before placement intents were captured cannot say whether the
 * fund had an unresolved order POST, so presenting it as a complete
 * placement-safe recovery point would be false. Restoring one is allowed only
 * on an explicit acknowledgement; the destination's own intents are kept either way.
 * @param {Object} manifest - Validated snapshot manifest
 * @param {boolean} acceptMissingPlacementIntents
 * @returns {{ok: true} | {ok: false, code: string, error: string}}
 */
const checkPlacementIntentEvidence = (manifest, acceptMissingPlacementIntents) => (
  manifest.placementIntentsCaptured === true || acceptMissingPlacementIntents === true
    ? { ok: true }
    : {
      ok: false,
      code: 'placement-intents-not-captured',
      error: 'This snapshot predates placement-intent capture, so it cannot recover an unresolved order POST the fund may have had. Check the exchange for open orders on this fund, then retry with acceptMissingPlacementIntents. Intents already on this machine are kept.',
    }
);

/**
 * The checks `restoreFundStateBackup` makes before staging, run on their own so
 * a restore that would refuse does so before any engine is stopped (#1384).
 * @param {string} snapshotId
 * @param {string} exchange
 * @param {string} pair
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}, acceptMissingPlacementIntents?: boolean}} [options]
 * @returns {{ok: true} | {ok: false, error: string, code?: string}}
 */
const checkFundStateRestorePreconditions = (snapshotId, exchange, pair, { paths: pathOverrides, acceptMissingPlacementIntents = false } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveFundStateSnapshot(snapshotId, exchange, pair, paths);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const pending = fundsWithPendingDcaImport(paths.dataDir, [{ exchange, pair }]);
  if (pending.length > 0) return { ok: false, ...pendingDcaImportRefusal(pending, 'No files were changed.') };
  return checkPlacementIntentEvidence(resolved.manifest, acceptMissingPlacementIntents);
};

/**
 * Merge a snapshot's intents into the destination's. Rows are never dropped:
 * the union keeps every intent id from either side (the destination's row wins
 * a shared id as the newer state), so a restore can add blockers but never
 * clear one. An intent resolved after the snapshot returns and blocks until
 * normal reconciliation proves its outcome again.
 * @param {string} snapshotFile
 * @param {string} destinationFile
 * @returns {string} Serialized intents document
 */
const mergePlacementIntentsForRestore = (snapshotFile, destinationFile) => {
  const snapshotRows = assertPlacementIntentRows(parsePlacementIntentsDocument(fs.readFileSync(snapshotFile, 'utf8'), snapshotFile), snapshotFile);
  const destinationRows = fs.existsSync(destinationFile)
    ? parsePlacementIntentsDocument(fs.readFileSync(destinationFile, 'utf8'), destinationFile)
    : [];
  const destinationIds = new Set(destinationRows.map((row) => row?.id));
  return JSON.stringify({ version: 1, intents: [...snapshotRows.filter((row) => !destinationIds.has(row.id)), ...destinationRows] }, null, 2);
};

/**
 * Replace every staged fund's placement-intents.json with its union against the
 * destination's, so a full-archive restore adds blockers but never clears one
 * (the same rule restoreFundStateBackup applies). Throws on an unreadable
 * destination document: guessing "empty" there is the double-placement the
 * file exists to prevent.
 * @param {string} stageDir - extracted, layout-translated staging tree
 * @param {string} dataDir - destination data root
 */
const stageMergedPlacementIntents = (stageDir, dataDir) => {
  for (const rel of listStagedPayloadPaths(stageDir)) {
    if (classifyPayloadPath(rel) !== 'placement-intents') continue;
    const staged = path.join(stageDir, ...rel.split('/'));
    fs.writeFileSync(staged, mergePlacementIntentsForRestore(staged, path.join(dataDir, ...rel.split('/'))));
  }
};

/**
 * Restore one fund from a rolling state snapshot through the same durable
 * transactional applier used by full archives.
 * @param {string} snapshotId
 * @param {string} exchange
 * @param {string} pair
 * @param {{paths?: {dataDir?: string, baseConfigFile?: string}, logger?: Object, acceptMissingPlacementIntents?: boolean}} [options]
 * @returns {{success: boolean, filesRestored?: number, error?: string, code?: string, rolledBack?: boolean, recovery?: Object, warnings?: Array<string>}}
 */
const restoreFundStateBackup = (snapshotId, exchange, pair, { paths: pathOverrides, logger = SILENT_LOGGER, acceptMissingPlacementIntents = false } = {}) => {
  const paths = resolvePaths(pathOverrides);
  const resolved = resolveFundStateSnapshot(snapshotId, exchange, pair, paths);
  if (!resolved.ok) return { success: false, error: resolved.error };
  // Repeated here: the restore would otherwise leave the destination's journal
  // to roll its import forward over the restored generation (#1809).
  const pending = fundsWithPendingDcaImport(paths.dataDir, [{ exchange, pair }]);
  if (pending.length > 0) return { success: false, ...pendingDcaImportRefusal(pending, 'No files were changed.') };
  const evidence = checkPlacementIntentEvidence(resolved.manifest, acceptMissingPlacementIntents);
  if (!evidence.ok) return { success: false, code: evidence.code, error: evidence.error };
  const { snapshotDir } = resolved;

  const stageDir = fs.mkdtempSync(path.join(paths.dataDir, STAGE_PREFIX));
  let absent;
  try {
    for (const name of resolved.files) {
      const source = path.join(snapshotDir, exchange, pair, name);
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile()) throw new Error(`Snapshot state file is not a regular file: ${name}`);
      const target = path.join(stageDir, exchange, pair, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (name === PLACEMENT_INTENTS_FILENAME) {
        // Staged with the accounting files so one journal commits or rolls back both.
        fs.writeFileSync(target, mergePlacementIntentsForRestore(source, path.join(paths.dataDir, exchange, pair, name)));
      } else {
        fs.copyFileSync(source, target);
      }
    }
    const sourceValidated = validateFundStateSnapshot(snapshotDir, snapshotId);
    if (!sourceValidated.ok) throw new Error(sourceValidated.error);
    const validated = validateFundStateSnapshot(stageDir, snapshotId, {
      ...resolved.manifest,
      funds: [{ exchange, pair, files: resolved.files }],
    });
    if (!validated.ok) throw new Error(validated.error);
    // The source may have changed since preflight: re-check what will be applied.
    const compatible = checkPersistedPayloads(stageDir, resolved.files.map((name) => `${exchange}/${pair}/${name}`));
    if (!compatible.ok) throw new Error(compatible.error);
    absent = planAbsentFundState(stageDir, [{ exchange, pair }]);
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    return { success: false, error: `Fund-state restore staging failed: ${error.message}` };
  }

  const applied = applyStagedFiles({ dataDir: paths.dataDir, stageDir, filename: `${snapshotId}/${exchange}/${pair}`, logger,
    absent,
  });
  if (!applied.success && applied.rolledBack !== false) fs.rmSync(stageDir, { recursive: true, force: true });
  if (applied.success && resolved.manifest.placementIntentsCaptured !== true) {
    return { ...applied, warnings: [`Snapshot ${snapshotId} predates placement-intent capture: any unresolved order POST on ${exchange}/${pair} is NOT recovered. Check the exchange for open or duplicate orders before restarting this fund.`] };
  }
  return applied;
};

/**
 * Read an archive's manifest without extracting the archive.
 * @param {string} zipPath
 * @returns {{present: boolean, manifest?: Object, error?: string}}
 */
const readArchiveManifest = (zipPath, member = MANIFEST_FILENAME) =>
  parseManifestRead(spawnSync('unzip', ['-p', zipPath, unzipMember(member)], { timeout: SPAWN_TIMEOUT_MS }));

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
  getNewestBackupTime,
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
