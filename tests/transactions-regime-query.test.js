const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { parseFillsQuery, createTransactionsReadView } = require('../src/transactions-regime-query');
const { computeFillsWithPnL } = require('../shared/transactions-regime-pnl.mjs');
const { sortFills, summarizeFills } = require('../shared/transactions-regime-page.mjs');
const fills = count => Array.from({ length: count }, (_, i) => ({ tradeId: `trade-${String(i).padStart(5, '0')}`, orderId: `order-${i}`, timestamp: 1000 + Math.floor(i / 2), side: i % 3 ? 'buy' : 'sell', cycleId: `cycle-${i % 4}`, size: 0.01, price: 100 + i % 50, quoteAmount: 1 + (i % 50) / 100, netFee: 0.01, fee: 0.01 }));

describe('regime fills paged query', () => {
  it('reports net fees including full rebates in the whole-history summary', () => {
    const history = fills(3).map((row, i) => ({ ...row,
      fee: 2, netFee: [0, -0.5, undefined][i],
    }));
    const page = createTransactionsReadView(() => history, () => 'rebated').query({ paged: true });
    assert.equal(page.summary.totalFees, 1.5);
  });

  it('validates paging and cannot bypass the 100-row cap', () => {
    assert.deepEqual(parseFillsQuery({}), { success: false, statusCode: 400, error: 'paged=true required' });
    assert.equal(parseFillsQuery({ paged: true, pageSize: 10000 }).pageSize, 100);
    for (const input of [{ paged: 'false' }, { paged: true, pageSize: 0 }, { paged: true, page: '-1' }, { paged: true, page: [] }, { paged: true, sortField: 'constructor' }, { paged: true, side: 'other' }, { paged: true, cycle: {} }, { paged: true, sortDir: 'other' }, { paged: true, page: Number.MAX_SAFE_INTEGER + 1 }, { paged: true, revision: [] }]) {
      assert.equal(parseFillsQuery(input).statusCode, 400, JSON.stringify(input));
    }
  });

  it('validates opt-in cycle options without changing legacy responses', () => {
    for (const input of [{ cycleOptionsPaged: 'yes' }, { cycleOptionsPaged: true, cycleOffset: '-1' },
      { cycleOptionsPaged: true, cycleLimit: 0 }, { cycleOptionsPaged: true, cycleSearch: [] },
      { cycleOptionsPaged: true, cycleSearch: 'x'.repeat(201) }, { cycleOptionsPaged: true, cycleOffset: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.equal(parseFillsQuery({ paged: true, ...input }).statusCode, 400);
    }
    assert.equal(parseFillsQuery({ paged: true, cycleOptionsPaged: true, cycleLimit: 999 }).cycleLimit, 100);
    const view = createTransactionsReadView(() => [...fills(20), { ...fills(1)[0], cycleId: undefined }], () => 'r1');
    const legacy = view.query({ paged: true });
    assert.deepEqual(legacy.cycleIds, ['current', 'cycle-3', 'cycle-2', 'cycle-1', 'cycle-0']);
    assert.equal('cycleOptionsInfo' in legacy, false);
    assert.deepEqual(view.query({ paged: true, cycleOptionsPaged: false }), legacy);
    const options = view.query({ paged: true, cycleOptionsPaged: true, cycleOffset: 999, cycleLimit: 2 });
    assert.deepEqual(options.cycleIds, ['cycle-1', 'cycle-0']);
    assert.deepEqual(options.cycleOptionsInfo, { offset: 2, limit: 2, total: 4, hasPrev: true, hasNext: false });
    assert.equal(view.query({ paged: true, cycleOptionsPaged: true, cycleSearch: 'absent' }).cycleOptionsInfo.total, 0);
  });

  for (const cycles of [3000, 15000]) it(`bounds options and repeated response bytes for 30,000 fills / ${cycles} cycles`, () => {
    let revision = 'r1';
    const history = fills(30000).map((row, i) => ({ ...row, cycleId: `cycle-${i % cycles}` }));
    const view = createTransactionsReadView(() => history, () => revision);
    const legacy = view.query({ paged: true });
    const query = { paged: true, cycleOptionsPaged: true };
    const first = view.query(query);
    const second = view.query({ ...query, revision: first.revision });
    assert.equal(legacy.cycleIds.length, cycles);
    assert.equal(first.cycleIds.length, 100);
    assert.deepEqual(second, first);
    assert.ok(Buffer.byteLength(JSON.stringify(second)) < 45000);
    console.log(JSON.stringify({ cycles, fills: 30000, legacyBytes: Buffer.byteLength(JSON.stringify(legacy)), boundedBytes: Buffer.byteLength(JSON.stringify(first)), pollBytes: Buffer.byteLength(JSON.stringify(second)), options: first.cycleIds.length }));
    const selected = view.query({ ...query, cycleSearch: 'CYCLE-1', cycleOffset: 0 });
    assert.ok(selected.cycleIds.every(id => id.includes('cycle-1')));
    const old = view.query({ ...query, cycleSearch: 'cycle-0', cycle: 'cycle-0', sortField: 'price', sortDir: 'asc' });
    const expected = computeFillsWithPnL(history).filter(row => row.cycleId === 'cycle-0');
    assert.deepEqual(old.cycleIds, ['cycle-0']);
    assert.deepEqual(old.fills.map(row => row.tradeId), sortFills(expected, 'price', 'asc').map(row => row.tradeId));
    assert.deepEqual(old.summary, summarizeFills(expected));
    assert.equal(old.pageInfo.total, 30000 / cycles);
    revision = 'r2';
    assert.equal(view.query({ ...query, cycle: 'cycle-0', revision: old.revision }).statusCode, 409);
    assert.deepEqual(view.query({ ...query, cycle: 'cycle-0' }).summary, old.summary);
  });

  it('keeps large exchange metadata and ownership annotations out of page responses', () => {
    const history = fills(150).map(row => ({ ...row, rawExchangeResponse: 'x'.repeat(100000), consumedBy: [{ orderId: 'private-detail' }] }));
    const page = createTransactionsReadView(() => history, () => 'rev').query({ paged: true });
    assert.equal(page.fills.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50000);
    assert.ok(page.fills.every(row => !('rawExchangeResponse' in row) && !('consumedBy' in row)));
    assert.equal(history[0].rawExchangeResponse.length, 100000);
  });

  it('pages 30,000 rows globally with deterministic ties, and caches idle/page reads', () => {
    const history = fills(30000);
    let reads = 0;
    const view = createTransactionsReadView(() => { reads++; return history; }, () => 'rev-1');
    const first = view.query({ paged: true, pageSize: 10000 });
    assert.equal(first.fills.length, 100);
    assert.equal(first.pageInfo.total, 30000);
    assert.equal(first.pageInfo.pageCount, 300);
    const seen = new Set();
    for (let page = 0; page < 300; page++) {
      const result = view.query({ paged: true, page, revision: first.revision });
      assert.equal(result.fills.length, 100);
      result.fills.forEach(fill => seen.add(fill.tradeId));
    }
    assert.equal(seen.size, 30000);
    assert.equal(reads, 1);
    assert.equal(view.getRecomputeCount(), 1);
    const reversed = createTransactionsReadView(() => [...history].reverse(), () => 'rev-1');
    assert.deepEqual(view.query({ paged: true, sortField: 'price' }).fills.map(f => f.tradeId), reversed.query({ paged: true, sortField: 'price' }).fills.map(f => f.tradeId));
  });

  it('preserves cross-page linked buys, uneven annotated partials, fallback and all global filters/sorts', () => {
    const history = fills(300);
    history.unshift({ tradeId: 'linked-buy', orderId: 'linked-buy-order', side: 'buy', timestamp: 1, size: 1, price: 10, quoteAmount: 10, netFee: 1, sellOrderId: 'linked-sell', isBodyOwned: true });
    history.push({ tradeId: 'linked-sell', orderId: 'linked-sell', side: 'sell', timestamp: 10000, size: 1, price: 20, quoteAmount: 20, netFee: 1, isBodyOwned: true });
    for (const [id, size] of [['partial-1', 0.2], ['partial-2', 0.8]]) history.push({ tradeId: id, orderId: 'partial-sell', side: 'sell', timestamp: 10001, size, price: 20, quoteAmount: size * 20, bodyPnl: 15, bodyHoldbackAsset: 0.05, bodyReservesSoldAsset: 0.01, isBodyOwned: true });
    const enriched = computeFillsWithPnL(history);
    const view = createTransactionsReadView(() => history, () => 'revision');
    for (const sortField of ['timestamp', 'cycleId', 'side', 'size', 'price', 'quoteAmount', 'fee', 'holdbackAsset', 'pnl']) {
      for (const sortDir of ['asc', 'desc']) {
        for (const side of ['all', 'buy', 'sell']) {
          for (const cycle of ['all', 'current', 'cycle-2']) {
            const filtered = enriched.filter(row => (side === 'all' || row.side === side) && (cycle === 'all' || (row.cycleId || 'current') === cycle));
            const expected = sortFills(filtered, sortField, sortDir);
            const actual = view.query({ paged: true, sortField, sortDir, side, cycle });
            assert.deepEqual(actual.fills.map(row => [row.tradeId, row.pnl, row.holdbackAsset, row.holdbackValue, row.avgCost]), expected.slice(0, 100).map(row => [row.tradeId, row.pnl, row.holdbackAsset, row.holdbackValue, row.avgCost]));
            assert.deepEqual(actual.summary, summarizeFills(filtered));
            assert.equal(actual.pageInfo.total, expected.length);
          }
        }
      }
    }
    const sells = view.query({ paged: true, side: 'sell' }).fills;
    assert.equal(sells.find(row => row.tradeId === 'linked-sell').pnl, 8);
    assert.equal(sells.find(row => row.tradeId === 'partial-1').pnl, 3);
    assert.equal(sells.find(row => row.tradeId === 'partial-2').pnl, 12);
    assert.equal(view.getRecomputeCount(), 1);
  });

  it('rejects mixed revisions without rows, reloads and clamps shrinking history', () => {
    let history = fills(300);
    let revision = 'old';
    const view = createTransactionsReadView(() => history, () => revision);
    const old = view.query({ paged: true, page: 2 });
    history = fills(50); revision = 'new';
    const stale = view.query({ paged: true, page: 2, revision: old.revision });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.code, 'STALE_FILL_REVISION');
    assert.equal(stale.fills, undefined);
    const next = view.query({ paged: true, page: 2 });
    assert.equal(next.pageInfo.page, 0);
    assert.equal(next.fills.length, 50);
    assert.equal(view.getRecomputeCount(), 2);
  });

  it('records aggregate decoded bytes, gzip projection, retention and warm query latency', () => {
    const history = fills(30000);
    const view = createTransactionsReadView(() => history, () => 'revision');
    const oldResponse = JSON.stringify({ running: true, fills: history, stats: {} });
    const start = performance.now();
    const response = JSON.stringify({ running: true, ...view.query({ paged: true }) });
    const coldMs = performance.now() - start;
    const median = callback => {
      const samples = Array.from({ length: 15 }, () => { const t = performance.now(); callback(); return performance.now() - t; }).sort((a, b) => a - b);
      return samples[7].toFixed(2);
    };
    const beforeMs = median(() => JSON.parse(JSON.stringify({ running: true, fills: history, stats: {} })));
    const afterMs = median(() => JSON.parse(JSON.stringify({ running: true, ...view.query({ paged: true }) })));
    console.log(JSON.stringify({ fixtureRows: history.length, decodedBeforeBytes: Buffer.byteLength(oldResponse), decodedAfterBytes: Buffer.byteLength(response), gzipProjectionBeforeBytes: gzipSync(oldResponse).length, gzipProjectionAfterBytes: gzipSync(response).length, retainedClientRowsBefore: history.length, retainedClientRowsAfter: 100, coldEnrichmentAndEncodingMs: coldMs.toFixed(2), medianEncodeDecodeBeforeMs: beforeMs, medianCachedReadEncodeDecodeAfterMs: afterMs }));
    assert.ok(Buffer.byteLength(response) < Buffer.byteLength(oldResponse) / 100);
  });
});
