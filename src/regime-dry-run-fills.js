/**
 * Dry-run fill handlers for the regime engine.
 *
 * Extracted verbatim from regime-engine.js (issue #1327). These are the
 * `onBuyFill` / `onSellFill` callbacks consumed by dry-run-executor.js; they
 * mirror the live body buy/merge and body-TP-fill/cycle-close flow against
 * simulated fills. No accounting changes — code move only.
 *
 * `positionState`, `orderExecutor` and `priceIncrement` are reassigned inside
 * the engine closure, so they are passed as getter functions and read fresh on
 * every call (snapshotted at handler entry; the engine only reassigns them on
 * start/reset paths, not mid-fill).
 */

const createDryRunFillHandlers = ({
  exchange, pair, baseCurrency, config, celestialHierarchy, tradeEvents, logger,
  getPositionState, getOrderExecutor, getPriceIncrement,
  placeBodyTp, resetCycle, recordCycleForOptimizer, recordCycleForSizeOptimizer,
  saveDryRunState, resaveAfterSizeOptimizerDryRun, updateRegimeConfig,
  roundPrice, roundAsset, roundUSDC, fmtPrice, calculateDynamicTpPercent,
}) => {
  const onBuyFill = async (orderId, assetQty, price, costBasis) => {
    const positionState = getPositionState();
    const orderExecutor = getOrderExecutor();
    const priceIncrement = getPriceIncrement();
    const newBuy = { assetQty, costBasis, avgPrice: price, buyOrderId: orderId };
    const candidateTpPrice = roundPrice(price * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

    const bodies = positionState.celestialBodies || [];
    let mergeTarget = celestialHierarchy.findMergeTarget(
      bodies, newBuy, {
        maxUsdcDeployed: config.maxUsdcDeployed,
        candidateTpPrice,
        maxBodies: config.maxCelestialBodies || 10,
        pendingOrderCount: orderExecutor.getPendingCounts().total,
        maxOpenOrders: config.maxOpenOrders,
        proximityScale: config.mergeProximityScale ?? 1.0
      }
    );

    positionState.cycleBuys += 1;
    positionState.lastEntryPrice = price;
    positionState.lastEntryTime = Date.now();

    if (positionState.pendingLadderOrders?.length > 0) {
      positionState.pendingLadderOrders = positionState.pendingLadderOrders.filter(o => o.orderId !== orderId);
      if (positionState.pendingLadderOrders.length === 0) {
        positionState.ladderActive = false;
      }
    }

    if (mergeTarget) {
      const cancelResult = await orderExecutor.cancelBodyTpOrder(mergeTarget.id, mergeTarget.tpOrderId);
      if (!cancelResult.cancelled) {
        logger.warn(`⚠️ [${exchange}] [DRY-RUN] Body ${mergeTarget.id.slice(-8)} TP ${cancelResult.filled ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
        mergeTarget = null;
      } else {
        // Clear body TP fields so placeBodyTp can re-place after merge
        mergeTarget.tpOrderId = null;
        mergeTarget.tpPrice = 0;
        mergeTarget.assetOnOrder = 0;
      }
    }

    if (mergeTarget) {
      const merged = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed, undefined, logger);
      const idx = positionState.celestialBodies.findIndex(b => b.id === merged.id);
      if (idx !== -1) positionState.celestialBodies[idx] = merged;

      celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      await placeBodyTp(merged);

      tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [merged→${merged.tier}]`, {
        assetAmount: assetQty, price, bodyId: merged.id, bodyTier: merged.tier, isMerge: true, isDryRun: true,
      });
    } else {
      const body = celestialHierarchy.createNewBody(newBuy, orderId);
      positionState.celestialBodies = positionState.celestialBodies || [];
      positionState.celestialBodies.push(body);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      await placeBodyTp(body);

      tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [new ${body.tier}]`, {
        assetAmount: assetQty, price, bodyId: body.id, bodyTier: body.tier, isDryRun: true,
      });
    }

    saveDryRunState();
  };

  const onSellFill = async (orderId, assetQty, price, proceeds, pnl) => {
    const positionState = getPositionState();
    const orderExecutor = getOrderExecutor();
    // Find matching celestial body by TP order ID
    const bodies = positionState.celestialBodies || [];
    const bodyIdx = bodies.findIndex(b => b.tpOrderId === orderId);

    if (bodyIdx !== -1) {
      // CELESTIAL BODY TP FILL in dry-run
      const body = bodies[bodyIdx];
      const tierCfg = celestialHierarchy.getTierConfig(body.tier);
      const holdbackAsset = roundAsset(body.assetQty - assetQty);

      const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
      cs.bodiesCompleted += 1;
      positionState.celestialState = cs;

      const prevMaxUsdc = config.maxUsdcDeployed;
      config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
      updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

      positionState.celestialBodies.splice(bodyIdx, 1);
      orderExecutor.removeBodyTracking(orderId);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

      logger.info(`${tierCfg.emoji} [${exchange}] [DRY-RUN] Body TP filled (${body.tier}): ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc.toFixed(2)}→$${config.maxUsdcDeployed.toFixed(2)}`);

      tradeEvents.emitTradeEvent('body_tp_filled', exchange, `[DRY-RUN] ${tierCfg.emoji} ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
        assetAmount: assetQty, price, pnl, holdbackAsset,
        bodyId: body.id, bodyTier: body.tier, isDryRun: true,
      });

      // If no bodies remain, full cycle reset
      if (positionState.celestialBodies.length === 0) {
        positionState.cyclesCompleted += 1;
        const actualTpPct = body.avgPrice > 0 ? ((price - body.avgPrice) / body.avgPrice) * 100 : 0;

        const optimalAnalytics = orderExecutor.getOptimalTpAnalytics();
        const lastCycle = optimalAnalytics?.cycles?.[optimalAnalytics.cycles.length - 1];
        const optimalTpPct = lastCycle?.optimalTpPct || actualTpPct;

        recordCycleForOptimizer({ optimalTpPct, actualTpPct });
        // Capture before resetCycle() zeroes cycleBuys; run the optimizer's
        // real-balance fetch (issue #694) AFTER resetCycle() flips the
        // cycle boundary — see the live-mode call site's comment for why.
        const cycleBuysAtClose = positionState.cycleBuys;
        // try/finally: see the live-mode call site's comment — a
        // resetCycle() failure must not permanently drop this cycle from
        // the optimizer's stats on retry.
        // Deliberately NOT awaited — the optimizer's balance fetch must not
        // delay saveDryRunState() below. Once it DOES resolve, re-save
        // so the recorded sample/balance isn't left only in memory until
        // some unrelated future save picks it up.
        try {
          await resetCycle();
        } finally {
          recordCycleForSizeOptimizer({
            stepsUsed: cycleBuysAtClose,
            capitalDeployed: body.costBasis,
          }).catch(() => {}).finally(resaveAfterSizeOptimizerDryRun);
        }
      }
    } else {
      // Fallback: untracked sell (legacy core TP or unknown)
      const holdbackAsset = roundAsset(positionState.totalAsset - assetQty);
      positionState.assetOnOrder = 0;
      positionState.cyclesCompleted += 1;

      const prevMaxUsdc = config.maxUsdcDeployed;
      config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
      updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

      logger.info(`💰 [${exchange}] [DRY-RUN] Capital growth: $${prevMaxUsdc.toFixed(2)} → $${config.maxUsdcDeployed.toFixed(2)} (+$${pnl.toFixed(2)})`);

      tradeEvents.emitTradeEvent('tp_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
        assetAmount: assetQty, price, pnl, holdbackAsset, isDryRun: true,
      });

      const actualTpPct = positionState.avgCostBasis > 0
        ? ((price - positionState.avgCostBasis) / positionState.avgCostBasis) * 100 : 0;
      recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
      // Capture before resetCycle() zeroes cycleBuys/totalCostBasis; run the
      // optimizer's real-balance fetch (issue #694) AFTER resetCycle() flips
      // the cycle boundary — see the live-mode call site's comment for why.
      const cycleBuysAtClose = positionState.cycleBuys;
      const totalCostBasisAtClose = positionState.totalCostBasis;
      // try/finally: see the live-mode call site's comment — a resetCycle()
      // failure must not permanently drop this cycle from the optimizer's
      // stats on retry.
      // Deliberately NOT awaited — the optimizer's balance fetch cannot
      // delay saveDryRunState() below. Once it resolves, re-save so the
      // recorded sample/balance isn't left only in memory until some
      // unrelated future save picks it up.
      try {
        await resetCycle();
      } finally {
        recordCycleForSizeOptimizer({
          stepsUsed: cycleBuysAtClose,
          capitalDeployed: totalCostBasisAtClose,
        }).catch(() => {}).finally(resaveAfterSizeOptimizerDryRun);
      }
    }

    saveDryRunState();
  };

  return { onBuyFill, onSellFill };
};

module.exports = { createDryRunFillHandlers };
