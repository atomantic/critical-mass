const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { publishBackfill } = require('../scripts/backfill-scorecard')
const { acquireScorecardLock, appendScorecardRecord, atomicPublish, validateJsonl, lockPath } = require('../src/updown/scorecard-maintenance')

const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-publication-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const day = '2026-01-01'
  const file = path.join(directory, `${day}.jsonl`)
  const live = { type: 'prediction', id: 'live-1', ts: `${day}T00:00:00Z` }
  const existing = JSON.stringify(live) + '\n'
  fs.writeFileSync(file, existing)
  const backfill = { type: 'prediction', id: 'backfill_1', trigger: 'backfill', ts: `${day}T00:05:00Z` }
  const buffers = { [day]: [JSON.stringify(backfill)] }
  return { directory, day, file, existing, live, buffers }
}

describe('scorecard backfill publication', () => {
  it('dry-run does not create output, backup, lock, or manifest files', (t) => {
    const f = fixture(t)
    const before = fs.readdirSync(f.directory)
    assert.equal(publishBackfill(f.buffers, { directory: f.directory }).totalLines, 1)
    assert.deepEqual(fs.readdirSync(f.directory), before)
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.existing)
    const absent = path.join(f.directory, 'absent')
    publishBackfill(f.buffers, { directory: absent })
    assert.equal(fs.existsSync(absent), false)
  })

  it('refuses apply while a writer owns the shared lock', (t) => {
    const f = fixture(t)
    const release = acquireScorecardLock(f.directory)
    try {
      assert.throws(() => publishBackfill(f.buffers, { directory: f.directory, apply: true }), /lock is busy/)
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.existing)
    } finally { release() }
  })

  it('queues a live append behind maintenance and preserves it after publication', async (t) => {
    const f = fixture(t)
    const release = acquireScorecardLock(f.directory)
    const later = { type: 'outcome', predictionId: f.live.id, window: '5m' }
    let appended = false
    const pending = appendScorecardRecord(f.directory, f.file, later).then(() => { appended = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(appended, false)
    // Model backfill preparation under the lock, then its atomic publication.
    atomicPublish(f.file, f.buffers[f.day].join('\n') + '\n' + fs.readFileSync(f.file, 'utf8'), validateJsonl)
    release()
    await pending
    const records = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(records, [JSON.parse(f.buffers[f.day][0]), f.live, later])
    // A normal apply also retains that live record and never duplicates replay.
    publishBackfill(f.buffers, { directory: f.directory, apply: true })
    assert.equal(fs.readFileSync(f.file, 'utf8').trim().split('\n').length, 3)
  })

  it('preserves originals on validation/staging failure and can retry safely', (t) => {
    const f = fixture(t)
    assert.throws(() => publishBackfill({ [f.day]: ['bad json'] }, { directory: f.directory, apply: true }))
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.existing)
    assert.equal(fs.existsSync(lockPath(f.directory)), false)
    assert.throws(() => atomicPublish(f.file, '{"type":"prediction"}\n', () => { throw new Error('interrupted stage') }), /interrupted stage/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.existing)
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false)
    const first = publishBackfill(f.buffers, { directory: f.directory, apply: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(first.manifestPath, 'utf8')).completedDays, [f.day])
    const backup = fs.readdirSync(f.directory).find(name => name.endsWith('.backup'))
    assert.equal(fs.readFileSync(path.join(f.directory, backup), 'utf8'), f.existing)
    const completed = fs.readFileSync(f.file, 'utf8')
    assert.equal(publishBackfill(f.buffers, { directory: f.directory, apply: true }).totalLines, 0)
    assert.equal(fs.readFileSync(f.file, 'utf8'), completed)
    // Simulate interruption after day rename but before manifest update.
    fs.unlinkSync(first.manifestPath)
    assert.equal(publishBackfill(f.buffers, { directory: f.directory, apply: true }).totalLines, 0)
    assert.equal(fs.readFileSync(f.file, 'utf8'), completed)
  })

  it('keeps the prior day intact when a publisher process is killed before rename', (t) => {
    const f = fixture(t)
    const { spawnSync } = require('child_process')
    const script = `const { atomicPublish } = require(process.argv[1]); atomicPublish(process.argv[2], '{"type":"prediction"}\\n', () => process.kill(process.pid, 'SIGKILL'))`
    const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/updown/scorecard-maintenance'), f.file])
    assert.equal(child.signal, 'SIGKILL')
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.existing)
    assert.equal(publishBackfill(f.buffers, { directory: f.directory, apply: true }).totalLines, 1)
  })

  it('resumes a multi-day run after a later day fails without duplicating completed history', (t) => {
    const f = fixture(t)
    const later = '2026-01-02'
    const laterFile = path.join(f.directory, `${later}.jsonl`)
    const buffers = { ...f.buffers, [later]: [JSON.stringify({ type: 'prediction', trigger: 'backfill', id: 'backfill_2', ts: `${later}T00:05:00Z` })] }
    fs.writeFileSync(laterFile, 'broken')
    assert.throws(() => publishBackfill(buffers, { directory: f.directory, apply: true }))
    const firstDay = fs.readFileSync(f.file, 'utf8')
    const manifestFile = fs.readdirSync(f.directory).find(name => name.endsWith('.manifest.json'))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, manifestFile), 'utf8')).completedDays, [f.day])
    assert.equal(fs.readFileSync(laterFile, 'utf8'), 'broken')
    fs.writeFileSync(laterFile, '')
    assert.equal(publishBackfill(buffers, { directory: f.directory, apply: true }).totalLines, 1)
    assert.equal(fs.readFileSync(f.file, 'utf8'), firstDay)
    validateJsonl(fs.readFileSync(laterFile, 'utf8'))
  })

  it('fails closed on malformed existing history rather than overwriting it', (t) => {
    const f = fixture(t)
    fs.appendFileSync(f.file, '{broken\n')
    const before = fs.readFileSync(f.file, 'utf8')
    assert.throws(() => publishBackfill(f.buffers, { directory: f.directory, apply: true }))
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  })
})
