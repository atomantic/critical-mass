// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  FLUSH_SETUP_PARAMS,
  createFlushSetupState,
  stepFlushSetup,
  createFlushSetupTracker,
  replayFlushSetup,
} = require('../src/updown/flush-setup')
const { createSignalEngine } = require('../src/updown/signal-engine')

const MIN = 60_000
const DAY = 86_400_000
const D0 = Date.UTC(2026, 0, 5)

/**
 * 1m series: a flat prior day closing at 100k, then (starting at `flushAt`
 * minutes after D0) a 20-minute slide to `floor`, a bounce, and a drift to
 * `finalPrice`.
 */
const buildSeries = ({ flushAt = 25 * 60, floor = 98_500, finalPrice = 99_900, total = 28 * 60 } = {}) => {
  const out = []
  let prev = 100_000
  for (let m = 0; m < total; m++) {
    let close
    if (m < flushAt) close = 100_000 + (m % 2 ? 5 : -5)
    else if (m < flushAt + 20) close = 100_000 - ((100_000 - floor) * (m - flushAt + 1)) / 20
    else close = Math.min(finalPrice, floor + (m - flushAt - 19) * 60)
    const open = prev
    out.push({ timestamp: D0 + m * MIN, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 1 })
    prev = close
  }
  return out
}

const aggregate = (candles, interval) => {
  const buckets = new Map()
  for (const c of candles) {
    const ts = Math.floor(c.timestamp / interval) * interval
    const b = buckets.get(ts)
    if (!b) buckets.set(ts, { ...c, timestamp: ts })
    else {
      b.high = Math.max(b.high, c.high)
      b.low = Math.min(b.low, c.low)
      b.close = c.close
    }
  }
  return [...buckets.values()]
}

/** Aggregator view as the live cache would expose it at `now` (completed candles only). */
const liveView = (series, now) => {
  const done = series.filter(c => c.timestamp + MIN <= now)
  const completed = (interval) => aggregate(done, interval).filter(c => c.timestamp + interval <= now)
  const view = {
    '1m': done.slice(-180),
    '15m': completed(15 * MIN).slice(-180),
    '1d': completed(DAY),
  }
  return { getCandles: (tf) => view[tf] || [] }
}

const bar = (over = {}) => ({
  timestamp: D0 + DAY + 60 * MIN, high: 98_600, low: 98_500, close: 98_550,
  priorLow: 99_990, windowHigh: 100_010, dailyRefClose: 100_000, rsi: 20, ...over,
})

describe('flush-reversal setup state machine', () => {
  it('arms only on a fresh 24h low that is deep, below the prior daily close and oversold', () => {
    const idle = createFlushSetupState()
    assert.equal(stepFlushSetup(idle, bar()).event, 'armed')
    // Each condition alone blocks arming.
    for (const over of [
      { priorLow: 98_400 }, // not a fresh 24h low
      { windowHigh: 99_000 }, // only a ~0.5% drop
      { dailyRefClose: 98_600 }, // day is not red enough
      { rsi: 50 }, // not oversold
    ]) {
      assert.equal(stepFlushSetup(idle, bar(over)).event, null, JSON.stringify(over))
    }
  })

  it('fails closed while any feature is unavailable', () => {
    for (const key of ['priorLow', 'windowHigh', 'dailyRefClose', 'rsi']) {
      const { state, event } = stepFlushSetup(createFlushSetupState(), bar({ [key]: null }))
      assert.equal(event, null, key)
      assert.equal(state.phase, 'idle', key)
    }
  })

  it('enters on the bounce off the trailing low, then exits at target, stop or timeout', () => {
    const armed = stepFlushSetup(createFlushSetupState(), bar()).state
    // A deeper low while armed trails the flush low down; no bounce yet.
    const deeper = stepFlushSetup(armed, bar({ timestamp: armed.armedAt + MIN, low: 98_400, close: 98_420, rsi: 40, priorLow: 98_400 }))
    assert.equal(deeper.state.flushLow, 98_400)
    assert.equal(deeper.event, null)
    const entered = stepFlushSetup(deeper.state, bar({ timestamp: armed.armedAt + 2 * MIN, low: 98_450, close: 98_600, rsi: 45, priorLow: 98_400 }))
    assert.equal(entered.event, 'entered')
    assert.equal(entered.state.entryPrice, 98_600)
    assert.equal(entered.state.targetPrice, 99_586)
    assert.equal(entered.state.stopPrice, 97_614)

    const at = (m, over) => stepFlushSetup(entered.state, bar({ timestamp: entered.state.enteredAt + m * MIN, ...over }))
    assert.equal(at(5, { high: 99_600, low: 98_700 }).state.lastExit.reason, 'target')
    // A bar spanning both levels is scored as the stop (adverse side first).
    assert.equal(at(5, { high: 99_600, low: 97_600 }).state.lastExit.reason, 'stop')
    const timedOut = at(FLUSH_SETUP_PARAMS.maxHoldMin - 1, { high: 98_700, low: 98_500, close: 98_650 })
    assert.equal(timedOut.state.lastExit.reason, 'timeout')
    assert.equal(timedOut.state.phase, 'idle')
  })

  it('drops an unconfirmed arm after the arm window and honours the entry cooldown', () => {
    const armed = stepFlushSetup(createFlushSetupState(), bar()).state
    const stale = stepFlushSetup(armed, bar({ timestamp: armed.armedAt + (FLUSH_SETUP_PARAMS.armWindowMin + 1) * MIN, close: 99_000, rsi: 50 }))
    assert.equal(stale.state.phase, 'idle')

    const recent = { ...armed, lastEntryAt: armed.armedAt }
    const blocked = stepFlushSetup(recent, bar({ timestamp: armed.armedAt + MIN, close: 99_000, rsi: 50 }))
    assert.equal(blocked.event, null)
    assert.equal(blocked.state.phase, 'armed')
  })
})

describe('flush-reversal live tracker', () => {
  it('matches the offline replay entry and exit minute for minute', () => {
    const series = buildSeries()
    const replay = replayFlushSetup(series)
    assert.equal(replay.entries.length, 1)
    assert.equal(replay.entries[0].exit.reason, 'target')

    const tracker = createFlushSetupTracker()
    const events = []
    // Start early enough that the tracker sees the whole flush in its 3h buffer.
    for (let now = D0 + 25 * 60 * MIN - 90 * MIN; now <= series.at(-1).timestamp + MIN; now += MIN) {
      const { state, events: ev } = tracker.update(liveView(series, now))
      for (const e of ev) events.push({ e, state: { ...state } })
    }
    const entered = events.find(x => x.e === 'entered').state
    const exited = events.find(x => x.e === 'exited').state
    assert.equal(entered.enteredAt, replay.entries[0].enteredAt)
    assert.equal(entered.entryPrice, replay.entries[0].entryPrice)
    assert.deepEqual(exited.lastExit, replay.entries[0].exit)
  })

  it('never arms on a green day even when the 1m chart flushes', () => {
    // Prior day closes at 100k; today gaps up to 103k and flushes 1.5% to ~101.5k.
    const series = buildSeries().map(c => c.timestamp >= D0 + DAY
      ? { ...c, open: c.open + 3_000, high: c.high + 3_000, low: c.low + 3_000, close: c.close + 3_000 }
      : c)
    assert.equal(replayFlushSetup(series).entries.length, 0)
  })
})

describe('signal engine publishes the flush setup', () => {
  it('prints BUY for an active setup the composite would not, then closes on its exit', () => {
    const series = buildSeries()
    const { enteredAt, exit } = replayFlushSetup(series).entries[0]
    let now = D0 + 25 * 60 * MIN - 90 * MIN
    const view = { getCandles: (tf) => liveView(series, now).getCandles(tf) }
    const engine = createSignalEngine(view, { now: () => now })
    const types = new Map()
    for (; now <= exit.at; now += MIN) {
      const result = engine.computeSignals(null, null)
      types.set(now, result)
    }
    const atEntry = types.get(enteredAt)
    assert.equal(atEntry.type, 'BUY')
    assert.equal(atEntry.source, 'flush-setup')
    // The composite gate is closed (no 15m/1h tape to speak of) — the setup is what opened it.
    assert.equal(atEntry.trendGate.open, false)
    const atExit = types.get(exit.at)
    assert.equal(atExit.type, 'NEUTRAL')
    assert.equal(atExit.flushSetup.lastExit.reason, 'target')
    assert.deepEqual(engine.getFlushSetupState().lastExit, exit)
  })

  it('does not open a setup BUY inside a live contract no-trade zone', () => {
    const series = buildSeries()
    const { enteredAt } = replayFlushSetup(series).entries[0]
    let now = D0 + 25 * 60 * MIN - 90 * MIN
    const view = { getCandles: (tf) => liveView(series, now).getCandles(tf) }
    const engine = createSignalEngine(view, { now: () => now })
    let atEntry
    for (; now <= enteredAt; now += MIN) atEntry = engine.computeSignals(enteredAt + 60 * MIN, null)
    assert.equal(atEntry.flushSetup.phase, 'active')
    assert.equal(atEntry.type, 'NO_TRADE_ZONE')
  })
})
