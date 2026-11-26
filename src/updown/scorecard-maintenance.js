// @ts-check
const fs = require('fs')
const path = require('path')
const { atomicWriteSync } = require('../durable-write')
const { readOwner, tryOwnerDirectoryLock, waitForLockAsync } = require('../file-lock')
const { createContextLogger } = require('../logger')

const scorecardLog = createContextLogger({ component: 'scorecard-maintenance' })

const lockPath = (directory) => path.join(directory, '.maintenance-lock')

// A lock is reclaimed only when its owner.json is readable, names a pid on this
// host, that pid is provably gone (ESRCH), and the lock is past a short grace
// period. Anything else (live owner, EPERM, unreadable or malformed metadata,
// another host) is treated as held: a paused writer may still own the lock.
const STALE_LOCK_GRACE_MS = 5_000

const acquireScorecardLock = (directory) => {
  const lock = lockPath(directory)
  return tryOwnerDirectoryLock(lock, {
    graceMs: STALE_LOCK_GRACE_MS,
    allowMissingHost: true,
    metadata: { startedAt: new Date().toISOString() },
    reclaimed: (pid) => scorecardLog.warn(`Reclaimed stale scorecard maintenance lock ${lock} from dead pid ${pid}`),
  })
}

// Live appends wait out a replay publication (docs/scorecard-backfill.md), which
// can run for minutes of fsync'd day rewrites on slow storage.
const DEFAULT_LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 25

const describeLockOwner = (directory) => {
  try {
    const owner = readOwner(path.join(lockPath(directory), 'owner.json'))
    if (!owner) return 'no readable owner metadata'
    return `owner pid ${owner?.pid ?? 'unknown'} since ${owner?.startedAt ?? 'unknown'}`
  } catch {
    return 'no readable owner metadata'
  }
}

// Bounded because a live owner's lock is never stolen: an unbounded wait on a lock left by
// a killed process wedged scorecard startup (and with it UpDown and the gateway
// shutdown drain) silently and forever. Fail with the recovery pointer instead.
// `signal` lets a stopping writer cancel its waits, so a backup or shutdown
// drain is not held behind them for the full timeout.
/**
 * @param {string} directory
 * @param {Function} operation
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 */
const withScorecardLock = async (directory, operation, { timeoutMs = DEFAULT_LOCK_WAIT_MS, signal } = {}) => {
  const release = await waitForLockAsync(() => acquireScorecardLock(directory), {
    waitMs: timeoutMs,
    pollMs: LOCK_POLL_MS,
    beforeWait: () => {
      if (signal?.aborted) {
        throw Object.assign(new Error(`Scorecard lock wait for ${lockPath(directory)} cancelled: writer stopped`), { code: 'SCORECARD_LOCK_CANCELLED' })
      }
    },
  })
  if (!release) {
    throw Object.assign(new Error(`Scorecard maintenance lock ${lockPath(directory)} still held after ${Math.round(timeoutMs / 1000)}s (${describeLockOwner(directory)}); if no replay is running, clear it per docs/scorecard-backfill.md`), { code: 'SCORECARD_LOCK_BUSY' })
  }
  try {
    return await operation()
  } finally {
    release()
  }
}

const appendScorecardRecord = async (directory, file, record, options) => {
  const line = JSON.stringify(record) + '\n'
  await withScorecardLock(directory, () => fs.promises.appendFile(file, line, { mode: 0o600 }), options)
}

const validateJsonl = (content) => {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string') {
      throw new Error('Invalid scorecard JSONL record')
    }
  }
}

const atomicPublish = (file, content, validate = (/** @type {string} */ _content) => {}) => {
  validate(content)
  atomicWriteSync(file, content)
}

module.exports = { acquireScorecardLock, withScorecardLock, appendScorecardRecord, validateJsonl, atomicPublish, lockPath }
