// @ts-check
// A rejected new-body TP must leave its buy rows and accounting committed.
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-buy-booking-tp-rejection');
const configUtils = require('../src/config-utils');
const originalUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
// Fault the TP sizing dependency so placeBodyTp itself rejects. Executor
// transport errors are deliberately caught and returned as false by that step.
const sizerModule = require('../src/position-sizer');
const originalCreateSizer = sizerModule.createPositionSizer;
let beforeTpSizing = () => {};
sizerModule.createPositionSizer = (...args) => {
  const sizer = originalCreateSizer(...args);
  const originalCalculate = sizer.calculateTakeProfitSize;
  sizer.calculateTakeProfitSize = (...params) => {
    beforeTpSizing();
    return originalCalculate(...params);
  };
  return sizer;
};
const { createRegimeEngine } = require('../src/regime-engine');

let engine;
after(() => {
  engine?._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdate;
  sizerModule.createPositionSizer = originalCreateSizer;
  isolatedData.cleanup();
});

it('commits new-body ownership, rows and cycle accounting before TP rejection, then skips replay (#1021, #131)', async () => {
  const pair = '__test1135__';
  const orderId = 'new-body-reject';
  const failure = new Error('TP sizing unavailable');
  const fill = { tradeId: 'new-body-reject-t1', orderId, side: 'buy',
    price: '2000', size: '0.01', totalCommission: '0.02', rebate: '0',
    tradeTime: '2026-01-01T00:00:00.000Z' };
  let placements = 0;
  let acknowledgements = 0;
  engine = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  engine._test.setRunning(true);
  engine._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
  engine._test.setAdapter({ getOrderFills: async () => [fill] });
  const position = engine._getPositionState();
  const ledger = engine.getFillLedger();
  position.pendingEntryOrders = [{ orderId, assetQty: 0.01, sizeUsdc: 20.02 }];
  engine._test.setOrderExecutor({
    getOrderPlacedAt: () => null,
    getPendingCounts: () => ({ total: 0 }),
    isLadderOrder: () => false,
    handleOrderFill: () => { acknowledgements++; },
    placeBodyTpOrder: async () => assert.fail('sizing rejects before exchange placement'),
  });
  beforeTpSizing = () => {
    placements++;
    const [body] = position.celestialBodies;
    const [row] = ledger.getFillsForOrder(orderId);
    assert.equal(position.celestialBodies.length, 1);
    assert.equal(body.assetQty, 0.01);
    assert.equal(body.costBasis, 20.02);
    assert.equal(position.totalAsset, 0.01, 'aggregate state is synced before TP');
    assert.equal(row.isBodyOwned, true, 'booked row is annotated before the rejecting await');
    assert.equal(row.bodyId, body.id);
    assert.equal(row.bodyTier, body.tier);
    assert.equal(position.cycleBuys, 1, 'cycle accounting is committed before TP');
    assert.equal(position.lastEntryPrice, 2000);
    assert.ok(position.lastEntryTime > 0);
    throw failure;
  };
  const status = { orderId, side: 'buy', status: 'FILLED', filledSize: 0.01,
    filledValue: 20, totalFees: 0.02, averageFilledPrice: 2000, confirmedFills: [fill] };
  await assert.rejects(engine._test.handleOrderFill(status), error => error === failure);
  assert.equal(acknowledgements, 0, 'failed pass does not acknowledge the entry');
  const committedBody = position.celestialBodies[0];
  await engine._test.handleOrderFill(status);
  assert.equal(placements, 1, 'retry leaves TP repair to reconciliation');
  assert.equal(position.cycleBuys, 1);
  assert.deepEqual(position.celestialBodies, [committedBody]);
  assert.deepEqual(position.pendingEntryOrders, []);
  assert.equal(acknowledgements, 1, 'terminal recommit retires and acknowledges the entry');
  assert.equal(ledger.getFillsForOrder(orderId).length, 1);
});
