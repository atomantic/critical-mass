// @ts-check
/**
 * Legacy layout translation
 *
 * Plans how an archive laid out before multi-pair funds (exchange-level
 * per-fund files) or before exchange namespacing (artifacts at the data root)
 * is relocated into the per-fund layout on restore, and discloses that plan
 * from an archive's entry listing alone. Nothing here writes to disk.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { LEGACY_EXCHANGE, isLegacyRootArtifact } = require('./legacy-namespace-migration');
const { normalizeExchangeBlock } = require('./config-utils');
const { isPerFundFile, legacyRootArtifactTarget, legacyRootArtifactCandidates, PAIR_MIGRATION_CONFLICT_FILES } = require('./migration');
const { ROOT_COMPARE_MAX_BYTES, SPAWN_TIMEOUT_MS, unzipMember } = require('./backup-common');

/** Per-fund state file names whose presence marks a fund as still holding data. */
const FUND_STATE_FILENAMES = ['state.json', 'regime-state.json', 'fill-ledger.json'];

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
 * @param {{entries: string[], members: Map<string, string>}} params.archive
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

module.exports = {
  FUND_STATE_FILENAMES,
  NON_EXCHANGE_DIRS,
  collectExchangeFilesFromEntries,
  collectExchangeFilesFromDir,
  collectRootFilesFromEntries,
  planLayoutTranslation,
  findRootCollisions,
  rootCollisionEntries,
  findLegacyIntentCollisions,
  intentCollisionError,
  projectedArchivePaths,
  describeLayoutTranslation,
};
