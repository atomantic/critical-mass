// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSignalEngine } = require('../src/updown/signal-engine');

// issue #212C — the scorecard's 60s sampler and the live 5s signal cycle must NOT
// share a signal-engine instance. createSignalEngine mutates a private `prevIndicators`
// closure on every computeSignals() call for stoch/MACD crossover detection; if two
// consumers call computeSignals() on the SAME instance, whichever fires first "consumes"
// a crossover (advances prevIndicators past it) and the other sees already-post-cross
// state, silently losing the +90 MACD crossover bonus a moment later.
//
// Builds a synthetic 5m close series with a clean bearish->bullish MACD crossover
// between two candle snapshots, then drives it through the engine(s).

const closesToCandles = (closes) => closes.map((c, i) => ({
  open: c, high: c, low: c, close: c, volume: 1, timestamp: i * 300_000,
}));

const buildCrossoverCandles = () => {
  const closes = [];
  let price = 100;
  for (let i = 0; i < 30; i++) closes.push(price); // flat warmup
  for (let i = 0; i < 10; i++) { price -= 1.5; closes.push(price); } // decline (macd < signal)
  const beforeCandles = closesToCandles(closes);

  const closes2 = [...closes];
  let p2 = closes2[closes2.length - 1];
  for (let i = 0; i < 3; i++) { p2 += 6; closes2.push(p2); } // sharp rally (macd crosses > signal)
  const afterCandles = closesToCandles(closes2);

  return { beforeCandles, afterCandles };
};

describe('signal-engine crossover state isolation (issue #212C)', () => {
  it('a dedicated engine instance still detects a crossover after another instance already consumed it', () => {
    const { beforeCandles, afterCandles } = buildCrossoverCandles();
    const store = { five: beforeCandles };
    // Only 5m carries real data; every other timeframe returns [] (harmless — computeTimeframeSignals
    // short-circuits to zeros below length 2), keeping the fixture focused on the mechanism under test.
    const makeAdapter = () => ({ getCandles: (tf) => (tf === '5m' ? store.five : []) });

    const engineA = createSignalEngine(makeAdapter()); // stands in for the live 5s cycle
    const engineB = createSignalEngine(makeAdapter()); // stands in for the scorecard's 60s sampler

    // Seed both engines with identical pre-cross baseline state.
    engineA.computeSignals();
    engineB.computeSignals();

    // Advance to the post-cross candle snapshot. The sampler (B) fires first.
    store.five = afterCandles;
    const resultB = engineB.computeSignals();
    const resultA = engineA.computeSignals();

    // Both engines independently observe the bullish MACD crossover (+90) because each
    // has its own prevIndicators memory — this is the fix.
    assert.equal(resultB.timeframes['5m'].scores.macd, 90, 'sampler engine detects the crossover');
    assert.equal(resultA.timeframes['5m'].scores.macd, 90, 'live-cycle engine independently detects the same crossover');
  });

  it('demonstrates the bug: a SHARED engine instance loses the crossover for whichever consumer computes second', () => {
    const { beforeCandles, afterCandles } = buildCrossoverCandles();
    const store = { five: beforeCandles };
    const shared = createSignalEngine({ getCandles: (tf) => (tf === '5m' ? store.five : []) });

    shared.computeSignals(); // baseline

    store.five = afterCandles;
    const samplerResult = shared.computeSignals(); // "sampler" fires first, consumes the cross
    const liveResult = shared.computeSignals();     // "live cycle" fires moments later, same candles

    assert.equal(samplerResult.timeframes['5m'].scores.macd, 90, 'first caller sees the crossover bonus');
    assert.notEqual(liveResult.timeframes['5m'].scores.macd, 90, 'second caller on the SAME engine misses the crossover bonus (the bug)');
  });
});
