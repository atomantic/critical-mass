// @ts-check
// Regime fund state: lifecycle constants, initial shapes, legacy-field
// migrations and the load/save entry points (split out of the former
// state-tracker facade). File I/O and the per-file save-version bookkeeping that
// saveRegimeState's optimistic locking depends on live in fund-state-storage,
// which loadRegimeState/saveRegimeState here delegate to.

/**
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 * @typedef {import('./types').RegimeState} RegimeState
 */

const { createInitialCelestialState, migrateFromLegacy } = require('./celestial-hierarchy');
const { DEFAULT_MAX_USDC_DEPLOYED } = require('./fund-defaults');
const fundStateStorage = require('./fund-state-storage');
const { getRegimeStateFile, saveRegimeState } = fundStateStorage;


/**
 * Fund lifecycle states. The operator drives transitions:
 *   ACTIVE → DRAINING (operator clicks Close): block new entries, leave TP in place
 *   DRAINING → CLOSED (TP fills): engine auto-stops
 *   CLOSED → ACTIVE (operator clicks Reopen): allows engine to start again
 */
const LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  DRAINING: 'draining',
  CLOSED: 'closed',
});

/**
 * Single definition of the DRAINING -> CLOSED auto-close rule: a draining
 * fund with no asset and no celestial bodies is closed. Mutates `position`
 * (lifecycle, lifecycleChangedAt, lifecycleClosedCycle); callers persist.
 * @param {object|null} position
 * @param {number} [now]
 * @returns {boolean} true if the position was transitioned to CLOSED
 */
const closeDrainedEmptyPosition = (position, now = Date.now()) => {
  if (!position || position.lifecycle !== LIFECYCLE.DRAINING) return false;
  const hasPosition = (position.totalAsset || 0) > 0 || (position.celestialBodies || []).length > 0;
  if (hasPosition) return false;
  position.lifecycle = LIFECYCLE.CLOSED;
  position.lifecycleChangedAt = now;
  position.lifecycleClosedCycle = position.cyclesCompleted || 0;
  return true;
};


// ============================================================================
// Regime State Management
// ============================================================================

/**
 * Create initial regime position state
 * @returns {RegimePositionState}
 */
const createInitialRegimePositionState = () => ({
  totalAsset: 0,
  totalCostBasis: 0,
  avgCostBasis: 0,
  cycleBuys: 0,
  // Durable operator-selected cycle boundary. Null preserves the fill-ledger
  // heuristic for state files written before cycle resets became persistent.
  activeCycleId: null,
  // When that cycle began (ms). Bounds which null-cycle fills recalculateCycles
  // may fold into it (#705); null = unknown (falls back to its earliest fill).
  activeCycleStartedAt: null,
  // Sell order id of a body TP that closed the last body and still owes its
  // cycle reset (#766); a retry of that fill completes the reset from it.
  pendingCycleResetFor: null,
  lastEntryPrice: 0,
  lastEntryTime: 0,
  anchorPrice: 0,
  activeTpOrderId: null,
  lastTpPrice: 0,
  cyclesCompleted: 0,
  unrealizedPnL: 0,
  realizedPnL: 0,
  realizedAssetPnL: 0,
  assetOnOrder: 0,
  maxDrawdownSeen: 0,
  drawdownGuard: null,      // risk-manager drawdown tracker snapshot (peak, pause) — survives restarts
  scalingDisabled: false,
  scalingDisabledReason: null,
  // APY tracking fields
  engineStartTime: null,
  initialCapital: 0,
  originalCapital: 0,       // DEPRECATED: use depositedCapital instead
  depositedCapital: 0,      // Total user deposits (excludes profits) - updated when user adds capital
  // Pending entry orders (persisted across restarts)
  pendingEntryOrders: [],
  // Ladder mode state
  ladderActive: false,
  ladderPlacedAt: null,
  ladderLowerBound: 0,
  pendingLadderOrders: [],  // [{orderId, price, sizeUsdc, ladderIndex}]
  // Legacy satellite fields removed — migrated into celestialState on load
  // Celestial Hierarchy state
  celestialBodies: [],          // CelestialBody[]
  celestialState: {
    bodiesCompleted: 0,
    bodiesRealizedPnL: 0,
    bodiesRealizedAssetPnL: 0,
    stateVersion: 1,
  },
  // Macro regime state (persisted for recovery)
  macroRegime: null,
  // Fund lifecycle — see LIFECYCLE constant exported from this module
  lifecycle: LIFECYCLE.ACTIVE,
  lifecycleChangedAt: null,
  lifecycleReason: null,
  lifecycleClosedCycle: null,
});

/**
 * Create initial regime state
 * @returns {RegimeState}
 */
const createInitialRegimeState = () => ({
  mode: 'HARVEST',
  since: Date.now(),
  transitionCount: 0,
  trendDirection: null,
  lastVolExpansion: 1.0,
  lastMomentumMag: 0,
  trendConfirmationCount: 0,
});

// Old BTC-named keys on disk. Names are built by concatenation so refactoring
// scripts do not rename them; this table is the only place they are spelled.
const legacyKey = (prefix, suffix) => prefix + suffix;
const LEGACY_FIELD_RENAMES = {
  position: [
    [legacyKey('total', 'BTC'), 'totalAsset'],
    [legacyKey('realizedBtc', 'PnL'), 'realizedAssetPnL'],
    [legacyKey('maxBtc', 'Exposure'), 'maxAssetExposure'],
    [legacyKey('btcOn', 'Order'), 'assetOnOrder'],
  ],
  celestialState: [
    [legacyKey('bodiesRealizedBtc', 'PnL'), 'bodiesRealizedAssetPnL'],
  ],
  celestialBody: [
    [legacyKey('btc', 'Qty'), 'assetQty'],
    [legacyKey('btcOn', 'Order'), 'assetOnOrder'],
  ],
};

const renameLegacyFields = (obj, pairs) => {
  for (const [oldKey, newKey] of pairs) {
    if (oldKey in obj) {
      obj[newKey] = obj[oldKey];
      delete obj[oldKey];
    }
  }
};

// Mutates parsed regime-state data in place: ladderStep -> cycleBuys and the
// BTC-named -> asset-agnostic renames on position, celestialState and each body.
const migrateLegacyPositionFields = (data) => {
  const p = data.position;
  if (!p) return;
  if (p.ladderStep !== undefined && p.cycleBuys === undefined) {
    p.cycleBuys = p.ladderStep;
    delete p.ladderStep;
  }
  renameLegacyFields(p, LEGACY_FIELD_RENAMES.position);
  if (p.celestialState) renameLegacyFields(p.celestialState, LEGACY_FIELD_RENAMES.celestialState);
  for (const body of p.celestialBodies || []) renameLegacyFields(body, LEGACY_FIELD_RENAMES.celestialBody);
};

/** Apply domain migrations to a loaded regime position, without writing. */
const migrateRegimePosition = (position, { exchange, pair, stateFile, logger }) => {
  // Fold legacy satellite* counters into celestialState (one-time migration)
  if (position.satellitesCompleted || position.satelliteRealizedPnL || position.satelliteRealizedBtcPnL) {
    const cs = position.celestialState || createInitialCelestialState();
    cs.bodiesCompleted = (cs.bodiesCompleted || 0) + (position.satellitesCompleted || 0);
    cs.bodiesRealizedPnL = (cs.bodiesRealizedPnL || 0) + (position.satelliteRealizedPnL || 0);
    cs.bodiesRealizedAssetPnL = (cs.bodiesRealizedAssetPnL || 0) + (position.satelliteRealizedBtcPnL || 0);
    position.celestialState = cs;
    delete position.satellitesCompleted;
    delete position.satelliteRealizedPnL;
    delete position.satelliteRealizedBtcPnL;
    logger.info(`🔄 Folded legacy satellite counters into celestialState`, {
      stateFile,
      migration: 'legacy-satellite-counters',
    });
  }

  // Migrate legacy core+satellite state to celestial bodies if needed
  if (!position.celestialBodies || position.celestialBodies.length === 0) {
    const hasCorePosition = position.totalAsset > 0 && position.totalCostBasis > 0;
    const hasSatellites = position.satelliteTpOrders && position.satelliteTpOrders.length > 0;

    if (hasCorePosition || hasSatellites) {
      const configUtils = require('./config-utils');
      const regimeConfig = configUtils.getRegimeConfig(exchange, pair);
      const maxUsdcDeployed = regimeConfig.maxUsdcDeployed || DEFAULT_MAX_USDC_DEPLOYED;

      position.celestialBodies = migrateFromLegacy(position, maxUsdcDeployed);
      if (!position.celestialState) {
        position.celestialState = {
          bodiesCompleted: position.cyclesCompleted || 0,
          bodiesRealizedPnL: position.realizedPnL || 0,
          bodiesRealizedAssetPnL: position.realizedAssetPnL || 0,
          stateVersion: 1,
        };
      }

      const coreCount = hasCorePosition ? 1 : 0;
      const satCount = hasSatellites ? position.satelliteTpOrders.length : 0;
      logger.info(`🔄 Migrated ${coreCount} core + ${satCount} satellites → ${position.celestialBodies.length} celestial bodies`, {
        stateFile,
        migration: 'legacy-celestial-bodies',
        coreCount,
        satelliteCount: satCount,
        bodyCount: position.celestialBodies.length,
      });
    } else {
      position.celestialBodies = [];
      position.celestialState = position.celestialState || createInitialCelestialState();
    }
  }

  // Clean up legacy satellite fields from position (no longer used)
  delete position.satelliteTpOrders;
  delete position.satellitesCompleted;
  delete position.satelliteRealizedPnL;
  delete position.satelliteRealizedBtcPnL;
};

/**
 * Load regime state from file
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {{position: RegimePositionState, regime: RegimeState, tpOptimizer?: Object, sizeOptimizer?: Object}}
 */
const loadRegimeState = (exchange = 'coinbase', pair) =>
  fundStateStorage.loadRegimeState(exchange, pair, {
    createInitialRegimePositionState, createInitialRegimeState,
    migrateLegacyPositionFields, migrateRegimePosition,
  });

const loadFundRegimeState = (exchange, pair) => {
  if (!pair) throw new Error('loadFundRegimeState requires an explicit pair');
  return loadRegimeState(exchange, pair);
};

/**
 * Non-throwing wrapper around `loadRegimeState` for callers that must survive a
 * corrupt state file rather than die on it (issue #532).
 *
 * `loadRegimeState` throws by design on unreadable/non-object JSON (issue #108)
 * so nothing boots on top of a zeroed position. That is right for trading and
 * wrong for reporting and for process supervision: an IPC handler would surface
 * the throw as an unstructured exception, and the engine's startup path would
 * exit(1) into a PM2 restart loop against the very same file — burning the
 * restart budget in under a minute while resting orders sit on the exchange
 * with no process watching them.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {{state: Object|null, error: string|null}} State, or the operator-facing repair message
 */
const loadRegimeStateSafe = (exchange, pair) => {
  try {
    return { state: loadRegimeState(exchange, pair), error: null };
  } catch (err) {
    return { state: null, error: err.message };
  }
};

/**
 * Save the named state bundle for one explicitly identified fund.
 * @param {string} exchange - Exchange name
 * @param {string} pair - Required pair name
 * @param {{position: Object, regime: Object, tpOptimizer?: Object|null, sizeOptimizer?: Object|null}} state - Fund state bundle
 */
const saveFundRegimeState = (exchange, pair, { position, regime, tpOptimizer = null, sizeOptimizer = null }) => {
  if (!pair) throw new Error('saveFundRegimeState requires an explicit pair');
  return saveRegimeState(position, regime, exchange, tpOptimizer, sizeOptimizer, pair);
};

module.exports = {
  LIFECYCLE,
  closeDrainedEmptyPosition,
  getRegimeStateFile,
  createInitialRegimePositionState,
  createInitialRegimeState,
  loadRegimeState,
  loadFundRegimeState,
  loadRegimeStateSafe,
  saveRegimeState,
  saveFundRegimeState,
};
