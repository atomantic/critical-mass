const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpDipPaper } = require('../src/updown/up-dip-paper');
const { createDailyTrendEntryFilter } = require('../src/updown/up-dip-trend-filter');
const { pickContract } = require('../src/updown/up-dip-setup');

const MIN = 60_000;
const SUN = Date.parse('2026-11-15T18:00:00Z'); // 5.6 days before the Nov 21 expiry

/** 1m closes that rally, flush 1% and turn up: decideUpDip ENTERs if flat. */
const priceAt = (i) => (i < 100 ? 65000 : i < 130 ? 65000 - (i - 100) * 22 : 64340 + (i - 130) * 15);
const candles = (n) => Array.from({ length: n }, (_, i) => {
  const open = priceAt(Math.max(0, i - 1));
  const close = priceAt(i);
  return { timestamp: SUN + i * MIN, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1 };
});
const tfs = (m1) => {
  const m15 = [];
  for (const c of m1) {
    const t = Math.floor(c.timestamp / (15 * MIN)) * 15 * MIN;
    if (m15.at(-1)?.timestamp === t) m15.at(-1).close = c.close;
    else m15.push({ ...c, timestamp: t });
  }
  // Enough older 15m bars for the 15m EMA20.
  const older = Array.from({ length: 30 }, (_, i) => ({ timestamp: SUN - (30 - i) * 15 * MIN, close: 65000 }));
  const h1 = Array.from({ length: 20 }, (_, i) => ({ timestamp: SUN - (20 - i) * 60 * MIN, close: 65000 }));
  return { '1m': m1.slice(-180), '15m': [...older, ...m15.slice(0, -1)], '1h': h1 };
};
const daily = (close) => Array.from({ length: 50 }, () => ({ close }));

/** Underwater Up position from a higher entry, as on 2026-11-23 (62,178 → 61,300). */
const underwater = () => {
  const contract = pickContract(65600, SUN);
  return { contract, contracts: 1, cost: 1000 * (65600 - contract.floor) / 2000 + 1.99, lastFillPrice: 65600, entryPrice: 65600, openedAt: SUN - 60 * MIN };
};

describe('up-dip market signal', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-signal-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (seed, { entryFilter, dailyClose = 65000, to = 160 } = {}) => {
    const statePath = path.join(dir, 'p.json');
    if (seed) fs.writeFileSync(statePath, JSON.stringify({ pricing: { spread: true, source: 'cryptocom-index' }, lastBarTs: SUN + 60 * MIN, startedAt: SUN, ...seed }));
    let n = 62;
    const paper = createUpDipPaper({ getHalfSpread: () => 0,
      getCandles: (tf) => (tf === '1d' ? daily(dailyClose) : tfs(candles(n))[tf] || []),
      statePath, entryFilter, writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
    });
    const seen = [];
    for (; n <= to; n++) { paper.step(); seen.push(paper.getStatus()); }
    return { seen, statePath };
  };

  it('reports ENTER while the paper book HOLDs an underwater position', () => {
    const { seen } = run({ position: underwater() });
    const hit = seen.find(s => s.latest.signal?.action === 'ENTER');
    assert.ok(hit, 'signal must not be masked by the held paper position');
    assert.equal(hit.latest.decision.action, 'HOLD');
    assert.equal(hit.position.entryPrice, 65600);
  });

  it('does not trade on the signal: the held book keeps its position and fills nothing', () => {
    const { seen } = run({ position: underwater() });
    const end = seen.at(-1);
    assert.equal(end.position.contracts, 1);
    assert.equal(end.pending, null);
    assert.ok(end.events.every(e => !/^FILLED_/.test(e.action)));
  });

  it('is not masked by the paper book cooldown', () => {
    const { seen } = run({ lastExitAt: SUN + 125 * MIN }, { to: 145 });
    const hit = seen.find(s => s.latest.signal?.action === 'ENTER');
    assert.ok(hit);
    assert.match(hit.latest.decision.reasons[0], /cooling down/);
  });

  it('remembers the last ENTER signal after the one-bar window closes and across a reload', () => {
    const { seen, statePath } = run({ position: underwater() });
    const hit = seen.findLast(s => s.latest.signal?.action === 'ENTER');
    const end = seen.at(-1);
    assert.notEqual(end.latest.signal.action, 'ENTER');
    assert.deepEqual(end.lastEntrySignal, { at: hit.latest.at, btc: hit.latest.features.price, contract: hit.latest.signal.contract, bookHeld: true });
    const reloaded = createUpDipPaper({ getHalfSpread: () => 0, getCandles: () => [], statePath, writeJSON: () => {} });
    assert.deepEqual(reloaded.getStatus().lastEntrySignal, end.lastEntrySignal);
  });

  it('applies the book entry filter to the signal', () => {
    const { seen } = run({ position: underwater() }, { entryFilter: createDailyTrendEntryFilter(), dailyClose: 80000 });
    assert.ok(seen.every(s => s.latest.signal.action !== 'ENTER'));
    assert.equal(seen.at(-1).lastEntrySignal, null);
  });
});
