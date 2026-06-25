// @ts-check
/**
 * Route payload tests for issue #104 — legacy /api/config, /api/status and
 * /api/summary must never leak global secrets (telegram botToken, sentinel,
 * backup, aggressivenessPresets) through the merged fund config, and
 * PUT /api/notifications/config must not let a masked token round-trip
 * overwrite the real one.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configUtils = require('../src/config-utils');
const stateTracker = require('../src/state-tracker');
const adapters = require('../src/adapters');
const registerLegacyRoutes = require('../src/routes/legacy-routes');
const registerSettingsRoutes = require('../src/routes/settings-routes');

// Resolved paths matching what config-utils.js computes internally
const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

const SECRET_TOKEN = '123456:SECRET-BOT-TOKEN-abcdef';

const BASE_CONFIG_WITH_SECRETS = {
  exchanges: { coinbase: { productId: 'BTC-USDC', totalAllocation: 5000 } },
  global: {
    schedulerInterval: 30000,
    notifications: {
      enabled: true,
      telegram: { botToken: SECRET_TOKEN, chatId: '999' },
    },
    sentinel: { enabled: true, feeds: [] },
    backup: { enabled: true, maxBackups: 3 },
    aggressivenessPresets: { moderate: { kFactor: 0.6 } },
  },
};

/**
 * Mock fs so config-utils reads a virtual config (same pattern as
 * tests/config-utils.test.js).
 */
const setupFsMocks = ({ base = null, user = null } = {}) => {
  let writtenData = null;
  configUtils._resetConfigCacheForTests();

  mock.method(fs, 'existsSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return base !== null;
    if (filePath === USER_CONFIG_FILE) return user !== null;
    return false;
  });

  mock.method(fs, 'readFileSync', (filePath, _encoding) => {
    if (filePath === BASE_CONFIG_FILE && base !== null) return JSON.stringify(base);
    if (filePath === USER_CONFIG_FILE && user !== null) return JSON.stringify(user);
    throw new Error(`ENOENT: no such file: ${filePath}`);
  });

  let mtimeCounter = 0;
  mock.method(fs, 'statSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE && base !== null) return { mtimeMs: ++mtimeCounter };
    if (filePath === USER_CONFIG_FILE && user !== null) return { mtimeMs: ++mtimeCounter };
    const err = new Error(`ENOENT: no such file: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  });

  // saveConfig writes atomically (tmp + rename), so the data lands at
  // USER_CONFIG_FILE + '.tmp' before the rename. Capture either path, and stub
  // renameSync to a no-op (the tmp file never really exists under the mock).
  mock.method(fs, 'writeFileSync', (filePath, data) => {
    // saveConfig writes to a unique tmp path (USER_CONFIG_FILE.<pid>.<n>.tmp)
    // then renames. Capture any write whose target is the config file or its
    // tmp sibling.
    if (filePath === USER_CONFIG_FILE || String(filePath).startsWith(USER_CONFIG_FILE + '.')) {
      writtenData = JSON.parse(data);
    }
  });
  mock.method(fs, 'renameSync', () => {});

  mock.method(fs, 'mkdirSync', () => {});

  return { written: () => writtenData };
};

/**
 * Minimal express-like app that captures route handlers.
 */
const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => {
    handlers[`${method} ${route}`] = handler;
  };
  return {
    handlers,
    get: register('GET'),
    put: register('PUT'),
    patch: register('PATCH'),
    post: register('POST'),
    delete: register('DELETE'),
  };
};

/** Minimal res stub capturing the JSON payload. */
const createRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
};

const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

describe('legacy routes do not leak global secrets (issue #104)', () => {
  afterEach(() => mock.restoreAll());

  const setup = () => {
    const fsMocks = setupFsMocks({ base: BASE_CONFIG_WITH_SECRETS, user: null });
    mock.method(stateTracker, 'loadState', () => ({ orders: [] }));
    mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
    const app = createFakeApp();
    registerLegacyRoutes(app, {
      parseTSV: () => [],
      calculateCostBasis: () => ({}),
      getNextTradeInfo: () => ({}),
    });
    return { app, fsMocks };
  };

  const assertNoSecrets = (payload, route) => {
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(SECRET_TOKEN), `${route} leaks the bot token value`);
    assert.ok(!serialized.includes('botToken'), `${route} leaks a botToken field`);
    assert.ok(!serialized.includes('notifications'), `${route} leaks notifications config`);
    assert.ok(!serialized.includes('sentinel'), `${route} leaks sentinel config`);
    assert.ok(!serialized.includes('aggressivenessPresets'), `${route} leaks aggressiveness presets`);
  };

  it('GET /api/config returns fund config without secrets', async () => {
    const { app } = setup();
    const res = await invoke(app, 'GET /api/config');
    assert.equal(res.body.productId, 'BTC-USDC');
    assert.equal(res.body.totalAllocation, 5000);
    assertNoSecrets(res.body, 'GET /api/config');
  });

  it('GET /api/status returns status without secrets', async () => {
    const { app } = setup();
    const res = await invoke(app, 'GET /api/status');
    assert.equal(res.body.keysConfigured, false);
    assert.equal(res.body.config.productId, 'BTC-USDC');
    assertNoSecrets(res.body, 'GET /api/status');
  });

  it('GET /api/summary returns summary without secrets', async () => {
    const { app } = setup();
    const res = await invoke(app, 'GET /api/summary');
    assert.equal(res.body.config.productId, 'BTC-USDC');
    assert.ok(res.body.stats);
    assertNoSecrets(res.body, 'GET /api/summary');
  });
});

describe('PUT /api/config validates against the allowlist (issue #146)', () => {
  afterEach(() => mock.restoreAll());

  const BASE_COINBASE = {
    exchanges: { coinbase: { productId: 'BTC-USDC', amount: 25, holdbackPercent: 5 } },
    global: { schedulerInterval: 30000 },
  };

  const setup = (base = BASE_COINBASE) => {
    const fsMocks = setupFsMocks({ base, user: null });
    const app = createFakeApp();
    registerLegacyRoutes(app, {
      parseTSV: () => [],
      calculateCostBasis: () => ({}),
      getNextTradeInfo: () => ({}),
    });
    return { app, fsMocks };
  };

  it('drops unknown keys instead of persisting them', async () => {
    const { app, fsMocks } = setup();
    const res = await invoke(app, 'PUT /api/config', {
      body: { amount: 50, evilKey: 1, __proto__hack: true },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const written = fsMocks.written();
    assert.equal(written.exchanges.coinbase.amount, 50);
    assert.equal(written.exchanges.coinbase.evilKey, undefined);
    assert.equal(written.exchanges.coinbase.__proto__hack, undefined);
    // The echoed config must not carry the injected key either.
    assert.ok(!JSON.stringify(res.body.config).includes('evilKey'));
  });

  it('rejects out-of-range values with 400 and persists nothing', async () => {
    const { app, fsMocks } = setup();
    const res = await invoke(app, 'PUT /api/config', {
      body: { amount: -1, holdbackPercent: 9999 },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(/amount|holdbackPercent/.test(res.body.error));
    assert.equal(fsMocks.written(), null, 'no config write should occur on a rejected payload');
  });

  it('drops unknown nested regime keys but still saves the known ones (no 400)', async () => {
    const { app, fsMocks } = setup();
    const res = await invoke(app, 'PUT /api/config', {
      body: { regime: { enabled: true, bogusRegimeKey: 1 } },
    });
    assert.equal(res.statusCode, 200, `must not 400 (got ${res.statusCode}: ${JSON.stringify(res.body)})`);
    const written = fsMocks.written();
    assert.equal(written.exchanges.coinbase.regime.enabled, true, 'known regime key must persist');
    assert.ok(!JSON.stringify(written).includes('bogusRegimeKey'), 'unknown regime key must not enter overrides');
  });

  it('accepts a valid update including allowed regime keys', async () => {
    const { app, fsMocks } = setup();
    const res = await invoke(app, 'PUT /api/config', {
      body: { amount: 40, regime: { enabled: true } },
    });
    assert.equal(res.statusCode, 200);
    const written = fsMocks.written();
    assert.equal(written.exchanges.coinbase.amount, 40);
    assert.equal(written.exchanges.coinbase.regime.enabled, true);
  });
});

describe('PUT /api/notifications/config masked-token round-trip guard', () => {
  afterEach(() => mock.restoreAll());

  const setup = () => {
    const fsMocks = setupFsMocks({ base: BASE_CONFIG_WITH_SECRETS, user: null });
    const app = createFakeApp();
    registerSettingsRoutes(app, {
      notifier: { updateConfig: () => {}, sendTest: async () => ({ success: true }), getStats: () => ({}) },
      exchangeIPCMap: {},
      rescheduleBackupTimer: () => {},
    });
    return { app, fsMocks };
  };

  it('GET /api/notifications/config masks the bot token', async () => {
    const { app } = setup();
    const res = await invoke(app, 'GET /api/notifications/config');
    assert.equal(res.body.telegram.botToken, '123456...cdef');
    assert.ok(!JSON.stringify(res.body).includes(SECRET_TOKEN));
  });

  it('ignores a masked token echoed back, preserving the stored token', async () => {
    const { app, fsMocks } = setup();
    const res = await invoke(app, 'PUT /api/notifications/config', {
      body: { enabled: false, telegram: { botToken: '123456...cdef', chatId: '1234' } },
    });
    assert.equal(res.body.success, true);
    // saveConfig persists only the diff vs base — the token must NOT appear
    // in the diff (i.e. the mask was not written over the real token).
    const written = fsMocks.written();
    assert.equal(written.global.notifications.telegram.botToken, undefined);
    assert.ok(!JSON.stringify(written).includes('123456...cdef'));
    // Other updates in the same request still apply
    assert.equal(written.global.notifications.telegram.chatId, '1234');
    assert.equal(written.global.notifications.enabled, false);

    // End-to-end: load base + written diff as the engine would and verify
    // the real token still resolves for notifications.
    mock.restoreAll();
    setupFsMocks({ base: BASE_CONFIG_WITH_SECRETS, user: written });
    const notif = configUtils.getNotificationConfig();
    assert.equal(notif.telegram.botToken, SECRET_TOKEN);
    assert.equal(notif.telegram.chatId, '1234');
  });

  it('accepts a genuine new token', async () => {
    const { app, fsMocks } = setup();
    const newToken = '654321:NEW-REAL-TOKEN-xyz';
    await invoke(app, 'PUT /api/notifications/config', {
      body: { telegram: { botToken: newToken } },
    });
    const written = fsMocks.written();
    assert.equal(written.global.notifications.telegram.botToken, newToken);
  });
});
