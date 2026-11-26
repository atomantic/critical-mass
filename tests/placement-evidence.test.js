// @ts-check
// Settling a stuck placement intent from exchange open orders and fill history,
// for intents with no client order id or whose id lookup came back empty.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findPlacementOnExchange, MIN_INTENT_AGE_MS } = require('../src/placement-evidence');

const DISPATCHED_AT = Date.parse('2026-10-20T03:46:30.811Z');
const NOW = DISPATCHED_AT + 12 * 60 * 60_000;
const iso = (offsetMs) => new Date(DISPATCHED_AT + offsetMs).toISOString();

const intent = (extra = {}) => ({
  id: 'intent-1', action: 'entry_bid', side: 'buy', price: 2402.64, size: 0.01329371, createdAt: DISPATCHED_AT, ...extra,
});

const openOrder = (extra = {}) => ({
  orderId: 'open-1', side: 'BUY', price: 2402.64, size: 0.013293, originalSize: 0.013293, filledSize: 0, createdTime: iso(400), ...extra,
});

const fill = (extra = {}) => ({
  tradeId: 't-1', orderId: 'filled-1', side: 'buy', price: 2402.64, size: 0.013293, timestamp: DISPATCHED_AT + 60_000, ...extra,
});

// An unrelated trade at the read boundary shows the history has caught up.
const recentUnrelatedFill = () => fill({ tradeId: 'other-trade', orderId: 'other-order', side: 'sell', timestamp: NOW });

/** Adapter whose open orders, fills and order statuses are fixed. */
const makeAdapter = ({ openOrders = [], fills = [recentUnrelatedFill()], orders = {} } = {}) => {
  const calls = { getOrder: 0 };
  return {
    calls,
    getOpenOrders: async () => openOrders,
    getReconciliationFills: async () => fills,
    getOrder: async (orderId) => {
      calls.getOrder += 1;
      return orders[orderId] ?? { orderId, side: 'BUY', status: 'FILLED', filledSize: 0.013293, completionPercentage: 100, createdTime: iso(400) };
    },
  };
};

const search = (adapter, extra = {}) => findPlacementOnExchange({
  adapter, productId: 'ETHUSD', intent: intent(), isKnownOrder: () => false, isKnownTrade: () => false, now: NOW, clock: () => NOW, ...extra,
});

describe('findPlacementOnExchange', () => {
  it('reports absent when nothing on the exchange could be the placement', async () => {
    assert.deepEqual(await search(makeAdapter()), { verdict: 'absent' });
  });

  it('matches a resting order with the same side, price and rounded size created at dispatch', async () => {
    const result = await search(makeAdapter({ openOrders: [openOrder()], orders: { 'open-1': { orderId: 'open-1', status: 'OPEN', filledSize: 0 } } }));
    assert.equal(result.verdict, 'match');
    assert.equal(result.verdict === 'match' && result.order.orderId, 'open-1');
  });

  it('ignores resting orders that differ in price, size, side or creation time, or that the fund owns', async () => {
    const openOrders = [
      openOrder({ orderId: 'price', price: 2400 }),
      openOrder({ orderId: 'size', originalSize: 0.02 }),
      openOrder({ orderId: 'side', side: 'SELL' }),
      openOrder({ orderId: 'later', createdTime: iso(10 * 60_000) }),
      openOrder({ orderId: 'owned' }),
    ];
    const result = await search(makeAdapter({ openOrders }), { isKnownOrder: (id) => id === 'owned' });
    assert.deepEqual(result, { verdict: 'absent' });
  });

  it('matches an untracked filled order created at dispatch', async () => {
    const result = await search(makeAdapter({ fills: [fill()] }));
    assert.equal(result.verdict, 'match');
    assert.equal(result.verdict === 'match' && result.order.orderId, 'filled-1');
  });

  it('ignores fills already in the ledger, from orders created elsewhen, or outside the limit', async () => {
    const adapter = makeAdapter({
      fills: [
        fill({ tradeId: 'booked', orderId: 'booked-order', timestamp: NOW }),
        fill({ tradeId: 't-old', orderId: 'old-order' }),
        fill({ tradeId: 't-high', orderId: 'above-limit', price: 2410 }),
        fill({ tradeId: 't-big', orderId: 'too-big', size: 0.5 }),
      ],
      orders: { 'old-order': { orderId: 'old-order', side: 'BUY', status: 'FILLED', createdTime: iso(-60 * 60_000) } },
    });
    const result = await search(adapter, { isKnownTrade: (tradeId) => tradeId === 'booked' });
    assert.deepEqual(result, { verdict: 'absent' });
    assert.equal(adapter.calls.getOrder, 1, 'only the plausible fill order is looked up');
  });

  it('ignores a smaller unrelated order that filled at dispatch time', async () => {
    const adapter = makeAdapter({
      fills: [fill({ size: 0.001, timestamp: NOW })],
      orders: { 'filled-1': { orderId: 'filled-1', side: 'BUY', status: 'FILLED', filledSize: 0.001, completionPercentage: 100, createdTime: iso(400) } },
    });
    assert.deepEqual(await search(adapter), { verdict: 'absent' });
  });

  it('matches a partly filled, cancelled order by its derived requested size', async () => {
    const adapter = makeAdapter({
      fills: [fill({ size: 0.0066465 })],
      orders: { 'filled-1': { orderId: 'filled-1', side: 'BUY', status: 'CANCELLED', filledSize: 0.0066465, completionPercentage: 50, createdTime: iso(400) } },
    });
    const result = await search(adapter);
    assert.equal(result.verdict, 'match');
  });

  it('stays inconclusive when a dispatch-time order reports no size to compare', async () => {
    const adapter = makeAdapter({
      fills: [fill()],
      orders: { 'filled-1': { orderId: 'filled-1', side: 'BUY', status: 'FILLED', filledSize: 0.013293, completionPercentage: 0, createdTime: iso(400) } },
    });
    assert.equal((await search(adapter)).verdict, 'inconclusive');
  });

  it('stays inconclusive when the fill history may be incomplete', async () => {
    const fills = Object.defineProperty([recentUnrelatedFill()], 'incomplete', { value: true });
    assert.equal((await search(makeAdapter({ fills }))).verdict, 'inconclusive');
  });

  it('stays inconclusive when more than one untracked order matches', async () => {
    const result = await search(makeAdapter({ openOrders: [openOrder(), openOrder({ orderId: 'open-2' })] }));
    assert.equal(result.verdict, 'inconclusive');
  });

  it('stays inconclusive while the dispatch could still be landing', async () => {
    const result = await search(makeAdapter(), { now: DISPATCHED_AT + MIN_INTENT_AGE_MS - 1 });
    assert.equal(result.verdict, 'inconclusive');
  });

  it('stays inconclusive when the adapter cannot list open orders and fills', async () => {
    const result = await search({ getOrder: async () => null });
    assert.equal(result.verdict, 'inconclusive');
  });

  it('stays inconclusive when the open-order list may be incomplete', async () => {
    const openOrders = Object.defineProperty([], 'incomplete', { value: true });
    assert.equal((await search(makeAdapter({ openOrders }))).verdict, 'inconclusive');
  });

  describe('exchange-rounded placements', () => {
    // A coarse-tick product: the adapter floors 0.1234567 @ 1e-5 to 0.12345
    // (a 5.6e-5 relative move, far past the 1e-6 price tolerance) and
    // 512.6 @ qty tick 1 to 512 (0.12%, past the 0.1% size tolerance).
    const coarse = { baseIncrement: '1', quoteIncrement: '0.00001' };
    const croIntent = intent({ side: 'sell', price: 0.1234567, size: 512.6 });
    const withIncrements = (adapter, details = coarse) => ({ ...adapter, getProductDetails: async () => details });
    const searchCro = (adapter) => search(adapter, { intent: croIntent });

    it('matches a resting order at the floored price and size', async () => {
      const resting = openOrder({ orderId: 'floored', side: 'SELL', price: 0.12345, size: 512, originalSize: 512 });
      const result = await searchCro(withIncrements(makeAdapter({ openOrders: [resting], orders: { floored: { orderId: 'floored', status: 'OPEN', filledSize: 0 } } })));
      assert.equal(result.verdict, 'match');
      assert.equal(result.verdict === 'match' && result.order.orderId, 'floored');
    });

    it('matches an untracked sell that filled at the floored limit', async () => {
      const fills = [fill({ orderId: 'sold', side: 'sell', price: 0.12345, size: 512 })];
      const orders = { sold: { orderId: 'sold', side: 'SELL', status: 'FILLED', filledSize: 512, completionPercentage: 100, createdTime: iso(400) } };
      const result = await searchCro(withIncrements(makeAdapter({ fills, orders })));
      assert.equal(result.verdict, 'match');
    });

    it('stays inconclusive when the product increments cannot be read', async () => {
      const adapter = { ...makeAdapter(), getProductDetails: async () => { throw new Error('503'); } };
      assert.equal((await searchCro(adapter)).verdict, 'inconclusive');
    });
  });

  describe('an order that fills between the open-order and fill reads', () => {
    /**
     * A simulated exchange on a stepping clock. The placement rested until just
     * before the first open-order read and is gone from every listing after
     * that. The fill history only shows the fill on a later call.
     */
    const makeRacingExchange = ({ restingOnRead = [], historyLagCalls = 1 } = {}) => {
      let tick = DISPATCHED_AT + 3 * 60 * 60_000;
      const clock = () => tick;
      const calls = /** @type {string[]} */ ([]);
      const filledAt = tick;
      let openReads = 0;
      let fillReads = 0;
      const adapter = {
        getOpenOrders: async () => {
          tick += 1_000;
          calls.push('open');
          openReads += 1;
          return restingOnRead[openReads - 1] ? [openOrder({ orderId: 'raced' })] : [];
        },
        getReconciliationFills: async () => {
          tick += 1_000;
          calls.push('fills');
          fillReads += 1;
          if (fillReads <= historyLagCalls) return [];
          return [fill({ orderId: 'raced', timestamp: filledAt }), { ...recentUnrelatedFill(), timestamp: tick }];
        },
        getOrder: async (orderId) => ({ orderId, side: 'BUY', status: 'FILLED', filledSize: 0.013293, completionPercentage: 100, createdTime: iso(400) }),
      };
      return { adapter, clock, calls };
    };

    it('stays inconclusive while the fill history lags the first open-order read, then matches once the fill appears', async () => {
      const { adapter, clock, calls } = makeRacingExchange();
      const first = await search(adapter, { clock });
      assert.equal(first.verdict, 'inconclusive');
      assert.match(first.verdict === 'inconclusive' ? first.reason : '', /fill history/);

      const second = await search(adapter, { clock });
      assert.equal(second.verdict, 'match');
      assert.equal(second.verdict === 'match' && second.order.orderId, 'raced');
      assert.equal(second.verdict === 'match' && second.resting, false);
      assert.deepEqual(calls, ['open', 'fills', 'open', 'fills']);
    });

    it('stays inconclusive with an empty, stale or undated history even if the scan requested up to the present', async () => {
      for (const timestamps of [[], [NOW - 1], [NaN, Infinity]]) {
        const fills = timestamps.map(timestamp => fill({ side: 'sell', timestamp }));
        Object.defineProperty(fills, 'coveredThrough', { value: NOW });
        assert.equal((await search(makeAdapter({ fills }))).verdict, 'inconclusive');
      }
    });

    it('respects the scan end even when a returned trade reaches the open-order read', async () => {
      const fills = Object.defineProperty([recentUnrelatedFill()], 'coveredThrough', { value: NOW - 1 });
      assert.equal((await search(makeAdapter({ fills }))).verdict, 'inconclusive');
    });

    it('stays inconclusive when the re-read lists a matching order the first listing missed', async () => {
      const { adapter, clock, calls } = makeRacingExchange({ restingOnRead: [false, true], historyLagCalls: 0 });
      // The history call returns the fill too; isolate the re-read by treating it as booked.
      const result = await search(adapter, { clock, isKnownTrade: () => true });
      assert.equal(result.verdict, 'inconclusive');
      assert.match(result.verdict === 'inconclusive' ? result.reason : '', /raced/);
      assert.deepEqual(calls, ['open', 'fills', 'open']);
    });

    it('stays inconclusive when the re-read open-order list may be incomplete', async () => {
      let reads = 0;
      const adapter = {
        ...makeAdapter(),
        getOpenOrders: async () => (++reads === 1 ? [] : Object.defineProperty([], 'incomplete', { value: true })),
      };
      assert.equal((await search(adapter)).verdict, 'inconclusive');
      assert.equal(reads, 2);
    });

    it('reports absent only after a second open-order read that follows the fills', async () => {
      const calls = /** @type {string[]} */ ([]);
      const adapter = {
        ...makeAdapter(),
        getOpenOrders: async () => { calls.push('open'); return []; },
        getReconciliationFills: async () => { calls.push('fills'); return [recentUnrelatedFill()]; },
      };
      assert.deepEqual(await search(adapter), { verdict: 'absent' });
      assert.deepEqual(calls, ['open', 'fills', 'open']);
    });
  });

  it('stays inconclusive rather than looking up an unbounded number of filled orders', async () => {
    const fills = Array.from({ length: 21 }, (_, i) => fill({ tradeId: `t-${i}`, orderId: `o-${i}`, size: 0.0001 }));
    const adapter = makeAdapter({ fills });
    const result = await search(adapter);
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(adapter.calls.getOrder, 0);
  });
});
