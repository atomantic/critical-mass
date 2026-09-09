// @ts-check
// Actual save/read/apply handlers with in-memory persistence and stubbed IPC.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const registerSettingsRoutes = require('../src/routes/settings-routes');
const { DEFAULT_AGGRESSIVENESS_PRESETS, PRESET_KEYS, PRESET_FIELD_RULES } = require('../src/regime-preset-contract');
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
  let writtenData = structuredClone(base);
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
  return { handlers, get: register('GET'), put: register('PUT'), post: register('POST'), delete: register('DELETE') };
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


describe('aggressiveness preset save/read/apply contract', () => {
  afterEach(() => {
    mock.restoreAll();
    configUtils._resetConfigCacheForTests();
  });

  const setup = () => {
    setupFsMocks({
      ...BASE_CONFIG,
      global: { aggressivenessPresets: { moderate: { entryOffsetBps: 20, targetMarkup: 0.2 } } },
    });
    const calls = [];
    const app = createFakeApp();
    const deps = {
      exchangeIPCMap: { cryptocom: { request: (...args) => {
        calls.push(args);
        return Promise.resolve({ success: true });
      } } },
    };
    registerSettingsRoutes(app, deps);
    registerRegimeRoutes(app, deps);
    return { app, calls };
  };
  const getPresets = app => invoke(app, 'GET /api/presets/aggressiveness');
  const savePreset = (app, update) => invoke(app, 'PUT /api/presets/aggressiveness', { body: { moderate: update } });
  const fundReq = body => ({ params: { exchange: 'cryptocom' }, query: { pair: 'CRO_USD' }, body });

  it('persists merge proximity, preserves stored overrides, and only applies on an explicit fund PUT', async () => {
    const { app, calls } = setup();
    const beforeFund = await invoke(app, 'GET /api/:exchange/regime/config', fundReq({}));
    const saved = await savePreset(app, { mergeProximityScale: 2, unknownPresetKey: 99 });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.success, true);
    assert.equal(saved.body.presets.moderate.mergeProximityScale, 2);
    const read = await getPresets(app);
    assert.deepStrictEqual(read.body, saved.body);
    assert.equal(read.body.presets.moderate.entryOffsetBps, 20);
    assert.equal(read.body.presets.moderate.targetMarkup, 0.2);
    assert.equal(read.body.presets.moderate.unknownPresetKey, undefined);
    assert.deepStrictEqual(read.body.presets.conservative, DEFAULT_AGGRESSIVENESS_PRESETS.conservative);
    assert.equal(calls.length, 0);
    const untouched = await invoke(app, 'GET /api/:exchange/regime/config', fundReq({}));
    assert.deepStrictEqual(untouched.body, beforeFund.body);

    // Dashboard selection and Apply Suggested spread the API preset into this PUT.
    const applied = await invoke(app, 'PUT /api/:exchange/regime/config',
      fundReq({ aggressiveness: 'moderate', ...read.body.presets.moderate }));
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.body.success, true);
    const fund = await invoke(app, 'GET /api/:exchange/regime/config', fundReq({}));
    for (const key of PRESET_KEYS) {
      assert.equal(fund.body.config[key], read.body.presets.moderate[key], key);
      assert.equal(calls[0][1][key], read.body.presets.moderate[key], key);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'regime:update-config');
    assert.equal(calls[0][1].targetMarkup, undefined, 'legacy schema-only fields stay outside the fund contract');
    assert.equal(fund.body.config.dryRun, true);
    assert.equal(fund.body.config.baseSizeUsdc, 10);
  });

  it('saves and applies every declared preset in full', async () => {
    const { app } = setup();
    for (const [level, preset] of Object.entries(DEFAULT_AGGRESSIVENESS_PRESETS)) {
      const saved = await invoke(app, 'PUT /api/presets/aggressiveness', { body: { [level]: preset } });
      assert.equal(saved.statusCode, 200, level);
      const read = await getPresets(app);
      for (const key of Object.keys(preset)) assert.equal(read.body.presets[level][key], preset[key], key);
      const applied = await invoke(app, 'PUT /api/:exchange/regime/config',
        fundReq({ aggressiveness: level, ...read.body.presets[level] }));
      assert.equal(applied.statusCode, 200, JSON.stringify(applied.body));
      for (const key of Object.keys(preset)) assert.equal(applied.body.config[key], preset[key], key);
    }
  });

  it('saves, reads and applies both boundaries for every canonical field', async () => {
    const { app } = setup();
    for (const key of PRESET_KEYS) {
      for (const value of [PRESET_FIELD_RULES[key].min, PRESET_FIELD_RULES[key].max]) {
        const saved = await savePreset(app, { [key]: value });
        assert.equal(saved.statusCode, 200, key);
        const read = await getPresets(app);
        assert.equal(read.body.presets.moderate[key], value, key);
        const applied = await invoke(app, 'PUT /api/:exchange/regime/config',
          fundReq({ aggressiveness: 'moderate', ...read.body.presets.moderate }));
        assert.equal(applied.statusCode, 200, JSON.stringify(applied.body));
        assert.equal(applied.body.config[key], value, key);
      }
    }
  });

  it('rejects conflicting ranges and invalid merge proximity without partial writes or IPC', async () => {
    const { app, calls } = setup();
    const before = await getPresets(app);
    const invalidUpdates = [
      { kFactor: 0.9 }, { minIntervalMs: 1000 }, { maxIntervalMs: 86400000 }, { maxCycleBuys: 1 },
      ...[0.24, 3.01, NaN, Infinity, -Infinity, null, '2'].map(mergeProximityScale => ({ mergeProximityScale })),
    ];
    for (const update of invalidUpdates) {
      const rejected = await invoke(app, 'PUT /api/presets/aggressiveness', {
        body: { conservative: { kFactor: 0.7 }, moderate: update },
      });
      assert.equal(rejected.statusCode, 400, JSON.stringify(update));
      assert.equal(rejected.body.success, false);
      assert.ok(rejected.body.errors.length);
      assert.deepStrictEqual((await getPresets(app)).body, before.body);
      const fund = await invoke(app, 'PUT /api/:exchange/regime/config', fundReq(update));
      assert.equal(fund.statusCode, 400, JSON.stringify(update));
    }
    assert.equal(calls.length, 0);
  });
});
