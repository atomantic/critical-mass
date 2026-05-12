// @ts-check
/**
 * APY Calculator
 *
 * Pure calculation module for APY metrics and tracking initialization.
 * Extracted from regime-engine.js for modularity.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');

/**
 * Calculate APY and return metrics.
 *
 * Glossary (capital fields are unfortunately overloaded — fixing names
 * elsewhere is a bigger refactor, so each is documented here):
 *   - depositedCapital: USD the user actually moved into the bot. The
 *     denominator for ALL return percentages — this is your principal.
 *   - maxUsdcDeployed: budget cap the bot can deploy at any time. May exceed
 *     depositedCapital if the user has authorized leveraging realized profits.
 *   - initialCapital, originalCapital, currentCapital: legacy aliases kept
 *     for compatibility; do not use for new computations.
 *
 * Return decomposition:
 *   - realizedReturn (USD): position.realizedPnL — proceeds − cost on sells
 *     already executed. Locked in.
 *   - unrealizedReturn (USD): held BTC × current price − cost basis of held
 *     BTC. Moves with the market; not yet locked in.
 *   - totalReturn = realizedReturn + unrealizedReturn — the user's true
 *     economic gain over the principal.
 *
 * Old totalLiquidValue (= realizedPnL + reserves_value_at_current_price)
 * double-counted reserves: it treated the full market value of held BTC as
 * "return" instead of subtracting the cost the bot paid for that BTC.
 *
 * APY math: time-weighted compounding. Given a total return r over t years,
 * APY = (1 + r)^(1/t) − 1. The old form (1 + r/t/365)^365 conflated
 * "extrapolate daily return" with "compound it daily" — and could only be
 * tamed by a 10%/day clamp and a 99,999% APY ceiling.
 *
 * @param {Object} positionState - Current position state
 * @param {Object} config - Regime config
 * @param {Object} marketState - Current market state
 * @returns {Object} APY metrics
 */
const calculateApyMetrics = (positionState, config, marketState) => {
  const now = Date.now();
  const startTime = positionState.engineStartTime;
  const maxUsdcDeployed = config.maxUsdcDeployed || 10000;
  const realizedReturn = positionState.realizedPnL || 0;

  const autoDerivedCapital = Math.max(0, roundUSDC(maxUsdcDeployed - realizedReturn));
  const depositedCapital = config.depositedCapital > 0
    ? config.depositedCapital
    : (positionState.depositedCapital > 0
        ? positionState.depositedCapital
        : (positionState.originalCapital > 0
            ? positionState.originalCapital
            : autoDerivedCapital));

  const initialCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;

  // Cost basis of currently-held position (bodies + reserves).
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

  // Asset breakdown: position split into "active in bodies" vs "reserves".
  const reservesQty = positionState.realizedAssetPnL || 0;
  const bodyQty = (positionState.celestialBodies || []).reduce((s, b) => s + (b.assetQty || 0), 0);
  const totalHeldQty = reservesQty + bodyQty;
  const assetValueUsd = reservesQty * currentPrice;  // legacy field — "what reserves are worth now"
  const heldAssetMarketValue = totalHeldQty * currentPrice;

  // Cost basis of held BTC: bodies' tracked cost + reserves' approximate cost.
  // Reserves cost is derived from running avg of all buys so far (not exact
  // FIFO — that would require returning per-lot cost from getDerivedRealizedPnL,
  // which we can add later if needed for sub-1% accuracy).
  const heldAssetCostBasis = positionState.heldAssetCostBasis ?? bodyCost; // body cost is the conservative known piece
  const unrealizedReturn = heldAssetMarketValue - heldAssetCostBasis;

  // Total economic return over principal: realized + unrealized.
  const totalReturn = realizedReturn + unrealizedReturn;
  // Legacy "totalLiquidValue" — kept for compatibility with consumers that
  // expect realized USD + market value of reserves. Marked deprecated.
  const totalLiquidValue = realizedReturn + assetValueUsd;

  const denom = depositedCapital || initialCapital || 1;

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
    realizedReturn: 0, realizedReturnPercent: 0,
    unrealizedReturn: 0, unrealizedReturnPercent: 0,
    totalReturn: 0, totalReturnPercent: 0,
    dailyReturnPercent: 0, estimatedAnnualReturn: 0, estimatedApy: 0,
    cyclesPerDay: 0, avgPnlPerCycle: 0,
    isApyClamped: false,
  };

  if (!startTime || (realizedReturn === 0 && reservesQty === 0 && bodyQty === 0)) {
    return zeroMetrics;
  }

  const elapsedMs = now - startTime;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

  const realizedReturnPercent = (realizedReturn / denom) * 100;
  const unrealizedReturnPercent = (unrealizedReturn / denom) * 100;
  const totalReturnPercent = (totalReturn / denom) * 100;
  const totalLiquidValuePercent = (totalLiquidValue / denom) * 100;
  const totalUsdcReturnPercent = realizedReturnPercent; // legacy alias

  const minHoursForProjection = 1;
  const hasEnoughData = elapsedMs >= minHoursForProjection * 60 * 60 * 1000;

  // Time-weighted APY: if return r over y years, APY = (1+r)^(1/y) − 1.
  // Uses totalReturnPercent (realized + unrealized) as the basis since that's
  // the economically meaningful return rate.
  let estimatedApy = 0;
  let isApyClamped = false;
  if (hasEnoughData && elapsedDays > 0) {
    const yearsFraction = elapsedDays / 365;
    const totalReturnFraction = totalReturnPercent / 100;
    // Loss case: -100% return floors at -100% APY (can't lose more than principal).
    if (totalReturnFraction <= -1) {
      estimatedApy = -100;
    } else {
      const rawApy = (Math.pow(1 + totalReturnFraction, 1 / yearsFraction) - 1) * 100;
      isApyClamped = rawApy > 99999;
      estimatedApy = Math.min(Math.max(rawApy, -100), 99999);
    }
  }

  // Linear daily/annual extrapolation — useful as a "current run rate" but
  // doesn't compound. Always shown alongside estimatedApy for context.
  const dailyReturnPercent = hasEnoughData && elapsedDays > 0
    ? totalReturnPercent / elapsedDays
    : 0;
  const estimatedAnnualReturn = hasEnoughData ? dailyReturnPercent * 365 : 0;

  const cyclesPerDay = hasEnoughData && elapsedDays > 0
    ? positionState.cyclesCompleted / elapsedDays
    : 0;

  const avgPnlPerCycle = positionState.cyclesCompleted > 0
    ? realizedReturn / positionState.cyclesCompleted
    : 0;

  const estimatedDailyUsdc = hasEnoughData && elapsedDays > 0 ? realizedReturn / elapsedDays : 0;
  const estimatedDailyAsset = hasEnoughData && elapsedDays > 0 ? reservesQty / elapsedDays : 0;
  const estimatedDailyLiquid = hasEnoughData && elapsedDays > 0 ? totalReturn / elapsedDays : 0;

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
    // Realized: locked-in USD profit (FIFO over the ledger).
    realizedReturn: roundUSDC(realizedReturn),
    realizedReturnPercent: roundUSDC(realizedReturnPercent * 100) / 100,
    // Unrealized: market value − cost basis of currently-held BTC.
    unrealizedReturn: roundUSDC(unrealizedReturn),
    unrealizedReturnPercent: roundUSDC(unrealizedReturnPercent * 100) / 100,
    // Total economic return: realized + unrealized.
    totalReturn: roundUSDC(totalReturn),
    totalReturnPercent: roundUSDC(totalReturnPercent * 100) / 100,
    // Legacy aliases (do not use for new code — see top-of-file comment).
    totalUsdcReturn: roundUSDC(realizedReturn),
    totalUsdcReturnPercent: roundUSDC(realizedReturnPercent * 100) / 100,
    totalAssetReturn: roundAsset(reservesQty),
    assetValueUsd: roundUSDC(assetValueUsd),
    totalLiquidValue: roundUSDC(totalLiquidValue),
    totalLiquidValuePercent: roundUSDC(totalLiquidValuePercent * 100) / 100,
    estimatedDailyUsdc: roundUSDC(estimatedDailyUsdc),
    estimatedDailyAsset: roundAsset(estimatedDailyAsset),
    estimatedDailyLiquid: roundUSDC(estimatedDailyLiquid),
    dailyReturnPercent: roundUSDC(dailyReturnPercent * 100) / 100,
    estimatedAnnualReturn: roundUSDC(estimatedAnnualReturn * 100) / 100,
    estimatedApy: roundUSDC(estimatedApy * 100) / 100,
    isApyClamped,
    cyclesPerDay: roundUSDC(cyclesPerDay * 100) / 100,
    avgPnlPerCycle: roundUSDC(avgPnlPerCycle),
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
