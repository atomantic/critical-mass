// @ts-check
/**
 * Legacy root → exchange namespace migration (issue #971).
 *
 * Installs from before multi-exchange support kept their files directly under
 * `data/`. This moves each legacy artifact into `data/coinbase/`:
 *
 *   data/state.json               → data/coinbase/state.json
 *   data/transactions.tsv         → data/coinbase/transactions.tsv
 *   data/optimizer-cache.json     → data/coinbase/optimizer-cache.json
 *   data/btc-price-cache*.json    → data/coinbase/btc-price-cache*.json
 *
 * and, as the original migration did, keeps a `data/<name>.backup` copy of the
 * source (created only when absent — an existing backup is never replaced).
 *
 * The previous implementation used "root state.json exists and
 * coinbase/state.json does not" as its whole gate, and moved state.json first.
 * A failure after that first move made every later startup skip the rest, so
 * the root transaction log was stranded forever; and its `renameSync` replaced
 * any existing exchange-level target without preserving it. This module:
 *
 *  - discovers each pending artifact individually, so an interrupted run is
 *    resumed on the next startup, artifact by artifact;
 *  - preflights the WHOLE inventory before moving anything: a missing target
 *    is migrated, a byte-identical target is reconciled by retiring the root
 *    copy, and a target holding different bytes is a conflict that blocks
 *    startup with both generations left untouched;
 *  - never overwrites a target: placement is a hard link (fails on EEXIST), so
 *    a crash between link and unlink leaves two names for the same bytes,
 *    which the next run reconciles as identical;
 *  - serialises across processes with an exclusive lock file in the data
 *    directory and re-discovers the inventory after acquiring it, so two
 *    starters cannot both check and move. A lock left by a dead (or long
 *    silent) owner is broken safely, verified by inode so a fresh lock taken
 *    by someone else in between is restored rather than stolen.
 *
 * Pure with respect to `dataDir`; src/migration.js wires it to DATA_DIR.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { fsyncDir } = require('./fsync-dir');

/** The single exchange that existed before namespacing. */
const LEGACY_EXCHANGE = 'coinbase';

/** Fixed-name legacy artifacts, in the order the original migration moved them. */
const LEGACY_FILES = ['state.json', 'transactions.tsv', 'optimizer-cache.json'];

/** Legacy price caches: `btc-price-cache-<interval>.json` (backups excluded by the suffix). */
const isLegacyPriceCache = (name) => name.startsWith('btc-price-cache') && name.endsWith('.json');

/** Cross-process ownership marker. Dot-prefixed so exchange/backup scans skip it. */
const LOCK_FILENAME = '.legacy-namespace-migration.lock';

/** A lock untouched for this long is abandoned even if its pid looks alive (pid reuse). */
const LOCK_STALE_MS = 5 * 60 * 1000;
/** How long a starter waits for another process's migration before refusing to start. */
const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 50;

/** Errors meaning "hard links are not available here" — fall back to rename under the lock. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** @param {number} pid @returns {boolean} */
const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** @param {string} p @returns {fs.Stats|null} */
const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

/**
 * Byte-for-byte comparison without loading large price caches whole.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const filesIdentical = (a, b) => {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  if (sa.ino === sb.ino && sa.dev === sb.dev) return true;
  const CHUNK = 1 << 16;
  const bufA = Buffer.alloc(CHUNK);
  const bufB = Buffer.alloc(CHUNK);
  const fa = fs.openSync(a, 'r');
  try {
    const fb = fs.openSync(b, 'r');
    try {
      let offset = 0;
      while (offset < sa.size) {
        const na = fs.readSync(fa, bufA, 0, CHUNK, offset);
        const nb = fs.readSync(fb, bufB, 0, CHUNK, offset);
        if (na === 0 || na !== nb) return false;
        if (!bufA.subarray(0, na).equals(bufB.subarray(0, nb))) return false;
        offset += na;
      }
      return true;
    } finally {
      fs.closeSync(fb);
    }
  } finally {
    fs.closeSync(fa);
  }
};

/**
 * Every legacy artifact still sitting at the data root, as a regular file.
 * @param {string} dataDir
 * @returns {string[]}
 */
const discoverLegacyArtifacts = (dataDir) => {
  if (!fs.existsSync(dataDir)) return [];
  const entries = fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isFile());
  const names = new Set(entries.map((e) => e.name));
  const fixed = LEGACY_FILES.filter((name) => names.has(name));
  const caches = entries.map((e) => e.name).filter(isLegacyPriceCache).sort();
  return [...fixed, ...caches];
};

// ============ Cross-process ownership ============

/**
 * @param {string} lockPath
 * @returns {{pid: number|null, token: string|null, ino: number, mtimeMs: number}|null} null when the lock vanished
 */
const readLockOwner = (lockPath) => {
  let stat;
  let raw;
  try {
    stat = fs.statSync(lockPath);
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Created but not yet written (or torn): staleness then rests on age alone.
  }
  return {
    pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
    token: typeof parsed?.token === 'string' ? parsed.token : null,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
};

/**
 * Remove an abandoned lock without ever stealing a live one. The lock is first
 * renamed to a private tombstone (atomic); if the tombstone is not the inode we
 * judged stale, another starter broke and re-took the lock in between, so we
 * put its fresh lock back (link fails rather than clobbering a third owner).
 * @param {string} lockPath
 * @param {{ino: number}} staleOwner
 * @returns {void}
 */
const breakStaleLock = (lockPath, staleOwner) => {
  const tombstone = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    if (fs.statSync(tombstone).ino !== staleOwner.ino) {
      try {
        fs.linkSync(tombstone, lockPath);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } finally {
    fs.rmSync(tombstone, { force: true });
  }
};

/**
 * @typedef {Object} LockOptions
 * @property {number} [waitMs]
 * @property {number} [pollMs]
 * @property {number} [staleMs]
 * @property {() => number} [now]
 * @property {(ms: number) => void} [sleep]
 * @property {(pid: number) => boolean} [isAlive]
 */

/**
 * Take exclusive ownership of the migration, waiting for a live owner.
 * @param {string} dataDir
 * @param {LockOptions} [opts]
 * @returns {{lockPath: string, token: string}|null} null when a live owner kept it past the wait
 */
const acquireMigrationLock = (dataDir, opts = {}) => {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepSync;
  const isAlive = opts.isAlive ?? isPidAlive;
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  const token = randomUUID();
  const deadline = now() + waitMs;

  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (fd !== undefined) {
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          token,
          hostname: os.hostname(),
          acquiredAt: new Date(now()).toISOString(),
        }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, token };
    }

    const owner = readLockOwner(lockPath);
    if (!owner) continue;
    const silentTooLong = now() - owner.mtimeMs > staleMs;
    const ownerDead = owner.pid !== null && owner.pid !== process.pid && !isAlive(owner.pid);
    if (silentTooLong || ownerDead) {
      console.log(`  ⚠️  [Namespace Migration] Breaking abandoned migration lock (pid ${owner.pid ?? 'unknown'})`);
      breakStaleLock(lockPath, owner);
      continue;
    }
    if (now() >= deadline) return null;
    sleep(pollMs);
  }
};

/**
 * Confirm we still own the lock before a mutation, and refresh its mtime so a
 * slow but live migration is never judged abandoned.
 * @param {{lockPath: string, token: string}} lock
 * @returns {void}
 */
const assertLockHeld = (lock) => {
  const owner = readLockOwner(lock.lockPath);
  if (!owner || owner.token !== lock.token) {
    throw new Error('lost ownership of the namespace migration lock');
  }
  const t = new Date();
  fs.utimesSync(lock.lockPath, t, t);
};

/** @param {{lockPath: string, token: string}} lock @returns {void} */
const releaseMigrationLock = (lock) => {
  const owner = readLockOwner(lock.lockPath);
  if (owner && owner.token === lock.token) fs.rmSync(lock.lockPath, { force: true });
};

// ============ Planning ============

/**
 * @typedef {Object} ArtifactPlan
 * @property {string} name
 * @property {string} source
 * @property {string} target - Exchange-level destination
 * @property {'move'|'reconcile'|'conflict'} action
 * @property {string} [existing] - The existing copy compared against (reconcile/conflict)
 * @property {string} [reason]
 */

/**
 * Decide what to do with one root artifact. The existing copy that matters is
 * the exchange-level target, or — once a later pair migration has already
 * moved that name into the default fund directory — the per-fund copy, since
 * the pair migration would otherwise skip or append the root generation onto it.
 * @param {string} dataDir
 * @param {string} name
 * @param {string|null} pairDir
 * @returns {ArtifactPlan}
 */
const planArtifact = (dataDir, name, pairDir) => {
  const source = path.join(dataDir, name);
  const target = path.join(dataDir, LEGACY_EXCHANGE, name);
  const candidates = [target];
  if (pairDir && LEGACY_FILES.includes(name)) candidates.push(path.join(pairDir, name));

  for (const existing of candidates) {
    const stat = lstatOrNull(existing);
    if (!stat) continue;
    if (!stat.isFile()) {
      return { name, source, target, existing, action: 'conflict', reason: 'existing target is not a regular file' };
    }
    return filesIdentical(source, existing)
      ? { name, source, target, existing, action: 'reconcile' }
      : { name, source, target, existing, action: 'conflict', reason: 'source and existing target hold different bytes' };
  }
  return { name, source, target, action: 'move' };
};

// ============ Execution ============

/**
 * Keep the legacy `data/<name>.backup` copy of the source. An existing backup
 * (from an earlier run, possibly another generation) is never replaced.
 * @param {string} source
 * @returns {void}
 */
const ensureBackup = (source) => {
  const backup = `${source}.backup`;
  if (lstatOrNull(backup)) return;
  const tmp = `${backup}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, backup);
    } catch (err) {
      if (err.code === 'EEXIST') return;
      if (!LINK_UNSUPPORTED.has(err.code)) throw err;
      if (!lstatOrNull(backup)) fs.renameSync(tmp, backup);
    }
    console.log(`  Backup: ${path.basename(source)} -> ${path.basename(backup)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};

/**
 * Give the source bytes the target name without ever replacing an existing
 * target. Returns true when the source name is already gone (rename fallback).
 * @param {ArtifactPlan} plan
 * @returns {boolean}
 */
const placeWithoutClobber = (plan) => {
  try {
    fs.linkSync(plan.source, plan.target);
    return false;
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (filesIdentical(plan.source, plan.target)) return false;
      throw new Error(`target appeared during migration with different bytes: ${plan.target}`);
    }
    if (!LINK_UNSUPPORTED.has(err.code)) throw err;
  }
  // No hard links on this filesystem. We own the lock, so re-check and rename.
  if (lstatOrNull(plan.target)) {
    throw new Error(`target appeared during migration: ${plan.target}`);
  }
  fs.renameSync(plan.source, plan.target);
  return true;
};

/**
 * @typedef {Object} NamespaceConflict
 * @property {string} artifact
 * @property {string} source - Path relative to the data directory's parent (e.g. data/transactions.tsv)
 * @property {string} target
 * @property {string} reason
 */

/**
 * @typedef {Object} NamespaceMigrationResult
 * @property {'none'|'migrated'|'conflict'|'busy'|'error'} status
 * @property {string[]} moved
 * @property {string[]} reconciled
 * @property {NamespaceConflict[]} conflicts
 * @property {string|null} error
 */

/**
 * Finish every pending legacy namespace artifact, or report why it cannot be.
 * `conflict`, `busy` and `error` all mean data-consuming startup must not
 * proceed; anything already moved is complete and the remainder stays pending
 * for the next run.
 * @param {Object} params
 * @param {string} params.dataDir
 * @param {string|null} [params.pairDir] - Default fund directory under data/coinbase/, when known
 * @param {LockOptions} [params.lock]
 * @returns {NamespaceMigrationResult}
 */
const migrateLegacyNamespace = ({ dataDir, pairDir = null, lock: lockOpts = {} }) => {
  /** @type {NamespaceMigrationResult} */
  const result = { status: 'none', moved: [], reconciled: [], conflicts: [], error: null };
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  // Cheap fast path for every already-migrated start: nothing pending and
  // nobody mid-migration. A held lock means someone may be partway through,
  // so wait for it rather than serving a half-moved namespace.
  if (discoverLegacyArtifacts(dataDir).length === 0 && !lstatOrNull(lockPath)) return result;

  const rel = (p) => path.relative(path.dirname(dataDir), p) || p;
  let lock;
  try {
    lock = acquireMigrationLock(dataDir, lockOpts);
  } catch (err) {
    return { ...result, status: 'error', error: `could not acquire migration lock: ${err.message}` };
  }
  if (!lock) {
    return { ...result, status: 'busy', error: `another process is still migrating (${rel(lockPath)})` };
  }

  try {
    // Re-discover under ownership: a concurrent starter may have finished
    // some or all of the inventory while we waited.
    const plans = discoverLegacyArtifacts(dataDir).map((name) => planArtifact(dataDir, name, pairDir));
    const conflicts = plans.filter((p) => p.action === 'conflict');
    if (conflicts.length > 0) {
      result.status = 'conflict';
      result.conflicts = conflicts.map((p) => ({
        artifact: p.name,
        source: rel(p.source),
        target: rel(/** @type {string} */ (p.existing)),
        reason: /** @type {string} */ (p.reason),
      }));
      return result;
    }
    if (plans.length === 0) return result;

    console.log(`\n=== Data Migration to ${LEGACY_EXCHANGE} namespace (${plans.length} pending) ===\n`);
    fs.mkdirSync(path.join(dataDir, LEGACY_EXCHANGE), { recursive: true });
    for (const plan of plans) {
      assertLockHeld(lock);
      ensureBackup(plan.source);
      let sourceGone = false;
      if (plan.action === 'move') {
        sourceGone = placeWithoutClobber(plan);
        fsyncDir(path.dirname(plan.target), { ignoreAllErrors: true });
      }
      if (!sourceGone) fs.unlinkSync(plan.source);
      fsyncDir(dataDir, { ignoreAllErrors: true });
      if (plan.action === 'move') {
        result.moved.push(plan.name);
        console.log(`  Migrate: ${plan.name} -> ${LEGACY_EXCHANGE}/${plan.name}`);
      } else {
        result.reconciled.push(plan.name);
        console.log(`  Reconcile: ${plan.name} already at ${rel(/** @type {string} */ (plan.existing))} (identical) — retired root copy`);
      }
    }
    result.status = 'migrated';
    console.log(`\nMigration complete: ${result.moved.length} moved, ${result.reconciled.length} reconciled`);
    return result;
  } catch (err) {
    return { ...result, status: 'error', error: err.message };
  } finally {
    try {
      releaseMigrationLock(lock);
    } catch {
      // A lock we could not remove is broken as abandoned by the next starter.
    }
  }
};

/**
 * Operator-facing lines explaining a blocked result, with relative paths.
 * @param {NamespaceMigrationResult} result
 * @returns {string[]}
 */
const describeBlockedMigration = (result) => {
  if (result.status === 'conflict') {
    return [
      `Legacy data migration found ${result.conflicts.length} conflicting file(s); nothing was moved and both copies are unchanged:`,
      ...result.conflicts.map((c) => `  ${c.source} vs ${c.target}: ${c.reason}`),
      'To recover: compare each pair, keep (or merge) the history you want in the target path, then move the root-level file out of the way (for example rename it to <name>.conflict) and restart.',
    ];
  }
  if (result.status === 'busy') {
    return [`Legacy data migration is held by another process: ${result.error}. If no other Critical Mass process is running, it will be treated as abandoned after ${LOCK_STALE_MS / 60000} minutes.`];
  }
  return [`Legacy data migration failed and will resume on the next start: ${result.error}`];
};

module.exports = {
  migrateLegacyNamespace,
  discoverLegacyArtifacts,
  describeBlockedMigration,
  acquireMigrationLock,
  releaseMigrationLock,
  LEGACY_EXCHANGE,
  LEGACY_FILES,
  LOCK_FILENAME,
  LOCK_STALE_MS,
};
