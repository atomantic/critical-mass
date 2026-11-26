// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSignalEngine } = require('../../../src/updown/signal-engine');

const toCandles = (closes) => closes.map((close, i) => ({
  open: close, high: close, low: close, close, volume: 1, timestamp: i * 300_000,
}));

describe('completed-bar indicator scoring', () => {
  it('holds each crossover through 5s live and 60s scorecard polls until the next completed bar', () => {
    const decline = Array.from({ length: 10 }, (_, i) => 100 - 1.5 * (i + 1));
    const bars = toCandles([...Array(30).fill(100), ...decline, 85, 85, 103, 109]);
    // Keep %K oversold as the bullish MACD cross closes. A rising close
    // above the preceding equal lows also crosses the %D line on this bar.
    for (const bar of bars) {
      bar.high = 200;
      bar.low = 85;
    }
    let candles = bars.slice(0, 42);
    let now = Date.UTC(2020, 0, 1);
    const adapter = { getCandles: tf => tf === '5m' ? candles : [] };
    const live = createSignalEngine(adapter, { now: () => now });
    const scorecard = createSignalEngine(adapter, { now: () => now });
    const scores = (engine) => engine.computeSignals().timeframes['5m'].scores;
    scores(live);
    scores(scorecard);

    candles = bars.slice(0, 43);
    const onClose = scores(scorecard);
    assert.equal(onClose.stochastic, 90);
    assert.equal(onClose.macd, 90);
    for (let offset = 0; offset < 300_000; offset += 5_000) {
      if (offset % 60_000 === 0) assert.deepEqual(scores(scorecard), onClose);
      assert.deepEqual(scores(live), onClose);
      now += 5_000;
    }
    candles = bars;
    const next = scores(live);
    assert.notEqual(next.stochastic, 90);
    assert.notEqual(next.macd, 90);
    assert.deepEqual(scores(scorecard), next);
    assert.deepEqual(scores(createSignalEngine(adapter)), next);
  });

  it('holds the MACD continuation floor on repeated reads of a growing histogram', () => {
    const prices = Array.from({ length: 63 }, (_, i) => 100 + i + Math.max(0, i - 60) ** 2);
    const five = toCandles(prices);
    const hour = toCandles(Array.from({ length: 210 }, (_, i) => 100 + i));
    const engine = createSignalEngine({ getCandles: tf => ({ '1h': hour, '5m': five })[tf] ?? [] });
    for (let i = 0; i < 2; i++) {
      const result = engine.computeSignals();
      assert.equal(result.trendFilter.trendBias, 'bullish');
      assert.equal(result.timeframes['5m'].scores.macd, 50);
    }
    const neutral = createSignalEngine({ getCandles: tf => tf === '5m' ? five : [] });
    assert.ok(neutral.computeSignals().timeframes['5m'].scores.macd < 50);
  });

  it('scores a fully warmed zero stochastic and keeps a partial window neutral', () => {
    const bars = toCandles(Array(16).fill(85)).map(c => ({ ...c, high: 90 }));
    let candles = bars.slice(0, -1);
    const engine = createSignalEngine({ getCandles: tf => tf === '5m' ? candles : [] });
    const timeframe = () => engine.computeSignals().timeframes['5m'];
    assert.equal(timeframe().indicators.stochastic, null);
    assert.equal(timeframe().scores.stochastic, 0);
    candles = bars;
    assert.deepEqual(timeframe().indicators.stochastic, { k: 0, d: 0 });
    assert.equal(timeframe().scores.stochastic, 60);
  });

  it('keeps daily SMA context local to engines with different histories and identical last bars', () => {
    const engine = price => {
      const daily = toCandles([...Array(49).fill(price), 100]);
      return createSignalEngine({ getCandles: tf => tf === '1d' ? daily : [] });
    };
    const live = engine(100);
    const replay = engine(200);
    assert.equal(live.computeSignals().dailySMA.sma50, 100);
    assert.equal(replay.computeSignals().dailySMA.sma50, 198);
    assert.equal(live.computeSignals().dailySMA.sma50, 100);
  });
});
