const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAppQuotes } = require('../src/updown/app-quotes');
const { UP_DIP_PARAMS } = require('../src/updown/up-dip-setup');

const NOW = Date.parse('2026-11-23T22:59:30Z');
const EXPIRY = Date.parse('2026-11-28T09:00:00Z');
const HOUR = 3_600_000;
const SHOT1 = { source: 'screenshot', direction: 'Up', range: 2000, shown: 61118.69, up: 61172, down: 61074, floor: 60200, ceiling: 62200, maxLoss: '-$486.00' };
const SHOT2 = { ...SHOT1, shown: 61138.68, up: 61192, down: 61094, floor: 59400, ceiling: 61400, maxLoss: '-$896.00' };
const MANUAL = { source: 'manual', range: 2000, shown: 61118.69, up: 61172, down: 61074, floor: 60200 };

let dir, statePath, clock, latest, logs;
const readJSON = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const make = () => createAppQuotes({
  statePath, readJSON, writeJSON: (p, d) => fs.writeFileSync(p, JSON.stringify(d)),
  getLatest: () => latest, clock: () => clock, logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
});
const fail = (input, pattern) => {
  const { error, quote } = make().check(input);
  assert.equal(quote, undefined, `accepted: ${JSON.stringify(input)}`);
  assert.match(error, pattern);
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-quotes-'));
  statePath = path.join(dir, 'app-quotes.json');
  clock = NOW;
  latest = { coinbase: { value: 61140, at: NOW - 400 }, index: { value: 61136, at: NOW - 900 } };
  logs = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('recording a quote', () => {
  it('accepts both screenshots at a $49 half-spread', () => {
    const quotes = make();
    for (const shot of [SHOT1, SHOT2]) assert.equal(quotes.record(shot).quote.halfSpread, 49);
    const [first] = JSON.parse(fs.readFileSync(statePath, 'utf8')).quotes;
    assert.deepEqual(first, {
      capturedAt: NOW, recordedAt: NOW, source: 'screenshot', range: 2000, shown: 61118.69, up: 61172, down: 61074,
      floor: 60200, ceiling: 62200, expiry: EXPIRY, halfSpread: 49, coinbase: 61140, index: 61136,
    });
  });

  it('checks without saving', () => {
    assert.equal(make().check(SHOT1).quote.halfSpread, 49);
    assert.equal(fs.existsSync(statePath), false);
  });

  it('accepts a manual quote, filling in the ceiling, time and expiry', () => {
    const { quote } = make().record(MANUAL);
    assert.deepEqual([quote.ceiling, quote.capturedAt, quote.expiry], [62200, NOW, EXPIRY]);
  });

  it('records a $500 quote with no spread at all', () => {
    const { quote } = make().record({ source: 'manual', range: 500, shown: 61140, up: 61140, down: 61140, floor: 60900 });
    assert.equal(quote.halfSpread, 0);
  });

  it('stores one quote for a double click', () => {
    const quotes = make();
    quotes.record(SHOT1);
    clock = NOW + 400;
    assert.equal(quotes.record(SHOT1).quote.capturedAt, NOW);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).quotes.length, 1);
  });

  it('keeps the newest 500', () => {
    const quotes = make();
    for (let i = 0; i < 501; i++) { clock = NOW + i * 60_000; latest.coinbase.at = clock; quotes.record({ ...MANUAL, up: 61172 + (i % 5) }); }
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8')).quotes;
    assert.equal(stored.length, 500);
    assert.equal(stored[0].capturedAt, NOW + 60_000);
  });
});

describe('refusing a quote', () => {
  it('for a $2,000 range with no spread', () => fail({ ...MANUAL, up: 61119, down: 61118 }, /spread/i));
  it('for a contract that has expired by now', () => {
    clock = EXPIRY + HOUR;
    fail({ ...MANUAL, capturedAt: EXPIRY - HOUR, expiry: EXPIRY }, /expired/i);
  });
  it('whose Down price was misread', () => fail({ ...SHOT1, down: 60974 }, /not centered/i));
  it('whose Up price does not match Max Loss', () => fail({ ...SHOT1, maxLoss: '-$468.00' }, /max loss/i));
  it('from a screenshot with no Max Loss', () => fail({ ...SHOT1, maxLoss: undefined }, /max loss/i));
  it('from a Down screen', () => fail({ ...SHOT1, direction: 'Down' }, /up/i));
  it('with a floor that is not a multiple of 100', () => fail({ ...MANUAL, floor: 60250 }, /multiple of 100/i));
  it('whose ceiling does not match the range', () => fail({ ...SHOT1, ceiling: 62300 }, /range/i));
  it('with Down above the shown price', () => fail({ ...MANUAL, down: 61120 }, /between/i));
  it('with an implausible gap', () => fail({ ...MANUAL, shown: 61100, up: 61300, down: 60898 }, /spread/i));
  it('with an unknown range', () => fail({ ...MANUAL, range: 1000 }, /range/i));
  it('with a price outside the contract', () => fail({ ...MANUAL, floor: 61100 }, /outside/i));
  it('with missing or junk numbers', () => {
    for (const key of ['shown', 'up', 'down', 'floor']) fail({ ...MANUAL, [key]: 'x' }, /number/i);
    fail(null, /number|range/i);
  });
  it('off the week\'s $400 grid', () => {
    make().record(MANUAL);
    fail({ ...MANUAL, floor: 60000, shown: 61120, up: 61173, down: 61075 }, /grid/i);
  });
  it('far from Coinbase when no earlier time is given', () => fail({ ...MANUAL, shown: 61800, up: 61849, down: 61751 }, /coinbase/i));
  it('when Coinbase is not live to check against', () => {
    latest = { coinbase: { value: 61140, at: NOW - 60_000 }, index: null };
    fail(MANUAL, /coinbase/i);
    latest = { coinbase: null, index: null };
    fail(MANUAL, /coinbase/i);
  });
  it('from the future', () => fail({ ...MANUAL, capturedAt: NOW + 61_000 }, /future/i));
  it('whose expiry is not a Saturday settlement', () => fail({ ...MANUAL, expiry: EXPIRY + 13 * HOUR }, /expiry/i));
  it('whose expiry had already passed when captured', () => fail({ ...MANUAL, capturedAt: EXPIRY + HOUR - 14 * 86_400_000 + 86_400_000, expiry: EXPIRY - 14 * 86_400_000 }, /expired/i));
});

describe('captured time and expiry', () => {
  it('accepts an older screenshot with its captured time, and compares it with nothing', () => {
    const { quote } = make().record({ ...MANUAL, shown: 60500, up: 60549, down: 60451, floor: 59400, capturedAt: NOW - 2 * HOUR });
    assert.deepEqual([quote.coinbase, quote.index], [null, null]);
  });
  it('snaps a countdown expiry to the Saturday settlement', () => {
    assert.equal(make().check({ ...SHOT1, expiry: EXPIRY + 25_000 }).quote.expiry, EXPIRY);
    assert.equal(make().check({ ...SHOT1, expiry: EXPIRY - 11 * HOUR }).quote.expiry, EXPIRY);
  });
  it('drops a source that is more than 5s old', () => {
    latest.index.at = NOW - 5_001;
    assert.equal(make().check(MANUAL).quote.index, null);
  });
});

describe('spread in force', () => {
  it('uses the newest quote for 24 hours, then the default', () => {
    const quotes = make();
    quotes.record(MANUAL);
    clock = NOW + 24 * HOUR - 60_000;
    assert.deepEqual(quotes.halfSpread(2000), { value: 49, source: 'quote', capturedAt: NOW, ageMs: 24 * HOUR - 60_000 });
    clock = NOW + 24 * HOUR;
    assert.deepEqual(quotes.halfSpread(2000), { value: 35, source: 'default', capturedAt: null, ageMs: null });
  });
  it('defaults $500 ranges to no spread', () => assert.equal(make().halfSpread(500).value, 0));
  it('never mixes the two ranges', () => {
    const quotes = make();
    quotes.record({ source: 'manual', range: 500, shown: 61140, up: 61150, down: 61130, floor: 60900 });
    assert.equal(quotes.halfSpread(2000).value, 35);
    assert.equal(quotes.halfSpread(500).value, 10);
    quotes.record(MANUAL);
    assert.equal(quotes.halfSpread(500).value, 10);
  });
  it('ignores a quote from the future after the clock is set back', () => {
    const quotes = make();
    quotes.record(MANUAL);
    clock = NOW - 2 * HOUR;
    assert.equal(quotes.halfSpread(2000).source, 'default');
  });
  it('uses the newest captured time, not the newest recorded', () => {
    const quotes = make();
    quotes.record(MANUAL);
    quotes.record({ ...MANUAL, up: 61152, down: 61084, capturedAt: NOW - 3 * HOUR });
    assert.equal(quotes.halfSpread(2000).value, 49);
  });
});

describe('listed contracts', () => {
  it('picks the grid floor nearest the planned offset', () => {
    const quotes = make();
    quotes.record(MANUAL);
    assert.deepEqual(quotes.pick(61138, NOW, UP_DIP_PARAMS), { floor: 59800, ceiling: 61800, range: 2000, maxPayout: 1000, expiry: EXPIRY, expiryDate: '2026-11-28' });
  });
  it('knows nothing without a quote for this expiry', () => {
    const quotes = make();
    assert.equal(quotes.pick(61138, NOW, UP_DIP_PARAMS), null);
    quotes.record({ ...MANUAL, capturedAt: NOW - 7 * 86_400_000, expiry: EXPIRY - 7 * 86_400_000 });
    assert.equal(quotes.pick(61138, NOW, UP_DIP_PARAMS), null);
  });
  it('is not taught by a $500 quote', () => {
    const quotes = make();
    quotes.record({ source: 'manual', range: 500, shown: 61140, up: 61140, down: 61140, floor: 60900 });
    assert.equal(quotes.pick(61138, NOW, UP_DIP_PARAMS), null);
  });
  it('only offers floors the app would list', () => {
    const quotes = make();
    quotes.record(MANUAL);
    for (let price = 60000; price < 64000; price += 37) {
      const c = quotes.pick(price, NOW, UP_DIP_PARAMS);
      assert.equal(c.floor % 400, 200);
      assert.ok(price - c.floor >= 300 && price - c.floor <= 1900, `${price} -> ${c.floor}`);
    }
  });
});

describe('status', () => {
  it('reports spread, listing and the last quote', () => {
    const quotes = make();
    assert.deepEqual(quotes.getStatus().listingSeen, false);
    quotes.record(MANUAL);
    const s = quotes.getStatus();
    assert.equal(s.spread[2000].value, 49);
    assert.equal(s.spread[500].value, 0);
    assert.equal(s.listingSeen, true);
    assert.equal(s.last.floor, 60200);
  });
  it('compares sources only from ten quotes', () => {
    const quotes = make();
    for (let i = 0; i < 9; i++) { clock = NOW + i * 60_000; latest = { coinbase: { value: 61120 + i, at: clock }, index: null }; quotes.record(MANUAL); }
    assert.deepEqual(quotes.getStatus().comparison, { coinbase: { n: 9 }, index: { n: 0 } });
    clock = NOW + 9 * 60_000; latest = { coinbase: { value: 61129, at: clock }, index: null };
    quotes.record(MANUAL);
    assert.deepEqual(quotes.getStatus().comparison, { coinbase: { n: 10, median: -5.31, p90: 10.31 }, index: { n: 0 } });
  });
  it('does not count quotes that had nothing to compare with', () => {
    const quotes = make();
    for (let i = 0; i < 12; i++) quotes.record({ ...MANUAL, capturedAt: NOW - (2 + i) * 60_000 });
    assert.deepEqual(quotes.getStatus().comparison, { coinbase: { n: 0 }, index: { n: 0 } });
  });
  it('reports the newest $2,000 quote as the one costs are shown for, and the last one recorded for removal', () => {
    const quotes = make();
    quotes.record(MANUAL);
    clock = NOW + 60_000; latest.coinbase.at = clock;
    quotes.record({ source: 'manual', range: 500, shown: 61140, up: 61140, down: 61140, floor: 60900 });
    const s = quotes.getStatus();
    assert.equal(s.last.range, 2000);
    assert.equal(s.lastRecorded.range, 500);
  });
});

describe('removing a mistaken quote', () => {
  it('frees the week\'s grid', () => {
    const quotes = make();
    const wrong = quotes.record({ ...MANUAL, floor: 60300 }).quote;
    assert.match(quotes.record(MANUAL).error, /grid.*remove/i);
    assert.deepEqual(quotes.remove(wrong.recordedAt), {});
    assert.equal(quotes.record(MANUAL).quote.floor, 60200);
    assert.equal(quotes.pick(61138, NOW, UP_DIP_PARAMS).floor, 59800);
  });
  it('refuses when that quote is no longer the last recorded', () => {
    const quotes = make();
    const first = quotes.record(MANUAL).quote;
    clock = NOW + 60_000; latest.coinbase.at = clock;
    quotes.record({ ...MANUAL, up: 61173 });
    assert.match(quotes.remove(first.recordedAt).error, /last/i);
    assert.match(quotes.remove('x').error, /last/i);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).quotes.length, 2);
  });
  it('refuses when there is nothing to remove', () => assert.match(make().remove(1).error, /last/i));
});

describe('an unreadable file', () => {
  it('is set aside, and defaults apply', () => {
    fs.writeFileSync(statePath, '{not json');
    const quotes = make();
    assert.equal(quotes.halfSpread(2000).value, 35);
    assert.equal(quotes.pick(61138, NOW, UP_DIP_PARAMS), null);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('app-quotes.json.corrupt-')));
  });
  it('with the wrong shape is treated as empty without throwing', () => {
    fs.writeFileSync(statePath, '{"quotes":"nope"}');
    assert.equal(make().halfSpread(2000).value, 35);
  });
});
