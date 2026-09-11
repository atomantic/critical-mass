// @ts-check
/**
 * Coverage for the notification config endpoints in settings-routes.js
 * (issue #426): PUT /api/notifications/config must validate the fields that
 * feed notifier.js timer arithmetic (dailySummaryHour, rateLimitMs,
 * quietHours.start/end, the boolean flags), rejecting bad input with 400
 * and leaving the stored config untouched, and must never let a masked
 * bot token round-trip overwrite the real stored token.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const registerSettingsRoutes = require('../src/routes/settings-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

const SECRET_TOKEN = '123456:SECRET-BOT-TOKEN-abcdef';

const BASE_CONFIG = {
  exchanges: { coinbase: { productId: 'BTC-USDC' } },
  global: {
    notifications: {
      enabled: true,
      telegram: { botToken: SECRET_TOKEN, chatId: '999' },
      rateLimitMs: 5000,
      dailySummaryHour: 20,
      quietHours: { enabled: false, start: 23, end: 7 },
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

  return { written: () => writtenData };
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

describe('PUT /api/notifications/config', () => {
  afterEach(() => {
    mock.restoreAll();
    configUtils._resetConfigCacheForTests();
  });

  const setup = () => {
    const fsMocks = setupFsMocks(BASE_CONFIG);
    let updateConfigCalls = 0;
    const app = createFakeApp();
    registerSettingsRoutes(app, {
      notifier: {
        updateConfig: () => { updateConfigCalls++; },
        sendTest: async () => ({ success: true }),
        getStats: () => ({}),
      },
      exchangeIPCMap: {},
      rescheduleBackupTimer: () => {},
    });
    return { app, fsMocks, getUpdateConfigCalls: () => updateConfigCalls };
  };

  it('GET returns a masked bot token, never the raw one', async () => {
    const { app } = setup();
    const res = await invoke(app, 'GET /api/notifications/config');
    assert.equal(res.body.telegram.botToken, '123456...cdef');
    assert.ok(!JSON.stringify(res.body).includes(SECRET_TOKEN));
  });

  it('echoing the masked token back leaves the stored token unchanged', async () => {
    const { app } = setup();
    const res = await invoke(app, 'PUT /api/notifications/config', {
      body: { telegram: { botToken: '123456...cdef', chatId: '1234' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(configUtils.getNotificationConfig().telegram.botToken, SECRET_TOKEN);
    assert.equal(configUtils.getNotificationConfig().telegram.chatId, '1234');
  });

  it('a real new token is stored', async () => {
    const { app } = setup();
    const newToken = '654321:NEW-REAL-TOKEN-xyz';
    const res = await invoke(app, 'PUT /api/notifications/config', {
      body: { telegram: { botToken: newToken, chatId: '999' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(configUtils.getNotificationConfig().telegram.botToken, newToken);
  });

  const invalidCases = [
    { label: 'dailySummaryHour: non-numeric string', body: { dailySummaryHour: 'abc' } },
    { label: 'dailySummaryHour: above range', body: { dailySummaryHour: 24 } },
    { label: 'dailySummaryHour: below range', body: { dailySummaryHour: -1 } },
    { label: 'dailySummaryHour: non-integer', body: { dailySummaryHour: 12.5 } },
    { label: 'rateLimitMs: below floor', body: { rateLimitMs: 0 } },
    { label: 'rateLimitMs: above ceiling', body: { rateLimitMs: 999999 } },
    { label: 'rateLimitMs: non-numeric', body: { rateLimitMs: 'fast' } },
    { label: 'quietHours.start: out of range', body: { quietHours: { start: 24 } } },
    { label: 'quietHours.end: out of range', body: { quietHours: { end: -1 } } },
    { label: 'quietHours.enabled: non-boolean', body: { quietHours: { enabled: 'yes' } } },
    { label: 'quietHours: not an object', body: { quietHours: 'always' } },
    { label: 'enabled: non-boolean', body: { enabled: 'true' } },
  ];

  for (const { label, body } of invalidCases) {
    it(`rejects ${label} with 400 and leaves stored config unchanged`, async () => {
      const { app, getUpdateConfigCalls } = setup();
      const before = configUtils.getNotificationConfig();
      const res = await invoke(app, 'PUT /api/notifications/config', { body });
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.length > 0);
      assert.deepStrictEqual(configUtils.getNotificationConfig(), before);
      assert.equal(getUpdateConfigCalls(), 0);
    });
  }

  it('accepts valid values, persists them, and calls notifier.updateConfig once', async () => {
    const { app, getUpdateConfigCalls } = setup();
    const res = await invoke(app, 'PUT /api/notifications/config', {
      body: {
        enabled: true,
        dailySummaryHour: 9,
        rateLimitMs: 15000,
        quietHours: { enabled: true, start: 22, end: 6 },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const stored = configUtils.getNotificationConfig();
    assert.equal(stored.dailySummaryHour, 9);
    assert.equal(stored.rateLimitMs, 15000);
    assert.deepStrictEqual(stored.quietHours, { enabled: true, start: 22, end: 6 });
    assert.equal(getUpdateConfigCalls(), 1);
  });

  it('boundary hours 0 and 23 are accepted for dailySummaryHour and quietHours', async () => {
    const { app } = setup();
    for (const hour of [0, 23]) {
      const res = await invoke(app, 'PUT /api/notifications/config', {
        body: { dailySummaryHour: hour, quietHours: { start: hour, end: hour } },
      });
      assert.equal(res.statusCode, 200, `hour ${hour}`);
    }
  });
});
