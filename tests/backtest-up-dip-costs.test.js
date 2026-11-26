const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { upDipPath } = require('./helpers/up-dip-path');
const golden = require('./fixtures/up-dip-backtest-golden.json');
const { buildFeatures, simulate, gridPicker, parseArgs, main } = require('../scripts/backtest-up-dip');
const { standalone } = require('../scripts/research-up-selection');
const { UP_DIP_PARAMS, decideUpDip } = require('../src/updown/up-dip-setup');
const { createUpDipPaper } = require('../src/updown/up-dip-paper');

const r6 = (n) => Math.round(n * 1e6) / 1e6;
let candles, features;
before(() => {
  candles = upDipPath();
  features = buildFeatures(candles, UP_DIP_PARAMS);
});
const run = (minGainPct, options) => simulate(candles, features, 0, candles.length, { ...UP_DIP_PARAMS, minDropPct: 0.3, minGainPct }, options);
const simulations = new Map();
const baseline = (gain, halfSpread) => {
  const cacheKey = `${gain}:${halfSpread}`;
  if (!simulations.has(cacheKey)) simulations.set(cacheKey, run(gain, { halfSpread }));
  return simulations.get(cacheKey);
};
const key = (c) => `${c.openedAt}-${c.closedAt}-${c.reason}`;

describe('Up dip backtest costs', () => {
  for (const gain of [4, 40]) {
    it(`with no spread reproduces the results from before costs (${gain}% target)`, () => {
      const { cycles, fills, maxDrawdown } = baseline(gain, 0);
      assert.deepEqual(cycles.map((c) => [c.openedAt, c.closedAt, c.reason, c.floor, r6(c.pnl)]), golden[gain].cycles);
      assert.equal(fills.length, golden[gain].fills);
      assert.equal(r6(maxDrawdown), golden[gain].maxDrawdown);
    });
  }

  it('charges both sides of a closed trade and one side of a settled one', () => {
    // Decide as if there were no spread, so both runs trade the same bars and only pricing differs.
    const spreadless = (input) => decideUpDip({ ...input, halfSpread: 0,
      position: input.position && { ...input.position, cost: input.position.cost - 0.5 * input.halfSpread * input.position.contracts } });
    const seen = {};
    for (const gain of [4, 40]) {
      const free = baseline(gain, 0).cycles;
      const real = run(gain, { halfSpread: 35, decide: spreadless }).cycles;
      assert.deepEqual(real.map(key), free.map(key));
      real.forEach((c, i) => {
        const closed = c.reason === 'exit' || c.reason === 'end_of_period';
        assert.equal(r6(free[i].pnl - c.pnl), closed ? 35 : 17.5, `${c.reason} at ${c.closedAt}`);
        seen[c.reason] = (seen[c.reason] || 0) + 1;
      });
    }
    for (const reason of ['exit', 'knock_out_floor', 'knock_out_ceiling', 'expiry', 'end_of_period']) assert.ok(seen[reason] > 0, `no ${reason}: ${JSON.stringify(seen)}`);
  });

  it('waits longer to exit when the spread is real', () => {
    const exits = (h) => baseline(4, h).cycles.filter((c) => c.reason === 'exit');
    assert.ok(exits(35).length < exits(0).length);
    for (const c of exits(35)) assert.ok(c.pnl > 0);
  });

  it('defaults to $35 a side', () => {
    assert.deepEqual(run(4).cycles, baseline(4, 35).cycles);
    assert.notDeepEqual(run(4).cycles, baseline(4, 0).cycles);
  });

  it('charges a standalone research trade too', () => {
    const params = { ...UP_DIP_PARAMS, minDropPct: 0.3 };
    let compared = 0;
    for (let i = 2000; i < candles.length - 2 && compared < 5; i++) {
      if (decideUpDip({ features: features[i], position: null, now: candles[i].timestamp + 60_000, halfSpread: 0, params }).action !== 'ENTER') continue;
      const free = standalone(candles, features, i, params, 0);
      const real = standalone(candles, features, i, params, 35);
      if (!free || !real || free.closedAt !== real.closedAt) continue;
      assert.ok([17.5, 35].includes(r6(free.pnl - real.pnl)));
      compared++;
    }
    assert.ok(compared > 0);
  });
});

describe('listed floors in a backtest', () => {
  const expiry = Date.parse('2026-06-06T08:00:00Z');
  const orders = [{ range: [63300, 65300], expiry: '2026-06-06' }, { range: [64100, 64600], expiry: '2026-06-13' }];

  it('follow the week\'s grid and skip weeks without one', () => {
    const { cycles } = run(4, { halfSpread: 0, pick: gridPicker(orders) });
    assert.ok(cycles.length > 0);
    assert.ok(cycles.every((c) => c.floor % 400 === 100 && c.expiry === expiry));
  });

  it('are not taught by a $500 order', () => {
    const pick = gridPicker(orders);
    assert.equal(pick(64000, Date.parse('2026-06-08T00:00:00Z'), UP_DIP_PARAMS), null);
    assert.equal(pick(64000, Date.parse('2026-06-02T00:00:00Z'), UP_DIP_PARAMS).floor, 62500);
  });
});

describe('the report', () => {
  const build = (t, args) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-report-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const at = (name) => path.join(dir, name);
    fs.writeFileSync(at('candles.json'), JSON.stringify(candles.slice(0, 3600)));
    fs.writeFileSync(at('orders.jsonl'), `${JSON.stringify({ range: [63300, 65300], expiry: '2026-06-06', fills: [{ side: 'buy', qty: 1, btc: 64300, amount: 501.99, time: '2026-06-02T10:00:00Z' }, { side: 'sell', qty: 1, btc: 64400, amount: 548.01, time: '2026-06-02T12:00:00Z', exit: 'closed' }], pnl: 46.02 })}\n`);
    main(['--candles', at('candles.json'), '--orders', at('orders.jsonl'), '--from', '2026-06-01T00:00:00Z', '--split', '2026-06-02T00:00:00Z', '--to', '2026-06-03T00:00:00Z', '--out', at('report.json'), ...args], () => {});
    return { dir, reportPath: at('report.json'), report: JSON.parse(fs.readFileSync(at('report.json'), 'utf8')) };
  };

  it('records its spread and listing, which the book passes on', t => {
    const { dir, reportPath, report } = build(t, []);
    assert.deepEqual([report.spread, report.listing], [35, 'legacy']);
    const book = createUpDipPaper({ getCandles: () => [], getHalfSpread: () => 0, statePath: path.join(dir, 'b.json'), writeJSON: () => {}, backtestPath: reportPath });
    assert.deepEqual([book.getStatus().backtest.spread, book.getStatus().backtest.listing], [35, 'legacy']);
  });

  it('takes both options', t => {
    const { report } = build(t, ['--spread', '0', '--listing', 'grid']);
    assert.deepEqual([report.spread, report.listing], [0, 'grid']);
  });

  for (const bad of [['--spread', 'x'], ['--spread', '-1'], ['--listing', 'any']]) {
    it(`refuses ${bad.join(' ')}`, () => assert.throws(() => parseArgs(bad), new RegExp(bad[0])));
  }

  it('from before costs reads as having no recorded spread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-dip-report-'));
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify({ from: 'a', split: 'b', to: 'c', defaults: {} }));
    const book = createUpDipPaper({ getCandles: () => [], getHalfSpread: () => 0, statePath: path.join(dir, 'b.json'), writeJSON: () => {}, backtestPath: path.join(dir, 'r.json') });
    assert.deepEqual([book.getStatus().backtest.spread, book.getStatus().backtest.listing], [null, null]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
