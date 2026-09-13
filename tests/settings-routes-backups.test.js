// @ts-check
/**
 * Coverage for PUT /api/backups/config (issue #547): the route previously
 * spread `req.body` straight into persisted config with no validation, so a
 * bad `intervalMs` reached `setInterval` (Node clamps a non-positive/NaN
 * delay to ~1ms, spinning a backup loop) and a bad `maxBackups` reached
 * `pruneBackups`'s raw slice (`0`/`null` deletes every stored archive). This
 * asserts the route now validates via BACKUP_CONFIG_SCHEMA like every sibling
 * settings route, rejects out-of-range/wrong-type input with 400 and leaves
 * the stored config untouched, drops unknown keys, and that a valid PUT still
 * round-trips against GET.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const registerSettingsRoutes = require('../src/routes/settings-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

const BASE_CONFIG = {
  exchanges: { coinbase: { productId: 'BTC-USDC' } },
  global: {
    backup: {
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      maxBackups: 7,
      includePriceCache: false,
    },
  },
};

const setupFsMocks = (base) => {
  let writtenData = null;
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

describe('PUT /api/backups/config', () => {
  afterEach(() => {
    mock.restoreAll();
    configUtils._resetConfigCacheForTests();
  });

  const setup = () => {
    setupFsMocks(BASE_CONFIG);
    let rescheduleCalls = 0;
    const app = createFakeApp();
    registerSettingsRoutes(app, {
      notifier: { updateConfig: () => {}, sendTest: async () => ({ success: true }), getStats: () => ({}) },
      exchangeIPCMap: {},
      rescheduleBackupTimer: () => { rescheduleCalls++; },
    });
    return { app, getRescheduleCalls: () => rescheduleCalls };
  };

  const getConfig = (app) => invoke(app, 'GET /api/backups/config');
  const putConfig = (app, body) => invoke(app, 'PUT /api/backups/config', { body });

  const invalidCases = [
    { label: 'intervalMs: 0', body: { intervalMs: 0 } },
    { label: 'intervalMs: negative', body: { intervalMs: -1 } },
    { label: 'intervalMs: below the 5-minute floor', body: { intervalMs: 299999 } },
    { label: 'intervalMs: non-numeric string', body: { intervalMs: 'soon' } },
    { label: 'intervalMs: null', body: { intervalMs: null } },
    { label: 'intervalMs: NaN', body: { intervalMs: NaN } },
    { label: 'intervalMs: Infinity', body: { intervalMs: Infinity } },
    { label: 'maxBackups: 0', body: { maxBackups: 0 } },
    { label: 'maxBackups: null', body: { maxBackups: null } },
    { label: 'maxBackups: negative', body: { maxBackups: -1 } },
    { label: 'maxBackups: above the ceiling', body: { maxBackups: 101 } },
    { label: 'maxBackups: non-integer', body: { maxBackups: 2.5 } },
    { label: 'maxBackups: numeric string', body: { maxBackups: '5' } },
    { label: 'enabled: non-boolean', body: { enabled: 'true' } },
    { label: 'includePriceCache: non-boolean', body: { includePriceCache: 'yes' } },
  ];

  for (const { label, body } of invalidCases) {
    it(`rejects ${label} with 400 and leaves stored config unchanged`, async () => {
      const { app, getRescheduleCalls } = setup();
      const before = await getConfig(app);
      const res = await putConfig(app, body);
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.length > 0);
      assert.deepStrictEqual((await getConfig(app)).body, before.body);
      assert.equal(getRescheduleCalls(), 0);
    });
  }

  it('drops an unknown key instead of persisting it', async () => {
    const { app } = setup();
    const res = await putConfig(app, { maxBackups: 3, unknownKey: 'sneaky' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.config.maxBackups, 3);
    assert.equal(res.body.config.unknownKey, undefined);
    assert.equal(configUtils.getBackupConfig().unknownKey, undefined);
  });

  it('accepts a valid update, persists it, reschedules the timer, and round-trips against GET', async () => {
    const { app, getRescheduleCalls } = setup();
    const res = await putConfig(app, {
      enabled: false,
      intervalMs: 21600000,
      maxBackups: 14,
      includePriceCache: true,
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.config.enabled, false);
    assert.equal(res.body.config.intervalMs, 21600000);
    assert.equal(res.body.config.maxBackups, 14);
    assert.equal(res.body.config.includePriceCache, true);
    assert.equal(getRescheduleCalls(), 1);

    const read = await getConfig(app);
    assert.deepStrictEqual(read.body.config, res.body.config);
  });

  it('boundary values for intervalMs and maxBackups are accepted', async () => {
    const { app } = setup();
    const res = await putConfig(app, { intervalMs: 300000, maxBackups: 1 });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.config.intervalMs, 300000);
    assert.equal(res.body.config.maxBackups, 1);

    const res2 = await putConfig(app, { maxBackups: 100 });
    assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
    assert.equal(res2.body.config.maxBackups, 100);
  });
});
