// @ts-check
// Filesystem persistence only. Domain defaults/migrations are supplied by the
// facade; this module never requires state-tracker (including during startup).
const fs = require('fs');
const path = require('path');
const { resolveFundDataDir } = require('./migration');
const { createContextLogger } = require('./logger');
const { atomicWriteSync } = require('./durable-write');

/** @typedef {import('./types').BotState} BotState */
/** @typedef {import('./types').RegimePositionState} RegimePositionState */
/** @typedef {import('./types').RegimeState} RegimeState */

/** @type {Map<string, number>} Single in-memory save version owner per file. */
const saveVersions = new Map();

/**
 * Get state file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory. Callers that
 * write should ensure the directory exists themselves (via mkdirSync), or
 * use getFundDataDir which creates it as a side effect.
 * @param {string} exchange - Exchange name (default: coinbase)
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to state file
 */
const getStateFile = (exchange = 'coinbase', pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'state.json');
};

/**
 * Get regime state file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to regime state file
 */
const getRegimeStateFile = (exchange = 'coinbase', pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'regime-state.json');
};

/**
 * Read DCA state with domain initialization/migration supplied by the facade.
 * Paths are resolved on every call; reads never persist migration results.
 * @param {Object} config
 * @param {string} exchange
 * @param {string|undefined} pair
 * @param {{createInitialState: Function, migrateState: Function}} domain
 * @returns {Object}
 */
const loadState = (config, exchange, pair, { createInitialState, migrateState }) => {
  const stateFile = getStateFile(exchange, pair);

  if (!fs.existsSync(stateFile)) {
    return createInitialState(config);
  }

  const data = fs.readFileSync(stateFile, 'utf8');
  let state;
  try {
    state = JSON.parse(data);
  } catch (err) {
    // A corrupt state file must not surface as a raw SyntaxError (opaque at
    // boot, a bare 500 from the gateway). Throw a descriptive error naming the
    // file so the operator can repair/move it. We do NOT silently fall back to
    // initial state — that would zero a live fund's accounting on next save
    // (issue #108).
    throw new Error(`state file at ${stateFile} is corrupted or unreadable: ${err.message}. Repair or move the file aside before starting.`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`state file at ${stateFile} did not parse to an object (got ${state === null ? 'null' : Array.isArray(state) ? 'array' : typeof state}). Repair or move the file aside before starting.`);
  }

  // Migrate old state format if needed
  state = migrateState(state);

  return state;
};

/**
 * Save state to file
 * @param {BotState} state - State to save
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {void}
 */
const saveState = (state, exchange = 'coinbase', pair) => {
  const stateFile = getStateFile(exchange, pair);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(stateFile, JSON.stringify(state, null, 2));
};

/**
 * Load a regime bundle, preserving migration and version-observation order.
 * Callbacks own domain rules; this module alone owns the per-file versions.
 * @param {string} exchange
 * @param {string|undefined} pair
 * @param {{createInitialRegimePositionState: Function, createInitialRegimeState: Function, migrateLegacyPositionFields: Function, migrateRegimePosition: Function}} domain
 * @returns {Object}
 */
const loadRegimeState = (exchange, pair, {
  createInitialRegimePositionState, createInitialRegimeState,
  migrateLegacyPositionFields, migrateRegimePosition,
}) => {
  const stateFile = getRegimeStateFile(exchange, pair);
  const logger = createContextLogger({ exchange, pair });

  if (!fs.existsSync(stateFile)) {
    return {
      position: createInitialRegimePositionState(),
      regime: createInitialRegimeState(),
      tpOptimizer: null,
      sizeOptimizer: null,
    };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    // Corrupt regime-state.json holds live financial position — a raw
    // SyntaxError here crashes the engine boot / gateway status path opaquely.
    // Throw a descriptive error so the operator repairs or moves the file
    // aside rather than booting with zeroed position (issue #108).
    throw new Error(`regime-state file at ${stateFile} is corrupted or unreadable: ${err.message}. Repair or move the file aside before starting.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`regime-state file at ${stateFile} did not parse to an object (got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}). Repair or move the file aside before starting.`);
  }

  migrateLegacyPositionFields(data);

  const position = { ...createInitialRegimePositionState(), ...data.position };

  // Sync in-memory save version from disk
  const diskVersion = (data.position && data.position._saveVersion) || 0;
  saveVersions.set(stateFile, diskVersion);

  migrateRegimePosition(position, { exchange, pair, stateFile, logger });

  return {
    position,
    regime: { ...createInitialRegimeState(), ...data.regime },
    tpOptimizer: data.tpOptimizer || null,
    sizeOptimizer: data.sizeOptimizer || null,
  };
};

/**
 * Protected fields that should be preserved from external edits
 * when an optimistic version conflict is detected.
 */
const PROTECTED_FIELDS = ['celestialBodies', 'celestialState', 'realizedPnL', 'realizedAssetPnL', 'appliedBuyCorrections', 'appliedSellCorrections'];

/**
 * Save regime state to file
 * @param {RegimePositionState} position - Position state
 * @param {RegimeState} regime - Regime state
 * @param {string} exchange - Exchange name
 * @param {Object} [tpOptimizer] - Optional TP optimizer state
 * @param {Object} [sizeOptimizer] - Optional Size optimizer state
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @deprecated Use saveFundRegimeState(exchange, pair, state) for fund-scoped writes.
 */
const saveRegimeState = (position, regime, exchange = 'coinbase', tpOptimizer = null, sizeOptimizer = null, pair) => {
  const stateFile = getRegimeStateFile(exchange, pair);
  const dir = path.dirname(stateFile);
  const logger = createContextLogger({ exchange, pair });

  fs.mkdirSync(dir, { recursive: true });

  // Optimistic version locking: detect external edits. Preserve unreadable
  // bytes before replacing them; saveLiveStateGuarded handles a failed save
  // at the background boundary and records it as a persistence health fault.
  const myVersion = saveVersions.get(stateFile) || 0;
  let diskVersion = 0;
  if (fs.existsSync(stateFile)) {
    let diskData = null;
    try {
      diskData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      // Quarantine the unreadable file before overwriting so the operator can
      // recover protected fields. renameSync can itself throw (file vanished,
      // permissions). If that fails, refuse the save rather than destroy the
      // only recovery copy. The next save retries after the fault is repaired.
      const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(stateFile, quarantinePath);
        logger.warn(`⚠️ Regime state unreadable (${err.message}) — quarantined to ${path.basename(quarantinePath)} before overwrite`, {
          stateFile,
          quarantinePath,
          error: err.message,
        });
      } catch (renameErr) {
        logger.error(`⚠️ Regime state unreadable (${err.message}) and quarantine failed (${renameErr.message}) — save refused; original retained`, {
          stateFile,
          quarantinePath,
          error: err.message,
          quarantineError: renameErr.message,
        });
        throw new Error(`Cannot save regime state: unreadable file could not be quarantined (${renameErr.message}). Repair the file or quarantine permissions, then retry.`, { cause: renameErr });
      }
    }
    diskVersion = (diskData?.position && diskData.position._saveVersion) || 0;
    if (diskData && diskVersion > myVersion) {
      // External edit detected — merge protected fields from disk
      logger.info(`🔀 Merge: disk version ${diskVersion} > memory ${myVersion}, preserving external edits on [${PROTECTED_FIELDS.join(', ')}]`, {
        stateFile,
        diskVersion,
        memoryVersion: myVersion,
        protectedFields: PROTECTED_FIELDS,
      });
      for (const field of PROTECTED_FIELDS) {
        if (diskData.position[field] !== undefined) {
          position[field] = diskData.position[field];
        }
      }
    }
  }

  // Stamp a version STRICTLY greater than both our in-memory version and the
  // version we observed on disk. Using `myVersion + 1` alone could regress
  // below diskVersion after a merge (disk ahead of memory) — a lower stamp
  // would make the next save think ITS state is the newer one and silently
  // clobber these just-merged protected fields (issue #108).
  const nextVersion = Math.max(myVersion, diskVersion) + 1;
  const stateData = { position: { ...position, _saveVersion: nextVersion }, regime };
  if (tpOptimizer) {
    stateData.tpOptimizer = tpOptimizer;
  }
  if (sizeOptimizer) {
    stateData.sizeOptimizer = sizeOptimizer;
  }

  atomicWriteSync(stateFile, JSON.stringify(stateData, null, 2));
  // Only acknowledge a committed save. Advancing before a failed write makes
  // a later external edit at nextVersion look stale and lose protected fields.
  position._saveVersion = nextVersion;
  saveVersions.set(stateFile, nextVersion);
};

module.exports = { getStateFile, loadState, saveState, getRegimeStateFile, loadRegimeState, saveRegimeState };
