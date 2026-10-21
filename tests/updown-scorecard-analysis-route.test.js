// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { buildScorecardAnalysis } = require('../src/updown/scorecard-analytics')

const DATE = '2026-09-07'
const outcome = (predictionId, overrides = {}) => ({
  type: 'outcome', predictionId, window: '5m', ts: DATE + 'T10:05:00Z',
  compositeDirection: 'up', compositeCorrect: true, priceChangeBps: 100, perpCorrect: true,
  ...overrides,
})

// Load the real route module with storage redirected and fs instrumented so the
// test can see which reads the handler performs.
const loadRoute = (dir) => {
  const counts = { asyncReads: 0, syncReads: 0 }
  const fsSpy = {
    ...fs,
    readFileSync: () => { counts.syncReads++; throw new Error('sync read on event loop') },
    readdirSync: () => { counts.syncReads++; throw new Error('sync readdir on event loop') },
    existsSync: () => { counts.syncReads++; throw new Error('sync exists on event loop') },
    promises: {
      ...fs.promises,
      readFile: (...args) => { counts.asyncReads++; return fs.promises.readFile(...args) },
    },
  }
  const routePath = require.resolve('../src/routes/updown-routes')
  const routeRequire = createRequire(routePath)
  const routeModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(routePath, 'utf8'), {
    module: routeModule,
    require: id => id === '../paths' ? { UPDOWN_DATA_DIR: dir } : id === 'fs' ? fsSpy : routeRequire(id),
  }, { filename: routePath })
  const handlers = new Map()
  const app = { get: (url, fn) => handlers.set(url, fn), post: () => {}, put: () => {}, delete: () => {} }
  routeModule.exports(app, { updownService: {}, readJSON: () => ({}), DATA_DIR: dir })
  const handler = handlers.get('/api/updown/scorecard-analysis')
  const call = async (query = { from: DATE, to: DATE }) => {
    let body
    await handler({ query }, { status: () => ({ json: r => { body = r } }), json: r => { body = r } })
    return body
  }
  return { call, counts }
}

describe('GET /api/updown/scorecard-analysis journal reads', () => {
  it('returns the same analysis as the pure builder, skipping torn lines, without sync fs reads', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-route-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const journalDir = path.join(dir, 'scorecard')
    fs.mkdirSync(journalDir)
    const rows = [outcome('a'), outcome('b', { compositeCorrect: false, priceChangeBps: -100, perpCorrect: false })]
    fs.writeFileSync(path.join(journalDir, DATE + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n{torn')
    fs.writeFileSync(path.join(journalDir, '2000-01-01.jsonl'), JSON.stringify(outcome('outside')))

    const { call, counts } = loadRoute(dir)
    const result = await call()
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(buildScorecardAnalysis(rows))))
    assert.equal(counts.syncReads, 0)
    assert.equal(counts.asyncReads, 1)
  })

  it('serves an unchanged repeat request without re-reading and re-reads once the journal grows', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-route-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const journalDir = path.join(dir, 'scorecard')
    fs.mkdirSync(journalDir)
    const file = path.join(journalDir, DATE + '.jsonl')
    fs.writeFileSync(file, JSON.stringify(outcome('a')) + '\n')

    const { call, counts } = loadRoute(dir)
    const first = await call()
    const second = await call()
    assert.equal(counts.asyncReads, 1, 'second identical poll must not re-read the journal')
    assert.deepEqual(second, first)
    assert.equal(first.summary.outcomes, 1)

    fs.appendFileSync(file, JSON.stringify(outcome('b')) + '\n')
    const third = await call()
    assert.equal(counts.asyncReads, 2, 'a grown journal must be re-read')
    assert.equal(third.summary.outcomes, 2)
  })

  it('keeps the newest days cached when a long-range request reads older journals', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-route-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const journalDir = path.join(dir, 'scorecard')
    fs.mkdirSync(journalDir)
    const days = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`)
    for (const day of days) fs.writeFileSync(path.join(journalDir, day + '.jsonl'), JSON.stringify(outcome(day)) + '\n')

    const { call, counts } = loadRoute(dir)
    const recent = { from: '2026-08-25', to: '2026-08-31' }
    await call(recent)
    assert.equal(counts.asyncReads, 7)
    await call({ from: '2026-08-01', to: '2026-08-31' })
    assert.equal(counts.asyncReads, 7 + 24, 'the long range reads only the days it has not cached')
    await call(recent)
    assert.equal(counts.asyncReads, 7 + 24, 'the recent window must still be served from cache')
  })

  it('returns the empty analysis when the scorecard directory does not exist', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-route-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const { call } = loadRoute(dir)
    const result = await call()
    assert.equal(result.success, true)
    assert.equal(result.summary.outcomes, 0)
  })
})
