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

/** Durable marker + rollback plan. Lives in the data dir so any process finds it. */
const JOURNAL_FILENAME = '.restore-journal.json';

/** Journal envelope version — recovery refuses anything it does not understand. */
const JOURNAL_VERSION = 1;

/** Pre-restore copies of every destination the attempt replaces. */
const ORIGINALS_PREFIX = '.restore-originals-';

/** Archive extraction staging directory. */
const STAGE_PREFIX = '.restore-temp-';

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
 * Flush a directory entry (a rename, a create) to stable storage. Without this
 * the journal can be absent after a power loss even though its data blocks
 * landed — exactly the case the journal exists to cover.
 * @param {string} dir - Directory to fsync
 * @returns {void}
 */
const fsyncDir = (dir) => {
  const opened = attempt(() => fs.openSync(dir, 'r'));
  if (!opened.ok) return; // Some filesystems refuse O_RDONLY on directories; the rename still stands.
  attempt(() => fs.fsyncSync(opened.value));
  attempt(() => fs.closeSync(opened.value));
};

/**
 * Write a file so that a crash leaves either the previous content or the new
 * content: temp file, fsync, atomic rename, fsync of the parent directory.
 *
 * Deliberately not `state-tracker.atomicWriteSync`: that helper does not fsync
 * the data or the directory entry, and surviving a power loss is the entire
 * reason the journal exists (config-utils.js makes the same call for the same
 * reason). A failed write leaves no temp file behind.
 * @param {string} file - Destination path
 * @param {string|Buffer} data - Bytes to write
 * @param {number} [mode] - Permission mode for the new inode
 * @returns {void}
 */
const writeFileDurable = (file, data, mode) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const written = attempt(() => {
    const fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  });
  if (!written.ok) {
    fs.rmSync(tmp, { force: true });
    throw written.error;
  }
};

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
  const existingMode = attempt(() => fs.statSync(dest).mode & 0o777);
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${Date.now()}.restore-tmp`);
  const replaced = attempt(() => {
    fs.copyFileSync(src, tmp);
    if (existingMode.ok && existingMode.value) fs.chmodSync(tmp, existingMode.value);
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, dest);
  });
  // A half-written temp file left in data/ would be picked up by the next
  // backup and outlive the failure that created it.
  if (!replaced.ok) {
    fs.rmSync(tmp, { force: true });
    throw replaced.error;
  }
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
  const written = attempt(() => writeFileDurable(path.join(dataDir, JOURNAL_FILENAME), JSON.stringify(next, null, 2), 0o600));
  return written.ok ? { ok: true, journal: next } : { ok: false, error: written.error };
};

/**
 * Delete the journal and every artifact it references. Called once the
 * transaction has reached a safe state (committed, or fully rolled back) —
 * never while destinations may still be mixed-generation.
 * @param {string} dataDir - Data directory
 * @param {Object} journal - Journal object
 * @returns {void}
 */
const cleanupArtifacts = (dataDir, journal) => {
  for (const rel of [journal.originalsDir, journal.stageDir].filter(Boolean)) {
    attempt(() => fs.rmSync(path.join(dataDir, rel), { recursive: true, force: true }));
  }
  attempt(() => fs.rmSync(path.join(dataDir, JOURNAL_FILENAME), { force: true }));
  fsyncDir(dataDir);
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
    const gone = attempt(() => fs.rmSync(dest, { force: true }));
    if (gone.ok) removed++;
    else failures.push(`${entry.dest}: ${gone.error.message}`);
  }

  // Deepest first, so nested creations unwind cleanly.
  for (const rel of [...(journal.createdDirs || [])].sort((a, b) => b.length - a.length)) {
    attempt(() => fs.rmdirSync(path.join(dataDir, rel)));
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
 * The journal transitions are best-effort — a filesystem that cannot take the
 * status update is exactly the one whose rollback is about to fail anyway, and
 * the on-disk `applying` marker already routes the next start back here.
 *
 * @param {Object} params
 * @param {string} params.dataDir - Data directory
 * @param {Object} params.journal - Journal object
 * @param {{info: Function, warn: Function, error: Function}} params.logger - Context logger
 * @returns {{ok: boolean, restored: number, removed: number, failures: string[], recovery?: Object}} Outcome
 */
const revertAndSettle = ({ dataDir, journal, logger }) => {
  const marked = writeJournal(dataDir, journal, STATUS.ROLLING_BACK);
  const current = marked.ok ? marked.journal : journal;

  const rolled = rollbackFromJournal({ dataDir, journal: current, logger });
  if (rolled.ok) {
    cleanupArtifacts(dataDir, current);
    return rolled;
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
  const { files, dirs } = collectStagedSet({ stageDir, dataDir, skip });

  const valid = validateStagedSet({ stageDir, dataDir, files });
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
    for (const rel of files) {
      const dest = path.join(dataDir, rel);
      const existed = fs.existsSync(dest);
      if (existed) {
        const copyTo = path.join(originalsPath, rel);
        fs.mkdirSync(path.dirname(copyTo), { recursive: true });
        fs.copyFileSync(dest, copyTo);
      }
      entries.push({ dest: rel, existed });
    }
  });
  if (!saved.ok) {
    attempt(() => fs.rmSync(originalsPath, { recursive: true, force: true }));
    logger.error(`❌ 💾 Restore refused: could not snapshot destinations for rollback: ${saved.error.message}`, {
      action: 'restore-apply', filename, error: saved.error.message,
    });
    return { success: false, code: 'rollback-snapshot-failed', error: `Could not snapshot current files for rollback: ${saved.error.message}. No files were changed.`, rolledBack: true };
  }

  // ---- Durable marker, written BEFORE the first destination changes ------
  const journalWrite = writeJournal(dataDir, {
    journalVersion: JOURNAL_VERSION,
    restoreId,
    filename,
    startedAt: new Date(startedAt).toISOString(),
    originalsDir,
    stageDir: path.relative(dataDir, stageDir),
    entries,
    createdDirs: dirs,
  }, STATUS.APPLYING);
  if (!journalWrite.ok) {
    attempt(() => fs.rmSync(originalsPath, { recursive: true, force: true }));
    logger.error(`❌ 💾 Restore refused: could not persist the rollback journal: ${journalWrite.error.message}`, {
      action: 'restore-apply', filename, error: journalWrite.error.message,
    });
    return { success: false, code: 'journal-write-failed', error: `Could not persist the restore rollback journal: ${journalWrite.error.message}. No files were changed.`, rolledBack: true };
  }
  const journal = journalWrite.journal;

  logger.info(`ℹ️ 💾 Restore applying ${files.length} file(s) from ${filename} (restoreId=${restoreId}, rollback journal written)`, {
    action: 'restore-apply', filename, restoreId, files: files.length,
  });

  // ---- Apply: every destination replaced atomically ----------------------
  const applied = attempt(() => {
    for (const rel of dirs) fs.mkdirSync(path.join(dataDir, rel), { recursive: true });
    for (const rel of files) replaceFileAtomic(path.join(stageDir, rel), path.join(dataDir, rel));
  });

  if (!applied.ok) {
    const message = applied.error.message;
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
  const committed = writeJournal(dataDir, journal, STATUS.COMMITTED);
  cleanupArtifacts(dataDir, committed.ok ? committed.journal : journal);
  logger.info(`ℹ️ 💾 Restore applied and committed in ${Date.now() - startedAt}ms: ${files.length} file(s) from ${filename}`, {
    action: 'restore-apply', filename, restoreId, filesRestored: files.length, elapsedMs: Date.now() - startedAt,
  });
  return { success: true, filesRestored: files.length };
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
  if (!read.present) return { pending: false, recovered: false, blocked: false };
  if (!read.ok) {
    logger.error(`❌ 💾 Incomplete restore detected but its journal is unusable: ${read.error} — refusing to load persisted state`, {
      action: 'restore-recovery', error: read.error,
    });
    return { pending: true, recovered: false, blocked: true, error: read.error };
  }

  const journal = read.journal;
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
