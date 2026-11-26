const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UP_DIP_PARAMS, nextExpiryMs, pickContract, decideUpDip, computeUpDipFeatures } = require('../src/updown/up-dip-setup');
const { createUpDipPaper } = require('../src/updown/up-dip-paper');
const { simulate } = require('../scripts/backtest-up-dip');

const MIN = 60_000;
const SUN = Date.parse('2026-11-15T18:00:00Z'); // 5.6 days before the Nov 21 09:00Z expiry
const FRI = Date.parse('2026-11-20T18:00:00Z'); // 0.6 days before

const dipFeatures = (over = {}) => ({ timestamp: SUN - MIN, price: 64700, green1m: true, rsi1m: 45, dropPct: 0.8,
  vs1m: 0.01, vs5m: -0.2, vs15m: -0.3, vs1h: -0.5, vs1d: -3, ...over });

describe('expiry and contract choice', () => {
  it('rolls to the next Saturday 04:00 New York', () => {
    assert.equal(new Date(nextExpiryMs(SUN)).toISOString(), '2026-11-21T09:00:00.000Z');
    assert.equal(new Date(nextExpiryMs(Date.parse('2026-11-21T09:00:00Z'))).toISOString(), '2026-11-28T09:00:00.000Z');
  });
  it('picks the $2000 range with the floor ~floorOffset below price', () => {
    const c = pickContract(64687, SUN);
    assert.deepEqual([c.floor, c.ceiling, c.maxPayout, c.expiryDate], [63100, 65100, 1000, '2026-11-21']);
  });
});

describe('decideUpDip', () => {
  it('blocks entries and adds with no hourly EMA while retaining exit advice', () => {
    const features = dipFeatures({ vs1h: null });
    const contract = pickContract(features.price, SUN);
    const decide = (position) => decideUpDip({
      features, position, now: SUN, halfSpread: 0, params: { ...UP_DIP_PARAMS, maxContracts: 2 },
    });
    assert.match(decide(null).reasons[0], /1h trend unavailable/);
    const position = { contract, contracts: 1, lastFillPrice: features.price + 500, cost: 800 };
    assert.equal(decide(position).action, 'HOLD');
    assert.equal(decide({ ...position, cost: 500 }).action, 'EXIT');
  });

  it('ENTERs on the turn after a dip with expected P&L after fees', () => {
    const d = decideUpDip({ features: dipFeatures(), position: null, now: SUN, halfSpread: 0 });
    assert.equal(d.action, 'ENTER');
    assert.equal(d.contract.floor, 63200);
    assert.ok(d.expected.targetPnlUsd > 0 && d.expected.targetBtc > 64700);
    assert.equal(d.expected.floorLossUsd, -d.expected.costUsd);
  });
  it('STANDS ASIDE late in the week, on breakdowns, without a dip — never Down', () => {
    assert.match(decideUpDip({ features: dipFeatures(), position: null, now: FRI, halfSpread: 0 }).reasons[0], /too late in the week/);
    assert.equal(decideUpDip({ features: dipFeatures({ vs1h: -3 }), position: null, now: SUN, halfSpread: 0 }).action, 'STAND_ASIDE');
    const noDip = decideUpDip({ features: dipFeatures({ dropPct: 0.1 }), position: null, now: SUN, halfSpread: 0 });
    assert.equal(noDip.action, 'STAND_ASIDE');
    for (const f of [dipFeatures({ vs1h: -5 }), dipFeatures({ green1m: false })]) {
      assert.ok(['STAND_ASIDE', 'HOLD', 'EXIT', 'ENTER', 'ADD'].includes(decideUpDip({ features: f, position: null, now: SUN, halfSpread: 0 }).action));
    }
  });
  const position = { contract: pickContract(64700, SUN), contracts: 1, cost: 0, lastFillPrice: 64700, openedAt: SUN };
  position.cost = 1000 * (64700 - position.contract.floor) / 2000 + 1.99;
  it('EXITs once up minGainPct after fees and back above the 1m EMA, else HOLDs', () => {
    const up = 64700 + 120;
    assert.equal(decideUpDip({ features: dipFeatures({ price: up, vs1m: 0.05 }), position, now: SUN, halfSpread: 0 }).action, 'EXIT');
    assert.equal(decideUpDip({ features: dipFeatures({ price: up, vs1m: -0.05 }), position, now: SUN, halfSpread: 0 }).action, 'HOLD');
    assert.equal(decideUpDip({ features: dipFeatures({ price: 64710, vs1m: 0.05 }), position, now: SUN, halfSpread: 0 }).action, 'HOLD');
  });
  it('ADDs on a further dip only when maxContracts allows', () => {
    const f = dipFeatures({ price: 64400, vs1m: -0.3 });
    assert.equal(decideUpDip({ features: f, position, now: SUN, halfSpread: 0 }).action, 'HOLD');
    const d = decideUpDip({ features: f, position, now: SUN, halfSpread: 0, params: { ...UP_DIP_PARAMS, maxContracts: 5 } });
    assert.equal(d.action, 'ADD');
  });
  it('takes a risk exit when configured', () => {
    const d = decideUpDip({ features: dipFeatures({ price: 64000 }), position, now: SUN, halfSpread: 0, params: { ...UP_DIP_PARAMS, maxLossPct: 30 } });
    assert.equal(d.action, 'EXIT');
    assert.match(d.reasons[0], /risk exit/);
  });
});

// Synthetic 1m path: flat, a 1% dip, a turn, then a recovery.
const path1m = (start, n, priceAt) => Array.from({ length: n }, (_, i) => {
  const p = priceAt(i), q = priceAt(i + 1);
  return { timestamp: start + i * MIN, open: p, close: q, high: Math.max(p, q) + 1, low: Math.min(p, q) - 1, volume: 1 };
});
// Completed 15m bars from 1m candles up to index i, plus a seeded hourly trend.
const tfAt = (candles, i) => {
  const m15 = [];
  for (const c of candles.slice(0, i + 1)) {
    const t = Math.floor(c.timestamp / (15 * MIN)) * 15 * MIN;
    const b = m15.at(-1);
    if (b && b.timestamp === t) { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
    else m15.push({ ...c, timestamp: t });
  }
  m15.pop(); // the bucket in progress
  const hour = 60 * MIN;
  const startHour = Math.floor(candles[0].timestamp / hour) * hour;
  const h1 = Array.from({ length: 20 }, (_, n) => ({
    ...candles[0], timestamp: startHour - (20 - n) * hour,
  }));
  return { '1m': candles.slice(Math.max(0, i - 179), i + 1), '15m': m15, '1h': h1 };
};
// 400 flat minutes first so the 15m EMA20 has 20 completed bars.
const priceAt = (i) => (i < 400 ? 65000 : i < 430 ? 65000 - (i - 400) * 22 : 64340 + (i - 430) * 15);

describe('backtest simulate', () => {
  it('enters at the next open after a signal and exits in profit', () => {
    const start = SUN - 600 * MIN;
    const candles = path1m(start, 520, priceAt);
    const features = candles.map((_, i) => computeUpDipFeatures(tfAt(candles, i)));
    const { cycles, fills } = simulate(candles, features, 0, candles.length, UP_DIP_PARAMS);
    assert.ok(fills.length >= 1);
    assert.ok(cycles.length >= 1);
    assert.ok(cycles[0].pnl > 0, JSON.stringify(cycles[0]));
    assert.equal(cycles[0].reason, 'exit');
  });
  it('knocks out at the floor', () => {
    const start = SUN - 600 * MIN;
    const crash = (i) => (i < 460 ? priceAt(i) : 64340 - (i - 460) * 60);
    const candles = path1m(start, 500, crash);
    const features = candles.map((_, i) => (i < 440 ? computeUpDipFeatures(tfAt(candles, i)) : null));
    const { cycles } = simulate(candles, features, 0, candles.length, { ...UP_DIP_PARAMS, minGainPct: 50 });
    assert.equal(cycles.at(-1).reason, 'knock_out_floor');
    assert.equal(cycles.at(-1).proceeds, 0);
  });
});

describe('createUpDipPaper', () => {
  it('fills a paper ENTER at the next bar open and persists state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-'));
    const statePath = path.join(dir, 'paper.json');
    const all = path1m(SUN - 600 * MIN, 520, priceAt);
    let n = 0;
    const paper = createUpDipPaper({ getHalfSpread: () => 0,
      getCandles: (tf) => (n ? (tfAt(all, n - 1)[tf] || []) : []),
      statePath,
      writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
    });
    const actions = [];
    for (n = 60; n <= all.length; n++) {
      paper.step();
      actions.push(paper.getStatus().latest?.decision?.action);
    }
    const status = paper.getStatus();
    assert.equal(status.paperOnly, true);
    assert.ok(actions.includes('ENTER'));
    assert.ok(status.events.some(e => e.action === 'FILLED_ENTER'));
    assert.ok(status.summary.cycles >= 1 && status.summary.pnl > 0);
    assert.equal(paper.step(), false, 'no new bar → no work');
    const reloaded = createUpDipPaper({ getHalfSpread: () => 0, getCandles: () => [], statePath, writeJSON: () => {} });
    assert.equal(reloaded.getStatus().summary.cycles, status.summary.cycles);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
