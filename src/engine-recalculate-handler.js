// @ts-check
/**
 * Engine IPC handler: `regime:recalculate`.
 *
 * Extracted from engines/coinbase-engine.js (issue #505) so the
 * preview-vs-apply / live-vs-stopped selection this handler enforces — never
 * mutating the ledger on a running-engine preview, delegating a running-
 * engine apply to the engine's own `recalculateAndRefresh` (never opening a
 * second ledger writer on the same file), and preserving order/lifecycle/
 * body fields on a stopped apply (only derived accounting fields are
 * replaced) — can be exercised directly against the real production
 * callback instead of only through the read-only fill-ledger helper tests
 * (which never invoke this handler) or the HTTP-route tests (which mock IPC
 * entirely). Behavior is unchanged from the inline handler this replaces;
 * every dependency below is injected so `regime:recalculate` for other
 * exchange processes (gemini, cryptocom) keeps working unmodified.
 *
 * P&L source of truth is the cycle-pair derivation (realizedPnL = Σ per-sell
 * bodyPnl; realizedAssetPnL = Σ bodyHoldbackAsset). NOT FIFO globals and NOT
 * closed-trades — both over-count (closed-trades prorates buy cost by sold
 * qty, leaving holdback cost unattributed; FIFO ignores cycle boundaries).
 * See docs/pnl-architecture.md.
 */

/**
 * @typedef {Object} EngineRecalculateDeps
 * @property {Map<string, Object>} regimeEngines - Active regime engines keyed by `${exchange}::${pair}`
 * @property {(exchange: string, pair: string) => string} resolvePair - Resolves an IPC pair to its configured fund pair; throws on an invalid pair
 * @property {(exchange: string, pair: string) => string} fundKey - Composes the `${exchange}::${pair}` registry key
 * @property {(payload: Object, field: string, defaultValue: boolean) => {value?: boolean, error?: string}} readBooleanFlag - Strict boolean flag parser (rejects non-boolean values, e.g. the string "false")
 * @property {(exchange: string, pair: string) => {position?: Object, regime?: Object, tpOptimizer?: Object, sizeOptimizer?: Object}} loadRegimeState - Loads on-disk regime state for a fund
 * @property {(position: Object, regime: Object, exchange: string, tpOptimizer: Object, sizeOptimizer: Object, pair: string) => void} saveRegimeState - Persists regime state to disk
 * @property {(exchange: string, pair: string) => void} invalidateStandaloneLedger - Drops the cached standalone fill ledger for a fund
 * @property {(exchange: string, pair: string) => Object} getStandaloneLedger - Loads (or returns the cached) standalone fill ledger for a fund; throws on cold-start ledger corruption
 */

/**
 * Register the `regime:recalculate` IPC request handler on a registry (the
 * engine's IPC server, or any object exposing the same
 * `onRequest(channel, handler)` surface — e.g. a fake registrar in tests).
 *
 * @param {{onRequest: (channel: string, handler: (payload: any, exchange: string, pair: string) => Promise<any>) => void}} registry
 * @param {EngineRecalculateDeps} deps
 */
const registerEngineRecalculateHandler = (registry, deps) => {
  const {
    regimeEngines,
    resolvePair,
    fundKey,
    readBooleanFlag,
    loadRegimeState,
    saveRegimeState,
    invalidateStandaloneLedger,
    getStandaloneLedger,
  } = deps;

  registry.onRequest('regime:recalculate', async (payload, exchange, pair) => {
    const resolvedPair = resolvePair(exchange, pair);
    // Reject before any ledger/store read so a direct IPC caller (bypassing
    // the gateway route's own validation) cannot flip a preview into an
    // apply with a non-boolean value such as the string "false".
    const applyFlag = readBooleanFlag(payload, 'apply', false);
    if (applyFlag.error) return { success: false, error: applyFlag.error };
    const apply = applyFlag.value;

    const currentState = loadRegimeState(exchange, resolvedPair);
    const before = {
      cyclesCompleted: currentState.position?.cyclesCompleted || 0,
      realizedPnL: currentState.position?.realizedPnL || 0,
      realizedAssetPnL: currentState.position?.realizedAssetPnL || 0,
    };

    const engine = regimeEngines.get(fundKey(exchange, resolvedPair));

    // When the engine is running, recompute on ITS ledger and re-derive in
    // place so we never (a) open a second ledger on the same file, (b)
    // write a FIFO/closed-trades number to disk, or (c) blind-merge a
    // rebuilt position that nulls activeTpOrderId / resurrects stale
    // bodies (issue #96).
    let result;
    if (engine?.recalculateAndRefresh) {
      if (!apply) {
        // Preview only: derive P&L read-only via getDerivedRealizedPnL, and
        // full per-cycle detail + orphan-fix count via
        // previewRecalculateCycles — both are side-effect-free (issue
        // #132). The full recalculateCycles() mutates the live ledger
        // (stamps orphan cycleIds, sets the dirty flag), which we must NOT
        // do during a preview the operator may cancel (the engine's
        // periodic save could persist an unapplied recalc).
        const fillLedger = engine.getFillLedger();
        const derived = fillLedger.getDerivedRealizedPnL();
        const preview = fillLedger.previewRecalculateCycles();
        const cycleFills = fillLedger.getCurrentCycleFills();
        result = {
          cyclesCompleted: preview.cyclesCompleted,
          realizedPnL: derived.realizedPnL,
          realizedAssetPnL: derived.realizedAssetPnL,
          cycleDetails: preview.cycleDetails,
          orphansFixed: preview.orphansFixed,
          activeCycleId: preview.activeCycleId,
          currentCycleFills: cycleFills.length,
        };
      } else {
        const r = engine.recalculateAndRefresh();
        result = { ...r, currentCycleFills: engine.getFillLedger().getCurrentCycleFills().length };
      }
    } else {
      // Engine not running — operate on the standalone ledger directly.
      invalidateStandaloneLedger(exchange, resolvedPair);
      let fillLedger;
      try {
        fillLedger = getStandaloneLedger(exchange, resolvedPair);
      } catch (err) {
        return { success: false, error: err.message };
      }
      const recalc = fillLedger.recalculateCycles();
      const derived = fillLedger.getDerivedRealizedPnL();
      const cycleFills = fillLedger.getCurrentCycleFills();
      result = {
        cyclesCompleted: recalc.cyclesCompleted,
        realizedPnL: derived.realizedPnL,
        realizedAssetPnL: derived.realizedAssetPnL,
        cycleDetails: recalc.cycleDetails,
        orphansFixed: recalc.orphansFixed,
        activeCycleId: recalc.activeCycleId,
        currentCycleFills: cycleFills.length,
      };

      if (apply) {
        // Persist ONLY the cycle-derived P&L fields onto the existing
        // position — do not rebuild/overwrite order tracking, lifecycle,
        // or bodies.
        const position = {
          ...currentState.position,
          cyclesCompleted: recalc.cyclesCompleted,
          realizedPnL: derived.realizedPnL,
          realizedAssetPnL: derived.realizedAssetPnL,
          heldAssetCostBasis: derived.heldOpenBuyCostBasis,
        };
        if (position.celestialState) {
          position.celestialState = {
            ...position.celestialState,
            bodiesRealizedPnL: derived.realizedPnL,
            bodiesRealizedAssetPnL: derived.realizedAssetPnL,
          };
        }
        saveRegimeState(position, currentState.regime, exchange, currentState.tpOptimizer, currentState.sizeOptimizer, resolvedPair);
        fillLedger.persist();
      }
    }

    const changes = {
      cyclesCompleted: { before: before.cyclesCompleted, after: result.cyclesCompleted },
      realizedPnL: { before: before.realizedPnL, after: result.realizedPnL },
      realizedAssetPnL: { before: before.realizedAssetPnL, after: result.realizedAssetPnL },
    };

    return {
      success: true, exchange, pair: resolvedPair, applied: apply, changes,
      cycleDetails: result.cycleDetails,
      orphansFixed: result.orphansFixed,
      activeCycleId: result.activeCycleId,
      currentCycleFills: result.currentCycleFills,
    };
  });
};

module.exports = { registerEngineRecalculateHandler };
