// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSecondBars } = require('../src/btc-feed/second-bars');

const at = (sec, ms = 0) => 1_800_000_000_000 + sec * 1000 + ms;

/** Bars connected during second 0, so second 1 is the first kept. */
const setup = () => {
  let clock = at(0, 500);
  let nextId = 1000;
  const bars = createSecondBars({ now: () => clock });
  bars.markConnected();
  return {
    bars,
    setNow: (t) => { clock = t; },
    /** Add a trade that arrives the moment it happened unless `arrival` says otherwise. */
    add: (timestamp, price, { size = 1, side = 'buy', tradeId = String(nextId++), arrival = Math.max(clock, timestamp) } = {}) => {
      clock = arrival;
      return bars.addTrade({ tradeId, price, size, side, timestamp });
    },
    seconds: () => bars.getBars(3600).map(b => (b.t - at(0)) / 1000),
  };
};

describe('1s bars', () => {
  it('builds OHLCV from taker sides', () => {
    const { bars, add } = setup();
    add(at(1, 100), 100, { size: 1, side: 'buy' });
    add(at(1, 200), 103, { size: 2, side: 'sell' });
    add(at(1, 300), 99, { size: 3, side: 'buy' });
    assert.deepEqual(bars.getBars(3600), [
      { t: at(1), open: 100, high: 103, low: 99, close: 99, buyVolume: 4, sellVolume: 2, trades: 3 },
    ]);
  });

  it('orders by exchange time, not arrival', () => {
    const { bars, add } = setup();
    add(at(1, 800), 105);
    add(at(1, 100), 100);
    const [bar] = bars.getBars(3600);
    assert.equal(bar.open, 100);
    assert.equal(bar.close, 105);
  });

  it('breaks timestamp ties by trade id', () => {
    const { bars, add } = setup();
    add(at(1, 100), 7, { tradeId: '12' });
    add(at(1, 100), 5, { tradeId: '9' });
    const [bar] = bars.getBars(3600);
    assert.equal(bar.open, 5);
    assert.equal(bar.close, 7);
  });

  it('drops a duplicate id', () => {
    const { bars, add } = setup();
    assert.equal(add(at(1), 100, { tradeId: '5' }), 'accepted');
    assert.equal(add(at(1), 100, { tradeId: '5' }), 'duplicate');
    assert.equal(bars.getBars(3600)[0].trades, 1);
  });

  it('drops a trade more than 10s old on arrival', () => {
    const { add } = setup();
    assert.equal(add(at(20), 100, { arrival: at(30) }), 'accepted');
    assert.equal(add(at(20), 100, { arrival: at(30, 1) }), 'late');
  });

  it('drops the connect snapshot and the partial first second', () => {
    const { add } = setup();
    assert.equal(add(at(0, 900), 100), 'pre-connect');
    assert.equal(add(at(1), 100), 'accepted');
  });

  it('drops everything while no connection has been made', () => {
    const bars = createSecondBars({ now: () => at(5) });
    assert.equal(bars.addTrade({ tradeId: '1', price: 1, size: 1, side: 'buy', timestamp: at(5) }), 'pre-connect');
  });

  for (const [name, over] of /** @type {Array<[string, any]>} */ ([
    ['NaN price', { price: NaN }],
    ['zero price', { price: 0 }],
    ['negative price', { price: -1 }],
    ['infinite price', { price: Infinity }],
    ['zero size', { size: 0 }],
    ['NaN size', { size: NaN }],
    ['unknown side', { side: 'x' }],
    ['NaN timestamp', { timestamp: NaN }],
    ['timestamp over 5s ahead', { timestamp: at(1, 5001) }],
    ['missing id', { tradeId: undefined }],
  ])) {
    it(`rejects a malformed trade: ${name}`, () => {
      const { bars, setNow } = setup();
      setNow(at(1));
      assert.equal(bars.addTrade({ tradeId: '1', price: 100, size: 1, side: 'buy', timestamp: at(1), ...over }), 'invalid');
      assert.deepEqual(bars.getBars(3600), []);
      assert.equal(bars.getLastAcceptedAt(), null);
    });
  }

  it('fills empty seconds when trades are at most 5s apart', () => {
    const { bars, add, seconds } = setup();
    add(at(1), 100);
    add(at(6), 110);
    assert.deepEqual(seconds(), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(bars.getBars(3600)[2], { t: at(3), open: 100, high: 100, low: 100, close: 100, buyVolume: 0, sellVolume: 0, trades: 0 });
  });

  it('leaves a gap when trades are more than 5s apart', () => {
    const { add, seconds } = setup();
    add(at(1), 100);
    add(at(6, 1), 110);
    assert.deepEqual(seconds(), [1, 6]);
  });

  it('never fills across a disconnect', () => {
    const { bars, add, setNow, seconds } = setup();
    add(at(1), 100);
    bars.markDisconnected();
    setNow(at(2, 100));
    bars.markConnected();
    add(at(4), 110);
    assert.deepEqual(seconds(), [1, 4]);
  });

  it('does not add flat bars before the next trade arrives', () => {
    const { add, setNow, seconds } = setup();
    add(at(1), 100);
    setNow(at(4));
    assert.deepEqual(seconds(), [1]);
  });

  it('revises flat bars when a late trade lands between them', () => {
    const { bars, add } = setup();
    add(at(1), 100);
    add(at(4), 110);
    add(at(2), 90, { arrival: at(4, 100) });
    assert.equal(bars.getBars(3600).find(b => b.t === at(3))?.close, 90);
  });

  it('drains every revised bar once', () => {
    const { bars, add } = setup();
    add(at(1), 100);
    add(at(4), 110);
    bars.drainChanged();
    add(at(2), 90, { arrival: at(4, 100) });
    assert.deepEqual(bars.drainChanged().map(b => b.t), [at(1), at(2), at(3), at(4)]);
    assert.deepEqual(bars.drainChanged(), []);
  });

  it('limits getBars to the requested seconds', () => {
    const { bars, add } = setup();
    for (let s = 1; s <= 5; s++) add(at(s), 100);
    assert.deepEqual(bars.getBars(2).map(b => b.t), [at(4), at(5)]);
  });

  it('evicts bars after retention and releases their trade ids', () => {
    const { add, seconds } = setup();
    add(at(1), 100, { tradeId: '1' });
    add(at(3601), 110);
    assert.deepEqual(seconds(), [3601]);
    assert.equal(add(at(1), 100, { tradeId: '1' }), 'late');
  });

  it('reports the arrival time of the last accepted trade only', () => {
    const { bars, add } = setup();
    add(at(1), 100, { tradeId: '1', arrival: at(1, 250) });
    add(at(1), 100, { tradeId: '1', arrival: at(2) });
    assert.equal(bars.getLastAcceptedAt(), at(1, 250));
  });
});
