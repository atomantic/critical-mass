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

/** Adapter whose open orders, fills and order statuses are fixed. */
const makeAdapter = ({ openOrders = [], fills = [], orders = {} } = {}) => {
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
  adapter, productId: 'ETHUSD', intent: intent(), isKnownOrder: () => false, isKnownTrade: () => false, now: NOW, ...extra,
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
        fill({ tradeId: 'booked', orderId: 'booked-order' }),
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
      fills: [fill({ size: 0.001 })],
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
    const fills = Object.defineProperty([], 'incomplete', { value: true });
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

  it('stays inconclusive rather than looking up an unbounded number of filled orders', async () => {
    const fills = Array.from({ length: 21 }, (_, i) => fill({ tradeId: `t-${i}`, orderId: `o-${i}`, size: 0.0001 }));
    const adapter = makeAdapter({ fills });
    const result = await search(adapter);
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(adapter.calls.getOrder, 0);
  });
});
