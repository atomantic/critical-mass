// @ts-check
/**
 * Applies planned cycle repairs to one fill ledger (issue #1613).
 * The owner supplies its live maps and scalar state accessors. This module
 * retains the original mutation and persist order: apply, legacy link, save.
 */
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { isBodyOwnedFill } = require('../shared/cycle-pairing.mjs');
const { planCycleRecalculation } = require('./fill-ledger-recalc');

const createCycleApplication = (state) => {
  const { fills, cycleIndex, logger, exchange, cycleCompletionRatio,
    setDirty, bumpLedgerVersion, persist } = state;
  const linkLegacyCycleBuys = (cycleDetails) => {
    // Auto-link buys to sells within completed cycles only (fixes orphaned buys display).
    // Skip active cycles to avoid linking unsold buys to early partial sells.
    //
    // This is legacy-core-only (#677): body/satellite buy linkage is owned by
    // TP placement (regime-engine.js) and boot annotation, not this heuristic.
    // In celestial mode a cycle can hold many bodies and is marked "completed"
    // once the sell ratio crosses CYCLE_COMPLETE_SELL_RATIO while other bodies
    // in the SAME cycle are still open with no TP placed yet (their buy has no
    // sellOrderId for a legitimate reason, not a crash to repair). Stamping
    // those open buys with an unrelated body's sell falsely closes them and
    // zeroes their heldOpenBuyCostBasis. Also never auto-link inside the
    // ledger's current (still-live) cycle — a body there may not even have
    // attempted its TP placement yet.
    let linkedCount = 0;
    const completedCycleIds = new Set(cycleDetails.map(d => d.cycleId));
    const cycleSellIds = new Map(); // cycleId -> first LEGACY (non-body/satellite) sell orderId
    // A sell recalc attributed into a cycle (#705) is a re-imported row. It
    // may serve as the cycle's legacy close only when core buys — and no
    // body/satellite buy — link to it: then it is provably the core TP. A
    // sell nothing links to, or one linked from body buys it could not
    // inherit a single owner from, would stamp unrelated core buys with
    // another order's sell (#752).
    const sellLinkOwnership = new Map(); // sell orderId -> { core, owned }
    // Ownership is tested once per fill; the later passes only see core fills.
    const coreFills = [];
    for (const fill of fills.values()) {
      const owned = isBodyOwnedFill(fill);
      if (!owned) coreFills.push(fill);
      if (fill.side !== 'buy') continue;
      const linkedSellIds = new Set();
      if (fill.sellOrderId) linkedSellIds.add(fill.sellOrderId);
      if (fill.consumedBy && typeof fill.consumedBy === 'object') {
        for (const id of Object.keys(fill.consumedBy)) linkedSellIds.add(id);
      }
      for (const id of linkedSellIds) {
        const entry = sellLinkOwnership.get(id) || { core: false, owned: false };
        if (owned) entry.owned = true; else entry.core = true;
        sellLinkOwnership.set(id, entry);
      }
    }
    for (const fill of coreFills) {
      if (fill.side === 'sell' && fill.cycleAttribution) {
        const links = sellLinkOwnership.get(fill.orderId);
        if (!links || !links.core || links.owned) continue;
      }
      if (fill.side === 'sell' && fill.cycleId && completedCycleIds.has(fill.cycleId) && !cycleSellIds.has(fill.cycleId)) {
        cycleSellIds.set(fill.cycleId, fill.orderId);
      }
    }
    for (const fill of coreFills) {
      if (fill.cycleId && fill.cycleId === state.currentCycleId) continue;
      // A buy folded in by timestamp alone (#705) was never part of the core
      // position the cycle's TP sold — stamping it would book its cost as
      // consumed by that sell (realized P&L / reserves / closed-trades).
      if (fill.cycleAttribution === 'timeframe') continue;
      if (fill.side === 'buy' && fill.cycleId && !fill.sellOrderId && completedCycleIds.has(fill.cycleId)) {
        const sellId = cycleSellIds.get(fill.cycleId);
        if (sellId) {
          fill.sellOrderId = sellId;
          linkedCount++;
          setDirty();
          bumpLedgerVersion();
        }
      }
    }
    if (linkedCount > 0) {
      logger.info(`🔗 [${exchange}] Linked ${linkedCount} buys to their cycle sells`, {
        linkedCount,
      });
    }
    return linkedCount;
  };

  /**
   * Plan a recalculation against the ledger's fills and live cycle
   * (fill-ledger-recalc.js, issue #1335). Never mutates ledger state.
   * @returns {import('./fill-ledger-recalc').CycleRecalculationPlan}
   */
  const planRecalculation = () => planCycleRecalculation({
    fills: fills.values(),
    liveCycleId: state.currentCycleId,
    liveCycleStartedAt: state.currentCycleStartedAt,
    cycleCompletionRatio,
  });

  /**
   * Apply a recalculation plan to the ledger: stamp attributed and recovered
   * fills with their cycles, assign inherited annotations, adopt a recovered
   * live cycle when there was none, renumber, and keep cycleIndex, the
   * dirty flag and the ledger version in step. Does not auto-link or persist.
   * @param {import('./fill-ledger-recalc').CycleRecalculationPlan} plan
   */
  const applyRecalculationPlan = (plan) => {
    const { attributed, patches, liveCycleOrphansAttributed, orphanCycles, orphanFillCount, renumbering } = plan;
    for (const [fill, patch] of patches) {
      Object.assign(fill, patch);
      setDirty();
      bumpLedgerVersion();
    }
    for (const { fill, cycleId, reason } of attributed) {
      fill.cycleId = cycleId;
      // Record HOW the cycle was chosen. A 'timeframe' fold has no linkage to
      // any engine order — sync-fills imports every trade on the pair, manual
      // ones included — so boot's orphan-buy → body merge must not adopt it
      // and place a TP for it (R2 in docs/pnl-architecture.md).
      fill.cycleAttribution = reason;
      if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
      cycleIndex.get(cycleId).add(fill.tradeId);
      setDirty();
      bumpLedgerVersion();
    }
    if (attributed.length > 0) {
      logger.info(`🔧 [${exchange}] Attributed ${attributed.length} orphan fills to existing cycles (${liveCycleOrphansAttributed} into live cycle ${state.currentCycleId})`, {
        attributed: attributed.length,
        liveCycleOrphansAttributed,
        cycleId: state.currentCycleId,
      });
    }

    if (orphanCycles.length > 0) {
      logger.info(`🔧 [${exchange}] Split ${orphanFillCount} orphan fills into ${orphanCycles.length} cycles`, {
        orphanFillCount,
        orphanCycleCount: orphanCycles.length,
      });
      for (const { cycleId, fills: cycleFills } of orphanCycles) {
        // Assign cycle ID to all fills in this cycle
        if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
        for (const fill of cycleFills) {
          fill.cycleId = cycleId;
          fills.set(fill.tradeId, fill);
          cycleIndex.get(cycleId).add(fill.tradeId);
          setDirty();
          bumpLedgerVersion();
        }
      }
      // The plan only adopts a recovered cycle when there was no live cycle
      // to preserve (#675).
      if (plan.adoptedCycleId !== null) {
        state.currentCycleId = plan.adoptedCycleId;
        state.currentCycleStartedAt = null;
      }
      const completedCycleCount = orphanCycles.filter(c => c.fills.some(f => f.side === 'sell')).length;
      logger.info(`🔧 [${exchange}] Assigned ${orphanFillCount} orphan fills to recovered cycles, found ${completedCycleCount} completed cycles`, {
        orphansFixed: orphanFillCount,
        completedCycleCount,
      });
    }

    if (renumbering) {
      const { idMap, nextCycleNumber: cycleNum, renumbered } = renumbering;
      if (renumbered > 0) {
        cycleIndex.clear();
        for (const fill of Array.from(fills.values())) {
          if (fill.cycleId && idMap.has(fill.cycleId)) {
            fill.cycleId = idMap.get(fill.cycleId);
            fills.set(fill.tradeId, fill);
            setDirty();
            bumpLedgerVersion();
          }
          if (fill.cycleId) {
            if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
            cycleIndex.get(fill.cycleId).add(fill.tradeId);
          }
        }
        if (state.currentCycleId && idMap.has(state.currentCycleId)) {
          state.currentCycleId = idMap.get(state.currentCycleId);
        }
        logger.info(`🔢 [${exchange}] Renumbered ${renumbered} cycles to sequential IDs (cycle-1 through cycle-${cycleNum - 1})`, {
          renumbered,
          firstCycleId: 'cycle-1',
          lastCycleId: `cycle-${cycleNum - 1}`,
        });
      }
      state.nextCycleNumber = cycleNum;
    }
  };

  /**
   * Recalculate cycles from fill history: plan (fill-ledger-recalc.js), apply
   * the plan, auto-link legacy core buys within completed cycles, persist.
   * See planCycleRecalculation for the attribution / recovery / renumbering
   * rules.
   * @returns {{cyclesCompleted: number, realizedPnL: number, realizedAssetPnL: number, cycleDetails: Array, orphansFixed: number, orphansAttributed: number, liveCycleOrphansAttributed: number, activeCycleId: string|null, idMap: Object<string, string>}}
   */
  const recalculateCycles = () => {
    const plan = planRecalculation();
    applyRecalculationPlan(plan);
    const { cycleDetails, orphansFixed } = plan;
    const linkedCount = linkLegacyCycleBuys(cycleDetails);

    if (orphansFixed > 0 || linkedCount > 0 || plan.patches.size > 0) {
      persist();
    }

    return {
      cyclesCompleted: cycleDetails.length,
      realizedPnL: roundUSDC(plan.realizedPnL),
      realizedAssetPnL: roundAsset(plan.realizedAssetPnL),
      cycleDetails,
      orphansFixed,
      // Orphans placed into existing cycles / into the live cycle (#705).
      // A non-zero live count changes live-cycle membership: callers must
      // resync their position counters (cycleBuys, totals) from the ledger.
      orphansAttributed: plan.attributed.length,
      liveCycleOrphansAttributed: plan.liveCycleOrphansAttributed,
      activeCycleId: state.currentCycleId,
      // old → new cycle ID for every cycle the renumbering renamed. Callers
      // holding a durable cycle ID (positionState.activeCycleId) must re-point
      // it through this map, or the next restart restores a stale name (#675).
      idMap: plan.idMap,
    };
  };

  return { planRecalculation, recalculateCycles };
};

module.exports = { createCycleApplication };
