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

  it('preserves fill-ingestion text while appending fund, trade, and order context', () => {
    const { createFillLedger } = freshFillLedgerModule();
    const ledger = createFillLedger('coinbase', 'BTC-USDC', 'BTC-USDC', { quiet: true });
    ledger.startNewCycle();
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(line);

    try {
      ledger.ingestFill(makeBuyFill({
        tradeId: 'structured-trade',
        orderId: 'structured-order',
      }));
    } finally {
      console.log = originalLog;
    }

    assert.match(
      lines[0],
      /^📝 \[coinbase\] Fill ingested: tradeId=structured-trade orderId=structured-order buy 0\.001 BTC @ \$100000\.00 \(fee: \$0\.1000\)/
    );
    const context = JSON.parse(lines[0].slice(lines[0].lastIndexOf(' {') + 1));
    assert.deepEqual(context, {
      exchange: 'coinbase',
      pair: 'BTC-USDC',
      tradeId: 'structured-trade',
      orderId: 'structured-order',
      side: 'buy',
      size: 0.001,
      price: 100000,
      netFee: 0.1,
      fillTimeMs: null,
    });
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
  // 22c. aggregateFills — carries the fills' own cycleId, not the live cycle
  // =======================================================================
  it('aggregateFills reports the cycleId of the aggregated fills, not the ledger current cycle', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle(); // cycle-1 — the cycle the sell actually belongs to
    ledger.ingestFill(makeSellFill({ tradeId: 'cyc-own-1', orderId: 'sell-own' }));
    const sellFills = ledger.getFillsForOrder('sell-own');

    // Cycle advances AFTER the sell fills (resetCycle runs before the closed
    // trade is recorded), so reading the live cycle would misfile the trade.
    ledger.startNewCycle(); // cycle-2

    const agg = ledger.aggregateFills(sellFills);

    assert.equal(agg.cycleId, 'cycle-1');
    assert.equal(ledger.getCurrentCycleId(), 'cycle-2');
  });

  // =======================================================================
  // 22d. aggregateFills — reports the last exchange fill time
  // =======================================================================
  it('aggregateFills reports the last exchange fill timestamp, not the current time', () => {
    const ledger = createTestLedger();
    ledger.startNewCycle();

    const first = new Date('2026-08-19T15:27:30.000Z');
    const last = new Date('2026-08-19T15:27:35.000Z');
    ledger.ingestFill(makeSellFill({ tradeId: 'ts-1', orderId: 'sell-ts', tradeTime: first.toISOString() }));
    ledger.ingestFill(makeSellFill({ tradeId: 'ts-2', orderId: 'sell-ts', tradeTime: last.toISOString() }));

    const agg = ledger.aggregateFills(ledger.getFillsForOrder('sell-ts'));

    assert.equal(agg.lastTimestamp, last.getTime());
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
  it('persists a whole body of buy links once, including partial fills and duplicate IDs', () => {
    const ledger = createTestLedger();
    for (let i = 0; i < 496; i++) {
      ledger.ingestFill(makeBuyFill({ tradeId: `batch-${i}`, orderId: `buy-${i}` }), { skipPersist: true });
    }
    ledger.ingestFill(makeBuyFill({ tradeId: 'partial', orderId: 'buy-0' }), { skipPersist: true });
    ledger.ingestFill(makeBuyFill({ tradeId: 'unrelated', orderId: 'other' }), { skipPersist: true });
    ledger.persist();
    const writes = ledger._test.getWriteCount();
    const ids = Array.from({ length: 496 }, (_, i) => `buy-${i}`);
    ledger.annotateFillsByOrderIds([...ids, 'buy-0', 'missing'], {
      sellOrderId: 'merged-tp', bodyId: 'merged-body', bodyTier: 'hypergiant',
    });
    assert.equal(ledger._test.getWriteCount(), writes + 1);
    const restored = createTestLedger();
    restored.load();
    for (const id of ids) {
      const fills = restored.getFillsForOrder(id);
      assert.equal(fills.length, id === 'buy-0' ? 2 : 1);
      assert.ok(fills.every(f => f.sellOrderId === 'merged-tp' && f.bodyId === 'merged-body'));
    }
    assert.equal(restored.getFillsForOrder('other')[0].sellOrderId, undefined);
    ledger.annotateFillsByOrderIds(['missing'], { sellOrderId: 'unused' });
    assert.equal(ledger._test.getWriteCount(), writes + 1, 'unmatched batch does not write');
  });

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

  describe('per-buy consumption records (issue #607)', () => {
    // An order that bought 0.002 but whose body only ever attributed 0.001 of
    // it (the first tranche) — the TP that closed that body sold less than the
    // order bought. sellOrderId is stamped across EVERY fill of the order and
    // names a sell with fills, so the boolean rule reads the whole order closed.
    const seedPartlySoldOrder = (ledger) => {
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'c-b1', orderId: 'buy-c', price: '100000', size: '0.001', totalCommission: '0.10' }));
      ledger.ingestFill(makeBuyFill({ tradeId: 'c-b2', orderId: 'buy-c', price: '100000', size: '0.001', totalCommission: '0.10' }));
      ledger.annotateFillsByOrderId('buy-c', { sellOrderId: 'tp-c', bodyId: 'body-c' });
      // Body held 0.001: TP sold 0.0009, holdback 0.0001 booked as reserves.
      ledger.ingestFill(makeSellFill({ tradeId: 'c-s1', orderId: 'tp-c', price: '110000', size: '0.0009', totalCommission: '0.10' }));
      ledger.annotateFillsByOrderId('tp-c', { bodyPnl: 8.8, bodyHoldbackAsset: 0.0001, isBodyOwned: true });
    };

    it('without a record, the boolean rule loses the unsold remainder (the defect)', () => {
      const ledger = createTestLedger();
      seedPartlySoldOrder(ledger);
      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.heldOpenBuyCostBasis, 0, 'legacy closure reads the whole order closed');
      assert.equal(derived.heldOpenAssetQty, 0);
      // The identity breaks by exactly the lost remainder.
      assert.ok(Math.abs(derived.ledgerNetAsset - (derived.heldOpenAssetQty + derived.realizedAssetPnL) - 0.001) < 1e-12);
    });

    it('holds the unsold remainder of an order whose TP sold less than the order bought', () => {
      const ledger = createTestLedger();
      seedPartlySoldOrder(ledger);
      // The sale consumed the body's 0.001 tranche: 0.0009 sold + 0.0001 holdback.
      assert.equal(ledger.recordBuyConsumption('buy-c', 'tp-c', 0.001), true);

      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.heldOpenAssetQty, 0.001, 'the second tranche is still held');
      assert.equal(derived.heldOpenBuyCostBasis, 100.10, 'at its own pro-rata cost (half of $200.20)');
      assert.equal(derived.realizedPnL, 8.8, 'realized P&L is untouched');
      assert.equal(derived.realizedAssetPnL, 0.0001, 'reserves are untouched');
      assert.equal(derived.ledgerNetAsset, 0.0011);
      assert.ok(
        Math.abs(derived.ledgerNetAsset - derived.heldOpenAssetQty - derived.realizedAssetPnL) < 1e-12,
        'net ledger position == held open + reserves, from the ledger alone',
      );
    });

    it('is idempotent per sell order and survives rows ingested after the record', () => {
      const ledger = createTestLedger();
      seedPartlySoldOrder(ledger);
      ledger.recordBuyConsumption('buy-c', 'tp-c', 0.001);
      ledger.recordBuyConsumption('buy-c', 'tp-c', 0.001); // crash replay of the same sell
      // A late tranche of the same order lands after the record: no consumedBy
      // on its row, but it must neither reset nor duplicate the order's record.
      ledger.ingestFill(makeBuyFill({ tradeId: 'c-b3', orderId: 'buy-c', price: '100000', size: '0.001', totalCommission: '0.10' }));

      const consumption = ledger.getBuyOrderConsumption('buy-c');
      assert.deepEqual(consumption.consumedBy, { 'tp-c': 0.001 });
      assert.ok(Math.abs(consumption.size - 0.003) < 1e-12);
      assert.equal(ledger.getDerivedRealizedPnL().heldOpenAssetQty, 0.002);

      // A second booking of the SAME sell (issue #777) adds to its entry.
      ledger.recordBuyConsumption('buy-c', 'tp-c', 0.0005, 0, { additive: true });
      assert.deepEqual(ledger.getBuyOrderConsumption('buy-c').consumedBy, { 'tp-c': 0.0015 });
      ledger.recordBuyConsumption('buy-c', 'tp-c', 0.001); // back to the single booking
      // A second sale adds its own entry; the late row picks the map up too.
      ledger.recordBuyConsumption('buy-c', 'tp-c2', 0.002);
      assert.equal(ledger.getDerivedRealizedPnL().heldOpenAssetQty, 0);
      assert.equal(ledger.getDerivedRealizedPnL().heldOpenBuyCostBasis, 0);
      assert.ok(ledger.getFillsForOrder('buy-c').every(f => f.consumedBy && f.consumedBy['tp-c2'] === 0.002));
    });

    it('seeds prior legacy consumption once, from the first record', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'l-b1', orderId: 'buy-l', price: '100000', size: '0.002', totalCommission: '0.20' }));
      ledger.annotateFillsByOrderId('buy-l', { sellOrderId: 'tp-l2', consumedCostFraction: 0.5 });
      ledger.recordBuyConsumption('buy-l', 'tp-l2', 0.0005, 0.001);
      ledger.recordBuyConsumption('buy-l', 'tp-l3', 0.0001, 0.001); // seed ignored once a record exists
      assert.deepEqual(ledger.getBuyOrderConsumption('buy-l').consumedBy, { __legacy__: 0.001, 'tp-l2': 0.0005, 'tp-l3': 0.0001 });
      assert.equal(ledger.getDerivedRealizedPnL().heldOpenAssetQty, 0.0004);
      assert.equal(ledger.getDerivedRealizedPnL().heldOpenBuyCostBasis, 40.04, 'consumedCostFraction is not applied on top');
    });

    it('refuses to record against an order the ledger does not hold', () => {
      const ledger = createTestLedger();
      assert.equal(ledger.recordBuyConsumption('no-such-order', 'tp-x', 0.001), false);
      assert.equal(ledger.getBuyOrderConsumption('no-such-order'), null);
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
  // Orphan recovery must not move the live cycle (issue #675)
  // =======================================================================
  describe('recalculateCycles orphan recovery preserves the live cycle (issue #675)', () => {
    const HOUR = 60 * 60 * 1000;
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (ms) => new Date(T0 + ms).toISOString();

    // Completed cycle-1 at t=10h, active cycle-2 (two buy orders) at t=20h.
    const seedLiveCycles = (ledger) => {
      ledger.ingestFill(makeBuyFill({ tradeId: 'c1-b', orderId: 'c1-buy', tradeTime: at(10 * HOUR) }), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(makeSellFill({ tradeId: 'c1-s', orderId: 'c1-sell', tradeTime: at(11 * HOUR) }), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(makeBuyFill({ tradeId: 'c2-b1', orderId: 'c2-buy-1', tradeTime: at(20 * HOUR) }), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(makeBuyFill({ tradeId: 'c2-b2', orderId: 'c2-buy-2', tradeTime: at(21 * HOUR) }), null, { cycleId: 'cycle-2' });
      ledger.setCurrentCycleId('cycle-2');
    };
    const currentTradeIds = (ledger) => ledger.getCurrentCycleFills().map(f => f.tradeId).sort();

    it('a single historical orphan buy does not replace the active cycle', () => {
      const ledger = createTestLedger('orphan-buy');
      seedLiveCycles(ledger);
      ledger.ingestFill(makeBuyFill({ tradeId: 'o1-b', orderId: 'o1-buy', tradeTime: at(0) }), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.orphansFixed, 1);
      assert.deepStrictEqual(currentTradeIds(ledger), ['c2-b1', 'c2-b2'],
        'the live cycle must still hold the t=20h buys, not the historical orphan');
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 2);
      assert.equal(result.activeCycleId, ledger.getCurrentCycleId());
      // The orphan sits in its own recovered cycle, distinct from the live one.
      const orphan = ledger.getAllFills().find(f => f.tradeId === 'o1-b');
      assert.ok(orphan.cycleId, 'orphan got a cycle');
      assert.notEqual(orphan.cycleId, ledger.getCurrentCycleId());
      // Preview and apply agree on the live cycle and the rename map.
      assert.equal(preview.activeCycleId, result.activeCycleId);
      assert.deepStrictEqual(preview.idMap, result.idMap);
      // A later fill stamps into the live cycle, not a completed one.
      ledger.ingestFill(makeBuyFill({ tradeId: 'c2-b3', orderId: 'c2-buy-3', tradeTime: at(22 * HOUR) }));
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 3);
    });

    it('returns an idMap that re-points a persisted activeCycleId after an orphan pair renumbers cycles', () => {
      const ledger = createTestLedger('orphan-pair');
      seedLiveCycles(ledger);
      ledger.ingestFill(makeBuyFill({ tradeId: 'o1-b', orderId: 'o1-buy', tradeTime: at(0) }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'o1-s', orderId: 'o1-sell', tradeTime: at(1 * HOUR) }), null, { cycleId: null });

      const persistedActiveCycleId = 'cycle-2';
      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.orphansFixed, 2);
      assert.equal(result.cyclesCompleted, 2, 'orphan pair + cycle-1 are completed');
      assert.deepStrictEqual(currentTradeIds(ledger), ['c2-b1', 'c2-b2']);
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 2);
      // The live cycle was renamed; the map carries the persisted ID to it.
      assert.ok(Object.prototype.hasOwnProperty.call(result.idMap, persistedActiveCycleId),
        'idMap must include the renamed live cycle');
      assert.equal(result.idMap[persistedActiveCycleId], ledger.getCurrentCycleId());
      assert.equal(result.activeCycleId, ledger.getCurrentCycleId());
      assert.equal(preview.activeCycleId, result.activeCycleId);
      assert.deepStrictEqual(preview.idMap, result.idMap);

      // Simulated restart: restoring the RE-POINTED ID selects the live buys;
      // restoring the stale one would select the completed cycle.
      const repointed = result.idMap[persistedActiveCycleId] ?? persistedActiveCycleId;
      ledger.setCurrentCycleId(repointed);
      assert.deepStrictEqual(currentTradeIds(ledger), ['c2-b1', 'c2-b2']);
      ledger.setCurrentCycleId(persistedActiveCycleId);
      assert.notDeepStrictEqual(currentTradeIds(ledger), ['c2-b1', 'c2-b2'],
        'sanity: the stale persisted ID now names a different cycle');
    });

    it('keeps an empty post-reset live cycle last so renumbering cannot collide with it', () => {
      const ledger = createTestLedger('orphan-fresh');
      ledger.ingestFill(makeBuyFill({ tradeId: 'c1-b', orderId: 'c1-buy', tradeTime: at(10 * HOUR) }), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(makeSellFill({ tradeId: 'c1-s', orderId: 'c1-sell', tradeTime: at(11 * HOUR) }), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(makeBuyFill({ tradeId: 'c2-b', orderId: 'c2-buy', tradeTime: at(20 * HOUR) }), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(makeSellFill({ tradeId: 'c2-s', orderId: 'c2-sell', tradeTime: at(21 * HOUR) }), null, { cycleId: 'cycle-2' });
      ledger.setCurrentCycleId('cycle-3'); // reset: no fills yet
      ledger.ingestFill(makeBuyFill({ tradeId: 'o1-b', orderId: 'o1-buy', tradeTime: at(0) }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'o1-s', orderId: 'o1-sell', tradeTime: at(1 * HOUR) }), null, { cycleId: null });

      const result = ledger.recalculateCycles();

      assert.equal(result.cyclesCompleted, 3);
      assert.deepStrictEqual(currentTradeIds(ledger), [], 'the fresh live cycle must not inherit a completed cycle');
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);
      const completedIds = new Set(result.cycleDetails.map(d => d.cycleId));
      assert.ok(!completedIds.has(ledger.getCurrentCycleId()), 'live cycle ID must not name a completed cycle');
      // The next reset must also produce a fresh, unused ID.
      const next = ledger.startNewCycle();
      assert.ok(!completedIds.has(next));
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);
    });

    it('folds a newer unlinked orphan buy into the live cycle without displacing it (#705)', () => {
      const ledger = createTestLedger('orphan-newer');
      seedLiveCycles(ledger);
      // A buy re-imported with cycleId null that postdates the live cycle's
      // start (no persisted start time here, so the boundary is the live
      // cycle's earliest fill at t=20h): a fill the engine missed during
      // downtime inside the live cycle. It joins the live cycle; the live
      // cycle keeps its identity.
      ledger.ingestFill(makeBuyFill({ tradeId: 'late-b', orderId: 'late-buy', tradeTime: at(22 * HOUR) }), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.orphansFixed, 1);
      assert.equal(result.liveCycleOrphansAttributed, 1);
      assert.deepStrictEqual(currentTradeIds(ledger), ['c2-b1', 'c2-b2', 'late-b']);
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 3);
      assert.equal(ledger.getCurrentCycleId(), 'cycle-2', 'no recovered cycle was created, so nothing is renumbered');
      assert.deepStrictEqual(result.idMap, {});
      assert.equal(preview.activeCycleId, result.activeCycleId);
      assert.equal(preview.liveCycleOrphansAttributed, result.liveCycleOrphansAttributed);
      assert.deepStrictEqual(preview.idMap, result.idMap);
    });

    it('still adopts an incomplete orphan group when there is no live cycle', () => {
      const ledger = createTestLedger('orphan-no-live');
      ledger.ingestFill(makeBuyFill({ tradeId: 'o1-b', orderId: 'o1-buy', tradeTime: at(0) }), null, { cycleId: null });
      assert.equal(ledger.getCurrentCycleId(), null);

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.activeCycleId, 'cycle-1');
      assert.equal(ledger.getCurrentCycleId(), 'cycle-1');
      assert.equal(preview.activeCycleId, result.activeCycleId);
    });
  });

  // =======================================================================
  // Null-cycle fills inside the live cycle's timeframe (issue #705)
  // =======================================================================
  describe('recalculateCycles attributes null-cycle fills to the live cycle (issue #705)', () => {
    const HOUR = 60 * 60 * 1000;
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (h) => new Date(T0 + h * HOUR).toISOString();
    const cycleOf = (ledger, tradeId) => ledger.getAllFills().find(f => f.tradeId === tradeId).cycleId;
    const currentTradeIds = (ledger) => ledger.getCurrentCycleFills().map(f => f.tradeId).sort();
    const buy = (tradeId, orderId, h, size = '0.001') => makeBuyFill({ tradeId, orderId, size, tradeTime: at(h) });
    const sell = (tradeId, orderId, h, size = '0.001') => makeSellFill({ tradeId, orderId, size, tradeTime: at(h) });

    // Completed cycle-1 (t=10-11h); cycle-2 is a fresh post-reset live cycle.
    const seedCompletedCycle1 = (ledger) => {
      ledger.ingestFill(buy('c1-b', 'c1-buy', 10), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(sell('c1-s', 'c1-sell', 11), null, { cycleId: 'cycle-1' });
    };

    it('startNewCycle records its start time; setCurrentCycleId only keeps a supplied one', () => {
      const ledger = createTestLedger('started-at');
      const before = Date.now();
      ledger.startNewCycle();
      assert.ok(ledger.getCurrentCycleStartedAt() >= before);
      ledger.setCurrentCycleId('cycle-7', T0);
      assert.equal(ledger.getCurrentCycleStartedAt(), T0);
      ledger.setCurrentCycleId('cycle-7');
      assert.equal(ledger.getCurrentCycleStartedAt(), null, 'an unknown start is null, never a stale one');
      ledger.setCurrentCycleId('cycle-7', /** @type {any} */ ('garbage'));
      assert.equal(ledger.getCurrentCycleStartedAt(), null);
    });

    it('folds orphans after a persisted reset boundary into the still-empty live cycle, leaves earlier ones', () => {
      const ledger = createTestLedger('fold-empty-live');
      seedCompletedCycle1(ledger);
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR); // reset at t=30h, no fills yet
      ledger.ingestFill(buy('pre-b', 'pre-buy', 25), null, { cycleId: null });
      ledger.ingestFill(buy('post-b', 'post-buy', 31), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      assert.equal(cycleOf(ledger, 'post-b'), null, 'preview never stamps fills');
      assert.equal(ledger.getAllFills().find(f => f.tradeId === 'post-b').cycleAttribution, undefined);
      const result = ledger.recalculateCycles();

      assert.equal(result.liveCycleOrphansAttributed, 1);
      assert.equal(result.orphansFixed, 2);
      assert.deepStrictEqual(currentTradeIds(ledger), ['post-b']);
      assert.equal(ledger.getAllFills().find(f => f.tradeId === 'post-b').cycleAttribution, 'timeframe');
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
      assert.notEqual(cycleOf(ledger, 'pre-b'), ledger.getCurrentCycleId(), 'pre-reset fill stays out of the live cycle');
      assert.equal(result.activeCycleId, ledger.getCurrentCycleId());
      assert.equal(preview.activeCycleId, result.activeCycleId);
      assert.deepStrictEqual(preview.idMap, result.idMap);
      assert.equal(preview.liveCycleOrphansAttributed, result.liveCycleOrphansAttributed);
      assert.equal(preview.orphansFixed, result.orphansFixed);
      // The renamed live cycle keeps its start time.
      assert.equal(ledger.getCurrentCycleStartedAt(), T0 + 30 * HOUR);
    });

    it('counts a timeframe-folded buy toward cycleBuys but keeps it out of the core position', () => {
      const ledger = createTestLedger('fold-rebuild');
      seedCompletedCycle1(ledger);
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);
      ledger.ingestFill(buy('live-b', 'live-buy', 31), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(buy('late-b', 'late-buy', 32), null, { cycleId: null });

      ledger.recalculateCycles();
      const rebuilt = ledger.rebuildPositionFromFills();

      assert.equal(rebuilt.cycleBuys, 2);
      assert.equal(ledger.getCurrentCycleBuysCount(), 2);
      assert.equal(rebuilt.totalAsset, 0.001, 'no core TP may be sized over an unlinked import');
    });

    it('a known start time is the boundary even when older fills were stamped into the live cycle', () => {
      const ledger = createTestLedger('fold-known-start');
      seedCompletedCycle1(ledger);
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);
      // DCA-merge synthetic pending buy dated at order creation, before the reset.
      ledger.ingestFill(buy('dca-b', 'dca-buy', 20), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(buy('manual-b', 'manual-buy', 25), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.equal(preview.liveCycleOrphansAttributed, 0);
      assert.deepStrictEqual(currentTradeIds(ledger), ['dca-b'], 'the pre-reset manual buy stays out');
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
    });

    it('auto-link never stamps a timeframe-folded buy once its cycle completes (legacy core)', () => {
      const ledger = createTestLedger('fold-autolink');
      ledger.setCurrentCycleId('cycle-1', T0 + 9 * HOUR);
      ledger.ingestFill(buy('core-b', 'core-buy', 10), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(buy('manual-b', 'manual-buy', 11), null, { cycleId: null });
      ledger.recalculateCycles();
      assert.equal(ledger.getAllFills().find(f => f.tradeId === 'manual-b').cycleAttribution, 'timeframe');
      // Core TP fills for the core position only (TP placement skips the
      // timeframe buy), then the cycle resets.
      ledger.annotateFillsByOrderId('core-buy', { sellOrderId: 'core-tp' });
      ledger.ingestFill(sell('core-s', 'core-tp', 12), null, { cycleId: 'cycle-1' });
      const before = ledger.getDerivedRealizedPnL();
      ledger.startNewCycle();

      const result = ledger.recalculateCycles();

      assert.ok(result.cycleDetails.some(d => d.cycleId === 'cycle-1'), 'cycle-1 is completed and non-current');
      assert.equal(ledger.getAllFills().find(f => f.tradeId === 'manual-b').sellOrderId, undefined,
        'the manual buy is not booked against the core TP');
      const after = ledger.getDerivedRealizedPnL();
      assert.equal(after.realizedPnL, before.realizedPnL);
      assert.equal(after.realizedAssetPnL, before.realizedAssetPnL);
      assert.equal(after.heldOpenBuyCostBasis, before.heldOpenBuyCostBasis);
    });

    it('does not fold anything into an empty live cycle with no known start time', () => {
      const ledger = createTestLedger('fold-no-boundary');
      seedCompletedCycle1(ledger);
      ledger.setCurrentCycleId('cycle-2'); // legacy state: no persisted start
      ledger.ingestFill(buy('late-b', 'late-buy', 31), null, { cycleId: null });

      const result = ledger.recalculateCycles();

      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.deepStrictEqual(currentTradeIds(ledger), []);
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);
    });

    it('attributes by order linkage before timestamp: a late partial row joins its own order\'s cycle', () => {
      const ledger = createTestLedger('fold-linkage');
      seedCompletedCycle1(ledger);
      // cycle-1's sell order had a second partial row that sync-fills re-imported.
      ledger.ingestFill(sell('c1-s2', 'c1-sell', 32), null, { cycleId: null });
      // A buy linked (sellOrderId) to cycle-1's sell, re-imported null.
      ledger.ingestFill(buy('c1-b2', 'c1-buy-2', 31), null, { cycleId: null });
      ledger.annotateFillsByOrderId('c1-buy-2', { sellOrderId: 'c1-sell' });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(cycleOf(ledger, 'c1-s2'), 'cycle-1');
      assert.equal(cycleOf(ledger, 'c1-b2'), 'cycle-1');
      const attributionOf = (id) => ledger.getAllFills().find(f => f.tradeId === id).cycleAttribution;
      assert.equal(attributionOf('c1-s2'), 'order');
      assert.equal(attributionOf('c1-b2'), 'order', 'linked to c1-s2, so it moves with that component');
      assert.equal(result.orphansAttributed, 2);
      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.deepStrictEqual(currentTradeIds(ledger), [], 'linked fills never fold into the live cycle by time');
      assert.deepStrictEqual(result.idMap, {}, 'no recovered cycle → no renumbering');
      assert.equal(preview.orphansAttributed, result.orphansAttributed);
    });

    it('a recovered partial row of a body-owned buy order inherits the order\'s ownership annotations', () => {
      const ledger = createTestLedger('fold-body-row');
      seedCompletedCycle1(ledger);
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);
      ledger.ingestFill(buy('bb-1', 'body-buy', 31), null, { cycleId: 'cycle-2' });
      ledger.annotateFillsByOrderId('body-buy', { isBodyOwned: true, bodyId: 'body-A', bodyTier: 'moon', sellOrderId: 'body-tp' });
      ledger.ingestFill(buy('bb-2', 'body-buy', 32), null, { cycleId: null });

      ledger.recalculateCycles();

      const row = ledger.getAllFills().find(f => f.tradeId === 'bb-2');
      assert.equal(row.cycleId, 'cycle-2');
      assert.equal(row.cycleAttribution, 'order');
      assert.equal(row.bodyId, 'body-A');
      assert.equal(row.isBodyOwned, true);
      assert.equal(row.sellOrderId, 'body-tp');
      assert.equal(ledger.rebuildPositionFromFills().totalAsset, 0, 'body-owned rows stay out of the core position');
    });

    it('attributes a buy linked only via sellOrderId to its sell\'s cycle', () => {
      const ledger = createTestLedger('fold-link-only');
      seedCompletedCycle1(ledger);
      ledger.ingestFill(buy('l-b', 'l-buy', 31), null, { cycleId: null });
      ledger.annotateFillsByOrderId('l-buy', { sellOrderId: 'c1-sell' });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const result = ledger.recalculateCycles();

      assert.equal(cycleOf(ledger, 'l-b'), 'cycle-1');
      assert.equal(ledger.getAllFills().find(f => f.tradeId === 'l-b').cycleAttribution, 'link');
      assert.equal(result.liveCycleOrphansAttributed, 0);
    });

    it('keeps a linked orphan buy/sell together when the pair straddles the live boundary', () => {
      const ledger = createTestLedger('fold-straddle');
      seedCompletedCycle1(ledger);
      ledger.ingestFill(buy('s-b', 's-buy', 29), null, { cycleId: null });
      ledger.annotateFillsByOrderId('s-buy', { sellOrderId: 's-sell' });
      ledger.ingestFill(sell('s-s', 's-sell', 31), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const result = ledger.recalculateCycles();

      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.equal(cycleOf(ledger, 's-b'), cycleOf(ledger, 's-s'), 'the pair lands in one cycle (atomic)');
      assert.notEqual(cycleOf(ledger, 's-s'), ledger.getCurrentCycleId());
    });

    it('never folds a component holding a sell by timestamp, even entirely inside the live timeframe', () => {
      const ledger = createTestLedger('fold-pair');
      seedCompletedCycle1(ledger);
      // A manual-trade import pair (linked buy → sell) and a lone unlinked sell.
      ledger.ingestFill(buy('p-b', 'p-buy', 31), null, { cycleId: null });
      ledger.annotateFillsByOrderId('p-buy', { sellOrderId: 'p-sell' });
      ledger.ingestFill(sell('p-s', 'p-sell', 32), null, { cycleId: null });
      ledger.ingestFill(sell('lone-s', 'lone-sell', 33), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.deepStrictEqual(currentTradeIds(ledger), [], 'no foreign sell may join (or complete) the live cycle');
      assert.equal(cycleOf(ledger, 'p-b'), cycleOf(ledger, 'p-s'), 'the pair stays together in a recovered cycle');
      assert.notEqual(cycleOf(ledger, 'lone-s'), ledger.getCurrentCycleId());
      assert.equal(preview.cyclesCompleted, result.cyclesCompleted);
    });

    it('keeps an unlinked buy with the unlinked sell after it instead of folding the buy alone', () => {
      const ledger = createTestLedger('fold-roundtrip');
      seedCompletedCycle1(ledger);
      // A manual round trip sync-fills re-imported without links, then a
      // genuinely missed engine buy after it.
      ledger.ingestFill(buy('rt-b', 'rt-buy', 31), null, { cycleId: null });
      ledger.ingestFill(sell('rt-s', 'rt-sell', 32), null, { cycleId: null });
      ledger.ingestFill(buy('miss-b', 'miss-buy', 33), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(cycleOf(ledger, 'rt-b'), cycleOf(ledger, 'rt-s'), 'the round trip is not split across cycles');
      assert.notEqual(cycleOf(ledger, 'rt-s'), ledger.getCurrentCycleId());
      assert.deepStrictEqual(currentTradeIds(ledger), ['miss-b'], 'a buy after the unplaced sell still folds');
      assert.equal(result.liveCycleOrphansAttributed, 1);
      assert.equal(preview.liveCycleOrphansAttributed, result.liveCycleOrphansAttributed);
      assert.equal(preview.cyclesCompleted, result.cyclesCompleted);
      assert.ok(result.cycleDetails.some(d => d.cycleId === cycleOf(ledger, 'rt-s')), 'the round trip is a completed cycle');
    });

    it('leaves an orphan whose order spans two cycles unattributed (ambiguous)', () => {
      const ledger = createTestLedger('fold-ambiguous');
      seedCompletedCycle1(ledger);
      ledger.ingestFill(buy('c2-b', 'c2-buy', 20), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(sell('c2-s', 'shared-sell', 21), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(sell('c1-sx', 'shared-sell', 12), null, { cycleId: 'cycle-1' });
      ledger.setCurrentCycleId('cycle-3', T0 + 30 * HOUR);
      ledger.ingestFill(sell('amb-s', 'shared-sell', 31), null, { cycleId: null });

      const result = ledger.recalculateCycles();

      assert.equal(result.orphansAttributed, 0);
      assert.equal(result.liveCycleOrphansAttributed, 0);
      assert.ok(!['cycle-1', 'cycle-2', ledger.getCurrentCycleId()].includes(cycleOf(ledger, 'amb-s')));
    });

    it('re-evaluates live-cycle completion after folding, identically in preview and apply', () => {
      const ledger = createTestLedger('fold-completes');
      seedCompletedCycle1(ledger);
      ledger.ingestFill(buy('c2-b1', 'c2-buy-1', 20), null, { cycleId: 'cycle-2' });
      ledger.ingestFill(buy('c2-b2', 'c2-buy-2', 21), null, { cycleId: 'cycle-2' });
      // TP placement stamped both buys with their sell; the TP filled while the
      // engine was down and sync-fills re-imported it null.
      ledger.annotateFillsByOrderId('c2-buy-1', { sellOrderId: 'c2-tp' });
      ledger.annotateFillsByOrderId('c2-buy-2', { sellOrderId: 'c2-tp' });
      ledger.setCurrentCycleId('cycle-2');
      ledger.ingestFill(sell('late-s', 'c2-tp', 23, '0.002'), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      assert.equal(cycleOf(ledger, 'late-s'), 'cycle-2');
      const ids = (r) => r.cycleDetails.map(d => d.cycleId).sort();
      assert.ok(ids(result).includes('cycle-2'), 'the folded sell completes the live cycle');
      assert.equal(result.cyclesCompleted, 2);
      assert.deepStrictEqual(ids(preview), ids(result));
      assert.equal(preview.cyclesCompleted, result.cyclesCompleted);
    });

    // --- #752: attributed SELL rows keep their body/satellite annotations ---
    const rowOf = (ledger, tradeId) => ledger.getAllFills().find(f => f.tradeId === tradeId);
    const cycleFillsOf = (ledger, cycleId) => ledger.getAllFills().filter(f => f.cycleId === cycleId);

    it('an order-attributed body TP sell row inherits its sibling\'s per-sell annotations (#752)', () => {
      const ledger = createTestLedger('attr-sell-order');
      ledger.ingestFill(buy('ab-b', 'a-buy', 10, '0.002'), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('a-buy', { isBodyOwned: true, bodyId: 'body-A', bodyTier: 'moon', sellOrderId: 'a-tp' });
      ledger.ingestFill(buy('core-b', 'core-buy', 10.5, '0.001'), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(sell('as-1', 'a-tp', 11, '0.0009'), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('a-tp', {
        isBodyOwned: true, bodyId: 'body-A', bodyTier: 'moon',
        bodyCostBasis: 180, bodyAvgPrice: 100000, bodyBtcQty: 0.002, bodyHoldbackAsset: 0.0002, bodyPnl: 7.5,
      });
      // The TP's second partial row, re-imported null by sync-fills.
      ledger.ingestFill(sell('as-2', 'a-tp', 11.5, '0.0009'), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);
      const derivedBefore = ledger.getDerivedRealizedPnL();

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      const row = rowOf(ledger, 'as-2');
      assert.equal(row.cycleId, 'cycle-1');
      assert.equal(row.cycleAttribution, 'order');
      assert.equal(row.isBodyOwned, true);
      assert.equal(row.bodyId, 'body-A');
      assert.equal(row.bodyPnl, 7.5);
      assert.equal(row.bodyHoldbackAsset, 0.0002);
      // bodyPnl is taken once per orderId, so the copy never double-counts.
      const derived = ledger.getDerivedRealizedPnL();
      assert.equal(derived.realizedPnL, derivedBefore.realizedPnL);
      assert.equal(derived.realizedAssetPnL, derivedBefore.realizedAssetPnL);
      // A body sell is not a legacy sell: cycle-1 completes, yet the core buy is
      // not stamped with the body's TP, and core stats see no sell.
      assert.ok(result.cycleDetails.some(d => d.cycleId === 'cycle-1'));
      assert.equal(rowOf(ledger, 'core-b').sellOrderId, undefined);
      const c1 = result.cycleDetails.find(d => d.cycleId === 'cycle-1');
      assert.equal(c1.assetSold, 0);
      assert.equal(ledger.rebuildPositionFromFills(cycleFillsOf(ledger, 'cycle-1')).totalAsset, 0.001, 'only the core buy');
      assert.deepStrictEqual(preview.cycleDetails, result.cycleDetails, 'preview evaluates the same inherited annotations');
    });

    it('a link-attributed sibling-less sell inherits ownership from the body buys that link to it (#752)', () => {
      const ledger = createTestLedger('attr-sell-link');
      ledger.ingestFill(buy('lb-b', 'b-buy', 10, '0.002'), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('b-buy', { isBodyOwned: true, bodyId: 'body-B', bodyTier: 'moon', sellOrderId: 'b-tp' });
      ledger.ingestFill(buy('core-b', 'core-buy', 10.5, '0.001'), null, { cycleId: 'cycle-1' });
      // The body TP filled while the engine was down; sync-fills re-imported it null.
      ledger.ingestFill(sell('bs-1', 'b-tp', 11, '0.0019'), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);
      const derivedBefore = ledger.getDerivedRealizedPnL();

      const preview = ledger.previewRecalculateCycles();
      const result = ledger.recalculateCycles();

      const row = rowOf(ledger, 'bs-1');
      assert.equal(row.cycleId, 'cycle-1');
      assert.equal(row.cycleAttribution, 'link');
      assert.equal(row.isBodyOwned, true);
      assert.equal(row.bodyId, 'body-B');
      assert.equal(row.bodyTier, 'moon');
      assert.equal(row.isSatellite, undefined);
      assert.equal(row.bodyPnl, undefined, 'P&L stays with cycle pairing\'s linked-cost proration');
      assert.deepStrictEqual(ledger.getDerivedRealizedPnL(), derivedBefore);
      assert.ok(result.cycleDetails.some(d => d.cycleId === 'cycle-1'), 'the sell completes cycle-1');
      assert.equal(rowOf(ledger, 'core-b').sellOrderId, undefined, 'auto-link never books the core buy against a body TP');
      assert.equal(ledger.rebuildPositionFromFills(cycleFillsOf(ledger, 'cycle-1')).totalAsset, 0.001,
        'the body sell does not reduce the core position');
      assert.deepStrictEqual(preview.cycleDetails, result.cycleDetails);
    });

    it('a link-attributed sell linked only from core buys stays unowned and closes the cycle\'s other core buys (#752)', () => {
      const ledger = createTestLedger('attr-sell-core');
      ledger.ingestFill(buy('x-b', 'x-buy', 10), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('x-buy', { sellOrderId: 'x-tp' });
      ledger.ingestFill(buy('y-b', 'y-buy', 10.5), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(sell('xs', 'x-tp', 11, '0.0011'), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const result = ledger.recalculateCycles();

      const row = rowOf(ledger, 'xs');
      assert.equal(row.cycleAttribution, 'link');
      assert.equal(row.isBodyOwned, undefined);
      assert.equal(row.bodyId, undefined);
      assert.ok(result.cycleDetails.some(d => d.cycleId === 'cycle-1'));
      assert.equal(rowOf(ledger, 'y-b').sellOrderId, 'x-tp',
        'a core-linked recovered sell is provably the core TP, so legacy auto-link still applies');
    });

    it('heals a sell row an earlier (#705) recalc already attributed without its annotations (#752)', () => {
      const ledger = createTestLedger('attr-sell-heal');
      ledger.ingestFill(buy('hb', 'h-buy', 10, '0.002'), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('h-buy', { isBodyOwned: true, bodyId: 'body-H', sellOrderId: 'h-tp' });
      ledger.ingestFill(sell('hs-1', 'h-tp', 11, '0.0009'), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('h-tp', { isBodyOwned: true, bodyId: 'body-H', bodyPnl: 4, bodyHoldbackAsset: 0.0002 });
      // Stamped into cycle-1 by the pre-#752 recalc: cycleId + attribution, no annotations.
      ledger.ingestFill(sell('hs-2', 'h-tp', 11.5, '0.0009'), null, { cycleId: 'cycle-1' });
      const row = rowOf(ledger, 'hs-2');
      row.cycleAttribution = 'order';
      delete row.isBodyOwned; delete row.bodyId; delete row.bodyPnl; delete row.bodyHoldbackAsset;
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const preview = ledger.previewRecalculateCycles();
      assert.equal(rowOf(ledger, 'hs-2').bodyId, undefined, 'preview never mutates');
      const result = ledger.recalculateCycles();

      assert.equal(rowOf(ledger, 'hs-2').bodyId, 'body-H');
      assert.equal(rowOf(ledger, 'hs-2').bodyPnl, 4);
      assert.deepStrictEqual(preview.cycleDetails, result.cycleDetails);
    });

    it('a link-attributed sell linked from buys of two different bodies stays unowned (#752)', () => {
      const ledger = createTestLedger('attr-sell-mixed');
      ledger.ingestFill(buy('m1', 'm1-buy', 10), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('m1-buy', { isBodyOwned: true, bodyId: 'body-1', sellOrderId: 'm-tp' });
      ledger.ingestFill(buy('m2', 'm2-buy', 10.5), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('m2-buy', { isBodyOwned: true, bodyId: 'body-2', sellOrderId: 'm-tp' });
      ledger.ingestFill(buy('mc', 'mc-buy', 10.8), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(sell('ms', 'm-tp', 11, '0.0019'), null, { cycleId: null });
      ledger.setCurrentCycleId('cycle-2', T0 + 30 * HOUR);

      const result = ledger.recalculateCycles();

      const row = rowOf(ledger, 'ms');
      assert.equal(row.cycleAttribution, 'link');
      assert.equal(row.isBodyOwned, undefined);
      assert.equal(row.bodyId, undefined);
      assert.ok(result.cycleDetails.some(d => d.cycleId === 'cycle-1'));
      assert.equal(rowOf(ledger, 'mc').sellOrderId, undefined, 'a body-linked sell is never the core buy\'s close');
    });
  });

  // =======================================================================
  // recalculateCycles auto-link must not close still-open body buys (issue #677)
  // =======================================================================
  describe('recalculateCycles auto-link skips body/satellite buys (issue #677)', () => {
    it("does not stamp an open body buy with another body's sell when the cycle crosses the completion ratio", () => {
      const ledger = createTestLedger('autolink-body');

      // Body A: buy 1.0, TP sell fills 0.95 with a bodyPnl annotation — the
      // healthy holdback shape (CLAUDE.md "Holdback is the design").
      ledger.ingestFill(makeBuyFill({
        tradeId: 'ba-buy', orderId: 'bodyA-buy', price: '100', size: '1.0',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T00:00:00Z',
      }), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('bodyA-buy', { sellOrderId: 'bodyA-sell', bodyId: 'body-A', isBodyOwned: true });
      ledger.ingestFill(makeSellFill({
        tradeId: 'ba-sell', orderId: 'bodyA-sell', price: '105', size: '0.95',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T01:00:00Z',
      }), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('bodyA-sell', { bodyId: 'body-A', isBodyOwned: true, bodyPnl: 9.5, bodyHoldbackAsset: 0.05 });

      // Body B: buy 0.5 in the SAME cycle. Its TP was never placed (min-size
      // body / placement failure / crash), so it legitimately carries no
      // sellOrderId — this is not a crash-repair case.
      ledger.ingestFill(makeBuyFill({
        tradeId: 'bb-buy', orderId: 'bodyB-buy', price: '90', size: '0.5',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T02:00:00Z',
      }), null, { cycleId: 'cycle-1' });
      ledger.annotateFillsByOrderId('bodyB-buy', { bodyId: 'body-B', isBodyOwned: true });

      // The cycle's sell ratio (0.95 / 1.5 ≈ 0.63) crosses
      // CYCLE_COMPLETE_SELL_RATIO (0.5), so recalculateCycles classifies
      // cycle-1 as "completed" even though body B's buy is still open.
      const result = ledger.recalculateCycles();
      assert.ok(result.cyclesCompleted >= 1, 'cycle-1 must be classified as completed');

      const buyB = ledger.getFillsForOrder('bodyB-buy')[0];
      assert.equal(buyB.sellOrderId, undefined,
        "body B's still-open buy must NOT be auto-linked to body A's sell");

      const derived = ledger.computeRealizedFromCyclePairs();
      assert.equal(derived.heldOpenBuyCostBasis, 45,
        "body B's full cost (0.5 * 90) must stay held, not attributed to sellA");
      assert.equal(derived.realizedPnL, 9.5,
        "body A's realizedPnL from the bodyPnl annotation is unaffected");
    });

    it('never picks a body/satellite sell as the anchor for a legacy buy, even when it is the first sell recorded', () => {
      const ledger = createTestLedger('autolink-sell-anchor');

      // A body-owned sell lands in cycle-3 FIRST (insertion order), so a
      // pre-fix `cycleSellIds` scan (no ownership check on the sell side)
      // would anchor the cycle on it.
      ledger.ingestFill(makeSellFill({
        tradeId: 'x-body-sell', orderId: 'body-sell-x', price: '105', size: '0.3',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T00:00:00Z',
      }), null, { cycleId: 'cycle-3' });
      ledger.annotateFillsByOrderId('body-sell-x', { bodyId: 'body-X', isBodyOwned: true, bodyPnl: 1, bodyHoldbackAsset: 0 });

      // A legacy (non-body) buy with no sellOrderId — the orphan this
      // heuristic exists to repair.
      ledger.ingestFill(makeBuyFill({
        tradeId: 'x-legacy-buy', orderId: 'legacy-buy-x', price: '100', size: '1.0',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T01:00:00Z',
      }), null, { cycleId: 'cycle-3' });

      // A legacy sell arrives after the body sell. It is the only correct
      // anchor for the legacy buy.
      ledger.ingestFill(makeSellFill({
        tradeId: 'x-legacy-sell', orderId: 'legacy-sell-x', price: '110', size: '0.3',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T02:00:00Z',
      }), null, { cycleId: 'cycle-3' });

      // Sell ratio: (0.3 + 0.3) / 1.0 = 0.6, crosses CYCLE_COMPLETE_SELL_RATIO.
      ledger.recalculateCycles();

      const legacyBuy = ledger.getFillsForOrder('legacy-buy-x')[0];
      assert.equal(legacyBuy.sellOrderId, 'legacy-sell-x',
        'the legacy buy must anchor to the legacy sell, never the body-owned sell that happened to be recorded first');
    });

    it("does not auto-link within the ledger's current (still-live) cycle, even after it crosses the completion ratio", () => {
      const ledger = createTestLedger('autolink-livecycle');

      ledger.ingestFill(makeBuyFill({
        tradeId: 'lc-buy', orderId: 'lc-buy-order', price: '100', size: '1.0',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T00:00:00Z',
      }), null, { cycleId: 'cycle-1' });
      ledger.ingestFill(makeSellFill({
        tradeId: 'lc-sell', orderId: 'lc-sell-order', price: '105', size: '0.6',
        totalCommission: '0', rebate: '0', tradeTime: '2026-01-01T01:00:00Z',
      }), null, { cycleId: 'cycle-1' });
      ledger.setCurrentCycleId('cycle-1');

      // Sell ratio (0.6 / 1.0 = 0.6) already crosses CYCLE_COMPLETE_SELL_RATIO
      // (0.5), but cycle-1 is still the LIVE cycle — more buys/sells can still
      // land in it, so the buy must stay open rather than adopt a premature link.
      const result = ledger.recalculateCycles();
      assert.equal(result.activeCycleId, 'cycle-1');

      const buy = ledger.getFillsForOrder('lc-buy-order')[0];
      assert.equal(buy.sellOrderId, undefined,
        'a buy inside the still-live cycle must not be auto-linked even though the ratio crosses the completion threshold');
    });
  });

  // =======================================================================
  // Cycle recalculation parity & shared rules (issue #582)
  // =======================================================================
  describe('previewRecalculateCycles and recalculateCycles parity (issue #582)', () => {
    it('agrees on cyclesCompleted, orphansFixed, and the set of cycleDetails cycle ids', () => {
      const ledger = createTestLedger('parity-test');
      // Build a ledger with orphan fills: completed cycle + active cycle
      ledger.ingestFill(makeBuyFill({ tradeId: 'p-b1', orderId: 'pb-1', price: '100000', size: '0.002', timestamp: 1000 }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'p-s1', orderId: 'ps-1', price: '105000', size: '0.002', timestamp: 2000 }), null, { cycleId: null });
      ledger.ingestFill(makeBuyFill({ tradeId: 'p-b2', orderId: 'pb-2', price: '101000', size: '0.001', timestamp: 3000 }), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const real = ledger.recalculateCycles();

      assert.equal(preview.cyclesCompleted, real.cyclesCompleted);
      assert.equal(preview.orphansFixed, real.orphansFixed);
      assert.equal(preview.activeCycleId, real.activeCycleId);
      const previewCycleIds = preview.cycleDetails.map(d => d.cycleId);
      const realCycleIds = real.cycleDetails.map(d => d.cycleId);
      assert.deepStrictEqual(previewCycleIds, realCycleIds, 'preview and apply must produce the identical set of cycleDetails cycle IDs');
      assert.ok(previewCycleIds.length > 0, 'at least one completed cycle verified');
    });

    it('pins that changing the shared threshold moves preview and apply together', () => {
      const fillLedgerMod = freshFillLedgerModule();
      const { createFillLedger, setCycleCompleteSellRatioForTest, CYCLE_COMPLETE_SELL_RATIO } = fillLedgerMod;
      const originalRatio = CYCLE_COMPLETE_SELL_RATIO;
      try {
        // Buy 1.0, Sell 0.6 -> sell ratio is 0.6.
        // At default threshold (0.5), 0.6 >= 0.5 so cycle is completed.
        const ledger1 = createFillLedger('thresh-1');
        ledger1.ingestFill(makeBuyFill({ tradeId: 't-b1', orderId: 'tb-1', price: '100000', size: '1.0', timestamp: 1000 }), null, { cycleId: null });
        ledger1.ingestFill(makeSellFill({ tradeId: 't-s1', orderId: 'ts-1', price: '105000', size: '0.6', timestamp: 2000 }), null, { cycleId: null });

        const preview1 = ledger1.previewRecalculateCycles();
        const real1 = ledger1.recalculateCycles();
        assert.equal(preview1.cyclesCompleted, 1, 'completed at default threshold');
        assert.equal(real1.cyclesCompleted, 1, 'completed at default threshold');

        // Increase threshold to 0.7. Now 0.6 < 0.7, so cycle should NOT be completed in BOTH.
        setCycleCompleteSellRatioForTest(0.7);

        const ledger2 = createFillLedger('thresh-2');
        ledger2.ingestFill(makeBuyFill({ tradeId: 't-b2', orderId: 'tb-2', price: '100000', size: '1.0', timestamp: 1000 }), null, { cycleId: null });
        ledger2.ingestFill(makeSellFill({ tradeId: 't-s2', orderId: 'ts-2', price: '105000', size: '0.6', timestamp: 2000 }), null, { cycleId: null });

        const preview2 = ledger2.previewRecalculateCycles();
        const real2 = ledger2.recalculateCycles();
        assert.equal(preview2.cyclesCompleted, 0, 'not completed at 0.7 threshold in preview');
        assert.equal(real2.cyclesCompleted, 0, 'not completed at 0.7 threshold in apply');
        assert.equal(preview2.cycleDetails.length, 0);
        assert.equal(real2.cycleDetails.length, 0);
      } finally {
        setCycleCompleteSellRatioForTest(originalRatio);
      }
    });

    it('supports instance-scoped cycleCompleteSellRatio in opts', () => {
      const { createFillLedger } = freshFillLedgerModule();
      const ledger = createFillLedger('inst-thresh', 'BTC-USDC', 'BTC-USDC', { cycleCompleteSellRatio: 0.7 });
      ledger.ingestFill(makeBuyFill({ tradeId: 'it-b1', orderId: 'itb-1', price: '100000', size: '1.0', timestamp: 1000 }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'it-s1', orderId: 'its-1', price: '105000', size: '0.6', timestamp: 2000 }), null, { cycleId: null });

      const preview = ledger.previewRecalculateCycles();
      const real = ledger.recalculateCycles();
      assert.equal(preview.cyclesCompleted, 0);
      assert.equal(real.cyclesCompleted, 0);
    });

    it('asserts 0.5 appears exactly once as named constant in src/fill-ledger.js', () => {
      const src = fs.readFileSync(path.join(__dirname, '../src/fill-ledger.js'), 'utf8');
      const matches = src.match(/0\.5/g) || [];
      assert.equal(matches.length, 1, `expected 0.5 to appear exactly once, but found ${matches.length} occurrences`);
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

  // =======================================================================
  // getCurrentCycleAllBuysCount — celestial-mode cycleBuys survival (#210-A)
  // =======================================================================
  describe('getCurrentCycleAllBuysCount (issue #210-A)', () => {
    it('counts body-owned buys that getCurrentCycleBuysCount excludes', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      // Two body-owned buys (celestial mode) + one plain core buy, all this cycle.
      // Body ownership is stamped via annotateFillsByOrderId post-ingest, exactly
      // as the engine does when it commits a buy to a body.
      ledger.ingestFill(makeBuyFill({ tradeId: 'b1', orderId: 'body-buy-1' }));
      ledger.annotateFillsByOrderId('body-buy-1', { isBodyOwned: true, bodyId: 'body-A' });
      ledger.ingestFill(makeBuyFill({ tradeId: 'b2', orderId: 'body-buy-2' }));
      ledger.annotateFillsByOrderId('body-buy-2', { isBodyOwned: true, bodyId: 'body-A' });
      ledger.ingestFill(makeBuyFill({ tradeId: 'b3', orderId: 'core-buy-1' }));

      // The body-excluding count (used by the non-celestial core path) drops the
      // two body-owned buys — the exact bug that zeroed cycleBuys on restart.
      assert.equal(ledger.getCurrentCycleBuysCount(), 1, 'body-excluding count sees only the core buy');
      // The all-buys count matches the live commitBuyCounter (one per unique buy order).
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 3, 'all-buys count survives celestial mode');
    });

    it('dedupes partial fills of the same buy order', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'p1', orderId: 'body-buy-1', size: '0.0005' }));
      ledger.ingestFill(makeBuyFill({ tradeId: 'p2', orderId: 'body-buy-1', size: '0.0005' }));
      ledger.annotateFillsByOrderId('body-buy-1', { isBodyOwned: true, bodyId: 'b' });
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 1, 'two partials of one order count once');
    });

    it('excludes buys from prior cycles', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'old', orderId: 'body-buy-old' }));
      ledger.annotateFillsByOrderId('body-buy-old', { isBodyOwned: true, bodyId: 'b' });
      ledger.startNewCycle(); // cycle rolls over (matches resetCycle)
      ledger.ingestFill(makeBuyFill({ tradeId: 'new', orderId: 'body-buy-new' }));
      ledger.annotateFillsByOrderId('body-buy-new', { isBodyOwned: true, bodyId: 'b' });
      assert.equal(ledger.getCurrentCycleAllBuysCount(), 1, 'only current-cycle buys count');
    });
  });

  // =======================================================================
  // claimCapitalCredit — capital-growth idempotency (#210-B)
  // =======================================================================
  describe('claimCapitalCredit (issue #210-B)', () => {
    it('allows the first credit and refuses a replay of the same sell order', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A' }));

      assert.equal(ledger.claimCapitalCredit('sell-A'), true, 'first credit is allowed');
      assert.equal(ledger.claimCapitalCredit('sell-A'), false, 'a crash-replay of the same sell is refused');
    });

    it('stamps every fill row of the sell order so the marker survives a reload', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.0005' }));
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.0005' }));
      ledger.claimCapitalCredit('sell-A');

      const rows = ledger.getFillsForOrder('sell-A');
      assert.equal(rows.length, 2);
      assert.ok(rows.every(r => r.capitalCredited === true), 'all partial rows marked credited');

      // A fresh ledger loading the persisted file must still refuse the replay.
      const reloaded = createTestLedger();
      assert.equal(reloaded.claimCapitalCredit('sell-A'), false, 'persisted marker survives reload');
    });

    it('treats distinct sell orders independently', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A' }));
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-B' }));
      assert.equal(ledger.claimCapitalCredit('sell-A'), true);
      assert.equal(ledger.claimCapitalCredit('sell-B'), true, 'a different sell is credited independently');
      assert.equal(ledger.claimCapitalCredit('sell-A'), false);
    });

    it('credits a second booking of the same sell for a larger booked size, never a replay (issue #777)', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.002' }));
      assert.equal(ledger.claimCapitalCredit('sell-A', 0.002), true, 'first tranche credited');
      assert.equal(ledger.claimCapitalCredit('sell-A', 0.002), false, 'a replay of the same booking is refused');
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.001' }));
      assert.equal(ledger.claimCapitalCredit('sell-A', 0.003), true, 'execution beyond the first booking is credited');
      assert.equal(ledger.claimCapitalCredit('sell-A', 0.003), false);
      assert.equal(ledger.claimCapitalCredit('sell-A'), false, 'an unsized claim refuses any prior credit');
      assert.ok(ledger.getFillsForOrder('sell-A').every(r => r.capitalCreditedSize === 0.003));
      assert.equal(createTestLedger().claimCapitalCredit('sell-A', 0.003), false, 'the sized marker survives a reload');
    });

    it('treats a credit recorded before sizes existed as covering the whole order', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.002' }));
      assert.equal(ledger.claimCapitalCredit('sell-A'), true);
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.001' }));
      assert.equal(ledger.claimCapitalCredit('sell-A', 0.003), false, 'conservative: never a double credit');
    });
  });

  // =======================================================================
  // commitSellBooking — a second booking of one sell order adds up (#777)
  // =======================================================================
  describe('commitSellBooking (issue #777)', () => {
    const tranche1 = {
      isBodyOwned: true, bodyId: 'b1', bodyTier: 'ASTEROID', bodyCostBasis: 100, bodyAvgPrice: 50000,
      bodyBtcQty: 0.002, bodyHoldbackAsset: 0, bodyPnl: 0.98, partialFill: true,
    };

    it('a first booking replaces and records the commit marker once per order', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.001' }));
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.001' }));
      assert.equal(ledger.getSellBooking('sell-A'), null, 'nothing committed yet');
      assert.equal(ledger.commitSellBooking('sell-A', tranche1, { soldSize: 0.002 }), 0.002);
      const booking = ledger.getSellBooking('sell-A');
      assert.equal(booking.bodyPnl, 0.98, 'read once per order, never summed across rows');
      assert.equal(booking.bookedSize, 0.002);
      assert.equal(booking.hasMarker, true);
    });

    it('a second booking adds P&L, cost, quantity, holdback and reserves sold, and clears partialFill on close', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.002' }));
      ledger.commitSellBooking('sell-A', tranche1, { soldSize: 0.002 });
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.009' }));
      const total = ledger.commitSellBooking('sell-A', {
        isBodyOwned: true, bodyId: 'b1', bodyTier: 'ASTEROID', bodyCostBasis: 400, bodyAvgPrice: 50000,
        bodyBtcQty: 0.008, bodyHoldbackAsset: 0.0001, bodyReservesSoldAsset: 0.0011, bodyPnl: 3.5,
      }, { additive: true, soldSize: 0.009 });
      assert.equal(total, 0.011);
      const rows = ledger.getFillsForOrder('sell-A');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.ok(Math.abs(row.bodyPnl - 4.48) < 1e-9);
        assert.equal(row.bodyCostBasis, 500);
        assert.equal(row.bodyBtcQty, 0.01);
        assert.equal(row.bodyHoldbackAsset, 0.0001);
        assert.equal(row.bodyReservesSoldAsset, 0.0011);
        assert.equal(row.bodyBookedSize, 0.011);
        assert.equal(row.partialFill, undefined, 'the closing booking clears the partial flag');
      }
      assert.ok(Math.abs(ledger.getDerivedRealizedPnL().realizedPnL - 4.48) < 1e-9, 'realizedPnL counts both tranches once');
    });

    it('without additive (a replay re-aggregating every row) it replaces', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.002' }));
      ledger.commitSellBooking('sell-A', tranche1, { soldSize: 0.002 });
      ledger.commitSellBooking('sell-A', tranche1, { soldSize: 0.002 });
      const booking = ledger.getSellBooking('sell-A');
      assert.equal(booking.bodyPnl, 0.98);
      assert.equal(booking.bookedSize, 0.002);
    });

    it('adds onto a booking committed before the marker existed, sized by its annotated rows', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', size: '0.002' }));
      ledger.annotateFillsByOrderId('sell-A', tranche1);
      const legacy = ledger.getSellBooking('sell-A');
      assert.equal(legacy.hasMarker, false);
      assert.equal(legacy.bookedSize, 0.002);
      ledger.ingestFill(makeSellFill({ tradeId: 's2', orderId: 'sell-A', size: '0.001' }));
      ledger.commitSellBooking('sell-A', { ...tranche1, bodyPnl: 0.48, bodyCostBasis: 50, bodyBtcQty: 0.001 }, { additive: true, soldSize: 0.001 });
      const booking = ledger.getSellBooking('sell-A');
      assert.ok(Math.abs(booking.bodyPnl - 1.46) < 1e-9);
      assert.equal(booking.bookedSize, 0.003);
    });
  });

  // =======================================================================
  // ingestFill fee mapping — synthetic-fill fee retention (#210-C)
  // =======================================================================
  describe('ingestFill honors explicit/synthetic fees (issue #210-C)', () => {
    it('persists netFee from a synthetic fill built off order status', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      // Shape produced by the Coinbase eventual-consistency synthetic-fill fallback.
      const result = ledger.ingestFill({
        tradeId: 'synthetic-sell-A',
        orderId: 'sell-A',
        side: 'sell',
        price: 105000,
        size: 0.001,
        quoteAmount: 105,
        totalFees: 1.20,
        netFee: 1.20,
      });
      assert.equal(result.fill.netFee, 1.20, 'synthetic netFee must be persisted (not defaulted to 0)');
      assert.equal(result.fill.fee, 1.20, 'gross fee resolves from totalFees too');
    });

    it('still derives netFee from totalCommission minus rebate for normal fills', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      const result = ledger.ingestFill(makeSellFill({ tradeId: 's1', orderId: 'sell-A', totalCommission: '0.50', rebate: '0.10' }));
      assert.equal(result.fill.fee, 0.5);
      assert.equal(result.fill.netFee, 0.4, 'netFee = gross − rebate when no explicit netFee given');
    });

    it('maps a plain fee field when neither totalCommission nor totalFees is present', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      const result = ledger.ingestFill({ tradeId: 'x', orderId: 'o', side: 'buy', price: 100, size: 1, fee: 0.25 });
      assert.equal(result.fill.fee, 0.25);
      assert.equal(result.fill.netFee, 0.25);
    });
  });

  // =======================================================================
  // Derived-P&L / fill-time-stats memoization (issue #365). getState() calls
  // getDerivedRealizedPnL() and getFillTimeStats(7) on every ~1s status tick;
  // between fills the ledger is immutable, so these must be served from
  // cache. `_test.getRealizedRecomputeCount()` / `getFillTimeStatsRecomputeCount()`
  // count only actual (non-cached) recomputations, letting these tests prove
  // "served from cache" deterministically instead of via wall-clock timing.
  // =======================================================================
  describe('derived realized P&L caching (issue #365)', () => {
    it('serves consecutive calls from cache with an identical result', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'c-b1', orderId: 'c-buy-1' }));

      const first = ledger.getDerivedRealizedPnL();
      const second = ledger.getDerivedRealizedPnL();
      const third = ledger.getDerivedRealizedPnL();

      assert.deepStrictEqual(second, first, 'cached result must equal the freshly-computed result');
      assert.deepStrictEqual(third, first, 'cached result must equal the freshly-computed result');
      assert.equal(ledger._test.getRealizedRecomputeCount(), 1,
        'repeat calls on an unmodified ledger must not trigger a recomputation');
    });

    it('invalidates and recomputes when a fill is ingested', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'inv-b1', orderId: 'inv-buy-1', price: '100000', size: '0.001' }));

      const before = ledger.getDerivedRealizedPnL();
      ledger.getDerivedRealizedPnL();
      assert.equal(ledger._test.getRealizedRecomputeCount(), 1, 'repeat call must hit cache');

      ledger.ingestFill(makeBuyFill({ tradeId: 'inv-b2', orderId: 'inv-buy-2', price: '100000', size: '0.001' }));
      const after = ledger.getDerivedRealizedPnL();

      assert.equal(ledger._test.getRealizedRecomputeCount(), 2, 'ingestFill must invalidate the cache');
      assert.notStrictEqual(after.heldOpenBuyCostBasis, before.heldOpenBuyCostBasis,
        'the new buy must be reflected once the cache is invalidated');
    });

    it('invalidates and recomputes when annotateFillsByOrderId writes a bodyPnl annotation', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'ann-b1', orderId: 'ann-buy-1', price: '100000', size: '0.001' }));
      ledger.annotateFillsByOrderId('ann-buy-1', { sellOrderId: 'ann-tp-1' });
      ledger.ingestFill(makeSellFill({ tradeId: 'ann-s1', orderId: 'ann-tp-1', price: '105000', size: '0.001' }));

      const before = ledger.getDerivedRealizedPnL();
      ledger.getDerivedRealizedPnL();
      const countAfterCacheHit = ledger._test.getRealizedRecomputeCount();

      ledger.annotateFillsByOrderId('ann-tp-1', { bodyPnl: 3.33, bodyHoldbackAsset: 0, isBodyOwned: true });
      const after = ledger.getDerivedRealizedPnL();

      assert.equal(ledger._test.getRealizedRecomputeCount(), countAfterCacheHit + 1,
        'annotateFillsByOrderId must invalidate the cache');
      assert.equal(after.realizedPnL, 3.33, 'bodyPnl annotation must be picked up after invalidation');
      assert.notStrictEqual(after.realizedPnL, before.realizedPnL);
    });

    it('invalidates and recomputes when an externally-mutated fill is flushed via markDirty', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'md-b1', orderId: 'md-buy-1', price: '100000', size: '0.001' }));
      ledger.annotateFillsByOrderId('md-buy-1', { sellOrderId: 'md-tp-1' });
      ledger.ingestFill(makeSellFill({ tradeId: 'md-s1', orderId: 'md-tp-1', price: '105000', size: '0.001' }));

      const before = ledger.getDerivedRealizedPnL();
      const countBefore = ledger._test.getRealizedRecomputeCount();

      // Contract documented on markDirty(): callers may mutate a fill object
      // returned by getFillsForOrder/getAllFills directly, then call
      // markDirty() to flag the change — this must invalidate the cache too,
      // since bodyPnl feeds computeRealizedFromCyclePairs.
      const [sellFill] = ledger.getFillsForOrder('md-tp-1');
      sellFill.bodyPnl = 9.99;
      ledger.markDirty();

      const after = ledger.getDerivedRealizedPnL();

      assert.equal(ledger._test.getRealizedRecomputeCount(), countBefore + 1,
        'markDirty must invalidate the cache');
      assert.equal(after.realizedPnL, 9.99);
      assert.notStrictEqual(after.realizedPnL, before.realizedPnL);
    });

    it('invalidates and recomputes on recalculateCycles and updateFillCycleId', () => {
      const ledger = createTestLedger();
      // Orphan fills (no cycleId) so recalculateCycles has real cycle-index
      // work to do rather than short-circuiting as a no-op.
      ledger.ingestFill(makeBuyFill({ tradeId: 'rc-b1', orderId: 'rc-buy-1' }), null, { cycleId: null });
      ledger.ingestFill(makeSellFill({ tradeId: 'rc-s1', orderId: 'rc-sell-1', size: '0.001' }), null, { cycleId: null });

      ledger.getDerivedRealizedPnL();
      const countAfterFirst = ledger._test.getRealizedRecomputeCount();
      ledger.getDerivedRealizedPnL();
      assert.equal(ledger._test.getRealizedRecomputeCount(), countAfterFirst, 'unmodified ledger must stay cached');

      ledger.recalculateCycles();
      ledger.getDerivedRealizedPnL();
      assert.equal(ledger._test.getRealizedRecomputeCount(), countAfterFirst + 1,
        'recalculateCycles must invalidate the cache');

      const countAfterRecalc = ledger._test.getRealizedRecomputeCount();
      ledger.updateFillCycleId('rc-b1', 'cycle-99');
      ledger.getDerivedRealizedPnL();
      assert.equal(ledger._test.getRealizedRecomputeCount(), countAfterRecalc + 1,
        'updateFillCycleId must invalidate the cache');
    });

    it('invalidates and recomputes when load() picks up an externally-written fill', () => {
      const exchange = 'test-exchange-365-load';
      const pair = 'BTC-USD';
      const { createFillLedger } = freshFillLedgerModule();
      const ledger = createFillLedger(exchange, pair, pair);
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'load-b1', orderId: 'load-buy-1', price: '100000', size: '0.001' }));

      const first = ledger.getDerivedRealizedPnL();
      ledger.getDerivedRealizedPnL();
      assert.equal(ledger._test.getRealizedRecomputeCount(), 1, 'repeat call must hit cache');

      // Simulate an operator edit / another process appending a fill to the
      // on-disk ledger, then a live SIGUSR1-style reload.
      const filePath = path.join(migration.resolveFundDataDir(exchange, pair), 'fill-ledger.json');
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      onDisk.push({
        tradeId: 'load-b2',
        orderId: 'load-buy-2',
        side: 'buy',
        size: 0.001,
        price: 100000,
        quoteAmount: 100,
        netFee: 0.1,
        timestamp: Date.now(),
      });
      fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2));

      ledger.load();
      const second = ledger.getDerivedRealizedPnL();

      assert.equal(ledger._test.getRealizedRecomputeCount(), 2, 'load() must invalidate the cache');
      assert.equal(second.heldOpenBuyCostBasis, first.heldOpenBuyCostBasis + 100.10,
        'reload must reflect the externally-added fill, not the stale cached value');
    });
  });

  describe('fill-time-stats caching (issue #365)', () => {
    it('serves consecutive calls from cache and invalidates on ingestFill', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      const now = Date.now();
      ledger.ingestFill(makeBuyFill({ tradeId: 'ft-b1', orderId: 'ft-buy-1' }), now - 5000);

      const first = ledger.getFillTimeStats(7);
      ledger.getFillTimeStats(7);
      assert.deepStrictEqual(ledger.getFillTimeStats(7), first);
      assert.equal(ledger._test.getFillTimeStatsRecomputeCount(), 1,
        'repeat calls within the same time bucket must not recompute');
      assert.equal(first.count, 1);

      ledger.ingestFill(makeBuyFill({ tradeId: 'ft-b2', orderId: 'ft-buy-2' }), now - 10000);
      const second = ledger.getFillTimeStats(7);

      assert.equal(ledger._test.getFillTimeStatsRecomputeCount(), 2,
        'ingestFill must invalidate the fill-time-stats cache');
      assert.equal(second.count, 2);
    });

    it('keys the cache by sinceDays so different windows do not collide', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      ledger.ingestFill(makeBuyFill({ tradeId: 'ft-b3', orderId: 'ft-buy-3' }), Date.now() - 1000);

      const stats7 = ledger.getFillTimeStats(7);
      const stats1 = ledger.getFillTimeStats(1);

      assert.equal(stats7.count, 1);
      assert.equal(stats1.count, 1);
    });
  });

  describe('memoization performance (issue #365)', () => {
    it('serves 100 consecutive calls from cache without a single extra recomputation', () => {
      const ledger = createTestLedger();
      ledger.startNewCycle();
      const n = 500;
      for (let i = 0; i < n; i++) {
        const buyOrderId = `perf-buy-${i}`;
        const sellOrderId = `perf-sell-${i}`;
        ledger.ingestFill(
          makeBuyFill({ tradeId: `perf-b-${i}`, orderId: buyOrderId, price: '100000', size: '0.001' }),
          Date.now() - 5000,
          { skipPersist: true },
        );
        ledger.annotateFillsByOrderId(buyOrderId, { sellOrderId });
        ledger.ingestFill(
          makeSellFill({ tradeId: `perf-s-${i}`, orderId: sellOrderId, price: '105000', size: '0.001' }),
          null,
          { skipPersist: true },
        );
        ledger.annotateFillsByOrderId(sellOrderId, { bodyPnl: 1, bodyHoldbackAsset: 0, isBodyOwned: true });
      }

      // Warm both caches once.
      const baselineRealized = ledger.getDerivedRealizedPnL();
      const baselineFillTime = ledger.getFillTimeStats(7);
      const realizedCountBefore = ledger._test.getRealizedRecomputeCount();
      const fillTimeCountBefore = ledger._test.getFillTimeStatsRecomputeCount();

      const start = process.hrtime.bigint();
      for (let i = 0; i < 100; i++) {
        const derived = ledger.getDerivedRealizedPnL();
        assert.deepStrictEqual(derived, baselineRealized);
        const fillTime = ledger.getFillTimeStats(7);
        assert.deepStrictEqual(fillTime, baselineFillTime);
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      assert.equal(ledger._test.getRealizedRecomputeCount(), realizedCountBefore,
        '100 cached getDerivedRealizedPnL calls must not trigger any recomputation');
      assert.equal(ledger._test.getFillTimeStatsRecomputeCount(), fillTimeCountBefore,
        '100 cached getFillTimeStats calls must not trigger any recomputation');
      // Generous, CI-safe bound: cached reads over 1000 fills should be far
      // below the ~2.7ms/call uncached cost measured against 25,440
      // production fills (issue #365 audit), even on a slow/shared runner.
      assert.ok(elapsedMs < 100, `expected 100 cached calls to complete quickly, took ${elapsedMs}ms`);
    });
  });
});
