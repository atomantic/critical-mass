// @ts-check
const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module-level setup: patch getExchangeDataDir so fill-ledger writes to tmpdir
// ---------------------------------------------------------------------------
const migrationPath = require.resolve('../src/migration');
const fillLedgerPath = require.resolve('../src/fill-ledger');
const stateTrackerPath = require.resolve('../src/state-tracker');

// Ensure migration module is loaded so we can patch it
const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

/** @type {string|null} tmp directory for the current test */
let tmpDir = null;

/**
 * Get a fresh createFillLedger by clearing the fill-ledger module cache
 * and re-requiring it (so it picks up the patched getExchangeDataDir).
 */
const freshFillLedgerModule = () => {
  delete require.cache[fillLedgerPath];
  return require('../src/fill-ledger');
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Fill Ledger', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-ledger-test-'));
    // Patch migration so getExchangeDataDir returns a path under tmpDir
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    // Restore original
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    // Clean up tmpDir
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
    // Clear fill-ledger from cache so next test gets a fresh module
    delete require.cache[fillLedgerPath];
  });

  // -----------------------------------------------------------------------
  // Helper: create a fill ledger in the temp directory
  // -----------------------------------------------------------------------
  const createTestLedger = (exchange = 'test-exchange') => {
    const { createFillLedger } = freshFillLedgerModule();
    return createFillLedger(exchange);
  };

  const makeBuyFill = (overrides = {}) => ({
    tradeId: `trade-buy-${Date.now()}-${Math.random()}`,
    orderId: `order-buy-1`,
    side: 'buy',
    price: '100000',
    size: '0.001',
    totalCommission: '0.10',
    rebate: '0',
    liquidityIndicator: 'TAKER',
    tradeTime: new Date().toISOString(),
    ...overrides,
  });

  const makeSellFill = (overrides = {}) => ({
    tradeId: `trade-sell-${Date.now()}-${Math.random()}`,
    orderId: `order-sell-1`,
    side: 'sell',
    price: '105000',
    size: '0.001',
    totalCommission: '0.10',
    rebate: '0',
    liquidityIndicator: 'TAKER',
    tradeTime: new Date().toISOString(),
    ...overrides,
  });

  // =======================================================================
  // 1. Empty Ledger
  // =======================================================================
  it('starts with zero fills and no current cycle', () => {
    const ledger = createTestLedger();
    assert.equal(ledger.getFillCount(), 0);
    assert.equal(ledger.getCurrentCycleId(), null);
    assert.deepStrictEqual(ledger.getAllFills(), []);
    assert.deepStrictEqual(ledger.getCurrentCycleFills(), []);
  });

  // =======================================================================
  // 2. Fill Ingestion — basic buy
  // =======================================================================
  it('ingests a buy fill and increments fill count', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    const fill = makeBuyFill({ tradeId: 'buy-1' });

    const result = ledger.ingestFill(fill);

    assert.equal(result.ingested, true);
    assert.ok(result.fill);
    assert.equal(result.fill.tradeId, 'buy-1');
    assert.equal(result.fill.side, 'buy');
    assert.equal(result.fill.price, 100000);
    assert.equal(result.fill.size, 0.001);
    assert.equal(ledger.getFillCount(), 1);
  });

  // =======================================================================
  // 3. Fill Ingestion — basic sell
  // =======================================================================
  it('ingests a sell fill with correct quoteAmount and netFee', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    const fill = makeSellFill({ tradeId: 'sell-1', price: '105000', size: '0.001', totalCommission: '0.15', rebate: '0.02' });

    const result = ledger.ingestFill(fill);

    assert.equal(result.ingested, true);
    assert.equal(result.fill.side, 'sell');
    assert.equal(result.fill.quoteAmount, 105000 * 0.001);
    assert.equal(result.fill.netFee, 0.15 - 0.02);
    assert.equal(result.fill.fee, 0.15);
    assert.equal(result.fill.rebate, 0.02);
  });

  // =======================================================================
  // 4. Deduplication — same trade ID
  // =======================================================================
  it('deduplicates fills with the same trade ID', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    const fill = makeBuyFill({ tradeId: 'dup-1' });

    const first = ledger.ingestFill(fill);
    const second = ledger.ingestFill(fill);

    assert.equal(first.ingested, true);
    assert.equal(second.ingested, false);
    assert.equal(second.fill, null);
    assert.equal(ledger.getFillCount(), 1);
  });

  // =======================================================================
  // 5. hasProcessedTrade
  // =======================================================================
  it('hasProcessedTrade returns correct status', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    assert.equal(ledger.hasProcessedTrade('nope'), false);

    ledger.ingestFill(makeBuyFill({ tradeId: 'exists-1' }));
    assert.equal(ledger.hasProcessedTrade('exists-1'), true);
    assert.equal(ledger.hasProcessedTrade('nope'), false);
  });

  // =======================================================================
  // 6. Cycle management — startNewCycle
  // =======================================================================
  it('startNewCycle assigns sequential cycle IDs', () => {
    const ledger = createTestLedger();

    const c1 = ledger.startNewCycle();
    assert.equal(c1, 'cycle-1');
    assert.equal(ledger.getCurrentCycleId(), 'cycle-1');

    const c2 = ledger.startNewCycle();
    assert.equal(c2, 'cycle-2');
    assert.equal(ledger.getCurrentCycleId(), 'cycle-2');
  });

  // =======================================================================
  // 7. getCurrentCycleFills — fills scoped to active cycle
  // =======================================================================
  it('getCurrentCycleFills returns only fills for the active cycle', () => {
    const ledger = createTestLedger();

    ledger.startNewCycle(); // cycle-1
    ledger.ingestFill(makeBuyFill({ tradeId: 'c1-buy', tradeTime: '2025-01-01T00:00:00Z' }));

    ledger.startNewCycle(); // cycle-2
    ledger.ingestFill(makeBuyFill({ tradeId: 'c2-buy', tradeTime: '2025-01-02T00:00:00Z' }));

    const cycleFills = ledger.getCurrentCycleFills();
    assert.equal(cycleFills.length, 1);
    assert.equal(cycleFills[0].tradeId, 'c2-buy');
  });

  // =======================================================================
  // 8. getCurrentCycleFills returns empty when no cycle
  // =======================================================================
  it('getCurrentCycleFills returns empty array when no cycle is active', () => {
    const ledger = createTestLedger();
    assert.deepStrictEqual(ledger.getCurrentCycleFills(), []);
  });

  // =======================================================================
  // 9. setCurrentCycleId
  // =======================================================================
  it('setCurrentCycleId overrides the current cycle', () => {
    const ledger = createTestLedger();
    ledger.setCurrentCycleId('custom-cycle-42');
    assert.equal(ledger.getCurrentCycleId(), 'custom-cycle-42');
    ledger.setCurrentCycleId(null);
    assert.equal(ledger.getCurrentCycleId(), null);
  });

  // =======================================================================
  // 10. rebuildPositionFromFills — single buy
  // =======================================================================
  it('rebuilds position from a single buy fill', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({
      tradeId: 'rb-buy-1',
      price: '100000',
      size: '0.01',
      totalCommission: '1.00',
      rebate: '0',
    }));

    const pos = ledger.rebuildPositionFromFills();

    assert.equal(pos.totalAsset, 0.01);
    // costBasis = quoteAmount + netFee = 100000*0.01 + 1.00 = 1001.00
    assert.equal(pos.totalCostBasis, 1001);
    assert.equal(pos.avgCostBasis, 1001 / 0.01);
    assert.equal(pos.cycleBuys, 1);
    assert.equal(pos.lastEntryPrice, 100000);
    assert.equal(pos.realizedPnL, 0);
  });

  // =======================================================================
  // 11. rebuildPositionFromFills — buy then sell with profit
  // =======================================================================
  it('rebuilds position with realized P&L after buy and sell', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // Buy 0.01 BTC at $100,000 with $1 fee
    ledger.ingestFill(makeBuyFill({
      tradeId: 'pnl-buy',
      price: '100000',
      size: '0.01',
      totalCommission: '1.00',
      rebate: '0',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Sell 0.01 BTC at $105,000 with $1 fee
    ledger.ingestFill(makeSellFill({
      tradeId: 'pnl-sell',
      price: '105000',
      size: '0.01',
      totalCommission: '1.00',
      rebate: '0',
      tradeTime: '2025-01-02T00:00:00Z',
    }));

    const pos = ledger.rebuildPositionFromFills();

    // After selling all BTC, totalAsset should be 0
    assert.equal(pos.totalAsset, 0);
    // costBasis for 0.01 BTC = 100000*0.01 + 1 = 1001
    // avgCost = 1001/0.01 = 100100
    // proceeds = 105000*0.01 - 1 = 1049
    // soldCostBasis = 0.01 * 100100 = 1001
    // realizedPnL = 1049 - 1001 = 48
    assert.equal(pos.realizedPnL, 48);
    assert.equal(pos.totalCostBasis, 0);
  });

  // =======================================================================
  // 12. rebuildPositionFromFills — multiple buys at different prices
  // =======================================================================
  it('rebuilds position with weighted average cost from multiple buys', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // Buy 0.01 BTC at $100,000 with $0 fee
    ledger.ingestFill(makeBuyFill({
      tradeId: 'avg-buy-1',
      orderId: 'ord-1',
      price: '100000',
      size: '0.01',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Buy 0.01 BTC at $110,000 with $0 fee
    ledger.ingestFill(makeBuyFill({
      tradeId: 'avg-buy-2',
      orderId: 'ord-2',
      price: '110000',
      size: '0.01',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T01:00:00Z',
    }));

    const pos = ledger.rebuildPositionFromFills();

    assert.equal(pos.totalAsset, 0.02);
    // costBasis = 1000 + 1100 = 2100
    assert.equal(pos.totalCostBasis, 2100);
    // avgCost = 2100 / 0.02 = 105000
    assert.equal(pos.avgCostBasis, 105000);
    assert.equal(pos.cycleBuys, 2);
  });

  // =======================================================================
  // 13. Negative BTC guard (Phase 1.10 fix) — sells exceeding buys clamp to 0
  // =======================================================================
  it('clamps totalAsset to 0 when sells exceed buys (negative BTC guard)', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // Buy 0.001 BTC
    ledger.ingestFill(makeBuyFill({
      tradeId: 'neg-buy',
      price: '100000',
      size: '0.001',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Sell 0.002 BTC (more than we bought — edge case)
    ledger.ingestFill(makeSellFill({
      tradeId: 'neg-sell',
      price: '105000',
      size: '0.002',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-02T00:00:00Z',
    }));

    const pos = ledger.rebuildPositionFromFills();

    assert.equal(pos.totalAsset, 0);
    assert.equal(pos.totalCostBasis, 0);
  });

  // =======================================================================
  // 14. Sells before buys (edge case)
  // =======================================================================
  it('handles sell fill with no prior buy gracefully', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeSellFill({
      tradeId: 'orphan-sell',
      price: '100000',
      size: '0.001',
      totalCommission: '0.10',
      rebate: '0',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    const pos = ledger.rebuildPositionFromFills();

    // When selling with 0 BTC, avgCost is 0 so soldCostBasis is 0
    // Negative BTC guard clamps to 0
    assert.equal(pos.totalAsset, 0);
    assert.equal(pos.totalCostBasis, 0);
  });

  // =======================================================================
  // 15. Persistence — persist and load round-trip
  // =======================================================================
  it('persists fills to disk and loads them in a new instance', () => {
    const exchange = 'persist-test';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'persist-buy-1', tradeTime: '2025-01-01T00:00:00Z' }));
    ledger1.ingestFill(makeBuyFill({ tradeId: 'persist-buy-2', tradeTime: '2025-01-01T01:00:00Z' }));

    // Verify file exists on disk under the per-fund subdirectory.
    // (Test exchanges have no pair config, so getDefaultPair() returns null
    // and getFundDataDir falls back to a 'default' subdirectory.)
    const filePath = path.join(tmpDir, exchange, 'default', 'fill-ledger.json');
    assert.ok(fs.existsSync(filePath));

    // Create new instance for the same exchange — it should load from disk
    const ledger2 = createTestLedger(exchange);
    assert.equal(ledger2.getFillCount(), 2);
    assert.equal(ledger2.hasProcessedTrade('persist-buy-1'), true);
    assert.equal(ledger2.hasProcessedTrade('persist-buy-2'), true);
  });

  // =======================================================================
  // 16. Persistence — restores active cycle on load
  // =======================================================================
  it('restores the active cycle ID from loaded fills', () => {
    const exchange = 'cycle-restore';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle(); // cycle-1

    // Ingest a buy (less than 50% sold = active cycle)
    ledger1.ingestFill(makeBuyFill({
      tradeId: 'restore-buy',
      price: '100000',
      size: '0.01',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Create new instance — should restore cycle-1 as active
    const ledger2 = createTestLedger(exchange);
    assert.equal(ledger2.getCurrentCycleId(), 'cycle-1');
  });

  // =======================================================================
  // 17. Persistence — nextCycleNumber restored from loaded fills
  // =======================================================================
  it('restores nextCycleNumber so new cycles continue sequentially', () => {
    const exchange = 'cycle-number';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle(); // cycle-1
    ledger1.ingestFill(makeBuyFill({ tradeId: 'cn-buy-1', tradeTime: '2025-01-01T00:00:00Z' }));

    ledger1.startNewCycle(); // cycle-2
    ledger1.ingestFill(makeBuyFill({ tradeId: 'cn-buy-2', tradeTime: '2025-01-02T00:00:00Z' }));

    // Load new instance
    const ledger2 = createTestLedger(exchange);
    const newCycle = ledger2.startNewCycle();
    assert.equal(newCycle, 'cycle-3');
  });

  // =======================================================================
  // 18. cycleIndex Map optimization — O(1) cycle lookups
  // =======================================================================
  it('cycleIndex enables efficient lookup of fills by cycle', () => {
    const ledger = createTestLedger();

    // Create cycle-1 with 3 fills
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'idx-c1-1', tradeTime: '2025-01-01T00:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'idx-c1-2', tradeTime: '2025-01-01T01:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'idx-c1-3', tradeTime: '2025-01-01T02:00:00Z' }));

    // Create cycle-2 with 1 fill
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'idx-c2-1', tradeTime: '2025-01-02T00:00:00Z' }));

    // getCurrentCycleFills should only return cycle-2 fills
    const cycle2Fills = ledger.getCurrentCycleFills();
    assert.equal(cycle2Fills.length, 1);
    assert.equal(cycle2Fills[0].tradeId, 'idx-c2-1');

    // Total fills across all cycles should be 4
    assert.equal(ledger.getFillCount(), 4);
  });

  // =======================================================================
  // 19. cycleIndex rebuilt on load from disk
  // =======================================================================
  it('cycleIndex is rebuilt correctly when loading from disk', () => {
    const exchange = 'idx-reload';
    const ledger1 = createTestLedger(exchange);

    ledger1.startNewCycle(); // cycle-1
    ledger1.ingestFill(makeBuyFill({ tradeId: 'rl-c1-buy', tradeTime: '2025-01-01T00:00:00Z' }));

    ledger1.startNewCycle(); // cycle-2
    ledger1.ingestFill(makeBuyFill({ tradeId: 'rl-c2-buy', tradeTime: '2025-01-02T00:00:00Z' }));

    // Load fresh instance
    const ledger2 = createTestLedger(exchange);

    // cycle-2 should be active (it has buys, 0% sold)
    assert.equal(ledger2.getCurrentCycleId(), 'cycle-2');
    const cycleFills = ledger2.getCurrentCycleFills();
    assert.equal(cycleFills.length, 1);
    assert.equal(cycleFills[0].tradeId, 'rl-c2-buy');
  });

  // =======================================================================
  // 20. getFillsForOrder
  // =======================================================================
  it('getFillsForOrder returns fills grouped by order ID', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeBuyFill({ tradeId: 'fo-1', orderId: 'order-A', tradeTime: '2025-01-01T00:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'fo-2', orderId: 'order-A', tradeTime: '2025-01-01T01:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'fo-3', orderId: 'order-B', tradeTime: '2025-01-01T02:00:00Z' }));

    const orderAFills = ledger.getFillsForOrder('order-A');
    assert.equal(orderAFills.length, 2);
    assert.ok(orderAFills.every(f => f.orderId === 'order-A'));

    const orderBFills = ledger.getFillsForOrder('order-B');
    assert.equal(orderBFills.length, 1);

    const noFills = ledger.getFillsForOrder('nonexistent');
    assert.equal(noFills.length, 0);
  });

  // =======================================================================
  // 21. getStats summary
  // =======================================================================
  it('getStats returns correct aggregate statistics', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeBuyFill({
      tradeId: 'stat-buy',
      price: '100000',
      size: '0.01',
      totalCommission: '1.00',
      rebate: '0',
    }));
    ledger.ingestFill(makeSellFill({
      tradeId: 'stat-sell',
      price: '105000',
      size: '0.005',
      totalCommission: '0.50',
      rebate: '0',
    }));

    const stats = ledger.getStats();

    assert.equal(stats.totalFills, 2);
    assert.equal(stats.buyFills, 1);
    assert.equal(stats.sellFills, 1);
    assert.equal(stats.totalBuyAsset, 0.01);
    assert.equal(stats.totalSellAsset, 0.005);
    assert.equal(stats.currentCycleId, 'cycle-1');
  });

  // =======================================================================
  // 22. aggregateFills
  // =======================================================================
  it('aggregateFills calculates correct totals for a set of fills', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeBuyFill({ tradeId: 'agg-1', price: '100000', size: '0.01', totalCommission: '1', rebate: '0' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'agg-2', price: '102000', size: '0.01', totalCommission: '1', rebate: '0' }));

    const allFills = ledger.getAllFills();
    const agg = ledger.aggregateFills(allFills);

    assert.equal(agg.totalSize, 0.02);
    // totalValue = 100000*0.01 + 102000*0.01 = 1000 + 1020 = 2020
    assert.equal(agg.totalValue, 2020);
    // totalFees = 1 + 1 = 2
    assert.equal(agg.totalFees, 2);
    // avgPrice = 2020 / 0.02 = 101000
    assert.equal(agg.avgPrice, 101000);
  });

  // =======================================================================
  // 22b. aggregateFills — low-priced asset preserves avgPrice precision
  // =======================================================================
  it('aggregateFills preserves avgPrice precision for low-priced assets', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // CRO-like fill: 597 units at $0.0837 each
    ledger.ingestFill(makeBuyFill({
      tradeId: 'low-price-1',
      price: '0.0837',
      size: '597',
      totalCommission: '0.05',
      rebate: '0',
    }));

    const allFills = ledger.getAllFills();
    const agg = ledger.aggregateFills(allFills);

    // avgPrice should be ~0.0837, not truncated to 0.08
    assert.ok(
      Math.abs(agg.avgPrice - 0.0837) < 0.0001,
      `avgPrice ${agg.avgPrice} should be approximately 0.0837, not rounded to ${Math.round(agg.avgPrice * 100) / 100}`,
    );
  });

  // =======================================================================
  // 23. getFillsSince
  // =======================================================================
  it('getFillsSince returns only fills after the given timestamp', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const t1 = new Date('2025-01-01T00:00:00Z').getTime();
    const t2 = new Date('2025-01-02T00:00:00Z').getTime();
    const t3 = new Date('2025-01-03T00:00:00Z').getTime();

    ledger.ingestFill(makeBuyFill({ tradeId: 'since-1', tradeTime: '2025-01-01T00:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'since-2', tradeTime: '2025-01-02T00:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'since-3', tradeTime: '2025-01-03T00:00:00Z' }));

    const recent = ledger.getFillsSince(t2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].tradeId, 'since-2');
    assert.equal(recent[1].tradeId, 'since-3');
  });

  // =======================================================================
  // 24. Fill ingestion with fill time tracking
  // =======================================================================
  it('records fillTimeMs when orderPlacedAt is provided', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const tradeTime = '2025-01-01T00:00:05Z'; // 5 seconds after epoch
    const orderPlacedAt = new Date('2025-01-01T00:00:00Z').getTime();

    const result = ledger.ingestFill(
      makeBuyFill({ tradeId: 'ft-1', tradeTime }),
      orderPlacedAt,
    );

    assert.equal(result.fill.fillTimeMs, 5000);
    assert.equal(result.fill.orderPlacedAt, orderPlacedAt);
  });

  // =======================================================================
  // 25. Fill ingestion without fill time tracking
  // =======================================================================
  it('fillTimeMs is null when orderPlacedAt is not provided', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const result = ledger.ingestFill(makeBuyFill({ tradeId: 'ft-null' }));

    assert.equal(result.fill.fillTimeMs, null);
    assert.equal(result.fill.orderPlacedAt, null);
  });

  // =======================================================================
  // 26. rebuildPositionFromFills skips body-owned fills
  // =======================================================================
  it('rebuildPositionFromFills skips body-owned fills', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // Regular buy
    ledger.ingestFill(makeBuyFill({
      tradeId: 'skip-regular',
      price: '100000',
      size: '0.01',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Satellite buy — should be skipped
    ledger.ingestFill(makeBuyFill({
      tradeId: 'skip-satellite',
      orderId: 'sat-ord',
      price: '100000',
      size: '0.005',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T01:00:00Z',
    }));
    // Annotate as body-owned after ingestion
    ledger.annotateFillsByOrderId('sat-ord', { isBodyOwned: true });

    // Body buy — should be skipped
    const bodyResult = ledger.ingestFill(makeBuyFill({
      tradeId: 'skip-body',
      orderId: 'body-ord',
      price: '100000',
      size: '0.005',
      totalCommission: '0',
      rebate: '0',
      tradeTime: '2025-01-01T02:00:00Z',
    }));
    ledger.annotateFillsByOrderId('body-ord', { bodyId: 'body-123' });

    const pos = ledger.rebuildPositionFromFills();

    // Only the regular fill should count
    assert.equal(pos.totalAsset, 0.01);
    assert.equal(pos.totalCostBasis, 1000); // 100000 * 0.01
  });

  // =======================================================================
  // 27. updateFillCycleId
  // =======================================================================
  it('updateFillCycleId moves a fill between cycles', () => {
    const ledger = createTestLedger();

    ledger.startNewCycle(); // cycle-1
    ledger.ingestFill(makeBuyFill({ tradeId: 'move-1', tradeTime: '2025-01-01T00:00:00Z' }));

    ledger.startNewCycle(); // cycle-2

    // Move the fill from cycle-1 to cycle-2
    ledger.updateFillCycleId('move-1', 'cycle-2');

    // Now cycle-2 should have the fill
    const c2Fills = ledger.getCurrentCycleFills();
    assert.equal(c2Fills.length, 1);
    assert.equal(c2Fills[0].tradeId, 'move-1');
  });

  // =======================================================================
  // 28. getCurrentCycleBuysCount
  // =======================================================================
  it('getCurrentCycleBuysCount counts unique buy orders in current cycle', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    // Two fills from the same order
    ledger.ingestFill(makeBuyFill({ tradeId: 'bc-1', orderId: 'order-X', tradeTime: '2025-01-01T00:00:00Z' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'bc-2', orderId: 'order-X', tradeTime: '2025-01-01T00:01:00Z' }));
    // One fill from a different order
    ledger.ingestFill(makeBuyFill({ tradeId: 'bc-3', orderId: 'order-Y', tradeTime: '2025-01-01T00:02:00Z' }));

    // Sell fills should not count
    ledger.ingestFill(makeSellFill({ tradeId: 'bc-4', orderId: 'order-Z', tradeTime: '2025-01-01T00:03:00Z' }));

    assert.equal(ledger.getCurrentCycleBuysCount(), 2); // order-X and order-Y
  });

  // =======================================================================
  // 29. Fills without a cycle get null cycleId
  // =======================================================================
  it('fills ingested without a cycle have null cycleId', () => {
    const ledger = createTestLedger();
    // No startNewCycle called

    const result = ledger.ingestFill(makeBuyFill({ tradeId: 'no-cycle' }));

    assert.equal(result.fill.cycleId, null);
  });

  // =======================================================================
  // 30. getFillTimeStats — with data
  // =======================================================================
  it('getFillTimeStats returns correct statistics for buy fills with fill times', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const now = Date.now();
    const recentTime = new Date(now - 1000).toISOString(); // 1 second ago

    // Ingest fills with fill time data
    ledger.ingestFill(makeBuyFill({
      tradeId: 'fts-1',
      tradeTime: recentTime,
    }), now - 6000); // orderPlacedAt = 5s before fill

    ledger.ingestFill(makeBuyFill({
      tradeId: 'fts-2',
      tradeTime: recentTime,
    }), now - 11000); // orderPlacedAt = 10s before fill

    // Sell fills should not be counted
    ledger.ingestFill(makeSellFill({
      tradeId: 'fts-3',
      tradeTime: recentTime,
    }), now - 3000);

    const stats = ledger.getFillTimeStats(30);
    assert.equal(stats.count, 2);
    assert.ok(stats.avgMs > 0);
    assert.ok(stats.minMs <= stats.maxMs);
    assert.equal(stats.staleCount, 0); // Both under 30s
  });

  // =======================================================================
  // 31. getFillTimeStats — empty
  // =======================================================================
  it('getFillTimeStats returns zeros when no fill time data exists', () => {
    const ledger = createTestLedger();
    const stats = ledger.getFillTimeStats();
    assert.equal(stats.count, 0);
    assert.equal(stats.avgMs, 0);
    assert.equal(stats.minMs, 0);
    assert.equal(stats.maxMs, 0);
  });

  // =======================================================================
  // 32. Persistence — empty ledger loads gracefully
  // =======================================================================
  it('loads gracefully when no file exists on disk', () => {
    const exchange = 'no-file-exchange';
    const ledger = createTestLedger(exchange);

    assert.equal(ledger.getFillCount(), 0);
    assert.equal(ledger.getCurrentCycleId(), null);
  });

  // =======================================================================
  // 33. Field mapping — alternative field names (trade_id, order_id, etc.)
  // =======================================================================
  it('maps alternative field names from exchange data', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const result = ledger.ingestFill({
      trade_id: 'alt-trade-1',
      order_id: 'alt-order-1',
      side: 'BUY',
      price: '99000',
      size: '0.005',
      commission: '0.50',
      fee_asset: 'USD',
      liquidity_indicator: 'MAKER',
      tradeTime: '2025-01-01T00:00:00Z',
    });

    assert.equal(result.fill.tradeId, 'alt-trade-1');
    assert.equal(result.fill.orderId, 'alt-order-1');
    assert.equal(result.fill.side, 'buy'); // lowercased
    assert.equal(result.fill.fee, 0.50);
    assert.equal(result.fill.feeAsset, 'USD');
    assert.equal(result.fill.liquidityIndicator, 'MAKER');
  });

  // =======================================================================
  // 34. annotateFillsByOrderId
  // =======================================================================
  it('annotateFillsByOrderId merges metadata into matching fills', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeBuyFill({ tradeId: 'ann-1', orderId: 'ann-order' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'ann-2', orderId: 'ann-order' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'ann-3', orderId: 'other-order' }));

    ledger.annotateFillsByOrderId('ann-order', { bodyId: 'body-X', bodyTier: 'MOON' });

    const annotated = ledger.getFillsForOrder('ann-order');
    assert.ok(annotated.every(f => f.bodyId === 'body-X'));
    assert.ok(annotated.every(f => f.bodyTier === 'MOON'));

    // The other fill should not be annotated
    const other = ledger.getFillsForOrder('other-order');
    assert.equal(other[0].bodyId, undefined);
  });

  // =======================================================================
  // 35. rebuildPositionFromFills with explicit fills parameter
  // =======================================================================
  it('rebuildPositionFromFills accepts explicit fills array', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    ledger.ingestFill(makeBuyFill({ tradeId: 'exp-1', price: '100000', size: '0.01', totalCommission: '0', rebate: '0' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'exp-2', price: '110000', size: '0.01', totalCommission: '0', rebate: '0' }));

    // Only pass the first fill
    const firstFill = ledger.getAllFills().filter(f => f.tradeId === 'exp-1');
    const pos = ledger.rebuildPositionFromFills(firstFill);

    assert.equal(pos.totalAsset, 0.01);
    assert.equal(pos.totalCostBasis, 1000); // 100000 * 0.01
  });

  // =======================================================================
  // 36. load() excludes body/satellite sells from active cycle detection
  // =======================================================================
  it('restores active cycle on load even when satellite sells exceed 50% of buy volume', () => {
    const exchange = 'sat-sell-load';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle(); // cycle-1

    // Ingest a buy of 0.01 BTC
    ledger1.ingestFill(makeBuyFill({
      tradeId: 'ssl-buy-1',
      orderId: 'ssl-buy-ord-1',
      price: '100000',
      size: '0.01',
      tradeTime: '2025-01-01T00:00:00Z',
    }));

    // Ingest a satellite sell of 0.006 BTC (60% of buy volume — would exceed 0.5 threshold)
    ledger1.ingestFill(makeSellFill({
      tradeId: 'ssl-sat-sell-1',
      orderId: 'ssl-sat-ord-1',
      price: '105000',
      size: '0.006',
      tradeTime: '2025-01-02T00:00:00Z',
    }));
    // Annotate as body-owned satellite sell and persist to disk
    ledger1.annotateFillsByOrderId('ssl-sat-ord-1', { isBodyOwned: true, isSatellite: true, bodyId: 'body-abc' });
    ledger1.persist();

    // Reload — cycle-1 should still be active (satellite sells excluded from ratio)
    const ledger2 = createTestLedger(exchange);
    assert.equal(ledger2.getCurrentCycleId(), 'cycle-1');
    assert.equal(ledger2.getCurrentCycleBuysCount(), 1);
  });

  // =======================================================================
  // persist() is a no-op when nothing has changed since the last successful
  // persist — lets defensive callers (e.g. unbounded retry loops) invoke
  // persist() on every tick without churning the ledger file.
  // =======================================================================
  it('persist() is a no-op when ledger is clean (no mutations since last persist)', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1' })); // auto-persists, clears dirty

    const filePath = path.join(tmpDir, 'test-exchange', 'default', 'fill-ledger.json');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    // Sleep briefly so a no-op persist would still produce a different
    // mtime if it actually wrote. Use a busy-wait via Date.now to avoid
    // making this test async.
    const wait = Date.now() + 25;
    while (Date.now() < wait) { /* busy wait */ }

    ledger.persist();
    ledger.persist();
    ledger.persist();

    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'clean persists must NOT rewrite the ledger file');
  });

  it('getRecordedSizeForOrder returns the per-order total in O(1)', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-2', orderId: 'o-1', size: '0.3' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-3', orderId: 'o-2', size: '1.0' }));

    assert.equal(ledger.getRecordedSizeForOrder('o-1'), 0.4 + 0.3);
    assert.equal(ledger.getRecordedSizeForOrder('o-2'), 1.0);
    assert.equal(ledger.getRecordedSizeForOrder('unknown'), 0);
  });

  it('getRecordedSizeForOrder rounds accumulated float sums to asset precision', () => {
    // Raw float sum of 0.1 + 0.2 + 0.4 produces 0.7000000000000001.
    // Without rounding, recordedSize < filledSize=0.7 would be false-but-
    // also-not-equal, and the retry chain would loop forever even though
    // all fills are present. The index must round to 8-decimal asset
    // precision after each accumulation.
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.1' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-2', orderId: 'o-1', size: '0.2' }));
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-3', orderId: 'o-1', size: '0.4' }));

    const recorded = ledger.getRecordedSizeForOrder('o-1');
    assert.equal(recorded, 0.7, 'rounded sum must be exactly 0.7, not 0.7000000000000001');
  });

  it('getRecordedSizeForOrder restores the per-order index from disk on load', () => {
    const exchange = 'test-exchange-load-idx';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-2', orderId: 'o-1', size: '0.3' }));

    const ledger2 = createTestLedger(exchange);
    assert.equal(ledger2.getRecordedSizeForOrder('o-1'), 0.4 + 0.3,
      'index must be rebuilt on load — production retry loops depend on it');
  });

  it('markDirty + persist flushes external mutations to disk', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    const result = ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1' }));

    // External mutation directly on the fill object (the dca-converter
    // pattern). Without markDirty, the trailing persist would no-op.
    result.fill.sellOrderId = 'sell-XYZ';
    ledger.markDirty();
    ledger.persist();

    // Reload and verify the mutation survived.
    delete require.cache[fillLedgerPath];
    const { createFillLedger: fresh } = require('../src/fill-ledger');
    const reloaded = fresh('test-exchange');
    const fills = reloaded.getFillsForOrder('o-1');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].sellOrderId, 'sell-XYZ',
      'markDirty + persist must flush direct field mutations to disk');
  });

  it('persist() rewrites the file when mutations have happened since last persist', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1' }));

    const filePath = path.join(tmpDir, 'test-exchange', 'default', 'fill-ledger.json');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    const wait = Date.now() + 25;
    while (Date.now() < wait) { /* busy wait */ }

    // skipPersist mutates without writing — dirty flag should now be set
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-2' }), null, { skipPersist: true });
    ledger.persist();

    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.ok(mtimeAfter > mtimeBefore, 'persist must rewrite when ledger is dirty');
  });
});
