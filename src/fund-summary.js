// @ts-check
/**
 * Fund Summary Aggregation & Cost Basis Calculation
 * Pure domain function for building fund-level financial summaries
 * from regime state and fill ledger data.
 */

const { getFundConfig } = require('./config-utils');
const { loadRegimeState } = require('./state-tracker');
const { getCachedFillLedger } = require('./fill-ledger');

/**
 * Build a complete fund summary with financial metrics, cost basis, and state.
 * Pure function: deterministic given the same inputs (state, fills, config).
 *
 * @param {string} exchange - Exchange name (e.g., 'coinbase')
 * @param {string} pair - Fund pair (e.g., 'BTC-USD')
 * @param {{
 *   config?: Object,
 *   regimeState?: Object,
 *   fillLedger?: Object
 * }} [opts] - Optional dependencies (if provided, will be used instead of loading)
 * @returns {{
 *   exchange: string,
 *   config: Object,
 *   state: Object,
 *   stats: Object,
 *   costBasis: Object,
 *   nextTrade: Object,
 *   transactions: Array
 * }} Complete fund summary matching the API contract
 */
function buildFundSummary(exchange, pair, opts = {}) {
  // Load dependencies if not provided
  const config = opts.config || getFundConfig(exchange, pair);
  const regimeState = opts.regimeState || loadRegimeState(exchange, pair);
  const fillLedger = opts.fillLedger || getCachedFillLedger(exchange, config.productId, pair);

  const position = regimeState.position || {};
  const allFills = fillLedger.getAllFills();

  // Partition and aggregate fills by side
  const buyFills = allFills.filter(f => f.side === 'buy');
  const sellFills = allFills.filter(f => f.side === 'sell');
  const totalBought = buyFills.reduce((s, f) => s + (f.quoteAmount || 0), 0);
  const totalSold = sellFills.reduce((s, f) => s + (f.quoteAmount || 0), 0);
  const totalAssetBought = buyFills.reduce((s, f) => s + (f.size || 0), 0);
  const totalAssetSold = sellFills.reduce((s, f) => s + (f.size || 0), 0);
  const totalFees = allFills.reduce((s, f) => s + (f.netFee || 0), 0);

  // Derive realized P&L from fill ledger cycle-pair accounting
  const derived = fillLedger.getDerivedRealizedPnL();

  // Cost basis breakdown derived from regime bodies
  // (pending = on TP orders; reserves = accumulated holdback not currently in a body)
  const bodies = position.celestialBodies || [];
  const pendingCostBasis = bodies.reduce((s, b) => s + (b.costBasis || 0), 0);
  const pendingAsset = bodies.reduce((s, b) => s + (b.assetQty || 0), 0);
  const totalCostBasis = totalBought; // gross capital ever deployed on buys
  const avgCostPerAsset = totalAssetBought > 0 ? totalCostBasis / totalAssetBought : 0;

  // Reserves are zero-cost in the cycle-pair model (their cost was attributed
  // to the paired sell), but the dashboard's "reserves cost basis" panel
  // expects an avg-cost figure for display only. Use running avg.
  const reservesAsset = derived.realizedAssetPnL;
  const reservesCostBasis = reservesAsset * avgCostPerAsset;

  // Map regime shape onto the legacy `state` shape Dashboard.jsx expects
  const state = {
    usdcFundSize: position.depositedCapital || 0,
    assetReserves: reservesAsset,
    outstandingOrdersUSDC: bodies.reduce((s, b) => s + (b.assetQty || 0) * (b.tpPrice || 0), 0),
    outstandingOrdersAsset: position.assetOnOrder || 0,
    totalAllocated: position.depositedCapital || 0,
    totalFees,
    totalRebates: 0,
    netFees: totalFees,
    totalIntervalsRun: position.cyclesCompleted || 0,
    orders: [], // legacy DCA-style orders; regime engine doesn't use this shape
  };

  return {
    exchange,
    config,
    state,
    stats: {
      totalBuys: buyFills.length,
      totalSells: sellFills.length,
      pendingOrders: (position.pendingEntryOrders || []).length,
      totalBought,
      totalSold,
      totalBTCBought: totalAssetBought,
      totalBTCSold: totalAssetSold,
      totalFees,
      totalRebates: 0,
      netFees: totalFees,
      assetReserves: state.assetReserves,
      usdcFundSize: state.usdcFundSize,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      outstandingOrdersAsset: state.outstandingOrdersAsset,
      allocationUsed: state.totalAllocated,
      allocationRemaining: (config.totalAllocation || state.totalAllocated || 0) - state.totalAllocated,
      intervalsRun: state.totalIntervalsRun,
      realizedProfit: derived.realizedPnL,
      // Diagnostic: sells with no paired buys (e.g. manual sells, recovery
      // sells with no linkage). Their proceeds are not counted in realizedPnL.
      unpairedSellQty: derived.unpairedSellQty || 0,
    },
    costBasis: {
      totalCostBasis,
      totalAssetBought,
      avgCostPerAsset,
      reservesAsset,
      reservesCostBasis,
      reservesAvgCost: reservesAsset > 0 ? reservesCostBasis / reservesAsset : 0,
      pendingAsset,
      pendingCostBasis,
      pendingAvgCost: pendingAsset > 0 ? pendingCostBasis / pendingAsset : 0,
      orderBreakdown: [],
    },
    nextTrade: { nextRunTime: null, intervalsRemaining: 0, allocationRemaining: 0 },
    transactions: [], // legacy DCA transaction log no longer maintained
  };
}

module.exports = {
  buildFundSummary,
};
