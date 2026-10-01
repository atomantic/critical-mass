// @ts-check
// Issue #852: the regime Transactions table pages 100 rows at a time while
// totals/sort/filter stay whole-history.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'admin', 'src', 'components');
const pageMod = () => import(pathToFileURL(path.join(dir, 'transactionsRegimePage.js')).href);
const pnlMod = () => import(pathToFileURL(path.join(dir, 'transactionsRegimePnl.js')).href);

function makeFills(n) {
  return Array.from({ length: n }, (_, i) => ({
    tradeId: `t${i}`, orderId: `o${i}`, side: i % 3 === 0 ? 'sell' : 'buy',
    size: 0.01, price: 100 + (i % 50), quoteAmount: 1, netFee: 0.01,
    cycleId: `c${i % 4}`, timestamp: 1000 + i,
  }));
}

describe('transactionsRegimePage', () => {
  it('mounts at most 100 rows for 30,000 fills and reaches every fill via pages', async () => {
    const { paginate } = await pageMod();
    const items = makeFills(30000);
    const seen = new Set();
    let p = 0;
    for (;;) {
      const r = paginate(items, p);
      assert.ok(r.rows.length <= 100);
      r.rows.forEach(f => seen.add(f.tradeId));
      if (!r.hasNext) break;
      p++;
    }
    assert.equal(p, 299);
    assert.equal(seen.size, 30000);
  });

  it('reports range, boundaries and a short last page', async () => {
    const { paginate } = await pageMod();
    const items = makeFills(250);
    const first = paginate(items, 0);
    assert.deepEqual([first.start, first.end, first.pageCount, first.hasPrev, first.hasNext], [1, 100, 3, false, true]);
    const last = paginate(items, 2);
    assert.deepEqual([last.start, last.end, last.rows.length, last.hasPrev, last.hasNext], [201, 250, 50, true, false]);
    const empty = paginate([], 0);
    assert.deepEqual([empty.start, empty.end, empty.pageCount, empty.hasPrev, empty.hasNext], [0, 0, 1, false, false]);
  });

  it('clamps a stale page after the result count shrinks', async () => {
    const { paginate, clampPage } = await pageMod();
    assert.equal(clampPage(299, 250), 2);
    assert.equal(clampPage(-3, 250), 0);
    assert.equal(clampPage(NaN, 250), 0);
    assert.equal(paginate(makeFills(100), 5).page, 0);
    assert.equal(paginate(makeFills(101), 5).rows.length, 1);
  });

  it('sorts the whole history before slicing (page 0 holds global extremes)', async () => {
    const { sortFills, paginate } = await pageMod();
    const fills = makeFills(1000);
    const desc = paginate(sortFills(fills, 'timestamp', 'desc'), 0).rows;
    assert.equal(desc[0].timestamp, 1999);
    const asc = paginate(sortFills(fills, 'timestamp', 'asc'), 0).rows;
    assert.equal(asc[0].timestamp, 1000);
    const byPrice = paginate(sortFills(fills, 'price', 'desc'), 0).rows;
    assert.ok(byPrice.slice(0, 20).every(f => f.price === 149));
    assert.ok(byPrice[20].price < 149);
  });

  it('summary covers the full filtered set regardless of page', async () => {
    const { summarizeFills, paginate } = await pageMod();
    const { computeFillsWithPnL } = await pnlMod();
    const all = computeFillsWithPnL(makeFills(2000));
    const sells = all.filter(f => f.side === 'sell');
    const s = summarizeFills(sells);
    assert.equal(s.totalSells, sells.length);
    assert.equal(s.totalBuys, 0);
    assert.ok(sells.length > 100);
    // Summary is a function of the full list only; slicing does not alter it.
    const page = paginate(sells, 3).rows;
    assert.ok(page.length < sells.length);
    assert.deepEqual(summarizeFills(sells), s);
    const total = summarizeFills(all);
    assert.equal(total.totalBuys + total.totalSells, 2000);
  });
});
