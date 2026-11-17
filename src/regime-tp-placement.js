'use strict';

/**
 * Take-profit placement for one fund: the base dynamic TP percent, the
 * per-body TP (`placeBodyTp`) with its single retry, and
 * `placeTakeProfitOrder`, which places every body's missing TP and falls
 * through to the legacy single TP when the position has no bodies. Extracted
 * verbatim from regime-engine (issue #1980); the engine wires
 * `createTpPlacement({...})` and hands these functions to the fill handlers,
 * the reconcile loop, startup recovery, the operator actions and the dry-run
 * fill handlers exactly as before.
 *
 * Holdback is the design, not a partial fill: a body's TP is placed for
 * `body.assetOnOrder = body.assetQty − planned holdback`, sized by the
 * position sizer with the tier's holdback scale, and the remainder is kept as
 * asset-side profit. The percent floors (round-trip fees, one-satoshi
 * holdback), the override / manual / merge-cap precedence, the price rounding
 * and the minimum-order fallback are unchanged. Nothing here books P&L: a
 * legacy TP that fills during its own cancel-and-replace is routed through
 * the engine's `handleOrderFill`, so realized P&L still comes only from the
 * fill ledger's cycle-pair annotations (refreshRealizedFromCyclePairs).
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getAdapter`, `getOrderExecutor`,
 * `getPriceIncrement` and `getProductDetails` are accessors because the
 * engine reassigns those bindings (tests swapping the exchange deps, product
 * details loaded at start); `getMarketState` reads the engine's `let` binding
 * the same way the operator actions do. The in-flight placement guard
 * (`tpPlacementInFlight`, also read by state persistence) and the dust-wait
 * log map (`dustWaitLoggedQty`) are the engine's own, passed by reference.
 * The negative-P&L log throttle is used by nothing else, so it lives here.
 */

const celestialHierarchy = require('./celestial-hierarchy');
const { tradeEvents } = require('./trade-events');
const { DEFAULT_FEE_RATE_PER_SIDE } = require('../shared/fee-defaults.mjs');
const { fmtCurrency: fmtPrice, floorToIncrement, sleep } = require('./shared-utils');
const { clamp, roundAsset, roundPrice } = require('./volatility-utils');
const { PLACEMENT_RETRY_DELAY_MS } = require('./timing-constants');

/**
 * @param {Object} deps
 * @returns {{calculateDynamicTpPercent: () => number, placeBodyTp: Function, placeBodyTpWithRetry: Function, placeTakeProfitOrder: Function}}
 */
const createTpPlacement = ({
  exchange, baseCurrency, isDryRun, config, logger,
  positionState, fillLedger, regimeDetector, macroRegime, positionSizer,
  // Placement guard and log throttle owned by the engine
  tpPlacementInFlight, dustWaitLoggedQty,
  getAdapter, getOrderExecutor, getMarketState, getPriceIncrement, getProductDetails,
  lookupOrNull,
  // Live fill pipeline
  handleOrderFill,
  // State persistence (regime-state-persistence)
  saveLiveStateGuarded,
}) => {
  const negativePnlLoggedPrice = new WeakMap(); // body -> last rejected TP price; no persisted state

  /**
   * Calculate base dynamic TP percentage (without tier adjustments)
   * Used for candidate TP calculations and merge proximity checks
   * @returns {number} TP percentage
   */
  const calculateDynamicTpPercent = () => {
    const { recentSwing, lastPrice } = getMarketState();
    let tpPercent = recentSwing > 0 && lastPrice > 0
      ? (config.tpMult * recentSwing / lastPrice) * 100
      : config.tpMinPercent;

    const regime = regimeDetector.getMode();
    if (regime === 'CAUTION') tpPercent *= 1.5;
    else if (regime === 'TREND') tpPercent *= 0.8;

    const macroTpMult = macroRegime ? macroRegime.getMultipliers().tpMult : 1.0;
    tpPercent *= macroTpMult;

    return clamp(tpPercent, config.tpMinPercent, config.tpMaxPercent);
  };

  /**
   * Place or update TP order for a celestial body
   * Calculates tier-specific TP, applies holdback, places via executor
   * @param {Object} body - CelestialBody
   * @returns {Promise<boolean>} Whether TP was successfully placed
   */
  const placeBodyTp = async (body) => {
    // Extract hints immediately so they never leak if we return early
    const mergeMaxTpPct = body._maxTpPct ?? null;
    const overrideTpPct = body._overrideTpPct ?? null;
    delete body._maxTpPct;
    delete body._overrideTpPct;

    if (body.tpOrderId) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} already has TP ${body.tpOrderId.slice(0, 8)}, skipping duplicate placement`);
      return false;
    }

    // Prevent concurrent TP placement for the same body (race between fill handler and safety-net loop)
    if (tpPlacementInFlight.has(body.id)) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} TP placement already in-flight, skipping`);
      return false;
    }

    tpPlacementInFlight.add(body.id);
    try {

    // Get tier-specific TP percentage
    const baseTpPct = calculateDynamicTpPercent();
    const { tpPercent: tierTpPct } = celestialHierarchy.calculateBodyTpPercent(baseTpPct, body.tier, config.tpMaxPercent);

    // Get tier holdback scale
    const tierCfg = celestialHierarchy.getTierConfig(body.tier);

    // Holdback ratio (needed for fee floor calculation below)
    const holdbackRatio = Math.min((config.holdbackRatio ?? 0.5) * (tierCfg.holdbackScale || 1), 0.95);

    // Minimum profit floor: TP% must clear round-trip fees + $0.01 net USDC profit.
    // Because holdback retains BTC, only (1-h) of gross profit becomes USDC proceeds,
    // so the required TP% = (roundTripFees + minProfit/costBasis) / (1-h)
    const feeRatePerSide = config.feeRate ?? DEFAULT_FEE_RATE_PER_SIDE; // ?? so an explicit 0 (zero-fee) is honored, matching dry-run-executor
    const feeFloorPct = ((2 * feeRatePerSide) + (0.01 / body.costBasis)) / (1 - holdbackRatio) * 100;

    // Holdback floor: TP% must generate enough profit for at least 1 satoshi holdback
    // Only applied when achievable within the tier's effective max TP —
    // tiny bodies that can't produce 1 sat holdback at a reasonable price just get normal TP
    const holdbackFloorPct = (0.00000001 * body.avgPrice) / (body.assetQty * holdbackRatio) * 100;
    const effectiveMax = config.tpMaxPercent * (tierCfg.tpMaxScale || 1);

    const minTpPct = holdbackFloorPct <= effectiveMax
      ? Math.max(feeFloorPct, holdbackFloorPct)
      : feeFloorPct;
    let finalTpPct = Math.min(Math.max(tierTpPct, minTpPct), effectiveMax);

    if (overrideTpPct != null) {
      // User-specified override: use exactly this TP%, subject to fee floor only
      finalTpPct = Math.max(overrideTpPct, minTpPct);
    } else if (body.manualTpPct != null) {
      // Persisted manual override: re-use the user's last manual TP% on re-placement
      finalTpPct = Math.max(body.manualTpPct, minTpPct);
    } else if (mergeMaxTpPct != null) {
      // Merge cap: after a manual merge, TP% must not exceed the pre-merge target's TP%.
      // This guarantees the combined sell price is lower (lower avgPrice × capped TP%).
      finalTpPct = Math.max(Math.min(finalTpPct, mergeMaxTpPct), minTpPct);
    }

    let tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), getPriceIncrement());

    // Guard: never place a TP at or below the body's avg price (would realize a loss)
    if (tpPrice <= body.avgPrice) {
      logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} TP price ${fmtPrice(tpPrice)} <= avgPrice ${fmtPrice(body.avgPrice)}, skipping placement to prevent negative P&L`);
      return false;
    }

    // Calculate sell qty with tier-specific holdback
    let { sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
      body.assetQty,
      body.avgPrice,
      tpPrice,
      tierCfg.holdbackScale
    );

    // Post-hoc P&L validation: simulate the fill and bump TP% if rounding
    // still causes negative USDC P&L or insufficient holdback
    for (let bump = 0; bump < 10; bump++) {
      const estSellProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
      const estPnl = estSellProceeds - body.costBasis;
      if (estPnl >= 0.01 && holdbackQty >= 0.00000001) break;
      finalTpPct += 0.01;
      tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), getPriceIncrement());
      ({ sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
        body.assetQty, body.avgPrice, tpPrice, tierCfg.holdbackScale
      ));
    }

    // Final guard: skip if estimated P&L is still negative (e.g. effectiveMax too low)
    const finalEstProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
    const finalEstPnl = finalEstProceeds - body.costBasis;
    if (finalEstPnl < 0.01) {
      if (negativePnlLoggedPrice.get(body) !== tpPrice) {
        logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} estimated PnL $${finalEstPnl.toFixed(4)} < $0.01 at TP ${fmtPrice(tpPrice)} (${finalTpPct.toFixed(3)}%), skipping to prevent negative P&L`);
        negativePnlLoggedPrice.set(body, tpPrice);
      }
      return false;
    }

    if (sellQty <= 0) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} sell qty is 0 after holdback`);
      return false;
    }

    // Pre-check sell qty against exchange minimum order size to avoid failed placements.
    // If holdback pushes qty below minimum, sell the full body (zero holdback).
    // If even the full body is below minimum, skip — it needs more buys to consolidate.
    if (getProductDetails()?.baseMinSize) {
      const baseMinSize = parseFloat(getProductDetails().baseMinSize);
      const baseIncrement = parseFloat(getProductDetails().baseIncrement) || 0.00000001;
      const roundedSellQty = floorToIncrement(sellQty, baseIncrement);

      if (roundedSellQty < baseMinSize) {
        const fullQty = roundAsset(body.assetQty);
        const roundedFullQty = floorToIncrement(fullQty, baseIncrement);

        if (roundedFullQty >= baseMinSize) {
          const fullProceeds = fullQty * tpPrice * (1 - feeRatePerSide);
          const fullPnl = fullProceeds - body.costBasis;
          if (fullPnl >= 0.01) {
            logger.info(`📏 [${exchange}] Body ${body.id.slice(-8)} sellQty ${sellQty} below exchange min ${baseMinSize}, selling full qty ${fullQty} (no holdback)`);
            sellQty = fullQty;
            holdbackQty = 0;
          } else {
            logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} full qty ${fullQty} PnL $${fullPnl.toFixed(4)} < $0.01 even without holdback, skipping`);
            return false;
          }
        } else {
          // Re-log only when this body's rounded qty changes (consolidation
          // progress); otherwise a permanently-stranded dust body floods the
          // log every cycle (#187).
          if (dustWaitLoggedQty.get(body.id) !== roundedFullQty) {
            logger.info(`📏 [${exchange}] Body ${body.id.slice(-8)} assetQty ${fullQty} (rounded ${roundedFullQty}) below exchange min ${baseMinSize}, waiting for consolidation`);
            dustWaitLoggedQty.set(body.id, roundedFullQty);
          }
          return false;
        }
      }
    }

    // The body owns its TP from the moment the exchange accepts it. Live mode
    // persists that ownership inside the placement handoff, before the dispatch
    // intent is released: otherwise the order id lived only in memory until the
    // 5-minute save, and a crash in that window restarted the body with no TP,
    // so startup placed a second sell beside the untracked original.
    const adoptTpOrder = (orderId) => {
      body.tpOrderId = orderId;
      body.tpPrice = tpPrice;
      body.assetOnOrder = sellQty;

      // Re-aggregate position-level fields so positionState.assetOnOrder reflects
      // ALL bodies' TP orders, not just the most-recently-placed one. Without this,
      // satellite bodies created after the main body's TP leave assetOnOrder stale,
      // making the dashboard's "On Order" panel under-report by the satellite size.
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    };

    let result;
    try {
      // body.avgPrice is the body's real, already-tracked average buy price —
      // pass it through so the dry-run executor can seed this body's own
      // cost basis from it instead of falling back to a global cross-body
      // running average that drifts in a trending market (issue #213E
      // follow-up: that fallback is the PRIMARY path in a celestial-hierarchy
      // engine, since it never trades through the legacy single-cycle path
      // that resets it). No-op for the live executor, which already tracks
      // cost basis on `body.costBasis` independently of order placement.
      result = await getOrderExecutor().placeBodyTpOrder(sellQty, tpPrice, body.id, body.avgPrice, {
        // Guarded: the order is already resting, so a failed save must not
        // turn it into a pending placement the executor stops tracking; the
        // failure counts toward the health monitor's persistence limit instead.
        onAccepted: isDryRun ? null : ({ orderId }) => {
          adoptTpOrder(orderId);
          saveLiveStateGuarded('body-tp-placed');
        },
      });
    } catch (err) {
      logger.warn(
        `⚠️ [${exchange}] Body TP placement error for ${body.id.slice(-8)}: ${err.message}`,
        { bodyId: body.id, orderType: 'body_tp', error: err.message }
      );
      return false;
    }

    if (result.success) {
      adoptTpOrder(result.orderId);

      // Link all source buy fills to this sell order (use both sourceOrderIds and buyOrders for coverage)
      // A large merged body can own hundreds of buys. Persist all links in one
      // ledger write before reporting success, rather than blocking the engine
      // with a full-ledger rewrite for every buy (and timing out the gateway).
      const sourceIds = new Set(body.sourceOrderIds || []);
      for (const buyOrder of (body.buyOrders || [])) {
        if (buyOrder.orderId && buyOrder.orderId !== 'core-migration') sourceIds.add(buyOrder.orderId);
      }
      fillLedger.annotateFillsByOrderIds(sourceIds, {
        sellOrderId: result.orderId, bodyId: body.id, bodyTier: body.tier,
      });

      logger.info(`${tierCfg.emoji} [${exchange}] Body TP placed (${body.tier}): ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency}, body=${body.id.slice(-8)})`);

      tradeEvents.emitTradeEvent('body_tp_placed', exchange, `${tierCfg.emoji} ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)}`, {
        bodyId: body.id,
        bodyTier: body.tier,
        assetQty: body.assetQty,
        costBasis: body.costBasis,
        avgPrice: body.avgPrice,
        tpPrice,
        sellQty,
        holdbackQty,
      });

      return true;
    }

    logger.warn(
      `⚠️ [${exchange}] Failed to place body TP for ${body.id.slice(-8)}: ${result.errorMessage}`,
      { bodyId: body.id, orderType: 'body_tp', error: result.errorMessage }
    );
    return false;

    } finally {
      tpPlacementInFlight.delete(body.id);
    }
  };

  /** Place body TP with a single retry on failure to avoid leaving body without sell */
  const placeBodyTpWithRetry = async (body, context) => {
    let placed = await placeBodyTp(body);
    if (!placed && !body.tpOrderId) {
      logger.warn(`⚠️ [${exchange}] ${context} TP placement failed for body ${body.id.slice(-8)}, retrying after 1s...`);
      await sleep(PLACEMENT_RETRY_DELAY_MS);
      placed = await placeBodyTp(body);
      if (!placed && !body.tpOrderId) {
        logger.error(
          `🚨 [${exchange}] ${context} TP retry failed for body ${body.id.slice(-8)} — body has no sell order, will re-place on next reconcile`,
          { bodyId: body.id, orderType: 'body_tp', operation: context }
        );
      }
    }
    return placed;
  };

  /**
   * Place or update take-profit order (legacy compat for untracked core position)
   * In celestial mode, body TPs are managed via placeBodyTp()
   * @param {Object} [options] - Options
   * @param {boolean} [options.forceUpdate] - Bypass anti-churn (use after buy fills)
   */
  const placeTakeProfitOrder = async (options = {}) => {
    // In celestial mode, update all body TPs instead
    if (positionState.celestialBodies && positionState.celestialBodies.length > 0) {
      // Cancel any lingering legacy TP order — but only if no body owns it
      if (positionState.activeTpOrderId) {
        const ownedByBody = positionState.celestialBodies.some(b => b.tpOrderId === positionState.activeTpOrderId);
        if (!ownedByBody) {
          logger.info(`🧹 [${exchange}] Cancelling legacy TP ${positionState.activeTpOrderId.substring(0, 8)} — celestial mode active`);
          await getOrderExecutor().cancelTpOrder();
        }
        positionState.activeTpOrderId = null;
        positionState.lastTpPrice = 0;
        positionState.assetOnOrder = 0;
      }

      // Snapshot the array to avoid visiting bodies added concurrently by fill handlers
      const bodiesToCheck = [...positionState.celestialBodies];
      for (const body of bodiesToCheck) {
        if (!body.tpOrderId) {
          await placeBodyTp(body);
        }
      }
      return;
    }

    // Legacy path for untracked core position
    const tpPrice = calculateDynamicTP();

    const { sellQty, holdbackQty, profitAssetValue } = positionSizer.calculateTakeProfitSize(
      positionState.totalAsset,
      positionState.avgCostBasis,
      tpPrice
    );

    if (sellQty <= 0) return;

    const result = await getOrderExecutor().placeTakeProfitOrder(sellQty, tpPrice, options);

    if (result.filledDuringCancel && result.filledOrderId) {
      // Old TP filled while we were trying to cancel-and-replace — route to fill handler.
      // The cancel-replace path already removed the order from pendingOrders, so the
      // engine's terminal handleOrderFill cleanup would log a spurious "orphan" warning
      // without this markSettled.
      logger.info(`📋 [${exchange}] TP filled during cancel-and-replace, routing to fill handler: ${result.filledOrderId}`);
      // placeTakeProfitOrder's cancel attempt already fetched this order's terminal
      // status to discover the fill — use those fields directly rather than
      // re-fetching via a second, redundant getOrder() call whose own failure
      // would otherwise silently drop the fill entirely (issue #227 follow-up).
      // Fall back to a fresh fetch only if that data is missing for some reason.
      let fillData = result.filledSize > 0 ? result : null;
      if (!fillData) {
        fillData = await lookupOrNull('getOrder', result.filledOrderId, getAdapter().getOrder(result.filledOrderId));
      }
      if (fillData) {
        getOrderExecutor().markSettled(result.filledOrderId);
        await handleOrderFill({
          orderId: result.filledOrderId,
          side: 'sell',
          status: 'FILLED',
          filledSize: parseFloat(fillData.filledSize || 0),
          filledValue: parseFloat(fillData.filledValue || 0),
          averageFilledPrice: parseFloat(fillData.averageFilledPrice || 0),
          totalFees: parseFloat(fillData.totalFees || 0),
        });
      }
      return;
    }

    if (result.success) {
      positionState.activeTpOrderId = result.orderId;
      positionState.lastTpPrice = tpPrice;
      positionState.assetOnOrder = sellQty;

      // Link all current-cycle non-body buys to this sell order (skip body-owned buys)
      const cycleFills = fillLedger.getCurrentCycleFills();
      const coreBuyOrderIds = new Set();
      for (const fill of cycleFills) {
        // Timestamp-folded buys (#705) are not in the core position this TP sells.
        if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId && fill.cycleAttribution !== 'timeframe') {
          coreBuyOrderIds.add(fill.orderId);
        }
      }
      fillLedger.annotateFillsByOrderIds(coreBuyOrderIds, { sellOrderId: result.orderId });

      if (result.updated) {
        logger.info(`📝 [${exchange}] TP ${result.orderId ? 'updated' : 'placed'}: ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency} ≈$${profitAssetValue.toFixed(2)})`);
      }
    }
  };

  /**
   * Calculate dynamic take-profit price (legacy for core position)
   * @returns {number}
   */
  const calculateDynamicTP = () => {
    const { avgCostBasis } = positionState;
    const tpPercent = calculateDynamicTpPercent();
    return roundPrice(avgCostBasis * (1 + tpPercent / 100), getPriceIncrement());
  };

  return { calculateDynamicTpPercent, placeBodyTp, placeBodyTpWithRetry, placeTakeProfitOrder };
};

module.exports = { createTpPlacement };
