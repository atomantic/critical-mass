// @ts-check
/**
 * Dashboard projection for an existing regime engine. The engine refreshes
 * accounting first and supplies current runtime references on every read.
 * Stopped-process synthesis remains in regime-status.js.
 */
const { LIFECYCLE, describePlacementIntents } = require('./state-tracker');
const celestialHierarchy = require('./celestial-hierarchy');
const { DEFAULT_FEE_RATE_PER_SIDE } = require('../shared/fee-defaults.mjs');

/**
 * Build the dashboard pendingOrders payload: enrich the executor's tracked
 * orders with body/cost-basis metadata, then union any body TPs the executor
 * doesn't track in-memory (after engine stop, or pre-reconcile after start).
 */
const buildPendingOrders = (executorOrders, positionState) => {
  const bodies = positionState.celestialBodies || [];
  const enriched = executorOrders.map(order => {
    if (order.type === 'take_profit') {
      const body = bodies.find(b => b.tpOrderId === order.orderId);
      if (body) {
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        return {
          ...order,
          type: 'body_tp',
          tpPercent: body.avgPrice > 0 ? ((order.price - body.avgPrice) / body.avgPrice * 100).toFixed(2) : null,
          bodyId: body.id,
          bodyTier: body.tier,
          tierEmoji: tierCfg?.emoji || '🛰️',
          bodyAvgCost: body.avgPrice,
          bodyBtcQty: body.assetQty,
          bodyCostBasis: body.costBasis,
        };
      }
      if (positionState.avgCostBasis > 0) {
        return {
          ...order,
          tpPercent: ((order.price - positionState.avgCostBasis) / positionState.avgCostBasis * 100).toFixed(2),
        };
      }
      return order;
    }
    if (order.type === 'body_tp' || order.type === 'satellite_tp') {
      const body = bodies.find(b => b.tpOrderId === order.orderId);
      const avgPrice = body ? body.avgPrice : 0;
      const tierCfg = body ? celestialHierarchy.getTierConfig(body.tier) : null;
      return {
        ...order,
        tpPercent: avgPrice > 0 ? ((order.price - avgPrice) / avgPrice * 100).toFixed(2) : null,
        bodyId: body?.id || null,
        bodyTier: body?.tier || null,
        tierEmoji: tierCfg?.emoji || '🛰️',
        bodyAvgCost: avgPrice,
        bodyBtcQty: body?.assetQty ?? order.size,
        bodyCostBasis: body?.costBasis || 0,
      };
    }
    return order;
  });

  const known = new Set(enriched.map(o => o.orderId));
  for (const body of bodies) {
    if (!body.tpOrderId || known.has(body.tpOrderId)) continue;
    enriched.push(celestialHierarchy.buildBodyTpOrder(body));
  }
  return enriched;
};

/**
 * Assemble the existing engine status payload without capturing runtime state.
 * @param {Object} dependencies - Current engine services, state and flags.
 * @returns {Object}
 */
const buildRegimeEngineStatus = ({
  exchange, pair, isRunning, isDryRun, config, marketState, positionState,
  regimeDetector, macroRegime, healthMonitor, tailEvents, riskManager,
  orderExecutor, fillDrift, positionCoverage, calculateApyMetrics,
  tpOptimizer, sizeOptimizer, fillLedger, closedTrades,
}) => {
  const executorOrders = orderExecutor.capabilities?.liveReconciliation
    ? orderExecutor.getPendingOrdersList()
    : [];
  const dryRunState = isDryRun ? orderExecutor.getDryRunState() : null;
  const pendingEntry = isDryRun
    ? dryRunState.pendingOrders.find(order => order.type === 'entry')
    : executorOrders.find(order => order.type === 'entry');
  return {
    isRunning,
    isDryRun,
    market: marketState,
    position: positionState,
    regime: regimeDetector.getState(),
    macro: macroRegime ? macroRegime.getState() : null,
    health: healthMonitor.getState(),
    pause: tailEvents.getPauseState(),
    risk: riskManager.getState(),
    orders: orderExecutor.getPendingCounts(),
    pendingOrders: orderExecutor.capabilities?.liveReconciliation
      ? buildPendingOrders(executorOrders, positionState)
      : [],
    fillDrift,
    positionCoverage,
    apy: calculateApyMetrics(),
    dryRun: dryRunState,
    tpOptimizer: tpOptimizer.getStatus(),
    sizeOptimizer: sizeOptimizer.getStatus(),
    fillTimeStats: fillLedger.getFillTimeStats ? fillLedger.getFillTimeStats(7) : null,
    closedTradesSummary: {
      totalPnl: closedTrades.getTotalPnL(),
      totalHoldback: closedTrades.getTotalHoldback(),
      count: closedTrades.getCount(),
    },
    effectiveStaleMs: orderExecutor.capabilities?.liveReconciliation ? orderExecutor.getEffectiveStaleMs() : config.orderStaleMs,
    pendingEntryStaleMs: pendingEntry?.staleMs ?? null,
    // Include current config for real-time dashboard updates
    config: {
      maxUsdcDeployed: config.maxUsdcDeployed,
      baseSizeUsdc: config.baseSizeUsdc,
      maxCycleBuys: config.maxCycleBuys,
      tpMinPercent: config.tpMinPercent,
      tpMaxPercent: config.tpMaxPercent,
      holdbackRatio: config.holdbackRatio,
      // Same fee the engine actually budgets when sizing/gating a TP (placeBodyTp's
      // feeFloorPct) — exposed so the dashboard's Open Orders "est." columns never
      // hard-code a fee guess of their own. See issue #698.
      feeRatePerSide: config.feeRate ?? DEFAULT_FEE_RATE_PER_SIDE,
      entryMode: config.entryMode || 'reactive',
      ladderAutoSwitch: config.ladderAutoSwitch || false,
      ladderMaxAthDropPct: config.ladderMaxAthDropPct || 80,
      ladderSpacingMode: config.ladderSpacingMode || 'sqrt',
      ladderSizeMode: config.ladderSizeMode || 'fibonacci',
      ladderMinSpacingPct: config.ladderMinSpacingPct || 0.5,
      celestialEnabled: config.celestialEnabled !== false,
      maxCelestialBodies: config.maxCelestialBodies || 10,
      mergeProximityScale: config.mergeProximityScale ?? 1.0,
      macroEnabled: config.macroEnabled || false,
    },
    // Effective entry mode (may differ from config due to auto-switch)
    entryMode: (() => {
      let mode = config.entryMode || 'reactive';
      if (config.ladderAutoSwitch && marketState.volBaseline > 0) {
        const volExpansion = marketState.realizedVol / marketState.volBaseline;
        if (volExpansion >= (config.ladderAutoSwitchVolMult || 2.0)) {
          mode = 'ladder';
        }
      }
      return mode;
    })(),
    // Auto-switch debug info
    autoSwitch: config.ladderAutoSwitch ? {
      volExpansion: marketState.volBaseline > 0 ? parseFloat((marketState.realizedVol / marketState.volBaseline).toFixed(2)) : 0,
      threshold: config.ladderAutoSwitchVolMult || 2.0,
      wouldTrigger: marketState.volBaseline > 0 && (marketState.realizedVol / marketState.volBaseline) >= (config.ladderAutoSwitchVolMult || 2.0),
    } : null,
    ladder: positionState.ladderActive ? {
      active: true,
      placedAt: positionState.ladderPlacedAt,
      lowerBound: positionState.ladderLowerBound,
      pendingOrders: positionState.pendingLadderOrders?.length || 0,
      committedUsdc: (positionState.pendingLadderOrders || []).reduce((sum, o) => sum + (o.sizeUsdc || 0), 0),
    } : null,
    celestial: celestialHierarchy.buildCelestialPayload(positionState, config),
    // Body TP aggregates (legacy key "satellites" kept for UI compat)
    satellites: {
      enabled: config.celestialEnabled !== false,
      active: (positionState.celestialBodies || []).length,
      completed: positionState.celestialState?.bodiesCompleted || 0,
      realizedPnL: positionState.celestialState?.bodiesRealizedPnL || 0,
      realizedAssetPnL: positionState.celestialState?.bodiesRealizedAssetPnL || 0,
      orders: (positionState.celestialBodies || []).map(b => ({
        buyOrderId: b.id?.substring(0, 8),
        tpOrderId: b.tpOrderId,
        assetQty: b.assetQty,
        costBasis: b.costBasis,
        avgPrice: b.avgPrice,
        tpPrice: b.tpPrice,
        assetOnOrder: b.assetOnOrder,
        placedAt: b.createdAt,
      })),
    },
    lifecycle: {
      lifecycle: positionState.lifecycle || LIFECYCLE.ACTIVE,
      lifecycleChangedAt: positionState.lifecycleChangedAt || null,
      lifecycleReason: positionState.lifecycleReason || null,
      lifecycleClosedCycle: positionState.lifecycleClosedCycle || null,
    },
    placementIntents: isDryRun ? [] : describePlacementIntents(exchange, pair),
  };
};

module.exports = { buildRegimeEngineStatus };
