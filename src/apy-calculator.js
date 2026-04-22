// @ts-check
/**
 * APY Calculator
 *
 * Pure calculation module for APY metrics and tracking initialization.
 * Extracted from regime-engine.js for modularity.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');

/**
 * Calculate APY and return metrics
 * Uses total liquid value (USDC + BTC at current price) for APY calculations
 * @param {Object} positionState - Current position state
 * @param {Object} config - Regime config
 * @param {Object} marketState - Current market state
 * @returns {Object} APY metrics
 */
const calculateApyMetrics = (positionState, config, marketState) => {
  const now = Date.now();
  const startTime = positionState.engineStartTime;
  const maxUsdcDeployed = config.maxUsdcDeployed || 10000;
  const totalUsdcReturn = positionState.realizedPnL || 0;

  const autoDerivedCapital = Math.max(0, roundUSDC(maxUsdcDeployed - totalUsdcReturn));
  const depositedCapital = config.depositedCapital > 0
    ? config.depositedCapital
    : (positionState.depositedCapital > 0
        ? positionState.depositedCapital
        : (positionState.originalCapital > 0
            ? positionState.originalCapital
            : autoDerivedCapital));

  const initialCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;

  // Derive deployed capital from source data (totalCostBasis can be stale/out-of-sync)
  const bodyCost = (positionState.celestialBodies || [])
    .reduce((sum, b) => sum + (b.costBasis || 0), 0);
  const pendingEntryCost = (positionState.pendingEntryOrders || [])
    .reduce((sum, o) => sum + (o.sizeUsdc || 0), 0);
  const pendingLadderCost = (positionState.pendingLadderOrders || [])
    .reduce((sum, o) => sum + (o.sizeUsdc || 0), 0);
  const additionalCycleCost = Math.max(0, (positionState.totalCostBasis || 0) - bodyCost);
  const deployedInPosition = bodyCost + pendingEntryCost + pendingLadderCost + additionalCycleCost;
  const availableCapital = Math.max(0, maxUsdcDeployed - deployedInPosition);
  const currentPrice = marketState.lastPrice || 0;

  // Legacy aliases
  const currentCapital = maxUsdcDeployed;
  const deployedCapital = deployedInPosition;
  const originalCapital = depositedCapital;

  // Asset (e.g. BTC, ETH) value in USD terms
  const totalAssetReturn = positionState.realizedAssetPnL || 0;
  const assetValueUsd = totalAssetReturn * currentPrice;
  const totalLiquidValue = totalUsdcReturn + assetValueUsd;

  // Zero return template
  const zeroMetrics = {
    engineStartTime: startTime,
    depositedCapital, maxUsdcDeployed, deployedInPosition, availableCapital,
    originalCapital, initialCapital, currentCapital, deployedCapital,
    elapsedMs: startTime ? now - startTime : 0,
    elapsedDays: 0,
    totalUsdcReturn: 0, totalUsdcReturnPercent: 0, estimatedDailyUsdc: 0,
    totalAssetReturn: 0, assetValueUsd: 0, estimatedDailyAsset: 0,
    totalLiquidValue: 0, totalLiquidValuePercent: 0,
    dailyReturnPercent: 0, estimatedAnnualReturn: 0, estimatedApy: 0,
    cyclesPerDay: 0, avgPnlPerCycle: 0,
    totalReturn: 0, totalReturnPercent: 0,
    isApyClamped: false,
  };

  if (!startTime || (totalUsdcReturn === 0 && totalAssetReturn === 0)) {
    return zeroMetrics;
  }

  const elapsedMs = now - startTime;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

  const totalUsdcReturnPercent = (totalUsdcReturn / initialCapital) * 100;
  const totalLiquidValuePercent = (totalLiquidValue / initialCapital) * 100;

  const minHoursForProjection = 1;
  const hasEnoughData = elapsedMs >= minHoursForProjection * 60 * 60 * 1000;

  const dailyReturnPercent = hasEnoughData && elapsedDays > 0
    ? totalLiquidValuePercent / elapsedDays
    : 0;

  const estimatedAnnualReturn = hasEnoughData ? dailyReturnPercent * 365 : 0;

  const rawDailyReturnDecimal = dailyReturnPercent / 100;
  const isApyClamped = rawDailyReturnDecimal > 0.1;
  const dailyReturnDecimal = Math.min(rawDailyReturnDecimal, 0.1);
  let estimatedApy = 0;
  if (hasEnoughData && elapsedDays > 0) {
    const rawApy = (Math.pow(1 + dailyReturnDecimal, 365) - 1) * 100;
    estimatedApy = Math.min(rawApy, 99999);
  }

  const cyclesPerDay = hasEnoughData && elapsedDays > 0
    ? positionState.cyclesCompleted / elapsedDays
    : 0;

  const avgPnlPerCycle = positionState.cyclesCompleted > 0
    ? totalUsdcReturn / positionState.cyclesCompleted
    : 0;

  const estimatedDailyUsdc = hasEnoughData && elapsedDays > 0 ? totalUsdcReturn / elapsedDays : 0;
  const estimatedDailyAsset = hasEnoughData && elapsedDays > 0 ? totalAssetReturn / elapsedDays : 0;
  const estimatedDailyLiquid = hasEnoughData && elapsedDays > 0 ? totalLiquidValue / elapsedDays : 0;

  return {
    engineStartTime: startTime,
    depositedCapital: roundUSDC(depositedCapital),
    maxUsdcDeployed: roundUSDC(maxUsdcDeployed),
    deployedInPosition: roundUSDC(deployedInPosition),
    availableCapital: roundUSDC(availableCapital),
    originalCapital: roundUSDC(originalCapital),
    initialCapital: roundUSDC(initialCapital),
    currentCapital: roundUSDC(currentCapital),
    deployedCapital: roundUSDC(deployedCapital),
    elapsedMs,
    elapsedDays: roundUSDC(elapsedDays * 100) / 100,
    totalUsdcReturn: roundUSDC(totalUsdcReturn),
    totalUsdcReturnPercent: roundUSDC(totalUsdcReturnPercent * 100) / 100,
    estimatedDailyUsdc: roundUSDC(estimatedDailyUsdc),
    totalAssetReturn: roundAsset(totalAssetReturn),
    assetValueUsd: roundUSDC(assetValueUsd),
    estimatedDailyAsset: roundAsset(estimatedDailyAsset),
    totalLiquidValue: roundUSDC(totalLiquidValue),
    totalLiquidValuePercent: roundUSDC(totalLiquidValuePercent * 100) / 100,
    estimatedDailyLiquid: roundUSDC(estimatedDailyLiquid),
    dailyReturnPercent: roundUSDC(dailyReturnPercent * 100) / 100,
    estimatedAnnualReturn: roundUSDC(estimatedAnnualReturn * 100) / 100,
    estimatedApy: roundUSDC(estimatedApy * 100) / 100,
    isApyClamped,
    cyclesPerDay: roundUSDC(cyclesPerDay * 100) / 100,
    avgPnlPerCycle: roundUSDC(avgPnlPerCycle),
    totalReturn: roundUSDC(totalLiquidValue),
    totalReturnPercent: roundUSDC(totalLiquidValuePercent * 100) / 100,
  };
};

/**
 * Initialize APY tracking if not already set
 * Backfills start time from existing filled orders if available
 * @param {Object} positionState - Position state (mutated in place)
 * @param {Object} config - Regime config
 * @param {string} exchange - Exchange name
 * @param {Function} [getFilledOrders] - Function to get filled orders from executor
 */
const initializeApyTracking = (positionState, config, exchange, getFilledOrders) => {
  const filledOrders = getFilledOrders ? getFilledOrders() : [];
  let earliestOrderTime = Infinity;

  if (filledOrders.length > 0) {
    earliestOrderTime = filledOrders.reduce((earliest, order) => {
      const orderTime = order.placedAt || order.filledAt;
      return orderTime < earliest ? orderTime : earliest;
    }, Infinity);
  }

  const ensureDepositedCapital = () => {
    if (!positionState.depositedCapital || positionState.depositedCapital === 0) {
      const maxUsdc = config.maxUsdcDeployed || 10000;
      const profits = positionState.realizedPnL || 0;
      positionState.depositedCapital = positionState.originalCapital > 0
        ? positionState.originalCapital
        : roundUSDC(Math.max(0, maxUsdc - profits));
    }
  };

  if (earliestOrderTime !== Infinity) {
    if (!positionState.engineStartTime || positionState.engineStartTime > earliestOrderTime) {
      positionState.engineStartTime = earliestOrderTime;
      positionState.initialCapital = config.maxUsdcDeployed || 10000;
      if (!positionState.originalCapital) {
        positionState.originalCapital = positionState.initialCapital;
      }
      ensureDepositedCapital();
      console.log(`📊 [${exchange}] APY tracking backfilled: deposited=$${Number(positionState.depositedCapital).toFixed(2)} max=$${Number(config.maxUsdcDeployed).toFixed(2)}`);
      return;
    }
    if (!positionState.originalCapital) {
      positionState.originalCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;
    }
    ensureDepositedCapital();
    console.log(`📊 [${exchange}] APY tracking restored: deposited=$${Number(positionState.depositedCapital).toFixed(2)} max=$${Number(config.maxUsdcDeployed).toFixed(2)}`);
    return;
  }

  if (positionState.engineStartTime) {
    if (!positionState.originalCapital) {
      positionState.originalCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;
    }
    ensureDepositedCapital();
    console.log(`📊 [${exchange}] APY tracking restored: deposited=$${Number(positionState.depositedCapital).toFixed(2)} max=$${Number(config.maxUsdcDeployed).toFixed(2)}`);
    return;
  }

  positionState.engineStartTime = Date.now();
  positionState.initialCapital = config.maxUsdcDeployed || 10000;
  positionState.originalCapital = positionState.initialCapital;
  positionState.depositedCapital = positionState.initialCapital;
  console.log(`📊 [${exchange}] APY tracking started fresh: deposited=$${Number(positionState.depositedCapital).toFixed(2)}`);
};

module.exports = { calculateApyMetrics, initializeApyTracking };
