// @ts-check
// ---------------------------------------------------------------------------
// Regression coverage for issue #679 follow-up: `getOrderFills` now rejects
// on a failed order lookup or an incomplete-fill mismatch instead of
// silently returning a partial set. `recovery.js`'s `getRecentFills` (called
// from `recoverState`, which `regime-engine.js` runs unconditionally on
// every engine start with no outer try/catch) iterated every open order and
// called `adapter.getOrderFills` with no error handling — a single order's
// rejection would abort the entire startup recovery, leaving the engine
// registered (per engine-lifecycle-handlers.js) but never actually started.
//
// getRecentFills now catches a per-order failure, logs it, and continues
// recovering the rest instead of aborting the whole scan.
// ---------------------------------------------------------------------------
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRecoveryModule } = require('../src/recovery');

describe('recovery.getRecentFills resilience (issue #679 follow-up)', () => {
  it('skips an order whose getOrderFills rejects and still returns fills from the rest', async () => {
    const adapter = {
      getOpenOrders: async () => [
        { orderId: 'order-ok-1', filledSize: 0.5 },
        { orderId: 'order-bad', filledSize: 0.2 },
        { orderId: 'order-ok-2', filledSize: 0.3 },
      ],
      getOrderFills: async (orderId) => {
        if (orderId === 'order-bad') {
          throw Object.assign(new Error(`fills incomplete for ${orderId}: 0.1 of 0.2`), { incompleteFills: true });
        }
        return [{ tradeId: `t-${orderId}`, orderId, size: 0.1, price: 100, netFee: 0 }];
      },
    };

    const recovery = createRecoveryModule('coinbase', adapter, 'BTC-USD');
    const fills = await recovery.getRecentFills();

    assert.equal(fills.length, 2, 'must return the fills from the two orders that succeeded');
    assert.deepEqual(fills.map((f) => f.orderId).sort(), ['order-ok-1', 'order-ok-2']);
  });

  it('does not throw and returns an empty list when every order fails', async () => {
    const adapter = {
      getOpenOrders: async () => [{ orderId: 'order-bad', filledSize: 1 }],
      getOrderFills: async () => { throw new Error('order-detail lookup failed'); },
    };

    const recovery = createRecoveryModule('gemini', adapter, 'ETH-USD');
    const fills = await recovery.getRecentFills();

    assert.deepEqual(fills, []);
  });

  it('recoverState completes (does not abort startup) when one open order\'s fills cannot be fetched', async () => {
    const adapter = {
      getOpenOrders: async () => [{ orderId: 'order-bad', filledSize: 1 }],
      getOrderFills: async () => { throw Object.assign(new Error('fills incomplete'), { incompleteFills: true }); },
      getAccountBalance: async () => ({ available: 0, hold: 0 }),
    };
    const fillLedger = {
      ingestFill: () => ({ ingested: false }),
      getCurrentCycleFills: () => [],
      rebuildPositionFromFills: () => ({ totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0 }),
    };

    const recovery = createRecoveryModule('cryptocom', adapter, 'CRO-USD');
    const result = await recovery.recoverState(fillLedger, /* orderExecutor */ {});

    assert.ok(result.position, 'recoverState must resolve with a position instead of rejecting');
    assert.deepEqual(result.discrepancies, []);
  });
});
