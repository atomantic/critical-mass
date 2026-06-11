// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDryRunExecutor } = require('../src/dry-run-executor');

// Minimal config: only the fields exercised by the body-TP round-trip path.
const baseConfig = (overrides = {}) => ({
  entryOffsetBps: 0,
  orderStaleMs: 60_000,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,
  maxOpenOrders: 100,
  feeRate: 0.001, // 0.1% per side
  ...overrides,
});

// Market state stub (only lastPrice/regime are read for logging).
const marketState = () => ({ lastPrice: 0, regime: 'NEUTRAL' });

describe('dry-run body-TP cost basis — round-trip fee parity (#133)', () => {
  it('folds the buy-side entry fee into the body cost basis', async () => {
    const config = baseConfig();
    const exec = createDryRunExecutor('coinbase', config, marketState(), {}, 'BTC-USD');
    exec.setPriceIncrement(0.01);

    // 1) Place + fill an entry so the executor knows the body's real entry price.
    const entryPrice = 100_000;
    const sizeUsdc = 1000; // 0.01 BTC @ 100k
    const placed = await exec.placeEntryBid(sizeUsdc, entryPrice, entryPrice * 1.0001);
    assert.ok(placed.success);
    // Drop price to the bid level so the entry fills at entryPrice.
    exec.checkEntryFills(placed.price);

    const qty = placed.assetQty; // filled buy size
    const expectedEntryFee = qty * placed.price * config.feeRate;

    // 2) Place a body TP for the full filled qty and capture the stamped basis.
    const tpPrice = 110_000;
    const tpRes = await exec.placeBodyTpOrder(qty, tpPrice, 'body-1');
    assert.ok(tpRes.success);

    const bodyInfo = exec.getBodyByTpOrderId(tpRes.orderId);
    assert.ok(bodyInfo, 'body tracking should exist');

    // Cost basis must be entry-priced + entry fee (NOT TP-priced, NOT gross).
    const expectedBasis = (qty * placed.price) + expectedEntryFee;
    assert.ok(
      Math.abs(bodyInfo.costBasis - expectedBasis) < 1e-6,
      `body cost basis ${bodyInfo.costBasis} should equal entry notional + entry fee ${expectedBasis}`,
    );
    // Regression guard: must not be the old TP-notional stamp.
    assert.notEqual(bodyInfo.costBasis, qty * tpPrice);

    // 3) Fill the body TP and verify P&L nets BOTH legs' fees.
    exec.checkTpFills(tpPrice);

    const filled = exec.getFilledOrders().find((o) => o.isBody);
    assert.ok(filled, 'body TP should be filled');

    // Expected round-trip P&L:
    //   netProceeds = qty*tpPrice*(1 - feeRate)
    //   costBasis   = qty*entryPrice + entryFee
    //   pnl         = netProceeds - costBasis
    const grossProceeds = qty * tpPrice;
    const sellFee = grossProceeds * config.feeRate;
    const expectedPnl = (grossProceeds - sellFee) - expectedBasis;

    assert.ok(
      Math.abs(filled.pnl - expectedPnl) < 1e-6,
      `body PnL ${filled.pnl} should net both legs' fees (expected ${expectedPnl})`,
    );

    // Round-trip fee total embedded in the cycle should be ~both legs (~0.2% of
    // notional combined), proving the buy-side leg is no longer omitted.
    const grossPnl = grossProceeds - (qty * placed.price);
    const totalFees = grossPnl - filled.pnl;
    const expectedTotalFees = expectedEntryFee + sellFee;
    assert.ok(
      Math.abs(totalFees - expectedTotalFees) < 1e-6,
      `round-trip fees ${totalFees} should equal entry+sell fees ${expectedTotalFees}`,
    );
    assert.ok(expectedEntryFee > 0, 'entry fee leg must be non-zero');
  });

  it('honors an explicit zero fee rate (no fee folded)', async () => {
    const config = baseConfig({ feeRate: 0 });
    const exec = createDryRunExecutor('coinbase', config, marketState(), {}, 'BTC-USD');
    exec.setPriceIncrement(0.01);

    const placed = await exec.placeEntryBid(1000, 100_000, 100_010);
    exec.checkEntryFills(placed.price);
    const qty = placed.assetQty;

    const tpRes = await exec.placeBodyTpOrder(qty, 110_000, 'body-1');
    const bodyInfo = exec.getBodyByTpOrderId(tpRes.orderId);
    // Zero fee => basis is exactly the entry notional.
    assert.ok(Math.abs(bodyInfo.costBasis - qty * placed.price) < 1e-6);
  });
});
