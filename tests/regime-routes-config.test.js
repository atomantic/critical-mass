// @ts-check
/**
 * Round-trip tests for PUT/GET /api/:exchange/regime/config.
 *
 * Regression for the "dry-run toggle resets on refresh" bug: `dryRun` is a
 * fund/exchange-level field (GET reads it from getFundConfig -> fundBlock.dryRun),
 * but the PUT handler used to route the entire body — including dryRun — through
 * updateRegimeConfig, which nests it under pairs[pair].regime.dryRun where GET
 * never reads it. The toggle appeared to do nothing after a refresh.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const registerRegimeRoutes = require('../src/routes/regime-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// Fund in nested form with dryRun enabled at the fund level (mirrors live config).
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

describe('PUT/GET /api/:exchange/regime/config dryRun round-trip', () => {
  afterEach(() => mock.restoreAll());

  const setup = () => {
    setupFsMocks(BASE_CONFIG);
    const app = createFakeApp();
    // IPC is fire-and-forget here; a stub that resolves is enough.
    registerRegimeRoutes(app, { exchangeIPCMap: { cryptocom: { request: () => Promise.resolve({ success: true }) } } });
    return app;
  };

  const reqFor = (body) => ({ params: { exchange: 'cryptocom' }, query: { pair: 'CRO_USD' }, body });

  it('persists a dryRun=false toggle so a subsequent GET reflects it', async () => {
    const app = setup();

    const putRes = await invoke(app, 'PUT /api/:exchange/regime/config', reqFor({ dryRun: false }));
    assert.equal(putRes.statusCode, 200);
    assert.equal(putRes.body.success, true);

    const getRes = await invoke(app, 'GET /api/:exchange/regime/config', reqFor({}));
    assert.equal(getRes.body.config.dryRun, false, 'GET must reflect the toggled dryRun after a refresh');
  });

  it('rejects a non-boolean dryRun so it can never flip the fund to live trading', async () => {
    const app = setup();

    const res = await invoke(app, 'PUT /api/:exchange/regime/config', reqFor({ dryRun: 'false' }));
    assert.equal(res.statusCode, 400, 'a string dryRun must be rejected, not persisted');
    assert.equal(res.body.success, false);

    // The fund must remain in its original dry-run state, untouched.
    const getRes = await invoke(app, 'GET /api/:exchange/regime/config', reqFor({}));
    assert.equal(getRes.body.config.dryRun, true, 'dryRun must be unchanged after a rejected write');
  });

  it('persists dryRun even when bundled with regime field updates', async () => {
    const app = setup();

    await invoke(app, 'PUT /api/:exchange/regime/config', reqFor({ dryRun: false, baseSizeUsdc: 25 }));

    const getRes = await invoke(app, 'GET /api/:exchange/regime/config', reqFor({}));
    assert.equal(getRes.body.config.dryRun, false, 'dryRun must persist alongside regime updates');
    assert.equal(getRes.body.config.baseSizeUsdc, 25, 'regime field must still persist');
  });
});
