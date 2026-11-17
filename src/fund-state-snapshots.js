// @ts-check
/**
 * Fund-state snapshots
 *
 * The lightweight hourly per-fund snapshots (create, list, prune, validate and
 * restore), plus the fund-state, placement-intent and DCA-import-journal checks
 * that full archive restore shares with them.
 */

const fs = require('fs');
const path = require('path');
const { fsyncDir } = require('./fsync-dir');
const { fsyncFile } = require('./durable-write');
const { validatePersistedPayload, classifyPayloadPath } = require('./persisted-payload-validation');
const { applyStagedFiles, STAGE_PREFIX } = require('./restore-apply');
const { normalizeExchangeBlock, GLOBAL_DEFAULTS } = require('./config-utils');
const { serializeFundState } = require('./dry-run-state');
const { JOURNAL_FILENAME: DCA_IMPORT_JOURNAL_FILENAME } = require('./dca-conversion-transaction');
const { PLACEMENT_INTENTS_FILENAME, parsePlacementIntentsDocument, assertPlacementIntentRows } = require('./placement-intent-document');
const { ensureBackupsDir, FUND_STATE_MANIFEST_FILENAME, readEffectiveConfig, resolvePaths, SILENT_LOGGER } = require('./backup-common');
const { NON_EXCHANGE_DIRS } = require('./backup-layout-translation');

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

module.exports = {
  planAbsentFundState,
  restoredArchiveFunds,
  fundsWithPendingDcaImport,
  pendingDcaImportRefusal,
  dcaImportJournalPaths,
  archivedDcaImportRefusal,
  listTreeFiles,
  archiveEntryFunds,
  checkPersistedPayloads,
  listStagedPayloadPaths,
  listFundStateBackups,
  getNewestFundStateBackupTime,
  pruneFundStateBackups,
  createFundStateBackup,
  checkFundStateRestorePreconditions,
  stageMergedPlacementIntents,
  restoreFundStateBackup,
};
