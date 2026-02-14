// @ts-check
/**
 * DCA-to-Regime Engine Converter
 *
 * Converts DCA order history into regime fill-ledger entries,
 * preserves existing sell orders as celestial bodies, and
 * prepares the regime engine state for a seamless start.
 */

const fs = require('fs');
const path = require('path');
const { loadState, saveState, saveRegimeState } = require('./state-tracker');
const { createFillLedger } = require('./fill-ledger');
const { createNewBody, classifyTier } = require('./celestial-hierarchy');
const { setExchangeEnabled, getRegimeConfig, getExchangeConfig } = require('./config-utils');
const { getExchangeDataDir } = require('./migration');

/**
 * Categorize DCA orders into pending (open sells), filled (completed), and consolidated
 * @param {import('./types').TrackedOrder[]} orders
 * @returns {{ pending: import('./types').TrackedOrder[], filled: import('./types').TrackedOrder[], skipped: number }}
 */
const categorizeOrders = (orders) => {
  const pending = [];
  const filled = [];
  let skipped = 0;

  for (const order of orders) {
    // Skip source orders that were consumed by consolidation
    if (order.consolidatedInto) {
      skipped++;
      continue;
    }

    if (order.status === 'pending') {
      pending.push(order);
    } else if (order.status === 'filled') {
      filled.push(order);
    }
  }

  return { pending, filled, skipped };
};

/**
 * Preview DCA-to-Regime conversion without making changes
 * @param {string} exchange
 * @returns {{ pending: number, filled: number, skipped: number, totalBaseQty: number, totalCostBasis: number, pendingBaseQty: number, pendingCostBasis: number, sellOrderIds: string[], productId: string, assetReserves: number }}
 */
const previewConversion = (exchange) => {
  const state = loadState(null, exchange);
  const exchangeConfig = getExchangeConfig(exchange);
  const orders = state.orders || [];
  const { pending, filled, skipped } = categorizeOrders(orders);

  const totalBaseQty = filled.reduce((sum, o) => sum + (o.buyQuantity || 0), 0);
  const totalCostBasis = filled.reduce((sum, o) => sum + (o.buyCostBasis || o.buyUSDC || 0), 0);
  const pendingBaseQty = pending.reduce((sum, o) => sum + (o.buyQuantity || 0), 0);
  const pendingCostBasis = pending.reduce((sum, o) => sum + (o.buyCostBasis || o.buyUSDC || 0), 0);

  return {
    pending: pending.length,
    filled: filled.length,
    skipped,
    totalBaseQty,
    totalCostBasis,
    pendingBaseQty,
    pendingCostBasis,
    sellOrderIds: pending.map(o => o.orderId),
    totalAllocated: state.totalAllocated || 0,
    assetReserves: state.assetReserves || 0,
    productId: exchangeConfig.productId,
  };
};

/**
 * Execute DCA-to-Regime conversion
 * @param {string} exchange
 * @returns {{ success: boolean, backupDir: string, summary: Object }}
 */
const executeConversion = (exchange) => {
  const dataDir = getExchangeDataDir(exchange);
  const timestamp = Date.now();
  const backupSuffix = `.backup-dca-convert-${timestamp}`;

  // 1. Backup existing state files
  const filesToBackup = ['state.json', 'fill-ledger.json', 'regime-state.json'];
  const backedUp = [];
  for (const file of filesToBackup) {
    const src = path.join(dataDir, file);
    if (fs.existsSync(src)) {
      const dest = path.join(dataDir, file + backupSuffix);
      fs.copyFileSync(src, dest);
      backedUp.push(file);
    }
  }
  console.log(`💾 [${exchange}] DCA conversion backup: ${backedUp.join(', ')} → ${backupSuffix}`);

  // 2. Disable DCA engine
  setExchangeEnabled(exchange, false);
  console.log(`⏹️ [${exchange}] DCA engine disabled`);

  // 3. Load DCA state and categorize orders
  const state = loadState(null, exchange);
  const orders = state.orders || [];
  const { pending, filled } = categorizeOrders(orders);

  // 4. Create fill ledger and ingest synthetic fills
  const fillLedger = createFillLedger(exchange);

  // Ingest filled (completed) DCA orders as completed cycles
  let filledIngested = 0;
  for (const order of filled) {
    fillLedger.startNewCycle();

    // Synthetic buy fill
    const buyTradeId = `dca-convert-buy-${order.buyOrderId}`;
    const buyResult = fillLedger.ingestFill({
      tradeId: buyTradeId,
      orderId: order.buyOrderId,
      side: 'buy',
      price: order.buyPrice,
      size: order.buyQuantity,
      totalCommission: order.buyFees || 0,
      rebate: order.buyRebates || 0,
      liquidityIndicator: 'TAKER',
      tradeTime: order.createdAt,
    });

    // Synthetic sell fill
    const sellTradeId = `dca-convert-sell-${order.orderId}`;
    fillLedger.ingestFill({
      tradeId: sellTradeId,
      orderId: order.orderId,
      side: 'sell',
      price: order.sellPrice,
      size: order.sellQuantity,
      totalCommission: order.sellFees || 0,
      rebate: order.sellRebates || 0,
      liquidityIndicator: 'MAKER',
      tradeTime: order.filledAt || order.createdAt,
    });

    if (buyResult.ingested) filledIngested++;
  }

  // Start active cycle for pending orders
  fillLedger.startNewCycle();

  let pendingIngested = 0;
  for (const order of pending) {
    // Synthetic buy fill for the open position
    const buyTradeId = `dca-convert-buy-${order.buyOrderId}`;
    const buyResult = fillLedger.ingestFill({
      tradeId: buyTradeId,
      orderId: order.buyOrderId,
      side: 'buy',
      price: order.buyPrice,
      size: order.buyQuantity,
      totalCommission: order.buyFees || 0,
      rebate: order.buyRebates || 0,
      liquidityIndicator: 'TAKER',
      tradeTime: order.createdAt,
    });

    // Link the buy fill to its existing sell order on exchange
    if (buyResult.ingested && buyResult.fill) {
      buyResult.fill.sellOrderId = order.orderId;
    }

    if (buyResult.ingested) pendingIngested++;
  }

  fillLedger.persist();
  console.log(`📝 [${exchange}] Fill ledger: ${filledIngested} filled + ${pendingIngested} pending orders ingested`);

  // 5. Build regime state
  const recalcResult = fillLedger.recalculateCycles();
  const currentCycleFills = fillLedger.getCurrentCycleFills();
  const currentPosition = fillLedger.rebuildPositionFromFills(currentCycleFills);
  fillLedger.persist();

  // Create celestial bodies from pending DCA orders
  const regimeConfig = getRegimeConfig(exchange);
  const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 500;
  const celestialBodies = [];

  for (const order of pending) {
    const costBasis = order.buyCostBasis || (order.buyUSDC + (order.buyFees || 0));
    const body = createNewBody({
      totalSize: order.buyQuantity,
      totalValue: order.buyUSDC,
      totalFees: order.buyFees || 0,
      avgPrice: order.buyPrice,
    }, order.buyOrderId);

    // Link to existing sell order on exchange
    body.tpOrderId = order.orderId;
    body.tpPrice = order.sellPrice;
    body.assetOnOrder = order.sellQuantity || order.buyQuantity;
    body.createdAt = Date.parse(order.createdAt) || Date.now();

    // Classify tier based on cost basis
    const tier = classifyTier(costBasis, maxUsdcDeployed);
    body.tier = tier.name;

    celestialBodies.push(body);
  }

  // Find earliest order for engine start time
  const allOrders = [...filled, ...pending];
  const earliestTime = allOrders.reduce((min, o) => {
    const t = Date.parse(o.createdAt);
    return t && t < min ? t : min;
  }, Date.now());

  const position = {
    ...currentPosition,
    cyclesCompleted: recalcResult.cyclesCompleted,
    realizedPnL: recalcResult.globalRealizedPnL || 0,
    realizedAssetPnL: (recalcResult.globalRealizedAssetPnL || 0) + (state.assetReserves || 0),
    celestialBodies,
    celestialState: {
      totalBodiesCreated: celestialBodies.length,
      totalBodiesSold: 0,
      bodiesRealizedPnL: 0,
      bodiesRealizedAssetPnL: 0,
    },
    engineStartTime: earliestTime,
    depositedCapital: state.totalAllocated || 0,
  };

  const regime = {
    currentRegime: 'unknown',
    regimeStartTime: Date.now(),
    volatilityHistory: [],
    entryThreshold: null,
    lastVolatilityCheck: null,
  };

  saveRegimeState(position, regime, exchange);
  console.log(`🚀 [${exchange}] Regime state created: ${celestialBodies.length} celestial bodies, ${recalcResult.cyclesCompleted} completed cycles`);

  // 6. Mark converted orders in DCA state so dashboard no longer shows them
  const dcaState = loadState(null, exchange);
  const convertedOrderIds = new Set([
    ...pending.map(o => o.orderId),
    ...filled.map(o => o.orderId),
  ]);
  let migratedCount = 0;
  for (const order of dcaState.orders || []) {
    if (convertedOrderIds.has(order.orderId) || order.consolidatedInto) {
      order.status = 'migrated_to_regime';
      migratedCount++;
    }
  }
  saveState(dcaState, exchange);
  console.log(`🧹 [${exchange}] DCA state cleanup: ${migratedCount} orders marked as migrated_to_regime`);

  return {
    success: true,
    backupDir: backupSuffix,
    backedUpFiles: backedUp,
    summary: {
      filledOrders: filledIngested,
      pendingOrders: pendingIngested,
      celestialBodies: celestialBodies.length,
      cyclesCompleted: recalcResult.cyclesCompleted,
      realizedPnL: position.realizedPnL,
      realizedAssetPnL: position.realizedAssetPnL,
      depositedCapital: position.depositedCapital,
      engineStartTime: earliestTime,
    },
  };
};

module.exports = {
  previewConversion,
  executeConversion,
};
