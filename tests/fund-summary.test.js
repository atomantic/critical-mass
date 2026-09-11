// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFundSummary } = require('../src/fund-summary');

// Mock fill ledger for testing
class MockFillLedger {
  constructor(fills = []) {
    this.fills = fills;
  }

  getAllFills() {
    return this.fills;
  }

  getDerivedRealizedPnL() {
    return {
      realizedPnL: 0,
      realizedAssetPnL: 0,
      unpairedSellQty: 0,
      heldOpenBuyCostBasis: 0,
    };
  }
}

// Helper to create test fills
function makeFill(overrides = {}) {
  return {
    side: 'buy',
    quoteAmount: 100,
    size: 0.001,
    netFee: 0.1,
    ...overrides,
  };
}

describe('fund-summary: buildFundSummary', () => {
  describe('initialization and basic structure', () => {
    it('returns a complete response object with all required fields', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = {
        position: {
          depositedCapital: 500,
          assetOnOrder: 0.005,
          cyclesCompleted: 10,
          celestialBodies: [],
          pendingEntryOrders: [],
        },
      };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert(summary.exchange === 'coinbase');
      assert(summary.config === mockConfig);
      assert(summary.state);
      assert(summary.stats);
      assert(summary.costBasis);
      assert(summary.nextTrade);
      assert(Array.isArray(summary.transactions));
    });
  });

  describe('fill aggregation', () => {
    it('counts and sums buy fills correctly', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001, netFee: 0.1 }),
        makeFill({ side: 'buy', quoteAmount: 200, size: 0.002, netFee: 0.2 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.totalBuys, 2);
      assert.equal(summary.stats.totalBought, 300);
      assert.equal(summary.stats.totalBTCBought, 0.003);
      // Floating point: 0.1 + 0.2 can be 0.30000000000000004, so use approximate check
      assert(Math.abs(summary.stats.totalFees - 0.3) < 0.0001);
    });

    it('counts and sums sell fills correctly', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'sell', quoteAmount: 150, size: 0.0015, netFee: 0.15 }),
        makeFill({ side: 'sell', quoteAmount: 250, size: 0.0025, netFee: 0.25 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.totalSells, 2);
      assert.equal(summary.stats.totalSold, 400);
      assert.equal(summary.stats.totalBTCSold, 0.004);
    });

    it('handles mixed buy and sell fills', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001, netFee: 0.1 }),
        makeFill({ side: 'sell', quoteAmount: 200, size: 0.002, netFee: 0.2 }),
        makeFill({ side: 'buy', quoteAmount: 150, size: 0.0015, netFee: 0.15 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.totalBuys, 2);
      assert.equal(summary.stats.totalSells, 1);
      assert.equal(summary.stats.totalBought, 250);
      assert.equal(summary.stats.totalSold, 200);
    });
  });

  describe('cost basis calculation', () => {
    it('calculates average cost per asset from total bought and total asset bought', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001 }),
        makeFill({ side: 'buy', quoteAmount: 200, size: 0.002 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.costBasis.totalCostBasis, 300);
      assert.equal(summary.costBasis.totalAssetBought, 0.003);
      assert.equal(summary.costBasis.avgCostPerAsset, 100000); // 300 / 0.003
    });

    it('handles zero asset bought case with zero division guard', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 0, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.costBasis.avgCostPerAsset, 0);
    });

    it('includes pending cost basis from celestial bodies', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = {
        position: {
          depositedCapital: 500,
          celestialBodies: [
            { costBasis: 150, assetQty: 0.0015, tpPrice: 50000 },
            { costBasis: 200, assetQty: 0.002, tpPrice: 50000 },
          ],
          pendingEntryOrders: [],
        },
      };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.costBasis.pendingCostBasis, 350);
      assert.equal(summary.costBasis.pendingAsset, 0.0035);
      assert.equal(summary.costBasis.pendingAvgCost, 100000);
    });
  });

  describe('state mapping', () => {
    it('maps regime position onto legacy state shape', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = {
        position: {
          depositedCapital: 500,
          assetOnOrder: 0.005,
          cyclesCompleted: 10,
          celestialBodies: [
            { assetQty: 0.001, tpPrice: 40000 },
            { assetQty: 0.002, tpPrice: 40000 },
          ],
          pendingEntryOrders: [{ id: '1' }, { id: '2' }],
        },
      };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.state.usdcFundSize, 500);
      assert.equal(summary.state.totalAllocated, 500);
      assert.equal(summary.state.outstandingOrdersAsset, 0.005);
      // outstandingOrdersUSDC = (0.001 + 0.002) * 40000 = 0.003 * 40000 = 120
      assert.equal(summary.state.outstandingOrdersUSDC, 120);
      assert.equal(summary.stats.pendingOrders, 2);
      assert.equal(summary.state.totalIntervalsRun, 10);
    });

    it('handles missing position data gracefully', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = {};
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.state.usdcFundSize, 0);
      assert.equal(summary.state.assetReserves, 0);
      assert.equal(summary.state.outstandingOrdersAsset, 0);
    });
  });

  describe('realized P&L integration', () => {
    it('includes realized P&L from fillLedger.getDerivedRealizedPnL', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };

      const customLedger = new MockFillLedger([]);
      customLedger.getDerivedRealizedPnL = () => ({
        realizedPnL: 250,
        realizedAssetPnL: 0.005,
        unpairedSellQty: 0,
      });

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: customLedger,
      });

      assert.equal(summary.stats.realizedProfit, 250);
      assert.equal(summary.costBasis.reservesAsset, 0.005);
    });

    it('includes unpaired sell quantity for diagnostics', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };

      const customLedger = new MockFillLedger([]);
      customLedger.getDerivedRealizedPnL = () => ({
        realizedPnL: 0,
        realizedAssetPnL: 0,
        unpairedSellQty: 0.001,
      });

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: customLedger,
      });

      assert.equal(summary.stats.unpairedSellQty, 0.001);
    });
  });

  describe('backwards compatibility', () => {
    it('includes all legacy fields expected by Dashboard consumers', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000, intervalsToSpread: 10, daysToSpread: 50 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      // Dashboard destructures: { config, state, stats, costBasis, nextTrade }
      assert(summary.config);
      assert(summary.state);
      assert(summary.stats);
      assert(summary.costBasis);
      assert(summary.nextTrade);

      // Fields accessed by Dashboard
      assert(typeof summary.state.usdcFundSize === 'number');
      assert(typeof summary.state.assetReserves === 'number');
      assert(typeof summary.state.outstandingOrdersAsset === 'number');
      assert(typeof summary.state.outstandingOrdersUSDC === 'number');
      assert(typeof summary.stats.realizedProfit === 'number');
      assert(typeof summary.stats.allocationRemaining === 'number');
      assert(typeof summary.stats.intervalsRun === 'number');
      assert(typeof summary.costBasis.pendingCostBasis === 'number');
      assert(typeof summary.costBasis.reservesCostBasis === 'number');
    });

    it('maintains state and stats field parity', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([
        makeFill({ side: 'buy', quoteAmount: 100, size: 0.001, netFee: 0.5 }),
      ]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      // state and stats should have duplicate fields that stay in sync
      assert.equal(summary.state.usdcFundSize, summary.stats.usdcFundSize);
      assert.equal(summary.state.assetReserves, summary.stats.assetReserves);
      assert.equal(summary.state.outstandingOrdersUSDC, summary.stats.outstandingOrdersUSDC);
      assert.equal(summary.state.outstandingOrdersAsset, summary.stats.outstandingOrdersAsset);
      assert.equal(summary.state.totalFees, summary.stats.totalFees);
    });
  });

  describe('edge cases', () => {
    it('handles empty fill ledger', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 0, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.totalBuys, 0);
      assert.equal(summary.stats.totalSells, 0);
      assert.equal(summary.stats.totalBought, 0);
      assert.equal(summary.stats.totalSold, 0);
      assert.equal(summary.stats.totalFees, 0);
      assert.equal(summary.costBasis.totalCostBasis, 0);
    });

    it('calculates allocation remaining correctly', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.allocationUsed, 500);
      assert.equal(summary.stats.allocationRemaining, 500); // 1000 - 500
    });

    it('uses deposited capital as allocation used when totalAllocation is missing', () => {
      const mockConfig = { productId: 'BTC-USD' }; // No totalAllocation
      const mockRegimeState = { position: { depositedCapital: 300, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.stats.allocationUsed, 300);
      assert.equal(summary.stats.allocationRemaining, 0);
    });

    it('reserves cost basis calculation with zero reserves asset', () => {
      const mockConfig = { productId: 'BTC-USD', totalAllocation: 1000 };
      const mockRegimeState = { position: { depositedCapital: 500, celestialBodies: [], pendingEntryOrders: [] } };
      const mockLedger = new MockFillLedger([]);

      const summary = buildFundSummary('coinbase', 'BTC-USD', {
        config: mockConfig,
        regimeState: mockRegimeState,
        fillLedger: mockLedger,
      });

      assert.equal(summary.costBasis.reservesAsset, 0);
      assert.equal(summary.costBasis.reservesCostBasis, 0);
      assert.equal(summary.costBasis.reservesAvgCost, 0);
    });
  });
});
