// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  buildContractOutcomeRecord,
  buildOutcomeRecord,
  createScorecard,
  findUnsettledContractPredictions,
} = require('../../../src/updown/scorecard')

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
    assert.deepEqual(planned, { pending: [], elapsed: [], knockouts: new Map() })
  })

  it('compares in-range expiry proceeds with the entry cost for either direction', () => {
    const prediction = makePrediction(expiry)
    const opts = { ts: new Date(expiry).toISOString() }
    assert.equal(buildContractOutcomeRecord(prediction, 105, opts).contractOutcome, 'win')
    assert.equal(buildContractOutcomeRecord(prediction, 100.1, opts).contractOutcome, 'loss', 'both fees exceed the small gain')
    assert.equal(buildContractOutcomeRecord(prediction, 95, opts).contractOutcome, 'loss')
    const down = { ...prediction, contract: { ...prediction.contract, target: 90, stop: 110, direction: 'down' } }
    assert.equal(buildContractOutcomeRecord(down, 95, opts).contractOutcome, 'win')
    assert.equal(buildContractOutcomeRecord(down, 105, opts).contractOutcome, 'loss')
    assert.equal(buildContractOutcomeRecord({ ...prediction, price: 120 }, 125, opts), null, 'entry already outside the range')
  })

  it('uses the first price at or after expiry and does not duplicate a settled contract', () => {
    const prediction = makePrediction(expiry)
    const before = { type: 'prediction', id: 'before', ts: new Date(expiry - 1_000).toISOString(), price: 95, compositeDirection: 'neutral' }
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

  it('recovers the first recorded knockout even when the expiry mark reaches the other bound', () => {
    const prediction = makePrediction(expiry)
    const floor = { type: 'prediction', id: 'floor', ts: new Date(expiry - 3_600_000).toISOString(), price: 90, compositeDirection: 'neutral' }
    const rebound = { type: 'prediction', id: 'rebound', ts: new Date(expiry).toISOString(), price: 120, compositeDirection: 'neutral' }
    const { elapsed: [settlement] } = findUnsettledContractPredictions([rebound, prediction, floor], expiry)
    assert.equal(settlement.knockout, 'stop')
    const outcome = buildContractOutcomeRecord(prediction, settlement.exitPrice, {
      ts: new Date(settlement.settlementTs).toISOString(),
      knockout: settlement.knockout,
    })
    assert.equal(outcome.contractOutcome, 'loss')
    assert.equal(outcome.contractExitReason, 'stop')
  })

  it('includes ticks received while a restart is loading its journal', () => {
    const prediction = makePrediction(expiry)
    const { elapsed: [settlement] } = findUnsettledContractPredictions([prediction], expiry, [
      { timestamp: expiry - 15_000, price: 90 },
      { timestamp: expiry, price: 120 },
    ])
    assert.equal(settlement.knockout, 'stop')
  })

  it('keeps a knocked-out listing closed after restart even when the original entries aged out', () => {
    const later = { ...makePrediction(expiry), ts: new Date(predictionTs + 120_000).toISOString() }
    const marker = {
      type: 'contract_knockout', ts: new Date(predictionTs + 60_000).toISOString(),
      price: 90, contract: later.contract,
    }
    const plan = findUnsettledContractPredictions([marker, later], predictionTs + 150_000)
    assert.deepEqual(plan.pending, [])
    assert.deepEqual(plan.elapsed, [])
    assert.equal([...plan.knockouts.values()][0].knockout, 'stop')
  })

  it('journals a live knockout once and ignores a later recovery', async (t) => {
    const start = Date.now()
    const records = []
    const contract = { ...makePrediction(start + 60_000).contract }
    const scorecard = createScorecard({
      io: { to: () => ({ emit() {} }) },
      scorecardDir: '/dev/null/updown-scorecard',
      lastPriceFn: () => 100,
      contractFn: () => contract,
      journalWriter: async record => { records.push(record) },
    })
    t.after(() => scorecard.stop())
    await scorecard.start(() => null)
    scorecard.recordPrediction({ type: 'BUY', score: 30 }, 'interval')
    scorecard.observePrice(90, start + 30_000)
    scorecard.recordPrediction({ type: 'BUY', score: 30 }, 'interval')
    scorecard.observePrice(120, start + 40_000)
    scorecard.observePrice(120, start + 60_000)
    await new Promise(resolve => setImmediate(resolve))
    const outcomes = records.filter(r => r.window === 'contract')
    assert.equal(outcomes.length, 1)
    assert.equal(records.filter(r => r.type === 'contract_knockout').length, 1)
    assert.equal(outcomes[0].contractOutcome, 'loss')
    assert.equal(scorecard.getMetrics().contractAware.wins, 0)
  })
})
