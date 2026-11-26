const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpDipPaper } = require('../src/updown/up-dip-paper');

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00Z');
const EXPIRY = Date.parse('2026-11-21T09:00:00Z');
const CONTRACT = { floor: 63000, ceiling: 65000, range: 2000, maxPayout: 1000, expiry: EXPIRY };

const bar = (i, over = {}) => ({ timestamp: T0 + i * MIN, open: 64000, high: 64050, low: 63950, close: 64000, volume: 1, ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-gap-'));
const position = () => ({ contract: CONTRACT, contracts: 1, cost: 500, lastFillPrice: 64000, entryPrice: 64000, openedAt: T0 });
const seed = (file, extra) => fs.writeFileSync(file, JSON.stringify({ pricing: { spread: true, source: 'cryptocom-index' }, lastBarTs: T0, startedAt: T0, ...extra }));
const make = (dir, candles, name = 'p.json') => createUpDipPaper({ getHalfSpread: () => 0,
  getCandles: (tf) => (tf === '1m' ? candles : []),
  statePath: path.join(dir, name),
  writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
});

describe('up-dip paper restart replay', () => {
  it('floors an in-range expiry payout below the fee at zero, with or without a gap', () => {
    for (const gap of [false, true]) {
      const dir = tmp();
      try {
        const file = path.join(dir, 'p.json');
        const pos = position();
        seed(file, { position: pos, lastBarTs: EXPIRY - 2 * MIN, lastClose: 63_001 });
        const timestamp = gap ? EXPIRY : EXPIRY - MIN;
        const paper = make(dir, [{ timestamp, open: 63_001, low: 63_001, high: 63_002, close: 63_001, volume: 1 }]);
        assert.equal(paper.step(), true);
        assert.equal(paper.getStatus().cycles[0].pnl, -pos.cost);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('replays every buffered bar in the gap, so an early floor knock-out is not skipped', () => {
    const dir = tmp();
    const file = path.join(dir, 'p.json');
    seed(file, { position: position() });
    // 12 missed bars; the floor breaks on bar 2 and price recovers afterwards.
    const candles = Array.from({ length: 13 }, (_, i) => bar(i, i === 2 ? { low: 62900 } : {}));
    const paper = make(dir, candles);
    assert.equal(paper.step(), true);
    const st = paper.getStatus();
    assert.equal(st.position, null);
    assert.equal(st.cycles.length, 1);
    assert.equal(st.cycles[0].reason, 'knock_out_floor');
    assert.equal(st.cycles[0].closedAt, T0 + 2 * MIN + MIN);
    assert.equal(st.summary.gaps, 0, 'contiguous buffer is not a gap');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records a visible GAP marker and keeps a pending EXIT when the buffer lost bars', () => {
    const dir = tmp();
    const file = path.join(dir, 'p.json');
    seed(file, { pending: { action: 'EXIT' }, position: position() });
    const candles = [bar(50), bar(51), bar(52)]; // bars 1..49 are gone
    const paper = make(dir, candles);
    paper.step();
    const st = paper.getStatus();
    const gap = st.events.find(e => e.action === 'GAP');
    assert.ok(gap, 'GAP event recorded');
    assert.equal(gap.missingBars, 49);
    assert.equal(gap.droppedPending, null);
    assert.equal(gap.keptPending, 'EXIT');
    assert.equal(st.summary.gaps, 1);
    assert.equal(st.cycles[0].reason, 'exit', 'an exit is filled late rather than lost');
    assert.equal(st.cycles[0].closedAt, T0 + 50 * MIN);
    assert.equal(st.position, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('up-dip paper running totals', () => {
  it('keeps count, wins, losses and pnl past the 500-cycle cap', () => {
    const dir = tmp();
    const file = path.join(dir, 'p.json');
    const cycles = Array.from({ length: 500 }, (_, i) => ({ openedAt: i, closedAt: i, pnl: 1 }));
    seed(file, {
      cycles, position: position(),
      totals: { cycles: 700, wins: 450, losses: 250, pnl: 200, worst: -30 },
    });
    // Floor knock-out closes the position at a -500 cycle (cost 500, proceeds 0).
    const paper = make(dir, [bar(1, { low: 62900 })]);
    paper.step();
    const st = paper.getStatus();
    assert.equal(st.summary.cycles, 701);
    assert.equal(st.summary.wins, 450);
    assert.equal(st.summary.losses, 251);
    assert.equal(st.summary.pnl, -300);
    assert.equal(st.summary.worst, -500);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cycles.length, 500, 'recent list stays capped');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('seeds totals from retained cycles when loading state saved before aggregates existed', () => {
    const dir = tmp();
    seed(path.join(dir, 'p.json'), { cycles: [{ pnl: 10 }, { pnl: -4 }, { pnl: 2.5 }] });
    const st = make(dir, []).getStatus();
    assert.deepEqual([st.summary.cycles, st.summary.wins, st.summary.losses, st.summary.pnl, st.summary.worst], [3, 2, 1, 8.5, -4]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('up-dip paper stop and reload', () => {
  it('stop halts polling and reload re-reads a restored state file', () => {
    const dir = tmp();
    const file = path.join(dir, 'p.json');
    seed(file, { totals: { cycles: 1, wins: 1, losses: 0, pnl: 5, worst: 5 } });
    const paper = make(dir, []);
    paper.start(1_000_000);
    paper.stop();
    paper.stop(); // idempotent
    seed(file, { totals: { cycles: 9, wins: 9, losses: 0, pnl: 90, worst: 1 } }); // simulated restore
    assert.equal(paper.getStatus().summary.cycles, 1, 'memory still holds the pre-restore book');
    paper.reload();
    assert.equal(paper.getStatus().summary.cycles, 9);
    assert.equal(paper.getStatus().summary.pnl, 90);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
