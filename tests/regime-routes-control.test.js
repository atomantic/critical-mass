// @ts-check
/**
 * Route tests for the regime engine's operational control endpoints
 * (issue #407): lifecycle start/close/reopen, force-regime and set-body-tp
 * parameter validation, and the GET /status offline fallback.
 *
 * These mock the IPC boundary (`exchangeIPCMap[exchange].request`) rather
 * than starting a real engine, mirroring tests/regime-routes-config.test.js.
 * The offline-status tests additionally mock `buildStoppedRegimeStatus`
 * (src/regime-status.js) at the module boundary — that function's own
 * derivation logic (fill-ledger P&L re-derivation, disk-state fallback) is
 * already covered by tests/regime-status.test.js; here we only verify the
 * route wires the IPC-down branch to it correctly.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const regimeStatusModule = require('../src/regime-status');
const stateTracker = require('../src/state-tracker');
const ROUTES_PATH = require.resolve('../src/routes/regime-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// Fund in nested form (mirrors live config); mirrors regime-routes-config.test.js.
const BASE_CONFIG = {
  exchanges: {
    cryptocom: {
      pairs: {
        CRO_USD: {
          productId: 'CRO_USD',
          enabled: true,
          dryRun: true,
          regime: { enabled: true, baseSizeUsdc: 10 },
        },
      },
    },
  },
};

const setupFsMocks = (base) => {
  let writtenData = base;
  configUtils._resetConfigCacheForTests();

  mock.method(fs, 'existsSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return base !== null;
    if (filePath === USER_CONFIG_FILE) return writtenData !== null;
    return false;
  });
  mock.method(fs, 'readFileSync', (filePath) => {
    if (filePath === USER_CONFIG_FILE && writtenData !== null) return JSON.stringify(writtenData);
    if (filePath === BASE_CONFIG_FILE && base !== null) return JSON.stringify(base);
    throw new Error(`ENOENT: ${filePath}`);
  });
  let mtime = 0;
  mock.method(fs, 'statSync', (filePath) => {
    if (filePath === USER_CONFIG_FILE && writtenData !== null) return { mtimeMs: ++mtime };
    if (filePath === BASE_CONFIG_FILE && base !== null) return { mtimeMs: ++mtime };
    const err = new Error(`ENOENT: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  });
  mock.method(fs, 'writeFileSync', (filePath, data) => {
    if (filePath === USER_CONFIG_FILE || String(filePath).startsWith(USER_CONFIG_FILE + '.')) {
      writtenData = JSON.parse(data);
      configUtils._resetConfigCacheForTests();
    }
  });
  mock.method(fs, 'renameSync', () => {});
  mock.method(fs, 'mkdirSync', () => {});
};

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST') };
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

const reqFor = (body) => ({ params: { exchange: 'cryptocom' }, query: { pair: 'CRO_USD' }, body });

// Re-requires regime-routes.js with a clean module cache so it re-destructures
// `buildStoppedRegimeStatus` from src/regime-status.js at its *current*
// (possibly mocked) value. Needed because regime-routes.js destructures that
// import once at module-load time, so a mock applied after the module was
// already loaded would never be observed otherwise.
const requireFreshRoutes = () => {
  delete require.cache[ROUTES_PATH];
  return require('../src/routes/regime-routes');
};

const setupApp = (request) => {
  // Re-require BEFORE mocking fs: module loading itself goes through
  // fs.readFileSync, so it must happen while fs is still real.
  const registerRegimeRoutes = requireFreshRoutes();
  setupFsMocks(BASE_CONFIG);
  const app = createFakeApp();
  registerRegimeRoutes(app, { exchangeIPCMap: { cryptocom: { request } } });
  return app;
};

describe('GET /api/:exchange/regime/status', () => {
  afterEach(() => mock.restoreAll());

  it('passes through a live IPC status response unchanged', async () => {
    const liveStatus = { success: true, status: { isRunning: true, health: { mode: 'RUNNING' } } };
    const app = setupApp(() => Promise.resolve(liveStatus));

    const res = await invoke(app, 'GET /api/:exchange/regime/status', reqFor({}));

    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.body, liveStatus);
  });

  it('falls back to buildStoppedRegimeStatus (engineDown: true) when IPC connection fails', async () => {
    const offlineStatus = { isRunning: false, health: { mode: 'ENGINE_DOWN' }, position: null };
    const statusMock = mock.method(regimeStatusModule, 'buildStoppedRegimeStatus', () => offlineStatus);
    const app = setupApp(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const res = await invoke(app, 'GET /api/:exchange/regime/status', reqFor({}));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.engineDown, true);
    assert.deepStrictEqual(res.body.status, offlineStatus);
    assert.match(res.body.engineError, /ECONNREFUSED/);

    // Verify the route asked for the engine-down synthesis, not a clean stop.
    assert.equal(statusMock.mock.calls.length, 1);
    const [exchange, pair, options] = statusMock.mock.calls[0].arguments;
    assert.equal(exchange, 'cryptocom');
    assert.equal(pair, 'CRO_USD');
    assert.equal(options.mode, 'ENGINE_DOWN');
    assert.equal(options.requireExistingState, true);
  });

  it('returns 503 when IPC connection fails and there is no persisted state to synthesize from', async () => {
    mock.method(regimeStatusModule, 'buildStoppedRegimeStatus', () => null);
    const app = setupApp(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const res = await invoke(app, 'GET /api/:exchange/regime/status', reqFor({}));

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /ECONNREFUSED/);
  });

  it('returns 503 on a request timeout WITHOUT masking it as an offline/stopped engine', async () => {
    const statusMock = mock.method(regimeStatusModule, 'buildStoppedRegimeStatus', () => ({ isRunning: false }));
    const app = setupApp(() => Promise.reject(new Error('request timeout')));

    const res = await invoke(app, 'GET /api/:exchange/regime/status', reqFor({}));

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /request timeout/i);
    assert.equal(res.body.engineDown, undefined, 'a slow-but-alive engine must not be reported as engineDown');
    assert.equal(statusMock.mock.calls.length, 0, 'the offline synthesizer must be skipped on timeout — the engine may still be running');
  });
});

describe('POST /api/:exchange/regime/close', () => {
  afterEach(() => mock.restoreAll());

  it('forwards the reason to the regime:close IPC op and passes the response through', async () => {
    let seen;
    const app = setupApp((op, payload, exchange, pair) => {
      seen = { op, payload, exchange, pair };
      return Promise.resolve({ success: true, message: 'Draining — new entries blocked' });
    });

    const res = await invoke(app, 'POST /api/:exchange/regime/close', reqFor({ reason: 'operator requested' }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(seen.op, 'regime:close');
    assert.equal(seen.payload.reason, 'operator requested');
    assert.equal(seen.exchange, 'cryptocom');
    assert.equal(seen.pair, 'CRO_USD');
  });

  it('omits a non-string reason rather than forwarding a bad value', async () => {
    let seen;
    const app = setupApp((op, payload) => {
      seen = payload;
      return Promise.resolve({ success: true });
    });

    await invoke(app, 'POST /api/:exchange/regime/close', reqFor({ reason: 12345 }));

    assert.equal(seen.reason, undefined);
  });

  it('maps an IPC outage to a 503', async () => {
    const app = setupApp(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const res = await invoke(app, 'POST /api/:exchange/regime/close', reqFor({}));

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
  });
});

describe('POST /api/:exchange/regime/reopen', () => {
  afterEach(() => mock.restoreAll());

  it('forwards to the regime:reopen IPC op with the resolved pair', async () => {
    let seen;
    const app = setupApp((op, payload, exchange, pair) => {
      seen = { op, exchange, pair };
      return Promise.resolve({ success: true, message: 'Fund reopened' });
    });

    const res = await invoke(app, 'POST /api/:exchange/regime/reopen', reqFor({}));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(seen.op, 'regime:reopen');
    assert.equal(seen.exchange, 'cryptocom');
    assert.equal(seen.pair, 'CRO_USD');
  });

  it('maps an IPC outage to a 503', async () => {
    const app = setupApp(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const res = await invoke(app, 'POST /api/:exchange/regime/reopen', reqFor({}));

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
  });
});

describe('POST /api/:exchange/regime/force-regime', () => {
  afterEach(() => mock.restoreAll());

  for (const badRegime of ['BULL', 'CRASH']) {
    it(`rejects an unknown regime (${badRegime}) with 400 and never calls IPC`, async () => {
      let ipcCalls = 0;
      const app = setupApp(() => { ipcCalls += 1; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'POST /api/:exchange/regime/force-regime', reqFor({ regime: badRegime }));

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /Invalid regime/);
      assert.equal(ipcCalls, 0);
    });
  }

  it('rejects a missing regime with 400', async () => {
    const app = setupApp(() => Promise.resolve({ success: true }));

    const res = await invoke(app, 'POST /api/:exchange/regime/force-regime', reqFor({}));

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  it('accepts a valid regime, normalizing case, and forwards it uppercase over IPC', async () => {
    let seen;
    const app = setupApp((op, payload) => {
      seen = { op, payload };
      return Promise.resolve({ success: true, message: 'Regime forced to HARVEST' });
    });

    const res = await invoke(app, 'POST /api/:exchange/regime/force-regime', reqFor({ regime: 'harvest', reason: 'macro shift' }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(seen.op, 'regime:force-regime');
    assert.equal(seen.payload.regime, 'HARVEST');
    assert.equal(seen.payload.reason, 'macro shift');
  });
});

describe('POST /api/:exchange/regime/set-body-tp', () => {
  afterEach(() => mock.restoreAll());

  it('rejects a missing bodyId with 400 and never calls IPC', async () => {
    let ipcCalls = 0;
    const app = setupApp(() => { ipcCalls += 1; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp', reqFor({ tpPct: 10 }));

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /bodyId is required/);
    assert.equal(ipcCalls, 0);
  });

  for (const tpPct of [0, -5]) {
    it(`rejects tpPct <= 0 (${tpPct}) with 400`, async () => {
      const app = setupApp(() => Promise.resolve({ success: true }));

      const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp', reqFor({ bodyId: 'body-1', tpPct }));

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /tpPct must be a number between 0 and 50/);
    });
  }

  it('rejects tpPct > 50 with 400', async () => {
    const app = setupApp(() => Promise.resolve({ success: true }));

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp', reqFor({ bodyId: 'body-1', tpPct: 51 }));

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /tpPct must be a number between 0 and 50/);
  });

  it('rejects a non-numeric tpPct with 400', async () => {
    const app = setupApp(() => Promise.resolve({ success: true }));

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp', reqFor({ bodyId: 'body-1', tpPct: 'not-a-number' }));

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /tpPct must be a number between 0 and 50/);
  });

  it('accepts a valid tpPct, forwarding the parsed float to IPC', async () => {
    let seen;
    const app = setupApp((op, payload) => {
      seen = { op, payload };
      return Promise.resolve({ success: true });
    });

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp', reqFor({ bodyId: 'body-1', tpPct: '12.5' }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.op, 'regime:set-body-tp');
    assert.equal(seen.payload.bodyId, 'body-1');
    assert.equal(seen.payload.tpPct, 12.5);
  });
});

describe('POST /api/:exchange/regime/set-body-tp-price', () => {
  afterEach(() => mock.restoreAll());

  it('rejects a missing bodyId with 400', async () => {
    const app = setupApp(() => Promise.resolve({ success: true }));

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp-price', reqFor({ limitPrice: 100 }));

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /bodyId is required/);
  });

  for (const limitPrice of [0, -1]) {
    it(`rejects a non-positive limitPrice (${limitPrice}) with 400`, async () => {
      const app = setupApp(() => Promise.resolve({ success: true }));

      const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp-price', reqFor({ bodyId: 'body-1', limitPrice }));

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /limitPrice must be a positive number/);
    });
  }

  it('accepts a valid limitPrice, forwarding the parsed float to IPC', async () => {
    let seen;
    const app = setupApp((op, payload) => {
      seen = { op, payload };
      return Promise.resolve({ success: true });
    });

    const res = await invoke(app, 'POST /api/:exchange/regime/set-body-tp-price', reqFor({ bodyId: 'body-1', limitPrice: '0.045' }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.op, 'regime:set-body-tp-price');
    assert.equal(seen.payload.bodyId, 'body-1');
    assert.equal(seen.payload.limitPrice, 0.045);
  });
});

// Issue #454: apply/preview/merge/createBody are read-only-vs-mutating
// selectors. A malformed value (string "false", number, array, object, null)
// must be rejected with zero IPC forwarding — not truthiness-coerced into the
// mutating branch.
const NON_BOOLEAN_FLAG_VALUES = ['false', 'true', 0, 1, [], {}, null];

describe('POST /api/:exchange/regime/recalculate', () => {
  afterEach(() => mock.restoreAll());

  for (const apply of NON_BOOLEAN_FLAG_VALUES) {
    it(`rejects a non-boolean apply (${JSON.stringify(apply)}) with 400 and never calls IPC`, async () => {
      let called = false;
      const app = setupApp(() => { called = true; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'POST /api/:exchange/regime/recalculate', reqFor({ apply }));

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /apply must be a boolean/);
      assert.equal(called, false, 'IPC must not be reached for a rejected flag');
    });
  }

  it('defaults omitted apply to false (preview)', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/recalculate', reqFor({}));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.apply, false);
  });

  it('forwards a literal true apply', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/recalculate', reqFor({ apply: true }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.apply, true);
  });
});

describe('POST /api/:exchange/regime/convert-dca', () => {
  afterEach(() => mock.restoreAll());

  for (const preview of NON_BOOLEAN_FLAG_VALUES) {
    it(`rejects a non-boolean preview (${JSON.stringify(preview)}) with 400 and never calls IPC`, async () => {
      let called = false;
      const app = setupApp(() => { called = true; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'POST /api/:exchange/regime/convert-dca', reqFor({ preview }));

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /preview must be a boolean/);
      assert.equal(called, false);
    });
  }

  for (const merge of NON_BOOLEAN_FLAG_VALUES) {
    it(`rejects a non-boolean merge (${JSON.stringify(merge)}) with 400 and never calls IPC`, async () => {
      let called = false;
      const app = setupApp(() => { called = true; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'POST /api/:exchange/regime/convert-dca', reqFor({ preview: false, merge }));

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /merge must be a boolean/);
      assert.equal(called, false);
    });
  }

  it('defaults omitted flags to preview=true, merge=false', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/convert-dca', reqFor({}));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.preview, true);
    assert.equal(seen.merge, false);
  });

  it('forwards literal preview=false, merge=true', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/convert-dca', reqFor({ preview: false, merge: true }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.preview, false);
    assert.equal(seen.merge, true);
  });
});

describe('POST /api/:exchange/regime/manual-trade-buy', () => {
  afterEach(() => mock.restoreAll());

  for (const createBody of NON_BOOLEAN_FLAG_VALUES) {
    it(`rejects a non-boolean createBody (${JSON.stringify(createBody)}) with 400 and never calls IPC`, async () => {
      let called = false;
      const app = setupApp(() => { called = true; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'POST /api/:exchange/regime/manual-trade-buy', reqFor({ buyOrderId: 'buy-1', createBody }));

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /createBody must be a boolean/);
      assert.equal(called, false, 'IPC must not be reached for a rejected flag — no body/TP is created');
    });
  }

  it('defaults omitted createBody to true and preserves other body fields', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/manual-trade-buy', reqFor({ buyOrderId: 'buy-1', note: 'n' }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.buyOrderId, 'buy-1');
    assert.equal(seen.note, 'n');
    assert.equal(seen.createBody, true);
  });

  it('forwards a literal false createBody (ledger-only import)', async () => {
    let seen;
    const app = setupApp((op, payload) => { seen = payload; return Promise.resolve({ success: true }); });

    const res = await invoke(app, 'POST /api/:exchange/regime/manual-trade-buy', reqFor({ buyOrderId: 'buy-1', createBody: false }));

    assert.equal(res.statusCode, 200);
    assert.equal(seen.createBody, false);
  });
});


describe('placement intent discard respects engine ownership', () => {
  afterEach(() => mock.restoreAll());

  const setup = (ipc) => {
    const discard = mock.method(stateTracker, 'resolvePlacementIntent', () => true);
    const register = requireFreshRoutes();
    setupFsMocks(BASE_CONFIG);
    const app = createFakeApp();
    register(app, { exchangeIPCMap: ipc ? { cryptocom: ipc } : {} });
    return { app, discard };
  };

  for (const kind of ['refusal', 'timeout']) {
    it(`does not discard on disk after a connected engine ${kind}`, async () => {
      const { app, discard } = setup({
        isConnected: () => true,
        request: () => kind === 'refusal'
          ? Promise.resolve({ success: false, code: 'maintenance-in-progress', error: 'Engine in maintenance' })
          : Promise.reject(new Error('IPC request timeout')),
      });
      const res = await invoke(app, 'POST /api/:exchange/regime/reconcile-placement-intent', reqFor({ intentId: 'intent-1', action: 'discard' }));
      assert.equal(res.statusCode, kind === 'refusal' ? 400 : 503);
      assert.equal(res.body.success, false);
      assert.equal(res.body.engineDown, undefined);
      assert.equal(discard.mock.callCount(), 0);
    });
  }

  for (const missing of [false, true]) {
    it(`allows explicit offline discard with ${missing ? 'missing' : 'disconnected'} IPC`, async () => {
      const { app, discard } = setup(missing ? null : {
        isConnected: () => false,
        request: () => Promise.reject(new Error('IPC disconnected')),
      });
      const res = await invoke(app, 'POST /api/:exchange/regime/reconcile-placement-intent', reqFor({ intentId: 'intent-1', action: 'discard' }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.engineDown, true);
      assert.deepEqual(discard.mock.calls[0].arguments, ['cryptocom', 'CRO_USD', 'intent-1']);
    });
  }
});
