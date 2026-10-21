// @ts-check
const fs = require('fs')
const os = require('os')
const path = require('path')
const { atomicWriteSync } = require('../durable-write')
const { setTimeout: delay } = require('timers/promises')

const lockPath = (directory) => path.join(directory, '.maintenance-lock')

// A lock is reclaimed only when its owner.json is readable, names a pid on this
// host, that pid is provably gone (ESRCH), and the lock is past a short grace
// period. Anything else (live owner, EPERM, unreadable or malformed metadata,
// another host) is treated as held: a paused writer may still own the lock.
const STALE_LOCK_GRACE_MS = 5_000

const isOwnerDead = (directory) => {
  const lock = lockPath(directory)
  let owner
  let ageMs
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
    ageMs = Date.now() - fs.statSync(lock).mtimeMs
  } catch {
    return null
  }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null
  if (owner.host !== undefined && owner.host !== os.hostname()) return null
  if (ageMs < STALE_LOCK_GRACE_MS) return null
  try {
    process.kill(owner.pid, 0)
    return null
  } catch (error) {
    return error.code === 'ESRCH' ? owner.pid : null
  }
}

// Rename aside first so concurrent reclaimers cannot remove a lock another
// process just re-acquired; verify the moved directory is still the dead owner's.
const reclaimStaleLock = (directory) => {
  const pid = isOwnerDead(directory)
  if (pid === null) return false
  const lock = lockPath(directory)
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`
  try {
    fs.renameSync(lock, aside)
  } catch {
    return false
  }
  let movedPid
  try {
    movedPid = JSON.parse(fs.readFileSync(path.join(aside, 'owner.json'), 'utf8'))?.pid
  } catch {
    movedPid = undefined
  }
  if (movedPid !== pid) {
    try { fs.renameSync(aside, lock) } catch { /* lock was re-created; leave the moved directory for inspection */ }
    return false
  }
  fs.rmSync(aside, { recursive: true, force: true })
  console.warn(`Reclaimed stale scorecard maintenance lock ${lock} from dead pid ${pid}`)
  return true
}

const acquireScorecardLock = (directory) => {
  fs.mkdirSync(directory, { recursive: true })
  const lock = lockPath(directory)
  try {
    fs.mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!reclaimStaleLock(directory)) return null
    try {
      fs.mkdirSync(lock, { mode: 0o700 })
    } catch (retryError) {
      if (retryError.code === 'EEXIST') return null
      throw retryError
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch (error) {
    fs.rmSync(lock, { recursive: true })
    throw error
  }
  let released = false
  return () => {
    if (released) return
    fs.rmSync(lock, { recursive: true })
    released = true
  }
}

// Live appends wait out a replay publication (docs/scorecard-backfill.md), which
// can run for minutes of fsync'd day rewrites on slow storage.
const DEFAULT_LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 25

const describeLockOwner = (directory) => {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath(directory), 'owner.json'), 'utf8'))
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
const withScorecardLock = async (directory, operation, { timeoutMs = DEFAULT_LOCK_WAIT_MS, signal } = {}) => {
  const deadline = Date.now() + timeoutMs
  let release
  while (!(release = acquireScorecardLock(directory))) {
    if (signal?.aborted) {
      throw Object.assign(new Error(`Scorecard lock wait for ${lockPath(directory)} cancelled: writer stopped`), { code: 'SCORECARD_LOCK_CANCELLED' })
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`Scorecard maintenance lock ${lockPath(directory)} still held after ${Math.round(timeoutMs / 1000)}s (${describeLockOwner(directory)}); if no replay is running, clear it per docs/scorecard-backfill.md`), { code: 'SCORECARD_LOCK_BUSY' })
    }
    await delay(LOCK_POLL_MS)
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

const atomicPublish = (file, content, validate = () => {}) => {
  validate(content)
  atomicWriteSync(file, content)
}

module.exports = { acquireScorecardLock, withScorecardLock, appendScorecardRecord, validateJsonl, atomicPublish, lockPath }
