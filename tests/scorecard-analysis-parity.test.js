// @ts-check
const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createScorecard } = require('../src/updown/scorecard')
const analytics = require('../src/updown/scorecard-analytics')

it('live hydration and the registered historical endpoint agree on mixed-version outcomes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-parity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journalDir = path.join(dir, 'scorecard')
  fs.mkdirSync(journalDir)
  const date = new Date().toISOString().slice(0, 10)
  const base = { type: 'outcome', window: '5m', ts: date + 'T10:05:00Z', compositeDirection: 'up' }
  const rows = [
    { ...base, predictionId: 'legacy-win', compositeCorrect: true, priceChangeBps: 100 },
    { ...base, predictionId: 'current-loss', compositeCorrect: false, priceChangeBps: -100, perpCorrect: false },
  ]
  fs.writeFileSync(path.join(journalDir, date + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n{torn')
  fs.writeFileSync(path.join(journalDir, '2000-01-01.jsonl'), JSON.stringify({ ...rows[0], predictionId: 'outside-range' }))

  // Evaluate the real registration module with only its storage root redirected.
  const routePath = require.resolve('../src/routes/updown-routes')
  const routeRequire = createRequire(routePath)
  const routeModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(routePath, 'utf8'), {
    module: routeModule,
    require: id => id === '../paths' ? { UPDOWN_DATA_DIR: dir } : routeRequire(id),
  }, { filename: routePath })
  const handlers = new Map()
  const app = { get: (url, fn) => handlers.set(url, fn), post: () => {}, put: () => {}, delete: () => {} }
  routeModule.exports(app, { updownService: {}, readJSON: () => ({}), DATA_DIR: dir })
  assert.equal(routeModule.exports.buildIndicatorTimeframeHeatmap, analytics.buildIndicatorTimeframeHeatmap)
  const legacyExports = require('../src/updown/scorecard')
  for (const name of ['getDirection', 'evaluateDirection', 'dedupeScorecardRecords', 'WINDOW_MS']) {
    assert.equal(legacyExports[name], analytics[name])
  }

  // Remove the deliberately out-of-range fixture before live hydration, which has
  // its own retention policy rather than the HTTP request's explicit date range.
  let historical
  handlers.get('/api/updown/scorecard-analysis')(
    { query: { from: date, to: date } },
    { json: result => { historical = result } },
  )
  fs.unlinkSync(path.join(journalDir, '2000-01-01.jsonl'))
  const scorecard = createScorecard({
    io: { to: () => ({ emit: () => {} }) }, lastPriceFn: () => 100,
    journalWriter: async () => {}, scorecardDir: journalDir,
  })
  t.after(() => scorecard.stop())
  await scorecard.start(() => ({ score: 0, type: 'NEUTRAL', timeframes: {} }))
  assert.deepEqual(scorecard.getMetrics().overallPerp, { accuracy: 50, correct: 1, incorrect: 1, total: 2 })
  assert.equal(historical.summary.perpDirectionalAccuracy, 50)
  assert.equal(historical.summary.outcomes, 2)
})
