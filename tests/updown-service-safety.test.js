// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createUpDownService, isFreshPrice, PRICE_STALE_MS } = require('../src/updown/updown-service')

const io = { to: () => ({ emit: () => {} }) }
const candleCache = { getCandles: () => [] }

const signalResult = (type) => ({
  type,
  score: type === 'BUY' ? 30 : 0,
  confidence: type === 'BUY' ? 0.5 : 0,
  timestamp: Date.now(),
  timeframes: {},
  trendFilter: { trendBias: 'neutral' },
  volatility: { ratio: 1 },
  trendGate: { open: true },
})

const engineFactory = (computeSignals) => () => ({
  computeSignals,
  setIndicatorWeights: () => {},
  getStabilityState: () => ({}),
  setStabilityState: () => {},
})

const scorecardStub = (overrides = {}) => ({
  start: () => Promise.resolve(),
  stop: () => {},
  getMetrics: () => ({ adaptiveWeights: null, byWindow: {} }),
  recordPrediction: () => {},
  recordPerpFill: () => {},
  ...overrides,
})

describe('UpDown stale-price and lifecycle safety', () => {
  it('classifies only recent, positive marks as fresh', () => {
    assert.equal(isFreshPrice(100, 1_000, 1_000 + PRICE_STALE_MS), true)
    assert.equal(isFreshPrice(100, 1_000, 1_001 + PRICE_STALE_MS), false)
    assert.equal(isFreshPrice(0, 1_000, 1_001), false)
    assert.equal(isFreshPrice(100, 0, 1_001), false)
  })

  it('lets stop win over an in-progress start', async () => {
    let resolveStart
    let scorecardStops = 0
    const deferredStart = new Promise(resolve => { resolveStart = resolve })
    const service = createUpDownService(io, {
      readJSON: () => null,
      writeJSON: () => {},
      DATA_DIR: '/tmp/updown-service-lifecycle',
      candleCache,
      createSignalEngine: engineFactory(() => signalResult('HOLD')),
      createScorecard: () => scorecardStub({
        start: () => deferredStart,
        stop: () => { scorecardStops++ },
      }),
    })

    const starting = service.start()
    service.stop()
    resolveStart()
    await starting

    assert.equal(service.getStatus().running, false)
    assert.equal(scorecardStops, 1)
  })

  it('pauses predictions and paper fills until a stale feed becomes fresh again', async (t) => {
    const startedAt = Date.UTC(2026, 0, 1)
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: startedAt })
    let computeCalls = 0
    const service = createUpDownService(io, {
      readJSON: () => null,
      writeJSON: () => {},
      DATA_DIR: '/tmp/updown-service-stale',
      candleCache,
      createSignalEngine: engineFactory(() => {
        computeCalls++
        return signalResult(Date.now() - startedAt >= 40_000 ? 'BUY' : 'HOLD')
      }),
      createScorecard: () => scorecardStub(),
    })

    await service.start()
    service.handlePriceTick(100, startedAt)
    t.mock.timers.tick(35_000)
    const callsAtStale = computeCalls
    assert.equal(service.getStatus().priceFresh, false)
    assert.equal(service.getStatus().lastPrice, null)
    assert.equal(service.getStatus().perp.contracts, 0)

    t.mock.timers.tick(5_000)
    assert.equal(computeCalls, callsAtStale, 'stale cycles must not run the model')
    assert.equal(service.getStatus().perp.contracts, 0, 'stale marks must not fill the paper book')

    service.handlePriceTick(101, Date.now())
    t.mock.timers.tick(5_000)
    assert.equal(service.getStatus().priceFresh, true)
    assert.equal(service.getStatus().perp.contracts, 1)
    service.stop()
  })
})
