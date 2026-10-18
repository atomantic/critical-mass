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

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

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

describe('coinbase user-channel authentication', () => {
  it('subscribes to the user channel with an ES256 CDP token the key pair verifies', (t) => {
    const crypto = require('node:crypto');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const apiKey = 'organizations/example-org/apiKeys/example-key';
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.instances = [];
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', apiKey, apiSecret: privateKey });
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.emit('open');
    feed.disconnect();

    const userSub = sock.sent.map(raw => JSON.parse(raw)).find(message => message.channel === 'user');
    assert.ok(userSub, 'user channel subscription must be sent when credentials are configured');
    assert.deepEqual(userSub.product_ids, ['BTC-USD']);
    const [header, payload, signature] = userSub.jwt.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(decodedHeader.alg, 'ES256');
    assert.equal(decodedHeader.kid, apiKey);
    assert.match(decodedHeader.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual({ iss: claims.iss, sub: claims.sub, ttl: claims.exp - claims.nbf, uri: claims.uri }, { iss: 'cdp', sub: apiKey, ttl: 120, uri: undefined });
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  });
});

const VARIANTS = [
  { exchange: 'coinbase', openDelayMs: 0, connectMessage: '🔌 [coinbase] Connecting to WebSocket...' },
  { exchange: 'gemini', openDelayMs: 0, connectMessage: '🔌 [gemini] Connecting to Gemini WebSocket...' },
  { exchange: 'cryptocom', openDelayMs: 1000, connectMessage: '🔌 [cryptocom] Connecting to Crypto.com WebSocket...' }, // 1s post-connect delay before subscribe/heartbeat
];

/**
 * Enable mock timers, create a feed, connect it, and emit 'open'.
 * @param {import('node:test').TestContext} t
 * @param {{exchange: string, openDelayMs: number}} variant
 */
const openFeed = (t, variant) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWebSocket.instances = [];
  const events = { disconnects: 0, connects: 0, errors: 0 };
  const feed = createWebSocketFeed(variant.exchange, {
    productId: 'BTC-USD',
    publicOnly: true,
    onConnect: () => { events.connects++; },
    onDisconnect: () => { events.disconnects++; },
    onError: () => { events.errors++; },
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
    it('preserves connection messages and appends fund lifecycle context', (t) => {
      const lines = [];
      const originalLog = console.log;
      console.log = line => lines.push(line);

      try {
        const { feed } = openFeed(t, variant);
        feed.disconnect();
      } finally {
        console.log = originalLog;
      }

      assert.deepEqual(
        contextFor(lines, variant.connectMessage),
        { exchange: variant.exchange, pair: 'BTC-USD', lifecycle: 'connecting' }
      );
    });

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

    it('ignores obsolete socket callbacks after reconnect, including liveness', (t) => {
      const { feed, sock, events } = openFeed(t, variant);
      sock.close();
      sock.emit('close', 1006, Buffer.from('lost'));
      assert.equal(feed.isActive(), false);
      t.mock.timers.tick(1000);
      const replacement = FakeWebSocket.instances[1];
      replacement.emit('open');
      t.mock.timers.tick(variant.openDelayMs);
      assert.equal(events.connects, 2);
      const subscriptions = replacement.sent.length;

      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      sock.readyState = FakeWebSocket.OPEN; // An already queued old callback remains stale.
      sock.emit('open');
      sock.emit('message', Buffer.from('{}'));
      sock.emit('pong');
      sock.emit('error', new Error('obsolete socket'));
      sock.emit('close', 1006, Buffer.from('late close'));
      assert.equal(events.errors, 0);
      assert.equal(events.disconnects, 1);
      assert.equal(events.connects, 2);
      assert.equal(replacement.sent.length, subscriptions);
      assert.equal(feed.isActive(), true);
      assert.equal(sock.pings, 0, 'closed session heartbeat is cancelled');
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(replacement.terminated, true, 'old pong/message cannot reset replacement watchdog');
      feed.disconnect();
    });

    it('cancels a pending reconnect on shutdown and ignores late close callbacks', (t) => {
      const { feed, sock, events } = openFeed(t, variant);
      sock.close();
      sock.emit('close', 1006, Buffer.from('lost'));
      feed.disconnect();
      sock.emit('close', 1006, Buffer.from('duplicate'));
      t.mock.timers.tick(HEARTBEAT * 10);
      assert.equal(events.disconnects, 1);
      assert.equal(FakeWebSocket.instances.length, 1);
      assert.equal(sock.pings, 0);
    });

    it('uses capped exponential reconnect backoff and resets it on open', (t) => {
      const { feed, sock } = openFeed(t, variant);
      let current = sock;
      for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        const count = FakeWebSocket.instances.length;
        current.close();
        current.emit('close', 1006, Buffer.from('lost'));
        t.mock.timers.tick(delay - 1);
        assert.equal(FakeWebSocket.instances.length, count);
        t.mock.timers.tick(1);
        current = FakeWebSocket.instances[count];
      }
      assert.equal(feed.getStatus().reconnectAttempts, 8);
      current.emit('open');
      assert.equal(feed.getStatus().reconnectAttempts, 0);
      feed.disconnect();
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


describe('Crypto.com delayed subscription session ownership (issue #1003)', () => {
  for (const shutdown of ['close', 'disconnect']) {
    it(`cancels subscription and heartbeat when ${shutdown} occurs before subscription`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const intervals = t.mock.method(global, 'setInterval');
      FakeWebSocket.instances = [];
      const events = [];
      const feed = createWebSocketFeed('cryptocom', {
        productId: 'BTC-USD',
        onConnect: () => events.push('connect'),
        onDisconnect: () => events.push('disconnect'),
      });
      feed.connect();
      const first = FakeWebSocket.instances[0];
      first.emit('open');
      t.mock.timers.tick(100);
      if (shutdown === 'close') {
        first.close();
        first.emit('close', 1006, Buffer.from('early close'));
      } else feed.disconnect();
      t.mock.timers.tick(900);
      assert.deepEqual(events, ['disconnect']);
      assert.equal(feed.isActive(), false);
      assert.equal(first.sent.length, 0);
      assert.equal(intervals.mock.callCount(), 0, 'no obsolete heartbeat is installed');

      if (shutdown === 'close') {
        t.mock.timers.tick(100);
        assert.equal(FakeWebSocket.instances.length, 2);
        const replacement = FakeWebSocket.instances[1];
        replacement.emit('open');
        replacement.emit('open'); // Duplicate open cannot schedule a second subscription.
        t.mock.timers.tick(999);
        assert.equal(replacement.sent.length, 0);
        t.mock.timers.tick(1);
        assert.equal(replacement.sent.length, 2);
        assert.deepEqual(replacement.sent.map(JSON.parse).map(sub => sub.params.channels), [
          ['ticker.BTC_USD'], ['trade.BTC_USD'],
        ]);
        assert.deepEqual(events, ['disconnect', 'connect']);
        assert.equal(intervals.mock.callCount(), 1);
        t.mock.timers.tick(HEARTBEAT);
        assert.equal(replacement.pings, 1);
      } else {
        t.mock.timers.tick(HEARTBEAT * 10);
        assert.equal(FakeWebSocket.instances.length, 1);
      }
      assert.equal(first.pings, 0);
      feed.disconnect();
    });
  }
});
