// @ts-check
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
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

const withScorecardLock = async (directory, operation) => {
  let release
  while (!(release = acquireScorecardLock(directory))) await delay(25)
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
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, content)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    validate(fs.readFileSync(temporary, 'utf8'))
    fs.renameSync(temporary, file)
    const directory = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

module.exports = { acquireScorecardLock, withScorecardLock, appendScorecardRecord, validateJsonl, atomicPublish, lockPath }
