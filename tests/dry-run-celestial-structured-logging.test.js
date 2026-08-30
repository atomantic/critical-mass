// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createDryRunExecutor } = require('../src/dry-run-executor');
const { mergeIntoBody, mergeBodies, checkPromotions } = require('../src/celestial-hierarchy');

const createCapturingLogger = () => {
  const events = [];
  return {
    events,
    logger: {
      info: (message, context) => events.push({ message, context }),
      warn: (message, context) => events.push({ message, context }),
      error: (message, context) => events.push({ message, context }),
    },
  };
};

describe('dry-run and celestial lifecycle structured logging (#253)', () => {
  it('preserves dry-run order messages and adds order/fill context', async () => {
    const { events, logger } = createCapturingLogger();
    const config = {
      entryOffsetBps: 0,
      orderStaleMs: 60_000,
      tpUpdateThresholdPct: 0.5,
      holdbackRatio: 0.5,
      feeRate: 0.001,
    };
    const executor = createDryRunExecutor(
      'coinbase',
      config,
      { lastPrice: 100_000, regime: 'NEUTRAL' },
      {},
      'BTC-USD',
      { logger }
    );

    const placed = await executor.placeEntryBid(1000, 100_000, 100_010);
    executor.checkEntryFills(placed.price);

    assert.match(events[0].message, /^🧪 \[coinbase\] \[DRY-RUN\] Entry bid placed:/);
    assert.deepEqual(
      {
        orderId: events[0].context.orderId,
        orderType: events[0].context.orderType,
        side: events[0].context.side,
        sizeUsdc: events[0].context.sizeUsdc,
        price: events[0].context.price,
      },
      { orderId: placed.orderId, orderType: 'entry', side: 'buy', sizeUsdc: 1000, price: placed.price }
    );

    assert.match(events[1].message, /^🧪 \[coinbase\] \[DRY-RUN\] Entry FILLED:/);
    assert.equal(events[1].context.orderId, placed.orderId);
    assert.equal(events[1].context.fillPrice, placed.price);
    assert.ok(events[1].context.costBasis > 1000);

    const tp = await executor.placeTakeProfitOrder(placed.assetQty, 110_000, { forceUpdate: true });
    executor.checkTpFills(110_000);

    assert.match(events[3].message, /^🧪 \[coinbase\] \[DRY-RUN\] TP FILLED:/);
    assert.equal(events[3].context.orderId, tp.orderId);
    assert.equal(events[3].context.fillPrice, 110_000);
    assert.ok(events[3].context.pnl > 0);
    assert.ok(events[3].context.holdbackAsset > 0);

    assert.match(events[4].message, /^📊 \[coinbase\] \[DRY-RUN\] Cycle 1 analytics:/);
    assert.equal(events[4].context.cycleNumber, 1);
    assert.equal(events[4].context.exitPrice, 110_000);

    executor.importState(executor.exportState());
    assert.match(events[5].message, /^🧪 \[coinbase\] \[DRY-RUN\] State restored:/);
    assert.equal(events[5].context.realizedPnL, events[3].context.pnl);
  });

  it('preserves body promotion messages and adds body/tier context', () => {
    const { events, logger } = createCapturingLogger();
    const body = {
      id: 'body-test-12345678',
      tier: 'satellite',
      assetQty: 0.001,
      costBasis: 50,
      avgPrice: 50_000,
      tpOrderId: null,
      tpPrice: 0,
      assetOnOrder: 0,
      createdAt: Date.now(),
      lastMergedAt: Date.now(),
      sourceOrderIds: [],
      buyOrders: [],
      mergeCount: 0,
    };

    mergeIntoBody(
      body,
      { totalSize: 0.001, totalValue: 100, totalFees: 0, avgPrice: 100_000 },
      10_000,
      'buy-order-1',
      logger
    );

    assert.match(events[0].message, /^⬆️ Body 12345678 promoted:/);
    assert.deepEqual(
      {
        bodyId: events[0].context.bodyId,
        orderId: events[0].context.orderId,
        oldTier: events[0].context.oldTier,
        newTier: events[0].context.newTier,
      },
      { bodyId: body.id, orderId: 'buy-order-1', oldTier: 'satellite', newTier: 'asteroid' }
    );

    body.tier = 'satellite';
    checkPromotions([body], 10_000, logger);
    assert.match(events[1].message, /^⬆️ Body 12345678 reclassified:/);
    assert.equal(events[1].context.newTier, 'asteroid');

    const collapseTarget = {
      ...body,
      id: 'body-target-12345678',
      tier: 'satellite',
      assetQty: 0.001,
      costBasis: 50,
      sourceOrderIds: [],
      buyOrders: [],
      mergeCount: 0,
    };
    const collapseSource = {
      ...body,
      id: 'body-source-87654321',
      tier: 'asteroid',
      assetQty: 0.001,
      costBasis: 100,
      sourceOrderIds: [],
      buyOrders: [],
      mergeCount: 0,
    };
    mergeBodies(collapseTarget, collapseSource, 10_000, logger);

    assert.match(events[2].message, /^⬆️ Body 12345678 promoted:/);
    assert.equal(events[2].context.bodyId, collapseTarget.id);
    assert.equal(events[2].context.sourceBodyId, collapseSource.id);
    assert.equal(events[2].context.capitalPercent, 1.5);
  });

  it('leaves no direct console calls in the migrated modules', () => {
    for (const relativePath of ['src/dry-run-executor.js', 'src/celestial-hierarchy.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
      assert.doesNotMatch(source, /console\.(log|warn|error|info|debug)\(/, relativePath);
      assert.match(source, /createContextLogger/, relativePath);
    }
  });
});
