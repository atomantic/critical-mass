// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_FEE_RATE_PER_SIDE } = require('../shared/fee-defaults.mjs');
const { createDryRunExecutor } = require('../src/dry-run-executor');

const baseConfig = (overrides = {}) => ({
  entryOffsetBps: 0,
  orderStaleMs: 60_000,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,
  maxOpenOrders: 100,
  ...overrides,
});
const marketState = () => ({ lastPrice: 0, regime: 'NEUTRAL' });

// Entry fill + body TP placement; returns the body's stamped cost basis.
const bodyBasisFor = async (config) => {
  const exec = createDryRunExecutor('coinbase', config, marketState(), {}, 'BTC-USD');
  exec.setPriceIncrement(0.01);
  const entryPrice = 100_000;
  const placed = await exec.placeEntryBid(1000, entryPrice, entryPrice * 1.0001);
  assert.ok(placed.success);
  exec.checkEntryFills(placed.price);
  const tpRes = await exec.placeBodyTpOrder(placed.assetQty, 110_000, 'body-1');
  assert.ok(tpRes.success);
  return exec._test.getBodyByTpOrderId(tpRes.orderId).costBasis;
};

describe('fallback fee rate (shared/fee-defaults)', () => {
  it('is 10 bps per side', () => {
    assert.equal(DEFAULT_FEE_RATE_PER_SIDE, 0.001);
  });

  it('dry-run uses the default when feeRate is unset', async () => {
    const unset = await bodyBasisFor(baseConfig());
    const explicit = await bodyBasisFor(baseConfig({ feeRate: DEFAULT_FEE_RATE_PER_SIDE }));
    assert.ok(Math.abs(unset - explicit) < 1e-9, `unset ${unset} should equal explicit default ${explicit}`);
  });

  it('dry-run still honors an explicit feeRate of 0 (zero-fee dry run)', async () => {
    const zero = await bodyBasisFor(baseConfig({ feeRate: 0 }));
    // Entry notional only: no fee folded into the basis.
    assert.ok(Math.abs(zero - 1000) < 1e-6, `zero-fee basis ${zero} should equal entry notional 1000`);
  });
});
