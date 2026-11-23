// @ts-check
/**
 * Every feed's onTrade.side is the TAKER (aggressor) side. Coinbase sends the
 * maker's side, so its feed inverts it; Gemini and Crypto.com already send the
 * taker's. Consumers (trade-window -> tradeImbalance -> regime momentum, the 1s
 * chart) rely on one convention.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

const { createWebSocketFeed } = require('../src/websocket-feed');
const { createTradeWindow } = require('../src/trade-window');

const open = (t, exchange, productId, config = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWebSocket.reset();
  const trades = [];
  const feed = createWebSocketFeed(exchange, { productId, publicOnly: true, onTrade: (trade) => trades.push(trade), ...config });
  feed.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  t.mock.timers.tick(1000);
  t.after(() => feed.disconnect());
  return { socket, trades };
};
const coinbase = (sides, type = 'update') => JSON.stringify({
  channel: 'market_trades',
  events: [{ type, trades: sides.map((side, i) => ({ trade_id: String(i + 1), product_id: 'BTC-USD', price: '100', size: '1', side, time: '2026-11-23T12:00:00Z' })) }],
});

describe('Coinbase trade side', () => {
  for (const type of ['update', 'snapshot']) {
    it(`reports the taker side of a ${type}`, (t) => {
      const { socket, trades } = open(t, 'coinbase', 'BTC-USD');
      socket.receive(coinbase(['BUY', 'SELL', 'buy', 'sell'], type));
      assert.deepEqual(trades.map((trade) => trade.side), ['sell', 'buy', 'sell', 'buy']);
    });
  }

  it('skips a trade whose side is neither', (t) => {
    const { socket, trades } = open(t, 'coinbase', 'BTC-USD');
    socket.receive(coinbase(['UNKNOWN', 'constructor', '__proto__', '', 'BUY']));
    assert.deepEqual(trades.map((trade) => trade.side), ['sell']);
  });

  it('gives aggressive buying a positive imbalance', (t) => {
    const { socket, trades } = open(t, 'coinbase', 'BTC-USD');
    socket.receive(coinbase(['SELL', 'SELL', 'SELL']));
    const window = createTradeWindow(180_000);
    const imbalance = trades.map((trade) => window.add(trade, trade.timestamp)).at(-1);
    assert.equal(imbalance, 1);
  });

  it('leaves the operator\'s own order side alone', (t) => {
    const orders = [];
    const { socket } = open(t, 'coinbase', 'BTC-USD', { onOrderUpdate: (order) => orders.push(order) });
    socket.receive(JSON.stringify({
      channel: 'user',
      events: [{ type: 'update', orders: [{ order_id: 'o1', product_id: 'BTC-USD', order_side: 'BUY', side: 'BUY', status: 'OPEN' }] }],
    }));
    assert.equal(orders.length, 1);
    assert.equal(String(orders[0].side).toLowerCase(), 'buy');
  });
});

describe('feeds that already send the taker side', () => {
  it('Crypto.com is unchanged', (t) => {
    const { socket, trades } = open(t, 'cryptocom', 'BTC-USD');
    socket.receive(JSON.stringify({ result: { channel: 'trade', data: [{ d: 1, p: '1', q: '1', s: 'BUY', t: 1 }, { d: 2, p: '1', q: '1', s: 'SELL', t: 2 }] } }));
    assert.deepEqual(trades.map((trade) => trade.side), ['buy', 'sell']);
  });

  it('Gemini is unchanged, standalone and embedded', (t) => {
    const { socket, trades } = open(t, 'gemini', 'BTCUSD');
    socket.receive(JSON.stringify({ type: 'trade', symbol: 'BTCUSD', tid: 1, price: '100', quantity: '1', side: 'buy' }));
    socket.receive(JSON.stringify({ type: 'l2_updates', symbol: 'BTCUSD', changes: [], trades: [{ tid: 2, price: '100', quantity: '1', side: 'sell' }] }));
    assert.deepEqual(trades.map((trade) => trade.side), ['buy', 'sell']);
  });
});
