// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  buildContractOutcomeRecord,
  buildOutcomeRecord,
  findUnsettledContractPredictions,
} = require('../src/updown/scorecard')

const makePrediction = (expiry) => ({
  type: 'prediction',
  id: 'p1',
  ts: '2026-01-01T00:00:00.000Z',
  price: 100,
  compositeScore: 30,
  compositeDirection: 'up',
  timeframes: {},
  contract: { expiry, target: 110, stop: 90, range: 20, direction: 'up' },
})

describe('contract scorecard settles at configured expiry', () => {
  const predictionTs = Date.parse('2026-01-01T00:00:00.000Z')
  const expiry = predictionTs + 6 * 60 * 60 * 1000

  it('never attaches a contract result to the fixed 1h outcome', () => {
    const outcome = buildOutcomeRecord(makePrediction(expiry), 3_600_000, 120, {
      ts: new Date(predictionTs + 3_600_000).toISOString(),
    })
    assert.equal(outcome.contractOutcome, null)
  })

  it('refuses early settlement and records the expiry mark once eligible', () => {
    const prediction = makePrediction(expiry)
    assert.equal(buildContractOutcomeRecord(prediction, 120, {
      ts: new Date(expiry - 1).toISOString(),
    }), null)

    const outcome = buildContractOutcomeRecord(prediction, 120, {
      ts: new Date(expiry).toISOString(),
    })
    assert.equal(outcome.window, 'contract')
    assert.equal(outcome.contractExpiry, expiry)
    assert.equal(outcome.contractOutcome, 'win')
  })

  it('excludes contracts that were already expired when predicted', () => {
    const prediction = makePrediction(predictionTs - 1)
    assert.equal(buildContractOutcomeRecord(prediction, 120, {
      ts: new Date(predictionTs + 1).toISOString(),
    }), null)
    const planned = findUnsettledContractPredictions([prediction], predictionTs + 10_000)
    assert.deepEqual(planned, { pending: [], elapsed: [] })
  })

  it('uses the first price at or after expiry and does not duplicate a settled contract', () => {
    const prediction = makePrediction(expiry)
    const before = { type: 'prediction', id: 'before', ts: new Date(expiry - 1_000).toISOString(), price: 80, compositeDirection: 'neutral' }
    const after = { type: 'prediction', id: 'after', ts: new Date(expiry + 2_000).toISOString(), price: 120, compositeDirection: 'neutral' }
    const planned = findUnsettledContractPredictions([prediction, before, after], expiry + 10_000)
    assert.equal(planned.elapsed.length, 1)
    assert.equal(planned.elapsed[0].exitPrice, 120)
    assert.equal(planned.elapsed[0].settlementTs, expiry + 2_000)

    const settled = {
      type: 'outcome', predictionId: 'p1', window: 'contract',
      ts: new Date(expiry + 2_000).toISOString(), exitPrice: 120, contractOutcome: 'win',
    }
    assert.equal(findUnsettledContractPredictions([prediction, after, settled], expiry + 10_000).elapsed.length, 0)
  })
})
