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

const CYCLE_START = Date.UTC(2026, 0, 1)

// Observe public boundaries without exporting private cycle steps or replacing the book.
// structuredClone retains undefined-valued fields and freezes each write at call time.
const cycleHarness = async (t, { saved = null, metrics = { adaptiveWeights: null, byWindow: {} }, failAt } = {}) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: CYCLE_START })
  const calls = []
  const results = []
  let next = {}
  let service
  const record = (name, payload) => {
    calls.push({ name, payload: structuredClone(payload) })
    if (name === failAt) throw new Error(`test failure: ${name}`)
  }
  let engineIndex = 0
  service = createUpDownService({ to: room => ({ emit: (name, payload) => {
    assert.equal(room, 'updown')
    record(name, payload)
  } }) }, {
    readJSON: () => structuredClone(saved),
    writeJSON: (file, state) => record('persist', state),
    DATA_DIR: '/tmp/updown-cycle-in-memory',
    candleCache,
    createSignalEngine: () => {
      const index = engineIndex++
      return {
        computeSignals: (expiry, weights, position) => {
          record('compute', { expiry, weights, position })
          const result = { ...signalResult('NEUTRAL'), ...next }
          results.push(result)
          return result
        },
        setIndicatorWeights: weights => record(`weights:${index}`, weights),
        getStabilityState: () => ({ publishedType: 'NEUTRAL' }),
        setStabilityState: () => {},
      }
    },
    createScorecard: () => scorecardStub({
      getMetrics: () => metrics,
      recordPerpFill: fill => {
        // A completed fill must already be visible when journaling starts.
        record('fill-book', service.getStatus().perp)
        record('recordPerpFill', fill)
      },
      recordPrediction: (result, source) => {
        assert.equal(result, results.at(-1), 'journal receives the engine result itself')
        record('prediction', { result, source })
      },
    }),
  })
  await service.start()
  t.after(() => { failAt = undefined; service.stop() })
  const cycle = (result = {}, prices = [100]) => {
    next = result
    prices.forEach((price, index) => service.handlePriceTick(price, Date.now() + index * 100))
    calls.length = 0 // tick emissions precede the signal cycle
    t.mock.timers.tick(5_000)
    return calls
  }
  return { service, calls, results, cycle }
}

const historyRow = (type, timestamp, score = 0) => ({
  type, action: type === 'BUY' ? 'OPEN' : 'HOLD', score, confidence: 0, timestamp, price: 100,
})

describe('UpDown cycle momentum characterization', () => {
  const cases = [
    { name: 'below threshold leaves confidence untouched', input: { score: 4.99, confidence: 0.77 }, prices: [100, 101, 102], score: 4.99, type: 'NEUTRAL', confidence: 0.77 },
    { name: 'zero momentum leaves confidence untouched', input: { type: 'BUY', score: 25, confidence: 0.77 }, prices: [100, 100, 100], score: 25, type: 'BUY', confidence: 0.77 },
    { name: 'threshold score is adjusted', input: { score: 5 }, prices: [100, 101, 102], score: 6.25, type: 'NEUTRAL', confidence: 0.1 },
    { name: 'aligned ticks amplify directional strength', input: { type: 'BUY', score: 30 }, prices: [100, 101, 102], score: 37.5, type: 'STRONG_BUY', confidence: 0.63 },
    { name: 'small momentum scales the boost', input: { type: 'BUY', score: 20 }, prices: [100, 100.05, 100.1], score: 22.5, type: 'BUY', confidence: 0.38 },
    { name: 'opposing ticks damp and round', input: { type: 'BUY', score: 20.01 }, prices: [102, 101, 100], score: 17.01, type: 'BUY', confidence: 0.28 },
    { name: 'damping cannot cancel a published direction', input: { type: 'BUY', score: 16 }, prices: [102, 101, 100], score: 13.6, type: 'BUY', confidence: 0.23 },
    { name: 'missing volatility uses normal threshold', input: { score: 14.5, volatility: undefined }, prices: [100, 101, 102], score: 15, type: 'NEUTRAL', confidence: 0.25 },
    { name: 'low volatility retains its wider clamp', input: { score: 19, volatility: { ratio: 0 } }, prices: [100, 101, 102], score: 22, type: 'NEUTRAL', confidence: 0.37 },
    { name: 'closed trend gate suppresses amplified upgrade', input: { type: 'BUY', score: 30, trendGate: { open: false } }, prices: [100, 101, 102], score: 37.5, type: 'BUY', confidence: 0.63 },
    { name: 'held DOWN exit bypasses closed trend gate and no-trade zone', input: { type: 'BUY', score: 30, trendGate: { open: false }, noTradeZone: true }, position: { direction: 'down', entryPrice: 100, contracts: 1 }, prices: [100, 101, 102], score: 37.5, type: 'STRONG_BUY', confidence: 0.63 },
    { name: 'held UP exit survives no-trade zone', input: { type: 'SELL', score: -30, noTradeZone: true }, position: { direction: 'up', entryPrice: 100, contracts: 1 }, prices: [102, 101, 100], score: -37.5, type: 'STRONG_SELL', confidence: 0.63 },
    { name: 'no-trade zone remains excluded without a held exit', input: { type: 'NO_TRADE_ZONE', score: 14.5, noTradeZone: true }, prices: [100, 101, 102], score: 15, type: 'NO_TRADE_ZONE', confidence: 0.25 },
    { name: 'confidence caps at one', input: { type: 'STRONG_BUY', score: 60 }, prices: [100, 101, 102], score: 75, type: 'STRONG_BUY', confidence: 1 },
    // Long window rises while the last ten prices fall: magnitude > 0, direction neutral.
    { name: 'neutral direction recomputes confidence without boosting', input: { type: 'BUY', score: 25, confidence: 0.77 }, prices: [100, 120, 119, 118, 117, 116, 115, 114, 113, 112, 111], score: 25, type: 'BUY', confidence: 0.42 },
  ]
  for (const scenario of cases) {
    it(scenario.name, async t => {
      const { service, cycle, results } = await cycleHarness(t, { saved: { position: scenario.position } })
      const calls = cycle(scenario.input, scenario.prices)
      const adjusted = { score: scenario.score, type: scenario.type, confidence: scenario.confidence }
      for (const result of [results[0], calls.find(c => c.name === 'updown:indicators').payload, service.getTradeContext().latestSignal]) {
        assert.deepEqual({ score: result.score, type: result.type, confidence: result.confidence }, adjusted)
      }
      assert.deepEqual(calls.find(c => c.name === 'compute').payload.position, scenario.position ?? null)
      assert.deepEqual(service.getTradeContext().volatility, scenario.input.volatility === undefined && 'volatility' in scenario.input ? null : scenario.input.volatility ?? { ratio: 1 })
    })
  }
})

describe('UpDown cycle history and side-effect characterization', () => {
  it('orders fill, journal, both state snapshots, and exact event payloads', async t => {
    const metrics = { adaptiveWeights: { rsi: 0.8 }, byWindow: {} }
    const { cycle, service } = await cycleHarness(t, { metrics })
    const calls = cycle({ type: 'BUY', score: 30, confidence: 0.5, noTradeZone: false, warningZone: null })
    assert.deepEqual(calls.map(c => c.name), [
      'weights:0', 'weights:1', 'compute', 'fill-book', 'recordPerpFill', 'persist',
      'updown:scorecard', 'updown:indicators', 'persist', 'prediction', 'updown:signal',
    ])
    const ts = CYCLE_START + 5_000
    const book = calls.find(c => c.name === 'fill-book').payload
    assert.equal(book.contracts, 1)
    assert.deepEqual(book.lots, [{ entryPrice: 100, entryTs: ts, action: 'OPEN' }])
    assert.deepEqual(calls.find(c => c.name === 'recordPerpFill').payload, {
      action: 'OPEN', signalType: 'BUY', price: 100, ts, contracts: 1, side: 'buy', pnl: undefined,
      trade: null, book: { contracts: 1, realizedPnl: 0 },
    })
    const row = { type: 'BUY', action: 'OPEN', score: 30, confidence: 0.5, timestamp: ts, price: 100 }
    const writes = calls.filter(c => c.name === 'persist').map(c => c.payload)
    const state = {
      contract: { expiry: null, target: null, stop: null, range: null, direction: null },
      position: null, signalHistory: [], stability: { publishedType: 'NEUTRAL' },
      perpBook: { contractSizeBtc: 0.01, lots: book.lots, realizedPnl: 0, closedTrades: [], maxContracts: 1, lastSide: 'BUY', open: true },
    }
    assert.deepEqual(writes, [state, { ...state, signalHistory: [row] }])
    assert.deepEqual(service.getStatus().signalHistory, [row])
    assert.deepEqual(calls.find(c => c.name === 'updown:scorecard').payload, metrics)
    const common = {
      type: 'BUY', action: 'OPEN', score: 30, confidence: 0.5, noTradeZone: false, warningZone: null,
      timeframes: {}, timestamp: ts, trendFilter: { trendBias: 'neutral' }, weeklyTrend: undefined,
      dailySMA: undefined, adxRegime: undefined, volatility: { ratio: 1 }, pivotPoints: undefined,
      horizonPrediction: undefined, trendGate: { open: true }, perp: book,
    }
    assert.deepEqual(calls.find(c => c.name === 'updown:indicators').payload, {
      ...common, tickMomentum: { direction: 'neutral', magnitude: 0, velocity: 0 }, confluence: undefined,
    })
    assert.deepEqual(calls.find(c => c.name === 'updown:signal').payload, { ...common, filled: true })
    assert.deepEqual(calls.find(c => c.name === 'prediction').payload, {
      result: { ...signalResult('BUY'), timestamp: ts, noTradeZone: false, warningZone: null }, source: 'signal_change',
    })
    assert.deepEqual(calls.slice(0, 3).map(c => c.payload), [metrics.adaptiveWeights, metrics.adaptiveWeights, { expiry: null, weights: metrics, position: null }])

    const repeated = cycle({ type: 'BUY', score: 30, confidence: 0.5 })
    assert.deepEqual(repeated.map(c => c.name), ['weights:0', 'weights:1', 'compute', 'updown:indicators'])
    assert.equal(repeated.at(-1).payload.action, 'ADD')
    assert.equal(service.getStatus().perp.contracts, 1, 'same-side repeats must not fill')
    assert.deepEqual(service.getStatus().signalHistory, [row])
  })

  for (const age of [299_999, 300_000]) {
    it(`resumed same-type history at age ${age}ms preserves the strict debounce boundary`, async t => {
      const old = historyRow('NEUTRAL', CYCLE_START + 5_000 - age)
      const { service, cycle } = await cycleHarness(t, { saved: { signalHistory: [old] } })
      const calls = cycle()
      assert.deepEqual(calls.map(c => c.name), ['compute', 'updown:indicators', 'persist', 'prediction', 'updown:signal'])
      assert.deepEqual(service.getStatus().signalHistory, age < 300_000 ? [old] : [old, historyRow('NEUTRAL', CYCLE_START + 5_000)])
      assert.deepEqual(calls.find(c => c.name === 'persist').payload.signalHistory, service.getStatus().signalHistory)
    })
  }

  it('excludes NO_TRADE_ZONE rows while still persisting, predicting and publishing changes', async t => {
    const { service, cycle } = await cycleHarness(t)
    const calls = cycle({ type: 'NO_TRADE_ZONE', noTradeZone: true })
    assert.deepEqual(calls.map(c => c.name), ['compute', 'updown:indicators', 'persist', 'prediction', 'updown:signal'])
    assert.deepEqual(service.getStatus().signalHistory, [])
    assert.deepEqual(calls.find(c => c.name === 'persist').payload.signalHistory, [])
    assert.equal(calls.find(c => c.name === 'prediction').payload.result.type, 'NO_TRADE_ZONE')
    assert.equal(calls.at(-1).payload.filled, false)
    assert.deepEqual(cycle({ type: 'NO_TRADE_ZONE' }).map(c => c.name), ['compute', 'updown:indicators'])
  })

  it('an intervening NEUTRAL closes the book and permits another BUY row', async t => {
    const { service, cycle } = await cycleHarness(t)
    cycle({ type: 'BUY', score: 30 })
    cycle({ type: 'NEUTRAL' })
    const calls = cycle({ type: 'BUY', score: 30 })
    assert.deepEqual(service.getStatus().signalHistory.map(r => [r.type, r.action]), [['BUY', 'OPEN'], ['NEUTRAL', 'CLOSE'], ['BUY', 'OPEN']])
    assert.equal(service.getStatus().perp.contracts, 1)
    assert.equal(calls.find(c => c.name === 'recordPerpFill').payload.action, 'OPEN')
  })

  it('NO_TRADE_ZONE does not break consecutive-type history debounce', async t => {
    const { service, cycle } = await cycleHarness(t)
    cycle()
    cycle({ type: 'NO_TRADE_ZONE', noTradeZone: true })
    const calls = cycle()
    assert.deepEqual(service.getStatus().signalHistory, [historyRow('NEUTRAL', CYCLE_START + 5_000)])
    assert.deepEqual(calls.map(c => c.name), ['compute', 'updown:indicators', 'persist', 'prediction', 'updown:signal'])
  })

  it('stale cycles do not compute, fill, write, predict or emit until ticks resume', async t => {
    const { service, cycle, calls } = await cycleHarness(t)
    cycle()
    t.mock.timers.tick(30_000)
    calls.length = 0
    t.mock.timers.tick(5_000)
    assert.deepEqual(calls, [])
    assert.equal(service.getTradeContext().lastPrice, null)
    assert.equal(service.getStatus().perp.contracts, 0)
    cycle({ type: 'BUY', score: 30 })
    assert.equal(service.getStatus().perp.contracts, 1)
    assert.equal(calls.at(-1).name, 'updown:signal')
  })

  it('retains the newest 100 history rows on insertion', async t => {
    const history = Array.from({ length: 100 }, (_, i) => historyRow('NEUTRAL', CYCLE_START - (100 - i) * 300_000))
    const { service, cycle } = await cycleHarness(t, { saved: { signalHistory: history } })
    const calls = cycle()
    const expected = [...history.slice(1), historyRow('NEUTRAL', CYCLE_START + 5_000)]
    assert.deepEqual(service.getStatus().signalHistory, expected)
    assert.deepEqual(calls.find(c => c.name === 'persist').payload.signalHistory, expected)
  })

  for (const failAt of ['compute', 'recordPerpFill', 'persist', 'prediction']) {
    it(`the interval catches ${failAt} failure and stops later cycle effects`, async t => {
      const { cycle, calls, service } = await cycleHarness(t, { failAt })
      assert.doesNotThrow(() => cycle({ type: 'BUY', score: 30 }))
      const order = ['compute', 'fill-book', 'recordPerpFill', 'persist', 'updown:scorecard', 'updown:indicators', 'persist', 'prediction', 'updown:signal']
      assert.deepEqual(calls.map(c => c.name), order.slice(0, order.indexOf(failAt) + 1))
      assert.equal(service.getStatus().perp.contracts, failAt === 'compute' ? 0 : 1)
    })
  }
})
