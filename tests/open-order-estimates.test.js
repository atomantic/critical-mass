// @ts-check
// Regression test for issue #698: the RegimeDashboard "Open Orders" table's est. P&L /
// est. holdback columns must mirror what the engine actually computed, not a hard-coded
// 6 bps fee and an untiered holdback ratio. See admin/src/utils/openOrderEstimates.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createPositionSizer } = require('../src/position-sizer');
const { getTierConfig, TIERS } = require('../src/celestial-hierarchy');

const load = () => import(pathToFileURL(path.join(__dirname, '../admin/src/utils/openOrderEstimates.mjs')).href);

test('body TP: estHoldback matches the engine holdbackQty for a scaled (planet) tier', async () => {
  const { computeOpenOrderEstimate } = await load();

  const config = { holdbackRatio: 0.5 };
  const sizer = createPositionSizer('test-exchange', config);
  const tierCfg = getTierConfig('planet');

  const totalAsset = 1.5; // body.assetQty before the TP holds anything back
  const avgPrice = 50000;
  const tpPrice = 51500;

  const { sellQty, holdbackQty } = sizer.calculateTakeProfitSize(totalAsset, avgPrice, tpPrice, tierCfg.holdbackScale);

  const bodyData = { assetQty: totalAsset, avgPrice, costBasis: totalAsset * avgPrice, tier: 'planet' };
  const order = { type: 'body_tp', orderId: 'tp-1', size: sellQty, price: tpPrice };

  const { estHoldback } = computeOpenOrderEstimate(order, bodyData, { holdbackRatio: config.holdbackRatio });

  // Exact-subtraction path (body.assetQty - order.size) should land within a satoshi of
  // the engine's own rounded holdbackQty.
  assert.ok(Math.abs(estHoldback - holdbackQty) < 1e-8, `estHoldback=${estHoldback} holdbackQty=${holdbackQty}`);
});

test('body TP: a naive 0.5 (untiered) ratio understates holdback vs. the real planet-tier holdback', async () => {
  const { computeOpenOrderEstimate } = await load();

  const config = { holdbackRatio: 0.5 };
  const sizer = createPositionSizer('test-exchange', config);
  const tierCfg = getTierConfig('planet'); // holdbackScale 1.10

  const totalAsset = 1.5;
  const avgPrice = 50000;
  const tpPrice = 51500;
  const { sellQty, holdbackQty } = sizer.calculateTakeProfitSize(totalAsset, avgPrice, tpPrice, tierCfg.holdbackScale);

  // A hand-rolled untiered-ratio estimate (the pre-fix formula) — should NOT match the
  // engine's tiered holdback; this pins the bug this issue fixes.
  const profitPerAsset = tpPrice - avgPrice;
  const denominator = tpPrice * (1 - 0.5) + avgPrice * 0.5;
  const untieredEstHoldback = sellQty * profitPerAsset * 0.5 / denominator;
  assert.ok(Math.abs(untieredEstHoldback - holdbackQty) > 1e-6, 'untiered estimate unexpectedly matched — test fixture no longer exercises the bug');

  // The fixed util uses the exact body.assetQty - order.size figure and gets it right.
  const bodyData = { assetQty: totalAsset, avgPrice, costBasis: totalAsset * avgPrice, tier: 'planet' };
  const order = { type: 'body_tp', orderId: 'tp-1', size: sellQty, price: tpPrice };
  const { estHoldback } = computeOpenOrderEstimate(order, bodyData, { holdbackRatio: config.holdbackRatio });
  assert.ok(Math.abs(estHoldback - holdbackQty) < 1e-8);
});

test('estPnl uses the configured feeRatePerSide, not a hard-coded 6 bps guess', async () => {
  const { computeOpenOrderEstimate } = await load();

  const order = { type: 'body_tp', orderId: 'tp-1', size: 1, price: 50000 };
  const bodyData = { assetQty: 1.2, avgPrice: 40000, costBasis: 1.2 * 40000, tier: 'satellite' };

  const feeRatePerSide = 0.0012; // deliberately NOT 0.0006, the old hard-coded value
  const { estPnl, estSellFee } = computeOpenOrderEstimate(order, bodyData, { feeRatePerSide });

  const sellValue = order.size * order.price;
  assert.equal(estSellFee, sellValue * feeRatePerSide);

  const proratedCost = (bodyData.costBasis / bodyData.assetQty) * order.size;
  const expectedPnl = (sellValue - estSellFee) - proratedCost;
  assert.ok(Math.abs(estPnl - expectedPnl) < 1e-9);

  // Sanity: the old hard-coded fee would have produced a different (higher) est. P&L.
  const oldEstSellFee = sellValue * 0.0006;
  const oldEstPnl = (sellValue - oldEstSellFee) - proratedCost;
  assert.notEqual(estPnl, oldEstPnl);
});

test('non-body (legacy/core) TP falls back to the ratio formula with tier scale 1.0, matching the untiered engine call', async () => {
  const { computeOpenOrderEstimate } = await load();

  const config = { holdbackRatio: 0.5 };
  const sizer = createPositionSizer('test-exchange', config);

  const totalAsset = 0.8;
  const avgPrice = 30000;
  const tpPrice = 30900;
  // Legacy/core path (regime-engine.js's "Legacy path for untracked core position") calls
  // calculateTakeProfitSize with no tier scale argument — default 1.0.
  const { sellQty, holdbackQty } = sizer.calculateTakeProfitSize(totalAsset, avgPrice, tpPrice);

  const order = { type: 'take_profit', orderId: 'tp-legacy', size: sellQty, price: tpPrice };
  const { estHoldback } = computeOpenOrderEstimate(order, null, { avgCost: avgPrice, holdbackRatio: config.holdbackRatio });

  // No exact figure is available (no bodyData), so this exercises the ratio-formula
  // fallback; it should still land close to the real holdbackQty since tier scale is 1.0.
  assert.ok(Math.abs(estHoldback - holdbackQty) < 1e-6, `estHoldback=${estHoldback} holdbackQty=${holdbackQty}`);
});

test('body TP sold at full qty with zero holdback (exchange-minimum guard) reports exact 0, not a ratio-formula guess', async () => {
  // Mirrors src/regime-engine.js placeBodyTp's exchange-minimum fallback: when the
  // holdback-reduced sellQty rounds below the exchange minimum, the engine sells the
  // FULL body with zero holdback (sellQty = fullQty = body.assetQty, holdbackQty = 0),
  // so assetOnOrder === body.assetQty exactly. bodyData.assetQty and order.size are
  // therefore equal, not assetQty > order.size — the estimate must still report 0.
  const { computeOpenOrderEstimate } = await load();

  const totalAsset = 0.0003; // dust body, fully sold per the exchange-minimum guard
  const avgPrice = 50000;
  const tpPrice = 51500;

  const bodyData = { assetQty: totalAsset, avgPrice, costBasis: totalAsset * avgPrice, tier: 'planet' };
  const order = { type: 'body_tp', orderId: 'tp-dust', size: totalAsset, price: tpPrice };

  const { estHoldback } = computeOpenOrderEstimate(order, bodyData, { holdbackRatio: 0.5 });
  assert.equal(estHoldback, 0);
});

test('bodyData.assetQty < order.size (unreachable in practice, but guarded) falls back to the tiered ratio formula, never negative/NaN', async () => {
  // Regression guard for the >= boundary fixed in this issue: if order.size ever
  // exceeds bodyData.assetQty (stale/partial-fill data, or the >= guard regressing
  // back to a stricter check), the estimate must still be a sane non-negative number
  // from the ratio-formula fallback, never a negative raw subtraction.
  const { computeOpenOrderEstimate } = await load();

  const bodyData = { assetQty: 1, avgPrice: 50000, costBasis: 50000, tier: 'planet' };
  const order = { type: 'body_tp', orderId: 'tp-stale', size: 1.0000001, price: 51500 };

  const { estHoldback } = computeOpenOrderEstimate(order, bodyData, { holdbackRatio: 0.5 });
  assert.ok(estHoldback === null || (Number.isFinite(estHoldback) && estHoldback >= 0), `estHoldback=${estHoldback}`);
});

test('TIER_HOLDBACK_SCALE stays in sync with src/celestial-hierarchy.js TIERS', async () => {
  const { TIER_HOLDBACK_SCALE } = await load();
  for (const tier of TIERS) {
    assert.equal(TIER_HOLDBACK_SCALE[tier.name], tier.holdbackScale, `mismatch for tier ${tier.name}`);
  }
});
