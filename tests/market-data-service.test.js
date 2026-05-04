// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { ingestNewFillsForOrder } = require('../src/market-data-service');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Fake adapter where getOrderFills can be programmed per-test.
 * @param {Array<Array|Error>} responses - One entry per call. Array => fills, Error => throw.
 */
const makeAdapter = (responses) => {
  let i = 0;
  return {
    getOrderFills: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

/**
 * Fake fillLedger that mimics ingestFill's idempotent-on-tradeId contract.
 * Accumulates calls so tests can assert what was ingested and what was deduped.
 */
const makeLedger = () => {
  const seen = new Set();
  const ingested = []; // { tradeId, orderPlacedAt }
  let persistCalls = 0;
  return {
    seen,
    ingested,
    get persistCalls() { return persistCalls; },
    ingestFill: (fill, orderPlacedAt = null) => {
      const tradeId = fill.tradeId || fill.trade_id;
      if (seen.has(tradeId)) return { ingested: false, fill: null };
      seen.add(tradeId);
      ingested.push({ tradeId, orderPlacedAt });
      return { ingested: true, fill };
    },
    persist: () => { persistCalls += 1; },
  };
};

const makeFill = (tradeId, size = 0.5) => ({
  tradeId,
  orderId: 'order-1',
  side: 'sell',
  price: 70000,
  size,
  totalCommission: 0.1,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingestNewFillsForOrder', () => {
  let ledger;
  let trackedOrder;

  beforeEach(() => {
    ledger = makeLedger();
    trackedOrder = {
      type: 'take_profit',
      placedAt: Date.now(),
      status: 'open',
      // lastIngestedFilledSize starts unset so default-0 path is exercised
    };
  });

  it('skips work when cumulative size has not advanced beyond watermark', async () => {
    const adapter = makeAdapter([new Error('should not be called')]);
    trackedOrder.lastIngestedFilledSize = 1.0;

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'partial fill'
    );

    assert.deepEqual(result, { fetched: true, fillsCount: 0, ingestedCount: 0 });
    assert.equal(ledger.ingested.length, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });

  it('on a partial fill, ingests the new fill and advances the watermark', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(result.fetched, true);
    assert.equal(result.fillsCount, 1);
    assert.equal(result.ingestedCount, 1);
    assert.equal(ledger.ingested.length, 1);
    assert.equal(ledger.ingested[0].tradeId, 't1');
    assert.equal(trackedOrder.lastIngestedFilledSize, 0.4);
    assert.equal(ledger.persistCalls, 1);
  });

  it('does not double-count when the terminal FILLED event re-fetches an already-ingested partial', async () => {
    // First partial: ledger learns about t1
    const adapter = makeAdapter([
      [makeFill('t1', 0.4)],                           // partial: returns 1 fill
      [makeFill('t1', 0.4), makeFill('t2', 0.6)],       // FILLED: returns both
    ]);

    const partial = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );
    assert.equal(partial.ingestedCount, 1);

    const filled = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'FILLED'
    );

    assert.equal(filled.fetched, true);
    assert.equal(filled.fillsCount, 2);
    assert.equal(filled.ingestedCount, 1, 't1 should be deduped, only t2 newly ingested');
    assert.equal(ledger.ingested.length, 2);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });

  it('does not advance watermark on adapter failure (so next event retries)', async () => {
    const adapter = makeAdapter([new Error('network down')]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'partial fill'
    );

    assert.equal(result.fetched, false);
    assert.equal(result.ingestedCount, 0);
    assert.equal(ledger.ingested.length, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'watermark must NOT advance — next WS update should retry the fetch');
  });

  it('does not advance watermark when adapter returns empty fills (Coinbase post-FILLED race)', async () => {
    const adapter = makeAdapter([[]]);

    const result = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.5, 'FILLED'
    );

    assert.equal(result.fetched, true);
    assert.equal(result.fillsCount, 0);
    assert.equal(result.ingestedCount, 0);
    assert.equal(trackedOrder.lastIngestedFilledSize ?? 0, 0,
      'watermark must NOT advance on empty response — caller relies on this to retry');
  });

  it('passes placedAt for buy orders (entry/ladder) so fill-time tracking works', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);
    trackedOrder.type = 'ladder_entry';
    trackedOrder.placedAt = 1700000000000;

    await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(ledger.ingested[0].orderPlacedAt, 1700000000000,
      'buy orders should pass placedAt so 7-day fill-time stats include them');
  });

  it('passes null placedAt for sell orders (TP)', async () => {
    const adapter = makeAdapter([[makeFill('t1', 0.4)]]);
    trackedOrder.type = 'take_profit';
    trackedOrder.placedAt = 1700000000000;

    await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.4, 'partial fill'
    );

    assert.equal(ledger.ingested[0].orderPlacedAt, null,
      'sell-order placedAt should not flow into the ledger');
  });

  it('handles a series of partial events without re-ingesting prior fills', async () => {
    const adapter = makeAdapter([
      [makeFill('t1', 0.3)],
      [makeFill('t1', 0.3), makeFill('t2', 0.4)],
      [makeFill('t1', 0.3), makeFill('t2', 0.4), makeFill('t3', 0.3)],
    ]);

    const r1 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.3, 'partial fill'
    );
    const r2 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 0.7, 'partial fill'
    );
    const r3 = await ingestNewFillsForOrder(
      { adapter, fillLedger: ledger, exchange: 'coinbase' },
      'order-1', trackedOrder, 1.0, 'FILLED'
    );

    assert.equal(r1.ingestedCount, 1);
    assert.equal(r2.ingestedCount, 1);
    assert.equal(r3.ingestedCount, 1);
    assert.equal(ledger.ingested.length, 3);
    assert.deepEqual(ledger.ingested.map(x => x.tradeId), ['t1', 't2', 't3']);
    assert.equal(trackedOrder.lastIngestedFilledSize, 1.0);
  });
});
