const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DAILY_TREND_PARAMS, computeDailyTrend, applyDailyTrendFilter, createDailyTrendEntryFilter } = require('../src/updown/up-dip-trend-filter');
const { createUpDipPaper } = require('../src/updown/up-dip-paper');

const MIN = 60_000;
const DAY = 86_400_000;
const daily = (n, close = 70000) => Array.from({ length: n }, (_, i) => ({ timestamp: i * DAY, open: close, high: close, low: close, close, volume: 1 }));
const enter = { action: 'ENTER', size: 1, contract: { floor: 1, ceiling: 2 }, reasons: ['dip'], expected: { costUsd: 700 } };

describe('computeDailyTrend', () => {
  it('averages the last 50 completed daily closes and blocks only below −4%', () => {
    const d = [...daily(10, 10), ...daily(50, 70000)]; // older closes fall outside the window
    assert.equal(computeDailyTrend(d, 70000).sma, 70000);
    const at = (price) => computeDailyTrend(d, price);
    assert.deepEqual([at(70000).blocking, at(67201).blocking, at(67199).blocking], [false, false, true]);
    assert.equal(at(66500).distancePct, -5);
    assert.equal(at(66500).sufficient, true);
  });
  it('reports insufficient daily history with fewer than 50 candles and blocks rather than guessing', () => {
    const t = computeDailyTrend(daily(49), 70000);
    assert.equal(t.sufficient, false);
    assert.equal(t.blocking, true);
    assert.equal(t.sma, null);
    assert.match(t.reason, /insufficient daily history \(49\/50/);
  });
  it('takes a configurable threshold', () => {
    assert.equal(DAILY_TREND_PARAMS.maxBelowSmaPct, 4);
    assert.equal(computeDailyTrend(daily(50), 66500, { ...DAILY_TREND_PARAMS, maxBelowSmaPct: 6 }).blocking, false);
    assert.equal(computeDailyTrend(daily(50), 67500, { ...DAILY_TREND_PARAMS, maxBelowSmaPct: 3 }).blocking, true);
  });
});

describe('applyDailyTrendFilter', () => {
  const blocking = computeDailyTrend(daily(50), 60000);
  const clear = computeDailyTrend(daily(50), 70000);
  it('turns ENTER into STAND_ASIDE and ADD into HOLD while blocking', () => {
    const e = applyDailyTrendFilter(enter, blocking);
    assert.equal(e.action, 'STAND_ASIDE');
    assert.match(e.reasons[0], /daily-trend filter/);
    const a = applyDailyTrendFilter({ ...enter, action: 'ADD' }, blocking);
    assert.equal(a.action, 'HOLD');
    assert.equal(a.expected, undefined);
  });
  it('passes exits, holds and unblocked entries through unchanged', () => {
    for (const action of ['EXIT', 'HOLD', 'STAND_ASIDE']) {
      const d = { action, reasons: ['x'] };
      assert.equal(applyDailyTrendFilter(d, blocking), d);
    }
    assert.equal(applyDailyTrendFilter(enter, clear), enter);
  });
});

// Same synthetic path as tests/updown-up-dip-setup.test.js: flat, a dip, a turn, a recovery.
const SUN = Date.parse('2026-11-15T18:00:00Z');
const path1m = (start, n, priceAt) => Array.from({ length: n }, (_, i) => {
  const p = priceAt(i), q = priceAt(i + 1);
  return { timestamp: start + i * MIN, open: p, close: q, high: Math.max(p, q) + 1, low: Math.min(p, q) - 1, volume: 1 };
});
const tfAt = (candles, i) => {
  const m15 = [];
  for (const c of candles.slice(0, i + 1)) {
    const t = Math.floor(c.timestamp / (15 * MIN)) * 15 * MIN;
    const b = m15.at(-1);
    if (b && b.timestamp === t) { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
    else m15.push({ ...c, timestamp: t });
  }
  m15.pop();
  const hour = 60 * MIN;
  const startHour = Math.floor(candles[0].timestamp / hour) * hour;
  const h1 = Array.from({ length: 20 }, (_, n) => ({
    ...candles[0], timestamp: startHour - (20 - n) * hour,
  }));
  return { '1m': candles.slice(Math.max(0, i - 179), i + 1), '15m': m15, '1h': h1 };
};
const priceAt = (i) => (i < 400 ? 65000 : i < 430 ? 65000 - (i - 400) * 22 : 64340 + (i - 430) * 15);

describe('shadow paper book', () => {
  const run = (dailyCandles, statePath) => {
    const all = path1m(SUN - 600 * MIN, 520, priceAt);
    let n = 0;
    const book = createUpDipPaper({ getHalfSpread: () => 0,
      getCandles: (tf) => (tf === '1d' ? dailyCandles : n ? (tfAt(all, n - 1)[tf] || []) : []),
      statePath,
      writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
      entryFilter: createDailyTrendEntryFilter(),
    });
    for (n = 60; n <= all.length; n++) book.step();
    return book.getStatus();
  };
  it('keeps its own state file, stands aside below the average, and trades when clear', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-shadow-'));
    const basePath = path.join(dir, 'up-dip-paper.json');
    fs.writeFileSync(basePath, JSON.stringify({ cycles: [{ pnl: 1 }] }));
    const before = fs.readFileSync(basePath, 'utf8');

    const blocked = run(daily(50, 70000), path.join(dir, 'shadow-blocked.json'));
    assert.equal(blocked.filter.blocking, true);
    assert.equal(blocked.summary.cycles, 0);
    assert.equal(blocked.position, null);
    assert.ok(blocked.events.every(e => e.action !== 'ENTER' && e.action !== 'FILLED_ENTER'));

    const thin = run(daily(20, 65000), path.join(dir, 'shadow-thin.json'));
    assert.equal(thin.filter.sufficient, false);
    assert.equal(thin.summary.cycles, 0);

    const clearPath = path.join(dir, 'shadow-clear.json');
    const clear = run(daily(50, 65000), clearPath);
    assert.equal(clear.filter.blocking, false);
    assert.ok(clear.summary.cycles >= 1 && clear.summary.pnl > 0);
    assert.equal(JSON.parse(fs.readFileSync(clearPath, 'utf8')).cycles.length, clear.summary.cycles);

    assert.equal(fs.readFileSync(basePath, 'utf8'), before, 'base book file untouched');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('exits an open shadow position even once the filter starts blocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-shadow-'));
    const all = path1m(SUN - 600 * MIN, 520, priceAt);
    let n = 0;
    let dailyCandles = daily(50, 65000);
    const book = createUpDipPaper({ getHalfSpread: () => 0,
      getCandles: (tf) => (tf === '1d' ? dailyCandles : n ? (tfAt(all, n - 1)[tf] || []) : []),
      statePath: path.join(dir, 'shadow.json'),
      writeJSON: () => {},
      entryFilter: createDailyTrendEntryFilter(),
    });
    for (n = 60; n <= all.length; n++) {
      book.step();
      if (book.getStatus().position) dailyCandles = daily(50, 80000); // filter blocks from here on
    }
    const s = book.getStatus();
    assert.equal(s.filter.blocking, true);
    assert.ok(s.summary.cycles >= 1, 'opened before the block, closed after it');
    assert.equal(s.cycles.at(-1).reason, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('the base book (no entryFilter) exposes no filter field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-shadow-'));
    const base = createUpDipPaper({ getHalfSpread: () => 0, getCandles: () => [], statePath: path.join(dir, 'b.json'), writeJSON: () => {} });
    assert.equal('filter' in base.getStatus(), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('GET /api/updown/up-dip', () => {
  const routeWith = (deps) => {
    const handlers = {};
    const reg = (m) => (route, h) => { handlers[`${m} ${route}`] = h; };
    require('../src/routes/updown-routes')({ get: reg('GET'), put: reg('PUT'), patch: reg('PATCH'), post: reg('POST'), delete: reg('DELETE') }, {
      updownService: { getTradeContext: () => ({}) }, candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }), writeJSON: () => {}, DATA_DIR: os.tmpdir(), ...deps,
    });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    handlers['GET /api/updown/up-dip']({ query: {}, params: {}, body: {} }, res);
    return res.body;
  };
  it('returns the base book at the top level and the shadow book beside it', () => {
    const body = routeWith({ upDipPaper: { getStatus: () => ({ summary: { cycles: 3 } }) },
      upDipShadow: { getStatus: () => ({ summary: { cycles: 1 }, filter: { blocking: true } }) } });
    assert.equal(body.summary.cycles, 3);
    assert.equal(body.shadow.summary.cycles, 1);
    assert.equal(body.shadow.filter.blocking, true);
    assert.equal(routeWith({ upDipPaper: { getStatus: () => ({}) } }).shadow, null);
  });
});
