// @ts-check
/**
 * Round-trip tests for PUT /api/:exchange/config (the endpoint the config
 * editor's "Save Configuration" button calls).
 *
 * Regression for the "can't save config" bug: the config editor GETs the full
 * stored fund config and PUTs it back verbatim. A fund whose persisted regime
 * block carried a key that was later removed from the engine (e.g.
 * satelliteTpEnabled) used to make the handler 400 with "Unknown regime keys",
 * so the fund became permanently unsaveable — toggling dryRun and saving
 * silently failed. The handler now DROPS unknown regime keys (keeping the
 * security intent — they're never persisted) so the save succeeds and the
 * stale key is stripped on the way through.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const registerExchangeRoutes = require('../src/routes/exchange-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// A coinbase fund whose stored regime block carries three dead keys (mirrors the
// live coinbase/BTC-USDC config that triggered the bug).
const BASE_CONFIG = {
  exchanges: {
    coinbase: {
      pairs: {
        'BTC-USDC': {
          productId: 'BTC-USDC',
          enabled: true,
          dryRun: true,
          regime: {
            enabled: true,
            baseSizeUsdc: 50,
            satelliteTpEnabled: true,        // dead key — removed from engine
            tpMergeMinImprovementPct: 0.5,   // dead key
            maxSatelliteOrders: 4,           // dead key
          },
        },
      },
    },
  },
};

// Mirrors void's layout: the full config (with the dead keys) lives in the BASE
// config.json; saveConfig writes only a diff to the USER data/config.json, and
// loads deepMerge base+user. This is the exact arrangement that makes the
// self-heal-on-disk impossible — the test pins the real contract: the save
// succeeds and the dropped keys never enter the persisted user overrides.
const setupFsMocks = (base) => {
  let userData = null; // the user-override diff written by saveConfig
  configUtils._resetConfigCacheForTests();

  mock.method(fs, 'existsSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return base !== null;
    if (filePath === USER_CONFIG_FILE) return userData !== null;
    return false;
  });
  mock.method(fs, 'readFileSync', (filePath) => {
    if (filePath === USER_CONFIG_FILE && userData !== null) return JSON.stringify(userData);
    if (filePath === BASE_CONFIG_FILE && base !== null) return JSON.stringify(base);
    throw new Error(`ENOENT: ${filePath}`);
  });
  let mtime = 0;
  mock.method(fs, 'statSync', (filePath) => {
    if (filePath === USER_CONFIG_FILE && userData !== null) return { mtimeMs: ++mtime, mode: 0o600 };
    if (filePath === BASE_CONFIG_FILE && base !== null) return { mtimeMs: ++mtime, mode: 0o600 };
    const err = new Error(`ENOENT: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  });
  mock.method(fs, 'writeFileSync', (filePath, data) => {
    if (filePath === USER_CONFIG_FILE || String(filePath).startsWith(USER_CONFIG_FILE + '.')) {
      userData = JSON.parse(data);
      configUtils._resetConfigCacheForTests();
    }
  });
  mock.method(fs, 'renameSync', () => {});
  mock.method(fs, 'mkdirSync', () => {});

  return { user: () => userData };
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

describe('PUT /api/:exchange/config tolerates stale regime keys', () => {
  afterEach(() => mock.restoreAll());

  const setup = () => {
    const fsMocks = setupFsMocks(BASE_CONFIG);
    const app = createFakeApp();
    registerExchangeRoutes(app, {
      exchangeIPCMap: { coinbase: { request: () => Promise.resolve({ success: true }) } },
      parseTSV: () => [],
      calculateCostBasis: () => ({}),
      getNextTradeInfo: () => ({}),
    });
    return { app, fsMocks };
  };

  const reqFor = (body) => ({ params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' }, body });

  it('saves a full round-trip config that carries dead regime keys (no 400)', async () => {
    const { app } = setup();

    // Simulate the editor: GET the full config, flip dryRun, PUT it back verbatim.
    const got = await invoke(app, 'GET /api/:exchange/config', reqFor({}));
    const fullConfig = { ...got.body, dryRun: false };
    assert.ok('satelliteTpEnabled' in fullConfig.regime, 'precondition: GET returns the dead key');

    const res = await invoke(app, 'PUT /api/:exchange/config', reqFor(fullConfig));
    assert.equal(res.statusCode, 200, `save must not 400 (got ${res.statusCode}: ${JSON.stringify(res.body)})`);
    assert.equal(res.body.success, true);
  });

  it('persists the dryRun change and never writes the dead keys into the overrides', async () => {
    const { app, fsMocks } = setup();
    const got = await invoke(app, 'GET /api/:exchange/config', reqFor({}));
    await invoke(app, 'PUT /api/:exchange/config', reqFor({ ...got.body, dryRun: false }));

    const after = await invoke(app, 'GET /api/:exchange/config', reqFor({}));
    assert.equal(after.body.dryRun, false, 'dryRun change must persist');
    assert.equal(after.body.regime.baseSizeUsdc, 50, 'known regime field must survive');
    assert.equal(after.body.regime.enabled, true, 'known regime field must survive');

    // The dropped keys must never be written into the persisted user overrides
    // (they stay inert in the base file but are never propagated forward or to
    // the engine). Assert against what saveConfig actually wrote to disk.
    const written = JSON.stringify(fsMocks.user());
    assert.ok(!written.includes('satelliteTpEnabled'), 'dead key must not enter saved overrides');
    assert.ok(!written.includes('tpMergeMinImprovementPct'), 'dead key must not enter saved overrides');
    assert.ok(!written.includes('maxSatelliteOrders'), 'dead key must not enter saved overrides');
  });
});
