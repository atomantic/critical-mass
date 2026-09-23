// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { calculateOBV } = require('../src/updown/indicators');

/** @param {number} close @param {number} volume */
const candle = (close, volume) => ({ close, volume });

// issue #696 — calculateOBV normalized its slope by the average absolute value of the
// cumulative OBV *level* over the lookback window. That level depends on where the
// rolling candle buffer happens to start (and how much trend the now-discarded older
// history contained), not on the recent volume flow the slope is supposed to measure.
// The same last `lookback` candles must always produce the same slope/direction,
// regardless of what came before the buffer's rolling window.
describe('calculateOBV slope is independent of buffer history (issue #696)', () => {
  // Identical tail: 14 candles of steady buying, +10 volume per up-bar.
  const buildTail = () => {
    const tail = [];
    let price = 1000;
    for (let i = 0; i < 14; i++) {
      price += 1;
      tail.push(candle(price, 10));
    }
    return tail;
  };

  it('produces the same slope/direction whether the prior history is balanced or a long uptrend', () => {
    // Prefix A: balanced up/down alternation — cumulative OBV stays low.
    const balancedPrefix = [];
    let p = 900;
    for (let i = 0; i < 166; i++) {
      p += i % 2 === 0 ? 1 : -1;
      balancedPrefix.push(candle(p, 5));
    }

    // Prefix B: 166 consecutive up-bars — cumulative OBV runs up large before the tail.
    const uptrendPrefix = [];
    let p2 = 900;
    for (let i = 0; i < 166; i++) {
      p2 += 1;
      uptrendPrefix.push(candle(p2, 5));
    }

    const tail = buildTail();
    const withBalancedHistory = calculateOBV([...balancedPrefix, ...tail]);
    const withUptrendHistory = calculateOBV([...uptrendPrefix, ...tail]);

    assert.equal(withBalancedHistory.slope, withUptrendHistory.slope);
    assert.equal(withBalancedHistory.direction, withUptrendHistory.direction);
    assert.equal(withBalancedHistory.direction, 'up');
  });

  it('still reflects genuinely different recent volume flow with different slopes', () => {
    // Same prefix, but the tail itself differs: one steadily buying, one flat/choppy.
    const prefix = [];
    let p = 900;
    for (let i = 0; i < 50; i++) {
      p += i % 2 === 0 ? 1 : -1;
      prefix.push(candle(p, 5));
    }

    const buyingTail = buildTail();

    const choppyTail = [];
    let cp = 1000;
    for (let i = 0; i < 14; i++) {
      cp += i % 2 === 0 ? 1 : -1;
      choppyTail.push(candle(cp, 10));
    }

    const buying = calculateOBV([...prefix, ...buyingTail]);
    const choppy = calculateOBV([...prefix, ...choppyTail]);

    assert.notEqual(buying.slope, choppy.slope);
    assert.equal(buying.direction, 'up');
  });
});
