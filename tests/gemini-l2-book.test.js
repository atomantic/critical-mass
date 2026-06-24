// @ts-check
/**
 * Gemini L2 best bid/ask book tests (issue #144)
 *
 * handleL2Updates used to update bestBid only when p > bestBid and bestAsk
 * only when p < bestAsk, ignoring qty=0 removals at the current best. Over a
 * session this ratcheted bestBid to the running high and bestAsk to the
 * running low, producing an inverted/crossed book that fed stale, too-high
 * bids into Gemini entry-order pricing.
 *
 * The fix maintains a real L2 book (price -> qty per side), applies qty=0 as a
 * deletion, and recomputes bestBid = max(bids) / bestAsk = min(asks) after
 * each update. These tests drive the feed through its public interface using
 * the same injected-fake-`ws` pattern as websocket-feed.test.js and assert on
 * the emitted ticker bid/ask.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }
  ping() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
  terminate() { this.readyState = FakeWebSocket.CLOSED; this.emit('close', 1006, Buffer.from('')); }
}

// Inject the fake 'ws' module before loading the feed so it picks it up.
const wsPath = require.resolve('ws');
require.cache[wsPath] = /** @type {any} */ ({
  id: wsPath, filename: wsPath, path: wsPath, loaded: true, exports: FakeWebSocket, children: [],
});
delete require.cache[require.resolve('../src/adapters/gemini/websocket')];
const { createGeminiWebSocketFeed } = require('../src/adapters/gemini/websocket');

/**
 * Create + open a feed, returning the socket and a getter for the latest
 * ticker. Mock timers are enabled so the heartbeat interval never fires real
 * timers (otherwise the feed leaks a 30s interval and hangs the test process).
 * @param {import('node:test').TestContext} t
 */
const openFeed = (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWebSocket.instances = [];
  let lastTicker = null;
  const feed = createGeminiWebSocketFeed('gemini', {
    productId: 'BTC-USD',
    publicOnly: true,
    onTicker: (tk) => { lastTicker = tk; },
  });
  feed.connect();
  const sock = FakeWebSocket.instances[0];
  sock.emit('open');
  return { feed, sock, ticker: () => lastTicker };
};

/** Emit an l2_updates message with the given [side, price, qty] changes. */
const l2 = (sock, changes) =>
  sock.emit('message', Buffer.from(JSON.stringify({ type: 'l2_updates', symbol: 'BTCUSD', changes })));

describe('Gemini L2 best bid/ask book (issue #144)', () => {
  it('drops best bid to the next level when the top bid is removed (qty=0)', (t) => {
    const { sock, ticker } = openFeed(t);

    // Snapshot: bids 100/99/98, asks 101/102/103
    l2(sock, [
      ['buy', '100', '1'], ['buy', '99', '1'], ['buy', '98', '1'],
      ['sell', '101', '1'], ['sell', '102', '1'], ['sell', '103', '1'],
    ]);
    assert.equal(ticker().bid, 100);
    assert.equal(ticker().ask, 101);

    // Top bid (100) is consumed/removed → best bid must fall to 99, not stick.
    l2(sock, [['buy', '100', '0']]);
    assert.equal(ticker().bid, 99, 'best bid must recompute to the next level after removal');
    assert.equal(ticker().ask, 101);
    assert.ok(ticker().bid < ticker().ask, 'book must not be crossed');
  });

  it('raises best ask to the next level when the top ask is removed (qty=0)', (t) => {
    const { sock, ticker } = openFeed(t);

    l2(sock, [
      ['buy', '100', '1'], ['buy', '99', '1'],
      ['sell', '101', '1'], ['sell', '102', '1'],
    ]);
    assert.equal(ticker().ask, 101);

    // Best ask (101) removed → best ask rises to 102.
    l2(sock, [['sell', '101', '0']]);
    assert.equal(ticker().ask, 102, 'best ask must recompute to the next level after removal');
    assert.equal(ticker().bid, 100);
    assert.ok(ticker().bid < ticker().ask, 'book must not be crossed');
  });

  it('does not ratchet: a lower bid then higher bid both reflect reality', (t) => {
    const { sock, ticker } = openFeed(t);

    l2(sock, [['buy', '100', '1'], ['sell', '105', '1']]);
    assert.equal(ticker().bid, 100);

    // Market drops: 100 removed, new top bid is 95. Old code stayed at 100.
    l2(sock, [['buy', '100', '0'], ['buy', '95', '1']]);
    assert.equal(ticker().bid, 95);

    // Market recovers: new bid at 102 becomes best.
    l2(sock, [['buy', '102', '1']]);
    assert.equal(ticker().bid, 102);
  });

  it('does not push a 0 bid downstream when every bid level is removed', (t) => {
    const { sock, ticker } = openFeed(t);

    l2(sock, [['buy', '100', '1'], ['sell', '101', '1']]);
    assert.equal(ticker().bid, 100);

    // All bids removed (transient empty side). A bid of 0 would divide-by-zero
    // in entry pricing (assetQty = sizeUsdc / 0 = Infinity), so the last known
    // good bid must be held rather than reset to 0.
    l2(sock, [['buy', '100', '0']]);
    assert.notEqual(ticker().bid, 0, 'an emptied bid side must not emit a 0 bid');
    assert.equal(ticker().bid, 100, 'last known good bid is held until a real bid arrives');

    // A real bid then takes over cleanly.
    l2(sock, [['buy', '102', '1']]);
    assert.equal(ticker().bid, 102);
  });

  it('resets lastPrice on reconnect so the first ticker is not a stale trade price', (t) => {
    const { sock, ticker } = openFeed(t);

    // Snapshot carries an embedded trade → lastPrice becomes 200.
    sock.emit('message', Buffer.from(JSON.stringify({
      type: 'l2_updates', symbol: 'BTCUSD',
      changes: [['buy', '199', '1'], ['sell', '201', '1']],
      trades: [{ tid: 1, price: '200', quantity: '0.1', side: 'buy', timestamp: 1 }],
    })));
    assert.equal(ticker().price, 200);

    // Reconnect, then a fresh snapshot at a much lower range with NO trade.
    sock.terminate();
    t.mock.timers.tick(1000);
    const sock2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    sock2.emit('open');
    l2(sock2, [['buy', '49', '1'], ['sell', '51', '1']]);

    // Price must reflect the fresh book (bestBid 49), not the stale 200 trade.
    assert.equal(ticker().price, 49, 'stale pre-reconnect lastPrice must not survive');
  });

  it('clears the book on reconnect so stale levels do not re-cross the best', (t) => {
    const { sock, ticker } = openFeed(t);

    l2(sock, [['buy', '100', '1'], ['sell', '101', '1']]);
    assert.equal(ticker().bid, 100);

    // Drop the connection; the close path schedules a reconnect.
    sock.terminate();
    t.mock.timers.tick(1000); // RECONNECT_BASE_DELAY → connect() makes a new socket
    const sock2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    assert.notEqual(sock2, sock, 'reconnect must create a fresh socket');
    sock2.emit('open');

    // Fresh snapshot at a much lower range. The old 100 bid must be gone.
    l2(sock2, [['buy', '50', '1'], ['sell', '51', '1']]);
    assert.equal(ticker().bid, 50, 'stale pre-reconnect levels must not survive');
    assert.equal(ticker().ask, 51);
    assert.ok(ticker().bid < ticker().ask, 'book must not be crossed after reconnect');
  });
});
