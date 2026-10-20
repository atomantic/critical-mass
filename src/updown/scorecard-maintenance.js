// @ts-check
const fs = require('fs')
const path = require('path')
const { atomicWriteSync } = require('../durable-write')
const { setTimeout: delay } = require('timers/promises')

const lockPath = (directory) => path.join(directory, '.maintenance-lock')

// Never steal a stale lock automatically: a paused writer may still own it.
// After a crash, stop every scorecard writer before removing this directory.
const acquireScorecardLock = (directory) => {
  fs.mkdirSync(directory, { recursive: true })
  const lock = lockPath(directory)
  try {
    fs.mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') return null
    throw error
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
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

// Bounded because the lock is never stolen: an unbounded wait on a lock left by
// a killed process wedged scorecard startup (and with it UpDown and the gateway
// shutdown drain) silently and forever. Fail with the recovery pointer instead.
const withScorecardLock = async (directory, operation, { timeoutMs = DEFAULT_LOCK_WAIT_MS } = {}) => {
  const deadline = Date.now() + timeoutMs
  let release
  while (!(release = acquireScorecardLock(directory))) {
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

const appendScorecardRecord = async (directory, file, record) => {
  const line = JSON.stringify(record) + '\n'
  await withScorecardLock(directory, () => fs.promises.appendFile(file, line, { mode: 0o600 }))
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
