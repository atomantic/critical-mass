// @ts-check
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

const { createIndexClient } = require('../src/btc-feed/index-client');
const { createIndexSeries } = require('../src/btc-feed/index-series');
const { createIndexHistory } = require('../src/btc-feed/index-history');

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 10, 23, 12, 0, 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Crypto.com index client', () => {
  const connect = (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeWebSocket.reset();
    const values = [];
    const client = createIndexClient({ onValue: (v) => values.push(v) });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    t.after(() => client.disconnect());
    return { client, socket, values };
  };
  const index = (data) => JSON.stringify({ result: { channel: 'index', data } });

  it('subscribes only after the 1s post-connect delay', (t) => {
    const { socket } = connect(t);
    t.mock.timers.tick(999);
    assert.deepEqual(socket.frames, []);
    t.mock.timers.tick(1);
    assert.deepEqual(socket.frames, [{ id: 1, method: 'subscribe', params: { channels: ['index.BTCUSD-INDEX'] } }]);
    assert.equal(socket.url, 'wss://stream.crypto.com/exchange/v1/market');
  });

  it('answers the exchange heartbeat with its id', (t) => {
    const { socket } = connect(t);
    socket.receive(JSON.stringify({ id: 7, method: 'public/heartbeat' }));
    assert.deepEqual(socket.frames, [{ id: 7, method: 'public/respond-heartbeat' }]);
  });

  it('reports index values as numbers', (t) => {
    const { socket, values } = connect(t);
    socket.receive(index([{ v: '61439.25', t: 5000 }]));
    assert.deepEqual(values, [{ value: 61439.25, timestamp: 5000 }]);
  });

  it('ignores malformed frames without dropping the socket', (t) => {
    const { client, socket, values } = connect(t);
    for (const frame of [
      index([{ v: 'x', t: 1 }]), index([{ v: '0', t: 1 }]), index([{ v: '-1', t: 1 }]), index([{ v: '5' }]),
      index([null]), index('nope'), 'not json', 'null', '[]', JSON.stringify({ result: null }),
      JSON.stringify({ id: 1, method: 'subscribe', code: 40004, message: 'bad channel' }),
      JSON.stringify({ result: { channel: 'trade', data: [{ v: '5', t: 1 }] } }),
    ]) socket.receive(frame);
    assert.deepEqual(values, []);
    assert.equal(client.getStatus().connected, true);
  });
});

describe('index series', () => {
  const setup = () => {
    let clock = BASE;
    const series = createIndexSeries({ now: () => clock });
    return { series, setNow: (t) => { clock = t; } };
  };

  it('keeps the latest value in each second', () => {
    const { series } = setup();
    assert.equal(series.add({ value: 101, timestamp: BASE + 800 }), true);
    assert.equal(series.add({ value: 100, timestamp: BASE + 100 }), false);
    assert.deepEqual(series.getValues(60), [{ t: BASE, value: 101 }]);
  });

  it('does not count a repeated or older value as a new event', () => {
    const { series, setNow } = setup();
    series.add({ value: 100, timestamp: BASE + 500 });
    setNow(BASE + 6000);
    assert.equal(series.add({ value: 100, timestamp: BASE + 500 }), false);
    assert.equal(series.add({ value: 99, timestamp: BASE - 1000 }), false);
    assert.equal(series.getLastAcceptedAt(), BASE);
  });

  it('rejects late, future and malformed values', () => {
    const { series } = setup();
    assert.equal(series.add({ value: 1, timestamp: BASE - 10_001 }), false);
    assert.equal(series.add({ value: 1, timestamp: BASE + 5_001 }), false);
    assert.equal(series.add({ value: NaN, timestamp: BASE }), false);
    assert.equal(series.add({ value: 0, timestamp: BASE }), false);
    assert.equal(series.add({ value: 1, timestamp: NaN }), false);
    assert.equal(series.getLastAcceptedAt(), null);
  });

  it('drains changed seconds once and evicts after retention', () => {
    const { series, setNow } = setup();
    series.add({ value: 1, timestamp: BASE });
    assert.deepEqual(series.drainChanged(), [{ t: BASE, value: 1 }]);
    assert.deepEqual(series.drainChanged(), []);
    setNow(BASE + 3_600_000);
    series.add({ value: 2, timestamp: BASE + 3_600_000 });
    assert.deepEqual(series.getValues(3600), [{ t: BASE + 3_600_000, value: 2 }]);
    assert.equal(series.getLastAcceptedAt(), BASE + 3_600_000);
  });

  it('limits getValues to the requested seconds', () => {
    const { series, setNow } = setup();
    for (let s = 0; s < 5; s++) { setNow(BASE + s * 1000); series.add({ value: s + 1, timestamp: BASE + s * 1000 }); }
    assert.deepEqual(series.getValues(2).map(v => v.value), [4, 5]);
  });
});

describe('index history', () => {
  const setup = (over = {}) => {
    const lines = [];
    const warnings = [];
    const history = createIndexHistory({
      dir: '/unused',
      logger: { warn: (message) => warnings.push(message) },
      append: async (file, line) => { lines.push([path.basename(file), JSON.parse(line)]); },
      ...over,
    });
    return { history, lines, warnings };
  };

  it('writes one OHLC line when a minute completes', async () => {
    const { history, lines } = setup();
    [10, 12, 9, 11].forEach((value, i) => history.add({ value, timestamp: BASE + i * 1000 }));
    assert.deepEqual(lines, []);
    history.add({ value: 20, timestamp: BASE + MINUTE });
    await settle();
    assert.deepEqual(lines, [['index-2026-11-23.jsonl', { t: BASE, open: 10, high: 12, low: 9, close: 11, samples: 4 }]]);
  });

  it('never writes a first minute that started part-way through', async () => {
    const { history, lines } = setup();
    for (let s = 45; s < 180; s++) history.add({ value: s, timestamp: BASE + s * 1000 });
    await settle();
    assert.deepEqual(lines.map(([, bar]) => [bar.t, bar.samples]), [[BASE + MINUTE, 60]]);
  });

  it('keeps a first minute whose first value is at most 2s in', async () => {
    const { history, lines } = setup();
    history.add({ value: 1, timestamp: BASE + 2000 });
    history.add({ value: 2, timestamp: BASE + MINUTE });
    await settle();
    assert.deepEqual(lines.map(([, bar]) => bar.t), [BASE]);
  });

  it('splits files at UTC midnight', async () => {
    const { history, lines } = setup();
    const midnight = Date.UTC(2026, 10, 24);
    history.add({ value: 1, timestamp: midnight - MINUTE });
    history.add({ value: 2, timestamp: midnight });
    history.add({ value: 3, timestamp: midnight + MINUTE });
    await settle();
    assert.deepEqual(lines.map(([file]) => file), ['index-2026-11-23.jsonl', 'index-2026-11-24.jsonl']);
  });

  it('writes nothing for a minute with no samples', async () => {
    const { history, lines } = setup();
    history.add({ value: 1, timestamp: BASE });
    history.add({ value: 2, timestamp: BASE + 3 * MINUTE });
    await settle();
    assert.deepEqual(lines.map(([, bar]) => bar.t), [BASE]);
  });

  it('ignores values older than the current minute', async () => {
    const { history, lines } = setup();
    history.add({ value: 5, timestamp: BASE + MINUTE });
    history.add({ value: 1, timestamp: BASE });
    history.add({ value: 6, timestamp: BASE + 2 * MINUTE });
    await settle();
    assert.deepEqual(lines.map(([, bar]) => bar), [{ t: BASE + MINUTE, open: 5, high: 5, low: 5, close: 5, samples: 1 }]);
  });

  it('logs a failed append once and keeps writing later minutes', async () => {
    const lines = [];
    let calls = 0;
    const { history, warnings } = setup({
      append: async (_file, line) => {
        if (++calls === 1) throw new Error('disk full');
        lines.push(JSON.parse(line).t);
      },
    });
    for (let m = 0; m < 3; m++) history.add({ value: 1, timestamp: BASE + m * MINUTE });
    await settle();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disk full/);
    assert.deepEqual(lines, [BASE + MINUTE]);
  });

  it('pause waits for an append in flight, holds later minutes, and resume writes them', async () => {
    const written = [];
    /** @type {Array<() => void>} */
    const release = [];
    const { history } = setup({
      append: (_file, line) => new Promise((resolve) => { release.push(() => { written.push(JSON.parse(line).t); resolve(undefined); }); }),
    });
    history.add({ value: 1, timestamp: BASE });
    history.add({ value: 1, timestamp: BASE + MINUTE });
    await settle();
    let paused = false;
    const pausing = history.pause().then(() => { paused = true; });
    history.add({ value: 1, timestamp: BASE + 2 * MINUTE });
    await settle();
    assert.equal(paused, false, 'pause must wait for the append in flight');
    release[0]();
    await pausing;
    await settle();
    assert.equal(release.length, 1, 'nothing is appended while paused');
    history.resume();
    await settle();
    release[1]();
    await settle();
    assert.deepEqual(written, [BASE, BASE + MINUTE]);
  });

  it('a minute queued behind an append in flight is not written after pause resolves', async () => {
    /** @type {Array<() => void>} */
    const release = [];
    const { history } = setup({ append: () => new Promise((resolve) => { release.push(() => resolve(undefined)); }) });
    for (let m = 0; m < 3; m++) history.add({ value: 1, timestamp: BASE + m * MINUTE });
    await settle();
    const pausing = history.pause();
    release[0]();
    await pausing;
    await settle();
    assert.equal(release.length, 1);
    history.resume();
    await settle();
    assert.equal(release.length, 2);
  });

  it('appends real files with private permissions, creating the directory', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'btc-feed');
    const history = createIndexHistory({ dir, logger: { warn: assert.fail } });
    history.add({ value: 7, timestamp: BASE });
    history.add({ value: 8, timestamp: BASE + MINUTE });
    await settle();
    await history.pause();
    const file = path.join(dir, 'index-2026-11-23.jsonl');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"t":' + BASE + ',"open":7,"high":7,"low":7,"close":7,"samples":1}\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
