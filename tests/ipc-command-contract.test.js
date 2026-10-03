// @ts-check
/**
 * IPC command contract (issue #845).
 *
 * Joins the pieces the existing suites test in isolation: the gateway client's
 * request serializer / correlation / deadline handling, the engine server's
 * dispatcher, and the real `regime:stop` lifecycle callback that consumes the
 * fund identity. Success/error transport and fund targeting run over a real
 * loopback socket (OS-assigned port); deadline, disconnect and reconnect
 * ordering run against a controllable fake socket on mock timers.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const WebSocket = require('ws');
const path = require('node:path');

const { createIPCClient } = require('../src/ipc/ipc-client');
const { DEFAULT_TIMEOUT, MSG_TYPE, createMessage } = require('../src/ipc/ipc-protocol');
const configUtils = require('../src/config-utils');
const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
const { fundKey, fundLabel } = require('../src/shared-utils');
const { LIFECYCLE } = require('../src/state-tracker');
const {
  FakeWebSocket, until, deferred, loadClientWithFakeWs, trackTimers, restoreTimers, startEngineIpc,
} = require('./helpers/ipc-command-harness');

const EXCHANGE = 'coinbase';
const DEFAULT_FUND = 'BTC-USD';
const SECOND_FUND = 'ETH-USD';

/** Resources released in afterEach so a failed assertion cannot leak sockets or mocks. */
const cleanups = [];
const onCleanup = (fn) => { cleanups.push(fn); };
afterEach(async () => {
  restoreTimers();
  while (cleanups.length) await cleanups.pop()();
});

/** Connect a real client to a real server and wait for the handshake. */
const connectReal = async (register, options = {}) => {
  const { server, url } = await startEngineIpc(register);
  onCleanup(() => server.stop());
  const client = createIPCClient(url, 'contract', options);
  onCleanup(() => client.disconnect());
  client.connect();
  await until(() => client.isConnected(), 'client connection');
  return { server, client, url };
};

describe('IPC process-only upgrade boundary', () => {
  for (const origin of ['https://untrusted.example', 'same-origin', 'null', '']) {
    it(`rejects ${JSON.stringify(origin)} Origin before admitting requests or events`, async () => {
      let requests = 0;
      let updates = 0;
      const { server, url } = await startEngineIpc((ipc) => {
        ipc.onRequest('test:echo', async () => { requests++; return { success: true }; });
        ipc.onRequest('config_update', async () => { updates++; });
      });
      onCleanup(() => server.stop());
      const browser = new WebSocket(url, { headers: { Origin: origin === 'same-origin' ? url.replace('ws:', 'http:') : origin } });
      onCleanup(() => browser.terminate());
      let opened = false;
      const messages = [];
      browser.on('message', (message) => messages.push(message));
      browser.on('open', () => {
        opened = true;
        browser.send(JSON.stringify(createMessage(MSG_TYPE.REQUEST, 'test:echo', {})));
        browser.send(JSON.stringify(createMessage(MSG_TYPE.CONFIG_UPDATE, 'config_update', {})));
      });
      const rejected = new Promise((resolve, reject) => {
        browser.once('unexpected-response', (_request, response) => {
          response.resume();
          browser.terminate();
          resolve(response.statusCode);
        });
        browser.once('open', () => reject(new Error('Origin client admitted')));
        browser.on('error', () => {}); // terminate after a rejected HTTP upgrade
      });
      assert.equal(await rejected, 401);
      server.broadcast('test:event', { private: true });
      assert.equal(opened, false);
      assert.equal(requests, 0);
      assert.equal(updates, 0);
      assert.deepEqual(messages, []);
      // A rejected handshake must not prevent the production process client.
      const client = createIPCClient(url, 'origin-boundary');
      onCleanup(() => client.disconnect());
      client.connect();
      await until(() => client.isConnected(), 'process connection after rejection');
      assert.deepEqual(await client.request('test:echo', {}), { success: true });
      assert.equal(requests, 1);
    });
  }
});

describe('IPC command transport over a real socket', () => {
  it('delivers exchange, pair and payload exactly and resolves concurrent callers independently', async () => {
    const arrivals = [];
    const gates = { [DEFAULT_FUND]: deferred(), [SECOND_FUND]: deferred() };
    const { client } = await connectReal((server) => {
      server.onRequest('test:echo', async (payload, exchange, pair) => {
        arrivals.push(pair);
        await gates[pair].promise;
        return { success: true, seen: { payload, exchange, pair } };
      });
    });

    let btcSettled = false;
    const btc = client.request('test:echo', { n: 1 }, EXCHANGE, DEFAULT_FUND).then((r) => { btcSettled = true; return r; });
    const eth = client.request('test:echo', { n: 2 }, EXCHANGE, SECOND_FUND);
    await until(() => arrivals.length === 2, 'both requests to reach the engine');

    gates[SECOND_FUND].resolve();
    const ethResult = await eth;
    assert.equal(btcSettled, false, 'the earlier request must not settle on the later reply');
    assert.deepEqual(ethResult, { success: true, seen: { payload: { n: 2 }, exchange: EXCHANGE, pair: SECOND_FUND } });

    gates[DEFAULT_FUND].resolve();
    assert.deepEqual(await btc, { success: true, seen: { payload: { n: 1 }, exchange: EXCHANGE, pair: DEFAULT_FUND } });
  });

  it('rejects the caller when a handler throws or the channel is unknown, but keeps structured negatives as results', async () => {
    const negative = { success: false, error: 'no capital', code: 'insufficient-funds' };
    const { client } = await connectReal((server) => {
      server.onRequest('test:throw', async () => { throw new Error('handler exploded'); });
      server.onRequest('test:negative', async () => negative);
    });

    await assert.rejects(client.request('test:throw', {}, EXCHANGE, DEFAULT_FUND), { message: 'handler exploded' });
    await assert.rejects(client.request('test:missing', {}, EXCHANGE, DEFAULT_FUND), /No handler for channel: test:missing/);
    assert.deepEqual(await client.request('test:negative', {}, EXCHANGE, DEFAULT_FUND), negative);
  });

  it('rejects every outstanding request when the engine goes away, then reconnects without replaying the command', async () => {
    const received = [];
    const hold = deferred();
    const register = (server) => {
      server.onRequest('regime:stop', async (_payload, _exchange, pair) => { received.push(pair); await hold.promise; return { success: true }; });
      server.onRequest('test:ping', async () => ({ success: true }));
    };
    const first = await startEngineIpc(register);
    onCleanup(() => first.server.stop());
    const client = createIPCClient(first.url, 'contract', { reconnectMin: 10, reconnectMax: 10 });
    onCleanup(() => client.disconnect());
    client.connect();
    await until(() => client.isConnected(), 'client connection');

    const outstanding = client.request('regime:stop', {}, EXCHANGE, SECOND_FUND);
    const outcome = assert.rejects(outstanding, /IPC connection closed/);
    await until(() => received.length === 1, 'request to reach the engine');
    first.server.stop();
    await outcome;
    hold.resolve();
    await until(() => !client.isConnected(), 'client to observe closure');

    // Engine restarts on the same port: the client reconnects by itself.
    const second = await startEngineIpc(register, first.port);
    onCleanup(() => second.server.stop());
    await until(() => client.isConnected(), 'automatic reconnect');
    assert.deepEqual(await client.request('test:ping', {}, EXCHANGE, DEFAULT_FUND), { success: true });
    assert.deepEqual(received, [SECOND_FUND], 'the already-sent command must not be replayed after reconnect');
  });
});

describe('IPC request lifecycle on a controlled socket', () => {
  const setup = (options = {}) => {
    const timers = trackTimers();
    const createClient = loadClientWithFakeWs();
    const client = createClient('ws://127.0.0.1:1', 'fake', options);
    onCleanup(() => client.disconnect());
    client.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    return { client, sock, ...timers };
  };
  const respond = (sock, request, extra = {}) =>
    sock.receive(createMessage(MSG_TYPE.RESPONSE, request.channel, extra.payload ?? { ok: true }, { id: request.id, error: extra.error }));

  it('serializes channel, exchange, pair and payload for the pair-aware signature', () => {
    const { client, sock } = setup();
    client.request('regime:pause', { reason: 'r' }, EXCHANGE, SECOND_FUND).catch(() => {});
    const [frame] = sock.frames;
    assert.equal(frame.type, MSG_TYPE.REQUEST);
    assert.equal(frame.channel, 'regime:pause');
    assert.equal(frame.exchange, EXCHANGE);
    assert.equal(frame.pair, SECOND_FUND);
    assert.deepEqual(frame.payload, { reason: 'r' });
  });

  it('honors a custom deadline in the pair-aware signature and ignores a late reply for the next request', async () => {
    const { client, sock, tick, live } = setup();
    const first = client.request('regime:rollup-body', { bodyId: 1 }, EXCHANGE, SECOND_FUND, 60_000);
    const firstFrame = sock.frames[0];

    tick(DEFAULT_TIMEOUT + 1);
    let settled = false;
    first.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'a long rollup deadline must outlive the default 10s');

    tick(60_000 - DEFAULT_TIMEOUT - 1);
    await assert.rejects(first, /IPC request timeout: regime:rollup-body/);
    assert.equal(live.size, 0, 'expired deadline is gone');

    const second = client.request('regime:status', {}, EXCHANGE, DEFAULT_FUND);
    const secondFrame = sock.frames[1];
    let secondSettled = false;
    second.then(() => { secondSettled = true; }, () => { secondSettled = true; });

    respond(sock, firstFrame, { payload: { success: true, from: 'late' } });
    await Promise.resolve();
    assert.equal(secondSettled, false, 'a late reply to the expired request must not settle another request');

    respond(sock, secondFrame, { payload: { success: true, from: 'second' } });
    assert.deepEqual(await second, { success: true, from: 'second' });
    assert.equal(live.size, 0);
  });

  it('honors a custom deadline in the legacy fourth-argument signature and defaults otherwise', async () => {
    const { client, sock, tick } = setup();
    const legacy = client.request('regime:status', {}, EXCHANGE, 250);
    assert.equal(sock.frames[0].pair, null, 'legacy signature carries no pair');
    const defaulted = client.request('regime:status', {}, EXCHANGE, DEFAULT_FUND);
    const outcomes = [legacy, defaulted].map((p) => p.then(() => 'resolved', (err) => err.message));

    tick(249);
    await Promise.resolve();
    assert.deepEqual(await Promise.race([legacy.then(() => 'resolved', () => 'rejected'), Promise.resolve('pending')]), 'pending');
    tick(1);
    assert.match(await outcomes[0], /IPC request timeout/);

    tick(DEFAULT_TIMEOUT - 250 - 1);
    assert.deepEqual(await Promise.race([outcomes[1], Promise.resolve('pending')]), 'pending');
    tick(1);
    assert.match(await outcomes[1], /IPC request timeout/);
  });

  it('settles only the request whose id matches, and reports an engine error as a rejection', async () => {
    const { client, sock, live } = setup();
    const a = client.request('regime:pause', {}, EXCHANGE, DEFAULT_FUND);
    const b = client.request('regime:pause', {}, EXCHANGE, SECOND_FUND);
    const [fa, fb] = sock.frames;
    assert.notEqual(fa.id, fb.id);

    respond(sock, fb, { payload: { fund: SECOND_FUND } });
    assert.deepEqual(await b, { fund: SECOND_FUND });
    assert.equal(live.size, 1, 'only the unanswered request keeps a deadline');

    respond(sock, fa, { error: 'engine said no', payload: null });
    await assert.rejects(a, { message: 'engine said no' });
    assert.equal(live.size, 0);
  });

  it('rejects every outstanding request and clears each deadline on peer closure, then reconnects without replay', async () => {
    let disconnects = 0;
    const { client, sock, tick, live } = setup({ onDisconnect: () => { disconnects++; } });
    const a = client.request('regime:stop', {}, EXCHANGE, DEFAULT_FUND);
    const b = client.request('regime:stop', {}, EXCHANGE, SECOND_FUND, 60_000);
    assert.equal(live.size, 2);
    const rejected = Promise.all([assert.rejects(a, /IPC connection closed/), assert.rejects(b, /IPC connection closed/)]);

    sock.peerClose();
    await rejected;
    assert.equal(disconnects, 1);
    assert.equal(live.size, 1, 'only the reconnect timer remains');

    tick(1000);
    assert.equal(FakeWebSocket.instances.length, 2, 'automatic reconnect opened a new socket');
    const fresh = FakeWebSocket.instances[1];
    assert.equal(fresh.frames.length, 0, 'reconnect must not replay sent commands');
    fresh.open();

    const next = client.request('regime:status', {}, EXCHANGE, SECOND_FUND);
    assert.equal(fresh.frames.length, 1);
    assert.equal(fresh.frames[0].channel, 'regime:status');
    assert.equal(sock.frames.length, 2, 'the old socket saw only its original two commands');
    respond(fresh, fresh.frames[0], { payload: { success: true } });
    assert.deepEqual(await next, { success: true });
  });

  it('rejects outstanding requests on intentional disconnect, clears deadlines and never reconnects', async () => {
    const { client, sock, tick, live } = setup();
    const pending = client.request('regime:rollup-all', {}, EXCHANGE, SECOND_FUND, 300_000);
    assert.equal(live.size, 1);
    const rejected = assert.rejects(pending, /IPC client disconnected/);

    client.disconnect();
    await rejected;
    assert.equal(live.size, 0);
    assert.equal(client.isConnected(), false);

    tick(10 * 60_000);
    assert.equal(FakeWebSocket.instances.length, 1, 'intentional disconnect must schedule no reconnect');
    assert.equal(sock.frames.length, 1);
    await assert.rejects(client.request('regime:status', {}, EXCHANGE, DEFAULT_FUND), /IPC not connected/);
  });
});

describe('fund targeting from the stop route to the engine lifecycle callback', () => {
  const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');
  const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
  const CONFIG = {
    exchanges: {
      [EXCHANGE]: {
        pairs: {
          [DEFAULT_FUND]: { productId: DEFAULT_FUND, enabled: true, dryRun: true, regime: { enabled: true } },
          [SECOND_FUND]: { productId: SECOND_FUND, enabled: true, dryRun: true, regime: { enabled: true } },
        },
      },
    },
  };

  /** Serve the two-fund config from memory; every other path still hits the real fs. */
  const mockConfigFiles = () => {
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    const realStat = fs.statSync;
    configUtils._resetConfigCacheForTests();
    mock.method(fs, 'existsSync', (p) => (p === USER_CONFIG_FILE ? true : p === BASE_CONFIG_FILE ? false : realExists(p)));
    mock.method(fs, 'readFileSync', (p, ...rest) => (p === USER_CONFIG_FILE ? JSON.stringify(CONFIG) : realRead(p, ...rest)));
    mock.method(fs, 'statSync', (p, ...rest) => (p === USER_CONFIG_FILE ? { mtimeMs: 1 } : realStat(p, ...rest)));
    onCleanup(() => configUtils._resetConfigCacheForTests());
  };

  const buildEngineSide = (server) => {
    const regimeEngines = new Map();
    const runningFlags = new Map();
    const stops = [];
    for (const pair of [DEFAULT_FUND, SECOND_FUND]) {
      regimeEngines.set(fundKey(EXCHANGE, pair), { stop: async () => { stops.push(pair); return {}; } });
      runningFlags.set(fundKey(EXCHANGE, pair), true);
    }
    registerEngineLifecycleHandlers(server, {
      regimeEngines,
      resolvePair: (exchange, pair) => {
        const resolved = configUtils.resolveConfiguredPair(exchange, pair);
        if (resolved.error) throw new Error(resolved.error);
        return resolved.pair;
      },
      fundKey,
      fundLabel,
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      getFundConfig: () => ({}),
      getAdapter: () => ({ hasValidKeys: () => true }),
      loadRegimeState: () => ({ position: { lifecycle: LIFECYCLE.ACTIVE } }),
      LIFECYCLE,
      createRegimeEngine: () => { throw new Error('not used'); },
      createEngineCallbacks: () => ({}),
      startMarketDataService: async () => ({ success: true }),
      stopMarketDataService: () => {},
      wireMarketDataCallbacks: () => {},
      invalidateStandaloneLedger: () => {},
      saveRegimeRunningFlag: (exchange, pair, isRunning) => { runningFlags.set(fundKey(exchange, pair), isRunning); },
    });
    return { regimeEngines, runningFlags, stops };
  };

  const mountRoute = (client) => {
    const handlers = {};
    const app = { get() {}, put() {}, delete() {}, post: (route, handler) => { handlers[route] = handler; } };
    const ROUTES_PATH = require.resolve('../src/routes/regime-routes');
    delete require.cache[ROUTES_PATH];
    require('../src/routes/regime-routes')(app, { exchangeIPCMap: { [EXCHANGE]: client } });
    return async (query) => {
      const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handlers['/api/:exchange/regime/stop']({ params: { exchange: EXCHANGE }, query, body: {} }, res, (err) => { throw err; });
      return res;
    };
  };

  const setup = async () => {
    mockConfigFiles();
    let side;
    const { client } = await connectReal((server) => { side = buildEngineSide(server); });
    return { ...side, stopRoute: mountRoute(client) };
  };

  it('stops only the requested second fund and leaves the default fund running', async () => {
    const { regimeEngines, runningFlags, stops, stopRoute } = await setup();

    const res = await stopRoute({ pair: SECOND_FUND });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, exchange: EXCHANGE, pair: SECOND_FUND, stopped: true });
    assert.deepEqual(stops, [SECOND_FUND]);
    assert.equal(runningFlags.get(fundKey(EXCHANGE, SECOND_FUND)), false);
    assert.equal(runningFlags.get(fundKey(EXCHANGE, DEFAULT_FUND)), true);
    assert.equal(regimeEngines.has(fundKey(EXCHANGE, SECOND_FUND)), false);
    assert.equal(regimeEngines.has(fundKey(EXCHANGE, DEFAULT_FUND)), true);
  });

  it('resolves an absent pair to the default fund and leaves the second fund running', async () => {
    const { runningFlags, stops, stopRoute } = await setup();

    const res = await stopRoute({});

    assert.equal(res.body.pair, DEFAULT_FUND);
    assert.deepEqual(stops, [DEFAULT_FUND]);
    assert.equal(runningFlags.get(fundKey(EXCHANGE, DEFAULT_FUND)), false);
    assert.equal(runningFlags.get(fundKey(EXCHANGE, SECOND_FUND)), true);
  });
});
