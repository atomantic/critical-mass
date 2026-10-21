const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTradeLog } = require('../src/updown/trade-log');

describe('createTradeLog', () => {
  let dir, file, log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-log-'));
    file = path.join(dir, 'trades.json');
    log = createTradeLog({ path: file, writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns empty list for missing file', () => {
    assert.deepEqual(log.list(), []);
  });

  it('throws with recovery hint for corrupt file', () => {
    fs.writeFileSync(file, '{bad');
    fs.writeFileSync(`${file}.tmp`, '{}');
    assert.throws(() => log.list(), /corrupted.*recovery file may exist/);
  });

  it('adds trades with allocated ids and inferred direction', () => {
    const ctx = { latestSignal: { type: 'STRONG_BUY', score: 1, confidence: 2 }, lastPrice: 100 };
    const a = log.add({ cost: 10, returnAmount: 15, exitTime: null }, { ctx });
    const b = log.add({ cost: 10, returnAmount: 5, direction: 'down', exitTime: null }, { ctx });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(a.direction, 'up');
    assert.equal(a.pnl, 5);
    assert.equal(a.btcPriceAtEntry, 100);
    assert.equal(a.entryTimeSource, 'logged');
    assert.equal(b.manualOverride, true);
  });

  it('uses operator entry time and price lookup', () => {
    const t = log.add({ cost: 1, returnAmount: 2, exitTime: null, boughtAtMs: 1000 }, { getPriceAt: () => 42 });
    assert.equal(t.entryTimeSource, 'operator');
    assert.equal(t.btcPriceAtEntry, 42);
  });

  it('updates, summarizes and removes', () => {
    log.add({ cost: 10, returnAmount: 15, direction: 'up', exitTime: null });
    log.add({ cost: 10, returnAmount: 5, direction: 'down', exitTime: null });
    const upd = log.update(2, { returnAmount: 20 });
    assert.equal(upd.pnl, 10);
    assert.equal(log.update(99, {}), null);
    const s = log.summary();
    assert.equal(s.count, 2);
    assert.equal(s.wins, 2);
    assert.equal(s.upWinRate, 100);
    assert.equal(s.totalPnl, 15);
    assert.equal(log.remove(1), true);
    assert.equal(log.remove(1), false);
    assert.equal(log.has(2), true);
  });
});
