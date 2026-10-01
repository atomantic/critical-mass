// @ts-check
/**
 * Recoverable, idempotent publication of a DCA-to-Regime import (issue #860).
 *
 * A DCA import rewrites three files of ONE fund that must agree with each
 * other: the fill ledger (synthetic DCA fills + body annotations), the regime
 * position (celestial bodies, deposited capital) and the DCA source state
 * (orders consumed as `migrated_to_regime`). Writing them one after another
 * left a failure between writes as a mixed generation — the position committed
 * while the source orders stayed importable — and a retry then appended
 * duplicate bodies and attributed the DCA capital a second time.
 *
 * Protocol (per fund directory):
 *   1. Recover any interrupted earlier import first.
 *   2. Exclusively create `.dca-import-journal.json` (status `staging`). Its
 *      presence is the fail-closed gate: neither the regime engine nor the DCA
 *      engine trades the fund while it exists.
 *   3. Copy the live files into a private staging directory and run the
 *      converter's ordinary load/save code against it (via
 *      migration.withFundDataDirOverride). No live file is touched.
 *   4. Validate the staged generation, then durably record the originals,
 *      the target bytes and their hashes in the journal (status `publishing`).
 *   5. Publish each target by atomic replacement, then remove the journal.
 *
 * Recovery: a `staging` journal means nothing was published — discard it. A
 * `publishing` journal holds a complete, validated target generation — roll
 * forward (idempotent; files already at their target are left alone). A live
 * file matching neither its recorded original nor its target means something
 * else wrote it, so recovery refuses rather than overwrite it, leaving the
 * journal (and therefore the trading gate) in place for the operator.
 */

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const migration = require('./migration');
const { log } = require('./logger');

const JOURNAL_FILENAME = '.dca-import-journal.json';
const STAGING_PREFIX = '.dca-import-staging-';
// Publication order: accounting history first, then the position derived
// from it, then the source consumption that makes the import non-repeatable.
const TARGET_FILES = Object.freeze(['fill-ledger.json', 'regime-state.json', 'state.json']);
const JOURNAL_STATUSES = new Set(['staging', 'publishing']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @param {string} bytes */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Resolve the fund pair the same way migration.resolveFundDataDir does.
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {string}
 */
const resolvePair = (exchange, pair) => pair || require('./config-utils').getDefaultPair(exchange) || 'default';

/**
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {string} Live per-fund data directory
 */
const liveFundDir = (exchange, pair) => migration.resolveFundDataDir(exchange, resolvePair(exchange, pair));

/** @param {string} file */
const readOptional = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** @param {string} target */
const fsyncPath = (target) => {
  const fd = fs.openSync(target, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

/** @param {string} file */
const tmpPathFor = (file) => `${file}.${process.pid}.${randomUUID()}.tmp`;

/**
 * Write bytes to a fresh temp file and fsync it.
 * @param {string} tmp
 * @param {string} bytes
 */
const writeSynced = (tmp, bytes) => {
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Durable atomic replacement: fsynced temp file, rename, fsync the directory.
 * @param {string} file
 * @param {string} bytes
 */
const durableReplace = (file, bytes) => {
  const tmp = tmpPathFor(file);
  try {
    writeSynced(tmp, bytes);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncPath(path.dirname(file));
};

/**
 * Durably create `file` only if it does not exist yet (link() is exclusive and
 * atomic, so a crash can never leave a torn journal behind).
 * @param {string} file
 * @param {string} bytes
 */
const durableCreateExclusive = (file, bytes) => {
  const tmp = tmpPathFor(file);
  try {
    writeSynced(tmp, bytes);
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fsyncPath(path.dirname(file));
};

/** @param {string} dir */
const removeJournal = (dir) => {
  fs.rmSync(path.join(dir, JOURNAL_FILENAME), { force: true });
  fsyncPath(dir);
};

/**
 * Remove leftover staging directories (never contain live data).
 * @param {string} dir
 */
const cleanupStaging = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(STAGING_PREFIX)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
};

/**
 * Shape checks on one staged target before it may be recorded as a target.
 * @param {string} file
 * @param {string} bytes
 * @returns {any} Parsed document
 */
const validateStagedFile = (file, bytes) => {
  let doc;
  try {
    doc = JSON.parse(bytes);
  } catch (err) {
    throw new Error(`Staged ${file} is not valid JSON: ${err.message}`);
  }
  if (file === 'fill-ledger.json') {
    if (!Array.isArray(doc)) throw new Error('Staged fill-ledger.json is not an array');
    return doc;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`Staged ${file} is not an object`);
  if (file === 'state.json') {
    if (!Array.isArray(doc.orders)) throw new Error('Staged state.json has no orders array');
    return doc;
  }
  const position = doc.position;
  if (!position || typeof position !== 'object' || Array.isArray(position)) throw new Error('Staged regime-state.json has no position');
  if (!Array.isArray(position.celestialBodies)) throw new Error('Staged regime position has no celestialBodies array');
  for (const field of ['depositedCapital', 'totalAsset', 'totalCostBasis']) {
    if (position[field] !== undefined && !Number.isFinite(position[field])) {
      throw new Error(`Staged regime position ${field} is not finite`);
    }
  }
  // One body per imported buy: a source buy order may back at most one body.
  const owners = new Map();
  for (const body of position.celestialBodies) {
    for (const orderId of body?.sourceOrderIds || []) {
      if (owners.has(orderId) && owners.get(orderId) !== body.id) {
        throw new Error(`Staged regime position has two bodies (${owners.get(orderId)}, ${body.id}) for buy order ${orderId}`);
      }
      owners.set(orderId, body.id);
    }
  }
  return doc;
};

/**
 * Read and validate a journal. Anything unexpected is fail-closed: the caller
 * must leave the journal in place (it keeps the fund from trading).
 * @param {string} journalFile
 */
const readJournal = (journalFile) => {
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  } catch (err) {
    throw new Error(`DCA import journal is unreadable (${err.message}); preserve it and restore from the .backup-dca-convert-* files`);
  }
  if (!journal || journal.version !== 1 || typeof journal.id !== 'string' || !UUID_RE.test(journal.id)
    || !JOURNAL_STATUSES.has(journal.status) || !Array.isArray(journal.entries)) {
    throw new Error('DCA import journal is invalid; preserve it and restore from the .backup-dca-convert-* files');
  }
  const seen = new Set();
  for (const entry of journal.entries) {
    if (!entry || !TARGET_FILES.includes(entry.file) || seen.has(entry.file)
      || typeof entry.after !== 'string' || hash(entry.after) !== entry.afterHash
      || !(entry.before === null || (typeof entry.before === 'string' && hash(entry.before) === entry.beforeHash))) {
      throw new Error('DCA import journal entry is invalid; preserve it and restore from the .backup-dca-convert-* files');
    }
    seen.add(entry.file);
  }
  return journal;
};

/**
 * Roll a `publishing` journal forward. Checks every target before replacing
 * any of them, so a fund changed outside the import is never half-rewritten.
 * @param {string} dir
 * @param {any} journal
 */
const publishEntries = (dir, journal) => {
  const targets = journal.entries.map((entry) => {
    const file = path.join(dir, entry.file);
    const current = readOptional(file);
    const currentHash = current === null ? null : hash(current);
    const beforeHash = entry.before === null ? null : entry.beforeHash;
    if (currentHash !== entry.afterHash && currentHash !== beforeHash) {
      throw new Error(`${entry.file} changed outside the DCA import; refusing to overwrite it (journal ${journal.id} retained)`);
    }
    return { file, entry, done: currentHash === entry.afterHash };
  });
  for (const { file, entry, done } of targets) {
    if (done) continue;
    durableReplace(file, entry.after);
    if (hash(fs.readFileSync(file, 'utf8')) !== entry.afterHash) {
      throw new Error(`${entry.file} verification failed after DCA import publication`);
    }
  }
};

/**
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {boolean} True while an interrupted DCA import blocks the fund
 */
const hasPendingDcaImport = (exchange, pair) => fs.existsSync(path.join(liveFundDir(exchange, pair), JOURNAL_FILENAME));

/**
 * Complete or discard an interrupted DCA import for one fund. Idempotent; a
 * no-op when nothing is pending. Throws (journal retained) when recovery
 * cannot prove it is safe.
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {{ recovered: boolean, action?: 'discarded' | 'rolled-forward', id?: string, kind?: string }}
 */
const recoverDcaImport = (exchange, pair) => {
  const dir = liveFundDir(exchange, pair);
  const journalFile = path.join(dir, JOURNAL_FILENAME);
  if (!fs.existsSync(journalFile)) {
    cleanupStaging(dir);
    return { recovered: false };
  }
  const journal = readJournal(journalFile);
  const label = `${exchange}/${resolvePair(exchange, pair)}`;
  if (journal.status === 'staging') {
    // Interrupted before the target generation was recorded: no live file
    // was replaced, so the import simply did not happen.
    cleanupStaging(dir);
    removeJournal(dir);
    log('WARN', `[${label}] Discarded interrupted DCA import ${journal.id} (nothing had been published)`);
    return { recovered: true, action: 'discarded', id: journal.id, kind: journal.kind };
  }
  publishEntries(dir, journal);
  removeJournal(dir);
  cleanupStaging(dir);
  log('WARN', `[${label}] Completed interrupted DCA import ${journal.id} (${journal.entries.map((e) => e.file).join(', ')})`);
  return { recovered: true, action: 'rolled-forward', id: journal.id, kind: journal.kind };
};

/**
 * Run one DCA import as a recoverable transaction.
 *
 * `stage` runs synchronously with this fund's data directory redirected to a
 * private staging copy; it performs the import with the ordinary state-tracker
 * / fill-ledger APIs and returns the caller's result. Nothing it writes is
 * visible until the whole staged generation validates and is journaled.
 *
 * @template T
 * @param {Object} options
 * @param {string} options.exchange
 * @param {string} [options.pair]
 * @param {'convert'|'merge'} options.kind
 * @param {Array<{orderId: string|null|undefined, buyOrderId: string|null|undefined}>} options.sourceOrders - Stable identities of the consumed DCA orders
 * @param {(ctx: { importId: string }) => T} options.stage
 * @param {(docs: Record<string, any>) => void} [options.validate] - Cross-file check on the parsed staged generation
 * @returns {T}
 */
const runDcaImportTransaction = ({ exchange, pair, kind, sourceOrders, stage, validate }) => {
  const resolvedPair = resolvePair(exchange, pair);
  const label = `${exchange}/${resolvedPair}`;
  recoverDcaImport(exchange, resolvedPair);

  const dir = liveFundDir(exchange, resolvedPair);
  const journalFile = path.join(dir, JOURNAL_FILENAME);
  const importId = randomUUID();
  const journal = {
    version: 1,
    id: importId,
    kind,
    exchange,
    pair: resolvedPair,
    status: 'staging',
    createdAt: new Date().toISOString(),
    sourceOrders: sourceOrders.map((o) => ({ orderId: o.orderId ?? null, buyOrderId: o.buyOrderId ?? null })),
    entries: /** @type {Array<Object>} */ ([]),
  };
  durableCreateExclusive(journalFile, JSON.stringify(journal, null, 2));

  const stagingDir = path.join(dir, `${STAGING_PREFIX}${importId}`);
  let result;
  try {
    fs.mkdirSync(stagingDir, { mode: 0o700 });
    /** @type {Record<string, string|null>} */
    const before = {};
    for (const file of TARGET_FILES) {
      before[file] = readOptional(path.join(dir, file));
      if (before[file] !== null) fs.writeFileSync(path.join(stagingDir, file), /** @type {string} */ (before[file]), { mode: 0o600 });
    }

    result = migration.withFundDataDirOverride(exchange, resolvedPair, stagingDir, () => stage({ importId }));

    const unexpected = fs.readdirSync(stagingDir).filter((name) => !TARGET_FILES.includes(name));
    if (unexpected.length > 0) throw new Error(`DCA import staged unexpected files: ${unexpected.join(', ')}`);

    /** @type {Record<string, any>} */
    const docs = {};
    for (const file of TARGET_FILES) {
      const after = readOptional(path.join(stagingDir, file));
      if (after === null) {
        if (before[file] !== null) throw new Error(`DCA import staging removed ${file}`);
        continue;
      }
      docs[file] = validateStagedFile(file, after);
      if (after === before[file]) continue;
      journal.entries.push({
        file,
        before: before[file],
        beforeHash: before[file] === null ? null : hash(/** @type {string} */ (before[file])),
        after,
        afterHash: hash(after),
      });
    }
    if (validate) validate(docs);

    journal.status = 'publishing';
    durableReplace(journalFile, JSON.stringify(journal, null, 2));
  } catch (err) {
    // Nothing live has been replaced yet: discarding the journal is exact.
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      removeJournal(dir);
    } catch (cleanupErr) {
      // A leftover `staging` journal is discarded by the next recovery pass.
      log('WARN', `[${label}] DCA import ${importId} abort cleanup failed: ${cleanupErr.message}`);
    }
    throw err;
  }
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (_) {
    // Staging copies are never read again; recovery sweeps leftovers.
  }

  try {
    try {
      publishEntries(dir, journal);
    } catch (firstErr) {
      // One immediate roll-forward retry in the same synchronous step absorbs
      // a transient write failure before any other writer can run.
      log('WARN', `[${label}] DCA import ${importId} publication failed (${firstErr.message}); retrying once`);
      publishEntries(dir, journal);
    }
  } catch (err) {
    log('ERROR', `[${label}] DCA import ${importId} publication interrupted: ${err.message} — journal retained; the fund stays blocked until recovery completes`);
    const wrapped = new Error(`DCA import for ${label} was interrupted while publishing; it will be completed by recovery before the fund can trade or import again`);
    /** @type {any} */ (wrapped).recoveryPending = true;
    throw wrapped;
  }

  try {
    removeJournal(dir);
  } catch (err) {
    // Every target is published; a retained journal only costs an idempotent
    // roll-forward on the next recovery pass.
    log('WARN', `[${label}] DCA import ${importId} published but its journal could not be removed: ${err.message}`);
  }
  return result;
};

module.exports = {
  JOURNAL_FILENAME,
  STAGING_PREFIX,
  TARGET_FILES,
  hasPendingDcaImport,
  recoverDcaImport,
  runDcaImportTransaction,
};
