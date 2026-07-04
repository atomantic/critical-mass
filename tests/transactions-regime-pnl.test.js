// @ts-check
// Regression test for issue #204: TransactionsRegime's Total P&L / Holdback
// summary multiplied per-order P&L annotations by the number of partial
// fills. The engine (src/fill-ledger.js:annotateFillsByOrderId, ~line 1200)
// writes bodyPnl/satellitePnl/bodyHoldbackAsset identically to EVERY
// partial-fill row of the same orderId, so summing across rows inflates
// Total P&L and Holdback by Nx for any TP that filled in N partials.
//
// admin/src/components/transactionsRegimePnl.js is the extracted pure
// aggregation function (imported by TransactionsRegime.jsx) that dedupes
// these annotations once per orderId and prorates them across partial rows,
// so per-row display shows a fair share and the sum across rows reproduces
// exactly the single annotated total.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = pathToFileURL(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'transactionsRegimePnl.js')
).href;

describe('transactionsRegimePnl.computeFillsWithPnL', () => {
  it('sums a 3-partial annotated sell to the single bodyPnl/bodyHoldbackAsset value, not 3x it', async () => {
    const { computeFillsWithPnL } = await import(modulePath);

    // One TP order ('tp-1') filled in 3 partials. The engine annotates the
    // SAME bodyPnl (30) and bodyHoldbackAsset (0.05) on every partial row —
    // this is the real-world shape that triggered the bug.
    const fills = [
      {
        orderId: 'tp-1', side: 'sell', bodyId: 'body-1', isBodyOwned: true,
        size: 0.3, price: 120, quoteAmount: 36, netFee: 0,
        bodyPnl: 30, bodyHoldbackAsset: 0.05,
        timestamp: 1000,
      },
      {
        orderId: 'tp-1', side: 'sell', bodyId: 'body-1', isBodyOwned: true,
        size: 0.3, price: 120, quoteAmount: 36, netFee: 0,
        bodyPnl: 30, bodyHoldbackAsset: 0.05,
        timestamp: 1001,
      },
      {
        orderId: 'tp-1', side: 'sell', bodyId: 'body-1', isBodyOwned: true,
        size: 0.3, price: 120, quoteAmount: 36, netFee: 0,
        bodyPnl: 30, bodyHoldbackAsset: 0.05,
        timestamp: 1002,
      },
    ];

    const enriched = computeFillsWithPnL(fills);
    assert.equal(enriched.length, 3);

    const totalPnl = enriched.reduce((sum, f) => sum + (f.pnl ?? 0), 0);
    const totalHoldback = enriched.reduce((sum, f) => sum + (f.holdbackAsset ?? 0), 0);

    // Must equal the single annotated value — NOT 3x it (90 / 0.15), which is
    // what the pre-fix per-row summation produced.
    assert.ok(Math.abs(totalPnl - 30) < 1e-9, `expected totalPnl ~30, got ${totalPnl}`);
    assert.ok(Math.abs(totalHoldback - 0.05) < 1e-9, `expected totalHoldback ~0.05, got ${totalHoldback}`);

    // Per-row display must show a prorated share (equal thirds here since all
    // three partials are the same size), not the full order value repeated.
    for (const f of enriched) {
      assert.ok(Math.abs(f.pnl - 10) < 1e-9, `expected each row's prorated pnl ~10, got ${f.pnl}`);
      assert.ok(Math.abs(f.holdbackAsset - 0.05 / 3) < 1e-9, `expected each row's prorated holdback ~${0.05 / 3}, got ${f.holdbackAsset}`);
    }
  });

  it('prorates unevenly-sized partial fills proportionally to their share of order value', async () => {
    const { computeFillsWithPnL } = await import(modulePath);

    const fills = [
      {
        orderId: 'tp-2', side: 'sell', bodyId: 'body-2', isBodyOwned: true,
        size: 0.7, price: 100, quoteAmount: 70, netFee: 0,
        bodyPnl: 20, bodyHoldbackAsset: 0.1,
        timestamp: 2000,
      },
      {
        orderId: 'tp-2', side: 'sell', bodyId: 'body-2', isBodyOwned: true,
        size: 0.3, price: 100, quoteAmount: 30, netFee: 0,
        bodyPnl: 20, bodyHoldbackAsset: 0.1,
        timestamp: 2001,
      },
    ];

    const enriched = computeFillsWithPnL(fills);
    const totalPnl = enriched.reduce((sum, f) => sum + (f.pnl ?? 0), 0);
    const totalHoldback = enriched.reduce((sum, f) => sum + (f.holdbackAsset ?? 0), 0);

    assert.ok(Math.abs(totalPnl - 20) < 1e-9, `expected totalPnl ~20, got ${totalPnl}`);
    assert.ok(Math.abs(totalHoldback - 0.1) < 1e-9, `expected totalHoldback ~0.1, got ${totalHoldback}`);

    // 70/30 split of the order's quote value → 70% / 30% of the annotated pnl
    const [first, second] = enriched;
    assert.ok(Math.abs(first.pnl - 14) < 1e-9, `expected first row pnl ~14, got ${first.pnl}`);
    assert.ok(Math.abs(second.pnl - 6) < 1e-9, `expected second row pnl ~6, got ${second.pnl}`);
  });

  it('leaves an unannotated single-fill sell using the buy-linkage fallback unaffected', async () => {
    const { computeFillsWithPnL } = await import(modulePath);

    const fills = [
      { orderId: 'buy-1', side: 'buy', sellOrderId: 'tp-3', size: 1, price: 50, quoteAmount: 50, netFee: 0, timestamp: 3000 },
      { orderId: 'tp-3', side: 'sell', size: 1, price: 60, quoteAmount: 60, netFee: 0, timestamp: 3001 },
    ];

    const enriched = computeFillsWithPnL(fills);
    const sell = enriched.find(f => f.side === 'sell');
    // proceeds (60) - buy cost (50) = 10
    assert.ok(Math.abs(sell.pnl - 10) < 1e-9, `expected linked-buy pnl ~10, got ${sell.pnl}`);
  });
});
