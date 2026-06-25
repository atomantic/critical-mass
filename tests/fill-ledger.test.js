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

    const writesBefore = ledger._test.getWriteCount();
    ledger.persist();
    ledger.persist();
    ledger.persist();
    assert.equal(ledger._test.getWriteCount(), writesBefore,
      'clean persists must NOT rewrite the ledger file');
  });

  it('load() on a dirty live instance clears the dirty flag so subsequent persist() is a no-op', () => {
    // SIGUSR1 reload path: load() may be called while the in-memory ledger
    // has unflushed mutations. resetCaches must clear dirtySinceLastPersist
    // alongside the in-memory state — after load(), in-memory matches disk,
    // and a defensive persist() on the next tick should be a no-op rather
    // than rewriting the just-loaded snapshot (which would churn the file
    // on every retry-loop call to persist()).
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1' })); // auto-persists; dirty cleared

    // Mutate without persist to set the dirty flag.
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-2' }), null, { skipPersist: true });

    // Reload from disk. After load(), in-memory matches disk (which has
    // only b-1, not b-2 — but the dirty flag should still be cleared).
    ledger.load();

    const writesBefore = ledger._test.getWriteCount();
    ledger.persist();
    assert.equal(ledger._test.getWriteCount(), writesBefore,
      'persist() after load() must be a no-op — load resets the dirty flag');
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

  it('load() resets currentCycleId and nextCycleNumber on a successful reload', () => {
    // The successful-load path still mirrors disk authoritatively: if the
    // operator manually edits the file to remove fills, those removals
    // must take effect on reload. This test verifies that path resets
    // cycle state. (The corrupt/missing-file paths preserve in-memory
    // state instead — see the SIGUSR1 reload safety tests below.)
    const exchange = 'test-exchange-cycle-reset';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1' }));
    const cycleBefore = ledger1.getCurrentCycleId();
    assert.ok(cycleBefore, 'cycle exists after startNewCycle');

    // Overwrite the file with a valid empty array so the load() success
    // path runs and resets cycle state.
    const filePath = path.join(tmpDir, exchange, 'default', 'fill-ledger.json');
    fs.writeFileSync(filePath, '[]');

    ledger1.load();
    assert.equal(ledger1.getCurrentCycleId(), null,
      'successful load() of an empty ledger must reset currentCycleId — without this, subsequent ingestFill keeps attributing fills to the prior cycle');
  });

  it('load() preserves in-memory state when the file is corrupt (SIGUSR1 reload safety)', () => {
    // SIGUSR1 reload runs load() on the live ledger. If the file is
    // momentarily corrupt (operator's mid-edit window, partial write,
    // disk hiccup), wiping in-memory state would turn that into live
    // data loss — the running engine would forget its last known-good
    // ledger and the next persist would rewrite the file with only the
    // fills that arrive after the reload. Instead, load() logs and
    // returns, keeping the existing in-memory state intact.
    const exchange = 'test-exchange-corrupt';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));

    const fillsBefore = ledger1.getFillCount();
    const recordedBefore = ledger1.getRecordedSizeForOrder('o-1');

    // Corrupt the file
    const filePath = path.join(tmpDir, exchange, 'default', 'fill-ledger.json');
    fs.writeFileSync(filePath, '<<< not valid json >>>');

    ledger1.load();
    assert.equal(ledger1.getFillCount(), fillsBefore,
      'fills must be preserved on corrupt-file reload (live SIGUSR1 safety)');
    assert.equal(ledger1.getRecordedSizeForOrder('o-1'), recordedBefore,
      'orderSizeIndex must be preserved on corrupt-file reload');
  });

  it('load() preserves in-memory state when the file is valid JSON but not an array (SIGUSR1 reload safety)', () => {
    // Valid JSON like `{}`, `null`, or `42` parses without throwing but
    // can't be iterated. resetCaches() must NOT run before this is
    // detected — otherwise a malformed-but-parseable manual edit during
    // SIGUSR1 reload would crash mid-way and leave the live ledger
    // permanently empty.
    const exchange = 'test-exchange-malformed';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));

    const fillsBefore = ledger1.getFillCount();

    const filePath = path.join(tmpDir, exchange, 'default', 'fill-ledger.json');
    fs.writeFileSync(filePath, '{}');

    ledger1.load();
    assert.equal(ledger1.getFillCount(), fillsBefore,
      'fills must be preserved when file is valid JSON but not an array');

    // Also test null and primitive values
    fs.writeFileSync(filePath, 'null');
    ledger1.load();
    assert.equal(ledger1.getFillCount(), fillsBefore,
      'fills preserved when file is null');

    fs.writeFileSync(filePath, '42');
    ledger1.load();
    assert.equal(ledger1.getFillCount(), fillsBefore,
      'fills preserved when file is a number primitive');
  });

  it('load() preserves in-memory state when the file is missing (SIGUSR1 reload safety)', () => {
    // Same SIGUSR1 reload concern as the corrupt-file test. An operator
    // who deletes the file mid-edit, or a temporary unavailability of
    // the storage medium, must not wipe live data.
    const exchange = 'test-exchange-missing-on-reload';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));

    const fillsBefore = ledger1.getFillCount();

    // Remove the file
    const filePath = path.join(tmpDir, exchange, 'default', 'fill-ledger.json');
    fs.rmSync(filePath);

    ledger1.load();
    assert.equal(ledger1.getFillCount(), fillsBefore,
      'fills must be preserved when file goes missing during reload');
  });

  it('load() is idempotent for orderSizeIndex (no double-counting on re-load)', () => {
    const exchange = 'test-exchange-double-load';
    const ledger1 = createTestLedger(exchange);
    ledger1.startNewCycle();
    ledger1.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));

    // Re-load the live ledger instance — regime-engine.js does this on
    // state reload. Without the index-rebuild fix, this would add 0.4
    // on top of the existing 0.4 and report 0.8.
    ledger1.load();
    assert.equal(ledger1.getRecordedSizeForOrder('o-1'), 0.4,
      're-load must not double-count');

    ledger1.load();
    assert.equal(ledger1.getRecordedSizeForOrder('o-1'), 0.4,
      'a third load must still report 0.4');
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

  it('persist() recreates the file when on-disk file is missing even if ledger is clean', () => {
    // Defensive write on missing-file. Without this, regime-engine.stop()'s
    // unconditional persist() would no-op when the file was unlinked
    // mid-run (operator rm, transient unmount), and the next boot's
    // load() would treat the missing file as a fresh deployment with
    // empty history. Subsequent persists would write a file containing
    // only post-restart fills, silently overwriting recoverable history.
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));
    // First persist wrote the file; ledger is now clean.

    // Simulate transient file disappearance.
    const filePath = path.join(tmpDir, 'test-exchange', 'default', 'fill-ledger.json');
    assert.ok(fs.existsSync(filePath), 'file should exist after first persist');
    fs.rmSync(filePath);
    assert.ok(!fs.existsSync(filePath), 'file removed for missing-file test');

    const writesBefore = ledger._test.getWriteCount();
    ledger.persist(); // clean BUT file missing — must still write
    assert.ok(ledger._test.getWriteCount() > writesBefore,
      'clean persist must still write when on-disk file is missing');
    assert.ok(fs.existsSync(filePath),
      'persist must recreate the missing file');

    // Verify the recreated file has the in-memory contents.
    const restored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(restored.length, 1);
    assert.equal(restored[0].tradeId, 'b-1');
  });

  it('persist() rewrites the file when mutations have happened since last persist', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1' }));

    const writesBefore = ledger._test.getWriteCount();

    // skipPersist mutates without writing — dirty flag should now be set
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-2' }), null, { skipPersist: true });
    ledger.persist();

    assert.ok(ledger._test.getWriteCount() > writesBefore,
      'persist must rewrite when ledger is dirty');
  });

  it('createFillLedger throws on cold start when file is corrupt JSON (refuses to boot empty)', () => {
    // Cold start = fresh ledger instance, no prior successful load, no
    // ingested fills. createFillLedger auto-loads in its constructor —
    // if the file is corrupt, the prior behavior (preserve empty
    // in-memory state) would let the engine boot with zero fills and
    // the next persist would overwrite the recoverable file with only
    // post-start fills, silently destroying historical data. Throwing
    // from the constructor forces operator intervention.
    const exchange = 'test-cold-start-corrupt-json';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), '<<< not valid json >>>');

    assert.throws(() => createTestLedger(exchange), /corrupted or unreadable on cold start/);
  });

  it('createFillLedger throws on cold start when file is valid JSON but not an array', () => {
    const exchange = 'test-cold-start-not-array';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), '{"unexpected":"shape"}');

    assert.throws(() => createTestLedger(exchange), /not an array on cold start/);
  });

  it('createFillLedger throws on cold start when file contains an invalid fill entry', () => {
    const exchange = 'test-cold-start-bad-entry';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    // Array with a single null entry — passes Array.isArray but fails per-fill validation.
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), '[null]');

    assert.throws(() => createTestLedger(exchange), /invalid entry .* on cold start/);
  });

  it('createFillLedger throws on cold start when entries are missing fields required by aggregateFills (would silently NaN downstream)', () => {
    // aggregateFills/rebuildPositionFromFills consume side, size,
    // quoteAmount, netFee, timestamp directly. A row missing any of those
    // would silently produce NaN totals after boot — exactly the corruption
    // mode this guard is meant to prevent. ingestFill always populates
    // every required field, so a missing field on disk indicates
    // hand-editing or actual corruption.
    const cases = [
      { tag: 'no-side', fill: { tradeId: 't1', orderId: 'o1', /* no side */ size: 0.4, price: 100, quoteAmount: 40, netFee: 0, timestamp: Date.now() }, expect: /side must be 'buy' or 'sell'/ },
      { tag: 'no-size', fill: { tradeId: 't1', orderId: 'o1', side: 'buy', /* no size */ price: 100, quoteAmount: 40, netFee: 0, timestamp: Date.now() }, expect: /size must be a finite number/ },
      { tag: 'no-price', fill: { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, /* no price */ quoteAmount: 40, netFee: 0, timestamp: Date.now() }, expect: /price must be a finite number/ },
      { tag: 'no-quoteAmount', fill: { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, price: 100, /* no quoteAmount */ netFee: 0, timestamp: Date.now() }, expect: /quoteAmount must be a finite number/ },
      { tag: 'no-netFee', fill: { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, price: 100, quoteAmount: 40, /* no netFee, no fee */ timestamp: Date.now() }, expect: /netFee or fee must be a finite number/ },
      { tag: 'no-timestamp', fill: { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, price: 100, quoteAmount: 40, netFee: 0 /* no timestamp */ }, expect: /timestamp must be a finite number/ },
    ];
    for (const { tag, fill, expect } of cases) {
      const exchange = `test-cold-start-missing-${tag}`;
      const dir = path.join(tmpDir, exchange, 'default');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify([fill]));
      assert.throws(() => createTestLedger(exchange), expect);
    }
  });

  it('createFillLedger accepts legacy fee-only entries (pre-rebate-split) and backfills netFee on load', () => {
    // Pre-rebate-split fills had `fee` only, no `netFee`. The validator
    // accepts either; load() backfills netFee=fee for the in-memory copy
    // so downstream consumers (aggregateFills etc.) that read fill.netFee
    // directly never see undefined. Without this compat path, upgrading
    // a fund with older ledger entries would refuse to start.
    const exchange = 'test-cold-start-legacy-fee-only';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    const legacyFill = {
      tradeId: 'legacy-1',
      orderId: 'o-1',
      side: 'buy',
      size: 0.4,
      price: 100,
      quoteAmount: 40,
      fee: 0.05, // legacy: fee only, no netFee
      timestamp: Date.now(),
    };
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify([legacyFill]));

    let ledger;
    assert.doesNotThrow(() => { ledger = createTestLedger(exchange); });
    const fills = ledger.getFillsForOrder('o-1');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].netFee, 0.05,
      'load() must backfill netFee from legacy fee field so direct fill.netFee reads work');
  });

  it('createFillLedger throws on cold start when ledger contains duplicate tradeIds (Map dedup would silently undercount)', () => {
    // load() stores entries in a Map keyed by tradeId, so a duplicate would
    // silently overwrite the earlier row — undercount totalAsset / P&L
    // without any indication of corruption. Pre-pass must reject duplicates.
    const exchange = 'test-cold-start-duplicate-tradeId';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    const fill = { tradeId: 'dup', orderId: 'o1', side: 'buy', size: 0.4, price: 100, quoteAmount: 40, netFee: 0, timestamp: Date.now() };
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify([fill, { ...fill, size: 0.5, quoteAmount: 50 }]));
    assert.throws(() => createTestLedger(exchange), /duplicate tradeId 'dup'/);
  });

  it('createFillLedger throws on cold start when an entry has a non-string cycleId (would crash .match() mid-load)', () => {
    // The load body calls `fill.cycleId.match(/^cycle-(\d+)$/)` — if
    // cycleId is an object/non-string, that throws AFTER resetCaches has
    // wiped the in-memory ledger. The presence-only pre-pass missed
    // this; field-type validation must catch it before resetCaches runs.
    const exchange = 'test-cold-start-bad-cycleId';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), JSON.stringify([
      { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, price: 100, quoteAmount: 40, netFee: 0, timestamp: Date.now(), cycleId: {} },
    ]));

    assert.throws(() => createTestLedger(exchange), /cycleId must be a string/);
  });

  it('reload preserves in-memory state when file gains a non-string cycleId entry (no half-load on bad reload)', () => {
    // The same shape that breaks cold-start must also be rejected before
    // resetCaches on a SIGUSR1 reload — otherwise we'd wipe the live
    // ledger and then crash mid-load on the offending entry's
    // cycleId.match() call, losing recoverable data.
    const exchange = 'test-reload-bad-cycleId';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'fill-ledger.json');
    fs.writeFileSync(filePath, '[]');

    const ledger = createTestLedger(exchange);
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));
    const fillsBefore = ledger.getFillCount();

    // Operator edits in a malformed entry mid-run. SIGUSR1 reload must NOT
    // wipe the live ledger — must log and preserve.
    fs.writeFileSync(filePath, JSON.stringify([
      { tradeId: 't1', orderId: 'o1', side: 'buy', size: 0.4, price: 100, quoteAmount: 40, netFee: 0, timestamp: Date.now(), cycleId: {} },
    ]));
    assert.doesNotThrow(() => ledger.load());
    assert.equal(ledger.getFillCount(), fillsBefore,
      'reload with malformed cycleId must preserve in-memory state');
  });

  it('createFillLedger succeeds on cold start when file is missing (legitimate first run)', () => {
    // No file at all is the legitimate "fresh deployment, no fills yet"
    // case — must NOT throw, must boot with empty caches.
    const exchange = 'test-cold-start-no-file';
    let ledger;
    assert.doesNotThrow(() => { ledger = createTestLedger(exchange); });
    assert.equal(ledger.getFillCount(), 0);
  });

  it('createFillLedger succeeds on cold start when file is an empty array', () => {
    const exchange = 'test-cold-start-empty-array';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fill-ledger.json'), '[]');

    let ledger;
    assert.doesNotThrow(() => { ledger = createTestLedger(exchange); });
    assert.equal(ledger.getFillCount(), 0);
  });

  it('load() preserves in-memory state on subsequent corrupt-file loads after a successful initial load (SIGUSR1 reload after boot)', () => {
    // After a successful cold-start load (file empty array → boot OK),
    // a SIGUSR1 reload that hits a corrupt file must NOT throw and must
    // preserve in-memory state. This covers the real flow where the
    // engine boots cleanly, accumulates fills, then operator does an
    // edit-corrupt-then-fix workflow.
    const exchange = 'test-warm-reload-after-boot';
    const dir = path.join(tmpDir, exchange, 'default');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'fill-ledger.json');
    fs.writeFileSync(filePath, '[]');

    const ledger = createTestLedger(exchange);
    ledger.load(); // cold-start success establishes the baseline
    ledger.startNewCycle();
    ledger.ingestFill(makeBuyFill({ tradeId: 'b-1', orderId: 'o-1', size: '0.4' }));
    const fillsBefore = ledger.getFillCount();

    // Corrupt the file and reload — must preserve, not throw.
    fs.writeFileSync(filePath, '<<< corrupt >>>');
    assert.doesNotThrow(() => ledger.load());
    assert.equal(ledger.getFillCount(), fillsBefore,
      'post-boot reload must preserve in-memory state on corruption');
  });

  // =======================================================================
  // heldOpenBuyCostBasis derivation (issue #95)
  // sellOrderId is stamped at TP *placement* — a buy only closes once its
  // linked sell order has actual sell fills in the ledger.
  // =======================================================================
  describe('getDerivedRealizedPnL heldOpenBuyCostBasis (issue #95)', () => {
    it('counts buys with no sellOrderId as held-open cost', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'h-b1', orderId: 'buy-1', price: '100000', size: '0.001' }));

      const derived = ledger.getDerivedRealizedPnL();
      // cost = quoteAmount (100) + netFee (0.10)
      assert.equal(derived.heldOpenBuyCostBasis, 100.10);
      assert.equal(derived.realizedPnL, 0);
    });

    it('still counts a buy as held when its sellOrderId points at a resting (unfilled) TP', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'h-b2', orderId: 'buy-2', price: '100000', size: '0.001' }));
      // Engine stamps sellOrderId at TP placement time — no sell fills exist yet
      ledger.annotateFillsByOrderId('buy-2', { sellOrderId: 'tp-resting-1', bodyId: 'body-1' });

      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.heldOpenBuyCostBasis, 100.10,
        'a placement-time sellOrderId stamp must not zero out held cost basis');
      assert.equal(derived.realizedPnL, 0);
    });

    it('releases held cost once the linked sell order has fills, using the bodyPnl annotation once per orderId', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'h-b3', orderId: 'buy-3', price: '100000', size: '0.001' }));
      ledger.annotateFillsByOrderId('buy-3', { sellOrderId: 'tp-1', bodyId: 'body-1' });

      // TP fills in two partial rows of the same orderId (sells 0.0009, holdback 0.0001)
      ledger.ingestFill(makeSellFill({ tradeId: 'h-s1', orderId: 'tp-1', price: '105000', size: '0.0005' }));
      ledger.ingestFill(makeSellFill({ tradeId: 'h-s2', orderId: 'tp-1', price: '105000', size: '0.0004' }));
      // Engine annotates every partial row with the same per-sell values
      ledger.annotateFillsByOrderId('tp-1', { bodyPnl: 4.2, bodyHoldbackAsset: 0.0001, isBodyOwned: true });

      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.heldOpenBuyCostBasis, 0, 'filled sell releases the buy cost');
      assert.equal(derived.realizedPnL, 4.2, 'bodyPnl taken once per orderId, not per partial row');
      assert.equal(derived.realizedAssetPnL, 0.0001, 'holdback taken once per orderId');
    });

    it('holds only the un-consumed remainder after a partial fill re-links buys to a re-placed TP (issue #128)', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'h-b4', orderId: 'buy-4', price: '100000', size: '0.002' }));
      ledger.annotateFillsByOrderId('buy-4', { sellOrderId: 'tp-old', bodyId: 'body-2' });

      // Partial fill of tp-old: half the body sold. Engine annotates the sell
      // with the realized bodyPnl and stamps the source buys with the consumed
      // fraction (0.5 of the original cost now realized).
      ledger.ingestFill(makeSellFill({ tradeId: 'h-s3', orderId: 'tp-old', price: '105000', size: '0.001' }));
      ledger.annotateFillsByOrderId('tp-old', { bodyPnl: 2.5, bodyHoldbackAsset: 0, isBodyOwned: true, partialFill: true });
      // placeBodyTp re-links the buys to the re-placed TP for the remainder,
      // and the partial-fill handler stamps consumedCostFraction.
      ledger.annotateFillsByOrderId('buy-4', { sellOrderId: 'tp-new', consumedCostFraction: 0.5 });

      const derived = ledger.getDerivedRealizedPnL();
      // tp-new has no fills yet, BUT half the cost was already realized via the
      // partial — only the un-consumed half (100.05) is genuinely held.
      assert.equal(derived.heldOpenBuyCostBasis, 100.05,
        'held cost excludes the already-realized partial tranche');
      assert.equal(derived.realizedPnL, 2.5, 'first tranche realized via annotation');
    });

    it('holds full cost when no partial has been consumed (consumedCostFraction absent)', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'h-b5', orderId: 'buy-5', price: '100000', size: '0.002' }));
      ledger.annotateFillsByOrderId('buy-5', { sellOrderId: 'tp-resting', bodyId: 'body-3' });
      // Resting TP, no fills, no partial consumed → full cost held (unchanged behavior).
      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.heldOpenBuyCostBasis, 200.10);
    });
  });

  describe('historical-fill cycle assignment (issue #108)', () => {
    it('stamps the live cycle by default', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle(); // cycle-1
      const { fill } = ledger.ingestFill(makeBuyFill({ tradeId: 'live-1', orderId: 'o-live' }));
      assert.equal(fill.cycleId, 'cycle-1');
    });

    it('routes a fill to orphan (null) cycle when caller passes cycleId: null', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle(); // cycle-1 is live
      const { fill } = ledger.ingestFill(
        makeBuyFill({ tradeId: 'hist-1', orderId: 'o-hist' }),
        null,
        { cycleId: null }
      );
      assert.equal(fill.cycleId, null,
        'a historical fill must not inherit the live cycle');
      // It is not counted in the current cycle's fills
      assert.equal(ledger.getCurrentCycleFills().some(f => f.tradeId === 'hist-1'), false);
    });

    it('an absent cycleId key still uses the live-cycle default (only explicit null overrides)', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle(); // cycle-1
      const { fill } = ledger.ingestFill(
        makeBuyFill({ tradeId: 'live-2', orderId: 'o-live2' }),
        null,
        { skipPersist: true } // no cycleId key
      );
      assert.equal(fill.cycleId, 'cycle-1');
    });
  });

  describe('computeRealizedFromCyclePairs no-orderId buys (issue #108)', () => {
    it('does not merge distinct no-orderId buys under a single undefined key', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      // Two legacy/manual buys with NO orderId. One is linked to a filled sell,
      // the other is open. Under the old `undefined`-key merge, the first row's
      // sellOrderId would win for the combined cost — mis-classifying both.
      ledger.ingestFill(makeBuyFill({ tradeId: 'no-b1', orderId: undefined, price: '100000', size: '0.001' }));
      ledger.ingestFill(makeBuyFill({ tradeId: 'no-b2', orderId: undefined, price: '100000', size: '0.001' }));
      // Link only the first buy to a sell that actually fills
      ledger.annotateFillsByOrderId(undefined, {}); // no-op safety
      // Manually link no-b1 to a sell via updateFill-like annotation path:
      // annotateFillsByOrderId keys on orderId, so set sellOrderId directly.
      for (const f of ledger.getAllFills()) {
        if (f.tradeId === 'no-b1') { f.sellOrderId = 'sell-x'; }
      }
      ledger.markDirty();
      ledger.ingestFill(makeSellFill({ tradeId: 'no-s1', orderId: 'sell-x', price: '105000', size: '0.001' }));

      const derived = ledger.getDerivedRealizedPnL();
      // Only no-b2's cost (100.10) remains held; no-b1 is paired/closed.
      assert.equal(derived.heldOpenBuyCostBasis, 100.10,
        'the open no-orderId buy is held; the linked one is not');
    });
  });

  describe('previewRecalculateCycles read-only (issue #132)', () => {
    it('reports orphan-fix count and cycle detail WITHOUT mutating the ledger', () => {
      const ledger = createTestLedger();
      // Ingest orphan fills (cycleId: null) forming one completed orphan cycle:
      // a buy followed by a covering sell.
      ledger.ingestFill(makeBuyFill({ tradeId: 'o-b1', orderId: 'ob-1', price: '100000', size: '0.001' }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'o-s1', orderId: 'os-1', price: '105000', size: '0.001' }), null, { cycleId: null });

      // Snapshot ledger state before preview
      const before = ledger.getAllFills().map(f => ({ tradeId: f.tradeId, cycleId: f.cycleId, sellOrderId: f.sellOrderId }));

      const preview = ledger.previewRecalculateCycles();

      // It surfaces the orphan-fix count and the completed cycle detail
      assert.equal(preview.orphansFixed, 2, 'counts both orphan fills it would place');
      assert.equal(preview.cyclesCompleted, 1, 'the buy+covering-sell forms one completed cycle');
      assert.equal(preview.cycleDetails.length, 1);

      // CRITICAL: no fill was mutated — cycleId stays null, no sellOrderId stamped
      const after = ledger.getAllFills().map(f => ({ tradeId: f.tradeId, cycleId: f.cycleId, sellOrderId: f.sellOrderId }));
      assert.deepStrictEqual(after, before, 'previewRecalculateCycles must not mutate any fill');
      assert.equal(ledger.getCurrentCycleId(), null, 'currentCycleId unchanged by preview');
    });

    it('matches recalculateCycles cycleDetails/orphansFixed on the same ledger', () => {
      // Build two ledgers with identical fills; compare preview vs real recalc.
      const seed = (ledger) => {
        ledger.ingestFill(makeBuyFill({ tradeId: 'm-b1', orderId: 'mb-1', price: '100000', size: '0.001' }), null, { cycleId: null });
        ledger.ingestFill(makeSellFill({ tradeId: 'm-s1', orderId: 'ms-1', price: '105000', size: '0.001' }), null, { cycleId: null });
      };
      const a = createTestLedger('preview-a');
      const b = createTestLedger('preview-b');
      seed(a);
      seed(b);

      const preview = a.previewRecalculateCycles();
      const real = b.recalculateCycles();

      assert.equal(preview.orphansFixed, real.orphansFixed);
      assert.equal(preview.cyclesCompleted, real.cyclesCompleted);
      assert.equal(preview.cycleDetails.length, real.cycleDetails.length);
      // Compare the P&L-bearing fields of the single completed cycle detail
      assert.equal(preview.cycleDetails[0].pnl, real.cycleDetails[0].pnl);
      assert.equal(preview.cycleDetails[0].holdbackAsset, real.cycleDetails[0].holdbackAsset);
    });
  });

  // =======================================================================
  // Read-only caching + quiet logs (issue #183)
  // =======================================================================
  describe('getCachedFillLedger / quiet (issue #183)', () => {
    it('quiet:true suppresses the routine load info logs; default still logs', () => {
      const { createFillLedger } = freshFillLedgerModule();
      // Seed a persisted file so load() reaches the "Loaded N fills" path
      // (not the "fill-ledger not found" early return).
      const writer = createFillLedger('cache-ex');
      writer.startNewCycle();
      writer.ingestFill(makeBuyFill({ tradeId: 'q-1' }));
      writer.persist({ force: true });

      const lines = [];
      const orig = console.log;
      console.log = (...a) => { lines.push(a.join(' ')); };
      try {
        createFillLedger('cache-ex', undefined, undefined, { quiet: true });
        const quietLines = lines.filter(l => l.includes('Loaded') || l.includes('Restored active cycle'));
        assert.deepEqual(quietLines, [], 'quiet load must not emit routine info logs');

        createFillLedger('cache-ex'); // default: not quiet
        const loudLines = lines.filter(l => l.includes('Loaded'));
        assert.ok(loudLines.length >= 1, 'non-quiet load should emit "Loaded N fills"');
      } finally {
        console.log = orig;
      }
    });

    it('returns the SAME instance while the file is unchanged, and a NEW one after it changes', () => {
      const mod = freshFillLedgerModule();
      const { createFillLedger, getCachedFillLedger } = mod;

      // Seed a persisted file via a writable ledger.
      const writer = createFillLedger('cache-ex');
      writer.startNewCycle();
      writer.ingestFill(makeBuyFill({ tradeId: 'c-1' }));
      writer.persist({ force: true });

      const a = getCachedFillLedger('cache-ex');
      const b = getCachedFillLedger('cache-ex');
      assert.strictEqual(a, b, 'unchanged file must return the cached instance');
      assert.equal(a.getFillCount(), 1);

      // Change the file (size changes → cache invalidates regardless of mtime granularity).
      writer.ingestFill(makeBuyFill({ tradeId: 'c-2', orderId: 'order-buy-2' }));
      writer.persist({ force: true });

      const c = getCachedFillLedger('cache-ex');
      assert.notStrictEqual(c, a, 'changed file must produce a fresh instance');
      assert.equal(c.getFillCount(), 2, 'fresh instance must reflect the new fill');
    });

    it('does NOT cache a fund whose ledger file does not exist (no unbounded growth from bogus pairs)', () => {
      const { getCachedFillLedger } = freshFillLedgerModule();
      // No file written for these pairs → each call must return a throwaway and
      // never populate the cache, so a flood of bogus pairs can't grow the heap.
      const a = getCachedFillLedger('cache-ex', undefined, 'NOPE-1');
      const b = getCachedFillLedger('cache-ex', undefined, 'NOPE-1');
      assert.equal(a.getFillCount(), 0);
      assert.notStrictEqual(a, b, 'missing-file funds must not be cached (fresh instance each call)');
    });
  });
});
