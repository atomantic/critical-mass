// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { createScorecard, buildOutcomeRecord } = require('../src/updown/scorecard')

describe('scorecard restart hydration', () => {
  it('does not double retained outcomes across stop/start and ignores duplicate keys', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-hydration-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const prediction = {
      type: 'prediction',
      id: 'p1',
      ts: '2026-08-30T10:00:00.000Z',
      price: 100,
      compositeScore: 30,
      compositeDirection: 'up',
      timeframes: {},
      contract: null,
    }
    const windows = [60_000, 300_000, 900_000, 3_600_000]
    const outcomes = windows.map(windowMs => buildOutcomeRecord(prediction, windowMs, 101, {
      ts: new Date(Date.parse(prediction.ts) + windowMs).toISOString(),
    }))
    const rows = [prediction, ...outcomes, outcomes[0]] // duplicate 1m row
    await fs.writeFile(path.join(dir, '2026-08-30.jsonl'), rows.map(JSON.stringify).join('\n') + '\n')

    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 101,
      journalWriter: () => Promise.resolve(),
      scorecardDir: dir,
    })
    const compute = () => ({ score: 0, type: 'NEUTRAL', timeframes: {} })

    await scorecard.start(compute)
    assert.equal(scorecard.getMetrics().totalEvaluated, 4)
    assert.equal(scorecard.getMetrics().totalPredictions, 1)
    scorecard.stop()

    await scorecard.start(compute)
    assert.equal(scorecard.getMetrics().totalEvaluated, 4)
    assert.equal(scorecard.getMetrics().totalPredictions, 1)
    scorecard.stop()
  })
})
