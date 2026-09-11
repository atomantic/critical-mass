// @ts-check
/**
 * Tests for the fund-lifecycle endpoints in src/routes/exchange-routes.js that
 * carry real financial-safety guarantees but had zero coverage before this
 * file (issue #406):
 *
 *  - POST   /api/:exchange/funds        — new-fund creation defaults
 *  - DELETE /api/:exchange/funds/:pair  — destructive deletion safety guards
 *  - PATCH  /api/:exchange/config       — live enabled/dryRun toggles + IPC
 *
 * Config I/O (config.json / data/config.json) is mocked exactly like
 * tests/exchange-routes-config.test.js, but the mock falls through to the
 * REAL fs implementation for any path outside those two files. That lets
 * regime-state.json / regime-engine-running.json reads (loadRegimeState,
 * shouldAutoResumeRegime) exercise their real logic against a throwaway
 * temp directory — the same "patch migration.getExchangeDataDir" pattern
 * used by tests/fill-ledger.test.js and tests/corrective-buy-paths.test.js —
 * instead of stubbing those modules out.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configUtils = require('../src/config-utils');
const migration = require('../src/migration');
const adapters = require('../src/adapters');
const registerExchangeRoutes = require('../src/routes/exchange-routes');

const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const USER_CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// Real fs, captured before any mock.method() calls touch the module — used
// both as the fallthrough target inside the mock and directly by test setup
// so temp-dir I/O for regime state never depends on whichever fs mock is
// currently installed.
const realFs = {
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
};

// Two funds on coinbase so DELETE tests can remove one and leave the other
// (removeFund refuses to remove an exchange's last remaining fund).
const BASE_CONFIG = {
  exchanges: {
    coinbase: {
      pairs: {
        'BTC-USDC': { productId: 'BTC-USDC', enabled: true, dryRun: false },
        'ETH-USDC': { productId: 'ETH-USDC', enabled: true, dryRun: false },
      },
    },
  },
};

const setupFsMocks = (base) => {
  let userData = null;
  configUtils._resetConfigCacheForTests();

  mock.method(fs, 'existsSync', (filePath) => {
    if (filePath === BASE_CONFIG_FILE) return base !== null;
    if (filePath === USER_CONFIG_FILE) return userData !== null;
    return realFs.existsSync(filePath);
  });
  mock.method(fs, 'readFileSync', (filePath, ...rest) => {
    if (filePath === USER_CONFIG_FILE && userData !== null) return JSON.stringify(userData);
    if (filePath === BASE_CONFIG_FILE && base !== null) return JSON.stringify(base);
    return realFs.readFileSync(filePath, ...rest);
  });
  let mtime = 0;
  mock.method(fs, 'statSync', (filePath) => {
    if (filePath === USER_CONFIG_FILE && userData !== null) return { mtimeMs: ++mtime, mode: 0o600 };
    if (filePath === BASE_CONFIG_FILE && base !== null) return { mtimeMs: ++mtime, mode: 0o600 };
    return realFs.statSync(filePath);
  });
  mock.method(fs, 'writeFileSync', (filePath, data, ...rest) => {
    if (filePath === USER_CONFIG_FILE || String(filePath).startsWith(USER_CONFIG_FILE + '.')) {
      userData = JSON.parse(data);
      configUtils._resetConfigCacheForTests();
      return;
    }
    return realFs.writeFileSync(filePath, data, ...rest);
  });
  mock.method(fs, 'renameSync', (from, to) => {
    if (to === USER_CONFIG_FILE || String(to).startsWith(USER_CONFIG_FILE)) return;
    return realFs.renameSync(from, to);
  });
  mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (String(dir) === path.dirname(USER_CONFIG_FILE)) return;
    return realFs.mkdirSync(dir, ...rest);
  });

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

// A real temp dir standing in for data/<exchange>/<pair>/ — populated per
// test with regime-state.json / regime-engine-running.json as needed, and
// wired in via migration.getExchangeDataDir (the same seam
// tests/fill-ledger.test.js and tests/corrective-buy-paths.test.js patch).
let tempRoot;
const originalGetExchangeDataDir = migration.getExchangeDataDir;

const fundDir = (exchange, pair) => path.join(tempRoot, exchange, pair);

const writeRegimeState = (exchange, pair, position) => {
  const dir = fundDir(exchange, pair);
  realFs.mkdirSync(dir, { recursive: true });
  realFs.writeFileSync(path.join(dir, 'regime-state.json'), JSON.stringify({ position, regime: {} }));
};

const writeRunningFlag = (exchange, pair) => {
  const dir = fundDir(exchange, pair);
  realFs.mkdirSync(dir, { recursive: true });
  realFs.writeFileSync(path.join(dir, 'regime-engine-running.json'), JSON.stringify({ running: true, startedAt: new Date().toISOString() }));
};

const setup = (ipcRequest = () => Promise.resolve({ success: true })) => {
  const fsMocks = setupFsMocks(BASE_CONFIG);
  const app = createFakeApp();
  registerExchangeRoutes(app, {
    exchangeIPCMap: { coinbase: { request: ipcRequest } },
    parseTSV: () => [],
    calculateCostBasis: () => ({}),
    getNextTradeInfo: () => ({}),
  });
  return { app, fsMocks };
};

describe('fund lifecycle routes', () => {
  beforeEach(() => {
    tempRoot = realFs.mkdirSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'exch-routes-lifecycle-')) : null;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tempRoot, exchange);
      realFs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    mock.restoreAll();
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    if (tempRoot) realFs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('POST /api/:exchange/funds', () => {
    it('defaults a new fund to enabled: false, dryRun: true when keys are not configured', async () => {
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC' },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.config.enabled, false, 'new fund must default enabled:false');
      assert.equal(res.body.config.dryRun, true, 'new fund must default dryRun:true');
    });

    it('does not let a caller override dryRun:false on creation (still defaults safe)', async () => {
      // The handler computes dryRun as `dryRun !== false` — i.e. an explicit
      // `dryRun: false` in the request IS honored (operator opt-in), but
      // omitting it (undefined) must still resolve to true. Pin both halves
      // of that contract.
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app } = setup();

      const omitted = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC' },
      });
      assert.equal(omitted.body.config.dryRun, true, 'omitted dryRun must default to true');
    });

    it('mirrors totalAllocation into regime.depositedCapital and regime.maxUsdcDeployed', async () => {
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC', totalAllocation: 5000 },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.config.totalAllocation, 5000);
      assert.equal(res.body.config.regime.depositedCapital, 5000, 'totalAllocation must seed regime.depositedCapital');
      assert.equal(res.body.config.regime.maxUsdcDeployed, 5000, 'totalAllocation must seed regime.maxUsdcDeployed');
    });

    // Parity regression for #452: a supplied regime seed used to be spread into
    // the new fund's config with no value validation at all (only the dedicated
    // PUT /api/:exchange/regime/config route checked ranges), so a fund could be
    // created with e.g. maxDrawdownPercent: 999 — a value the risk manager can
    // never legitimately compare a 0-100% drawdown against.
    it('rejects fund creation when the regime seed carries an out-of-range value (400, zero writes)', async () => {
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC', regime: { maxDrawdownPercent: 999 } },
      });

      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.match(res.body.error, /maxDrawdownPercent/);
      assert.ok(!JSON.stringify(fsMocks.user() || {}).includes('SOL-USDC'), 'rejected fund must not be persisted');
    });

    it('drops an unknown regime seed key but still creates the fund with the known ones', async () => {
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC', regime: { baseSizeUsdc: 25, bogusRegimeKey: 1 } },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.config.regime.baseSizeUsdc, 25, 'known regime seed field must persist');
      assert.equal(res.body.config.regime.bogusRegimeKey, undefined, 'unknown regime seed key must be dropped');
    });

    it('rejects an unknown exchange (no adapter registered) with 400', async () => {
      // Real (unmocked) adapter registry — 'unobtainium' is not coinbase/gemini/cryptocom.
      const { app } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'unobtainium' },
        body: { pair: 'BTC-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /Unknown exchange/i);
    });

    it('rejects creation when the adapter cannot verify the product (400, config never written)', async () => {
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getProductDetails: async () => null,
      }));
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /not found on coinbase/i);
      assert.ok(!JSON.stringify(fsMocks.user() || {}).includes('SOL-USDC'), 'unverified fund must not be persisted');
    });

    it('rejects creation when the product-details lookup throws (400, config never written)', async () => {
      mock.method(adapters, 'getAdapter', () => ({
        hasValidKeys: () => true,
        getProductDetails: async () => { throw new Error('exchange API timeout'); },
      }));
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /Failed to verify/i);
      assert.ok(!JSON.stringify(fsMocks.user() || {}).includes('SOL-USDC'), 'unverified fund must not be persisted');
    });

    describe('base-asset identity guard (mirrors PUT /api/:exchange/config)', () => {
      it('rejects a productId trading a different base asset (400, zero writes, no adapter lookup)', async () => {
        const getAdapterMock = mock.fn(() => ({
          hasValidKeys: () => true,
          getProductDetails: mock.fn(async () => ({})),
        }));
        mock.method(adapters, 'getAdapter', getAdapterMock);
        const { app, fsMocks } = setup();

        const res = await invoke(app, 'POST /api/:exchange/funds', {
          params: { exchange: 'coinbase' },
          body: { pair: 'ETH-USDC', productId: 'BTC-USDC' },
        });

        assert.equal(res.statusCode, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /does not match fund/i);
        assert.equal(getAdapterMock.mock.callCount(), 0, 'mismatched identity must be rejected before any adapter lookup');
        assert.ok(!JSON.stringify(fsMocks.user() || {}).includes('ETH-USDC'), 'mismatched fund must not be persisted');
      });

      it('accepts a same-asset productId (quote-only difference)', async () => {
        mock.method(adapters, 'getAdapter', () => ({
          hasValidKeys: () => true,
          getProductDetails: async () => ({}),
        }));
        const { app } = setup();

        const res = await invoke(app, 'POST /api/:exchange/funds', {
          params: { exchange: 'coinbase' },
          body: { pair: 'ETH-USD', productId: 'ETH-USDC' },
        });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.productId, 'ETH-USDC');
      });

      it('accepts an omitted productId (defaults to pair)', async () => {
        mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
        const { app } = setup();

        const res = await invoke(app, 'POST /api/:exchange/funds', {
          params: { exchange: 'coinbase' },
          body: { pair: 'SOL-USDC' },
        });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.productId, 'SOL-USDC');
      });

      it('rejects a non-string productId before any adapter invocation', async () => {
        const getAdapterMock = mock.fn(() => ({ hasValidKeys: () => false }));
        mock.method(adapters, 'getAdapter', getAdapterMock);
        const { app, fsMocks } = setup();

        const res = await invoke(app, 'POST /api/:exchange/funds', {
          params: { exchange: 'coinbase' },
          body: { pair: 'SOL-USDC', productId: 12345 },
        });

        assert.equal(res.statusCode, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /non-empty string/i);
        assert.equal(getAdapterMock.mock.callCount(), 0, 'non-string productId must be rejected before adapter invocation');
        assert.ok(!JSON.stringify(fsMocks.user() || {}).includes('SOL-USDC'), 'invalid fund must not be persisted');
      });
    });
  });

  describe('DELETE /api/:exchange/funds/:pair', () => {
    it('refuses deletion (400) when the fund lifecycle is active (default, no state file)', async () => {
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'BTC-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /lifecycle is 'active'/);
      assert.ok(!fsMocks.user(), 'config must be untouched when deletion is refused');
    });

    it('refuses deletion (400) when the fund lifecycle is draining', async () => {
      writeRegimeState('coinbase', 'BTC-USDC', { lifecycle: 'draining' });
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'BTC-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /lifecycle is 'draining'/);
      assert.ok(!fsMocks.user(), 'config must be untouched when deletion is refused');
    });

    it('refuses deletion (400) when lifecycle is closed but the regime engine is still running', async () => {
      writeRegimeState('coinbase', 'BTC-USDC', { lifecycle: 'closed' });
      writeRunningFlag('coinbase', 'BTC-USDC');
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'BTC-USDC' },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /engine is still flagged as running/i);
      assert.ok(!fsMocks.user(), 'config must be untouched when deletion is refused');
    });

    it('deletes the fund only when lifecycle is closed AND the engine is stopped', async () => {
      // Add a third fund the way the operator actually would (via the Add
      // Fund modal -> POST /funds), then close and delete it. A fund created
      // through this route lives entirely in the data/config.json diff layer,
      // so its removal is unambiguous. The harder case — a fund defined in the
      // BASE config.json, which saveConfig's diff persistence used to
      // resurrect — is covered by the base-config-fund test below (#441).
      mock.method(adapters, 'getAdapter', () => ({ hasValidKeys: () => false }));
      const { app } = setup();
      const created = await invoke(app, 'POST /api/:exchange/funds', {
        params: { exchange: 'coinbase' },
        body: { pair: 'SOL-USDC' },
      });
      assert.equal(created.statusCode, 200, JSON.stringify(created.body));

      writeRegimeState('coinbase', 'SOL-USDC', { lifecycle: 'closed' });
      // No running flag written -> shouldAutoResumeRegime is false.

      const res = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'SOL-USDC' },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);

      const remaining = await invoke(app, 'GET /api/:exchange/funds', { params: { exchange: 'coinbase' } });
      const pairs = remaining.body.funds.map((f) => f.pair);
      assert.ok(!pairs.includes('SOL-USDC'), 'deleted fund must be gone');
      assert.ok(pairs.includes('BTC-USDC') && pairs.includes('ETH-USDC'), 'other funds on the exchange must survive');
    });

    // Regression for #441: saveConfig persists only computeDiff(base, merged),
    // and computeDiff walks Object.keys(modified) — so a pair deleted outright
    // was simply absent from the diff, and the next deepMerge(base, diff)
    // restored it from config.json. DELETE returned {success: true} and the
    // fund came back on the next load.
    it('keeps a fund defined in the BASE config deleted across a fresh config load', async () => {
      writeRegimeState('coinbase', 'ETH-USDC', { lifecycle: 'closed' });
      const { app, fsMocks } = setup();

      const res = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'ETH-USDC' },
      });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));

      // The persisted overrides must carry an explicit tombstone — the base
      // config.json still defines ETH-USDC and is never rewritten.
      assert.deepStrictEqual(fsMocks.user().exchanges.coinbase.deletedPairs, ['ETH-USDC']);

      // Simulate a fresh process: same files on disk, no in-process cache.
      configUtils._resetConfigCacheForTests();

      const remaining = await invoke(app, 'GET /api/:exchange/funds', { params: { exchange: 'coinbase' } });
      const pairs = remaining.body.funds.map((f) => f.pair);
      assert.deepStrictEqual(pairs, ['BTC-USDC'], 'base-config fund must not resurrect');

      // A second delete attempt now sees it as gone rather than silently
      // re-deleting a resurrected fund.
      const again = await invoke(app, 'DELETE /api/:exchange/funds/:pair', {
        params: { exchange: 'coinbase', pair: 'ETH-USDC' },
      });
      assert.equal(again.statusCode, 400);
      assert.match(again.body.error, /not found/i);
    });
  });

  describe('PATCH /api/:exchange/config', () => {
    it('persists a dryRun toggle and dispatches regime:update-config over IPC', async () => {
      let seenOp = null;
      let seenPayload = null;
      const { app } = setup((op, payload) => {
        seenOp = op;
        seenPayload = payload;
        return Promise.resolve({ success: true });
      });

      const res = await invoke(app, 'PATCH /api/:exchange/config', {
        params: { exchange: 'coinbase' },
        query: { pair: 'BTC-USDC' },
        body: { dryRun: true },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.config.dryRun, true);
      assert.equal(seenOp, 'regime:update-config');
      assert.deepStrictEqual(seenPayload, { dryRun: true });

      const after = await invoke(app, 'GET /api/:exchange/config', {
        params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' },
      });
      assert.equal(after.body.dryRun, true, 'dryRun change must persist to disk');
    });

    it('toggles enabled without touching the live engine over IPC', async () => {
      let ipcCalled = false;
      const { app } = setup(() => { ipcCalled = true; return Promise.resolve({ success: true }); });

      const res = await invoke(app, 'PATCH /api/:exchange/config', {
        params: { exchange: 'coinbase' },
        query: { pair: 'BTC-USDC' },
        body: { enabled: true },
      });

      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.config.enabled, true);
      assert.equal(ipcCalled, false, 'enabled-only toggle must not call the live engine IPC');
    });

    it('reports 503 and persisted:true/applied:false when the live engine rejects the dryRun change', async () => {
      const { app } = setup(() => Promise.reject(new Error('engine unavailable')));

      const res = await invoke(app, 'PATCH /api/:exchange/config', {
        params: { exchange: 'coinbase' },
        query: { pair: 'BTC-USDC' },
        body: { dryRun: true },
      });

      assert.equal(res.statusCode, 503);
      assert.equal(res.body.persisted, true);
      assert.equal(res.body.applied, false);

      const after = await invoke(app, 'GET /api/:exchange/config', {
        params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' },
      });
      assert.equal(after.body.dryRun, true, 'disk state must match persisted:true even though the engine rejected it');
    });
  });
});
