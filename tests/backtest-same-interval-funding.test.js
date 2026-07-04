// @ts-check
/**
 * #213C — within an interval the engine filled sells (at the interval HIGH),
 * credited availableFunds, then bought at the MID in the SAME interval. Since
 * the high may print after the mid, this let proceeds fund a buy before they
 * existed. The fix defers same-interval proceeds until after the buy phase.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runBacktest } = require('../src/backtest-engine');

const candle = (date, { high, low, close }) => ({
  date,
  timestamp: new Date(date).getTime(),
  open: (high + low) / 2,
  high,
  low,
  close,
  highOfDay: high,
  lowOfDay: low,
});

const day = (n) => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

describe('#213C same-interval sell proceeds must not fund a same-interval buy', () => {
  it('defers sell proceeds so the buy in the same interval is skipped for funds', async () => {
    // Fee-free, fixed fund exactly large enough for ONE buy.
    const result = await runBacktest({
      intervalBuyAmount: 100,
      sellMarkupPercent: 10,
      holdbackPercent: 5,
      feePercent: 0,
      rebatePercent: 0,
      intervalType: 'daily',
      fundSize: 100,
    }, [
      // Day 1: flat 100 → buy, funds → 0, TP target 110.
      candle(day(1), { high: 100, low: 100, close: 100 }),
      // Day 2: high 115 fills the TP (~104.5 proceeds); a naive engine would
      // then buy at mid 107.5 with money received later in the same candle.
      candle(day(2), { high: 115, low: 100, close: 100 }),
      // Day 3: flat 100 → proceeds now available → buy.
      candle(day(3), { high: 100, low: 100, close: 100 }),
    ]);

    const at = (d) => result.transactions.filter(t => t.date === d);

    const d2 = at(day(2));
    assert.ok(d2.some(t => t.type === 'SELL_FILLED'), 'day 2 sell should fill');
    assert.ok(d2.some(t => t.type === 'SKIP_NO_FUNDS'), 'day 2 buy should skip — proceeds deferred');
    assert.ok(!d2.some(t => t.type === 'BUY'), 'day 2 must NOT buy with same-interval proceeds');

    assert.ok(at(day(3)).some(t => t.type === 'BUY'), 'day 3 should buy once proceeds are available');
  });
});
