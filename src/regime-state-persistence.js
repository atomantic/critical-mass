'use strict';

/**
 * State persistence for one fund: the dry-run snapshot/save/load, the live
 * save/load, the SIGUSR1 reload, and the cycle-pair realized-P&L refresh that
 * every save runs first. Extracted verbatim from regime-engine.
 *
 * `refreshRealizedFromCyclePairs` stays the single source of truth for
 * positionState.realizedPnL / realizedAssetPnL (derived from the fill ledger's
 * per-sell annotations, never accumulated) — see docs/pnl-architecture.md.
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getOrderExecutor` is an accessor because the
 * engine swaps executors. `persistEpisodeState`/`restoreEpisodeState` are
 * declared later in the engine, so they are passed as thunks that resolve at
 * call time.
 */

const dryRunState = require('./dry-run-state');
const { tradeEvents } = require('./trade-events');
const { MAX_CONSECUTIVE_PERSISTENCE_FAILURES } = require('./health-monitor');
const { loadFundRegimeState, saveFundRegimeState } = require('./state-tracker');
const { restorePersistedCycleId } = require('./regime-fill-annotations');
const { pruneStaleTpCancelMarkers } = require('./regime-pure-helpers');
const celestialHierarchy = require('./celestial-hierarchy');

// Position fields a SIGUSR1 reload merges from disk into memory.
const RELOADABLE_STATE_FIELDS = Object.freeze(['realizedPnL', 'realizedAssetPnL', 'celestialState']);

/**
 * @param {Object} deps
 * @returns {{snapshotDryRunState: Function, saveDryRunState: Function, saveDryRunStateGuarded: Function, loadDryRunState: Function, refreshRealizedFromCyclePairs: Function, syncActiveCycleIdAfterRecalc: Function, resyncLiveCycleCountersAfterRecalc: Function, saveLiveState: Function, saveLiveStateGuarded: Function, describeReloadBlocker: Function, reloadStateFromDisk: Function, loadLiveState: Function}}
 */
const createEngineStatePersistence = ({
  exchange, pair, baseCurrency, fundLabel, isDryRun, config, logger,
  positionState, replacePositionState, createInitialPositionState,
  fillLedger, tpOptimizer, sizeOptimizer, regimeDetector, macroRegime, healthMonitor, engineLocks,
  tpPlacementInFlight, isExtendInFlight, getOrderExecutor,
  persistEpisodeState, restoreEpisodeState,
}) => {
  /**
   * Build the dry-run state bundle. Single source for the periodic save, the
   * shutdown save and the backup flush so they cannot drift (#113, #1357).
   */
  const snapshotDryRunState = () => {
    persistEpisodeState();

    // Persist macro regime state into position for recovery
    if (macroRegime) {
      positionState.macroRegime = macroRegime.getState();
    }

    return {
      isDryRun: true,
      executor: getOrderExecutor().exportState(),
      position: { ...positionState },
      tpOptimizer: tpOptimizer.exportState(),
      sizeOptimizer: sizeOptimizer.exportState(),
    };
  };

  /**
   * Save dry-run state to disk
   */
  const saveDryRunState = () => {
    if (!isDryRun) return;
    dryRunState.saveState(exchange, snapshotDryRunState(), pair);
  };

  /**
   * Dry-run counterpart of saveLiveStateGuarded for the save timer. Dry-run is
   * a per-fund setting, so live funds share this process: a full disk must not
   * turn a dry-run save into an uncaughtException that exits them all (#532).
   * @param {string} source - Caller label for the log line
   * @returns {boolean} Whether the save succeeded
   */
  const saveDryRunStateGuarded = (source) => {
    try {
      saveDryRunState();
      return true;
    } catch (err) {
      logger.error(`❌ [${fundLabel}] Dry-run state save failed from ${source}: ${err.message}`, {
        action: 'save-dry-run-state', source, error: err.message,
      });
      return false;
    }
  };

  /**
   * Load dry-run state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadDryRunState = () => {
    if (!isDryRun) return false;

    const savedState = dryRunState.loadState(exchange, pair);
    if (!savedState || !savedState.isDryRun) return false;

    // Restore executor state
    getOrderExecutor().importState(savedState.executor);

    // Restore position state
    if (savedState.position) {
      replacePositionState({ ...createInitialPositionState(), ...savedState.position });
      restoreEpisodeState(positionState);
    }

    // Restore TP optimizer state
    if (savedState.tpOptimizer) {
      tpOptimizer.importState(savedState.tpOptimizer);
    }

    // Restore Size optimizer state
    if (savedState.sizeOptimizer) {
      sizeOptimizer.importState(savedState.sizeOptimizer);
    }

    // Log APY tracking state restoration
    const apyStatus = positionState.engineStartTime
      ? `APY from ${new Date(positionState.engineStartTime).toISOString()}`
      : 'APY not tracked yet';

    logger.info(`📂 [${exchange}] [DRY-RUN] Restored state: ${positionState.cyclesCompleted} cycles, buys ${positionState.cycleBuys}, PnL=$${positionState.realizedPnL.toFixed(2)}, ${apyStatus}`);
    return true;
  };

  /**
   * Refresh positionState.realizedPnL and positionState.realizedAssetPnL.
   *
   * SINGLE SOURCE OF TRUTH: both fields are derived from buy↔sell pairing
   * in the fill ledger. Each buy carries the orderId of the sell that
   * consumed it; each sell sums its paired buys' cost. closed-trades.json
   * is an audit log only — it is NOT consulted here.
   *
   *   realizedPnL      = Σ (sell_proceeds − Σ paired_buy_cost)
   *   realizedAssetPnL = Σ max(0, Σ paired_buy_size − sell_size)  (holdback)
   *
   * Held-back asset (reserves) is treated as zero-cost: the cost of the
   * un-sold portion was attributed to the paired sell's cost basis. This
   * matches the engine's design contract — buy(n)→sell(1) per cycle — and
   * the per-cycle UI sums in RegimeDashboard.jsx are derived the same way,
   * so the dashboard total always agrees with the cycle row sums.
   *
   * Safe to call on every state save and status emit (side-effect-free).
   */
  const refreshRealizedFromCyclePairs = () => {
    const derived = fillLedger.getDerivedRealizedPnL();
    positionState.realizedPnL = derived.realizedPnL;
    positionState.realizedAssetPnL = derived.realizedAssetPnL;
    // Cost basis of currently-held bot position: each buy order's unconsumed
    // remainder per its consumedBy record (issue #607), or — for orders no
    // sell has recorded against — buys whose linked sell order has not filled
    // (sellOrderId alone means a TP was *placed*, not fired).
    // Used by APY calc for unrealized P&L of body assets:
    //   unrealizedReturn = body_qty × current_price − heldAssetCostBasis.
    // Reserves are zero-cost; their full mark-to-market value is profit.
    positionState.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
    if (positionState.celestialState) {
      positionState.celestialState.bodiesRealizedPnL = derived.realizedPnL;
      positionState.celestialState.bodiesRealizedAssetPnL = derived.realizedAssetPnL;
    }
  };

  /**
   * After fillLedger.recalculateCycles(), re-point the durable
   * positionState.activeCycleId at the ledger's live cycle. Orphan recovery
   * can renumber every cycle (returned as `idMap`), and the persisted
   * boundary is otherwise only written by resetCycle — so without this the
   * next restart's restorePersistedCycleId would select whatever cycle now
   * holds the old name, possibly a completed one (#675).
   *
   * An existing marker is only translated through the rename map — never
   * replaced by the ledger's own guess. After a SIGUSR1 reload the ledger's
   * current cycle comes from load()'s "most recent unsold cycle" heuristic,
   * and overwriting the operator's post-reset boundary with it would undo the
   * #606 fix on the next restart. Legacy state files without the marker only
   * gain one when the recalc actually renamed cycles.
   * @param {{idMap?: Object<string, string>}} recalc
   * @returns {boolean} Whether activeCycleId changed (caller should persist)
   */
  const syncActiveCycleIdAfterRecalc = (recalc) => {
    const idMap = recalc?.idMap || {};
    const previous = positionState.activeCycleId;
    let next;
    if (typeof previous === 'string') {
      next = Object.prototype.hasOwnProperty.call(idMap, previous) ? idMap[previous] : previous;
    } else if (Object.keys(idMap).length > 0) {
      next = fillLedger.getCurrentCycleId();
    }
    if (!next || next === previous) return false;
    logger.info(`🔢 [${exchange}] Re-pointing persisted active cycle after recalc: ${previous ?? 'none'} → ${next}`, {
      previousCycleId: previous ?? null,
      cycleId: next,
    });
    positionState.activeCycleId = next;
    return true;
  };

  /**
   * After a recalc that attributed null-cycle fills INTO the live cycle
   * (#705), live-cycle membership changed, so the position counters derived
   * from it at boot (cycleBuys, and the core totals) are stale — an
   * under-counted cycleBuys would let the engine bypass its per-cycle entry
   * limit. (Timestamp-folded buys raise cycleBuys only; rebuildPositionFromFills
   * keeps them out of the core totals so no TP is auto-placed for them — R2.) Re-derive them from the ledger exactly as the reconcile path does:
   * core totals from the current cycle's fills, body totals from bodies
   * (authoritative in celestial mode), and cycleBuys from all current-cycle
   * buy orders in celestial mode (issue #210-A).
   * @param {{liveCycleOrphansAttributed?: number}} recalc
   * @returns {boolean} Whether counters were resynced
   */
  const resyncLiveCycleCountersAfterRecalc = (recalc) => {
    if (!(recalc?.liveCycleOrphansAttributed > 0)) return false;
    const before = { cycleBuys: positionState.cycleBuys, totalAsset: positionState.totalAsset };
    const rebuilt = fillLedger.rebuildPositionFromFills();
    for (const field of ['totalAsset', 'totalCostBasis', 'avgCostBasis', 'cycleBuys']) {
      if (rebuilt[field] !== undefined) positionState[field] = rebuilt[field];
    }
    // A recovered core buy that is newer than the entry clock moves it, so the
    // min-interval / volatility entry triggers don't fire again too soon or
    // against a stale anchor. Only ever forward: body-owned buys are absent
    // from the core rebuild, whose lastEntryTime would otherwise regress it.
    if (rebuilt.lastEntryTime > (positionState.lastEntryTime || 0)) {
      positionState.lastEntryTime = rebuilt.lastEntryTime;
      positionState.lastEntryPrice = rebuilt.lastEntryPrice;
      positionState.anchorPrice = rebuilt.anchorPrice;
    }
    const bodies = positionState.celestialBodies || [];
    if (bodies.length > 0) {
      celestialHierarchy.syncPositionState(positionState, bodies);
    }
    if (config.celestialEnabled !== false) {
      positionState.cycleBuys = fillLedger.getCurrentCycleAllBuysCount();
    }
    logger.info(`🔧 [${exchange}] Resynced live-cycle counters after attributing ${recalc.liveCycleOrphansAttributed} orphan fill(s): cycleBuys ${before.cycleBuys} → ${positionState.cycleBuys}, ${baseCurrency} ${before.totalAsset} → ${positionState.totalAsset}`, {
      liveCycleOrphansAttributed: recalc.liveCycleOrphansAttributed,
      cycleBuys: positionState.cycleBuys,
      totalAsset: positionState.totalAsset,
    });
    return true;
  };

  /**
   * Save live state to disk (for faster recovery on restarts)
   */
  const saveLiveState = () => {
    if (isDryRun) return;

    persistEpisodeState();

    // Persist macro regime state into position for recovery
    if (macroRegime) {
      positionState.macroRegime = macroRegime.getState();
    }

    // Refresh realized P&L (USD + asset reserves) from cycle pairs before persisting
    refreshRealizedFromCyclePairs();

    // A cancel-execution marker whose TP has since moved is dead state (#744).
    pruneStaleTpCancelMarkers(positionState.celestialBodies);

    const regimeState = regimeDetector.getState();
    const tpOptimizerState = tpOptimizer.exportState();
    const sizeOptimizerState = sizeOptimizer.exportState();
    saveFundRegimeState(exchange, pair, { position: positionState, regime: regimeState, tpOptimizer: tpOptimizerState, sizeOptimizer: sizeOptimizerState });
  };

  /**
   * Persist live state from a BACKGROUND caller — the 5-minute save timer and
   * the SIGUSR1 reload — where a synchronous throw is an uncaughtException that
   * terminates a live trading process with resting orders on the exchange
   * (issue #532). `saveFundRegimeState`'s terminal `atomicWriteSync` rethrows on
   * ENOSPC/EACCES/EROFS, so a full disk alone is enough to trigger it.
   *
   * A persistence fault is treated as a health condition: log it, notify the
   * operator, and after MAX_CONSECUTIVE_PERSISTENCE_FAILURES saves in a row
   * trip SAFE mode so no NEW entries are opened while the engine cannot write
   * down what it already holds. Resting orders are deliberately left alone.
   *
   * Deliberately NOT used by stop(): that path must still propagate so the
   * backup-restore quiescence gate learns the last state was not saved (#429).
   * @param {string} source - Call-site label for the log line
   * @returns {boolean} Whether the save succeeded
   */
  const saveLiveStateGuarded = (source) => {
    const startedAt = Date.now();
    try {
      saveLiveState();
      healthMonitor.recordPersistenceSuccess();
      return true;
    } catch (err) {
      const failures = healthMonitor.recordPersistenceFailure(err.message);
      const durationMs = Date.now() - startedAt;
      logger.error(
        `❌ [${fundLabel}] State save failed from ${source} after ${durationMs}ms (${failures}/${MAX_CONSECUTIVE_PERSISTENCE_FAILURES} consecutive): ${err.message}`,
        { action: 'save-live-state', source, consecutiveFailures: failures, durationMs, error: err.message }
      );
      tradeEvents.emitTradeEvent(
        'error',
        exchange,
        `State save failed (${failures}/${MAX_CONSECUTIVE_PERSISTENCE_FAILURES}) from ${source}: ${err.message}`,
        { action: 'save-live-state', source, consecutiveFailures: failures, pair, error: err.message }
      );
      return false;
    }
  };

  /**
   * Why a state reload must not run right now, or null when it is safe.
   *
   * Fill handlers book a sale in memory (commitSellBooking /
   * recordBuyConsumption) and persist only after awaiting exchange work — the
   * partial body-TP path awaits placeBodyTp, the merge-snapshot path awaits
   * cancelBodyTpOrder. fillLedger.load() inside that window wipes the booking
   * AND the dirty flag, so the handler's later persist() is a no-op and the
   * sale's P&L is lost for good (issue #1407). The ledger is deliberately NOT
   * persisted first instead: that would overwrite the operator's on-disk fix.
   * @returns {string|null}
   */
  const describeReloadBlocker = () => {
    if (engineLocks.isMutatingPosition()) return 'a merge, reconcile, or fill is in progress';
    if (engineLocks.isLadderBusy()) return 'a ladder rebuild, cancel, or cycle reset is in progress';
    if (tpPlacementInFlight.size > 0) return 'a body take-profit placement is in flight';
    if (isExtendInFlight()) return 'a body extend is in progress';
    if (fillLedger.isDirty()) return 'the fill ledger has unsaved in-memory changes';
    return null;
  };

  /**
   * SIGUSR1 handler: re-read regime state and the fill ledger from disk so an
   * operator can apply a manual state fix without restarting the engine.
   *
   * Refused (logged + an `error` trade event, nothing reloaded) while the fund
   * is mutating — see describeReloadBlocker (issue #1407). The operator
   * re-sends the signal once the fund settles.
   *
   * Guarded because a throw from a signal listener is an uncaughtException, and
   * the exact workflow this exists for — hand-editing regime-state.json — is
   * also the one that produces a malformed file. `loadFundRegimeState` throws by
   * design on unreadable/non-object JSON, so a typo used to kill a live trading
   * process (issue #532). It throws BEFORE anything is mutated, which is what
   * makes the reload all-or-nothing: a failed reload leaves in-memory state
   * exactly as it was rather than half-merging RELOADABLE_STATE_FIELDS.
   * @returns {boolean} Whether state was reloaded
   */
  const reloadStateFromDisk = () => {
    const startedAt = Date.now();
    logger.info(`🔄 [${fundLabel}] SIGUSR1 received — reloading state from disk`);
    try {
      // Inside the try: a throw from a signal listener is an uncaughtException.
      const blocker = describeReloadBlocker();
      if (blocker) {
        logger.warn(
          `⏸️ [${fundLabel}] SIGUSR1 state reload deferred — ${blocker}; nothing was reloaded. Re-send SIGUSR1 to retry once the fund settles.`,
          { action: 'sigusr1-reload', deferred: true, reason: blocker, ...engineLocks.getFlags() }
        );
        tradeEvents.emitTradeEvent(
          'error',
          exchange,
          `State reload deferred — ${blocker}; nothing was reloaded. Retry the reload (SIGUSR1) once the fund settles.`,
          { action: 'sigusr1-reload', deferred: true, reason: blocker, pair }
        );
        return false;
      }
      const savedState = loadFundRegimeState(exchange, pair);
      const diskPos = savedState?.position;
      if (!diskPos) {
        logger.warn(`⚠️ [${exchange}] No position in disk state, skipping reload`);
        return false;
      }
      // Merge safe-to-reload fields from disk into in-memory state
      for (const field of RELOADABLE_STATE_FIELDS) {
        if (diskPos[field] !== undefined) {
          const old = positionState[field];
          positionState[field] = diskPos[field];
          logger.info(`   ${field}: ${JSON.stringify(old)} → ${JSON.stringify(diskPos[field])}`);
        }
      }
      // Also reload fill ledger from disk (a live reload keeps in-memory fills
      // on a corrupt file rather than throwing — see fill-ledger.js load()).
      fillLedger.load();
      // load() re-derives the current cycle from its "most recent unsold
      // cycle" heuristic; re-apply the operator's durable boundary (#606/#675).
      restorePersistedCycleId(fillLedger, positionState, logger, exchange);
      logger.info(`✅ [${exchange}] State reloaded from disk in ${Date.now() - startedAt}ms`);
      saveLiveStateGuarded('sigusr1-reload');
      return true;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.error(
        `❌ [${fundLabel}] SIGUSR1 state reload failed after ${durationMs}ms — engine still running on pre-signal state: ${err.message}`,
        { action: 'sigusr1-reload', durationMs, error: err.message }
      );
      tradeEvents.emitTradeEvent(
        'error',
        exchange,
        `State reload failed — engine still running on pre-signal state: ${err.message}`,
        { action: 'sigusr1-reload', pair, error: err.message }
      );
      return false;
    }
  };

  /**
   * Load live state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadLiveState = () => {
    if (isDryRun) return false;

    const savedState = loadFundRegimeState(exchange, pair);
    const pos = savedState.position;
    // Episode markers matter even for an otherwise empty fund.
    restoreEpisodeState(pos);
    // Check if state has any meaningful data (not just default initial state)
    // Even with totalAsset=0, there may be satellites, TP orders, or historical data to restore
    const hasMeaningfulState = pos && (
      pos.totalAsset > 0
      || pos.cyclesCompleted > 0
      || pos.activeTpOrderId
      || (pos.celestialBodies && pos.celestialBodies.length > 0)
      || pos.realizedPnL > 0
      || typeof pos.activeCycleId === 'string'
    );
    if (!hasMeaningfulState) {
      logger.info(`ℹ️ [${exchange}] No saved live state or empty position`);
      // Still restore optimizer states even if no position
      if (savedState.tpOptimizer) {
        tpOptimizer.importState(savedState.tpOptimizer);
      }
      if (savedState.sizeOptimizer) {
        sizeOptimizer.importState(savedState.sizeOptimizer);
      }
      return false;
    }

    replacePositionState({ ...createInitialPositionState(), ...savedState.position });
    if (savedState.regime) {
      regimeDetector.restoreState(savedState.regime);
    }
    if (savedState.tpOptimizer) {
      tpOptimizer.importState(savedState.tpOptimizer);
    }
    if (savedState.sizeOptimizer) {
      sizeOptimizer.importState(savedState.sizeOptimizer);
    }

    logger.info(`📂 [${exchange}] Loaded saved state: ${positionState.cyclesCompleted} cycles, buys ${positionState.cycleBuys}, ${positionState.totalAsset.toFixed(6)} ${baseCurrency}`);
    return true;
  };

  return {
    snapshotDryRunState, saveDryRunState, saveDryRunStateGuarded, loadDryRunState,
    refreshRealizedFromCyclePairs, syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
    saveLiveState, saveLiveStateGuarded, describeReloadBlocker, reloadStateFromDisk, loadLiveState,
  };
};

module.exports = { createEngineStatePersistence, RELOADABLE_STATE_FIELDS };
