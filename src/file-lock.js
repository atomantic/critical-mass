// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { setTimeout: delay } = require('timers/promises');

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);
const isOccupied = (error) => ['EEXIST', 'ENOTEMPTY'].includes(error.code);

/** An inaccessible or reused PID alone never establishes that an owner died. */
const isDeadPid = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};

/** @template T @param {() => T} read @returns {T|null} */
const readIfPresent = (read) => {
  try { return read(); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const removeEmptyDirectory = (directory) => {
  try { fs.rmdirSync(directory); } catch (error) {
    if (error.code !== 'ENOENT' && !isOccupied(error)) throw error;
  }
};

/** Publish a populated sibling directory in one operation. */
const publishDirectory = (lockPath, candidate, ownerName, metadata) => {
  fs.mkdirSync(candidate, { mode: 0o700 });
  let published = false;
  try {
    const descriptor = fs.openSync(path.join(candidate, ownerName), 'wx', 0o600);
    try {
      const bytes = Buffer.from(metadata);
      if (fs.writeSync(descriptor, bytes) !== bytes.length) throw new Error('Incomplete lock owner write');
    } finally {
      fs.closeSync(descriptor);
    }
    try { fs.renameSync(candidate, lockPath); } catch (error) {
      if (isOccupied(error)) return false;
      throw error;
    }
    published = true;
    return true;
  } finally {
    if (!published) fs.rmSync(candidate, { recursive: true, force: true });
  }
};

/**
 * Restore's identity lives in the filename. Unlinking only an observed
 * identity and then doing a non-recursive rmdir cannot displace a successor.
 * Legacy empty reclaim markers may be replaced after their grace period.
 */
const tryIdentityDirectory = (lockPath, { candidatePrefix = `${lockPath}.new-`, emptyGraceMs = 0, invalidOwner = undefined }) => {
  const identity = `${process.pid}-${randomUUID()}`;
  const retire = (owner) => {
    fs.rmSync(path.join(lockPath, owner), { force: true });
    removeEmptyDirectory(lockPath);
  };

  // rename can replace an empty directory. Respect old empty reclaim markers
  // during the grace period so a legacy reclaimer and a new one stay serialized.
  if (emptyGraceMs) {
    const age = readIfPresent(() => Date.now() - fs.statSync(lockPath).mtimeMs);
    if (age !== null && age < emptyGraceMs) return null;
  }
  if (publishDirectory(lockPath, candidatePrefix + identity, identity, '')) return () => retire(identity);

  const names = readIfPresent(() => fs.readdirSync(lockPath));
  if (!names) return null;
  const [observed] = names;
  const pid = Number(/^([1-9]\d*)-[0-9a-f-]{36}$/.exec(observed ?? '')?.[1]);
  if (names.length === 0) removeEmptyDirectory(lockPath);
  else if (names.length !== 1 || !Number.isSafeInteger(pid)) {
    if (invalidOwner) throw invalidOwner();
  } else if (isDeadPid(pid)) retire(observed);
  return null;
};

/**
 * Acquire restore ownership using its existing on-disk identity format.
 * @param {string} lockPath
 * @param {WaitOptions & {candidatePrefix: string, invalidOwner: () => Error}} options
 */
const acquireIdentityLock = (lockPath, options) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return waitForLock(() => tryIdentityDirectory(lockPath, options), options);
};

/**
 * @typedef {{waitMs: number, pollMs: number, now?: () => number, sleep?: (ms: number) => void}} WaitOptions
 */

/** @template T @param {() => T|null} acquire @param {WaitOptions} options @returns {T|null} */
const waitForLock = (acquire, { waitMs, pollMs, now = Date.now, sleep = sleepSync }) => {
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const lock = acquire();
    if (lock !== null) return lock;
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    sleep(Math.min(remaining, pollMs));
  }
};

/** @template T @param {() => T|null} acquire @param {WaitOptions & {beforeWait: () => void}} options */
const waitForLockAsync = async (acquire, { waitMs, pollMs, beforeWait, now = Date.now }) => {
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const lock = acquire();
    if (lock !== null) return lock;
    beforeWait();
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await delay(Math.min(remaining, pollMs));
  }
};

/** @template T @param {string} directory @param {WaitOptions} options @param {() => T} operation @param {() => Error} busy */
const withUnreclaimedLock = (directory, options, operation, busy) => {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const release = waitForLock(() => {
    try { fs.mkdirSync(directory); } catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    }
    return () => fs.rmdirSync(directory);
  }, options);
  if (!release) throw busy();
  try { return operation(); } finally { release(); }
};

const parseOwner = (raw) => {
  try { return JSON.parse(raw ?? 'null'); } catch { return null; }
};

/** Read metadata from a lock's owner file while treating malformed JSON as unknown. */
const readOwner = (file) => parseOwner(readIfPresent(() => fs.readFileSync(file, 'utf8')));

/**
 * Placement intents and scorecard maintenance use an owner.json directory.
 * A separate identity lock serializes reclaimers, which recheck the owner
 * inside it before removing the directory. Only a dead owner or a configured
 * legacy ownerless directory can be removed from that path.
 * @param {string} lockPath
 * @param {{metadata?: object, graceMs?: number, ownerlessMs?: number, allowMissingHost?: boolean, reclaimed?: (pid: number) => void, bestEffortRelease?: boolean}} options
 * @returns {(() => void)|null}
 */
const tryOwnerDirectoryLock = (lockPath, {
  metadata = {}, graceMs = 0, ownerlessMs, allowMissingHost = false, reclaimed, bestEffortRelease = false,
}) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const ownerPath = path.join(lockPath, 'owner.json');
  const owner = { ...metadata, pid: process.pid, host: os.hostname(), token };
  const candidatePrefix = `${lockPath}.new-`;
  const retire = () => {
    fs.rmSync(ownerPath, { force: true });
    // The next publisher may already have renamed a populated directory into
    // place. Never recursively remove the shared path.
    removeEmptyDirectory(lockPath);
  };
  const publish = () => {
    if (ownerlessMs !== undefined) {
      // Publish with metadata already in place when legacy ownerless locks can
      // expire. A paused publisher must never look like one of those locks.
      try { return publishDirectory(lockPath, `${candidatePrefix}${process.pid}-${token}`, 'owner.json', JSON.stringify(owner)); }
      catch (error) {
        if (error.code === 'EPERM' && fs.existsSync(lockPath)) return false;
        throw error;
      }
    }
    // A real mkdir (rather than rename) respects even an existing empty lock
    // directory when ownership cannot be inferred from age.
    try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    try { fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 }); } catch (error) {
      fs.rmSync(lockPath, { recursive: true });
      throw error;
    }
    return true;
  };

  const staleOwner = () => {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      const raw = readIfPresent(() => fs.readFileSync(ownerPath, 'utf8'));
      if (raw === null) {
        return ownerlessMs !== undefined && age > ownerlessMs ? { empty: true, pid: null } : null;
      }
      const previous = parseOwner(raw);
      if (previous === null) {
        return ownerlessMs !== undefined && age > ownerlessMs ? { empty: false, pid: null } : null;
      }
      const local = previous.host === owner.host || (allowMissingHost && previous.host === undefined);
      return local && age >= graceMs && isDeadPid(previous.pid) ? { empty: false, pid: previous.pid } : null;
    } catch { return null; }
  };

  if (!publish()) {
    if (!staleOwner()) return null;
    const releaseReclaimer = tryIdentityDirectory(`${lockPath}.reclaim`, { candidatePrefix, emptyGraceMs: ownerlessMs ?? 30_000 });
    if (!releaseReclaimer) return null;
    try {
      const stale = staleOwner();
      if (stale) {
        if (stale.empty) removeEmptyDirectory(lockPath);
        else retire();
        reclaimed?.(stale.pid);
      }
    } finally {
      releaseReclaimer();
    }
    if (!publish()) return null;
  }

  let released = false;
  return () => {
    if (released) return;
    try {
      if (readOwner(ownerPath)?.token === token) retire();
      released = true;
    } catch (error) {
      if (!bestEffortRelease) throw error;
    }
  };
};

const readFileOwner = (lockPath) => {
  const stat = readIfPresent(() => fs.statSync(lockPath));
  if (!stat) return null;
  const owner = readOwner(lockPath);
  return { pid: Number.isInteger(owner?.pid) ? owner.pid : null, token: owner?.token ?? null, mtimeMs: stat.mtimeMs };
};

/**
 * Retain the migration lock's file format and existing breaker protocol.
 * @param {string} lockPath
 * @param {(owner: NonNullable<ReturnType<typeof readFileOwner>>) => boolean} isStale
 * @param {() => number} [now]
 * @param {(pid: number|null) => void} [onBreak]
 */
const breakFileLock = (lockPath, isStale, now = Date.now, onBreak = () => {}) => {
  const marker = `${lockPath}.break`;
  try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = readIfPresent(() => fs.lstatSync(marker));
    if (stat && now() - stat.mtimeMs > 10_000) fs.rmSync(marker, { force: true });
    return;
  }
  try {
    const owner = readFileOwner(lockPath);
    if (owner && isStale(owner)) {
      onBreak(owner.pid);
      fs.unlinkSync(lockPath);
    }
  } finally {
    fs.rmSync(marker, { force: true });
  }
};

/**
 * @param {string} lockPath
 * @param {WaitOptions & {metadata: object, staleMs: number, isDead?: (pid: number) => boolean, onBreak?: (pid: number) => void}} options
 */
const acquireOwnerFileLock = (lockPath, options) => {
  const { metadata, staleMs, isDead = isDeadPid, now = Date.now, onBreak } = options;
  const token = randomUUID();
  const isStale = ({ mtimeMs, pid }) => now() - mtimeMs > staleMs || (pid !== null && pid !== process.pid && isDead(pid));
  return waitForLock(() => {
    let fd;
    try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readFileOwner(lockPath);
      if (owner && isStale(owner)) breakFileLock(lockPath, isStale, now, onBreak);
      // Retry immediately after retirement, even for a zero-wait acquisition.
      if (fs.existsSync(lockPath)) return null;
      try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch (retryError) {
        if (retryError.code === 'EEXIST') return null;
        throw retryError;
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...metadata, pid: process.pid, token }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { lockPath, token };
  }, options);
};

const fileLockIsHeld = ({ lockPath, token }) => readFileOwner(lockPath)?.token === token;
const releaseOwnerFileLock = (lock) => {
  if (fileLockIsHeld(lock)) fs.rmSync(lock.lockPath, { force: true });
};

module.exports = {
  acquireIdentityLock, waitForLock, waitForLockAsync, withUnreclaimedLock,
  tryOwnerDirectoryLock, readOwner, acquireOwnerFileLock, breakFileLock, fileLockIsHeld, releaseOwnerFileLock,
};
