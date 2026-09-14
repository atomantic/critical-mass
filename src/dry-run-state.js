// @ts-check
/**
 * Dry-Run State Persistence
 *
 * Saves and loads dry-run simulation state to survive server restarts.
 *
 * State lives with every other per-fund artifact, at
 * `data/<exchange>/<pair>/dry-run-state.json` — inside the mounted data
 * directory, so it survives a container recreate, lands in backups and comes
 * back from a restore. It used to live at `<app root>/dry-run-state.json`:
 * outside the volume, outside backups, and shared by every engine process,
 * which made concurrent read-modify-write saves lose each other's updates
 * (issue #531). One file per fund means each process only ever writes the
 * funds it owns, so no cross-process merge and no lock is needed.
 *
 * A legacy root file is imported lazily, per fund, on first read and is never
 * deleted — it stays as the operator's fallback, the same way `migrateKeys`
 * leaves `keys.json` in place.
 */

const fs = require('fs');
const path = require('path');
const { resolveFundDataDir, getFundDataDir } = require('./migration');
const { atomicWriteSync } = require('./state-tracker');
const { fundKey: composeFundKey } = require('./shared-utils');
const { createContextLogger } = require('./logger');

const dryRunStateLogger = createContextLogger();

const STATE_FILENAME = 'dry-run-state.json';
const APP_ROOT = path.join(__dirname, '..');
/** Pre-#531 location: a single file for every fund, outside the data directory. */
const LEGACY_STATE_FILE = path.join(APP_ROOT, STATE_FILENAME);
const SAVE_DEBOUNCE_MS = 5000; // Debounce saves to avoid excessive disk writes

let pendingSave = null;
let lastSaveTime = 0;
/** @type {Map<string, {exchange: string, pair: string|undefined, state: ExchangeDryRunState}>} */
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
 * On-disk envelope for one fund. `state: null` is a tombstone written by
 * clearState — it records "this fund was deliberately reset" so a later read
 * does NOT fall back to importing a stale slot out of the legacy root file.
 * @typedef {Object} FundStateFile
 * @property {number} version - State version for migration
 * @property {ExchangeDryRunState|null} state - The fund's state, or null when cleared
 */

/**
 * Legacy (pre-#531) root file: every fund in one `exchanges` map.
 * @typedef {Object} LegacyAllDryRunState
 * @property {Object.<string, ExchangeDryRunState>} exchanges - State per fund key
 * @property {number} version - State version for migration
 */

const STATE_VERSION = 1;
const STALE_STATE_DAYS = 7;

// Compose the key identifying a fund in logs (and in the legacy root file).
// Legacy single-fund installations stored state under bare exchange names;
// callers that pass no pair still get that form so their log context is stable.
const fundKey = (exchange, pair) => (pair ? composeFundKey(exchange, pair) : exchange);

/**
 * Resolve the per-fund state file PATH without creating anything. Read side.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string}
 */
const getStateFile = (exchange, pair) => path.join(resolveFundDataDir(exchange, pair), STATE_FILENAME);

/**
 * Read + validate one fund's on-disk envelope.
 * @param {string} stateFile - Path to the fund's state file
 * @param {string} key - Fund key, for log context
 * @param {{info: Function, warn: Function}} logger - Context logger
 * @returns {ExchangeDryRunState|null} The fund's state, or null when absent/cleared/unusable
 */
const readFundStateFile = (stateFile, key, logger) => {
  /** @type {FundStateFile} */
  let payload;
  // A corrupt state file must not crash the process — this also runs from a
  // debounced setTimeout flush. Quarantine it rather than leaving it in place
  // for the next save to overwrite, so the operator can still recover it.
  try {
    payload = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
    fs.renameSync(stateFile, quarantinePath);
    logger.warn(`⚠️ [${key}] Dry-run state unreadable (${err.message}) — quarantined to ${path.basename(quarantinePath)}, starting fresh`, {
      fundKey: key,
      stateFile,
      quarantinePath,
      error: err.message,
    });
    return null;
  }

  // Version check for future migrations
  if (payload?.version !== STATE_VERSION) {
    logger.warn(`⚠️ [${key}] Dry-run state version mismatch (${payload?.version} vs ${STATE_VERSION}), starting fresh`, {
      fundKey: key,
      stateFile,
      actualVersion: payload?.version ?? null,
      expectedVersion: STATE_VERSION,
    });
    return null;
  }

  return payload.state ?? null;
};

/**
 * Write one fund's envelope atomically (temp file + rename), creating the fund
 * directory if needed. A torn write can no longer strand unparseable JSON, and
 * it can never take another fund down with it.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 * @param {ExchangeDryRunState|null} [state] - State to persist, or null for a tombstone
 * @returns {string} The file written
 */
const writeFundStateFile = (exchange, pair, state = null) => {
  const stateFile = path.join(getFundDataDir(exchange, pair), STATE_FILENAME);
  atomicWriteSync(stateFile, JSON.stringify({ version: STATE_VERSION, state }, null, 2));
  return stateFile;
};

/**
 * Read the legacy root file's fund map, or null when there is nothing usable.
 * The legacy file is never renamed or deleted here — it is the operator's
 * fallback copy, so an unreadable one is reported and skipped, not quarantined.
 * @param {{warn: Function}} logger - Context logger
 * @returns {Object.<string, ExchangeDryRunState>|null}
 */
const readLegacyFundMap = (logger) => {
  // Read through module.exports so tests that repoint LEGACY_STATE_FILE at a
  // tmp root take effect, the same seam migration.getExchangeDataDir uses.
  const legacyFile = module.exports.LEGACY_STATE_FILE;
  if (!fs.existsSync(legacyFile)) return null;

  /** @type {LegacyAllDryRunState} */
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch (err) {
    logger.warn(`⚠️ Legacy dry-run state is unreadable (${err.message}) — leaving it in place, starting fresh`, {
      stateFile: legacyFile,
      error: err.message,
    });
    return null;
  }

  if (legacy?.version !== STATE_VERSION) {
    logger.warn(`⚠️ Legacy dry-run state version mismatch (${legacy?.version} vs ${STATE_VERSION}) — leaving it in place, starting fresh`, {
      stateFile: legacyFile,
      actualVersion: legacy?.version ?? null,
      expectedVersion: STATE_VERSION,
    });
    return null;
  }

  return legacy.exchanges ?? null;
};

/**
 * One-time, idempotent import of a single fund's slot out of the legacy root
 * file. Only ever called when the fund has no file of its own, so re-running it
 * after a successful import is a no-op, and it can never overwrite state the
 * engine has already written. Both key forms the legacy writer produced are
 * accepted: the composite `exchange::pair` and the bare `exchange`.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 * @param {string} resolvedPair - Pair the fund directory actually resolved to
 * @param {{info: Function, warn: Function}} logger - Context logger
 * @returns {ExchangeDryRunState|null}
 */
const importLegacyFundState = (exchange, pair, resolvedPair, logger) => {
  const legacyFunds = readLegacyFundMap(logger);
  if (!legacyFunds) return null;

  const key = composeFundKey(exchange, resolvedPair);
  // Accept the bare-exchange key too: that is what pre-multi-pair installs wrote.
  const legacyKey = [key, exchange]
    .find(candidate => Object.hasOwn(legacyFunds, candidate) && legacyFunds[candidate]);
  if (!legacyKey) return null;

  const state = legacyFunds[legacyKey];
  const stateFile = writeFundStateFile(exchange, pair, state);
  logger.info(`📦 [${key}] Imported dry-run state from legacy ${STATE_FILENAME} slot '${legacyKey}' (original left in place)`, {
    fundKey: key,
    legacyKey,
    legacyFile: module.exports.LEGACY_STATE_FILE,
    stateFile,
  });
  return state;
};

/**
 * Flush every queued fund in `pendingStates` to its own file, stamping each
 * with `now`, then empty the queue. Shared by the debounce timer, the immediate
 * save branch, and forceSave so none of them can strand a fund that was queued
 * by an earlier debounced call (#159).
 * @returns {number} how many funds were flushed
 */
const flushPendingStates = () => {
  const now = Date.now();
  const fundCount = pendingStates.size;
  for (const { exchange, pair, state } of pendingStates.values()) {
    writeFundStateFile(exchange, pair, { ...state, savedAt: now });
  }
  pendingStates.clear();
  return fundCount;
};

/**
 * Load dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {ExchangeDryRunState|null}
 */
const loadState = (exchange, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair });
  const stateFile = getStateFile(exchange, pair);

  // The fund directory name is the authoritative pair when the caller omitted
  // one (resolveFundDataDir falls back to the exchange's configured default).
  const fundState = fs.existsSync(stateFile)
    ? readFundStateFile(stateFile, key, logger)
    : importLegacyFundState(exchange, pair, pair || path.basename(path.dirname(stateFile)), logger);

  if (!fundState) {
    logger.info(`ℹ️ [${key}] No saved dry-run state found`, { fundKey: key, stateFile });
    return null;
  }

  // A snapshot without a usable timestamp cannot be aged, and restoring an
  // unknown-age simulation is exactly what the staleness check exists to
  // prevent — discard it rather than let `new Date(undefined)` throw below.
  const savedAt = Number(fundState.savedAt);
  if (!Number.isFinite(savedAt)) {
    logger.warn(`⚠️ [${key}] Dry-run state has no usable savedAt timestamp, discarding`, {
      fundKey: key,
      stateFile,
      savedAt: fundState.savedAt ?? null,
    });
    return null;
  }

  // Check if state is stale (older than 7 days)
  const ageMs = Date.now() - savedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > STALE_STATE_DAYS) {
    logger.warn(`⚠️ [${key}] Dry-run state is ${ageDays.toFixed(1)} days old, discarding`, {
      fundKey: key,
      stateFile,
      ageDays,
      savedAt,
    });
    return null;
  }

  logger.info(`📂 [${key}] Loaded dry-run state from ${new Date(savedAt).toISOString()}`, {
    fundKey: key,
    stateFile,
    savedAt,
  });
  return fundState;
};

/**
 * Save dry-run state for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {ExchangeDryRunState} exchangeState - State to save
 * @param {string} [pair] - Pair name
 */
const saveState = (exchange, exchangeState, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair });
  // Always store the latest state for this fund
  pendingStates.set(key, { exchange, pair, state: exchangeState });

  // Debounce saves
  const now = Date.now();
  if (now - lastSaveTime < SAVE_DEBOUNCE_MS) {
    // Schedule a save if not already pending
    if (!pendingSave) {
      pendingSave = setTimeout(() => {
        pendingSave = null;
        const fundCount = flushPendingStates();
        lastSaveTime = Date.now();
        dryRunStateLogger.info(`💾 Dry-run state saved for ${fundCount} fund(s)`, {
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
    stateFile: getStateFile(exchange, pair),
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
  const logger = createContextLogger({ exchange, pair });

  // A debounced snapshot for this fund must not survive an explicit reset.
  // Otherwise the pending timer can flush the pre-reset state back to disk
  // after this deletion and resurrect simulated orders/P&L on restart.
  pendingStates.delete(key);
  if (pendingStates.size === 0 && pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  // Write a tombstone rather than removing the file: an absent file is the
  // signal that triggers the legacy-root import, so deleting would let a reset
  // fund resurrect its pre-migration state on the next read.
  const stateFile = writeFundStateFile(exchange, pair, null);
  logger.info(`🗑️ [${key}] Dry-run state cleared`, { fundKey: key, stateFile });
};

/**
 * Force immediate save (bypass debounce)
 * @param {string} exchange - Exchange name
 * @param {ExchangeDryRunState} exchangeState - State to save
 * @param {string} [pair] - Pair name
 */
const forceSave = (exchange, exchangeState, pair) => {
  const key = fundKey(exchange, pair);
  const logger = createContextLogger({ exchange, pair });
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }

  // Queue this fund's fresh snapshot, then flush the whole queue — cancelling the
  // timer above would otherwise strand any fund queued by an earlier debounced
  // call (issue #159). Setting it last lets it win over any stale queued entry.
  pendingStates.set(key, { exchange, pair, state: exchangeState });
  flushPendingStates();
  logger.info(`💾 [${key}] Dry-run state force saved`, {
    fundKey: key,
    stateFile: getStateFile(exchange, pair),
    saveMode: 'forced',
  });
};

module.exports = {
  loadState,
  saveState,
  clearState,
  forceSave,
  getStateFile,
  STATE_FILENAME,
  LEGACY_STATE_FILE,
};
