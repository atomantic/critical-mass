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
const { loadState, saveState, loadRegimeState, saveRegimeState } = require('./state-tracker');
const { createFillLedger } = require('./fill-ledger');
const { createNewBody, classifyTier, syncPositionState } = require('./celestial-hierarchy');
const { setExchangeEnabled, getRegimeConfig, getExchangeConfig } = require('./config-utils');
const { getExchangeDataDir } = require('./migration');
const { log } = require('./logger');

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

  // Check if existing regime state has celestial bodies (merge mode)
  const existingRegime = loadRegimeState(exchange);
  const existingBodies = existingRegime?.position?.celestialBodies?.length || 0;
  const existingAsset = existingRegime?.position?.totalAsset || 0;
  const existingCostBasis = existingRegime?.position?.totalCostBasis || 0;

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
    merge: existingBodies > 0,
    existingBodies,
    existingAsset,
    existingCostBasis,
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
  log('INFO', `💾 [${exchange}] DCA conversion backup: ${backedUp.join(', ')} → ${backupSuffix}`);

  // 2. Disable DCA engine
  setExchangeEnabled(exchange, false);
  log('INFO', `⏹️ [${exchange}] DCA engine disabled`);

  // 3. Load DCA state and categorize orders
  const state = loadState(null, exchange);
  const orders = state.orders || [];
  const { pending, filled } = categorizeOrders(orders);

  // 4. Create fill ledger and ingest synthetic fills.
  // Re-enable the DCA engine on createFillLedger failure (cold-start
  // throw against a corrupt fill-ledger.json) so a partial migration
  // doesn't leave the exchange permanently disabled. The operator can
  // repair the file and re-run the conversion.
  let fillLedger;
  try {
    fillLedger = createFillLedger(exchange);
  } catch (err) {
    setExchangeEnabled(exchange, true);
    log('ERROR', `❌ [${exchange}] Fill ledger init failed during conversion: ${err.message} — DCA engine re-enabled, conversion aborted`);
    // Throw a sanitized message: the IPC handler at coinbase-engine.js:
    // regime:convert-dca surfaces this back to the client. Keeping the
    // absolute ledger path / parser internals out of the API surface
    // mirrors the regime:start sanitization. Full detail stays in the
    // ERROR log above for the operator to investigate.
    throw new Error(`Fill ledger init failed for ${exchange} during DCA conversion — see engine logs for details`);
  }

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

    // Link the buy fill to its existing sell order on exchange.
    // markDirty after direct field mutation: ingestFill auto-persisted
    // and cleared the dirty flag, so the trailing persist() below would
    // otherwise no-op and lose this sellOrderId on restart.
    if (buyResult.ingested && buyResult.fill) {
      buyResult.fill.sellOrderId = order.orderId;
      fillLedger.markDirty();
    }

    if (buyResult.ingested) pendingIngested++;
  }

  fillLedger.persist();
  log('INFO', `📝 [${exchange}] Fill ledger: ${filledIngested} filled + ${pendingIngested} pending orders ingested`);

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

    // Don't copy DCA sell order ID — regime engine will re-place TPs with proper pricing.
    // Old DCA order IDs may not be valid for exchange lookup (e.g. crypto.com returns 40003).
    // NOTE: Old DCA sell orders may still be active on the exchange and should be cancelled
    // manually before starting the regime engine to avoid duplicate sells.
    body.tpOrderId = null;
    body.tpPrice = order.sellPrice;
    body.assetOnOrder = 0; // No tracked sell order — regime engine will place new TPs
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
  log('INFO', `🚀 [${exchange}] Regime state created: ${celestialBodies.length} celestial bodies, ${recalcResult.cyclesCompleted} completed cycles`);

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
  log('INFO', `🧹 [${exchange}] DCA state cleanup: ${migratedCount} orders marked as migrated_to_regime`);

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

/**
 * Merge DCA positions into an existing regime state (non-destructive)
 * Unlike executeConversion, this preserves existing celestial bodies, regime state, and optimizers.
 * @param {string} exchange
 * @returns {{ success: boolean, backupDir: string, summary: Object }}
 */
const mergeToRegime = (exchange) => {
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
  log('INFO', `💾 [${exchange}] DCA merge backup: ${backedUp.join(', ')} → ${backupSuffix}`);

  // 2. Load existing regime state and DCA state
  const existingState = loadRegimeState(exchange);
  const position = existingState.position;
  const state = loadState(null, exchange);
  const orders = state.orders || [];
  const { pending, filled } = categorizeOrders(orders);

  // 3. Load existing fill ledger and ingest fills.
  // Wrap createFillLedger so a cold-start corrupt ledger throw is rewritten
  // with merge-specific context. mergeToRegime doesn't disable the engine
  // (unlike executeConversion), so there's no rollback to do — but the
  // surfaced error needs to reach the IPC handler so it can return a
  // structured {success:false} response instead of leaking the raw
  // filesystem-level message.
  let fillLedger;
  try {
    fillLedger = createFillLedger(exchange);
  } catch (err) {
    log('ERROR', `❌ [${exchange}] Fill ledger init failed during DCA merge: ${err.message}`);
    // Sanitized message — see executeConversion's catch above for rationale.
    throw new Error(`Fill ledger init failed for ${exchange} during DCA merge — see engine logs for details`);
  }

  // Ingest filled (completed) DCA orders as completed cycle fills
  let filledIngested = 0;
  for (const order of filled) {
    fillLedger.startNewCycle();

    const buyTradeId = `dca-convert-buy-${order.buyOrderId}`;
    fillLedger.ingestFill({
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

    filledIngested++;
  }

  // Ingest pending order buy fills into the current active cycle
  let pendingIngested = 0;
  for (const order of pending) {
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

    // Mark as body-owned so these fills don't conflict with core position tracking.
    // markDirty: ingestFill auto-persisted and cleared the dirty flag,
    // so the trailing persist() below would otherwise no-op and lose
    // this isBodyOwned flag on restart.
    if (buyResult.ingested && buyResult.fill) {
      buyResult.fill.isBodyOwned = true;
      fillLedger.markDirty();
    }

    if (buyResult.ingested) pendingIngested++;
  }

  fillLedger.persist();
  log('INFO', `📝 [${exchange}] Fill ledger merge: ${filledIngested} filled + ${pendingIngested} pending orders ingested`);

  // 4. Create celestial bodies from pending DCA orders
  const regimeConfig = getRegimeConfig(exchange);
  const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || 500;
  const newBodies = [];

  for (const order of pending) {
    const costBasis = order.buyCostBasis || (order.buyUSDC + (order.buyFees || 0));
    const body = createNewBody({
      totalSize: order.buyQuantity,
      totalValue: order.buyUSDC,
      totalFees: order.buyFees || 0,
      avgPrice: order.buyPrice,
    }, order.buyOrderId);

    // Sell orders were canceled — regime engine will place new ones on start
    body.tpOrderId = null;
    body.tpPrice = 0;
    body.assetOnOrder = 0;
    body.createdAt = Date.parse(order.createdAt) || Date.now();

    const tier = classifyTier(costBasis, maxUsdcDeployed);
    body.tier = tier.name;

    newBodies.push(body);
  }

  // 4b. Annotate buy fills with bodyId now that bodies exist
  for (let i = 0; i < pending.length; i++) {
    const order = pending[i];
    const body = newBodies[i];
    if (body) {
      fillLedger.annotateFillsByOrderId(order.buyOrderId, {
        isBodyOwned: true,
        bodyId: body.id,
        bodyTier: body.tier,
      });
    }
  }
  fillLedger.persist();

  // 5. Append new bodies to existing position
  position.celestialBodies = [...(position.celestialBodies || []), ...newBodies];

  // 6. Update aggregates from all bodies
  syncPositionState(position, position.celestialBodies);

  // 7. Update celestialState counters
  const cs = position.celestialState || { bodiesCompleted: 0, bodiesRealizedPnL: 0, bodiesRealizedAssetPnL: 0, stateVersion: 1 };
  cs.totalBodiesCreated = (cs.totalBodiesCreated || 0) + newBodies.length;
  position.celestialState = cs;

  // 8. Add DCA assetReserves to position.realizedAssetPnL
  position.realizedAssetPnL = (position.realizedAssetPnL || 0) + (state.assetReserves || 0);

  // 9. Add DCA totalAllocated to position.depositedCapital
  position.depositedCapital = (position.depositedCapital || 0) + (state.totalAllocated || 0);

  // 10. Save regime state (preserving existing regime, tpOptimizer, sizeOptimizer)
  saveRegimeState(position, existingState.regime, exchange, existingState.tpOptimizer, existingState.sizeOptimizer);
  log('INFO', `🔗 [${exchange}] Regime state merged: +${newBodies.length} celestial bodies (total: ${position.celestialBodies.length})`);

  // 11. Mark converted orders in DCA state
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
  log('INFO', `🧹 [${exchange}] DCA state cleanup: ${migratedCount} orders marked as migrated_to_regime`);

  return {
    success: true,
    backupDir: backupSuffix,
    backedUpFiles: backedUp,
    summary: {
      filledOrders: filledIngested,
      pendingOrders: pendingIngested,
      celestialBodies: newBodies.length,
      totalBodies: position.celestialBodies.length,
      totalAsset: position.totalAsset,
      totalCostBasis: position.totalCostBasis,
      realizedAssetPnL: position.realizedAssetPnL,
      depositedCapital: position.depositedCapital,
    },
  };
};

module.exports = {
  previewConversion,
  executeConversion,
  mergeToRegime,
};
