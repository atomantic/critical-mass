// @ts-check
/**
 * WebSocket feed liveness watchdog tests (issues #103, #1180)
 *
 * All three feeds (Coinbase, Gemini, Crypto.com) judge liveness on inbound
 * traffic: each exchange sends periodic heartbeat frames, so if
 * MAX_SILENT_INTERVALS (2) heartbeat intervals pass with nothing inbound the
 * watchdog must terminate() the socket so the existing 'close' →
 * reconnect/backoff path runs. A silently dead TCP connection (NAT timeout,
 * sleep, partition) keeps the runtime socket OPEN forever, so without this the
 * feed would never reconnect.
 *
 * Uses the fake global WebSocket from tests/helpers/fake-websocket.js plus
 * node:test mock timers to drive the heartbeat interval deterministically.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

// Installed BEFORE any feed connects; the connection adapter resolves the
// global at connect time, so all three feeds pick it up.
const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

const { createWebSocketFeed } = require('../src/websocket-feed');

const contextFor = (lines, prefix) => {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing log line starting with: ${prefix}`);
  const contextStart = line.lastIndexOf(' {');
  assert.notEqual(contextStart, -1, `missing structured context: ${line}`);
  return JSON.parse(line.slice(contextStart + 1));
};

const HEARTBEAT = 30000;

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
    FakeWebSocket.reset();
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', apiKey, apiSecret: privateKey });
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    feed.disconnect();

    const userSub = sock.frames.find(message => message.channel === 'user');
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

  it('subscribes to the heartbeats channel so a quiet product still feeds the watchdog', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', publicOnly: true });
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    feed.disconnect();
    assert.deepEqual(sock.frames.map(message => message.channel), ['ticker', 'market_trades', 'heartbeats']);
  });
});

describe('coinbase user-channel recovery (#1382)', () => {
  const crypto = require('node:crypto');
  const jwt = require('../src/jwt');
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const USER_RETRY = 30000;
  const userSubs = (sock) => sock.frames.filter(message => message.channel === 'user');

  const openUserFeed = (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', apiKey: 'organizations/o/apiKeys/k', apiSecret: privateKey });
    return feed;
  };

  it('retries the user subscription after a JWT signing failure and reports degraded meanwhile', (t) => {
    const realSign = jwt.signJwt;
    let calls = 0;
    t.mock.method(jwt, 'signJwt', (...args) => {
      calls++;
      if (calls === 1) throw new Error('signer unavailable');
      return realSign(...args);
    });
    const feed = openUserFeed(t);
    assert.equal(feed.getStatus().userChannel, 'degraded', 'not subscribed before connect');
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    assert.equal(userSubs(sock).length, 0);
    assert.equal(feed.getStatus().userChannel, 'degraded');

    t.mock.timers.tick(USER_RETRY - 1);
    assert.equal(userSubs(sock).length, 0);
    t.mock.timers.tick(1);
    assert.equal(userSubs(sock).length, 1, 'user subscription retried on the same socket');
    assert.equal(feed.getStatus().userChannel, 'subscribed');
    assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect needed');
    feed.disconnect();
  });

  it('resubscribes after an error frame with doubling backoff, then reconnects after three failed retries', (t) => {
    const feed = openUserFeed(t);
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    assert.equal(userSubs(sock).length, 1);
    assert.equal(feed.getStatus().userChannel, 'subscribed');

    const reject = () => sock.receive(JSON.stringify({ type: 'error', message: 'authentication failure' }));
    let expected = 1;
    for (const delay of [30000, 60000, 120000]) {
      reject();
      assert.equal(feed.getStatus().userChannel, 'degraded');
      reject(); // a duplicate error while a retry is pending does not reschedule
      // Keep the liveness watchdog fed while we wait.
      for (let second = 1; second < delay / 1000; second++) { t.mock.timers.tick(1000); sock.receive('{}'); }
      t.mock.timers.tick(999);
      assert.equal(userSubs(sock).length, expected, `no resubscribe before ${delay}ms`);
      t.mock.timers.tick(1);
      expected++;
      assert.equal(userSubs(sock).length, expected, `resubscribed after ${delay}ms`);
      assert.equal(feed.getStatus().userChannel, 'subscribed');
    }
    assert.equal(sock.closeCalls.length, 0);
    reject();
    assert.equal(sock.closeCalls.length, 1, 'socket terminated after retries are exhausted');
    assert.equal(feed.getStatus().userChannel, 'degraded');
    t.mock.timers.tick(1000);
    assert.equal(FakeWebSocket.instances.length, 2, 'lifecycle reconnects');
    const replacement = FakeWebSocket.instances[1];
    replacement.open();
    assert.equal(userSubs(replacement).length, 1, 'fresh socket resubscribes the user channel');
    assert.equal(feed.getStatus().userChannel, 'subscribed');
    feed.disconnect();
    assert.equal(feed.getStatus().userChannel, 'degraded');
  });

  it('reports no user channel in public-only mode', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', publicOnly: true });
    feed.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive(JSON.stringify({ type: 'error', message: 'bad product' }));
    t.mock.timers.tick(USER_RETRY * 10);
    assert.equal(feed.getStatus().userChannel, null);
    feed.disconnect();
  });
});

describe('coinbase ticker bid/ask guard (#1336)', () => {
  it('withholds ticks with a missing, zero, or crossed side', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const ticks = [];
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', publicOnly: true, onTicker: (d) => ticks.push(d) });
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    const send = (t2) => sock.receive(JSON.stringify({ channel: 'ticker', events: [{ type: 'update', tickers: [{ product_id: 'BTC-USD', price: '100', ...t2 }] }] }));
    send({ best_bid: '0', best_ask: '0' });
    send({ best_ask: '101' });
    send({ best_bid: '102', best_ask: '101' });
    assert.equal(ticks.length, 0);
    send({ best_bid: '99', best_ask: '101' });
    feed.disconnect();
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].bid, 99);
    assert.equal(ticks[0].ask, 101);
  });

  it('withholds ticks with a zero, negative, or missing price (#110 M1)', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const ticks = [];
    const feed = createWebSocketFeed('coinbase', { productId: 'BTC-USD', publicOnly: true, onTicker: (d) => ticks.push(d) });
    feed.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    const send = (t2) => sock.receive(JSON.stringify({ channel: 'ticker', events: [{ type: 'update', tickers: [{ product_id: 'BTC-USD', best_bid: '99', best_ask: '101', ...t2 }] }] }));
    send({ price: '0' });
    send({ price: '-5' });
    send({});
    assert.equal(ticks.length, 0);
    send({ price: '100' });
    feed.disconnect();
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].price, 100);
  });
});

const VARIANTS = [
  { exchange: 'coinbase', openDelayMs: 0, connectMessage: '🔌 [coinbase] Connecting to WebSocket...', heartbeat: '{"channel":"heartbeats","client_id":"","timestamp":"2026-10-19T00:00:00Z","sequence_num":1,"events":[{"current_time":"2026-10-19 00:00:00","heartbeat_counter":1}]}' },
  { exchange: 'gemini', openDelayMs: 0, connectMessage: '🔌 [gemini] Connecting to Gemini WebSocket...', heartbeat: '{"type":"heartbeat","timestamp":1}' },
  { exchange: 'cryptocom', openDelayMs: 1000, connectMessage: '🔌 [cryptocom] Connecting to Crypto.com WebSocket...', heartbeat: '{"id":7,"method":"public/heartbeat","code":0}' }, // 1s post-connect delay before subscribe/heartbeat
];

/**
 * Enable mock timers, create a feed, connect it, and open the socket.
 * @param {import('node:test').TestContext} t
 * @param {{exchange: string, openDelayMs: number}} variant
 */
const openFeed = (t, variant) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWebSocket.reset();
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
  sock.open();
  if (variant.openDelayMs > 0) {
    t.mock.timers.tick(variant.openDelayMs);
  }
  return { feed, sock, events };
};

for (const variant of VARIANTS) {
  describe(`${variant.exchange} liveness watchdog`, () => {
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

    it('terminates a silently dead connection after two silent intervals and reconnects', (t) => {
      const { sock, events } = openFeed(t, variant);

      // Two silent intervals — not yet over the deadline
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.closeCalls.length, 0);
      assert.equal(events.disconnects, 0);

      // Third tick: MAX_SILENT_INTERVALS (2) passed with nothing inbound — watchdog trips
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.closeCalls.length, 1, 'the dead socket is closed best-effort');
      assert.equal(events.disconnects, 1, 'terminate must drive the close → disconnect path');

      // Reconnect/backoff path runs (base delay 1s, attempts reset on open)
      t.mock.timers.tick(1000);
      assert.equal(FakeWebSocket.instances.length, 2, 'a new socket must be created by reconnect');
    });

    it('exchange heartbeat frames keep the connection alive indefinitely', (t) => {
      const { sock, events } = openFeed(t, variant);
      const sentBefore = sock.sent.length;

      for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(HEARTBEAT);
        sock.receive(variant.heartbeat);
      }

      assert.equal(sock.closeCalls.length, 0);
      assert.equal(events.disconnects, 0);
      assert.equal(FakeWebSocket.instances.length, 1);
      if (variant.exchange === 'cryptocom') {
        const replies = sock.frames.slice(sentBefore);
        assert.equal(replies.length, 5, 'every Crypto.com heartbeat is answered');
        assert.deepEqual(replies[0], { id: 7, method: 'public/respond-heartbeat' });
      }
    });

    it('any inbound message resets the watchdog (data flow proves liveness)', (t) => {
      const { sock } = openFeed(t, variant);

      // Two silent intervals, then a message arrives
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      sock.receive('{}');

      // Counter was reset: two more ticks must NOT terminate
      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.closeCalls.length, 0);

      // But with continued silence the watchdog still trips
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(sock.closeCalls.length, 1);
    });

    it('ignores obsolete socket callbacks after reconnect, including liveness', (t) => {
      const { feed, sock, events } = openFeed(t, variant);
      sock.peerClose(1006, 'lost');
      assert.equal(feed.isActive(), false);
      t.mock.timers.tick(1000);
      const replacement = FakeWebSocket.instances[1];
      replacement.open();
      t.mock.timers.tick(variant.openDelayMs);
      assert.equal(events.connects, 2);
      const subscriptions = replacement.sent.length;

      t.mock.timers.tick(HEARTBEAT);
      t.mock.timers.tick(HEARTBEAT);
      // The retired socket is detached: anything it still reports is stale.
      sock.readyState = FakeWebSocket.OPEN;
      sock.open();
      sock.receive('{}');
      sock.fail('obsolete socket');
      sock.peerClose(1006, 'late close');
      assert.equal(events.errors, 0);
      assert.equal(events.disconnects, 1);
      assert.equal(events.connects, 2);
      assert.equal(replacement.sent.length, subscriptions);
      assert.equal(feed.isActive(), true);
      t.mock.timers.tick(HEARTBEAT);
      assert.equal(replacement.closeCalls.length, 1, 'old socket traffic cannot reset the replacement watchdog');
      assert.equal(sock.closeCalls.length, 0, 'the retired socket is never closed twice');
      feed.disconnect();
    });

    it('cancels a pending reconnect on shutdown and ignores late close callbacks', (t) => {
      const { feed, sock, events } = openFeed(t, variant);
      sock.peerClose(1006, 'lost');
      feed.disconnect();
      sock.peerClose(1006, 'duplicate');
      t.mock.timers.tick(HEARTBEAT * 10);
      assert.equal(events.disconnects, 1);
      assert.equal(FakeWebSocket.instances.length, 1);
      assert.equal(sock.closeCalls.length, 0);
    });

    it('uses capped exponential reconnect backoff and resets it on the first frame after subscribe', (t) => {
      const { feed, sock } = openFeed(t, variant);
      let current = sock;
      for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        const count = FakeWebSocket.instances.length;
        current.peerClose(1006, 'lost');
        t.mock.timers.tick(delay - 1);
        assert.equal(FakeWebSocket.instances.length, count);
        t.mock.timers.tick(1);
        current = FakeWebSocket.instances[count];
      }
      assert.equal(feed.getStatus().reconnectAttempts, 8);
      current.open();
      if (variant.openDelayMs > 0) t.mock.timers.tick(variant.openDelayMs);
      assert.equal(feed.getStatus().reconnectAttempts, 8, 'open alone does not reset the backoff');
      current.receive(variant.heartbeat);
      assert.equal(feed.getStatus().reconnectAttempts, 0);
      feed.disconnect();
    });

    it('keeps growing the backoff when the socket opens and closes straight away', (t) => {
      const { feed, sock } = openFeed(t, variant);
      let current = sock;
      for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        const count = FakeWebSocket.instances.length;
        current.peerClose(1008, 'rejected');
        t.mock.timers.tick(delay - 1);
        assert.equal(FakeWebSocket.instances.length, count, `waits the full ${delay}ms`);
        t.mock.timers.tick(1);
        current = FakeWebSocket.instances[count];
        current.open();
        if (variant.openDelayMs > 0) t.mock.timers.tick(variant.openDelayMs);
      }
      feed.disconnect();
    });

    it('resets the backoff after the connection stays open for the stability window', (t) => {
      const { feed, sock } = openFeed(t, variant);
      sock.peerClose(1006, 'lost');
      t.mock.timers.tick(1000);
      FakeWebSocket.instances[1].open();
      t.mock.timers.tick(30000);
      assert.equal(feed.getStatus().reconnectAttempts, 0);
      feed.disconnect();
    });

    it('reconnects at the base delay after a socket that received a frame later drops', (t) => {
      const { feed, sock } = openFeed(t, variant);
      sock.peerClose(1006, 'lost');
      t.mock.timers.tick(1000);
      const second = FakeWebSocket.instances[1];
      second.open();
      if (variant.openDelayMs > 0) t.mock.timers.tick(variant.openDelayMs);
      second.receive(variant.heartbeat);
      second.peerClose(1006, 'lost');
      t.mock.timers.tick(999);
      assert.equal(FakeWebSocket.instances.length, 2);
      t.mock.timers.tick(1);
      assert.equal(FakeWebSocket.instances.length, 3);
      feed.disconnect();
    });

    it('a failed handshake with no close event (Node 22) still reconnects with backoff', (t) => {
      const { feed, sock, events } = openFeed(t, variant);
      sock.peerClose(1006, 'lost');
      t.mock.timers.tick(1000);
      const retry = FakeWebSocket.instances[1];
      retry.fail('Received network error or non-101 status code.');
      assert.equal(events.errors, 1, 'the handshake failure is reported');
      t.mock.timers.tick(2000);
      assert.equal(FakeWebSocket.instances.length, 3, 'the next attempt is scheduled from the error alone');
      assert.equal(feed.getStatus().reconnectAttempts, 2);
      feed.disconnect();
    });

    it('intentional disconnect() clears the watchdog and never reconnects', (t) => {
      const { feed, sock } = openFeed(t, variant);

      feed.disconnect();
      t.mock.timers.tick(HEARTBEAT * 10);

      assert.deepEqual(sock.closeCalls, [{ code: undefined, reason: undefined }], 'one graceful close, never a terminate');
      assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect after intentional disconnect');
      assert.equal(feed.isActive(), false);
    });
  });
}


describe('WebSocket handshake timeout (#1413)', () => {
  const HANDSHAKE_TIMEOUT = 15000;
  const makeFeed = (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const events = { disconnects: 0 };
    const feed = createWebSocketFeed('gemini', {
      productId: 'BTC-USD', publicOnly: true, onDisconnect: () => { events.disconnects++; },
    });
    feed.connect();
    return { feed, events };
  };

  it('terminates a socket that never opens and schedules a reconnect', (t) => {
    const { feed, events } = makeFeed(t);
    const sock = FakeWebSocket.instances[0];
    t.mock.timers.tick(HANDSHAKE_TIMEOUT - 1);
    assert.equal(sock.closeCalls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(sock.closeCalls.length, 1, 'the hung socket is terminated');
    assert.equal(events.disconnects, 1);
    t.mock.timers.tick(1000);
    assert.equal(FakeWebSocket.instances.length, 2, 'reconnect creates a new socket');
    feed.disconnect();
  });

  it('does not terminate a socket that opened in time', (t) => {
    const { feed } = makeFeed(t);
    const sock = FakeWebSocket.instances[0];
    sock.open();
    t.mock.timers.tick(HANDSHAKE_TIMEOUT);
    assert.equal(sock.closeCalls.length, 0);
    feed.disconnect();
  });

  it('disconnect cancels the handshake timer', (t) => {
    const { feed } = makeFeed(t);
    feed.disconnect();
    t.mock.timers.tick(HANDSHAKE_TIMEOUT * 4);
    assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect after disconnect');
  });
});

describe('Crypto.com delayed subscription session ownership (issue #1003)', () => {
  for (const shutdown of ['close', 'disconnect']) {
    it(`cancels subscription and heartbeat when ${shutdown} occurs before subscription`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const intervals = t.mock.method(global, 'setInterval');
      FakeWebSocket.reset();
      const events = [];
      const feed = createWebSocketFeed('cryptocom', {
        productId: 'BTC-USD',
        onConnect: () => events.push('connect'),
        onDisconnect: () => events.push('disconnect'),
      });
      feed.connect();
      const first = FakeWebSocket.instances[0];
      first.open();
      t.mock.timers.tick(100);
      if (shutdown === 'close') first.peerClose(1006, 'early close');
      else feed.disconnect();
      t.mock.timers.tick(900);
      assert.deepEqual(events, ['disconnect']);
      assert.equal(feed.isActive(), false);
      assert.equal(first.sent.length, 0);
      assert.equal(intervals.mock.callCount(), 0, 'no obsolete heartbeat is installed');

      if (shutdown === 'close') {
        t.mock.timers.tick(100);
        assert.equal(FakeWebSocket.instances.length, 2);
        const replacement = FakeWebSocket.instances[1];
        replacement.open();
        replacement.open(); // Duplicate open cannot schedule a second subscription.
        t.mock.timers.tick(999);
        assert.equal(replacement.sent.length, 0);
        t.mock.timers.tick(1);
        assert.equal(replacement.sent.length, 2);
        assert.deepEqual(replacement.frames.map(sub => sub.params.channels), [
          ['ticker.BTC_USD'], ['trade.BTC_USD'],
        ]);
        assert.deepEqual(events, ['disconnect', 'connect']);
        assert.equal(intervals.mock.callCount(), 1);
        t.mock.timers.tick(HEARTBEAT);
        assert.equal(replacement.closeCalls.length, 0, 'the watchdog is armed, not tripped');
        assert.equal(first.closeCalls.length, 0);
      } else {
        t.mock.timers.tick(HEARTBEAT * 10);
        assert.equal(FakeWebSocket.instances.length, 1);
        assert.equal(first.closeCalls.length, 1, 'disconnect closes the pending socket once');
      }
      feed.disconnect();
    });
  }
});
