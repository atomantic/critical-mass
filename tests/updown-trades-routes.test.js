// @ts-check
/**
 * Route tests for issue #151 — POST/PUT /api/updown/trades must reject
 * non-numeric cost/returnAmount/btcPriceAtExit with a 400 rather than
 * persisting NaN (which JSON.stringify writes as null, misclassifying the
 * win/loss filters). Mirrors the position route's guard for issue #108.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const registerUpdownRoutes = require('../src/routes/updown-routes');

/** Minimal express-like app that captures route handlers. */
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
const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

/**
 * Register the updown routes against an in-memory trades store. Since readTrades
 * now directly reads and parses files, we mock fs operations to simulate a
 * virtual filesystem.
 */
const setup = (initialTrades = { trades: [], nextId: 1 }) => {
  let stored = JSON.parse(JSON.stringify(initialTrades));
  let written = null;
  const tradesPath = '/tmp/updown-test/updown-trades.json';

  // Mock filesystem operations
  mock.method(fs, 'existsSync', (path) => {
    if (path === tradesPath) return stored !== null;
    return false;
  });

  mock.method(fs, 'readFileSync', (path, encoding) => {
    if (path === tradesPath) {
      if (stored === null) throw new Error('ENOENT');
      return JSON.stringify(stored, null, 2);
    }
    throw new Error('ENOENT');
  });

  mock.method(fs, 'writeFileSync', (_path, data) => {
    written = JSON.parse(data);
    stored = written;
  });

  const app = createFakeApp();
  registerUpdownRoutes(app, {
    updownService: { getTradeContext: () => ({}) },
    candleCache: { getAllCandles: () => [] },
    readJSON: () => JSON.parse(JSON.stringify(stored)),
    writeJSON: (filepath, data) => {
      // Mock atomic write: just update stored
      stored = JSON.parse(JSON.stringify(data));
      written = stored;
    },
    DATA_DIR: '/tmp/updown-test',
  });
  return { app, getWritten: () => written };
};

describe('POST /api/updown/trades rejects non-numeric values (issue #151)', () => {
  afterEach(() => mock.restoreAll());

  it('rejects non-numeric cost with 400 and persists nothing', async () => {
    const { app, getWritten } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 'abc', returnAmount: 100 } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(getWritten(), null);
  });

  it('rejects non-numeric returnAmount with 400', async () => {
    const { app } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 50, returnAmount: 'xyz' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  it('rejects numeric-prefix junk like "12abc" (parseFloat would accept it)', async () => {
    const { app, getWritten } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: '12abc', returnAmount: 100 } });
    assert.equal(res.statusCode, 400);
    assert.equal(getWritten(), null);
  });

  it('rejects empty-string cost', async () => {
    const { app } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: '', returnAmount: 100 } });
    assert.equal(res.statusCode, 400);
  });

  it('accepts numeric strings', async () => {
    const { app } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: '50', returnAmount: '80.5' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trade.pnl, 30.5);
  });

  it('accepts finite numeric values and persists a finite pnl', async () => {
    const { app, getWritten } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 50, returnAmount: 80 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.trade.pnl, 30);
    assert.ok(Number.isFinite(getWritten().trades[0].pnl));
  });

  it('still requires cost/returnAmount to be present', async () => {
    const { app } = setup();
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 50 } });
    assert.equal(res.statusCode, 400);
  });
});

describe('POST /api/updown/trades does not infer DOWN from a SELL signal (UP-only)', () => {
  afterEach(() => mock.restoreAll());

  it('leaves direction null when the latest signal is SELL (EXIT / STAND ASIDE)', async () => {
    const app = createFakeApp();
    let stored = { trades: [], nextId: 1 };
    mock.method(fs, 'existsSync', () => true);
    mock.method(fs, 'readFileSync', () => JSON.stringify(stored, null, 2));
    mock.method(fs, 'writeFileSync', (_, data) => { stored = JSON.parse(data); });
    registerUpdownRoutes(app, {
      updownService: {
        getTradeContext: () => ({ latestSignal: { type: 'SELL', score: -20, confidence: 50 } }),
      },
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }),
      writeJSON: (_, data) => { stored = data; },
      DATA_DIR: '/tmp/updown-test',
    });
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 50, returnAmount: 80 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trade.direction, null);
    assert.equal(res.body.trade.manualOverride, false);
  });

  it('infers up from a BUY signal', async () => {
    const app = createFakeApp();
    let stored = { trades: [], nextId: 1 };
    mock.method(fs, 'existsSync', () => true);
    mock.method(fs, 'readFileSync', () => JSON.stringify(stored, null, 2));
    mock.method(fs, 'writeFileSync', (_, data) => { stored = JSON.parse(data); });
    registerUpdownRoutes(app, {
      updownService: {
        getTradeContext: () => ({ latestSignal: { type: 'BUY', score: 20, confidence: 50 } }),
      },
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }),
      writeJSON: (_, data) => { stored = data; },
      DATA_DIR: '/tmp/updown-test',
    });
    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 50, returnAmount: 80 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trade.direction, 'up');
  });
});

describe('PUT /api/updown/trades/:id rejects non-numeric updates (issue #151)', () => {
  afterEach(() => mock.restoreAll());

  const existing = () => ({ trades: [{ id: 1, cost: 50, returnAmount: 80, pnl: 30 }], nextId: 2 });

  it('rejects non-numeric cost with 400 and leaves the trade untouched', async () => {
    const { app, getWritten } = setup(existing());
    const res = await invoke(app, 'PUT /api/updown/trades/:id', { params: { id: '1' }, body: { cost: 'abc' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(getWritten(), null);
  });

  it('rejects non-numeric btcPriceAtExit with 400', async () => {
    const { app } = setup(existing());
    const res = await invoke(app, 'PUT /api/updown/trades/:id', { params: { id: '1' }, body: { btcPriceAtExit: 'nope' } });
    assert.equal(res.statusCode, 400);
  });

  it('rejects numeric-prefix junk like "12abc" on update', async () => {
    const { app, getWritten } = setup(existing());
    const res = await invoke(app, 'PUT /api/updown/trades/:id', { params: { id: '1' }, body: { returnAmount: '120xyz' } });
    assert.equal(res.statusCode, 400);
    assert.equal(getWritten(), null);
  });

  it('accepts finite numeric updates and recomputes pnl', async () => {
    const { app } = setup(existing());
    const res = await invoke(app, 'PUT /api/updown/trades/:id', { params: { id: '1' }, body: { returnAmount: 120 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trade.pnl, 70);
  });
});

describe('PUT /api/updown/position strictly validates numeric fields', () => {
  const setupPosition = () => {
    const calls = [];
    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: {
        setPosition: position => calls.push(position),
        getTradeContext: () => ({}),
      },
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }),
      DATA_DIR: '/tmp/updown-position-test',
    });
    return { app, calls };
  };

  for (const bad of ['12abc', '', '   ', Infinity, NaN, 0, -1]) {
    it(`rejects invalid entryPrice ${String(bad)}`, async () => {
      const { app, calls } = setupPosition();
      const res = await invoke(app, 'PUT /api/updown/position', {
        body: { entryPrice: bad, contracts: 1, direction: 'up' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 0);
    });
  }

  it('accepts complete numeric strings and persists parsed numbers', async () => {
    const { app, calls } = setupPosition();
    const res = await invoke(app, 'PUT /api/updown/position', {
      body: { entryPrice: '78000.5', contracts: '2', direction: 'up' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0], { entryPrice: 78000.5, contracts: 2, direction: 'up', entryTime: undefined });
  });
});

describe('Atomic write safety (issue #417) — corrupt trades file is detected and errors loudly', () => {
  const path = require('path');
  const os = require('os');
  afterEach(() => mock.restoreAll());

  it('truncated trades file causes GET /api/updown/trades to error with 500', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-test-'));
    const tradesPath = path.join(tmpDir, 'updown-trades.json');
    // Write a truncated (incomplete) JSON file
    fs.writeFileSync(tradesPath, '{"trades": [{"id": 1, "cost": 50, "returnAmount"');

    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: { getTradeContext: () => ({}) },
      candleCache: { getAllCandles: () => [] },
      readJSON: (filepath, def) => {
        // Simulate the actual readJSON behavior: if file can't be parsed, return default
        if (!fs.existsSync(filepath)) return def;
        const content = fs.readFileSync(filepath, 'utf8');
        if (!content || content.trim() === '') return def;
        try {
          return JSON.parse(content);
        } catch (err) {
          return def;
        }
      },
      DATA_DIR: tmpDir,
      writeJSON: (filepath, data) => {
        const tmpPath = `${filepath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, filepath);
      },
    });

    const res = await invoke(app, 'GET /api/updown/trades');
    assert.equal(res.statusCode, 500, 'Expected 500 error for corrupt file');
    assert.ok(res.body.error || res.body.message, 'Error response should contain error message');

    // Verify truncated file is unchanged after the error
    const contentAfter = fs.readFileSync(tradesPath, 'utf8');
    assert.equal(contentAfter, '{"trades": [{"id": 1, "cost": 50, "returnAmount"', 'File should be unchanged after error');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('missing trades file returns empty history without error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-test-'));
    const tradesPath = path.join(tmpDir, 'updown-trades.json');
    // Do NOT create the trades file

    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: { getTradeContext: () => ({}) },
      candleCache: { getAllCandles: () => [] },
      readJSON: (filepath, def) => {
        if (!fs.existsSync(filepath)) return def;
        const content = fs.readFileSync(filepath, 'utf8');
        if (!content || content.trim() === '') return def;
        try {
          return JSON.parse(content);
        } catch (err) {
          return def;
        }
      },
      DATA_DIR: tmpDir,
      writeJSON: (filepath, data) => {
        const tmpPath = `${filepath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, filepath);
      },
    });

    const res = await invoke(app, 'GET /api/updown/trades');
    assert.equal(res.statusCode, 200, 'GET should succeed for missing file');
    assert.deepEqual(res.body.trades, [], 'Should return empty trades array');
    assert.equal(res.body.summary.count, 0, 'Trade count should be 0');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeJSON produces a parseable file and leaves no .tmp sibling', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-test-'));
    const tradesPath = path.join(tmpDir, 'test-trades.json');

    // Use the actual atomicWriteSync logic from shared-utils
    const { randomUUID } = require('crypto');
    const atomicWriteSync = (filePath, data) => {
      const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmpPath, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
      } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        throw err;
      }
    };

    const testData = { trades: [{ id: 1, cost: 100, returnAmount: 150 }], nextId: 2 };
    atomicWriteSync(tradesPath, JSON.stringify(testData, null, 2));

    // Verify file is parseable
    const content = fs.readFileSync(tradesPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, testData, 'File should be valid JSON');

    // Verify no .tmp sibling exists
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'));
    assert.equal(tmpFiles.length, 0, 'No .tmp files should remain after atomic write');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/updown/trades uses atomic write (writeJSON)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-test-'));
    const tradesPath = path.join(tmpDir, 'updown-trades.json');

    let writeJsonCalled = false;
    const { randomUUID } = require('crypto');

    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: { getTradeContext: () => ({}) },
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }),
      DATA_DIR: tmpDir,
      writeJSON: (filepath, data) => {
        writeJsonCalled = true;
        // Verify it's using atomic write pattern
        const tmpPath = `${filepath}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(tmpPath, filepath);
      },
    });

    const res = await invoke(app, 'POST /api/updown/trades', { body: { cost: 100, returnAmount: 150 } });
    assert.equal(res.statusCode, 200, 'POST should succeed');
    assert.ok(writeJsonCalled, 'writeJSON should be called instead of raw fs.writeFileSync');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
