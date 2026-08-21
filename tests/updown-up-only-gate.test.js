// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeTrendGate,
  applyUpOnlyGate,
  resolveActionLabel,
  scoreRSI,
  createSignalEngine,
} = require('../src/updown/signal-engine');

describe('computeTrendGate (UP-only long gate)', () => {
  const tf = (macd, obv) => ({ scores: { macd, obv } });

  it('opens when EMA is not bearish and 15m/1h MACD+OBV are not bearish', () => {
    const gate = computeTrendGate(
      { trendBias: 'bullish' },
      { '15m': tf(50, 40), '1h': tf(40, 50) },
    );
    assert.equal(gate.open, true);
  });

  it('opens on a neutral EMA when MACD+OBV are not clearly bearish', () => {
    const gate = computeTrendGate(
      { trendBias: 'neutral' },
      { '15m': tf(0, 0), '1h': tf(5, -5) },
    );
    assert.equal(gate.open, true);
  });

  it('closes when the 1h EMA trend is bearish', () => {
    const gate = computeTrendGate(
      { trendBias: 'bearish' },
      { '15m': tf(50, 50), '1h': tf(50, 50) },
    );
    assert.equal(gate.open, false);
    assert.equal(gate.reason, 'ema-bearish');
  });

  it('closes when 15m/1h MACD+OBV average is below -10 even if EMA is bullish', () => {
    const gate = computeTrendGate(
      { trendBias: 'bullish' },
      { '15m': tf(-40, -30), '1h': tf(-20, -20) },
    );
    assert.equal(gate.open, false);
    assert.equal(gate.reason, 'macd-obv-bearish');
  });
});

describe('applyUpOnlyGate', () => {
  it('passes BUY/STRONG_BUY through when the trend gate is open', () => {
    assert.equal(applyUpOnlyGate('BUY', true), 'BUY');
    assert.equal(applyUpOnlyGate('STRONG_BUY', true), 'STRONG_BUY');
  });

  it('caps BUY/STRONG_BUY at NEUTRAL when the trend gate is closed', () => {
    assert.equal(applyUpOnlyGate('BUY', false), 'NEUTRAL');
    assert.equal(applyUpOnlyGate('STRONG_BUY', false), 'NEUTRAL');
  });

  it('leaves SELL/STRONG_SELL intact so a held long can still EXIT', () => {
    assert.equal(applyUpOnlyGate('SELL', false), 'SELL');
    assert.equal(applyUpOnlyGate('STRONG_SELL', false), 'STRONG_SELL');
    assert.equal(applyUpOnlyGate('NEUTRAL', false), 'NEUTRAL');
  });

  it('does not swallow a BUY that is the exit for a held DOWN position when the gate is closed', () => {
    assert.equal(applyUpOnlyGate('BUY', false, { direction: 'down' }), 'BUY');
    assert.equal(applyUpOnlyGate('STRONG_BUY', false, { direction: 'down' }), 'STRONG_BUY');
  });
});

describe('resolveActionLabel (UP-only display)', () => {
  it('labels BUY as BUY UP, never BUY DOWN', () => {
    assert.equal(resolveActionLabel('BUY'), 'BUY UP');
    assert.equal(resolveActionLabel('STRONG_BUY'), 'STRONG BUY UP');
  });

  it('labels SELL as EXIT when a long is held', () => {
    assert.equal(resolveActionLabel('SELL', { direction: 'up' }), 'EXIT');
    assert.equal(resolveActionLabel('STRONG_SELL', { direction: 'up' }), 'EXIT');
  });

  it('labels SELL as STAND ASIDE when flat (no short / no BUY DOWN)', () => {
    assert.equal(resolveActionLabel('SELL', null), 'STAND ASIDE');
    assert.equal(resolveActionLabel('STRONG_SELL', undefined), 'STAND ASIDE');
    assert.equal(resolveActionLabel('SELL', { direction: 'down' }), 'STAND ASIDE');
  });

  it('keeps HOLD / NO TRADE for non-directional types', () => {
    assert.equal(resolveActionLabel('NEUTRAL'), 'HOLD');
    assert.equal(resolveActionLabel('NO_TRADE_ZONE'), 'NO TRADE');
  });
});

describe('short timeframes inherit the higher-TF trend bias', () => {
  it('overbought RSI on 1m scores as trend confirmation, not a fade, when 1h EMA is bullish', () => {
    // Neutral mean-reversion would score RSI 75 as -80 (sell the rip).
    // Bullish trend-aware scoring scores it +30 (confirmation).
    assert.equal(scoreRSI(75, 'neutral'), -80);
    assert.equal(scoreRSI(75, 'bullish'), 30);

    const makeCandles = (n, start, step, tfMs) => {
      const out = [];
      let p = start;
      for (let i = 0; i < n; i++) {
        p += step;
        out.push({ open: p, high: p + 1, low: p - 1, close: p, volume: 10, timestamp: i * tfMs });
      }
      return out;
    };

    // 220 steadily-rising 1h candles → EMA50 > EMA200 → bullish trendFilter.
    const hourly = makeCandles(220, 50_000, 50, 3_600_000);
    // 40 steadily-rising 1m candles → RSI well above 70 (overbought).
    const minute = makeCandles(40, 60_000, 80, 60_000);

    const engine = createSignalEngine({
      getCandles: (tf) => {
        if (tf === '1h') return hourly;
        if (tf === '1m') return minute;
        return [];
      },
    });
    const result = engine.computeSignals();

    assert.equal(result.trendFilter.trendBias, 'bullish');
    assert.equal(
      result.timeframes['1m'].scores.rsi,
      30,
      '1m RSI must inherit bullish bias so overbought is confirmation, not a short',
    );
    assert.equal(result.trendGate.open, true);
  });
});
