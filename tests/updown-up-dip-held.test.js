const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpDipHeld } = require('../src/updown/up-dip-held');

const MIN = 60_000;
const NOW = Date.parse('2026-11-23T18:56:00Z');
const EXPIRY = Date.parse('2026-11-28T09:00:00Z');
/** Bought at 61,300: (61,300 − 59,800) × 0.5 + 1.99. */
const BUY = { floor: 59800, ceiling: 61800, contracts: 1, cost: 751.99 };
const latest = (price, over = {}) => ({ at: NOW, features: { price, vs1m: 0.1, vs1h: 0, green1m: true, dropPct: 0, vs15m: 0, rsi1m: 50, ...over } });

let dir, statePath, clock, candles;
const readJSON = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const make = () => createUpDipHeld({
  statePath, readJSON, writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
  getCandles: (tf) => candles[tf] || [], clock: () => clock,
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-held-'));
  statePath = path.join(dir, 'held.json');
  clock = NOW;
  candles = {};
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('operator-held Up contract', () => {
  it('is null until a fill is saved and null again once cleared', () => {
    const held = make();
    assert.equal(held.getStatus(latest(61300)), null);
    assert.equal(held.set(BUY).error, undefined);
    assert.equal(held.getStatus(latest(61300)).contracts, 1);
    held.clear();
    assert.equal(held.getStatus(latest(61300)), null);
  });

  it('EXITs the operator at +4% of their own cost after fees, whatever the paper book holds', () => {
    const held = make();
    held.set(BUY);
    // Break-even 61,307.96; +4% of 751.99 needs about 61,368.12.
    assert.equal(held.getStatus(latest(61360)).decision.action, 'HOLD');
    const out = held.getStatus(latest(61375));
    assert.equal(out.decision.action, 'EXIT');
    assert.equal(out.pnl, 33.52);
  });

  it('waits for price back above the 1m EMA before EXIT', () => {
    const held = make();
    held.set(BUY);
    assert.equal(held.getStatus(latest(61375, { vs1m: -0.01 })).decision.action, 'HOLD');
  });

  it('never recommends ADD', () => {
    const held = make();
    held.set(BUY);
    assert.equal(held.getStatus(latest(60900)).decision.action, 'HOLD');
  });

  it('gives no advice on stale or missing features', () => {
    const held = make();
    held.set(BUY);
    clock = NOW + 4 * MIN;
    assert.equal(held.getStatus(latest(61375)).decision.action, 'STALE');
    assert.equal(held.getStatus(null).decision.action, 'STALE');
    assert.equal(held.getStatus(latest(61375)).pnl, null);
  });

  it('flags a floor or ceiling touch since the fill, from any candle buffer, and ignores earlier ones', () => {
    const held = make();
    held.set(BUY);
    clock = NOW + 60 * MIN;
    const l = { ...latest(61300), at: clock };
    candles = { '1m': [{ timestamp: NOW - MIN, low: 59000, high: 61300 }] };
    assert.equal(held.getStatus(l).decision.action, 'HOLD');
    candles = { '1h': [{ timestamp: NOW + 4 * MIN, low: 59790, high: 61300 }] };
    assert.equal(held.getStatus(l).decision.action, 'CHECK_APP');
    candles = { '15m': [{ timestamp: NOW + 4 * MIN, low: 61300, high: 61800 }] };
    assert.match(held.getStatus(l).decision.reasons[0], /ceiling/);
  });

  it('reports EXPIRED after the next Saturday expiry', () => {
    const held = make();
    held.set(BUY);
    assert.equal(held.getStatus(latest(61300)).contract.expiry, EXPIRY);
    clock = EXPIRY;
    assert.equal(held.getStatus({ ...latest(61300), at: EXPIRY }).decision.action, 'EXPIRED');
  });

  it('rejects input that cannot be a real fill and leaves the saved contract alone', () => {
    const held = make();
    held.set(BUY);
    const bad = [
      {}, { ...BUY, floor: 'x' }, { ...BUY, contracts: 0 }, { ...BUY, contracts: 1.5 }, { ...BUY, cost: -1 },
      { ...BUY, ceiling: 60800 }, // only 500 and 2000 ranges have verified pricing
      { ...BUY, contracts: 2, cost: 5000 }, // implies a price above the ceiling
      { ...BUY, cost: 1 }, // below the fee: implies a price under the floor
    ];
    for (const b of bad) assert.ok(held.set(b).error, JSON.stringify(b));
    assert.equal(held.getStatus(latest(61300)).cost, 751.99);
  });

  it('survives a restart and picks up a restored file', () => {
    make().set(BUY);
    const again = make();
    assert.equal(again.getStatus(latest(61300)).cost, 751.99);
    fs.rmSync(statePath);
    assert.equal(again.getStatus(latest(61300)), null);
  });
});

describe('/api/updown/up-dip/held', () => {
  const setup = (upDipHeld) => {
    const handlers = {};
    const reg = (m) => (route, h) => { handlers[`${m} ${route}`] = h; };
    require('../src/routes/updown-routes')({ get: reg('GET'), put: reg('PUT'), patch: reg('PATCH'), post: reg('POST'), delete: reg('DELETE') }, {
      updownService: { getTradeContext: () => ({}) }, candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }), writeJSON: () => {}, DATA_DIR: os.tmpdir(),
      upDipPaper: { getStatus: () => ({ latest: latest(61375) }) }, upDipHeld,
    });
    return (key, body = {}) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      handlers[key]({ query: {}, params: {}, body }, res);
      return res;
    };
  };
  it('saves, reports beside the paper book, and clears', () => {
    const call = setup(make());
    assert.equal(call('GET /api/updown/up-dip').body.held, null);
    assert.equal(call('PUT /api/updown/up-dip/held', BUY).statusCode, 200);
    assert.equal(call('GET /api/updown/up-dip').body.held.decision.action, 'EXIT');
    assert.equal(call('DELETE /api/updown/up-dip/held').statusCode, 200);
    assert.equal(call('GET /api/updown/up-dip').body.held, null);
  });
  it('answers 400 with the reason for bad input and 503 when not running', () => {
    const bad = setup(make())('PUT /api/updown/up-dip/held', { ...BUY, contracts: 0 });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.error, /contracts/);
    assert.equal(setup(null)('PUT /api/updown/up-dip/held', BUY).statusCode, 503);
  });
});
