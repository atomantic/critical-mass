// @ts-check
/**
 * WebSocket feed pong-timeout watchdog tests (issue #103)
 *
 * All three feeds (Coinbase, Gemini, Crypto.com) ping every 30s. If
 * MAX_MISSED_PONGS (2) pings go unanswered — no pong and no inbound
 * messages — the watchdog must terminate() the socket so the existing
 * 'close' → reconnect/backoff path runs. A silently dead TCP connection
 * (NAT timeout, sleep, partition) keeps readyState OPEN forever, so
 * without this the feed would never reconnect.
 *
 * Uses a fake `ws` module injected via require.cache plus node:test
 * mock timers to drive the heartbeat interval deterministically.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const HEARTBEAT = 30000;

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
    this.pings = 0;
    this.sent = [];
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }
  ping() { this.pings++; }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1006, Buffer.from(''));
  }
}

// Inject the fake 'ws' module BEFORE loading the feed modules so all three
// feeds (and the lazily-required adapters) pick it up.
const wsPath = require.resolve('ws');
require.cache[wsPath] = /** @type {any} */ ({
  id: wsPath,
  filename: wsPath,
  path: wsPath,
  loaded: true,
  exports: FakeWebSocket,
  children: [],
});
for (const p of ['../src/websocket-feed', '../src/adapters/gemini/websocket', '../src/adapters/cryptocom/websocket']) {
  delete require.cache[require.resolve(p)];
}

const { createWebSocketFeed } = require('../src/websocket-feed');

const VARIANTS = [
  { exchange: 'coinbase', openDelayMs: 0 },
  { exchange: 'gemini', openDelayMs: 0 },
  { exchange: 'cryptocom', openDelayMs: 1000 }, // 1s post-connect delay before subscribe/heartbeat
];

/**
 * Enable mock timers, create a feed, connect it, and emit 'open'.
 * @param {import('node:test').TestContext} t
 * @param {{exchange: string, openDelayMs: number}} variant
 */
const openFeed = (t, variant) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWebSocket.instances = [];
  const events = { disconnects: 0 };
  const feed = createWebSocketFeed(variant.exchange, {
    productId: 'BTC-USD',
    publicOnly: true,
    onDisconnect: () => { events.disconnects++; },
  });
  feed.connect();
  const sock = FakeWebSocket.instances[0];
  sock.emit('open');
  if (variant.openDelayMs > 0) {
    t.mock.timers.tick(variant.openDelayMs);
  }
  return { feed, sock, events };
};

for (const variant of VARIANTS) {
  describe(`${variant.exchange} pong-timeout watchdog`, () => {
    it('terminates a silently dead connection after missed pongs and reconnects', (t) => {
      const { sock, events } = openFeed(t, variant);

      // Two pings go out, no pong — not yet over the deadline
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.pings, 2);
      assert.equal(sock.terminated, false);

      // Third tick: MAX_MISSED_PONGS (2) unanswered pings — watchdog trips
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.terminated, true);
      assert.equal(events.disconnects, 1, 'terminate must drive the close → disconnect path');

      // Reconnect/backoff path runs (base delay 1s, attempts reset on open)
      t.mock.timers.tick(1000);
      assert.equal(FakeWebSocket.instances.length, 2, 'a new socket must be created by reconnect');
    });

    it('pong responses keep the connection alive indefinitely', (t) => {
      const { sock, events } = openFeed(t, variant);

      for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(HEARTBEAT);
        sock.emit('pong');
      }

      assert.equal(sock.pings, 5);
      assert.equal(sock.terminated, false);
      assert.equal(events.disconnects, 0);
      assert.equal(FakeWebSocket.instances.length, 1);
    });

    it('inbound messages also reset the watchdog (data flow proves liveness)', (t) => {
      const { sock } = openFeed(t, variant);

      // Two unanswered pings, then a message arrives
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      sock.emit('message', Buffer.from('{}'));

      // Counter was reset: two more ticks must NOT terminate
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.terminated, false);

      // But with continued silence the watchdog still trips
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.terminated, true);
    });

    it('intentional disconnect() clears the watchdog and never reconnects', (t) => {
      const { feed, sock } = openFeed(t, variant);

      feed.disconnect();
      t.mock.timers.tick(HEARTBEAT * 10);

      assert.equal(sock.terminated, false);
      assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect after intentional disconnect');
      assert.equal(feed.isActive(), false);
    });
  });
}
