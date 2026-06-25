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
 * Register the updown routes against an in-memory trades store. fs.writeFileSync
 * is stubbed to capture the persisted payload so we can assert nothing was saved
 * on the reject path.
 */
const setup = (initialTrades = { trades: [], nextId: 1 }) => {
  let stored = JSON.parse(JSON.stringify(initialTrades));
  let written = null;
  mock.method(fs, 'writeFileSync', (_path, data) => { written = JSON.parse(data); stored = written; });
  const app = createFakeApp();
  registerUpdownRoutes(app, {
    updownService: { getTradeContext: () => ({}) },
    candleCache: { getAllCandles: () => [] },
    readJSON: () => JSON.parse(JSON.stringify(stored)),
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
