// @ts-check
/**
 * Dry-run executor fixes:
 *   #213D getSimulatedPnL omitted body-TP realized P&L (the primary TP path)
 *   #213E filledOrders grew unbounded; getAverageEntryPrice averaged all cycles
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDryRunExecutor } = require('../src/dry-run-executor');

const baseConfig = (overrides = {}) => ({
  entryOffsetBps: 0,
  orderStaleMs: 60_000,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,
  maxOpenOrders: 100_000,
  feeRate: 0.001,
  ...overrides,
});

const marketState = () => ({ lastPrice: 0, regime: 'NEUTRAL' });

/** Place an entry and immediately fill it at its bid price. Returns filled qty. */
const fillEntry = async (exec, price, sizeUsdc) => {
  const placed = await exec.placeEntryBid(sizeUsdc, price, price * 1.0001);
  exec.checkEntryFills(placed.price);
  return placed.assetQty;
};

describe('#213D dry-run P&L includes body-TP realized P&L', () => {
  it('body-TP fills surface in getSimulatedPnL().realizedPnL', async () => {
    const config = baseConfig();
    const exec = createDryRunExecutor('coinbase', config, marketState(), {}, 'BTC-USD');
    exec.setPriceIncrement(0.01);

    const qty = await fillEntry(exec, 100_000, 1000);

    // Before any sell, realized P&L is zero.
    assert.equal(exec.getSimulatedPnL().realizedPnL, 0);

    const tp = await exec.placeBodyTpOrder(qty, 110_000, 'body-1');
    assert.ok(tp.success);
    exec.checkTpFills(110_000);

    const filled = exec.getFilledOrders().find(o => o.isBody);
    assert.ok(filled, 'body TP should be filled');
    assert.ok(filled.pnl > 0, 'body TP should be profitable');

    const pnl = exec.getSimulatedPnL();
    // Legacy counter is untouched; the body pnl is now in the headline figure.
    assert.equal(pnl.legacyRealizedPnL, 0);
    assert.ok(Math.abs(pnl.bodyRealizedPnL - filled.pnl) < 1e-9);
    assert.ok(
      Math.abs(pnl.realizedPnL - filled.pnl) < 1e-9,
      `realizedPnL ${pnl.realizedPnL} should include the body TP pnl ${filled.pnl}`,
    );
    assert.ok(pnl.realizedAssetPnL > 0, 'body holdback asset P&L should be included');
  });
});

describe('#213E filledOrders is bounded', () => {
  it('trims the retained history to the 1000-entry cap', async () => {
    const exec = createDryRunExecutor('coinbase', baseConfig(), marketState(), {}, 'BTC-USD');
    exec.setPriceIncrement(0.01);

    for (let i = 0; i < 1005; i++) {
      await fillEntry(exec, 100_000, 100);
    }

    assert.equal(exec.getFilledOrders().length, 1000, 'filled history must be capped at 1000');
    assert.equal(exec.getSimulatedPnL().filledOrderCount, 1000);
  });
});

describe('#213E getAverageEntryPrice is scoped to the current cycle', () => {
  it('does not blend a previous cycle entry into the current cycle average', async () => {
    const config = baseConfig();
    const exec = createDryRunExecutor('coinbase', config, marketState(), {}, 'BTC-USD');
    exec.setPriceIncrement(0.01);

    // Cycle 1: entry at 100k, then a legacy TP fill closes the cycle.
    const qty1 = await fillEntry(exec, 100_000, 1000);
    assert.ok(Math.abs(exec.getSimulatedPnL().avgEntryPrice - 100_000) < 1e-6);

    await exec.placeTakeProfitOrder(qty1, 110_000, { forceUpdate: true });
    exec.checkTpFills(110_000); // resets cycle tracking

    // Cycle 2: entry at a much lower 50k. The current-cycle average must be 50k,
    // NOT the lifetime cross-cycle blend (~75k) that would overstate P&L on a
    // new cycle's TP in a trending market.
    await fillEntry(exec, 50_000, 1000);

    const avg = exec.getSimulatedPnL().avgEntryPrice;
    assert.ok(
      Math.abs(avg - 50_000) < 1e-6,
      `current-cycle avg entry ${avg} should be 50000, not a cross-cycle blend`,
    );
  });
});
