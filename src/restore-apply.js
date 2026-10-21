// @ts-check
/**
 * Transactional Restore Application
 *
 * Applying a backup archive replaces live accounting files (fill ledgers,
 * regime/position state, config). Copying them one by one straight over their
 * destinations has two failure modes that both destroy a coherent recovery
 * point (issue #431):
 *
 *  - A mid-way error (ENOSPC, EACCES) leaves earlier files on the archive's
 *    generation and later files on the current one, with no way back.
 *  - A process death during an overwrite leaves a truncated destination, and
 *    nothing on disk tells the next start that the data is a mixed generation.
 *
 * This module applies a staged file set as a single recoverable transaction:
 *
 *  1. Validate the WHOLE staged set (readable regular files, writable
 *     destination directories) before touching anything.
 *  2. Copy every destination that will be replaced into an originals directory
 *     and record it — plus every "this file did not exist" entry and every
 *     directory we create — in a durably-fsynced journal.
 *  3. Replace each destination with same-directory temp file + `rename`, which
 *     is atomic: a reader sees the old bytes or the new bytes, never a
 *     truncated file.
 *  4. Mark the journal committed only once every destination succeeded, then
 *     drop the originals and the journal.
 *
 * Any failure in step 3 rolls every destination back to its pre-restore bytes
 * and removes files the attempt created. If the rollback itself fails, the
 * journal and originals are RETAINED and an incomplete-recovery status is
 * returned so the operator can retry instead of guessing.
 *
 * `recoverIncompleteRestore` is the restart half: the gateway and every engine
 * process run it before they load persisted state, so a crash between file
 * replacements finishes its rollback (or blocks startup) rather than letting
 * trading resume on a half-restored ledger.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { hasPendingBackfill } = require('./fifo-backfill-transaction');
const { fsyncDir } = require('./fsync-dir');
const { atomicWriteSync, fsyncFile } = require('./durable-write');

/** Durable marker + rollback plan. Lives in the data dir so any process finds it. */
const JOURNAL_FILENAME = '.restore-journal.json';

/** Journal envelope version — recovery refuses anything it does not understand. */
const JOURNAL_VERSION = 1;

/** Pre-restore copies of every destination the attempt replaces. */
const ORIGINALS_PREFIX = '.restore-originals-';

/** Archive extraction staging directory. */
const STAGE_PREFIX = '.restore-temp-';

/** A staging directory younger than this may still be extracting in another process. */
const ORPHAN_STAGE_MIN_AGE_MS = 10 * 60_000;

/** Journal lifecycle. Anything but `committed` means data/ may be mixed-generation. */
const STATUS = {
  APPLYING: 'applying',
  ROLLING_BACK: 'rolling-back',
  COMMITTED: 'committed',
  INCOMPLETE: 'incomplete',
};

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Run a filesystem operation and hand back the failure instead of throwing.
 * The whole module is fault-injection plumbing, so every step needs this; it is
 * the one try/catch here rather than one per call site.
 * @param {() => any} fn - Operation to run
 * @returns {{ok: true, value: any} | {ok: false, error: Error}} Outcome
 */
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
};

/**
 * Deterministic sibling temp path for staging a replacement of `dest`. The name
 * is predictable (no pid/timestamp) so a temp file orphaned by a process death
 * can be found and removed by rollback before the next attempt. A
 * restore is serialized by the journal and maintenance lock, so two live
 * writers never share a name.
 * @param {string} dest - Destination file
 * @returns {string} Temp file path next to `dest`
 */
const restoreTmpPath = (dest) => path.join(path.dirname(dest), `.${path.basename(dest)}.restore-tmp`);

/**
 * Copy `src` over `dest` without ever leaving `dest` partially written: the
 * bytes land in a sibling temp file on the SAME filesystem, are flushed, and
 * then replace the destination with a single atomic rename.
 *
 * An existing destination's permission mode is preserved across the replace —
 * tmp+rename creates a new inode, so without this an operator who tightened a
 * file to 0600 would silently get it widened.
 * @param {string} src - Source file
 * @param {string} dest - Destination file
 * @returns {void}
 */
const replaceFileAtomic = (src, dest) => {
  atomicWriteSync(dest, fs.readFileSync(src), {
    preserveMode: true,
    mode: fs.statSync(src).mode & 0o777,
    temporaryPath: restoreTmpPath(dest),
  });
};

/**
 * Walk a staged extraction directory and return every file it would apply,
 * as paths relative to the staging root, plus the directories that would have
 * to be created under the destination.
 *
 * @param {Object} params
 * @param {string} params.stageDir - Extraction root
 * @param {string} params.dataDir - Destination root
 * @param {(name: string, isRoot: boolean) => boolean} [params.skip] - Entry filter (name, at-stage-root)
 * @returns {{files: string[], dirs: string[]}} Relative file and directory paths
 */
const collectStagedSet = ({ stageDir, dataDir, skip = () => false }) => {
  const files = [];
  const dirs = [];

  const walk = (relDir) => {
    const entries = fs.readdirSync(path.join(stageDir, relDir), { withFileTypes: true });
    for (const entry of entries) {
      if (skip(entry.name, relDir === '')) continue;
      const rel = relDir === '' ? entry.name : path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(path.join(dataDir, rel))) dirs.push(rel);
        walk(rel);
      } else {
        files.push(rel);
      }
    }
  };

  walk('');
  return { files, dirs };
};

/**
 * Reject the whole staged set before a single destination is touched: a source
 * that is not a readable regular file (a symlink smuggled into the archive, an
 * unreadable extraction) would otherwise be discovered halfway through the
 * application, with earlier destinations already replaced.
 *
 * @param {Object} params
 * @param {string} params.stageDir - Extraction root
 * @param {string} params.dataDir - Destination root
 * @param {string[]} params.files - Relative staged file paths
 * @returns {{ok: true} | {ok: false, error: string}} Validation outcome
 */
const validateStagedSet = ({ stageDir, dataDir, files }) => {
  for (const rel of files) {
    const src = path.join(stageDir, rel);
    const stat = attempt(() => fs.lstatSync(src));
    if (!stat.ok) return { ok: false, error: `Staged file ${rel} is not readable: ${stat.error.message}` };
    if (!stat.value.isFile()) return { ok: false, error: `Staged entry ${rel} is not a regular file — refusing to apply the archive` };
    const readable = attempt(() => fs.accessSync(src, fs.constants.R_OK));
    if (!readable.ok) return { ok: false, error: `Staged file ${rel} is not readable: ${readable.error.message}` };

    // The destination's parent must be writable NOW, not at rename time.
    const destDir = path.dirname(path.join(dataDir, rel));
    const existing = attempt(() => fs.statSync(destDir));
    if (existing.ok) {
      const writable = attempt(() => fs.accessSync(destDir, fs.constants.W_OK));
      if (!writable.ok) return { ok: false, error: `Destination directory for ${rel} is not writable: ${writable.error.message}` };
    }
  }
  return { ok: true };
};

/**
 * Read and validate the journal, if one is present.
 * @param {string} dataDir - Data directory
 * @returns {{present: false} | {present: true, ok: true, journal: Object} | {present: true, ok: false, error: string}} Journal state
 */
const readJournal = (dataDir) => {
  const file = path.join(dataDir, JOURNAL_FILENAME);
  if (!fs.existsSync(file)) return { present: false };
  const parsed = attempt(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.ok) return { present: true, ok: false, error: `${JOURNAL_FILENAME} is unreadable or not valid JSON: ${parsed.error.message}` };
  const journal = parsed.value;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !Array.isArray(journal.entries)) {
    return { present: true, ok: false, error: `${JOURNAL_FILENAME} is malformed (no entry list)` };
  }
  if (journal.journalVersion !== JOURNAL_VERSION) {
    return { present: true, ok: false, error: `${JOURNAL_FILENAME} version ${JSON.stringify(journal.journalVersion)} is not supported by this build (expected ${JOURNAL_VERSION})` };
  }
  return { present: true, ok: true, journal };
};

/**
 * Persist the journal at the given status, flushed before the caller acts on it.
 * @param {string} dataDir - Data directory
 * @param {Object} journal - Journal object
 * @param {string} status - One of STATUS
 * @returns {{ok: true, journal: Object} | {ok: false, error: Error}} Write outcome
 */
const writeJournal = (dataDir, journal, status) => {
  const next = { ...journal, status, updatedAt: new Date().toISOString() };
  const written = attempt(() => atomicWriteSync(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify(next, null, 2)));
  return written.ok ? { ok: true, journal: next } : { ok: false, error: written.error };
};

/**
 * Delete the journal and every artifact it references. Called once the
 * transaction has reached a safe state (committed, or fully rolled back) —
 * never while destinations may still be mixed-generation.
 * @param {string} dataDir - Data directory
 * @param {Object} journal - Journal object
 * The journal must be durably absent BEFORE any original is deleted. Otherwise
 * a crash during cleanup can leave a rollback marker with missing originals.
 * @returns {{ok: true, value: any} | {ok: false, error: Error}} Journal retirement outcome
 */
const cleanupArtifacts = (dataDir, journal) => {
  const retired = attempt(() => {
    fs.rmSync(path.join(dataDir, JOURNAL_FILENAME), { force: true });
    fsyncDir(dataDir);
  });
  if (!retired.ok) return retired;
  for (const rel of [journal.originalsDir, journal.stageDir].filter(Boolean)) {
    attempt(() => fs.rmSync(path.join(dataDir, rel), { recursive: true, force: true }));
  }
  return retired;
};

/**
 * Put every destination named by the journal back the way it was: restore the
 * saved bytes for files that existed, remove files the attempt created, and
 * drop directories the attempt created (only while empty — a directory that
 * picked up unrelated content stays).
 *
 * @param {Object} params
 * @param {string} params.dataDir - Data directory
 * @param {Object} params.journal - Journal object
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @returns {{ok: boolean, restored: number, removed: number, failures: string[]}} Rollback outcome
 */
const rollbackFromJournal = ({ dataDir, journal, logger }) => {
  const failures = [];
  let restored = 0;
  let removed = 0;

  for (const entry of journal.entries) {
    const dest = path.join(dataDir, entry.dest);
    // A crash between copy and rename orphans the staged temp copy.
    const cleared = attempt(() => fs.rmSync(restoreTmpPath(dest), { force: true }));
    if (!cleared.ok) failures.push(`${entry.dest}: ${cleared.error.message}`);
    if (entry.existed) {
      const original = path.join(dataDir, journal.originalsDir, entry.dest);
      if (!fs.existsSync(original)) {
        failures.push(`${entry.dest}: saved original is missing at ${journal.originalsDir}/${entry.dest}`);
        continue;
      }
      const back = attempt(() => replaceFileAtomic(original, dest));
      if (back.ok) restored++;
      else failures.push(`${entry.dest}: ${back.error.message}`);
      continue;
    }
    // The attempt created this file; the pre-restore state had nothing here.
    const gone = attempt(() => {
      fs.rmSync(dest, { force: true });
      if (fs.existsSync(path.dirname(dest))) fsyncDir(path.dirname(dest));
    });
    if (gone.ok) removed++;
    else failures.push(`${entry.dest}: ${gone.error.message}`);
  }

  // Deepest first, so nested creations unwind cleanly.
  for (const rel of [...(journal.createdDirs || [])].sort((a, b) => b.length - a.length)) {
    const dir = path.join(dataDir, rel);
    const removedDir = attempt(() => fs.rmdirSync(dir));
    if (removedDir.ok) {
      const synced = attempt(() => fsyncDir(path.dirname(dir)));
      if (!synced.ok) failures.push(`${rel}: ${synced.error.message}`);
    }
  }

  if (failures.length > 0) {
    logger.error(`❌ 💾 Restore rollback incomplete: ${failures.length} of ${journal.entries.length} destination(s) could not be reverted — ${failures.join('; ')}`, {
      action: 'restore-rollback', restoreId: journal.restoreId, failures: failures.length,
    });
  }
  return { ok: failures.length === 0, restored, removed, failures };
};

/**
 * Describe the artifacts an operator needs to retry a failed rollback by hand.
 * @param {Object} journal - Journal object
 * @returns {{restoreId: string, journal: string, originalsDir: string, status: string}} Artifact summary
 */
const describeArtifacts = (journal) => ({
  restoreId: journal.restoreId,
  journal: JOURNAL_FILENAME,
  originalsDir: journal.originalsDir,
  status: journal.status,
});

/**
 * Move the journal to `rolling-back`, revert, and settle it: cleaned away on
 * success, flipped to `incomplete` and RETAINED on failure. Shared verbatim by
 * the in-flight failure path and by restart recovery so the two can never drift
 * on which artifacts survive.
 *
 * The rollback marker must land before any reversion: a failed commit flush
 * may have left a `committed` marker visible. Reverting under that marker
 * would let startup treat a partial rollback as a committed restore.
 *
 * @param {Object} params
 * @param {string} params.dataDir - Data directory
 * @param {Object} params.journal - Journal object
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @returns {{ok: boolean, restored: number, removed: number, failures: string[], recovery?: Object}} Outcome
 */
const revertAndSettle = ({ dataDir, journal, logger }) => {
  const marked = writeJournal(dataDir, journal, STATUS.ROLLING_BACK);
  if (!marked.ok) {
    const failures = [`Could not persist rollback marker: ${marked.error.message}`];
    return { ok: false, restored: 0, removed: 0, failures, recovery: { ...describeArtifacts(journal), failures } };
  }
  const current = marked.journal;

  const rolled = rollbackFromJournal({ dataDir, journal: current, logger });
  if (rolled.ok) {
    const cleaned = cleanupArtifacts(dataDir, current);
    if (cleaned.ok) return rolled;
    rolled.ok = false;
    rolled.failures.push(`Could not retire rollback journal: ${cleaned.error.message}`);
  }

  const incomplete = writeJournal(dataDir, current, STATUS.INCOMPLETE);
  const retained = incomplete.ok ? incomplete.journal : { ...current, status: STATUS.INCOMPLETE };
  return { ...rolled, recovery: { ...describeArtifacts(retained), failures: rolled.failures } };
};

/**
 * Apply an extracted archive to the data directory as one recoverable
 * transaction. See the module header for the full contract.
 *
 * @param {Object} params
 * @param {string} params.dataDir - Destination root
 * @param {string} params.stageDir - Extraction root (absolute, inside dataDir)
 * @param {string} [params.filename] - Archive filename, for journal/log context
 * @param {(name: string, isRoot: boolean) => boolean} [params.skip] - Staged-entry filter
 * @param {{info: Function, warn: Function, error: Function}} [params.logger] - Context logger
 * @returns {{success: true, filesRestored: number} |
 *   {success: false, code: string, error: string, rolledBack: boolean, recovery?: Object}} Application outcome.
 *   `rolledBack: true` is the caller's guarantee that the data directory is at
 *   its pre-restore state — whether the attempt was refused before the first
 *   write or reverted after one. `false` means it is a mixed generation and
 *   `recovery` names the artifacts a retry needs.
 */
const applyStagedFiles = ({ dataDir, stageDir, filename = 'archive', skip, logger = NOOP_LOGGER }) => {
  const startedAt = Date.now();
  // Nothing is journalled yet, so a walk that throws must be reported as a
  // refusal (rolledBack: true) — the caller then disposes of the staging tree.
  let staged;
  try {
    staged = collectStagedSet({ stageDir, dataDir, skip });
  } catch (error) {
    logger.error(`❌ 💾 Restore refused before any write: could not read the staged set: ${error.message}`, { action: 'restore-apply', filename, error: error.message });
    return { success: false, code: 'staged-set-unreadable', error: `Could not read the extracted archive: ${error.message}. No files were changed.`, rolledBack: true };
  }
  const { files, dirs } = staged;

  let valid;
  try {
    valid = validateStagedSet({ stageDir, dataDir, files });
  } catch (error) {
    valid = { ok: false, error: `Could not validate the extracted archive: ${error.message}. No files were changed.` };
  }
  if (!valid.ok) {
    logger.error(`❌ 💾 Restore refused before any write: ${valid.error}`, { action: 'restore-apply', filename, error: valid.error });
    return { success: false, code: 'staged-set-invalid', error: valid.error, rolledBack: true };
  }

  const restoreId = `${Date.now()}-${process.pid}`;
  const originalsDir = `${ORIGINALS_PREFIX}${restoreId}`;
  const originalsPath = path.join(dataDir, originalsDir);

  // ---- Save every destination we are about to replace -------------------
  const entries = [];
  const saved = attempt(() => {
    fs.mkdirSync(originalsPath, { recursive: true, mode: 0o700 });
    const snapshotDirs = new Set([originalsPath]);
    for (const rel of files) {
      const dest = path.join(dataDir, rel);
      const existed = fs.existsSync(dest);
      if (existed) {
        const copyTo = path.join(originalsPath, rel);
        fs.mkdirSync(path.dirname(copyTo), { recursive: true });
        fs.copyFileSync(dest, copyTo);
        fsyncFile(copyTo);
        for (let dir = path.dirname(copyTo); dir !== originalsPath; dir = path.dirname(dir)) {
          snapshotDirs.add(dir);
        }
      }
      entries.push({ dest: rel, existed });
    }
    // Flush the entire rollback tree, children before parents, before its
    // journal can authorize replacing even one live file.
    for (const dir of [...snapshotDirs].sort((a, b) => b.length - a.length)) fsyncDir(dir);
    fsyncDir(dataDir);
  });
  if (!saved.ok) {
    attempt(() => fs.rmSync(originalsPath, { recursive: true, force: true }));
    logger.error(`❌ 💾 Restore refused: could not snapshot destinations for rollback: ${saved.error.message}`, {
      action: 'restore-apply', filename, error: saved.error.message,
    });
    return { success: false, code: 'rollback-snapshot-failed', error: `Could not snapshot current files for rollback: ${saved.error.message}. No files were changed.`, rolledBack: true };
  }

  // ---- Durable marker, written BEFORE the first destination changes ------
  const journalPlan = {
    journalVersion: JOURNAL_VERSION,
    restoreId,
    filename,
    startedAt: new Date(startedAt).toISOString(),
    originalsDir,
    stageDir: path.relative(dataDir, stageDir),
    entries,
    createdDirs: dirs,
  };
  const journalWrite = writeJournal(dataDir, journalPlan, STATUS.APPLYING);
  if (!journalWrite.ok) {
    // The rename may have succeeded before a directory flush failed. Retire
    // that possible marker durably before disposing of its rollback copies.
    const cleaned = cleanupArtifacts(dataDir, journalPlan);
    logger.error(`❌ 💾 Restore refused: could not persist the rollback journal: ${journalWrite.error.message}`, {
      action: 'restore-apply', filename, error: journalWrite.error.message,
    });
    return {
      success: false, code: 'journal-write-failed',
      error: `Could not persist the restore rollback journal: ${journalWrite.error.message}. No destination files were changed.`,
      rolledBack: cleaned.ok,
      ...(!cleaned.ok ? { recovery: describeArtifacts({ ...journalPlan, status: STATUS.APPLYING }) } : {}),
    };
  }
  const journal = journalWrite.journal;

  logger.info(`ℹ️ 💾 Restore applying ${files.length} file(s) from ${filename} (restoreId=${restoreId}, rollback journal written)`, {
    action: 'restore-apply', filename, restoreId, files: files.length,
  });

  // ---- Apply: every destination replaced atomically ----------------------
  const applied = attempt(() => {
    for (const rel of dirs) {
      const dir = path.join(dataDir, rel);
      fs.mkdirSync(dir, { recursive: true });
      fsyncDir(path.dirname(dir));
    }
    for (const rel of files) replaceFileAtomic(path.join(stageDir, rel), path.join(dataDir, rel));
  });

  // Success requires the durable commit marker too. A failed marker write is
  // still an uncommitted transaction and must use the same rollback path.
  const committed = applied.ok ? writeJournal(dataDir, journal, STATUS.COMMITTED) : applied;
  if (!committed.ok) {
    const message = committed.error.message;
    logger.error(`❌ 💾 Restore failed after ${Date.now() - startedAt}ms applying ${filename}: ${message} — rolling back ${entries.length} destination(s)`, {
      action: 'restore-apply', filename, restoreId, error: message, elapsedMs: Date.now() - startedAt,
    });
    const rolled = revertAndSettle({ dataDir, journal, logger });
    if (!rolled.ok) {
      return {
        success: false,
        code: 'restore-incomplete-recovery',
        error: `Restore failed (${message}) AND the rollback could not fully revert the data directory: ${rolled.failures.join('; ')}. Original files are retained in ${originalsDir}; startup will retry recovery.`,
        rolledBack: false,
        recovery: rolled.recovery,
      };
    }
    logger.info(`ℹ️ 💾 Restore rolled back cleanly in ${Date.now() - startedAt}ms: ${rolled.restored} file(s) reverted, ${rolled.removed} removed`, {
      action: 'restore-apply', filename, restoreId, reverted: rolled.restored, removed: rolled.removed, elapsedMs: Date.now() - startedAt,
    });
    return { success: false, code: 'restore-apply-failed', error: `${message}. All files were rolled back to their pre-restore state.`, rolledBack: true };
  }

  // ---- Commit: one durable flip, then the artifacts go ------------------
  cleanupArtifacts(dataDir, committed.journal);
  logger.info(`ℹ️ 💾 Restore applied and committed in ${Date.now() - startedAt}ms: ${files.length} file(s) from ${filename}`, {
    action: 'restore-apply', filename, restoreId, filesRestored: files.length, elapsedMs: Date.now() - startedAt,
  });
  return { success: true, filesRestored: files.length };
};

// A directory's own mtime only moves when a direct child is added or removed,
// so a restore still writing into existing entries looks idle; take the newest
// mtime among the immediate children too.
const newestMtimeMs = (dir, own) => {
  const listed = attempt(() => fs.readdirSync(dir));
  if (!listed.ok) return own;
  let newest = own;
  for (const child of listed.value) {
    const st = attempt(() => fs.lstatSync(path.join(dir, child)));
    if (st.ok && st.value.mtimeMs > newest) newest = st.value.mtimeMs;
  }
  return newest;
};

/**
 * Remove `.restore-temp-*` staging directories that no journal references.
 * A failed in-process restore disposes of its own staging tree; this backstops
 * the cases it cannot reach (a process killed mid-extraction). Directories
 * younger than ORPHAN_STAGE_MIN_AGE_MS are kept, since they may belong to a
 * restore still extracting in another process.
 *
 * @param {Object} params
 * @param {string} params.dataDir - Data directory
 * @param {Set<string>} params.referenced - Staging directory names a journal owns
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @returns {number} Number of directories removed
 */
const sweepOrphanStageDirs = ({ dataDir, referenced, logger }) => {
  const listed = attempt(() => fs.readdirSync(dataDir));
  if (!listed.ok) return 0;
  let removed = 0;
  for (const name of listed.value) {
    if (!name.startsWith(STAGE_PREFIX) || referenced.has(name)) continue;
    const target = path.join(dataDir, name);
    const stat = attempt(() => fs.lstatSync(target));
    if (!stat.ok || !stat.value.isDirectory() || Date.now() - newestMtimeMs(target, stat.value.mtimeMs) < ORPHAN_STAGE_MIN_AGE_MS) continue;
    const gone = attempt(() => fs.rmSync(target, { recursive: true, force: true }));
    if (gone.ok) {
      removed += 1;
      logger.info(`ℹ️ 💾 Removed orphaned restore staging directory ${name}`, { action: 'restore-recovery', stageDir: name });
    } else {
      logger.warn(`⚠️ 💾 Could not remove orphaned restore staging directory ${name}: ${gone.error.message}`, {
        action: 'restore-recovery', stageDir: name, error: gone.error.message,
      });
    }
  }
  return removed;
};

/**
 * Finish (or block on) a restore that a crash interrupted. Every process that
 * consumes persisted trading data calls this BEFORE loading any of it: the
 * journal is the only thing that distinguishes "these files are coherent" from
 * "these files are half archive-generation, half current-generation".
 *
 * @param {Object} [params]
 * @param {string} [params.dataDir] - Data directory
 * @param {{info: Function, warn: Function, error: Function}} [params.logger] - Context logger
 * @returns {{pending: boolean, recovered: boolean, blocked: boolean, error?: string, recovery?: Object}} Recovery outcome
 */
const recoverIncompleteRestore = ({ dataDir = DATA_DIR, logger = NOOP_LOGGER } = {}) => {
  const read = readJournal(dataDir);
  if (!read.present) {
    sweepOrphanStageDirs({ dataDir, referenced: new Set(), logger });
    return { pending: false, recovered: false, blocked: false };
  }
  if (!read.ok) {
    logger.error(`❌ 💾 Incomplete restore detected but its journal is unusable: ${read.error} — refusing to load persisted state`, {
      action: 'restore-recovery', error: read.error,
    });
    return { pending: true, recovered: false, blocked: true, error: read.error };
  }

  const journal = read.journal;
  sweepOrphanStageDirs({ dataDir, referenced: new Set([journal.stageDir].filter(Boolean)), logger });
  if (journal.status === STATUS.COMMITTED) {
    // The transaction reached its commit point; only cleanup was interrupted.
    cleanupArtifacts(dataDir, journal);
    logger.info(`ℹ️ 💾 Cleaned up artifacts from a committed restore (restoreId=${journal.restoreId}, ${journal.filename})`, {
      action: 'restore-recovery', restoreId: journal.restoreId, filename: journal.filename,
    });
    return { pending: true, recovered: true, blocked: false };
  }

  logger.warn(`⚠️ 💾 Incomplete restore detected (restoreId=${journal.restoreId}, status=${journal.status}, ${journal.filename}) — rolling ${journal.entries.length} file(s) back before any state loads`, {
    action: 'restore-recovery', restoreId: journal.restoreId, status: journal.status, filename: journal.filename,
  });

  const rolled = revertAndSettle({ dataDir, journal, logger });
  if (!rolled.ok) {
    return {
      pending: true,
      recovered: false,
      blocked: true,
      error: `Rollback of restore ${journal.restoreId} could not revert every file: ${rolled.failures.join('; ')}. Originals are retained in ${journal.originalsDir}.`,
      recovery: rolled.recovery,
    };
  }

  logger.info(`ℹ️ 💾 Incomplete restore rolled back: ${rolled.restored} file(s) reverted, ${rolled.removed} removed (restoreId=${journal.restoreId})`, {
    action: 'restore-recovery', restoreId: journal.restoreId, reverted: rolled.restored, removed: rolled.removed,
  });
  return { pending: true, recovered: true, blocked: false };
};

/**
 * Startup gate: recover an interrupted restore, and hard-stop the process if
 * the data directory cannot be proven coherent. Shared verbatim by the gateway
 * and every engine process so neither can be the one that skips it.
 *
 * @param {Object} params
 * @param {string} params.processLabel - Who is starting ("gateway", "coinbase engine")
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @param {string} [params.dataDir] - Data directory
 * @param {(code: number) => any} [params.exit] - Process exit (injectable for tests)
 * @returns {{pending: boolean, recovered: boolean, blocked: boolean, error?: string, recovery?: Object}} Recovery outcome
 */
const guardIncompleteRestore = ({ processLabel, logger, dataDir = DATA_DIR, exit = process.exit }) => {
  if (hasPendingBackfill(dataDir)) {
    const error = 'FIFO backfill recovery is pending; stop all PM2 processes and run scripts/backfill-fifo-realized.js --resume or --rollback.';
    logger.error(`Refusing to start ${processLabel}: ${error}`, { action: 'backfill-recovery', processLabel });
    exit(1);
    return { pending: true, recovered: false, blocked: true, error };
  }
  const result = recoverIncompleteRestore({ dataDir, logger });
  if (result.blocked) {
    logger.error(`❌ 💾 Refusing to start ${processLabel}: a backup restore was interrupted and could not be rolled back — ${result.error}`, {
      action: 'restore-recovery', processLabel, error: result.error,
    });
    logger.error(`❌ 💾 Resolve it by hand: restore the files listed in ${JOURNAL_FILENAME} from ${result.recovery?.originalsDir ?? 'the retained originals directory'}, then delete both. Trading data may be a mixed generation until then.`, {
      action: 'restore-recovery', processLabel,
    });
    exit(1);
  }
  return result;
};

module.exports = {
  applyStagedFiles,
  recoverIncompleteRestore,
  guardIncompleteRestore,
  JOURNAL_FILENAME,
  JOURNAL_VERSION,
  ORIGINALS_PREFIX,
  STAGE_PREFIX,
  STATUS,
};
