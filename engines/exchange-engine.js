// @ts-check
/**
 * Crypto Exchange Engine Process
 *
 * Standalone PM2 process that runs a single exchange's:
 * - Regime engine (buy/sell cycle management)
 * - Market data service (WebSocket price feeds, ATR, regime detection)
 * - Chart data buffer
 * - IPC WebSocket server for communication with the gateway
 *
 * Set EXCHANGE_NAME env var to select which exchange this process manages.
 * Thin wrappers (gemini-engine.js, cryptocom-engine.js) set env and require this file.
 * The `regime:*` IPC request handlers live in src/ipc/regime-ipc-handlers.js.
 *
 * The gateway (server.js) connects as an IPC client and forwards:
 * - Realtime bus events from the engine (regime:status, trade:event, etc.)
 * - Regime control commands from the admin UI (start/stop/pause/resume/etc.)
 */

const path = require('path');
const { IPC_CHANNELS } = require('../src/ipc/ipc-protocol');
const { createContextLogger } = require('../src/logger');
const {
  initializeConfigBase,
  getFundConfig,
  getRegimeConfig,
  getConfiguredExchanges,
  getFundsForExchange,
  resolveConfiguredPair,
} = require('../src/config-utils');
const { createRegimeEngine } = require('../src/regime-engine');
const {
  startMarketDataService,
  getActiveMarketDataFunds,
  drainMarketDataStarts,
  stopAllMarketDataServices,
  getMarketDataService,
  stopMarketDataService,
  fenceMarketDataService,
} = require('../src/market-data-service');
const { getChartDataBuffer, getChartData, removeChartDataBuffer, shutdownAllBuffers, resumeAllBuffers, removeAllChartDataBuffers } = require('../src/chart-data-buffer');
const { createFillLedger } = require('../src/fill-ledger');
const { parseFillsQuery } = require('../src/transactions-regime-query');
const { createManualTradeImporter } = require('../src/manual-trade-import');
const { createUnaccountedFillsJobs } = require('../src/unaccounted-fills-jobs');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { registerRegimeIpcHandlers } = require('../src/ipc/regime-ipc-handlers');
const { createRealtimeProxy, forwardTradeEvents } = require('../src/ipc/realtime-proxy');
const { saveRegimeRunningFlag, shouldAutoResumeRegime, fundKey, fundLabel, readBooleanFlag } = require('../src/shared-utils');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { drainPendingWrites } = require('../src/pending-writes');
const { createEngineStopAllHandler } = require('../src/engine-stop-all');
const { getEngineMaintenance, setEngineRestoreQuiescing } = require('../src/engine-maintenance');
const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
const { registerEngineRecalculateHandler } = require('../src/engine-recalculate-handler');
const { migrateExchangeToPairs, guardLegacyMigration } = require('../src/migration');
const { guardIncompleteRestore } = require('../src/restore-apply');
const { recoverDcaImport } = require('../src/dca-conversion-transaction');
const { LIFECYCLE, closeDrainedEmptyPosition, loadFundRegimeState, loadRegimeStateSafe, saveFundRegimeState } = require('../src/state-tracker');
const { getAdapter } = require('../src/adapters');
const { registerProcessGuards } = require('../src/process-guard');
const { resolveIpcPort } = require('../src/ipc-port-defaults');
const { lookupStoppedFundTpOrder } = require('../src/stopped-fund-tp-lookup');
const { createEngineShutdown } = require('../src/engine-shutdown');

/**
 * Build a context logger for one engine operation.
 *
 * The engine's handlers are keyed by fund (exchange + pair), so the stable
 * trading context is derived per call site rather than bound once. `pair` is
 * omitted for process-level events (startup banner, shutdown) that belong to
 * no single fund — JSON.stringify drops undefined keys.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Trading pair the event belongs to
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const engineLogger = (exchange, pair) => createContextLogger({
  module: 'exchange-engine',
  exchange,
  pair,
});

// ============ Configuration ============

const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'coinbase';
// EXCHANGE_IPC_PORT is set by the thin per-exchange wrappers (gemini-engine.js,
// cryptocom-engine.js) before they require this file; falling back to
// resolveIpcPort(EXCHANGE_NAME) covers running this file directly (e.g. `node
// engines/exchange-engine.js` with no wrapper), using the ecosystem.config.cjs
// PORTS default for whichever exchange is configured instead of a literal that
// could collide with the gateway (5570) or the Vite dev server (5571) — issue #690.
const IPC_PORT = parseInt(process.env.EXCHANGE_IPC_PORT, 10) || resolveIpcPort(EXCHANGE_NAME);
const ENGINE_NAME = `cm-${EXCHANGE_NAME}`;

// ============ IPC Server ============

const ipcServer = createIPCServer(IPC_PORT, ENGINE_NAME);
const ioProxy = createRealtimeProxy(ipcServer);
forwardTradeEvents(ipcServer);

// ============ Engine State ============
//
// Each fund (exchange + pair) has its own regime engine instance and its own
// standalone fill ledger. Maps are keyed by `${exchange}::${pair}` so multiple
// funds can coexist within the same engine process.

/** Resolve IPC pairs to configured funds before they reach engine state or disk. */
const resolvePair = (exchange, pair) => {
  const resolved = resolveConfiguredPair(exchange, pair);
  if (resolved.error) throw new Error(resolved.error);
  return resolved.pair;
};

/** @type {Map<string, Object>} Active regime engines keyed by `${exchange}::${pair}` */
const regimeEngines = new Map();

/** @type {Map<string, Object>} Cached standalone fill ledgers keyed by `${exchange}::${pair}` */
const standaloneLedgers = new Map();

const getStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  if (!standaloneLedgers.has(key)) {
    const fundConfig = getFundConfig(exchange, resolvedPair);
    // createFillLedger throws on cold-start corruption (refuses to boot
    // empty so a subsequent persist can't overwrite a recoverable file).
    // Log full detail (absolute path + parser error) server-side and throw
    // a sanitized message — the IPC framework propagates this back to
    // clients, so we keep filesystem internals out of the API surface.
    let ledger;
    try {
      ledger = createFillLedger(exchange, fundConfig?.productId, resolvedPair);
    } catch (err) {
      engineLogger(exchange, resolvedPair).error(`❌ [${exchange}/${resolvedPair}] Fill ledger init failed: ${err.message}`, { error: err.message });
      throw new Error(`Fill ledger init failed for ${exchange}/${resolvedPair} — see engine logs for details`);
    }
    ledger.load();
    standaloneLedgers.set(key, ledger);
  }
  return standaloneLedgers.get(key);
};

const invalidateStandaloneLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  standaloneLedgers.delete(fundKey(exchange, resolvedPair));
};

/** Get the best available fill ledger — engine's own if running, standalone otherwise */
const getActiveLedger = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const engine = regimeEngines.get(fundKey(exchange, resolvedPair));
  if (engine) return engine.getFillLedger();
  invalidateStandaloneLedger(exchange, resolvedPair);
  return getStandaloneLedger(exchange, resolvedPair);
};

// ============ Engine Callbacks ============

const wireMarketDataCallbacks = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const service = getMarketDataService(exchange, resolvedPair);
  if (!service) return;
  service.setOnStatusUpdate((status) => {
    getChartDataBuffer(exchange, resolvedPair).processStatus(status);
    ioProxy.emit('regime:status', { exchange, pair: resolvedPair, status });
  });
};

const createEngineCallbacks = (exchange, pair) => ({
  onRegimeChange: (prevMode, newMode, reason) =>
    ioProxy.emit('regime:change', { exchange, pair, prevMode, newMode, reason, message: `${prevMode} -> ${newMode}` }),
  onHealthChange: (mode, reason) =>
    ioProxy.emit('regime:health', { exchange, pair, mode, reason, message: reason || `Health: ${mode}` }),
  onPositionUpdate: (data) =>
    ioProxy.emit('regime:position', { exchange, pair, ...data }),
  onStatusUpdate: (status) => {
    getChartDataBuffer(exchange, pair).processStatus(status);
    ioProxy.emit('regime:status', { exchange, pair, status });
  },
  // Fired by the regime engine when a draining fund's TP fills and lifecycle
  // transitions to closed. We stop the engine here (rather than from inside
  // the engine itself) to avoid re-entrancy in the cycle-completion path.
  onLifecycleClosed: async () => {
    const label = fundLabel(exchange, pair);
    const fundLogger = engineLogger(exchange, pair);
    fundLogger.info(`ℹ️ 🛑 [${label}] Lifecycle closed — stopping regime engine`);
    const key = fundKey(exchange, pair);
    const engine = regimeEngines.get(key);
    if (!engine) return;
    try {
      await engine.stop();
    } catch (err) {
      fundLogger.error(`❌ [${label}] Error stopping engine after lifecycle close: ${err.message}`, { error: err.message });
    }
    regimeEngines.delete(key);
    invalidateStandaloneLedger(exchange, pair);
    manualTradeStores.delete(fundKey(exchange, pair));
    // Free the chart buffer (with its setInterval) and the market data
    // service so we don't leak memory for dead funds. Operator can reopen
    // and start the fund again later — both will be re-created on demand.
    removeChartDataBuffer(exchange, pair);
    stopMarketDataService(exchange, pair);
    saveRegimeRunningFlag(exchange, pair, false);
    ioProxy.emit('regime:closed', { exchange, pair });
  },
});

// ============ IPC Request Handlers ============

// Regime engine control — regime:start / regime:stop
// Extracted to src/engine-lifecycle-handlers.js (issue #504) so the
// fill-consumer handover ordering around engine stop/start can be tested
// directly against these production callbacks. Ledger ownership transfers
// exclusively between the engine and the standalone service (issue #1008).
let backupRecovery;
const { autoResumeFund, getStartStatus, cancelStarts, settleStarts } = registerEngineLifecycleHandlers(ipcServer, {
  regimeEngines,
  beforeStop: (key) => backupRecovery?.cancelFund(key),
  beforeCancelAll: () => backupRecovery?.cancelAll(),
  resolvePair,
  fundKey,
  fundLabel,
  logger: engineLogger,
  getFundConfig,
  getAdapter,
  loadFundRegimeState,
  LIFECYCLE,
  createRegimeEngine,
  createEngineCallbacks,
  startMarketDataService,
  fenceMarketDataService,
  wireMarketDataCallbacks,
  invalidateStandaloneLedger,
  saveRegimeRunningFlag,
  recoverPendingImport: recoverDcaImport,
  drainFundWrites: (exchange, pair) => drainPendingWrites(30_000,
    entry => entry.label.startsWith('engine-') && entry.label.endsWith(`:${fundLabel(exchange, pair)}`)),
});

// Stop all running regime engines (used by backup restore). The reply is the
// restore path's proof of writer quiescence, so a fund that failed to stop is
// reported as failed and stays owned by this process (issue #429).
backupRecovery = registerEngineBackupHandlers(ipcServer, {
  regimeEngines, drainPendingWrites, drainStarts: settleStarts,
  pauseBuffers: shutdownAllBuffers, resumeBuffers: resumeAllBuffers,
  // A gateway that dies mid-backup can never send backup-resume; the window
  // reopens the held fill gates itself once its only client is gone.
  onGatewayDisconnect: (listener) => ipcServer.onClientDisconnect((remaining) => { if (remaining === 0) listener(); }),
  isShuttingDown: ipcServer.isShuttingDown,
  logger: engineLogger(EXCHANGE_NAME),
});

ipcServer.onRequest(IPC_CHANNELS.REGIME_STOP_ALL, createEngineStopAllHandler({
  regimeEngines, cancelStarts, drainPendingWrites,
  stopMarketServices: stopAllMarketDataServices, drainMarketStarts: drainMarketDataStarts,
  clearCaches: () => { removeAllChartDataBuffers(); standaloneLedgers.clear(); manualTradeStores.clear(); },
  getMaintenance: getEngineMaintenance, setQuiescing: setEngineRestoreQuiescing,
  logger: engineLogger, label: fundLabel, setRunningFlag: saveRegimeRunningFlag,
}));

// Exchange/fund info queries
ipcServer.onRequest('exchanges:list', async () => {
  const configured = getConfiguredExchanges();
  return configured.map((name) => {
    const funds = getFundsForExchange(name);
    const anyRunning = funds.some((p) => regimeEngines.has(fundKey(name, p)));
    return {
      name,
      pairs: funds,
      regimeRunning: anyRunning,
    };
  });
});

// List funds (exchange + pair) configured on a specific exchange
ipcServer.onRequest('funds:list', async (payload, exchange) => {
  const funds = getFundsForExchange(exchange);
  return {
    exchange,
    funds: funds.map((pair) => ({
      pair,
      regimeRunning: regimeEngines.has(fundKey(exchange, pair)),
    })),
  };
});

// regime:recalculate — extracted to src/engine-recalculate-handler.js
// (issue #505) so the preview-vs-apply / live-vs-stopped selection it
// enforces can be tested directly against these production callbacks.
registerEngineRecalculateHandler(ipcServer, {
  regimeEngines,
  resolvePair,
  fundKey,
  readBooleanFlag,
  loadFundRegimeState,
  saveFundRegimeState,
  invalidateStandaloneLedger,
  getStandaloneLedger,
});


// ============ Manual Trade Tracking ============

/** @type {Map<string, Object>} Cached manual trade stores keyed by `${exchange}::${pair}` */
const manualTradeStores = new Map();

const getManualTradeStore = (exchange, pair) => {
  const resolvedPair = resolvePair(exchange, pair);
  const key = fundKey(exchange, resolvedPair);
  if (!manualTradeStores.has(key)) {
    const { createManualTradeStore } = require('../src/manual-trades');
    const store = createManualTradeStore(exchange, resolvedPair);
    store.load();
    manualTradeStores.set(key, store);
  }
  return manualTradeStores.get(key);
};

// Manual Trades history reads run as engine-owned jobs (issue #966): a long
// exchange history (e.g. hundreds of paced Crypto.com pages) outlasts the
// gateway's IPC deadline, so start/status answer promptly while the scan runs
// here. A start for a fund+startDate that is already scanning joins that job.
const unaccountedFillsJobs = createUnaccountedFillsJobs({ logger: engineLogger(EXCHANGE_NAME) });

registerRegimeIpcHandlers(ipcServer, {
  regimeEngines, resolvePair, fundKey, fundLabel, logger: engineLogger, ioProxy,
  getStartStatus, getStandaloneLedger, getActiveLedger, getManualTradeStore, invalidateStandaloneLedger,
  unaccountedFillsJobs,
  getFundConfig, getRegimeConfig, getMarketDataService, getChartData, getAdapter,
  loadRegimeStateSafe, loadFundRegimeState, saveFundRegimeState, closeDrainedEmptyPosition,
  LIFECYCLE, saveRegimeRunningFlag, readBooleanFlag, parseFillsQuery,
  lookupStoppedFundTpOrder, createManualTradeImporter,
});

// ============ Startup ============

const startup = async () => {
  const { version } = require('../package.json');
  const label = EXCHANGE_NAME.charAt(0).toUpperCase() + EXCHANGE_NAME.slice(1);
  const startupLogger = engineLogger(EXCHANGE_NAME);
  startupLogger.info(`ℹ️ \n📡 ${label} Engine v${version}`);
  startupLogger.info(`ℹ️    IPC: ws://127.0.0.1:${IPC_PORT}`);

  const exchange = EXCHANGE_NAME;

  // Own the configured local IPC port before any recovery, migration or fund
  // writer can run. A duplicate process must fail without touching fund data.
  ipcServer.setInitializing(true);
  await ipcServer.start();

  // ===== Interrupted-restore recovery =====
  // Runs before the migration and before any fund loads its ledger or regime
  // state: a crash mid-restore leaves data/ a mixed generation, and resuming a
  // fund on one would trade against another era's accounting (issue #431).
  // A rollback that cannot complete exits the process rather than trading blind.
  guardIncompleteRestore({ processLabel: `${exchange} engine`, logger: startupLogger });

  initializeConfigBase();

  // ===== Legacy root → exchange namespace migration =====
  // Same gate as the gateway and CLI (issue #971): an interrupted namespace
  // migration is finished here before the pair migration below resolves the
  // exchange tree, and a conflicting one keeps the engine from starting.
  guardLegacyMigration({ processLabel: `${exchange} engine`, logger: startupLogger });

  // ===== One-time multi-pair migration =====
  // Move legacy data/<exchange>/ files into data/<exchange>/<defaultPair>/.
  // Idempotent: returns no-op if already migrated. See UPGRADE.md.
  const migrationResult = migrateExchangeToPairs(exchange);
  if (migrationResult.migrated) {
    startupLogger.info(`ℹ️ ✅ [${exchange}] Pair migration complete: moved ${migrationResult.movedFiles} files into ${exchange}/${migrationResult.defaultPair}/`);
  } else if (migrationResult.reason && !migrationResult.reason.startsWith('no-op')) {
    startupLogger.error(`❌ [${exchange}] Pair migration failed: ${migrationResult.reason}`, { reason: migrationResult.reason });
    startupLogger.error(`❌ [${exchange}] Refusing to start engine. See UPGRADE.md for instructions.`, { reason: migrationResult.reason });
    process.exit(1);
  }

  // Auto-resume each fund (exchange + pair) that was running before restart
  const fundsForExchange = getFundsForExchange(exchange);
  for (const fundPair of fundsForExchange) {
    const label = fundLabel(exchange, fundPair);
    const fundLogger = engineLogger(exchange, fundPair);
    const key = fundKey(exchange, fundPair);

    // Finish (or discard) an interrupted DCA import before anything reads
    // this fund's files (issue #860). An unrecoverable journal keeps the fund
    // offline — no auto-resume and no stopped-fund fill writer — so nothing
    // trades or ingests on a mixed import generation.
    try {
      const recovery = recoverDcaImport(exchange, fundPair);
      if (recovery.recovered) {
        fundLogger.warn(`⚠️ [${label}] Interrupted DCA import ${recovery.id} ${recovery.action}`, { importId: recovery.id, action: recovery.action });
      }
    } catch (err) {
      fundLogger.error(`❌ [${label}] DCA import recovery failed — fund stays offline: ${err.message}`, { error: err.message });
      continue;
    }

    // Hand the first attempt to the start supervisor without awaiting it
    // (issue #1554). The supervisor registers the fund's start entry
    // synchronously, so a regime:stop landing mid-attempt is owned by
    // wrapStop and backups quiesce on settleStarts. Awaiting here held the
    // IPC gate closed for every fund's full exchange startup chain in turn.
    if (shouldAutoResumeRegime(exchange, fundPair)) {
      autoResumeFund(exchange, fundPair).catch((err) => {
        fundLogger.error(`❌ [${label}] Auto-resume failed: ${err.message}`, { error: err.message });
      });
    }

    // Start passive market data service for funds whose engine isn't running
    // and that have no supervised start (the entry above exists synchronously).
    if (!regimeEngines.has(key) && !getStartStatus(exchange, fundPair)) {
      const regimeConfig = getRegimeConfig(exchange, fundPair);
      if (regimeConfig && Object.keys(regimeConfig).length > 0) {
        fundLogger.info(`ℹ️ 📊 [${label}] Starting market data service...`);
        startMarketDataService(exchange, fundPair)
          .then(() => wireMarketDataCallbacks(exchange, fundPair))
          .catch((err) => {
            fundLogger.warn(`⚠️ [${label}] Failed to start market data service: ${err.message}`, { error: err.message });
          });
      }
    }
  }

  // Only the synchronous recovery above (restore, migrations, DCA import
  // journals) holds requests back; in-flight fund starts admit stop/status
  // and backup maintenance, as a manual regime:start already does.
  ipcServer.setInitializing(false);
};

startup().catch((err) => {
  engineLogger(EXCHANGE_NAME).error(`❌ Startup failed: ${err.message}`, { error: err.message });
  process.exit(1);
});

// ============ Graceful Shutdown ============

// Install signal handlers with error handling and watchdog
// Must cover the bounded pre-stop joins plus FILL_DRAIN_MS (the shared flash-
// cancel/in-flight-fill drain in regime-engine stop()) and the post-stop process
// drain, and stay below `kill_timeout` for the engines in ecosystem.config.cjs.
// Kept a literal: tests/pm2-kill-timeout.test.js parses it.
const SHUTDOWN_WATCHDOG_MS = 22000;

const engineShutdown = createEngineShutdown({
  ipcServer,
  regimeEngines,
  cancelStarts,
  settleStarts,
  unaccountedFillsJobs,
  stopMarketServices: stopAllMarketDataServices,
  drainMarketStarts: drainMarketDataStarts,
  drainPendingWrites,
  shutdownAllBuffers,
  logger: engineLogger(EXCHANGE_NAME),
  watchdogMs: SHUTDOWN_WATCHDOG_MS,
});

const gracefulShutdown = engineShutdown.shutdown;

const setupShutdownHandlers = () => {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
};

setupShutdownHandlers();

// Last-resort fault reporters (issue #532). The engine process has no notifier
// of its own — trade events reach Telegram through the gateway's IPC
// subscription. Drain the outbound frame before exit so the gateway can send
// the notification even after this process has terminated.
registerProcessGuards({
  logger: engineLogger(EXCHANGE_NAME),
  source: `${EXCHANGE_NAME}-engine`,
  flush: () => ipcServer.flush(),
});
