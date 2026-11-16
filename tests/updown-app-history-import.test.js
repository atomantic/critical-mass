const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  contractValue, buyCost, sellProceeds, expiryMs, deriveCycles, validateAppOrder, parseOrderHistory,
} = require('../src/updown/app-order-history');
const { reconcile, validateLedger, validateTradeRecord } = require('../src/updown/app-history-import');

// Two real app orders: a two-cycle row and a $500-range knock-out.
const TWO_CYCLE = {
  n: 1, range: [68800, 70800], expiry: '2026-03-14', note: 'one app order row holding two cycles',
  fills: [
    { side: 'buy', qty: 1, btc: 70221, amount: 712.49, time: '2026-03-12T11:51:44-07:00' },
    { side: 'sell', qty: 1, btc: 70307, amount: 751.51, time: '2026-03-12T11:59:00-07:00', exit: 'closed' },
    { side: 'buy', qty: 1, btc: 70648, amount: 925.99, time: '2026-03-12T19:04:51-07:00' },
    { side: 'sell', qty: 1, btc: 70800, amount: 998.01, time: '2026-03-12T19:32:53-07:00', exit: 'knocked_out' },
  ],
  pnl: 111.04,
};
const NARROW = {
  n: 2, range: [72500, 73000], expiry: '2026-03-21',
  fills: [
    { side: 'buy', qty: 1, btc: 72793, amount: 294.99, time: '2026-03-15T20:46:12-07:00' },
    { side: 'sell', qty: 1, btc: 73000, amount: 498.01, time: '2026-03-15T20:51:09-07:00', exit: 'knocked_out' },
  ],
  tpOrders: [],
  pnl: 203.02,
};

describe('app order pricing', () => {
  it('reproduces app fill amounts from the formula and $1.99 fee', () => {
    const c = { floor: 63600, ceiling: 65600 };
    assert.equal(Math.round(buyCost(65032, c) * 100) / 100, 717.99);
    assert.equal(Math.round(sellProceeds(65111, c, 2) * 100) / 100, 1507.02);
    assert.equal(Math.round(buyCost(72793, { floor: 72500, ceiling: 73000 }) * 100) / 100, 294.99);
  });
  it('knocks out at the floor and caps at the ceiling', () => {
    assert.equal(contractValue(60000, { floor: 63600, ceiling: 65600 }), 0);
    assert.equal(contractValue(70000, { floor: 63600, ceiling: 65600 }), 1000);
    assert.equal(contractValue(80000, { floor: 72500, ceiling: 73000 }), 500);
  });
  it('expires Saturday 04:00 New York across DST', () => {
    assert.equal(expiryMs('2026-03-14'), 1773475200000); // 08:00Z, matches the live contract config
    assert.equal(new Date(expiryMs('2026-11-21')).toISOString(), '2026-11-21T09:00:00.000Z');
  });
});

describe('deriveCycles', () => {
  it('splits a row into one cycle per sell with fees, times and TP orders', () => {
    const cycles = deriveCycles([TWO_CYCLE, NARROW]);
    assert.equal(cycles.length, 3);
    const [a, b, c] = cycles;
    assert.deepEqual([a.cost, a.returnAmount, a.pnl, a.exitType, a.contracts], [712.49, 751.51, 39.02, 'closed', 1]);
    assert.deepEqual([b.pnl, b.exitType, b.appCycleIndex, b.appCycleCount], [72.02, 'knocked_out', 1, 2]);
    assert.equal(a.appOrderKey, b.appOrderKey);
    assert.notEqual(a.importKey, b.importKey);
    assert.equal(a.fees, 3.98);
    assert.equal(a.holdMinutes, 7.27);
    assert.deepEqual([c.contract.range, c.contract.maxPayout, c.contract.floor], [500, 500, 72500]);
  });
  it('rejects orders whose fills do not sum to pnl, or are still open', () => {
    assert.match(validateAppOrder({ ...NARROW, pnl: 1 }), /pnl/);
    assert.match(validateAppOrder({ ...NARROW, fills: [NARROW.fills[0], NARROW.fills[0]] }), /last fill/);
    assert.throws(() => deriveCycles([{ ...NARROW, pnl: 1 }]), /App order 2/);
  });
  it('rejects a sell that does not close exactly the contracts bought since the previous sell', () => {
    const [buy1, sell1, buy2, sell2] = TWO_CYCLE.fills;
    // A sell before any buy would otherwise crash deriveCycles on an empty buy list.
    assert.match(validateAppOrder({ ...TWO_CYCLE, fills: [sell1, buy1, buy2, sell2] }), /does not close the 0 contract/);
    // buy 2, sell 1, buy 1, sell 2: totals agree but per-cycle cost would be misattributed.
    const skewed = [{ ...buy1, qty: 2 }, sell1, buy2, { ...sell2, qty: 2 }];
    assert.match(validateAppOrder({ ...TWO_CYCLE, fills: skewed }), /sell of 1 .* does not close the 2 contract/);
    assert.equal(validateAppOrder(TWO_CYCLE), null);
  });
  it('parses JSONL', () => {
    assert.equal(parseOrderHistory(`${JSON.stringify(NARROW)}\n\n`).length, 1);
  });
});

describe('reconcile', () => {
  const manual = (id, date, cost, returnAmount) => ({ id, date, cost, returnAmount, pnl: returnAmount - cost, note: 'mine', direction: 'up' });
  const cycles = deriveCycles([TWO_CYCLE, NARROW]);

  it('enriches exact matches, corrects near matches, adds missing, keeps the note', () => {
    const ledger = { trades: [manual(30, '2026-03-12', 712.49, 751.51), manual(33, '2026-03-16', 300, 498.01)], nextId: 50 };
    const { ledger: next, diff } = reconcile(ledger, cycles, { now: '2026-11-16T00:00:00Z' });
    assert.deepEqual(diff.enriched.map(r => r.id), [30]);
    assert.deepEqual(diff.corrected.map(r => [r.id, r.from.cost, r.to.cost]), [[33, 300, 294.99]]);
    assert.deepEqual(diff.added.map(r => r.id), [50]);
    assert.equal(next.nextId, 51);
    const t30 = next.trades.find(t => t.id === 30);
    assert.equal(t30.note, 'mine');
    assert.equal(t30.source, 'app-order-history');
    assert.equal(t30.importedFrom.match, 'exact');
    assert.equal(t30.entryTime, '2026-03-12T18:51:44.000Z');
    assert.equal(next.trades.find(t => t.id === 33).importedFrom.previous.cost, 300);
    assert.deepEqual(validateLedger(next), []);
  });

  it('is idempotent: a second import changes nothing', () => {
    const first = reconcile({ trades: [manual(30, '2026-03-12', 712.49, 751.51)], nextId: 31 }, cycles).ledger;
    const { ledger: second, diff } = reconcile(first, cycles);
    assert.equal(diff.unchanged.length, 3);
    assert.equal(diff.added.length + diff.enriched.length + diff.corrected.length, 0);
    assert.deepEqual(second, first);
  });

  it('does not fuzzy-match a manual trade far from the cycle date, and never deletes', () => {
    const ledger = { trades: [manual(7, '2026-01-01', 1, 498.01)], nextId: 8 };
    const { ledger: next, diff } = reconcile(ledger, cycles);
    assert.deepEqual(diff.unmatchedManual.map(r => r.id), [7]);
    assert.equal(next.trades.length, 4);
  });
});

describe('validateTradeRecord', () => {
  it('keeps legacy manual records valid', () => {
    assert.deepEqual(validateTradeRecord({ id: 1, date: '2026-02-19', cost: 187.99, returnAmount: 261.01, pnl: 73.02, note: '' }), []);
  });
  it('flags broken imported records', () => {
    const errs = validateTradeRecord({ id: 1, date: '2026-02-19', cost: 1, returnAmount: 2, pnl: 1, source: 'app-order-history', fills: [] });
    assert.ok(errs.some(e => /importKey/.test(e)));
    assert.ok(errs.some(e => /fills required/.test(e)));
  });
});
