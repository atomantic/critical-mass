// @ts-check
/**
 * Dry-Run State Persistence
 *
 * Saves and loads dry-run simulation state to survive server restarts.
 * State is stored per-exchange in a JSON file.
 */

const fs = require('fs');
const path = require('path');
const { createContextLogger } = require('./logger');

const dryRunStateLogger = createContextLogger({ module: 'dry-run-state' });

const STATE_FILE = path.join(__dirname, '..', 'dry-run-state.json');
const SAVE_DEBOUNCE_MS = 5000; // Debounce saves to avoid excessive disk writes

let pendingSave = null;
let lastSaveTime = 0;
/** @type {Map<string, ExchangeDryRunState>} */
const pendingStates = new Map();

/**
 * @typedef {Object} DryRunExecutorState
 * @property {Array} pendingOrders - Pending orders array
 * @property {Array} filledOrders - Filled orders array
 * @property {string|null} activeTpOrderId - Active TP order ID
 * @property {number} lastTpPrice - Last TP price
 * @property {number} lastTpSize - Last TP size
 * @property {number} simulatedRealizedPnL - Realized USD P&L
 * @property {number} simulatedRealizedAssetPnL - Realized BTC P&L (holdback)
 * @property {number} simulatedTotalBought - Total BTC bought
 * @property {number} simulatedTotalSold - Total BTC sold
 * @property {Object|null} currentCycleTracking - Current cycle tracking data
 * @property {Array} cycleAnalytics - Cycle analytics history
 * @property {number} orderIdCounter - Order ID counter
 */

/**
 * @typedef {Object} PositionState
 * @property {number} totalAsset - Total BTC position
 * @property {number} totalCostBasis - Total cost basis in USD
 * @property {number} avgCostBasis - Average cost basis per BTC
 * @property {number} cycleBuys - Current ladder step
 * @property {number} lastEntryPrice - Last entry price
 * @property {number} lastEntryTime - Last entry timestamp
 * @property {number} anchorPrice - Anchor price for volatility trigger
 * @property {string|null} activeTpOrderId - Active TP order ID
 * @property {number} lastTpPrice - Last TP price
 * @property {number} cyclesCompleted - Number of completed cycles
 * @property {number} unrealizedPnL - Unrealized P&L
 * @property {number} realizedPnL - Realized P&L
 * @property {number} realizedAssetPnL - Realized BTC P&L
 * @property {number} assetOnOrder - BTC on open orders
 * @property {number} maxDrawdownSeen - Max drawdown seen
 * @property {boolean} scalingDisabled - Whether scaling is disabled
 * @property {string|null} scalingDisabledReason - Reason scaling is disabled
 * @property {number|null} engineStartTime - Timestamp when engine first started with capital
 * @property {number} initialCapital - Initial capital (maxUsdcDeployed from config)
 */

/**
 * @typedef {Object} ExchangeDryRunState
 * @property {boolean} isDryRun - Whether dry-run mode is enabled
 * @property {DryRunExecutorState} executor - Executor state
 * @property {PositionState} position - Position state
 * @property {number} savedAt - Timestamp when saved
 */

/**
 * @typedef {Object} AllDryRunState
 * @property {Object.<string, ExchangeDryRunState>} exchanges - State per exchange
 * @property {number} version - State version for migration
 */

const STATE_VERSION = 1;

/**
 * Load all dry-run state from disk
 * @returns {AllDryRunState}
 */
const loadAllState = () => {
  if (!fs.existsSync(STATE_FILE)) {
    return { exchanges: {}, version: STATE_VERSION };
  }

  let state;
  // A corrupt state file must not crash the process — this runs from a
  // debounced setTimeout flush as well as on load. But returning empty would
  // let the next save overwrite the file, silently dropping every other fund's
  // dry-run state — so quarantine the bad file aside for manual recovery first.
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    const quarantinePath = `${STATE_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(STATE_FILE, quarantinePath);
    dryRunStateLogger.warn(`⚠️ Dry-run state unreadable (${err.message}) — quarantined to ${path.basename(quarantinePath)}, starting fresh`, {
      stateFile: STATE_FILE,
      quarantinePath,
      error: err.message,
    });
    return { exchanges: {}, version: STATE_VERSION };
  }

  // Version check for future migrations
  if (state.version !== STATE_VERSION) {
    dryRunStateLogger.warn(`⚠️ Dry-run state version mismatch (${state.version} vs ${STATE_VERSION}), starting fresh`, {
      stateFile: STATE_FILE,
      actualVersion: state.version,
      expectedVersion: STATE_VERSION,
    });
    return { exchanges: {}, version: STATE_VERSION };
  }

  return state;
};

/**
 * Save all state to disk
 * @param {AllDryRunState} state - State to save
 */
const saveAllState = (state) => {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

/**
 * Flush every queued fund in `pendingStates` to disk in a single pass, stamping
 * each with `now`, then empty the queue. Shared by the debounce timer, the
 * immediate save branch, and forceSave so none of them can strand a fund that
 * was queued by an earlier debounced call (#159).
 * @returns {number} how many funds were flushed
 */
const flushPendingStates = () => {
  const now = Date.now();
  const allState = loadAllState();
  const fundCount = pendingStates.size;
  for (const [k, state] of pendingStates) {
    allState.exchanges[k] = {
      ...state,
      savedAt: now,
    };
  }
  pendingStates.clear();
  saveAllState(allState);
  return fundCount;
};

const { fundKey: composeFundKey } = require('./shared-utils');

// Compose the key for the per-fund slot inside the dry-run state file.
// Legacy single-fund installations stored state under bare exchange names;
// for backwards compat we still write that form when no pair is provided
// (older callers won't break) — but new callers always pass a pair and get
// a proper composite key.
const fundKey = (exchange, pair) => (pair ? composeFundKey(exchange, pair) : exchange);

/**
 * Load dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {ExchangeDryRunState|null}
 */
const loadState = (exchange, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair, module: 'dry-run-state' });
  const allState = loadAllState();
  const exchangeState = allState.exchanges[key];

  if (!exchangeState) {
    logger.info(`ℹ️ [${key}] No saved dry-run state found`, { fundKey: key, stateFile: STATE_FILE });
    return null;
  }

  // Check if state is stale (older than 7 days)
  const ageMs = Date.now() - exchangeState.savedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > 7) {
    logger.warn(`⚠️ [${key}] Dry-run state is ${ageDays.toFixed(1)} days old, discarding`, {
      fundKey: key,
      stateFile: STATE_FILE,
      ageDays,
      savedAt: exchangeState.savedAt,
    });
    return null;
  }

  logger.info(`📂 [${key}] Loaded dry-run state from ${new Date(exchangeState.savedAt).toISOString()}`, {
    fundKey: key,
    stateFile: STATE_FILE,
    savedAt: exchangeState.savedAt,
  });
  return exchangeState;
};

/**
 * Save dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {ExchangeDryRunState} exchangeState - State to save
 * @param {string} [pair] - Pair name
 */
const saveState = (exchange, exchangeState, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair, module: 'dry-run-state' });
  // Always store the latest state for this fund
  pendingStates.set(key, exchangeState);

  // Debounce saves
  const now = Date.now();
  if (now - lastSaveTime < SAVE_DEBOUNCE_MS) {
    // Schedule a save if not already pending
    if (!pendingSave) {
      pendingSave = setTimeout(() => {
        pendingSave = null;
        const fundCount = flushPendingStates();
        lastSaveTime = Date.now();
        logger.info(`💾 Dry-run state saved for ${fundCount} fund(s)`, {
          fundKey: key,
          stateFile: STATE_FILE,
          fundCount,
          saveMode: 'debounced',
        });
      }, SAVE_DEBOUNCE_MS);
    }
    return;
  }

  lastSaveTime = now;

  // Cancel any scheduled debounce flush: we're about to write synchronously, so
  // a stale timer would later flush an emptied pendingStates map (a no-op) while
  // believing it still had work to do.
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  // Flush EVERY queued fund (this one is already queued above), not just the
  // current key. Clearing pendingStates without writing them — the old behavior —
  // dropped any fund queued by an earlier debounced call (issue #159).
  const fundCount = flushPendingStates();
  logger.info(`💾 [${key}] Dry-run state saved (${fundCount} fund(s))`, {
    fundKey: key,
    stateFile: STATE_FILE,
    fundCount,
    saveMode: 'immediate',
  });
};

/**
 * Clear dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 */
const clearState = (exchange, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair, module: 'dry-run-state' });

  // A debounced snapshot for this fund must not survive an explicit reset.
  // Otherwise the pending timer can flush the pre-reset state back to disk
  // after this deletion and resurrect simulated orders/P&L on restart.
  pendingStates.delete(key);
  if (pendingStates.size === 0 && pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  const allState = loadAllState();
  delete allState.exchanges[key];
  saveAllState(allState);
  logger.info(`🗑️ [${key}] Dry-run state cleared`, { fundKey: key, stateFile: STATE_FILE });
};

/**
 * Force immediate save (bypass debounce)
 * @param {string} exchange - Exchange name
 * @param {ExchangeDryRunState} exchangeState - State to save
 * @param {string} [pair] - Pair name
 */
const forceSave = (exchange, exchangeState, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair, module: 'dry-run-state' });
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  // Queue this fund's fresh snapshot, then flush the whole queue — cancelling the
  // timer above would otherwise strand any fund queued by an earlier debounced
  // call (issue #159). Setting it last lets it win over any stale queued entry.
  pendingStates.set(key, exchangeState);
  flushPendingStates();
  logger.info(`💾 [${key}] Dry-run state force saved`, {
    fundKey: key,
    stateFile: STATE_FILE,
    saveMode: 'forced',
  });
};

module.exports = {
  loadState,
  saveState,
  clearState,
  forceSave,
  STATE_FILE,
};
