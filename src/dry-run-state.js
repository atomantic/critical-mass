// @ts-check
/**
 * Dry-Run State Persistence
 *
 * Saves and loads dry-run simulation state to survive server restarts.
 * State is stored per-exchange in a JSON file.
 */

const fs = require('fs');
const path = require('path');

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

  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const state = JSON.parse(raw);

  // Version check for future migrations
  if (state.version !== STATE_VERSION) {
    console.log(`⚠️ Dry-run state version mismatch (${state.version} vs ${STATE_VERSION}), starting fresh`);
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

// Compose a key for the per-fund slot inside the dry-run state file.
// Backwards-compat: when pair is omitted, the key is just the exchange name
// (legacy single-fund installations continue to load/save state under their
// pre-multipair key).
const fundKey = (exchange, pair) => (pair ? `${exchange}::${pair}` : exchange);

/**
 * Load dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {ExchangeDryRunState|null}
 */
const loadState = (exchange, pair) => {
  const key = fundKey(exchange, pair);
  const allState = loadAllState();
  const exchangeState = allState.exchanges[key];

  if (!exchangeState) {
    console.log(`ℹ️ [${key}] No saved dry-run state found`);
    return null;
  }

  // Check if state is stale (older than 7 days)
  const ageMs = Date.now() - exchangeState.savedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > 7) {
    console.log(`⚠️ [${key}] Dry-run state is ${ageDays.toFixed(1)} days old, discarding`);
    return null;
  }

  console.log(`📂 [${key}] Loaded dry-run state from ${new Date(exchangeState.savedAt).toISOString()}`);
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
  // Always store the latest state for this fund
  pendingStates.set(key, exchangeState);

  // Debounce saves
  const now = Date.now();
  if (now - lastSaveTime < SAVE_DEBOUNCE_MS) {
    // Schedule a save if not already pending
    if (!pendingSave) {
      pendingSave = setTimeout(() => {
        pendingSave = null;
        // Flush all pending states
        const allState = loadAllState();
        const fundCount = pendingStates.size;
        for (const [k, state] of pendingStates) {
          allState.exchanges[k] = {
            ...state,
            savedAt: Date.now(),
          };
        }
        pendingStates.clear();
        saveAllState(allState);
        lastSaveTime = Date.now();
        console.log(`💾 Dry-run state saved for ${fundCount} fund(s)`);
      }, SAVE_DEBOUNCE_MS);
    }
    return;
  }

  lastSaveTime = now;
  pendingStates.clear();

  const allState = loadAllState();
  allState.exchanges[key] = {
    ...exchangeState,
    savedAt: now,
  };
  saveAllState(allState);
  console.log(`💾 [${key}] Dry-run state saved`);
};

/**
 * Clear dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 */
const clearState = (exchange, pair) => {
  const key = fundKey(exchange, pair);
  const allState = loadAllState();
  delete allState.exchanges[key];
  saveAllState(allState);
  console.log(`🗑️ [${key}] Dry-run state cleared`);
};

/**
 * Force immediate save (bypass debounce)
 * @param {string} exchange - Exchange name
 * @param {ExchangeDryRunState} exchangeState - State to save
 * @param {string} [pair] - Pair name
 */
const forceSave = (exchange, exchangeState, pair) => {
  const key = fundKey(exchange, pair);
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  const allState = loadAllState();
  allState.exchanges[key] = {
    ...exchangeState,
    savedAt: Date.now(),
  };
  saveAllState(allState);
  console.log(`💾 [${key}] Dry-run state force saved`);
};

module.exports = {
  loadState,
  saveState,
  clearState,
  forceSave,
  STATE_FILE,
};
