const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpDipCandles } = require('../src/updown/up-dip-candles');

const MIN = 60_000;
const TF_MS = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '1d': 1440 * MIN };
/** 12:10:20 on a UTC day, so 12:10 is in progress and the 5m bucket 12:10-12:14 has just begun. */
const M10 = Date.UTC(2026, 10, 23, 12, 10);

let clock, seeds, fetches, substitutes, recorded, push, unsubscribed, candles, failing;

const seedFor = (tf) => {
  const step = TF_MS[tf];
  const current = Math.floor(M10 / step) * step;
  // Twelve completed bars, then the one in progress.
  return Array.from({ length: 13 }, (_, i) => ({ timestamp: current - (12 - i) * step, open: 100, high: 110, low: 90, close: 100, volume: 1 }));
};
const make = (over = {}) => {
  candles = createUpDipCandles({
    subscribeIndex: (fn) => { push = fn; return () => { unsubscribed++; push = () => {}; }; },
    readIndexMinutes: () => recorded,
    fetchCandles: async (tf, count) => {
      fetches.push([tf, count, clock]);
      if (failing.has(tf)) return [];
      if (seeds[tf]) { const s = seeds[tf]; delete seeds[tf]; return s; }
      return substitutes;
    },
    clock: () => clock, logger: { info() {}, warn() {} }, ...over,
  });
  return candles;
};
/** Seed at 12:10:20 with every timeframe available. */
const ready = async () => {
  make();
  candles.start({ timer: false });
  await candles.poll();
  fetches.length = 0;
};
/** `n` index values spread over a minute: 100, then up to `high`, down to `low`, ending at `close`. */
const minute = (ts, n, { open = 100, high = 105, low = 95, close = 102 } = {}) => {
  const values = [open, high, low, ...Array(Math.max(0, n - 4)).fill(open), close].slice(0, n);
  values.forEach((value, i) => push({ value, timestamp: ts + Math.floor(i * (MIN / n)) }));
};
const at = async (ms) => { clock = ms; await candles.poll(); };
const last = (tf = '1m') => candles.getCandles(tf).at(-1);

beforeEach(() => {
  clock = M10 + 20_000;
  seeds = Object.fromEntries(Object.keys(TF_MS).map((tf) => [tf, seedFor(tf)]));
  fetches = [];
  substitutes = [];
  recorded = [];
  unsubscribed = 0;
  failing = new Set();
  push = () => {};
});
afterEach(() => candles?.stop());

describe('seeding', () => {
  it('is ready only once every timeframe has history', async () => {
    failing.add('15m');
    make();
    candles.start({ timer: false });
    await candles.poll();
    assert.equal(candles.isReady(), false);
    assert.deepEqual(candles.getCandles('1m'), [], 'nothing is served before every timeframe is seeded');
    failing.clear();
    await at(clock + 29_000);
    assert.equal(candles.isReady(), false, 'retries every 30s');
    await at(clock + 1_000);
    assert.equal(candles.isReady(), true);
    assert.equal(fetches.filter(([tf]) => tf === '1m').length, 1, 'a seeded timeframe is not fetched again');
  });

  it('serves completed bars only, marking 1m seeds as substitutes', async () => {
    await ready();
    assert.equal(candles.getCandles('1m').length, 12);
    assert.equal(last().timestamp, M10 - MIN);
    assert.ok(candles.getCandles('1m').every((c) => c.substitute === true));
    for (const tf of ['5m', '15m', '1h', '1d']) assert.equal(candles.getCandles(tf).length, 12, tf);
  });

  it('stays consistent when minutes and buckets end while it is fetching', async () => {
    clock = M10 + 4 * MIN + 50_000; // 12:14:50: the 5m bucket ends in 10 seconds
    const bars = (tf, upTo) => Array.from({ length: 12 }, (_, i) => ({ timestamp: upTo - (11 - i) * TF_MS[tf], open: 100, high: 110, low: 90, close: 100, volume: 1 }));
    make({ fetchCandles: async (tf) => {
      if (tf === '1m') { if (clock > M10 + 5 * MIN) return []; clock = M10 + 5 * MIN + 5_000; return bars('1m', M10 + 4 * MIN); }
      return bars(tf, Math.floor(clock / TF_MS[tf]) * TF_MS[tf]);
    } });
    candles.start({ timer: false });
    await candles.poll();
    assert.equal(last().timestamp, M10 + 3 * MIN, 'the 12:14 bar was still open when it was fetched');
    minute(M10 + 4 * MIN, 60);
    minute(M10 + 5 * MIN, 60);
    await at(M10 + 6 * MIN + 2_000);
    const times = candles.getCandles('5m').map((c) => c.timestamp);
    assert.deepEqual(times, [...new Set(times)].sort((a, b) => a - b), 'no bucket is repeated');
    assert.equal(times.at(-1), M10);
  });

  it('prefers recorded index minutes with at least 30 samples', async () => {
    recorded = [
      { t: M10 - 2 * MIN, open: 1, high: 2, low: 0.5, close: 1.5, samples: 30 },
      { t: M10 - MIN, open: 7, high: 8, low: 6, close: 7, samples: 29 },
    ];
    await ready();
    const [a, b] = candles.getCandles('1m').slice(-2);
    assert.deepEqual(a, { timestamp: M10 - 2 * MIN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 });
    assert.equal(b.close, 100);
    assert.equal(b.substitute, true);
  });

  it('survives a thrown fetch and a thrown history read', async () => {
    let calls = 0;
    make({ fetchCandles: async () => { calls++; throw new Error('network'); }, readIndexMinutes: () => { throw new Error('disk'); } });
    candles.start({ timer: false });
    await candles.poll();
    assert.equal(candles.isReady(), false);
    assert.ok(calls > 0);
  });
});

describe('live minutes', () => {
  it('builds the exact bar from index values, two seconds after the minute ends', async () => {
    await ready();
    minute(M10, 60);
    await at(M10 + MIN + 1_999);
    assert.equal(last().timestamp, M10 - MIN, 'late values are still allowed for');
    await at(M10 + MIN + 2_000);
    assert.deepEqual(last(), { timestamp: M10, open: 100, high: 105, low: 95, close: 102, volume: 0 });
    assert.deepEqual(fetches, []);
  });

  it('never serves the minute in progress', async () => {
    await ready();
    minute(M10, 60);
    await at(M10 + 59_000);
    assert.equal(last().timestamp, M10 - MIN);
  });

  it('accepts 30 values and refuses 29', async () => {
    await ready();
    minute(M10, 30);
    await at(M10 + MIN + 2_000);
    assert.equal(last().substitute, undefined);
    minute(M10 + MIN, 29);
    substitutes = [{ timestamp: M10 + MIN, open: 200, high: 201, low: 199, close: 200, volume: 3 }];
    await at(M10 + 2 * MIN + 2_000);
    assert.deepEqual(last(), { timestamp: M10 + MIN, open: 200, high: 201, low: 199, close: 200, volume: 3, substitute: true });
    assert.equal(candles.getStatus().substitutes, 1);
  });

  it('does not use an unfinished exchange candle', async () => {
    await ready();
    await at(M10 + MIN + 2_000);
    substitutes = [{ timestamp: M10 + MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    await at(M10 + MIN + 22_000);
    assert.equal(last().timestamp, M10 - MIN);
  });

  it('holds later minutes behind a missing one, then leaves a gap after two minutes', async () => {
    await ready();
    minute(M10 + MIN, 60);
    await at(M10 + MIN + 2_000);
    assert.equal(candles.getStatus().waitingFor, M10);
    await at(M10 + 2 * MIN + 2_000);
    assert.equal(last().timestamp, M10 - MIN, 'a complete later minute waits its turn');
    await at(M10 + MIN + 2_000 + 119_000);
    assert.equal(last().timestamp, M10 - MIN);
    await at(M10 + MIN + 2_000 + 120_000);
    assert.equal(last().timestamp, M10 + MIN);
    assert.equal(candles.getCandles('1m').some((c) => c.timestamp === M10), false);
    assert.equal(candles.getStatus().gaps, 1);
    assert.equal(candles.getStatus().waitingFor, M10 + 2 * MIN, 'the next minute is due by now and has no data');
  });

  it('is waiting for nothing when every due minute is in', async () => {
    await ready();
    minute(M10, 60);
    await at(M10 + MIN + 2_000);
    assert.equal(candles.getStatus().waitingFor, null);
  });

  it('does not use a candle fetched before its minute ended', async () => {
    const complete = [{ timestamp: M10, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const partial = { timestamp: M10 + MIN, open: 9, high: 9, low: 9, close: 9, volume: 1 };
    let calls = 0;
    make({ fetchCandles: async (tf) => {
      if (seeds[tf]) { const s = seeds[tf]; delete seeds[tf]; return s; }
      calls++;
      clock = M10 + 2 * MIN + 5_000; // slow: the next minute ends while this is in flight
      return [...complete, partial];
    } });
    candles.start({ timer: false });
    await candles.poll();
    await at(M10 + 2 * MIN - 1_000);
    assert.equal(calls, 1);
    assert.equal(last().timestamp, M10);
  });

  it('asks the exchange at most every 20 seconds while waiting', async () => {
    await ready();
    for (let s = 2; s <= 62; s++) await at(M10 + MIN + s * 1000);
    assert.deepEqual(fetches.map(([, , t]) => (t - M10 - MIN) / 1000), [2, 22, 42, 62]);
  });

  it('catches up after a long sleep from one fetch instead of declaring gaps', async () => {
    await ready();
    const wake = M10 + 45 * MIN + 10_000;
    substitutes = Array.from({ length: 46 }, (_, i) => ({ timestamp: M10 + i * MIN, open: 50 + i, high: 60 + i, low: 40 + i, close: 50 + i, volume: 1 }));
    await at(wake);
    assert.equal(last().timestamp, M10 + 44 * MIN);
    assert.equal(candles.getStatus().gaps, 0);
    assert.equal(fetches.length, 1);
    assert.ok(fetches[0][1] >= 45, 'asks for enough candles');
  });

  it('still tries for two minutes after a sleep before giving up', async () => {
    await ready();
    const wake = M10 + 45 * MIN + 10_000;
    await at(wake);
    assert.equal(candles.getStatus().gaps, 0);
    await at(wake + 119_000);
    assert.equal(candles.getStatus().gaps, 0);
    await at(wake + 120_000);
    assert.ok(candles.getStatus().gaps >= 45);
  });
});

describe('higher timeframes', () => {
  it('complete with their last minute and not before', async () => {
    await ready();
    const before = candles.getCandles('5m').length;
    for (let i = 0; i < 5; i++) {
      minute(M10 + i * MIN, 60, { high: 300 + i, low: 50 - i, close: 102 + i });
      await at(M10 + (i + 1) * MIN + 2_000);
      assert.equal(candles.getCandles('5m').length, before + (i === 4 ? 1 : 0), `after minute ${i}`);
    }
    const bar = last('5m');
    assert.equal(bar.timestamp, M10);
    assert.deepEqual([bar.high, bar.low, bar.close], [304, 46, 106]);
  });

  it('complete when the bucket\'s last minute was a gap', async () => {
    await ready();
    const before = candles.getCandles('5m').length;
    for (const i of [0, 1, 2, 3, 5]) minute(M10 + i * MIN, 60);
    for (let t = M10 + MIN + 2_000; t <= M10 + 8 * MIN; t += 10_000) await at(t);
    assert.equal(candles.getCandles('5m').length, before + 1);
    assert.equal(last('5m').timestamp, M10);
  });

  it('keep the seeded open of a bucket already in progress', async () => {
    seeds['1h'].at(-1).open = 77;
    await ready();
    for (let i = 0; i < 50; i++) { minute(M10 + i * MIN, 60); await at(M10 + (i + 1) * MIN + 2_000); }
    assert.equal(last('1h').timestamp, M10 - 10 * MIN);
    assert.equal(last('1h').open, 77);
  });

  it('are bounded', async () => {
    await ready();
    for (let i = 0; i < 200; i++) { minute(M10 + i * MIN, 60); await at(M10 + (i + 1) * MIN + 2_000); }
    assert.equal(candles.getCandles('1m').length, 180);
  });
});

describe('lifecycle', () => {
  it('stop unsubscribes and later polls do nothing', async () => {
    await ready();
    candles.stop();
    assert.equal(unsubscribed, 1);
    await at(M10 + 10 * MIN);
    assert.deepEqual(fetches, []);
  });

  it('a fetch that returns after stop changes nothing', async () => {
    let release;
    make({ fetchCandles: () => new Promise((resolve) => { release = () => resolve(seedFor('1m')); }) });
    candles.start({ timer: false });
    const polling = candles.poll();
    candles.stop();
    release();
    await polling;
    assert.equal(candles.isReady(), false);
    assert.deepEqual(candles.getCandles('1m'), []);
  });

  it('start twice subscribes once', async () => {
    let subs = 0;
    make({ subscribeIndex: () => { subs++; return () => {}; } });
    candles.start({ timer: false });
    candles.start({ timer: false });
    assert.equal(subs, 1);
  });

  it('does not stack polls while a fetch is in flight', async () => {
    let inFlight = 0, most = 0;
    make({ fetchCandles: async () => { most = Math.max(most, ++inFlight); await new Promise((r) => setImmediate(r)); inFlight--; return []; } });
    candles.start({ timer: false });
    await Promise.all([candles.poll(), candles.poll(), candles.poll()]);
    assert.equal(most, 1);
  });
});

describe('recorded index files', () => {
  it('are read from data/btc-feed, skipping torn lines', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-candles-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'btc-feed'));
    const line = (t0, close) => JSON.stringify({ t: t0, open: close, high: close, low: close, close, samples: 60 });
    fs.writeFileSync(path.join(root, 'btc-feed', 'index-2026-11-23.jsonl'), `${line(M10 - 2 * MIN, 11)}\n{"t":17\n${line(M10 - MIN, 12)}\n`);
    make({ DATA_DIR: root, readIndexMinutes: undefined });
    candles.start({ timer: false });
    await candles.poll();
    assert.deepEqual(candles.getCandles('1m').slice(-2).map((c) => c.close), [11, 12]);
  });
});
