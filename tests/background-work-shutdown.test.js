// @ts-check
/**
 * Accepted background jobs (AI prompt runs, optimizer runs) answer their HTTP
 * request early, so the gateway shutdown drain must own them independently of
 * the socket. These tests use the production route modules and shutdown
 * coordinator with deferred synthetic providers, isolated storage and an
 * injected exit; no real provider, exchange or process manager is contacted.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SimulationRunCoordinator } = require('../src/simulation-run-coordinator');
const { createGatewayShutdown } = require('../src/gateway-shutdown');
const { errorMiddleware } = require('../src/error-middleware');

const optimizerPath = require.resolve('../src/optimizer-engine');
const { compareOptimizerResults } = require(optimizerPath);
const pendingOptimizers = [];
require.cache[optimizerPath] = {
  id: optimizerPath,
  filename: optimizerPath,
  loaded: true,
  exports: {
    compareOptimizerResults,
    runOptimizer: () => new Promise((resolve, reject) => pendingOptimizers.push({ resolve, reject })),
    getTopResults: (results) => results,
  },
};
const mountAiRoutes = require('../src/routes/ai-routes');
const registerBacktestRoutes = require('../src/routes/backtest-routes');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

/** @param {import('node:http').RequestListener} handler */
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
};

const makeGateway = (timeoutMs = 30_000) => {
  /** @type {string[]} */
  const calls = [];
  const gateway = createGatewayShutdown({
    cancelSchedules: () => {},
    stopProducers: () => {},
    stopNotifier: () => {},
    disconnectIPC: () => {},
    closeListeners: () => { calls.push('listeners'); },
    log: () => {},
    exit: (code) => calls.push(`exit:${code}`),
    timeoutMs,
  });
  return { gateway, calls };
};

describe('AI runs are owned by the gateway shutdown drain', () => {
  /** @type {{ close: () => Promise<unknown> }[]} */
  const servers = [];
  /** @type {string[]} */
  const dirs = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  const setup = async ({ timeoutMs } = {}) => {
    /** @type {{ res: import('node:http').ServerResponse }[]} */
    const providerRequests = [];
    const provider = await listen((req, res) => {
      req.resume();
      if (req.url === '/v1/chat/completions') providerRequests.push({ res });
      else res.writeHead(404).end('{}');
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-shutdown-ai-'));
    dirs.push(dataDir);
    fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify({
      providers: {
        fixture: { id: 'fixture', name: 'Fixture', type: 'api', enabled: true, endpoint: `${provider.origin}/v1`, apiKey: 'sk-fixture', models: ['m1'], defaultModel: 'm1' },
      },
    }));
    const { gateway, calls } = makeGateway(timeoutMs);
    const app = express();
    app.use(gateway.middleware);
    app.use(express.json());
    mountAiRoutes(/** @type {any} */ (gateway.routes(app)), { DATA_DIR: dataDir, trackBackgroundWork: gateway.track }, { allowedOrigins: new Set([provider.origin]), maxConcurrentRuns: 2 });
    app.use(errorMiddleware);
    const server = await listen(app);
    servers.push(provider, server);
    const start = async () => {
      const response = await fetch(`${server.origin}/api/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'fixture', prompt: 'hello' }),
      });
      return { status: response.status, json: await response.json() };
    };
    const runFile = (runId, name) => fs.readFileSync(path.join(dataDir, 'runs', runId, name), 'utf8');
    return { gateway, calls, server, provider, providerRequests, start, runFile };
  };

  const answer = (request, content) => {
    request.res.writeHead(200, { 'Content-Type': 'application/json' });
    request.res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  };

  it('holds the drain until output and terminal metadata are durable', async () => {
    const { gateway, calls, providerRequests, start, runFile } = await setup();
    const started = await start();
    assert.equal(started.status, 202);
    await waitFor(() => providerRequests.length === 1, 'provider request');

    const shutdown = gateway.shutdown('SIGTERM');
    // A repeated signal shares the one drain.
    assert.equal(gateway.shutdown('SIGTERM'), shutdown);
    await settle();
    await settle();
    assert.deepEqual(calls, [], 'no listener closure or exit while the run is unfinished');
    assert.equal(JSON.parse(runFile(started.json.runId, 'metadata.json')).endTime, null);

    answer(providerRequests[0], 'generated text');
    assert.equal(await shutdown, 0);
    const metadata = JSON.parse(runFile(started.json.runId, 'metadata.json'));
    assert.equal(metadata.success, true);
    assert.notEqual(metadata.endTime, null);
    assert.equal(runFile(started.json.runId, 'output.txt'), 'generated text');
    assert.deepEqual(calls, ['listeners', 'exit:0']);
  });

  it('keeps the run tracked after the initiating client disconnects', async () => {
    const { gateway, calls, server, providerRequests, runFile } = await setup();
    // A raw socket that vanishes right after the 202 is read.
    const body = JSON.stringify({ providerId: 'fixture', prompt: 'hello' });
    const runId = await new Promise((resolve, reject) => {
      const socket = net.connect(server.port, '127.0.0.1', () => {
        socket.write(`POST /api/runs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk;
        const match = received.match(/"runId":"([^"]+)"/);
        if (match) { socket.destroy(); resolve(match[1]); }
      });
      socket.on('error', reject);
    });
    await waitFor(() => providerRequests.length === 1, 'provider request');

    const shutdown = gateway.shutdown('SIGTERM');
    await settle();
    await settle();
    assert.deepEqual(calls, []);

    answer(providerRequests[0], 'after disconnect');
    assert.equal(await shutdown, 0);
    assert.equal(runFile(runId, 'output.txt'), 'after disconnect');
  });

  it('settles the owner on provider failure, keeps the failure record, and refuses new starts while draining', async () => {
    const { gateway, calls, providerRequests, start, runFile } = await setup();
    const started = await start();
    await waitFor(() => providerRequests.length === 1, 'provider request');

    const shutdown = gateway.shutdown('SIGTERM');
    const refused = await start();
    assert.equal(refused.status, 503);
    assert.equal(providerRequests.length, 1, 'no new run reached the provider');

    providerRequests[0].res.writeHead(500).end('{"error":"boom"}');
    assert.equal(await shutdown, 0);
    const metadata = JSON.parse(runFile(started.json.runId, 'metadata.json'));
    assert.equal(metadata.success, false);
    assert.match(metadata.error, /HTTP 500/);
    assert.deepEqual(calls, ['listeners', 'exit:0']);
  });

  it('exits nonzero at the deadline when a run never finishes', async () => {
    const { gateway, calls, providerRequests, start } = await setup({ timeoutMs: 100 });
    await start();
    await waitFor(() => providerRequests.length === 1, 'provider request');

    assert.equal(await gateway.shutdown('SIGTERM'), 1);
    assert.deepEqual(calls, ['exit:1']);
    // Let the abandoned run finish while its storage still exists.
    answer(providerRequests[0], 'late');
    await settle();
  });
});

describe('optimizer runs are owned by the gateway shutdown drain', () => {
  const resultFor = (totalValue) => ({
    productId: 'BTC-USDC',
    totalCombinations: 1,
    duration: 10,
    bestResult: { params: { intervalType: 'daily', sellMarkupPercent: 2 }, metrics: { totalValue } },
    results: [],
    config: {},
  });

  const setup = ({ timeoutMs } = {}) => {
    pendingOptimizers.length = 0;
    const { gateway, calls } = makeGateway(timeoutMs);
    const record = (entry) => calls.push(entry);
    let optimizerHandler;
    registerBacktestRoutes({
      get: () => {},
      delete: () => {},
      post: (route, handler) => { if (route.endsWith('/optimizer/run')) optimizerHandler = handler; },
    }, {
      io: { emit: (name) => { if (name === 'optimizer:complete' || name === 'optimizer:error') record(name); } },
      readJSON: () => null,
      writeJSON: () => record('cache-write'),
      DATA_DIR: '/tmp',
      simulationCoordinator: new SimulationRunCoordinator(),
      trackBackgroundWork: gateway.track,
    });
    const start = () => {
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      optimizerHandler({ params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' }, body: { forceRefresh: true } }, res);
      return res;
    };
    return { gateway, calls, start };
  };

  it('publishes cache and completion before listener closure and successful exit', async () => {
    const { gateway, calls, start } = setup();
    const response = start();
    assert.equal(response.body.streaming, true);
    await settle();
    assert.equal(pendingOptimizers.length, 1);

    const shutdown = gateway.shutdown('SIGTERM');
    assert.equal(gateway.shutdown('SIGINT'), shutdown);
    await settle();
    await settle();
    assert.deepEqual(calls, [], 'no cache write, listener closure or exit while the job is unfinished');

    pendingOptimizers[0].resolve(resultFor(101));
    assert.equal(await shutdown, 0);
    assert.deepEqual(calls, ['cache-write', 'optimizer:complete', 'listeners', 'exit:0']);
  });

  it('settles the owner on failure and still emits the existing error event', async () => {
    const { gateway, calls, start } = setup();
    start();
    await settle();

    const shutdown = gateway.shutdown('SIGTERM');
    pendingOptimizers[0].reject(new Error('simulation failed'));
    assert.equal(await shutdown, 0);
    assert.deepEqual(calls, ['optimizer:error', 'listeners', 'exit:0']);
  });

  it('exits nonzero at the deadline when the job never finishes', async () => {
    const { gateway, calls, start } = setup({ timeoutMs: 50 });
    start();
    await settle();

    assert.equal(await gateway.shutdown('SIGTERM'), 1);
    assert.deepEqual(calls, ['exit:1']);
    pendingOptimizers[0].resolve(resultFor(101));
    await settle();
  });
});
