// @ts-check
/**
 * issue #546 — the Simple-DCA routes dropped the fund pair they had just
 * validated.
 *
 * `POST /api/:exchange/trade` and `POST /api/:exchange/consolidate` resolved
 * `?pair=` (400 on an unknown fund), logged it, ran their pre-checks against
 * that fund's state — and then called a pair-blind domain function, so the
 * order landed on the exchange's DEFAULT fund. Nothing in the response
 * contradicted the UI.
 *
 * These tests drive the real route handlers with a stubbed dca-engine and pin
 * the wiring: the validated pair is forwarded, it is echoed back, and omitting
 * it still resolves to the default fund for single-fund installs.
 *
 * Config I/O is mocked with the same two-file fs seam used by
 * tests/exchange-routes-lifecycle.test.js.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configUtils = require('../src/config-utils');
const migration = require('../src/migration');
const dcaEngine = require('../src/dca-engine');

const EXCHANGE_ROUTES = require.resolve('../src/routes/exchange-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

const realFs = {
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
};

const DEFAULT_PAIR = 'BTC-USDC';
const OTHER_PAIR = 'ETH-USDC';

// simpleDcaEnabled gates both routes; without it they short-circuit with 400.
const BASE_CONFIG = {
  global: { simpleDcaEnabled: true },
  exchanges: {
    coinbase: {
      pairs: {
        [DEFAULT_PAIR]: { productId: DEFAULT_PAIR, enabled: true, dryRun: false },
        [OTHER_PAIR]: { productId: OTHER_PAIR, enabled: true, dryRun: false },
      },
    },
  },
};

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), patch: register('PATCH'), post: register('POST'), delete: register('DELETE') };
};

const createRes = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

/** @type {string} */
let tempRoot;
/** @type {Object} */
let originals;
/** @type {Array<{fn: string, exchange: string, pair: string|undefined, orderIds: unknown}>} */
let engineCalls;
/** @type {ReturnType<typeof createFakeApp>} */
let app;

/** A fund's pending sells, so the consolidate route's own pre-check passes. */
const seedPendingOrders = (pair, count) => {
  const dir = path.join(tempRoot, 'coinbase', pair);
  realFs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    initialAllocation: 1000,
    totalAllocated: 0,
    usdcFundSize: 1000,
    orders: Array.from({ length: count }, (_, i) => ({
      orderId: `sell-${pair}-${i}`,
      buyOrderId: `buy-${pair}-${i}`,
      status: 'pending',
      sellQuantity: 0.01,
    })),
  }));
};

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-routes-fund-'));
  engineCalls = [];

  originals = {
    getExchangeDataDir: migration.getExchangeDataDir,
    runIntervalCycle: dcaEngine.runIntervalCycle,
    executeConsolidation: dcaEngine.executeConsolidation,
    reconcilePlacementIntent: dcaEngine.reconcilePlacementIntent,
  };

  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tempRoot, exchange);
    realFs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  configUtils._resetConfigCacheForTests();
  mock.method(fs, 'existsSync', (filePath) => (filePath === BASE_CONFIG_FILE ? true
    : filePath === USER_CONFIG_FILE ? false
      : realFs.existsSync(filePath)));
  mock.method(fs, 'readFileSync', (filePath, ...rest) => (filePath === BASE_CONFIG_FILE
    ? JSON.stringify(BASE_CONFIG)
    : realFs.readFileSync(filePath, ...rest)));
  let mtime = 0;
  mock.method(fs, 'statSync', (filePath) => (filePath === BASE_CONFIG_FILE
    ? { mtimeMs: ++mtime, mode: 0o600 }
    : realFs.statSync(filePath)));

  // The engine's own fund routing is covered by
  // tests/dca-engine-pair-scoping.test.js; here we only care what the route
  // hands it, and that the fund it reports comes back out.
  dcaEngine.runIntervalCycle = async (exchange, pair) => {
    engineCalls.push({ fn: 'runIntervalCycle', exchange, pair, orderIds: undefined });
    return { status: 'success', exchange, pair: pair ?? null };
  };
  dcaEngine.executeConsolidation = async (exchange, pair, orderIds) => {
    engineCalls.push({ fn: 'executeConsolidation', exchange, pair, orderIds });
    return { success: true, pair: pair ?? null, consolidatedCount: 2 };
  };
  dcaEngine.reconcilePlacementIntent = async (exchange, pair, intentId, action) => {
    engineCalls.push({ fn: 'reconcilePlacementIntent', exchange, pair, orderIds: [intentId, action] });
    return { success: true };
  };

  // exchange-routes destructures the engine's entry points at require time.
  delete require.cache[EXCHANGE_ROUTES];
  app = createFakeApp();
  require('../src/routes/exchange-routes')(app, {
    exchangeIPCMap: { coinbase: { request: async () => ({ success: true }) } },
    parseTSV: () => [],
    calculateCostBasis: () => ({}),
    getNextTradeInfo: () => ({}),
  });
});

afterEach(() => {
  mock.restoreAll();
  migration.getExchangeDataDir = originals.getExchangeDataDir;
  dcaEngine.runIntervalCycle = originals.runIntervalCycle;
  dcaEngine.executeConsolidation = originals.executeConsolidation;
  dcaEngine.reconcilePlacementIntent = originals.reconcilePlacementIntent;
  delete require.cache[EXCHANGE_ROUTES];
  configUtils._resetConfigCacheForTests();
  realFs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('POST /api/:exchange/trade fund routing (issue #546)', () => {
  it('forwards the validated pair to the engine and echoes it back', async () => {
    const res = await invoke(app, 'POST /api/:exchange/trade', {
      params: { exchange: 'coinbase' },
      query: { pair: OTHER_PAIR },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(engineCalls, [{ fn: 'runIntervalCycle', exchange: 'coinbase', pair: OTHER_PAIR, orderIds: undefined }]);
    assert.equal(res.body.pair, OTHER_PAIR, 'the response must name the fund that was traded');
    assert.equal(res.body.trigger, 'manual');
  });

  it('falls back to the default fund when no pair is given', async () => {
    const res = await invoke(app, 'POST /api/:exchange/trade', { params: { exchange: 'coinbase' } });

    assert.equal(engineCalls[0].pair, DEFAULT_PAIR);
    assert.equal(res.body.pair, DEFAULT_PAIR);
  });

  it('rejects an unknown fund before anything is placed', async () => {
    const res = await invoke(app, 'POST /api/:exchange/trade', {
      params: { exchange: 'coinbase' },
      query: { pair: 'DOGE-USDC' },
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(engineCalls, []);
  });
});

describe('POST /api/:exchange/consolidate fund routing (issue #546)', () => {
  it('consolidates the validated fund when the body carries no orderIds', async () => {
    // The shipped Dashboard posts `{}`; the fund selector is the only thing
    // standing between the operator and another fund's resting orders.
    seedPendingOrders(DEFAULT_PAIR, 3);
    seedPendingOrders(OTHER_PAIR, 2);

    const res = await invoke(app, 'POST /api/:exchange/consolidate', {
      params: { exchange: 'coinbase' },
      query: { pair: OTHER_PAIR },
      body: {},
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(engineCalls, [{ fn: 'executeConsolidation', exchange: 'coinbase', pair: OTHER_PAIR, orderIds: undefined }]);
    assert.equal(res.body.pair, OTHER_PAIR);
  });

  it('refuses when the SELECTED fund is short of pending orders, even if another fund has enough', async () => {
    seedPendingOrders(DEFAULT_PAIR, 5);
    seedPendingOrders(OTHER_PAIR, 1);

    const res = await invoke(app, 'POST /api/:exchange/consolidate', {
      params: { exchange: 'coinbase' },
      query: { pair: OTHER_PAIR },
      body: {},
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /found 1/);
    assert.deepEqual(engineCalls, [], 'no fund may have its resting orders cancelled');
  });

  it('falls back to the default fund when no pair is given', async () => {
    seedPendingOrders(DEFAULT_PAIR, 2);

    const res = await invoke(app, 'POST /api/:exchange/consolidate', {
      params: { exchange: 'coinbase' },
      body: {},
    });

    assert.equal(engineCalls[0].pair, DEFAULT_PAIR);
    assert.equal(res.body.pair, DEFAULT_PAIR);
  });
});

describe('POST /api/:exchange/reconcile-placement-intent fund routing (issue #546)', () => {
  it('reconciles against the named fund (intents are stored per fund)', async () => {
    const res = await invoke(app, 'POST /api/:exchange/reconcile-placement-intent', {
      params: { exchange: 'coinbase' },
      query: { pair: OTHER_PAIR },
      body: { intentId: 'intent-1', action: 'discard' },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(engineCalls[0].pair, OTHER_PAIR);
    assert.equal(res.body.pair, OTHER_PAIR);
  });

  it('rejects an unknown fund', async () => {
    const res = await invoke(app, 'POST /api/:exchange/reconcile-placement-intent', {
      params: { exchange: 'coinbase' },
      query: { pair: 'DOGE-USDC' },
      body: { intentId: 'intent-1', action: 'discard' },
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(engineCalls, []);
  });
});
