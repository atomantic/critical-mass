const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpDipPaper } = require('../src/updown/up-dip-paper');
const { UP_DIP_PARAMS } = require('../src/updown/up-dip-setup');

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00Z');
const EXPIRY = Date.parse('2026-11-21T09:00:00Z');
const CONTRACT = { floor: 63000, ceiling: 65000, range: 2000, maxPayout: 1000, expiry: EXPIRY, expiryDate: '2026-11-21' };
const STAMP = { pricing: { spread: true, source: 'cryptocom-index' } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.006, `${a} !== ${b}`);

const bar = (i, over = {}) => ({ timestamp: T0 + i * MIN, open: 64000, high: 64050, low: 63950, close: 64000, volume: 0, ...over });
const position = (over = {}) => ({ contract: CONTRACT, contracts: 1, cost: 519.49, lastFillPrice: 64000, entryPrice: 64000, openedAt: T0, halfSpread: 35, ...over });

let dir, file, candles, coinbase, spread, pickResult, logs;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const seed = (extra, stamp = STAMP) => fs.writeFileSync(file, JSON.stringify({ lastBarTs: T0, startedAt: T0, ...stamp, ...extra }));
const make = (over = {}) => createUpDipPaper({
  getCandles: (tf) => (tf === '1m' ? candles : []),
  getHalfSpread: () => spread,
  pick: () => pickResult,
  statePath: file, archiveDir: path.join(dir, 'archive'),
  writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
  logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  ...over,
});
const witnessed = (bars) => bars.map((b) => ({ ...b, coinbase: coinbase[b.timestamp] ?? null }));
const step = (bars, over) => { candles = witnessed(bars); const paper = make(over); paper.step(); return paper.getStatus(); };
/** A Coinbase bar touching nothing unless told otherwise. */
const cb = (i, over = {}) => { coinbase[T0 + i * MIN] = { high: 64050, low: 63950, complete: true, ...over }; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-costs-'));
  file = path.join(dir, 'up-dip-paper.json');
  candles = [];
  coinbase = {};
  spread = 35;
  pickResult = CONTRACT;
  logs = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('paper fills pay the app\'s spread', () => {
  it('on entry', () => {
    seed({ pending: { action: 'ENTER', contract: CONTRACT } });
    const { position: p } = step([bar(0), bar(1)]);
    near(p.cost, 0.5 * (64035 - 63000) + 1.99);
    assert.equal(p.halfSpread, 35);
    assert.equal(p.entryPrice, 64000);
  });

  it('on an ADD, keeping the larger spread', () => {
    spread = 49;
    seed({ position: position(), pending: { action: 'ADD' } });
    const { position: p } = step([bar(0), bar(1)]);
    near(p.cost, 519.49 + 0.5 * (64049 - 63000) + 1.99);
    assert.equal(p.halfSpread, 49);
    assert.equal(p.contracts, 2);
  });

  it('on exit, at the larger of the entry and current spread', () => {
    seed({ position: position({ halfSpread: 49 }), pending: { action: 'EXIT' } });
    const [cycle] = step([bar(0), bar(1)]).cycles;
    near(cycle.proceeds, 0.5 * (63951 - 63000) - 1.99);
  });

  it('but not on a knock-out or at expiry', () => {
    seed({ position: position() });
    cb(1, { high: 65001 });
    near(step([bar(0), bar(1, { high: 65001 })]).cycles[0].proceeds, 998.01);
    seed({ position: position({ contract: { ...CONTRACT, expiry: T0 + 2 * MIN } }) });
    near(step([bar(0), bar(1)]).cycles[0].proceeds, 0.5 * 1000 - 1.99);
  });

  it('does not enter when the buy price is past the ceiling', () => {
    seed({ pending: { action: 'ENTER', contract: CONTRACT } });
    assert.equal(step([bar(0), bar(1, { open: 64980, high: 64990 })]).position, null);
  });

  it('marks no profit when the spread narrows', () => {
    spread = 49;
    seed({ position: position({ halfSpread: 49 }) });
    candles = [bar(0), bar(1)];
    const paper = make();
    paper.step();
    const before = paper.getStatus().position.pnl;
    spread = 35;
    assert.equal(paper.getStatus().position.pnl, before);
  });

  it('refuses to be built without a spread source', () => {
    assert.throws(() => make({ getHalfSpread: undefined }), TypeError);
  });
});

describe('a book from before real costs', () => {
  const cycles = Array.from({ length: 14 }, (_, i) => ({ openedAt: i, closedAt: i, pnl: 51 }));
  it('is frozen byte for byte, but still evaluates the market', () => {
    seed({ cycles, totals: { cycles: 14, wins: 14, losses: 0, pnl: 714.55, worst: 25.36 }, position: position({ halfSpread: undefined }) }, {});
    const bytes = fs.readFileSync(file, 'utf8');
    const bars = Array.from({ length: 80 }, (_, i) => bar(i, { low: i === 70 ? 60000 : 63950 }));
    candles = bars.slice(0, 70);
    let changes = 0;
    const paper = make({ onChange: () => { changes++; } });
    for (let n = 70; n <= 80; n++) { candles = bars.slice(0, n); paper.step(); }
    const s = paper.getStatus();
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(s.needsReset, true);
    assert.equal(s.summary.cycles, 14);
    assert.ok(s.position, 'the open position is not knocked out');
    assert.equal(s.position.pnl, undefined, 'no bar of its own was saved, so there is nothing to mark it at');
    assert.equal(s.frozenAt, T0 + MIN);
    assert.equal(s.latest.at, bars[79].timestamp + MIN);
    assert.ok(s.latest.features);
    assert.equal(s.latest.signal.action, 'STAND_ASIDE');
    assert.match(s.latest.decision.reasons[0], /reset/);
    assert.equal(changes, 11, 'the panel keeps refreshing');
    assert.equal(paper.step(), false, 'no new bar, no work');
  });

  it('marks its open position where it stopped, not at the live price it cannot act on', () => {
    const latest = { at: bar(0).timestamp + MIN, features: { price: 64000 } };
    seed({ position: position({ halfSpread: undefined }), lastBarTs: bar(0).timestamp, latest, totals: { cycles: 0, wins: 0, losses: 0, pnl: 0, worst: null } }, {});
    const paper = make();
    const before = paper.getStatus();
    candles = Array.from({ length: 80 }, (_, i) => bar(i + 1, { low: 60000, close: 63000 }));
    paper.step();
    const s = paper.getStatus();
    assert.equal(s.latest.features.price, 63000, 'the market view is live');
    assert.equal(s.position.markBtc, 64000);
    assert.equal(s.position.pnl, before.position.pnl);
    assert.equal(s.frozenAt, bar(0).timestamp + MIN);
  });

  it('is never reported as holding when the market signals an entry', () => {
    seed({ position: position() }, {});
    const params = { ...UP_DIP_PARAMS, minDropPct: -100, maxVs15mPct: 100, turnBandPct: 100, maxRsi1m: 101, minDaysToEnter: 0, maxBelow1hPct: 100 };
    candles = Array.from({ length: 80 }, (_, i) => bar(i, { open: 63990 + i / 10, close: 64000 + i / 10 }));
    const paper = make({ params, pick: () => CONTRACT, getCandles: () => candles });
    paper.step();
    assert.equal(paper.getStatus().lastEntrySignal?.bookHeld, false);
  });

  for (const [name, extra] of [['a cycle', { cycles: cycles.slice(0, 1) }], ['a position', { position: position() }], ['a pending fill', { pending: { action: 'ENTER' } }], ['totals only', { totals: { cycles: 3, wins: 3, losses: 0, pnl: 9, worst: 1 } }]]) {
    it(`with ${name} needs a reset`, () => {
      seed(extra, {});
      assert.equal(make().getStatus().needsReset, true);
    });
  }

  it('that never traded is stamped and carries on', () => {
    seed({ events: [{ action: 'STAND_ASIDE' }], cycles: [], totals: { cycles: 0, wins: 0, losses: 0, pnl: 0, worst: null } }, {});
    const s = step([bar(0), bar(1)]);
    assert.equal(s.needsReset, false);
    assert.deepEqual(read().pricing, STAMP.pricing);
  });

  it('priced from another source also needs a reset', () => {
    seed({ position: position(), pricing: { spread: true, source: 'coinbase' } }, {});
    assert.equal(make().getStatus().needsReset, true);
  });

  for (const content of ['{not json', '[]', 'null', '"x"']) {
    it(`that cannot be read (${content}) is left alone and never treated as empty`, () => {
      fs.writeFileSync(file, content);
      const s = step([bar(0), bar(1)]);
      assert.equal(s.needsReset, true);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      assert.equal(make().getStatus().needsReset, true, 'and stays that way after a restart');
    });
  }

  it('starts stamped when there is no file', () => {
    assert.equal(step([bar(0)]).needsReset, false);
    assert.deepEqual(read().pricing, STAMP.pricing);
  });
});

describe('gaps', () => {
  it('in the middle of a replay are counted and drop a pending ENTER', () => {
    seed({ pending: { action: 'ENTER', contract: CONTRACT } });
    const s = step([bar(0), bar(3), bar(4)]);
    assert.equal(s.summary.gaps, 1);
    assert.equal(s.position, null);
    assert.deepEqual(s.events.find((e) => e.action === 'GAP'), { at: T0 + 3 * MIN, action: 'GAP', missingBars: 2, from: T0 + MIN, to: T0 + 2 * MIN, droppedPending: 'ENTER', keptPending: null, openPosition: false });
  });

  it('after the first new bar are noticed too', () => {
    seed({ position: position() });
    assert.equal(step([bar(0), bar(1), bar(5), bar(9)]).summary.gaps, 2);
  });

  it('keep a pending EXIT for the next bar', () => {
    seed({ position: position(), pending: { action: 'EXIT' } });
    const s = step([bar(0), bar(50, { open: 64100 })]);
    assert.equal(s.cycles[0].reason, 'exit');
    assert.equal(s.cycles[0].exitBtc, 64100);
    assert.equal(s.events.find((e) => e.action === 'GAP').keptPending, 'EXIT');
  });
});

describe('a gap across expiry', () => {
  const expired = { ...CONTRACT, expiry: T0 + 10 * MIN };
  it('settles before a later price can fill a kept EXIT', () => {
    seed({ position: position({ contract: expired }), pending: { action: 'EXIT' } });
    const s = step([bar(0), bar(50, { open: 64800, high: 64850, low: 64750, close: 64800 })]);
    assert.equal(s.cycles.length, 1);
    assert.deepEqual([s.cycles[0].reason, s.cycles[0].uncertain], ['expiry', true]);
    assert.equal(s.pending, null);
  });
  it('settles before a later price can knock it out', () => {
    for (const over of [{ high: 65001 }, { low: 62990 }]) {
      seed({ position: position({ contract: expired }) });
      cb(50, over);
      assert.equal(step([bar(0), bar(50, over)]).cycles[0].reason, 'expiry');
    }
  });
  it('uses the last price before the gap when that is nearer expiry', () => {
    seed({ position: position({ contract: expired }), lastClose: 64100, lastBarTs: T0 + 8 * MIN });
    near(step([bar(8), bar(50, { open: 64800 })]).cycles[0].proceeds, 0.5 * (64100 - 63000) - 1.99);
  });
  it('is not used when the bars run up to expiry', () => {
    seed({ position: position({ contract: { ...CONTRACT, expiry: T0 + 2 * MIN } }) });
    assert.equal(step([bar(0), bar(1)]).cycles[0].uncertain, undefined);
  });
});

describe('indicators after an outage', () => {
  const run = (bars) => { candles = witnessed(bars); const paper = make(); paper.step(); return paper.getStatus().latest; };
  it('are withheld while the last hour has a large hole', () => {
    const bars = [...Array.from({ length: 60 }, (_, i) => bar(i)), ...Array.from({ length: 40 }, (_, i) => bar(540 + i, { open: 63000, close: 63000, high: 63050, low: 62950 }))];
    const latest = run(bars);
    assert.equal(latest.features, null);
    assert.match(latest.signal.reasons[0], /not enough candle history/);
  });
  it('tolerate a few missing minutes', () => {
    assert.ok(run([...Array.from({ length: 60 }, (_, i) => bar(i)), ...Array.from({ length: 30 }, (_, i) => bar(65 + i))]).features);
    assert.equal(run([...Array.from({ length: 60 }, (_, i) => bar(i)), ...Array.from({ length: 30 }, (_, i) => bar(66 + i))]).features, null);
  });
});

describe('substitute bars', () => {
  const sub = (i, over = {}) => bar(i, { substitute: true, ...over });

  it('do not knock out when Coinbase did not touch the bound', () => {
    seed({ position: position() });
    cb(1);
    const s = step([bar(0), sub(1, { low: 62990 })]);
    assert.ok(s.position);
    const [e] = s.events.filter((x) => x.action === 'TOUCH_MISMATCH');
    assert.deepEqual([e.bound, e.touched], ['floor', 'BTC_USD']);
  });

  it('take a floor touch as the loss, flagged, when Coinbase stayed unknown', () => {
    seed({ position: position() });
    const [cycle] = step([bar(0), sub(1, { low: 62990 })]).cycles;
    assert.deepEqual([cycle.reason, cycle.proceeds, cycle.coinbaseTouched, cycle.uncertain], ['knock_out_floor', 0, null, true]);
  });

  it('do not take a ceiling touch as the gain when Coinbase stayed unknown', () => {
    seed({ position: position() });
    assert.ok(step([bar(0), sub(1, { high: 65001 })]).position);
  });

  it('treat part of a Coinbase minute as unknown unless it touched', () => {
    seed({ position: position() });
    cb(1, { complete: false });
    assert.equal(step([bar(0), sub(1, { low: 62990 })]).cycles[0].uncertain, true);
    seed({ position: position() });
    cb(1, { complete: false, high: 65001 });
    const [cycle] = step([bar(0), sub(1, { high: 65001 })]).cycles;
    assert.deepEqual([cycle.reason, cycle.coinbaseTouched, cycle.uncertain], ['knock_out_ceiling', true, undefined]);
  });

  it('knock out when Coinbase touched the same bound', () => {
    seed({ position: position() });
    cb(1, { low: 62999 });
    assert.equal(step([bar(0), sub(1, { low: 62990 })]).cycles[0].reason, 'knock_out_floor');
  });

  it('do not knock out when Coinbase touched the other bound', () => {
    seed({ position: position() });
    cb(1, { high: 65001 });
    assert.ok(step([bar(0), sub(1, { low: 62990 })]).position);
  });

  it('fill a pending EXIT but not a pending ENTER', () => {
    seed({ position: position(), pending: { action: 'EXIT' } });
    assert.equal(step([bar(0), sub(1)]).cycles[0].reason, 'exit');
    seed({ pending: { action: 'ENTER', contract: CONTRACT } });
    const s = step([bar(0), sub(1)]);
    assert.equal(s.position, null);
    assert.equal(s.pending, null);
    assert.ok(s.events.some((e) => e.action === 'DROPPED' && e.pending === 'ENTER'));
  });
});

describe('touches seen by only one source', () => {
  it('settle on the index and say Coinbase did not touch', () => {
    seed({ position: position() });
    cb(1);
    const s = step([bar(0), bar(1, { low: 62990 })]);
    assert.equal(s.cycles[0].reason, 'knock_out_floor');
    assert.equal(s.cycles[0].coinbaseTouched, false);
    assert.equal(s.events.find((e) => e.action === 'TOUCH_MISMATCH').touched, 'Crypto.com index');
  });

  it('record that Coinbase agreed', () => {
    seed({ position: position() });
    cb(1, { high: 65001 });
    const s = step([bar(0), bar(1, { high: 65002 })]);
    assert.equal(s.cycles[0].coinbaseTouched, true);
    assert.equal(s.events.some((e) => e.action === 'TOUCH_MISMATCH'), false);
  });

  it('record that Coinbase was unknown', () => {
    seed({ position: position() });
    assert.equal(step([bar(0), bar(1, { low: 62990 })]).cycles[0].coinbaseTouched, null);
  });

  it('log a Coinbase-only touch once per bound', () => {
    seed({ position: position() });
    for (const i of [1, 2, 3]) cb(i, { low: 62999 });
    const s = step([bar(0), bar(1), bar(2), bar(3)]);
    assert.ok(s.position);
    assert.equal(s.events.filter((e) => e.action === 'TOUCH_MISMATCH').length, 1);
    cb(4, { low: 62999 });
    candles = witnessed([bar(0), bar(1), bar(2), bar(3), bar(4)]);
    const again = make();
    again.step();
    assert.equal(again.getStatus().events.filter((e) => e.action === 'TOUCH_MISMATCH').length, 1, 'nor again after a restart');
  });
});

describe('restart', () => {
  it('never fills, knocks out or counts the same minute twice', () => {
    seed({ pending: { action: 'ENTER', contract: CONTRACT } });
    const bars = [bar(0), bar(1), bar(2, { substitute: true }), bar(5)];
    const first = step(bars);
    const again = step(bars);
    assert.deepEqual(again.position, first.position);
    assert.equal(again.summary.gaps, 1);
    assert.equal(again.events.filter((e) => e.action === 'FILLED_ENTER').length, 1);
  });
});

describe('decisions', () => {
  // Flat, a 1% flush, then a turn: the rule ENTERs.
  const SUN = Date.parse('2026-11-15T18:00:00Z');
  const price = (i) => (i < 100 ? 65000 : i < 130 ? 65000 - (i - 100) * 22 : 64340 + (i - 130) * 15);
  const path1m = (n) => Array.from({ length: n }, (_, i) => {
    const open = price(Math.max(0, i - 1)), close = price(i);
    return { timestamp: SUN + i * MIN, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 0 };
  });
  const m15 = Array.from({ length: 30 }, (_, i) => ({ timestamp: SUN - (30 - i) * 15 * MIN, close: 65000 }));
  const h1 = Array.from({ length: 20 }, (_, i) => ({ timestamp: SUN - (20 - i) * 60 * MIN, close: 65000 }));
  const run = ({ mark = (b) => b, until = 160 } = {}) => {
    let n = 62;
    const bars = path1m(until).map(mark);
    const paper = make({ getCandles: (tf) => ({ '1m': bars.slice(Math.max(0, n - 180), n), '15m': m15, '1h': h1 })[tf] || [],
      pick: () => pickResult && { ...pickResult, expiry: Date.parse('2026-11-21T09:00:00Z') } });
    const seen = [];
    for (; n <= until; n++) { paper.step(); seen.push(paper.getStatus()); }
    return seen;
  };

  it('ENTER on a listed contract', () => {
    const hit = run().find((s) => s.latest.decision.action === 'ENTER');
    assert.ok(hit);
    assert.equal(hit.latest.decision.contract.floor, 63000);
  });

  it('stand aside when no contract has been seen this week', () => {
    pickResult = null;
    const seen = run();
    assert.ok(seen.every((s) => s.latest.decision.action !== 'ENTER' && s.latest.signal.action !== 'ENTER'));
    assert.ok(seen.some((s) => s.latest.signal.reasons[0] === 'no listed contract seen this week'));
  });

  it('are not made on substitute bars', () => {
    const seen = run({ mark: (b) => ({ ...b, substitute: true }) });
    assert.ok(seen.every((s) => s.latest.decision.action !== 'ENTER' && s.latest.signal.action !== 'ENTER'));
    assert.ok(seen.some((s) => s.latest.decision.reasons[0] === 'waiting for index data'));
    assert.equal(seen.at(-1).lastEntrySignal, null);
  });
});

describe('archived book', () => {
  it('reports the newest archive of this book only', () => {
    const archive = path.join(dir, 'archive');
    fs.mkdirSync(archive);
    const write = (name, closedCycles) => fs.writeFileSync(path.join(archive, name), JSON.stringify({ summary: { closedCycles }, state: {} }));
    write('up-dip-paper-2026-11-24T10-00-00-000Z.json', 14);
    write('up-dip-paper-2026-11-25T10-00-00-000Z.json', 20);
    write('up-dip-paper-shadow-2026-11-26T10-00-00-000Z.json', 99);
    assert.deepEqual(make().getStatus().archived, { closedCycles: 20 });
  });
  it('is null with none, or with an unreadable one', () => {
    assert.equal(make().getStatus().archived, null);
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.writeFileSync(path.join(dir, 'archive', 'up-dip-paper-2026-11-24T10-00-00-000Z.json'), '{');
    assert.equal(make().getStatus().archived, null);
  });
});

describe('gateway wiring', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const block = (name) => { const i = source.indexOf(`const ${name} = createUpDipPaper({`); return source.slice(i, source.indexOf('\n});', i)); };
  for (const name of ['upDipPaper', 'upDipShadow']) {
    it(`${name} uses the index candles and the app's spread and listing`, () => {
      const text = block(name);
      for (const part of ['getCandles: upDipCandles.getCandles', 'getHalfSpread: getUpDipHalfSpread', 'pick: appQuotes.pick']) assert.ok(text.includes(part), `${name}: ${part}`);
    });
  }
  it('the operator contract checks both sources and is observed on every new minute', () => {
    const i = source.indexOf('const upDipHeld = createUpDipHeld({');
    const text = source.slice(i, source.indexOf('\n});', i));
    for (const part of ['getCandles: upDipCandles.getCandles', 'getCoinbaseCandles', 'getHalfSpread: getUpDipHalfSpread']) assert.ok(text.includes(part), part);
    assert.ok(i < source.indexOf('const upDipPaper = '), 'created before the book whose changes it observes');
    assert.match(block('upDipPaper'), /upDipHeld\.observe\(\)/);
  });
  it('the candles carry Coinbase as a second witness', () => {
    assert.match(source, /createUpDipCandles\(\{[^}]*getCoinbaseMinute: btcFeedService\.getCoinbaseMinute/);
  });
  it('never falls back to a constant spread', () => {
    assert.match(source, /const getUpDipHalfSpread = \(range\) => appQuotes\.halfSpread\(range\)\.value;/);
  });
});
