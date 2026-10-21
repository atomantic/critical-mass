// @ts-check
/**
 * Exchange WebSocket frame-handler containment (issue #1380)
 *
 * A throw out of a feed's frame handler (malformed exchange frame, or a bug in
 * a consumer callback) used to surface as an uncaughtException, which
 * process-guard turns into an engine exit for every fund on the exchange.
 * Market-data frames are now dropped (with a rate-limited error log); user
 * frames (fills/cancels) terminate the socket so the reconnect path runs and
 * gap recovery re-reads order state.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

const { createWebSocketFeed } = require('../src/websocket-feed');

/** Capture and silence console output while `fn` runs. */
const captureLogs = (fn) => {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (line) => lines.push(String(line));
  try { fn(); } finally { Object.assign(console, original); }
  return lines;
};

const openFeed = (t, exchange, callbacks = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  FakeWebSocket.reset();
  const events = { disconnects: 0 };
  const feed = createWebSocketFeed(exchange, {
    productId: 'BTC-USD',
    publicOnly: true,
    onDisconnect: () => { events.disconnects++; },
    ...callbacks,
  });
  feed.connect();
  const sock = FakeWebSocket.instances[0];
  sock.open();
  if (exchange === 'cryptocom') t.mock.timers.tick(1000); // post-connect subscribe delay
  return { feed, sock, events };
};

const MALFORMED = {
  cryptocom: [
    { result: { channel: 'ticker.BTC_USD', data: { a: '1' } } }, // non-array data
    { result: { channel: 'ticker.BTC_USD', data: [null, 7, { a: '100', b: '99', k: '101' }] } },
    { result: { channel: 'trade.BTC_USD', data: [null, 'x'] } },
  ],
  gemini: [
    { type: 'l2_updates', changes: [null, 5, ['buy', '99', '1']] }, // null entry in changes
    { type: 'l2_updates', changes: { not: 'an array' }, trades: 'nope' },
    { type: 'l2_updates', changes: [], trades: [null, 3] },
    { type: 'trade', price: '100', quantity: '1', side: null },
  ],
  coinbase: [
    { channel: 'ticker', events: [null, { type: 'update', tickers: [null, 'x'] }] }, // null event
    { channel: 'ticker', events: { not: 'an array' } },
    { channel: 'market_trades', events: [null, { type: 'update', trades: [null, { product_id: 'BTC-USD', side: 5 }] }] },
    { channel: 'user', events: [null, { type: 'update', orders: [null, { product_id: 'BTC-USD', side: 7 }] }] },
  ],
};

for (const exchange of ['cryptocom', 'gemini', 'coinbase']) {
  describe(`${exchange} malformed frames`, () => {
    it('are tolerated without a throw escaping, and the feed stays connected', (t) => {
      const { feed, sock, events } = openFeed(t, exchange, {
        onTicker: () => {}, onTrade: () => {}, onOrderUpdate: () => {},
      });
      for (const frame of MALFORMED[exchange]) sock.receive(JSON.stringify(frame));
      assert.equal(sock.closeCalls.length, 0, 'no reconnect for a merely malformed frame');
      assert.equal(events.disconnects, 0);
      assert.equal(feed.isActive(), true);
      feed.disconnect();
    });
  });
}

describe('market-data callback that throws', () => {
  const FRAMES = {
    cryptocom: JSON.stringify({ result: { channel: 'trade.BTC_USD', data: [{ d: 1, p: '1', q: '1', s: 'BUY' }] } }),
    gemini: JSON.stringify({ type: 'trade', tid: 1, price: '100', quantity: '1', side: 'buy' }),
    coinbase: JSON.stringify({ channel: 'market_trades', events: [{ type: 'update', trades: [{ product_id: 'BTC-USD', trade_id: '1', price: '1', size: '1', side: 'BUY', time: '2026-01-01T00:00:00Z' }] }] }),
  };

  for (const exchange of Object.keys(FRAMES)) {
    it(`${exchange}: drops the frame, stays connected, logs once per interval per channel`, (t) => {
      let calls = 0;
      const { feed, sock, events } = openFeed(t, exchange, { onTrade: () => { calls++; throw new Error('consumer bug'); } });
      const lines = captureLogs(() => {
        for (let i = 0; i < 5; i++) sock.receive(FRAMES[exchange]);
        assert.equal(calls, 5, 'every frame still reaches the consumer');
        t.mock.timers.tick(60000);
        sock.receive(FRAMES[exchange]);
      });
      assert.equal(sock.closeCalls.length, 0);
      assert.equal(events.disconnects, 0);
      assert.equal(feed.isActive(), true);
      const errorLines = lines.filter(line => line.includes('frame handler threw'));
      assert.equal(errorLines.length, 2, 'one log per interval, not per frame');
      assert.match(errorLines[0], new RegExp(`\\[${exchange}\\]`));
      assert.match(errorLines[0], /consumer bug/);
      const context = JSON.parse(errorLines[1].slice(errorLines[1].lastIndexOf(' {') + 1));
      assert.equal(context.suppressedSinceLastLog, 4);
      assert.equal(context.failSafe, false);
      feed.disconnect();
    });
  }
});

describe('coinbase user frames are fail-safe', () => {
  const FILL = JSON.stringify({
    channel: 'user',
    events: [{ type: 'update', orders: [{ order_id: 'o1', product_id: 'BTC-USD', side: 'SELL', status: 'FILLED' }] }],
  });

  it('a throwing onOrderUpdate terminates the socket and reconnects instead of throwing', (t) => {
    let delivered = 0;
    const { feed, sock, events } = openFeed(t, 'coinbase', { onOrderUpdate: () => { delivered++; throw new Error('order consumer bug'); } });
    const lines = captureLogs(() => sock.receive(FILL));
    assert.equal(delivered, 1);
    assert.equal(sock.closeCalls.length, 1, 'socket terminated');
    assert.equal(events.disconnects, 1);
    assert.ok(lines.some(line => line.includes('terminating socket to reconnect')));

    t.mock.timers.tick(1000);
    assert.equal(FakeWebSocket.instances.length, 2, 'normal reconnect path runs');
    const replacement = FakeWebSocket.instances[1];
    replacement.open();
    assert.ok(replacement.frames.some(frame => frame.channel === 'ticker'), 're-subscribes on the new socket');

    // The poisoned frame must not reset the backoff: the next failure waits 2s.
    captureLogs(() => replacement.receive(FILL));
    t.mock.timers.tick(1999);
    assert.equal(FakeWebSocket.instances.length, 2);
    t.mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 3);
    feed.disconnect();
  });

  it('every failing user frame logs, even inside the market-data rate-limit window', (t) => {
    const { feed, sock } = openFeed(t, 'coinbase', { onOrderUpdate: () => { throw new Error('boom'); } });
    const lines = captureLogs(() => {
      sock.receive(FILL);
      t.mock.timers.tick(1000);
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].receive(FILL);
    });
    assert.equal(lines.filter(line => line.includes('terminating socket to reconnect')).length, 2);
    feed.disconnect();
  });

  it('a delivered order update does not disturb the connection', (t) => {
    const updates = [];
    const { feed, sock } = openFeed(t, 'coinbase', { onOrderUpdate: update => updates.push(update) });
    sock.receive(FILL);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].orderId, 'o1');
    assert.equal(sock.closeCalls.length, 0);
    feed.disconnect();
  });
});
