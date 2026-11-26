// @ts-check
const { trackPendingWrite } = require('./pending-writes');
/**
 * Regime Engine
 *
 * Main regime-aware trading engine that orchestrates:
 * - WebSocket connection for real-time data
 * - Periodic metrics calculation (ATR, RV, VWAP)
 * - Regime classification (HARVEST/CAUTION/TREND)
 * - Volatility-triggered entries
 * - Dynamic take-profit management
 * - Risk management and caps
 * - Health monitoring and SAFE mode
 *
 * Replaces fixed-interval DCA with adaptive volatility-driven trading.
 */

const { getAdapter } = require('./adapters');
const { getUnaccountedFills } = require('./sync-fills');
const { getRegimeConfig, updateRegimeConfig, getBaseCurrency, getQuoteCurrency, getConfiguredFunds, loadConfig, normalizeExchangeBlock } = require('./config-utils');
const { createFillLedger, FillValidationError } = require('./fill-ledger');
const { projectBuyCorrection, applyBuyCorrectionCapital } = require('./buy-fill-correction');
const { applySellCorrectionCapital } = require('./sell-fill-correction');
const { createClosedTrades } = require('./closed-trades');
const { createTradeWindow } = require('./trade-window');
const {
  createHealthMonitor,
  instrumentAdapterForHealth,
  isPersistenceOnlySafeReason,
} = require('./health-monitor');
const { createTailEventsMonitor } = require('./tail-events');
const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { createPositionSizer } = require('./position-sizer');
const { createRiskManager, computeFundEquity } = require('./risk-manager');
const { createOrderExecutor } = require('./order-executor');
const { createDryRunExecutor } = require('./dry-run-executor');
const { validateExecutor } = require('./executor-contract');
const { createRecoveryModule } = require('./recovery');
const { createTpOptimizer } = require('./tp-optimizer');
const { createSizeOptimizer } = require('./size-optimizer');
const { validateSizingFields } = require('./regime-sizing-contract');
const { createLadderCalculator, applyAutoLadderSizing } = require('./ladder-calculator');
const { applyMarketMetrics, roundAsset, roundUSDC, roundPrice } = require('./volatility-utils');
const { createMacroRegime } = require('./macro-regime');
const { calculateApyMetrics: _calculateApyMetrics, initializeApyTracking: _initializeApyTracking } = require('./apy-calculator');
const { tradeEvents } = require('./trade-events');
const dryRunState = require('./dry-run-state');
const {
  saveFundRegimeState,
  LIFECYCLE,
  createInitialRegimePositionState,
  closeDrainedEmptyPosition,
} = require('./regime-state-store');
const { createEngineStatePersistence } = require('./regime-state-persistence');
const { buildRegimeEngineStatus } = require('./regime-engine-status');
const { createPlacementReconciler } = require('./regime-placement-reconciler');
const { createStartupRecovery } = require('./regime-startup-recovery');
const { createOperatorActions } = require('./regime-operator-actions');
const { createReconcileLoop } = require('./regime-reconcile');
const { createEntryEvaluator, CAP_ALERT_LABELS } = require('./regime-entry');
const { createTpPlacement } = require('./regime-tp-placement');
const celestialHierarchy = require('./celestial-hierarchy');
const { createDryRunFillHandlers } = require('./regime-dry-run-fills');
const { DEFAULT_FEE_RATE_PER_SIDE } = require('../shared/fee-defaults.mjs');
const { fmtCurrency: fmtPrice, isCancelledStatus, isTerminalStatus, sleep } = require('./shared-utils');
const { createContextLogger } = require('./logger');
const { DEFAULT_MAX_USDC_DEPLOYED } = require('./fund-defaults');
const { createEngineLocks, FILL_DRAIN_MS } = require('./engine-locks');
const { classifyResetSupersession, selectCarryForwardBuys } = require('./regime-cycle-reset');
const { createTtlStore } = require('./ttl-store');
const { buildPartialFillData, makeFillDedupKey, resolveEntryBudget, isBuyAlreadyCommitted, isUnsettledBuyRow, collectBuyBookingBatch, measureUnbookedOrderQty, boundRecoveredBuyRows, isFullTpExecution, pruneStaleTpCancelMarkers, isStrandedDustBody, shouldSkipBuyRecommit } = require('./regime-pure-helpers');
const { restorePersistedCycleId, repairHistoricalFillAnnotations, planBodyGrowthFromRecoveredBuyRows } = require('./regime-fill-annotations');
const { createSellFillBooking } = require('./regime-sell-fill');
const { createBuyBooking } = require('./regime-buy-booking');
const { createFillHandler, cancelPartialFillOrder } = require('./regime-fill-handler');
const { createEntryTrancheRecovery } = require('./regime-entry-tranche-recovery');
const { LIVE_STATE_SAVE_INTERVAL_MS, DRY_RUN_STATE_SAVE_INTERVAL_MS } = require('./timing-constants');

/** Interval between periodic metrics/regime-classification updates (ms) */
const METRICS_INTERVAL_MS = 60000;
const HOURLY_SUMMARY_EVENT_MS = 60 * 60 * 1000;

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').MarketState} MarketState
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 * @typedef {import('./types').RegimeState} RegimeState
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 */

/**
 * Create initial market state
 * @returns {MarketState}
 */
const createInitialMarketState = () => ({
  lastPrice: 0,
  bid: 0,
  ask: 0,
  spread: 0,
  atr1m: 0,
  atr5m: 0,
  realizedVol: 0,
  volBaseline: 0,
  vwap: 0,
  vwapDistance: 0,
  recentSwing: 0,
  tradeImbalance: 0,
  // 24h rolling volume from the ticker feed — consumed by the candle cache's
  // volume-delta logic (server.js). Without this it was always 0 (issue #202).
  volume24h: 0,
  momentum: { magnitude: 0, direction: 'neutral' },
  trades: [],
  lastUpdate: 0,
  // ATH tracking for ladder mode
  ath: 0,
  athDistance: 0,
  athLastUpdate: 0,
});

/**
 * Create initial position state
 * Alias for createInitialRegimePositionState (unified factory in state-tracker.js)
 * @returns {RegimePositionState}
 */
const createInitialPositionState = createInitialRegimePositionState;


/** Floor for `fillDriftSweepMs` — one full-history exchange fetch per minute. */
const MIN_FILL_DRIFT_SWEEP_MS = 60_000;

/**
 * Create regime engine instance.
 *
 * Two signatures (string-typed second arg disambiguates):
 *   createRegimeEngine(exchange, exchangeConfig, callbacks)
 *   createRegimeEngine(exchange, pair, exchangeConfig, callbacks)
 *
 * @param {string} exchange
 * @param {string|Object} pairOrExchangeConfig
 * @param {Object} [exchangeConfigOrCallbacks]
 * @param {Object} [maybeCallbacks]
 * @returns {Object}
 */
const createRegimeEngine = (exchange, pairOrExchangeConfig, exchangeConfigOrCallbacks, maybeCallbacks) => {
  let pair;
  let exchangeConfig;
  let callbacks;
  if (typeof pairOrExchangeConfig === 'string') {
    pair = pairOrExchangeConfig;
    exchangeConfig = exchangeConfigOrCallbacks || {};
    callbacks = maybeCallbacks || {};
  } else {
    pair = null;
    exchangeConfig = pairOrExchangeConfig || {};
    callbacks = exchangeConfigOrCallbacks || {};
  }

  const { getDefaultPair } = require('./config-utils');
  if (!pair) pair = getDefaultPair(exchange) || exchangeConfig.productId || 'default';

  const { productId } = exchangeConfig;
  const config = getRegimeConfig(exchange, pair);
  const baseCurrency = getBaseCurrency(productId);
  const logger = createContextLogger({ exchange, pair });

  // Exchange lookups whose failure the caller treats as "unknown" (null), not
  // as an error. The null result is unchanged, but a persistent auth,
  // rate-limit or transport failure must not be indistinguishable from "not
  // found": warn with the error text, at most once a minute per lookup so a
  // per-tick caller cannot flood the log.
  const LOOKUP_WARN_INTERVAL_MS = 60_000;
  const lookupWarnedAt = new Map();
  const lookupOrNull = (label, subject, lookup) => lookup.catch(err => {
    const key = `${label}:${subject}`;
    const now = Date.now();
    if (now - (lookupWarnedAt.get(key) ?? -Infinity) >= LOOKUP_WARN_INTERVAL_MS) {
      if (lookupWarnedAt.size >= 500) lookupWarnedAt.clear();
      lookupWarnedAt.set(key, now);
      const message = err?.message ?? String(err);
      logger.warn(`⚠️ [${exchange}] ${label}(${subject}) failed on ${pair}: ${message} — treated as unknown`, {
        exchange, pair, lookup: label, subject, error: message,
      });
    }
    return null;
  });

  // Stale window to re-arm a restored resting entry with. A row saved by
  // placeEntryBid carries the adaptive window it was placed with; a row from
  // before that was persisted (or an orphan adopted at startup) has none, and
  // its offset is unknown. Fall back to the longest window the adaptive timeout
  // can produce (the maxIntervalMs cap, never below orderStaleMs) rather than the
  // floor: a deep bid restored with the floor is cancelled seconds after restart
  // though its window may have been minutes. The cap still bounds how long a
  // resting entry can block new reactive entries.
  const restoredEntryStaleMs = (savedEntry) => {
    if (Number.isFinite(savedEntry?.staleMs) && savedEntry.staleMs > 0) return savedEntry.staleMs;
    const longest = Math.max(config.orderStaleMs || 0, config.maxIntervalMs || 0);
    return longest > 0 ? longest : undefined;
  };

  // Prefix used in log lines and trade events to identify this fund
  const fundLabel = `${exchange}/${pair}`;

  // Throttled status update tracking
  let lastStatusUpdate = 0;
  const STATUS_UPDATE_INTERVAL = 1000; // 1 second throttle

  // Dry-run mode flag - use exchange-level config (same as DCA engine)
  // This ensures the UI toggle at exchanges.coinbase.dryRun controls both engines
  const isDryRun = exchangeConfig.dryRun === true;
  const modeLabel = isDryRun ? '[DRY-RUN] ' : '';

  // Create adapter. `let` (not `const`) so the #196 merge↔fill concurrency
  // integration tests can swap in a mock adapter via the _test hooks; no
  // production path ever reassigns it.
  let adapter = getAdapter(exchange);

  // Create all component instances
  const fillLedger = createFillLedger(exchange, productId, pair);
  const closedTrades = createClosedTrades(exchange, pair);

  // Fund identity stamped on the notifier-facing events below (issue #1030),
  // so an exchange with several funds says which one tripped.
  const fundEventData = { pair };
  const healthMonitor = createHealthMonitor(exchange, config, {
    onSafeMode: (reason) => {
      // Publish BEFORE the cancel sweep starts: a slow or rejected cancel must
      // never delay or swallow the operator's SAFE warning (issue #1030).
      tradeEvents.safeMode(exchange, reason, fundEventData);
      return fencedWrite(`engine-safe-mode:${fundLabel}`, async () => {
        logger.warn(`⚠️ [${exchange}] SAFE mode: ${reason}`, { reason });
        // A disk fault is not an exchange fault (issue #532): the intervention is
        // to stop opening NEW entries (canPlaceEntry blocks them in SAFE), not to
        // cancel orders that are already resting. Pulling them because a write
        // failed would turn an unpersistable-state fault into an
        // unmanaged-position fault, which is strictly worse.
        if (!isPersistenceOnlySafeReason(reason)) {
          // A failed sweep is logged rather than thrown: the health monitor
          // never awaits this callback, so a rejection would go unhandled, and
          // the dashboard still has to hear about the SAFE transition.
          await orderExecutor.cancelAllEntries().catch((err) => logger.error(
            `❌ [${exchange}] SAFE-mode entry cancel failed: ${err.message}`, { error: err.message, reason }
          ));
        }
        if (callbacks.onHealthChange) {
          callbacks.onHealthChange('SAFE', reason);
        }
      });
    },
    onActiveMode: () => {
      tradeEvents.activeMode(exchange, fundEventData);
      if (callbacks.onHealthChange) {
        callbacks.onHealthChange('ACTIVE', null);
      }
    },
    onAuthDenied: (reason) => {
      logger.warn(
        `🔑 [${exchange}] API key denied (check IP allowlist) — trading paused until access restored: ${reason}`,
        { reason }
      );
      tradeEvents.emitTradeEvent('api_key_denied', exchange,
        `API key denied — trading paused (check IP allowlist): ${reason}`, { reason });
      // Deliberately NOT cancelling open orders here: cancelOrder is itself an
      // authenticated call that would fail (same IP block) and just churn. Live
      // orders are left untouched; new entries are blocked via canPlaceEntry.
      if (callbacks.onHealthChange) {
        callbacks.onHealthChange('AUTH_DENIED', reason);
      }
    },
  });

  // Instrument REST calls so adapter errors/latency/rate-limits actually drive
  // SAFE-mode triggers (issue #211-B — previously dead code with no call sites).
  adapter = instrumentAdapterForHealth(adapter, healthMonitor);

  const tailEvents = createTailEventsMonitor(exchange, config, {
    onFlashMove: (delta, multiple) => {
      tradeEvents.emitTradeEvent('flash_move', exchange, `Flash move: ${multiple.toFixed(1)}x ATR`, { delta, multiple });
      cancelReactiveEntriesOnFlash();
    },
    // Fired once per pause entry; a breach during an active pause is a no-op.
    onSpreadPause: (spreadBps, maxSpreadBps) => {
      tradeEvents.spreadPause(exchange, spreadBps, maxSpreadBps, fundEventData);
    },
    onRegimeTransition: (newMode, reason) => {
      regimeDetector.forceTransition(newMode, reason);
    },
  });

  const regimeDetector = createRegimeDetector(exchange, config, {
    onTransition: (prevMode, newMode, reason) => {
      tradeEvents.emitTradeEvent('regime_change', exchange, `${prevMode} -> ${newMode}`, { prevMode, newMode, reason });
      if (callbacks.onRegimeChange) {
        callbacks.onRegimeChange(prevMode, newMode, reason);
      }
    },
  }, productId);

  const positionSizer = createPositionSizer(exchange, config);
  const riskManager = createRiskManager(exchange, config, productId);

  // State (initialized before executor so dry-run can reference marketState)
  let marketState = createInitialMarketState();
  const tradeWindow = createTradeWindow(3 * 60 * 1000);
  Object.defineProperty(marketState, 'trades', { enumerable: false, get: tradeWindow.getTrades });
  const positionState = createInitialPositionState();

  // positionState keeps one object identity for the engine's lifetime so
  // extracted sub-modules can capture it. Every "reassignment" goes through
  // here: clear own keys, then copy the new ones in (the caller evaluates
  // `next` before the clear, so spreads of the old state are safe).
  const replacePositionState = (next) => {
    if (next === positionState) return positionState;
    for (const key of Object.keys(positionState)) delete positionState[key];
    return Object.assign(positionState, next);
  };
  // Listener ownership is runtime state; persisted position projections must
  // remain cloneable during buy/sell economic correction transactions.
  let stateReloadSignalInstalled = false;
  let priceIncrement = 0.01; // Updated from product details in start()
  let productDetails = null; // Cached from start() for min-order-size checks

  // Entry-block kinds (risk-manager reason prefixes, e.g. 'drawdown_paused')
  // already logged for the current block episode. Entries are evaluated on
  // every tick, so a persistent block would otherwise log several times a
  // second. A kind is forgotten once a check no longer reports it.
  let loggedEntryBlockKinds = new Set();
  // Track if budget exhausted warning has been logged (to avoid log spam)
  let budgetExhaustedWarningLogged = false;
  // Cap types (CAP_ALERT_LABELS keys) currently blocking entries and already
  // announced as cap_reached. A type leaves the set as soon as an entry check
  // no longer reports it, so re-entering that cap alerts again (issue #1030).
  let announcedCaps = new Set();
  // Notifications advertise an HOURLY summary; the summary log itself runs on
  // every metrics tick, so the event is throttled separately.
  let lastHourlySummaryEventAt = Date.now();
  // Guard against concurrent ATH backfill requests
  let athUpdateInProgress = false;

  // Callbacks container for dry-run (populated after functions are defined)
  const dryRunCallbacks = {
    onBuyFill: null,
    onSellFill: null,
  };

  // Callbacks container for live mode fill detection (populated after functions are defined)
  const liveCallbacks = {
    onFillDetected: null,
  };

  /**
   * Raise a saved pending entry/ladder row's knownFilledSize high-water mark
   * (issues #673 and #764). Searches BOTH saved lists: the executor
   * fires onEntryCancelled for 'entry' and 'ladder_entry' orders alike, and a
   * ladder rung that loses its partial size is exposed to the same
   * under-reporting re-poll as a plain entry.
   *
   * Persists immediately when the mark rises: the stamp exists precisely for
   * the window in which the fill it describes may fail to book, and leaving it
   * to the periodic state-save timer would let a restart inside that window
   * lose it — startImpl's catch-up would then trust an under-reporting poll
   * and purge the real partial. Guarded save: this runs inside the executor's
   * cancel callback, where a disk-error throw must not abort the fill routing
   * that follows.
   * @param {string} orderId
   * @param {number} filledSize
   */
  const stampKnownFilledSize = (orderId, filledSize) => {
    if (!(filledSize > 0)) return;
    let raised = false;
    for (const list of ['pendingEntryOrders', 'pendingLadderOrders']) {
      const row = positionState[list]?.find(e => e.orderId === orderId);
      if (row && !((row.knownFilledSize || 0) >= filledSize)) {
        row.knownFilledSize = filledSize;
        raised = true;
      }
    }
    if (raised && !isDryRun) saveLiveStateGuarded('known-filled-size');
  };

  /**
   * order-executor's onEntryCancelled callback: fires from handleCancelledOrder
   * for every cancelled 'entry' / 'ladder_entry' order, just before any fill it
   * carries is routed through onFillDetected.
   * @param {string} orderId
   * @param {{filledSize?: number}} [info]
   */
  const handleEntryCancelled = (orderId, info) => {
    // A cancel that also carries a fill (info.filledSize > 0) is about
    // to be routed through onFillDetected right after this fires —
    // purging the saved row here, before that fill's outcome is known,
    // would orphan a real buy with nothing left to rediscover it if
    // processing fails and the #679 engine-level retry exhausts (issue
    // #673). Leave it: a successful fill removes it via
    // handleOrderFillImpl's own terminal-entry filter, and a failure
    // leaves it for reconcileTick's orphan sweep to catch up. Only a
    // genuinely empty cancel (nothing to book) is safe to purge here.
    const filledSize = info?.filledSize || 0;
    if (filledSize > 0) {
      // Stamp the resolved high-water mark onto the saved row itself
      // (issue #673): handleCancelledOrder resolved this
      // value via order-executor's own partialFillTracker fallback,
      // which it then deletes. A LATER independent re-poll of this
      // same (already-cancelled) order — the reconcile sweep, or startImpl's
      // offline catch-up — can get a status whose filledSize reads
      // back as 0/missing (the same adapter quirk
      // handleCancelledOrder's fallback exists for), and would
      // otherwise misread a real partial as an empty cancel and purge
      // it with nothing booked. Persisting it here survives a restart
      // too, since positionState is saved to disk. Ladder rungs get the
      // same stamp (issue #764).
      stampKnownFilledSize(orderId, filledSize);
      return;
    }
    // "Empty" per THIS cancel read — but a row already carrying a
    // knownFilledSize has a confirmed partial that was never booked (a
    // successful booking removes the row). That happens when a failed
    // catch-up re-armed executor tracking via restorePendingOrder, which
    // does not repopulate partialFillTracker, so the re-cancel resolves
    // filledSize from an under-reporting status alone (issue #764). Keep
    // the row for reconcileTick's orphan sweep, which books knownFilledSize.
    const savedEntry = positionState.pendingEntryOrders?.find(e => e.orderId === orderId);
    if (savedEntry?.knownFilledSize > 0) {
      logger.warn(
        `⚠️ [${exchange}] Entry ${orderId.slice(0, 8)} re-cancelled with no reported fill, but a ${savedEntry.knownFilledSize} partial is already known — keeping it for the orphan sweep instead of purging`,
        { orderId, knownFilledSize: savedEntry.knownFilledSize }
      );
      return;
    }
    if (positionState.pendingEntryOrders?.length > 0) {
      positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(e => e.orderId !== orderId);
    }
  };

  // Create order executor - use dry-run executor when dryRun is enabled
  // Callbacks are set up later after internal functions are defined.
  // `let` so the #196 concurrency tests can inject a mock; no production
  // reassignment.
  let orderExecutor = isDryRun
    ? createDryRunExecutor(exchange, config, marketState, {
        onBuyFill: (...args) => dryRunCallbacks.onBuyFill && dryRunCallbacks.onBuyFill(...args),
        onSellFill: (...args) => dryRunCallbacks.onSellFill && dryRunCallbacks.onSellFill(...args),
      }, productId)
    : createOrderExecutor(exchange, config, adapter, productId, {
        onFillDetected: (orderId, status) => liveCallbacks.onFillDetected && liveCallbacks.onFillDetected(orderId, status),
        getRecordedSizeForOrder: (orderId) => fillLedger.getRecordedSizeForOrder(orderId),
        onEntryCancelled: (orderId, info) => handleEntryCancelled(orderId, info),
        // A stale-order timer is a top-level writer (#1959): during a backup
        // hold it parks before cancelling, then re-checks the order. stop()
        // clears unfired timers but wakes parked checks when it releases the
        // hold, so a check that parked across a stop is dropped instead of
        // reading and cancelling orders on the exchange while shutdown drains.
        withStaleCheckFence: (run) => {
          const stopsAtFire = stopGeneration;
          return fencedWrite(`engine-stale-order:${fundLabel}`,
            () => (stopGeneration === stopsAtFire ? run() : Promise.resolve()));
        },
      }, pair);

  validateExecutor(orderExecutor, isDryRun ? 'dry-run' : 'live');

  // `let` so the #196 reconcile lock-release test can inject a mock with a
  // controllable deferred promise; no production reassignment.
  let recoveryModule = createRecoveryModule(exchange, adapter, productId);

  // Create TP optimizer for dynamic TP adjustment
  const tpOptimizer = createTpOptimizer(exchange, config, {
    onAdjustment: (adjustment) => {
      logger.info(
        `📊 [${exchange}] ${modeLabel}TP auto-adjusted: min=${adjustment.tpMinPercent}% max=${adjustment.tpMaxPercent}% holdbackRatio=${adjustment.holdbackRatio}`,
        adjustment
      );
    },
  }, productId);

  // Create Size optimizer for dynamic position sizing
  const sizeOptimizer = createSizeOptimizer(exchange, config, {
    onAdjustment: (adjustment) => {
      logger.info(`📊 [${exchange}] ${modeLabel}Size auto-adjusted: ${adjustment.reason}`, adjustment);
    },
  }, productId);

  // Create Ladder calculator for pre-positioned liquidity ladder mode
  const ladderCalculator = createLadderCalculator(exchange, config);
  // Single source of truth for ladder market inputs: placement, preview and re-ladder
  // must feed the calculator identically (#851 gates placement on the preview).
  const buildLadderFromMarket = (marketState, budget, priceIncrement, allocatedCapital = getAllocatedCapital()) => {
    const ladder = ladderCalculator.buildLadder(marketState.lastPrice, budget, {
      atr: marketState.atr1m,
      volBaseline: marketState.volBaseline,
      realizedVol: marketState.realizedVol,
      athDistance: marketState.athDistance || 0,
      ath: marketState.ath || 0,
      priceIncrement,
    });
    return applyAutoLadderSizing(ladder, {
      budget,
      allocatedCapital,
      maxUsdcDeployed: config.maxUsdcDeployed,
      minSize: config.minOrderSizeUsdc || exchangeConfig.minOrderSize || 5,
      getAutoSizeMult: macroRegime?.getAutoSizeMult ? (ratio) => macroRegime.getAutoSizeMult(ratio) : undefined,
    });
  };

  // Create Macro Regime detector (multi-timeframe EMA overlay)
  const macroRegime = config.macroEnabled
    ? createMacroRegime(exchange, config, adapter, productId)
    : null;

  let isRunning = false;
  let isStarting = false; // reentrancy guard for start() (#113)
  // Bumped by every stop(). A writer parked at the backup fence compares it
  // after the park to tell whether the engine was stopped meanwhile.
  let stopGeneration = 0;
  // Entry admission (#1009). An entry evaluation captures this generation
  // before its balance preflight; stop() and close() bump it synchronously and
  // a successful start opens a fresh one, so an evaluation still awaiting the
  // exchange when the fund stops or starts draining can never submit later —
  // not even after a restart revived isRunning.
  let entryAdmissionGeneration = 0;
  const invalidateEntryAdmission = () => { entryAdmissionGeneration += 1; };
  /**
   * Capture entry admission for one evaluation.
   * @returns {() => boolean} true while the same generation is open on a running ACTIVE fund
   */
  const captureEntryAdmission = () => {
    const generation = entryAdmissionGeneration;
    return () => generation === entryAdmissionGeneration
      && isRunning
      && (!positionState.lifecycle || positionState.lifecycle === LIFECYCLE.ACTIVE);
  };
  let wsFeed = null;
  let metricsInterval = null;
  let reconcileInterval = null;
  // Merge / reconcile / fill / entry / ladder-sweep mutual exclusion lives in
  // engine-locks.js (#580, #766). Fills wait (bounded) for an in-flight merge
  // or ladder sweep; a merge never waits on fills or on the ladder lock.
  // Manual operator merges are not gated on in-flight fills (deliberate).
  const engineLocks = createEngineLocks({
    logWarn: (msg) => logger.warn(msg),
  });
  // Every top-level engine writer passes the backup fence (#1945) inside its
  // tracked write: while a backup holds the fund's files it parks there and is
  // marked parked, so the backup drain joins everything else but never waits
  // on it. Work nested in a writer that already passed runs straight through.
  const fencedWrite = (label, run) => trackPendingWrite(label, () => engineLocks.withBackupFence(run));
  // Cooldown after a failed dust consolidation so a body that can't currently be
  // merged (e.g. target TP partially filled) doesn't re-attempt+re-log every
  // cycle (#189). 0 = no cooldown.
  let dustMergeRetryAfter = 0;
  // Bound on stop()'s wait for in-flight fill handlers (test-overridable).
  let fillDrainMs = FILL_DRAIN_MS;

  // Flash-move entry protection (#1028). With cancelEntriesOnFlash on, a flash
  // pulls resting reactive bids. Two fences keep a new reactive bid from
  // slipping past the sweep: bumping reactiveFlashEpoch fails admission for any
  // reactive evaluation captured before the flash (placeEntryBid re-checks it
  // just before dispatch), and evaluateReactiveEntry refuses to start while
  // flashCancelSweep is set. Ladder rungs (`ladder_entry`) and TPs are exempt:
  // cancelAllEntries only targets reactive `entry` orders, and the ladder path
  // uses the plain admission, untouched by the epoch.
  let reactiveFlashEpoch = 0;
  /** @type {Promise<void>|null} The one in-flight sweep; overlapping flashes coalesce onto it. */
  let flashCancelSweep = null;
  // Bound on the sweep's wait for an already-dispatched entry to land (test-overridable).
  let flashEntryWaitMs = FILL_DRAIN_MS;

  /**
   * Admission for one reactive evaluation: the shared #1009 admission plus the
   * flash fence. Ladder evaluations keep using captureEntryAdmission directly.
   * @returns {() => boolean}
   */
  const captureReactiveEntryAdmission = () => {
    const isAdmitted = captureEntryAdmission();
    const epoch = reactiveFlashEpoch;
    return () => isAdmitted() && epoch === reactiveFlashEpoch;
  };

  /**
   * Cancel resting reactive entries after a flash move (#1028). Synchronous
   * entry point for the tail monitor's callback: the fence is raised before it
   * returns, and the exchange work runs as a tracked pending write so stop()
   * and the fund drain wait for it. Fill/refusal ownership stays with
   * orderExecutor.cancelAllEntries (a refused or unverifiable cancel keeps the
   * order tracked; discovered fills route through onFillDetected).
   */
  const cancelReactiveEntriesOnFlash = () => {
    if (config.cancelEntriesOnFlash === false) return;
    reactiveFlashEpoch += 1;
    if (flashCancelSweep) return;
    flashCancelSweep = fencedWrite(`engine-flash-cancel:${fundLabel}`, async () => {
      logger.warn(`⚡ [${exchange}] Flash move — cancelling resting reactive entries (cancelEntriesOnFlash)`);
      // An entry already dispatched is not in pendingOrders until its response
      // lands; sweeping first would miss it. Wait (bounded) for the entry-lock
      // holder — the epoch bump makes any not-yet-dispatched reactive bid bail.
      // A placement that outlives the wait is swept around, and the fence
      // stays up for another sweep once it lands — even across stop(), whose
      // bounded wait moves on while the fund drain keeps joining this write.
      for (;;) {
        const deadline = Date.now() + flashEntryWaitMs;
        while (engineLocks.isEntryInProgress() && Date.now() < deadline) {
          await sleep(25);
        }
        const placementInFlight = engineLocks.isEntryInProgress();
        if (placementInFlight) {
          logger.warn(`⚠️ [${exchange}] Flash cancel: an entry placement is still in flight after ${flashEntryWaitMs / 1000}s — sweeping now and again once it lands`);
        }
        // A failed sweep is logged, not thrown: it must not end the loop while
        // a late placement still needs its follow-up sweep. Orders it could
        // not cancel stay tracked by the executor.
        await orderExecutor.cancelAllEntries().catch((err) => logger.error(
          `❌ [${exchange}] Flash entry cancel failed: ${err.message}`, { error: err.message }
        ));
        if (!placementInFlight) break;
      }
    }).catch((err) => logger.error(
      `❌ [${exchange}] Flash entry cancel sweep aborted: ${err.message}`, { error: err.message }
    )).finally(() => { flashCancelSweep = null; });
  };
  let stateSaveInterval = null;
  let fillDriftInterval = null;
  let fillDriftInFlight = false;
  /** @type {AbortController|null} Cancels an in-flight drift sweep's history read on stop (issue #966). */
  let fillDriftAbort = null;
  // Most recent drift verdict, surfaced on getState() so the UI/operator sees a
  // leak without reading logs. null until the first sweep completes.
  let fillDrift = null;
  // Most recent "does the model cover what we actually hold" verdict, surfaced
  // on getState() alongside fillDrift. null until the first sweep completes.
  let positionCoverage = null;
  const MERGE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
  const FILL_DEDUP_TTL_MS = 5 * 60 * 1000;
  const POLL_FILL_DEDUP_TTL_MS = 60 * 1000;
  const recentlyProcessedFills = createTtlStore(POLL_FILL_DEDUP_TTL_MS); // Dedup guard: prevents double-processing when stale check and fill check race
  // Bounded engine-level retry for a polled fill whose adapter-side
  // completeness check (issue #679) still comes up short after the
  // adapter's own brief internal retry. Keyed by the SAME dedup key as
  // recentlyProcessedFills. A terminal order is already removed from
  // orderExecutor's pendingOrders by the time this callback runs
  // (checkPendingOrderFills deletes before invoking it), and exchanges
  // like Gemini have no order-event WebSocket — so "will retry on next
  // reconcile" is not actually true for this failure mode, and this map
  // exists to make it true.
  const incompleteFillRetries = new Map(); // dedupKey -> attempt count
  let incompleteFillMaxRetries = 5;
  let incompleteFillRetryDelayMs = 10000; // overridable via _test.setIncompleteFillRetryTiming for fast tests
  const recentlyProcessedSellFills = createTtlStore(FILL_DEDUP_TTL_MS); // Dedup guard: prevents sell orders from being processed twice across WS/reconcile/polling
  const recentlyProcessedBuyFills = createTtlStore(FILL_DEDUP_TTL_MS); // Dedup guard: prevents buy orders from being processed twice across WS/polling (would duplicate the body at full size)
  const tpPlacementInFlight = new Set(); // Dedup guard: prevents concurrent placeBodyTp calls for the same body

  // Transition-only logging guards (#187). These states persist across many
  // updateMetrics cycles (a body lacking a TP, a sub-min "dust" body waiting to
  // consolidate, a low-balance entry pause), so logging them every ~60s cycle
  // floods the log with identical lines. We log on state CHANGE only — control
  // flow / trading behavior is unchanged; the placement/entry attempts still run
  // every cycle so the state recovers the moment it can.
  let lastTpNeedKey = null;            // sorted body-ids currently lacking a TP
  const dustWaitLoggedQty = new Map(); // bodyId -> last-logged sub-min rounded qty
  let lowBalancePauseLogged = false;   // true while inside an already-logged low-balance pause

  // Race 3: Merge-snapshot maps for fills arriving after body removal during merges
  // tpOrderId → body snapshot (active during merge operation)
  const pendingMergeTpOrders = new Map();
  // tpOrderId → body snapshot, retained for the five-minute late-fill race window.
  const completedMergeTpOrders = createTtlStore(MERGE_SNAPSHOT_TTL_MS);
  /** A sell order the body-TP booking path (live body or merge snapshot) owns. */
  const isBodyTpSellOrder = (orderId) => pendingMergeTpOrders.has(orderId)
    || completedMergeTpOrders.has(orderId)
    || (positionState.celestialBodies || []).some(b => b.tpOrderId === orderId);
  const completeMergeSnapshot = (snapshot) => {
    const orderId = snapshot.tpOrderId;
    if (!orderId) return;
    pendingMergeTpOrders.delete(orderId);
    completedMergeTpOrders.add(orderId, snapshot);
  };

  // Track TTL timers for cleanup on shutdown
  const ttlTimers = new Set();

  /**
   * Handle TP optimizer adjustment
   * Updates in-memory config and persists to config.json
   * @param {Object} adjustment - Adjustment from optimizer
   */
  const handleTpAdjustment = (adjustment) => {
    // Update in-memory config
    config.tpMinPercent = adjustment.tpMinPercent;
    config.tpMaxPercent = adjustment.tpMaxPercent;
    config.holdbackRatio = adjustment.holdbackRatio;

    // Persist to config.json
    updateRegimeConfig(exchange, pair, {
      tpMinPercent: adjustment.tpMinPercent,
      tpMaxPercent: adjustment.tpMaxPercent,
      holdbackRatio: adjustment.holdbackRatio,
    });

    tradeEvents.emitTradeEvent('tp_adjusted', exchange, `TP adjusted: ${adjustment.tpMinPercent}%-${adjustment.tpMaxPercent}%`, {
      tpMinPercent: adjustment.tpMinPercent,
      tpMaxPercent: adjustment.tpMaxPercent,
      holdbackRatio: adjustment.holdbackRatio,
      reason: adjustment.reason,
    });
  };

  /**
   * Handle Size optimizer adjustment
   * Updates in-memory config and persists to config.json
   * @param {Object} adjustment - Adjustment from optimizer
   */
  const handleSizeAdjustment = (adjustment) => {
    // Reject adjustments that manual saves would refuse, before touching
    // memory or persistence (issue #867).
    const sizingErrors = validateSizingFields(adjustment);
    if (sizingErrors.length > 0) {
      logger.warn(`⚠️ [${exchange}] Size adjustment rejected, config unchanged: ${sizingErrors.join("; ")}`);
      return;
    }

    const updates = {
      baseSizeUsdc: adjustment.baseSizeUsdc,
      maxUsdcDeployed: adjustment.maxUsdcDeployed,
    };

    // Optionally update max cycle buys
    if (adjustment.maxCycleBuys !== undefined) {
      updates.maxCycleBuys = adjustment.maxCycleBuys;
      config.maxCycleBuys = adjustment.maxCycleBuys;
    }

    // Update in-memory config
    config.baseSizeUsdc = adjustment.baseSizeUsdc;
    config.maxUsdcDeployed = adjustment.maxUsdcDeployed;

    // Persist to config.json
    updateRegimeConfig(exchange, pair, updates);

    tradeEvents.emitTradeEvent('size_adjusted', exchange, `Size adjusted: base=$${adjustment.baseSizeUsdc}`, {
      baseSizeUsdc: adjustment.baseSizeUsdc,
      maxUsdcDeployed: adjustment.maxUsdcDeployed,
      maxCycleBuys: adjustment.maxCycleBuys,
      reason: adjustment.reason,
    });
  };

  /**
   * Record cycle completion for TP optimizer
   * @param {Object} cycleData - Data about the completed cycle
   */
  const recordCycleForOptimizer = (cycleData) => {
    if (!config.tpAutoManaged) return;

    const adjustment = tpOptimizer.recordCycle({
      optimalTpPct: cycleData.optimalTpPct || 0,
      actualTpPct: cycleData.actualTpPct || 0,
      completedAt: Date.now(),
      volBaseline: marketState.volBaseline || 0,
    });

    if (adjustment) {
      handleTpAdjustment(adjustment);
    }
  };

  /**
   * Hand a closed (drained) fund to the host's onLifecycleClosed callback on the
   * next tick, so teardown never waits on the call stack that requested it.
   * The whole deferral + async callback is one tracked pending write (visible
   * to restore drains from scheduling until teardown settles), and every sync
   * throw or async rejection is contained and logged here — an unowned
   * rejection would reach the process guard and kill every fund in the process.
   */
  const scheduleLifecycleClosed = () => {
    if (!callbacks.onLifecycleClosed) return;
    fencedWrite(`engine-lifecycle-close:${fundLabel}`, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await callbacks.onLifecycleClosed();
    }).catch((err) => logger.warn(`⚠️ [${exchange}] onLifecycleClosed callback error: ${err.message}`, { error: err.message }));
  };

  /**
   * Record cycle completion for Size optimizer
   *
   * Build the optimizer's equity input from verified free quote and open fund
   * commitments. Feeding the configured cap back in would shrink it on every
   * evaluation (#694).
   *
   * @param {{stepsUsed: number, capitalDeployed: number, closedCoreTpOrderId?: string}} cycleData
   * @returns {Promise<void>}
   */
  const recordCycleForSizeOptimizer = (cycleData) => fencedWrite(`engine-size-optimizer:${fundLabel}`, async () => {
    if (!config.sizeAutoManaged) return;

    // getAccountBalance is ACCOUNT-wide, not fund-scoped (same caveat as
    // checkPositionCoverage above). With two+ funds on this exchange sharing
    // a quote currency (e.g. BTC-USDC and ETH-USDC both settling in USDC),
    // each fund's optimizer would otherwise see the WHOLE shared wallet and
    // could independently ratchet its OWN maxUsdcDeployed up toward ~90% of
    // that shared total — over-committing capital across sibling funds
    // (issue #694). Skip the fetch in that case, the same way
    // checkPositionCoverage skips its check, rather than act on unsound data.
    //
    // A fund's configured identity `pair` and its actual traded `productId`
    // can differ by quote currency (a documented, supported override — see
    // productIdMatchesPair in config-utils.js), so comparing raw `f.pair`
    // quote currencies can UNDER-count true sharing.
    // Resolve each candidate's EFFECTIVE traded quote from its RAW per-pair
    // config block, not getFundConfig()/getRegimeConfig() (both DEFAULTS/
    // regime-merged results, so `.productId` is NEVER falsy there — it
    // silently reads back DEFAULTS.productId = 'BTC-USDC' for any fund with
    // no explicit override, making `|| f.pair` dead code and misclassifying
    // every such fund as quoting USDC; this exact trap was already
    // worked around the same way in
    // config-snapshot.js:117 — `fundBlock?.productId ?? pair`, read from the
    // raw block).
    const quoteCurrency = getQuoteCurrency(productId);
    const sharingQuote = getConfiguredFunds()
      .filter(f => f.exchange === exchange)
      .filter(f => {
        const rawBlock = normalizeExchangeBlock(loadConfig().exchanges?.[f.exchange] || {}).pairs?.[f.pair];
        return getQuoteCurrency(rawBlock?.productId ?? f.pair) === quoteCurrency;
      });

    // A failed/unavailable/ambiguous fetch (including an adapter with no
    // getAccountBalance at all — some test/legacy adapters) passes 0. When
    // the fetch was skipped for sharing ambiguity specifically, ALSO force
    // sizeOptimizer's cached lastKnownBalance back to unset — a fund that
    // used to be the sole holder of this quote currency (balance previously
    // recorded) but now shares it with a newly-added sibling must not keep
    // evaluating against that now-unscoped stale value forever. A plain
    // fetch failure/missing method is NOT forced this way
    // — sizeOptimizer.recordCycle() already treats availableBalance<=0 there
    // as "no fresh reading" and correctly keeps the last verified balance,
    // since a transient failure is expected to recover on its own.
    const balanceAmbiguous = sharingQuote.length > 1;
    const quoteBalance = (!balanceAmbiguous && typeof adapter.getAccountBalance === 'function')
      ? await lookupOrNull('getAccountBalance', quoteCurrency, adapter.getAccountBalance(quoteCurrency))
      : null;
    const availableQuote = quoteBalance ? Number(quoteBalance.available ?? NaN) : NaN;

    // This now runs AFTER resetCycle() at every call site (issue #694) —
    // every caller awaits resetCycle() but then invokes this
    // function WITHOUT awaiting it (fire-and-forget, .catch()'d at the call
    // site) so its own network round-trip (adapter.getAccountBalance, up to
    // a 30s exchange timeout) never delays the caller's own
    // saveLiveState()/fillLedger.persist()/saveDryRunState() from durably
    // persisting the already-completed cycle close. A
    // crash during this call loses only this one best-effort optimizer stats
    // sample, never P&L-critical state. Any throw here (sizeOptimizer.
    // recordCycle()'s own bookkeeping, or handleSizeAdjustment()'s
    // updateRegimeConfig disk write) is therefore also caught and swallowed
    // internally, so it can never become an unhandled rejection.
    try {
      if (balanceAmbiguous) {
        sizeOptimizer.invalidateBalance();
      }
      // Open bodies are valued at cost. The wallet's free quote already
      // excludes live buy holds, so add the remaining commitments once.
      // Paper orders never reduce that wallet's quoted available balance.
      let fundEquity = 0;
      if (Number.isFinite(availableQuote) && availableQuote >= 0) {
        fundEquity = availableQuote;
        if (!isDryRun) {
          // If reset failed after a legacy core sale, its old aggregate cost
          // can still be in positionState even though the fill was booked.
          const soldCoreAwaitingReset = cycleData.closedCoreTpOrderId
            && positionState.activeTpOrderId === cycleData.closedCoreTpOrderId;
          fundEquity += soldCoreAwaitingReset ? getOpenBodyCost() : getAllocatedCapital();
          // Partial-fill booking shrinks these tracked rows by the cost
          // booked into a body, so sizeUsdc is already the remaining hold.
          for (const order of [...(positionState.pendingEntryOrders || []), ...(positionState.pendingLadderOrders || [])]) {
            fundEquity += order.sizeUsdc || 0;
          }
        }
      }
      const adjustment = sizeOptimizer.recordCycle({
        stepsUsed: cycleData.stepsUsed || 0,
        capitalDeployed: cycleData.capitalDeployed || 0,
        completedAt: Date.now(),
        availableBalance: fundEquity,
      });

      if (adjustment) {
        handleSizeAdjustment(adjustment);
      }
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Size optimizer recording failed (non-fatal): ${err.message}`, { error: err.message });
    }
  });

  /**
   * Re-save after recordCycleForSizeOptimizer's detached (fire-and-forget)
   * call resolves, so its result isn't left only in memory (issue #694).
   * Guarded: this runs inside a `.finally()` on a promise
   * chain nobody awaits, so an unguarded throw (e.g. a disk fault —
   * ENOSPC/EACCES/EROFS — surfacing from saveLiveState()/fillLedger.persist())
   * would be a genuinely unhandled promise rejection, which can crash a live
   * trading process with resting orders on the exchange — precisely the
   * hazard saveLiveStateGuarded exists to prevent for every other background
   * caller in this file.
   */
  const resaveAfterSizeOptimizerLive = () => {
    try {
      saveLiveStateGuarded('size-optimizer-record');
      fillLedger.persist();
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Post-size-optimizer state save failed (non-fatal): ${err.message}`, { error: err.message });
    }
  };
  const resaveAfterSizeOptimizerDryRun = () => {
    try {
      saveDryRunState();
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Post-size-optimizer dry-run state save failed (non-fatal): ${err.message}`, { error: err.message });
    }
  };

  // State persistence (dry-run + live save/load, SIGUSR1 reload, realized-P&L refresh).
  // isExtendInFlight (regime-operator-actions) and the episode-state helpers are
  // declared later in this closure, so they are passed as thunks that resolve at
  // call time.
  const {
    snapshotDryRunState, saveDryRunState, saveDryRunStateGuarded, loadDryRunState,
    refreshRealizedFromCyclePairs, syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
    saveLiveState, saveLiveStateGuarded, reloadStateFromDisk, loadLiveState, flushDeferredSave,
  } = createEngineStatePersistence({
    exchange, pair, baseCurrency, fundLabel, isDryRun, config, logger,
    positionState, replacePositionState, createInitialPositionState,
    fillLedger, tpOptimizer, sizeOptimizer, regimeDetector, macroRegime, healthMonitor, engineLocks,
    tpPlacementInFlight,
    isExtendInFlight: () => isExtendInFlight(),
    getOrderExecutor: () => orderExecutor,
    persistEpisodeState: () => persistEpisodeState(),
    restoreEpisodeState: (saved) => restoreEpisodeState(saved),
  });

  // APY calculation delegates to extracted module
  const calculateApyMetrics = () => _calculateApyMetrics(positionState, config, marketState);
  const initializeApyTracking = () => _initializeApyTracking(
    positionState, config, exchange,
    isDryRun ? () => orderExecutor.getFilledOrders() : undefined,
    productId
  );

  const autoCloseDrainedFund = () => {
    // Auto-close: if fund is draining but position is fully empty after recovery,
    // transition to closed immediately instead of running an empty engine.
    if (closeDrainedEmptyPosition(positionState)) {
      logger.info(`🛑 [${exchange}] Draining fund has empty position — auto-closing`);
      if (!isDryRun) saveLiveState();
      scheduleLifecycleClosed();
      return true;
    }
    return false;
  };

  const startFillDriftSweep = () => {
    // Exchange-vs-ledger drift check. Deliberately on its own timer rather
    // than inside reconcileTick: it is a read-only network sweep and must
    // never hold the reconcile lock behind a slow or hung trade fetch.
    // 0 disables. Any positive value is clamped to a floor: the sweep is a
    // full-history exchange fetch, and a misconfigured `fillDriftSweepMs: 1`
    // would queue one every millisecond, exhausting the rate limit the trading
    // path depends on.
    const configuredSweepMs = config.fillDriftSweepMs ?? 0;
    const driftSweepMs = configuredSweepMs > 0
      ? Math.max(configuredSweepMs, MIN_FILL_DRIFT_SWEEP_MS)
      : 0;
    if (configuredSweepMs > 0 && driftSweepMs !== configuredSweepMs) {
      logger.warn(`⚠️ [${exchange}] fillDriftSweepMs ${configuredSweepMs}ms is below the ${MIN_FILL_DRIFT_SWEEP_MS}ms floor — using the floor`, {
        configured: configuredSweepMs,
        applied: driftSweepMs,
      });
    }
    if (driftSweepMs > 0 && adapter.capabilities?.fillReconciliation) {
      fillDriftInterval = setInterval(() => {
        // A slow exchange can outlast the interval; never stack sweeps.
        // A long Crypto.com history now completes over many paced steps
        // (issue #966), so this guard also spans that whole traversal.
        if (fillDriftInFlight) return;
        fillDriftInFlight = true;
        const abort = new AbortController();
        fillDriftAbort = abort;
        sweepLedgerDrift(abort.signal)
          .catch(err => {
            logger.error(`❌ [${exchange}] Ledger drift sweep failed: ${err.message}`, { error: err.message });
          })
          .finally(() => {
            fillDriftInFlight = false;
            if (fillDriftAbort === abort) fillDriftAbort = null;
          });
      }, driftSweepMs);
    }
  };

  const installStateReloadSignal = () => {
    // SIGUSR1: reload state from disk (for applying manual state fixes without restart).
    // One listener per fund, so a single signal reloads EVERY live fund in this
    // exchange process, not just the one whose files were edited. Each fund
    // decides independently: a fund mid-fill defers (see reloadStateFromDisk)
    // while the idle ones reload — re-send the signal for the deferred fund.
    if (!isDryRun && !stateReloadSignalInstalled) {
      process.on('SIGUSR1', reloadStateFromDisk);
      stateReloadSignalInstalled = true;
    }
  };

  const restoreStartupDryRunState = () => {
    // Try to load saved dry-run state
    const loaded = loadDryRunState();
    if (!loaded) {
      logger.info(`🧪 [${exchange}] [DRY-RUN] No saved state, starting fresh`);
      replacePositionState(createInitialPositionState());
    }
  };

  /**
   * Start the regime engine
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const startImpl = async () => {
    logger.info(`🚀 [${exchange}] ${modeLabel}Starting regime engine for ${productId}`);

    // Fetch product details for price tick size (affects TP price rounding)
    productDetails = await adapter.getProductDetails(productId).catch((err) => {
      logger.warn(
        `⚠️ [${exchange}] Could not fetch product details: ${err.message}, using default price increment`,
        { error: err.message, productId }
      );
      return null;
    });
    if (productDetails?.quoteIncrement) {
      priceIncrement = parseFloat(productDetails.quoteIncrement) || 0.01;
      logger.info(`📏 [${exchange}] Price increment: ${priceIncrement}`);
    }
    orderExecutor.setPriceIncrement(priceIncrement);

    // Recover state from exchange (skip in dry-run mode). The live sequence
    // lives in regime-startup-recovery (issue #1601).
    if (!isDryRun) {
      const blocked = await startupRecovery.restoreAll();
      if (blocked) return blocked;
    } else {
      restoreStartupDryRunState();
    }

    // Hydrate before the feed connects or any entry evaluation can run.
    hydrateDrawdownState();

    // Initialize APY tracking if not already set (preserves existing tracking from saved state)
    initializeApyTracking();

    // Restore macro regime state if available
    if (macroRegime && positionState.macroRegime) {
      macroRegime.restoreState(positionState.macroRegime);
    }

    if (autoCloseDrainedFund()) {
      return { success: true, autoClosed: true };
    }

    // Start WebSocket feed
    await connectWebSocket();

    // Start periodic metrics updates
    startMetricsUpdater();

    // Start macro regime detector
    if (macroRegime) {
      macroRegime.start();
    }

    // Start reconciliation and state saving
    if (!isDryRun) {
      startReconciliation();
      // Refresh realized P&L from buy↔sell cycle pairing on startup
      refreshRealizedFromCyclePairs();
      // Start periodic state saving for live mode (every 5 minutes)
      // Guarded: a bare `setInterval(saveLiveState, ...)` turns a full disk into
      // an uncaughtException that kills the process from a timer tick (#532).
      stateSaveInterval = setInterval(() => saveLiveStateGuarded('state-save-timer'), LIVE_STATE_SAVE_INTERVAL_MS);
      startFillDriftSweep();
    } else {
      // Start periodic state saving for dry-run (every 60 seconds)
      stateSaveInterval = setInterval(() => saveDryRunStateGuarded('state-save-timer'), DRY_RUN_STATE_SAVE_INTERVAL_MS);
    }

    invalidateEntryAdmission();
    isRunning = true;

    // Recovered partial rows of a body's own buy order (#752) grow that body
    // through extendBody now that the engine is live: it cancels the body's TP
    // BEFORE growing it, so a stale TP that fills first can never book the
    // recovered quantity as zero-cost holdback.
    extendBodiesFromRecoveredBuyRows();

    // Start Gemini heartbeat to prevent order auto-cancellation.
    // Owner key: the adapter is a per-exchange singleton shared across funds,
    // and its heartbeat is refcounted per owner so stopping one fund cannot
    // kill another fund's heartbeat.
    if (!isDryRun && adapter.startHeartbeat) {
      adapter.startHeartbeat(fundLabel);
    }

    logger.info(`✅ [${exchange}] ${modeLabel}Regime engine started`);

    installStateReloadSignal();

    return { success: true };
  };

  /**
   * Public start(): reentrancy-guarded wrapper around startImpl.
   *
   * isRunning is only set true near the END of startImpl (after recovery +
   * order checks), so two near-simultaneous start() calls (API double-tap)
   * could both pass an isRunning-only guard and spin up duplicate intervals /
   * WS feeds / SIGUSR1 handlers / TPs. The isStarting flag closes that window
   * without disturbing the recovery path that relies on isRunning being false
   * until ready. The try/finally is essential: startImpl awaits unguarded work
   * (recoverState, getCurrentPrice, connectWebSocket) that can reject on a
   * transient exchange error — clearing isStarting in finally keeps a failed
   * start RETRYABLE instead of permanently bricking the engine instance (#113).
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  let startPromise = null;
  const start = async () => {
    if (isRunning || isStarting) {
      logger.warn(`⚠️ [${exchange}] ${modeLabel}Regime engine already ${isRunning ? 'running' : 'starting'}`);
      return { success: false, error: 'Engine already running' };
    }
    isStarting = true;
    // A prior stop() closed the fill gate; startup recovery books fills.
    engineLocks.openFillGate();
    try {
      startPromise = startImpl();
      return await startPromise;
    } finally {
      startPromise = null;
      isStarting = false;
    }
  };

  /**
   * Stop the regime engine
   */
  const stop = async ({ keepHeartbeat = false } = {}) => {
    // Close entry admission before any await: an entry still in its balance
    // preflight must not submit once stop() has been requested (#1009).
    invalidateEntryAdmission();
    // A stop must outlive startup before releasing its resources. Failed
    // partial starts also own sockets/timers even though isRunning is false.
    if (startPromise) await startPromise.catch(() => {});
    const wasRunning = isRunning;

    logger.info(`🛑 [${exchange}] Stopping regime engine`);

    // Mark as not running FIRST to prevent callbacks from taking action
    isRunning = false;
    stopGeneration += 1;
    // A stop ends any backup hold on this fund: writers parked at the fence
    // wake into a stopping engine (fills are refused once the gate closes
    // below, and recovered on the next start) instead of waiting it out. The
    // backup window sees the released fence and refuses its pause (#1945).
    releaseBackupHold();

    // Persist-then-cleanup, with the teardown in `finally`: a throwing state
    // save used to abandon stop() before the timer/websocket cleanup below, so
    // a "stopped" engine kept ticking and kept writing. The rejection still
    // reaches callers (the backup-restore quiescence gate, issue #429) — the
    // engine is quiet, but its last state was not saved.
    try {
      // A partial recovery is not a valid snapshot: never overwrite durable
      // state merely to dispose an attempt that failed before running.
      if (!wasRunning) return;
      // A flash-cancel sweep (#1028) routes the fills it discovers through the
      // fill gate, so let it settle before the gate closes. Bounded like the
      // fill drain; the fund drain after stop() still joins its pending write.
      // The sweep and the fill drain share ONE fillDrainMs budget, so stop()'s
      // waits stay inside the shutdown watchdog's budget (engine-shutdown.js).
      const drainDeadline = Date.now() + fillDrainMs;
      if (flashCancelSweep) {
        let timer;
        const settled = await Promise.race([
          flashCancelSweep.then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), fillDrainMs); }),
        ]);
        clearTimeout(timer);
        if (!settled) {
          logger.warn(`⚠️ [${exchange}] Shutdown: flash entry cancel still in flight after ${fillDrainMs / 1000}s — saving state anyway; startup recovery will repair`);
        }
      }
      // Let fill handlers already past their gate finish (TP placement,
      // cancel/replace) so the snapshot below includes their writes and the
      // process is not killed between ledger ingest and TP booking. New
      // top-level fills are refused first; the drain is bounded so a hung
      // exchange call cannot block shutdown.
      engineLocks.closeFillGate();
      const drain = await engineLocks.waitForFillsIdle(Math.max(0, drainDeadline - Date.now()));
      if (!drain.idle) {
        logger.warn(
          `⚠️ [${exchange}] Shutdown: ${drain.pending} fill handler(s) still in flight after ${fillDrainMs / 1000}s (orders: ${drain.orderIds.join(', ')}) — saving state anyway; startup recovery will repair`,
          { pending: drain.pending, orderIds: drain.orderIds }
        );
      }
      // Save state before stopping
      if (isDryRun) {
        dryRunState.forceSave(exchange, snapshotDryRunState(), pair);
      } else {
        // Save live state on shutdown
        saveLiveState();
        // Force-persist the fill ledger: if the on-disk file became
        // unreadable mid-run (truncation, partial write by another tool,
        // etc.), the dirty-flag short-circuit + existsSync check would
        // skip the write, and the next cold start's load() would fail on
        // the corrupt file even though a recoverable in-memory ledger
        // existed. force=true rewrites the healthy snapshot unconditionally.
        fillLedger.persist({ force: true });
        logger.info(`💾 [${exchange}] Saved live state and fill ledger`);
      }
    } finally {
      if (stateReloadSignalInstalled) {
        process.removeListener('SIGUSR1', reloadStateFromDisk);
        stateReloadSignalInstalled = false;
      }
      // Deregister this fund from the shared heartbeat (the adapter only
      // clears the timer when no other fund still needs it). Mirrors the
      // !isDryRun condition in start() so a dry-run engine can never
      // deregister a live fund's heartbeat.
      if (!isDryRun && !keepHeartbeat && adapter.stopHeartbeat) {
        adapter.stopHeartbeat(fundLabel);
      }

      // Stop intervals first
      if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
      }

      if (reconcileInterval) {
        clearInterval(reconcileInterval);
        reconcileInterval = null;
      }

      if (stateSaveInterval) {
        clearInterval(stateSaveInterval);
        stateSaveInterval = null;
      }

      if (fillDriftInterval) {
        clearInterval(fillDriftInterval);
        fillDriftInterval = null;
      }
      // A sweep still walking exchange history must not outlive the engine.
      if (fillDriftAbort) {
        fillDriftAbort.abort();
        fillDriftAbort = null;
      }

      // Stop macro regime
      if (macroRegime) {
        macroRegime.stop();
      }

      tailEvents.cleanup();

      // Clear engine-owned retry timers; expiring records own their own timers.
      for (const t of ttlTimers) clearTimeout(t);
      ttlTimers.clear();
      if (!keepHeartbeat) {
        recentlyProcessedFills.clear();
        recentlyProcessedSellFills.clear();
        recentlyProcessedBuyFills.clear();
        pendingMergeTpOrders.clear();
        completedMergeTpOrders.clear();
      } else {
        recentlyProcessedFills.cancelTimers();
        recentlyProcessedSellFills.cancelTimers();
        recentlyProcessedBuyFills.cancelTimers();
        completedMergeTpOrders.cancelTimers();
      }

      // Clear order executor stale timers
      if (orderExecutor.clearTimers) orderExecutor.clearTimers();

      // Disconnect WebSocket last (callbacks will check isRunning)
      if (wsFeed) {
        wsFeed.disconnect();
        wsFeed = null;
      }
    }

    logger.info(`✅ [${exchange}] Regime engine stopped`);
  };

  /**
   * Connect to WebSocket feed
   */
  const connectWebSocket = async () => {
    const credentials = adapter.loadCredentials();

    wsFeed = createWebSocketFeed(exchange, {
      productId,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      onTicker: (data) => { if (isRunning) handleTicker(data); },
      onTrade: (data) => { if (isRunning) handleTrade(data); },
      onOrderUpdate: (data) => onWsOrderUpdate(data),
      onConnect: () => {
        if (isRunning) healthMonitor.recordWsStatus(true);
      },
      onDisconnect: () => {
        if (isRunning) {
          healthMonitor.recordWsStatus(false);
          // Clear the flash-move anchor so the first tick after the gap doesn't
          // fire a spurious flash-move against a stale pre-disconnect price (#211-D).
          tailEvents.resetLastPrice();
        }
      },
      onError: (error) => {
        if (isRunning) logger.error(`❌ [${exchange}] WebSocket error: ${error.message}`, { error: error.message });
      },
    });

    wsFeed.connect();
  };

  /**
   * WebSocket order-event callback: one tracked, backup-fenced write per event.
   * @param {Object} data - Order update
   */
  const onWsOrderUpdate = (data) => {
    if (!isRunning) return;
    fencedWrite(`engine-order:${fundLabel}`, () => handleOrderUpdate(data)).catch(err => logger.error(
      `❌ [${exchange}] handleOrderUpdate error: ${err.message}`,
      { orderId: data.orderId, error: err.message }
    ));
  };

  /**
   * Handle ticker update from WebSocket
   * @param {Object} data - Ticker data
   */
  const handleTicker = (data) => {
    marketState.lastPrice = data.price;
    marketState.bid = data.bid;
    marketState.ask = data.ask;
    marketState.spread = data.ask - data.bid;
    // Carry 24h rolling volume through to the candle cache (issue #202). WS feeds
    // emit it; nullish-coalesce so a feed without it keeps the prior value.
    marketState.volume24h = data.volume24h ?? marketState.volume24h;
    marketState.lastUpdate = Date.now();

    healthMonitor.recordTickerUpdate();

    // Process tail event checks
    tailEvents.processTicker(data, marketState.atr1m);

    // Ticker-driven work is skipped, not queued, while a backup holds the
    // fund's files (#1945): the next tick after release re-evaluates it.
    const backupFenced = engineLocks.isBackupFenced();

    // Evaluate entry trigger (fire-and-forget, catch to prevent unhandled rejection)
    if (!backupFenced) {
      fencedWrite(`engine-entry:${fundLabel}`, () => evaluateEntryTrigger()).catch(err => logger.warn(
        `⚠️ [${exchange}] Entry evaluation failed: ${err.message}`,
        { error: err.message }
      ));
    }

    // In dry-run mode, check if any orders should fill based on current price
    if (isDryRun && !backupFenced) {
      orderExecutor.checkTpFills(data.price);
      orderExecutor.checkEntryFills(data.price);
    }

    // Update unrealized P&L — syncPositionState already aggregates body values
    // into totalAsset/totalCostBasis, so use them directly (no body loop needed)
    {
      const totalHeldBtc = positionState.totalAsset || 0;
      const totalHeldCost = positionState.totalCostBasis || 0;
      positionState.unrealizedPnL = totalHeldBtc > 0 ? (totalHeldBtc * data.price) - totalHeldCost : 0;
    }

    // Emit throttled status update
    const now = Date.now();
    if (callbacks.onStatusUpdate && now - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
      lastStatusUpdate = now;
      callbacks.onStatusUpdate(getState());
    }
  };

  /**
   * Handle trade from WebSocket
   * @param {Object} data - Trade data
   */
  const handleTrade = (data) => {
    // Update lastPrice from trade data (fallback when ticker isn't providing updates)
    if (data.price && data.price > 0) {
      marketState.lastPrice = data.price;
      marketState.lastUpdate = Date.now();
    }

    marketState.tradeImbalance = tradeWindow.add(data, Date.now());
  };

  /**
   * Handle order update from WebSocket
   * @param {Object} data - Order data
   */
  const handleOrderUpdate = async (data) => {
    healthMonitor.recordOrderUpdate();

    if (data.status === 'FILLED') {
      await handleOrderFill(data);
    } else if (isCancelledStatus(data)) {
      // A cancelled order with a fill still bought/sold that filled portion.
      // Route it through handleOrderFill BEFORE dropping tracking so the fill
      // isn't lost — otherwise the asset sits untracked (the polling path's
      // handleCancelledOrder already does this; the WS path previously didn't,
      // losing fills on exchanges with no order-events WS fallback) (issue #107 M3).
      if (data.filledSize > 0) {
        // A cancel-AFTER-FULL-fill (completionPercentage >= 100) is a TERMINAL
        // fill, not a partial — route it as FILLED so a fully-filled body TP
        // completes instead of being relisted as a residual body. Only treat it
        // as partial when it's genuinely under-filled. Mirrors the polling path,
        // which checks completionPercentage >= 100 before CANCELLED (issue #107).
        const fullyFilled = (data.completionPercentage || 0) >= 100;
        logger.warn(`⚠️ [${exchange}] WS ${data.status} ${data.orderId} with ${data.filledSize} ${fullyFilled ? 'full' : 'partial'} fill — routing through handleOrderFill before dropping tracking`);
        orderExecutor.markSettled(data.orderId);
        await handleOrderFill(fullyFilled
          ? { ...data, status: 'FILLED', isPartialFill: false }
          : buildPartialFillData(data.orderId, data.side, data));
      }
      orderExecutor.handleOrderCancel(data.orderId);
      retireTrackedEntry(data.orderId);
    }
  };

  const { recoverUnbookedOwnedEntryTranches, sealLegacyClosure } = createEntryTrancheRecovery({
    exchange, productId, baseCurrency, config, logger, positionState,
    fillLedger, closedTrades, getAdapter: () => adapter, lookupOrNull, saveLiveState,
  });

  // The booking paths call back into fill dispatch for execution discovered
  // during a TP cancel. Late calls also read the active placement functions.
  const { handleBuyOrderFill, retireTrackedEntry } = createBuyBooking({
    exchange, baseCurrency, config, logger, positionState, positionSizer, fillLedger,
    recentlyProcessedBuyFills, pendingMergeTpOrders, completeMergeSnapshot,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getPriceIncrement: () => priceIncrement,
    lookupOrNull, saveLiveState,
    handleOrderFill: (fillData) => handleOrderFill(fillData),
    cancelBodyTpForReplace: (body, context) => cancelBodyTpForReplace(body, context),
    placeBodyTp: (body) => placeBodyTp(body),
    placeBodyTpWithRetry: (body, context) => placeBodyTpWithRetry(body, context),
    calculateDynamicTpPercent: () => calculateDynamicTpPercent(),
  });
  const { handleOrderFill, handleOrderFillImpl, cancelBodyTpForReplace, knownTpCancelExecution, bookTpCancelExecution } =
    createFillHandler({
      exchange, productId, baseCurrency, fundLabel, logger, positionState, engineLocks,
      fillLedger, FillValidationError,
      getAdapter: () => adapter,
      getOrderExecutor: () => orderExecutor,
      isBodyTpSellOrder, fencedWrite, saveLiveState, handleBuyOrderFill,
      handleSellOrderFill: (fillData, dedupRef, keepEntryTracked, evidence) =>
        handleSellOrderFill(fillData, dedupRef, keepEntryTracked, evidence),
    });

  /**
   * Start periodic metrics updater
   */
  const startMetricsUpdater = () => {
    // A stalled exchange can outlast the interval (each candle request may take
    // minutes with retries); never stack metrics runs on top of each other.
    let metricsInFlight = false;
    // updateMetrics is async and awaits exchange/order calls that can reject;
    // an unhandled rejection in a bare interval callback would crash the
    // process, so guard every invocation.
    const runMetrics = () => {
      if (metricsInFlight) return;
      metricsInFlight = true;
      fencedWrite(`engine-metrics:${fundLabel}`, () => updateMetrics())
        .catch((err) =>
          logger.error(`❌ [${exchange}] Metrics update crashed: ${err.message}`, { error: err.message })
        )
        .finally(() => {
          metricsInFlight = false;
        });
    };
    metricsInterval = setInterval(runMetrics, METRICS_INTERVAL_MS);
    // Initial update
    runMetrics();
  };

  /**
   * Fetch and update ATH (All-Time High) for ladder mode
   * Only fetches if in ladder mode and data is stale (>24 hours old)
   */
  const updateATH = async () => {
    // Only fetch ATH for ladder mode
    const effectiveMode = config.entryMode || 'reactive';
    if (effectiveMode !== 'ladder' && !config.ladderAutoSwitch) {
      return;
    }

    // Prevent concurrent ATH backfills
    if (athUpdateInProgress) return;

    // Check if ATH data is fresh enough (refresh daily)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    if (marketState.athLastUpdate && (now - marketState.athLastUpdate) < dayMs) {
      return;
    }

    athUpdateInProgress = true;

    const fetchAndComputeATH = async () => {
      // Fetch full daily history in paginated batches (Coinbase API limits <350 candles per request)
      const nowSec = Math.floor(now / 1000);
      const maxCandlesPerRequest = 349;
      const daySec = 24 * 60 * 60;

      const allCandles = [];
      let endSec = nowSec;
      const maxPages = 20;
      let pages = 0;

      while (pages < maxPages) {
        pages++;
        const startSec = endSec - (maxCandlesPerRequest * daySec);
        const batch = await adapter.getCandles(productId, startSec, endSec, 'ONE_DAY').catch(err => {
          logger.warn(`⚠️ [${exchange}] Failed to fetch ATH data: ${err.message}`, { error: err.message });
          return null;
        });

        if (!batch || batch.length === 0) break;
        allCandles.push(...batch);

        // If we received fewer than max candles, we've reached the earliest available data
        if (batch.length < maxCandlesPerRequest) break;

        // Move window back in time for next batch
        endSec = startSec;
      }

      if (allCandles.length === 0) return;

      // Calculate ATH over full fetched history
      const ath = ladderCalculator.calculateATHFromCandles(allCandles);
      const athDistance = ladderCalculator.calculateATHDistance(marketState.lastPrice, ath);

      marketState.ath = ath;
      marketState.athDistance = athDistance;
      marketState.athLastUpdate = now;

      const distancePct = (Math.abs(athDistance) * 100).toFixed(1);
      logger.info(`📊 [${exchange}] ATH updated: ${fmtPrice(ath)} (${allCandles.length} candles), current price ${athDistance < 0 ? `${distancePct}% below` : `${distancePct}% above`} ATH`);
    };

    await fetchAndComputeATH().finally(() => {
      athUpdateInProgress = false;
    });
  };

  /**
   * Seed the risk manager's trackers from the persisted snapshot once
   * per engine instance, so a restart keeps an active pause and the peak.
   */
  let drawdownStateHydrated = false;
  const hydrateDrawdownState = (saved = positionState.drawdownGuard) => {
    if (drawdownStateHydrated) return;
    drawdownStateHydrated = true;
    riskManager.restoreState(saved);
  };

  /** Restore durable episode markers once during state loading, before recovery saves. */
  const restoreEpisodeState = (saved) => {
    if (!saved) return;
    hydrateDrawdownState(saved.drawdownGuard);
    announcedCaps = new Set(Array.isArray(saved.announcedCaps)
      ? saved.announcedCaps.filter(key => Object.hasOwn(CAP_ALERT_LABELS, key)) : []);
    if (typeof saved.lastHourlySummaryEventAt === 'number' && Number.isFinite(saved.lastHourlySummaryEventAt)) {
      lastHourlySummaryEventAt = saved.lastHourlySummaryEventAt;
    }
  };

  /** Mirror all restart-sensitive episodes on every save, including shutdown. */
  const persistEpisodeState = () => {
    persistDrawdownState();
    positionState.announcedCaps = [...announcedCaps];
    positionState.lastHourlySummaryEventAt = lastHourlySummaryEventAt;
  };

  /** Mirror the tracker into positionState (persisted with regime-state.json). */
  const persistDrawdownState = () => {
    const snapshot = riskManager.getPersistedState();
    positionState.drawdownGuard = snapshot;
    positionState.maxDrawdownSeen = snapshot.maxDrawdownSeen;
  };

  /**
   * Evaluate the maxDrawdownPercent guard (issue #693). Runs once per metrics
   * tick, independent of candle fetches (it needs only the live mark price).
   * checkAllCaps / canPlaceEntry and the ladder guard read the resulting pause
   * on every subsequent entry evaluation. Equity unit: computeFundEquity.
   * @returns {Object|null} updateDrawdown result, or null when no price yet
   */
  const refreshDrawdownGuard = () => {
    hydrateDrawdownState();
    const price = marketState.lastPrice;
    if (!(price > 0)) return null;
    // A fill / merge / reset mid-flight can leave bodies and the ledger out of
    // step (e.g. a TP's body already removed but its sell not yet paired),
    // which would read as a transient equity drop. Skip this sample; the
    // previous pause state stands until the next tick.
    if (engineLocks.isMutatingPosition()) return null;
    // realizedPnL / realizedAssetPnL are derived lazily from the ledger; refresh
    // them so a just-filled TP's proceeds and holdback are in the equity.
    refreshRealizedFromCyclePairs();
    const { equity, capitalBase } = computeFundEquity(positionState, config, price);
    const wasPaused = riskManager.getState().isDrawdownPaused;
    const result = riskManager.updateDrawdown(equity, capitalBase);
    persistDrawdownState();
    // Flush a pause-state transition to disk now, so a crash before the
    // 5-minute save timer cannot restart the engine without the pause.
    if (result.isPaused !== wasPaused && !isDryRun) saveLiveStateGuarded('drawdown-guard');
    return result;
  };

  /**
   * Update volatility metrics via REST API
   */
  const updateMetrics = async () => {
    // Check health status (allows auto-recovery from SAFE mode). Pass the live
    // open-order count so a flat engine is exempt from the stale-orders check
    // (issue #211-A) — nothing can go stale when there are no resting orders.
    healthMonitor.checkHealth({ openOrderCount: orderExecutor.getPendingCounts().total });

    // Drawdown guard first — before the candle fetch can early-return, so a
    // candle-endpoint outage never silently disables it.
    refreshDrawdownGuard();

    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    // Fetch candles with error handling - metrics update is non-critical
    let candles1m, candles5m;
    let fetchFailed = false;

    await (async () => {
      candles1m = await adapter.getCandles(productId, oneHourAgo, now, 'ONE_MINUTE');
      candles5m = await adapter.getCandles(productId, fourHoursAgo, now, 'FIVE_MINUTE');
    })().catch(err => {
      logger.warn(`⚠️ [${exchange}] Metrics update failed (using cached): ${err.message}`, { error: err.message });
      fetchFailed = true;
    });

    // If fetch failed, skip metrics update but continue with regime classification using cached values
    if (fetchFailed) {
      // Still log hourly summary with cached metrics
      logHourlySummary();
      // Placing a TP needs no candle data (falls back to tpMinPercent), so the
      // candle-fetch failure must NOT block the TP-replacement safety net — a
      // body whose TP placement failed would otherwise have no resting sell for
      // as long as the candle endpoint errors, even with a healthy order API.
      // The reconcile loop only repairs bodies that already HAVE a tpOrderId,
      // so this is the only path that covers a missing TP (issue #107 M4).
      await ensureTakeProfitPlaced();
      return;
    }

    applyMarketMetrics(marketState, candles1m, candles5m, config);

    // Feed volatility data to TP optimizer for continuous vol-based sampling
    if (config.tpAutoManaged && marketState.atr5m > 0 && marketState.lastPrice > 0) {
      const volAdj = tpOptimizer.recordVolatilitySample({
        atr5m: marketState.atr5m,
        lastPrice: marketState.lastPrice,
        realizedVol: marketState.realizedVol,
        volBaseline: marketState.volBaseline,
      });
      if (volAdj) handleTpAdjustment(volAdj);
    }

    // Update ATH for ladder mode (daily refresh) - run async to avoid blocking metrics interval
    updateATH().catch(err => logger.warn(`⚠️ [${exchange}] ATH update failed: ${err.message}`, { error: err.message }));

    // Classify regime with updated metrics
    regimeDetector.classify(marketState);

    // Update stale order timeout based on regime
    // HARVEST: normal timeout (1.0x)
    // CAUTION: faster repricing (0.7x) - uncertain markets need quicker adjustments
    // TREND: fastest repricing (0.5x) - trending markets move quickly
    if (orderExecutor.capabilities?.liveReconciliation) {
      const regime = regimeDetector.getMode();
      const multiplier = regime === 'CAUTION' ? 0.7 : regime === 'TREND' ? 0.5 : 1.0;
      orderExecutor.setStaleTimeoutMultiplier(multiplier);
    }

    // Log hourly summary
    logHourlySummary();

    // Place TP order if we have a position but no active TP order (e.g., after recovery)
    await ensureTakeProfitPlaced();
  };

  /**
   * Auto-consolidate one stranded sub-min "dust" body per cycle (#189). A body
   * whose entire qty rounds below the exchange minimum can never get a TP placed,
   * so it would otherwise sit idle forever with its value stranded. Fold it into
   * the NEAREST other body (by avg price) via the locked merge primitive so the
   * combined qty can clear the minimum and get a TP. Merging into the nearest
   * body (rather than relying on tpPrice ordering) also handles the all-dust case
   * — two sub-min bodies with no resting TP still merge and accumulate.
   *
   * Deferred (not failed) while a merge/reconcile is in flight, so it never sets
   * the failure cooldown just because the engine was momentarily busy; a genuine
   * merge failure (e.g. target TP partially filled) backs off for a few minutes
   * so it doesn't re-attempt and re-log every cycle.
   */
  const consolidateDustBodies = async () => {
    if (isDryRun || !productDetails?.baseMinSize) return;
    if (engineLocks.isMutatingPosition()) return; // busy → retry next tick (no cooldown)
    if (Date.now() < dustMergeRetryAfter) return;        // backing off after a failed attempt
    const bodies = positionState.celestialBodies || [];
    if (bodies.length < 2) return;
    const baseMinSize = parseFloat(productDetails.baseMinSize);
    const baseIncrement = parseFloat(productDetails.baseIncrement) || 0.00000001;

    const feeRate = config.feeRate ?? DEFAULT_FEE_RATE_PER_SIDE;
    const dust = bodies.find(b => isStrandedDustBody(b, baseMinSize, baseIncrement, {
      effectiveMaxTpPct: config.tpMaxPercent * (celestialHierarchy.getTierConfig(b.tier)?.tpMaxScale || 1),
      feeRate,
    }));
    if (!dust) return;

    // Pick the nearest OTHER body by avg price as the merge target.
    let target = null;
    let bestDist = Infinity;
    for (const b of bodies) {
      if (b.id === dust.id) continue;
      const dist = Math.abs((b.avgPrice || 0) - (dust.avgPrice || 0));
      if (dist < bestDist) { bestDist = dist; target = b; }
    }
    if (!target) return;

    const result = await manualMergeBody(dust.id, { targetId: target.id, label: 'Auto-consolidation (dust)' })
      .catch((err) => ({ success: false, message: err.message }));
    if (!result.success) {
      dustMergeRetryAfter = Date.now() + 300000; // 5 min backoff (bounds failure re-log)
      logger.warn(`⚠️ [${exchange}] Dust auto-consolidation deferred: ${result.message}`);
    }
  };

  /**
   * Place a TP for any held position that lacks a resting sell order. Extracted
   * from updateMetrics so it can run even when candle fetch fails (TP placement
   * doesn't need candles). No-op in dry-run or when fully covered.
   */
  const ensureTakeProfitPlaced = async () => {
    if (isDryRun || positionState.totalAsset <= 0) return;
    // Recover stranded sub-min dust first so a merged body gets its TP below.
    await consolidateDustBodies();
    const bodies = positionState.celestialBodies || [];
    const bodiesWithoutTp = bodies.filter(b => !b.tpOrderId);
    const needsTp = bodies.length > 0 ? bodiesWithoutTp.length > 0 : !positionState.activeTpOrderId;
    if (needsTp) {
      // Log only when the set of TP-needing bodies changes — a body stuck below
      // the exchange min (see placeTakeProfitOrder) otherwise re-logs every cycle.
      const tpNeedKey = bodiesWithoutTp.map(b => b.id).sort().join(',');
      if (tpNeedKey !== lastTpNeedKey) {
        logger.info(`📝 [${exchange}] Position without TP order detected — bodies=${bodies.length} (${bodiesWithoutTp.length} need TP: ${bodiesWithoutTp.map(b => b.id.slice(-8)).join(',')}), avgCost=${fmtPrice(positionState.avgCostBasis)}, cycleBuys=${positionState.cycleBuys}`);
        lastTpNeedKey = tpNeedKey;
      }
      await placeTakeProfitOrder();
    } else {
      lastTpNeedKey = null;
    }
  };

  /**
   * Ledger-only position coverage (issue #607). `net` is Σ buys − Σ sells over
   * the fill ledger; `heldOpen` is the quantity the per-buy consumption model
   * still holds open. Two readings:
   *   unmodelled    = net − inBodies − reserves — the exchange-balance
   *                   identity with the ledger standing in for the balance
   *   untrackedOpen = heldOpen − inBodies — open buy inventory no body tracks
   *                   (exact for sells booked with consumption records;
   *                   pre-#607 history still closes on sellOrderId)
   * plus `untrackedSold`: Σ size of foreign (`untrackedSell`) sells (issue
   * #750). They are already inside `net`, so they push `unmodelled` negative
   * by their size; the field says how much of that gap they explain, since
   * the engine does not guess whether they drew down reserves or position.
   * @param {number} inBodies - Σ body.assetQty
   * @returns {{net: number, heldOpen: number, inBodies: number, reserves: number, unmodelled: number, untrackedOpen: number, untrackedSold: number}}
   */
  const computeLedgerCoverage = (inBodies) => {
    const derived = fillLedger.getDerivedRealizedPnL();
    const net = derived.ledgerNetAsset || 0;
    const heldOpen = derived.heldOpenAssetQty || 0;
    const reserves = derived.realizedAssetPnL || 0;
    return {
      net: roundAsset(net),
      heldOpen: roundAsset(heldOpen),
      inBodies: roundAsset(inBodies),
      reserves: roundAsset(reserves),
      unmodelled: roundAsset(net - inBodies - reserves),
      untrackedOpen: roundAsset(heldOpen - inBodies),
      untrackedSold: roundAsset(derived.untrackedSellQty || 0),
    };
  };

  /**
   * Assert the position model covers every unit of base currency the account
   * actually holds: `balance == Σ body.assetQty + realizedAssetPnL (reserves)`.
   * Anything left over is asset the engine bought and never sold but no longer
   * tracks — it will never get a take-profit and shows up nowhere in the UI.
   * The ledger-only reading of the same identity (computeLedgerCoverage) is
   * always surfaced as `positionCoverage.ledger`, and warned on when the
   * exchange balance cannot be used.
   * Detect-only, like the rest of this sweep.
   * @returns {Promise<void>}
   */
  const checkPositionCoverage = async () => {
    const inBodies = (positionState.celestialBodies || []).reduce((sum, b) => sum + (b.assetQty || 0), 0);
    // A resting TP holds asset the body still owns, so tiny rounding is normal;
    // anything the exchange min-size could trade is not.
    const tolerance = Number(productDetails?.baseMinSize) || 0;

    // The same identity from the fill ledger alone (issue #607): the ledger's
    // net position stands in for the exchange balance, and the per-buy
    // consumption model says which of it is still open. Needs no exchange
    // call, so it also covers funds the balance check below cannot.
    const ledger = computeLedgerCoverage(inBodies);
    const reportLedgerGap = () => {
      if (Math.abs(ledger.unmodelled) <= tolerance) return;
      logger.warn(
        `⚖️ [${exchange}] Ledger coverage gap: ledger nets ${ledger.net} ${baseCurrency}, model accounts for ${roundAsset(ledger.inBodies + ledger.reserves)} `
        + `(${ledger.inBodies} in bodies + ${ledger.reserves} reserves) — ${ledger.unmodelled} ${baseCurrency} untracked; ledger holds ${ledger.heldOpen} ${baseCurrency} of buys open`
        + (ledger.untrackedSold > 0 ? `; ${ledger.untrackedSold} ${baseCurrency} left via untracked (foreign) sells` : ''),
        { pair: productId, ...ledger }
      );
    };

    if (typeof adapter.getAccountBalance !== 'function') {
      positionCoverage = { checkedAt: Date.now(), skipped: 'adapter has no account balance', ledger };
      reportLedgerGap();
      return;
    }
    // getAccountBalance is ACCOUNT-wide, not fund-scoped. With two funds on one
    // exchange sharing a base currency, the sibling's holdings read as this
    // fund's coverage gap, so the invariant is unsound and the check is skipped
    // rather than allowed to cry wolf every sweep.
    const sharingBase = getConfiguredFunds()
      .filter(f => f.exchange === exchange && getBaseCurrency(f.pair) === baseCurrency);
    if (sharingBase.length > 1) {
      positionCoverage = { checkedAt: Date.now(), skipped: `${sharingBase.length} funds on ${exchange} share ${baseCurrency}`, ledger };
      reportLedgerGap();
      return;
    }
    const balance = await adapter.getAccountBalance(baseCurrency);
    const onExchange = Number(balance?.total);
    if (!Number.isFinite(onExchange)) {
      positionCoverage = { checkedAt: Date.now(), skipped: 'account balance unavailable', ledger };
      reportLedgerGap();
      return;
    }

    const reserves = positionState.realizedAssetPnL || 0;
    const unmodelled = roundAsset(onExchange - inBodies - reserves);
    positionCoverage = {
      checkedAt: Date.now(),
      onExchange: roundAsset(onExchange),
      inBodies: roundAsset(inBodies),
      reserves: roundAsset(reserves),
      unmodelled,
      ledger,
    };

    if (Math.abs(unmodelled) <= tolerance) return;

    // Account-wide balance includes holdings the engine never managed, so this
    // is informational; the ledger-only gap above is the actionable warning.
    logger.info(
      `⚖️ [${exchange}] Position coverage gap: exchange holds ${roundAsset(onExchange)} ${baseCurrency}, model accounts for ${roundAsset(inBodies + reserves)} `
      + `(${roundAsset(inBodies)} in ${(positionState.celestialBodies || []).length} bodies + ${roundAsset(reserves)} reserves) — ${unmodelled} ${baseCurrency} untracked`
      + (ledger.untrackedSold > 0 ? `; ${ledger.untrackedSold} ${baseCurrency} left via untracked (foreign) sells` : ''),
      { pair: productId, ...positionCoverage, bodies: (positionState.celestialBodies || []).length }
    );
  };

  /**
   * Detect-only sweep: ask the exchange for every fill since engine start and
   * report the ones the local ledger never recorded. Runs on its own timer
   * (fillDriftSweepMs), never under the reconcile lock.
   *
   * This exists because nothing else notices. Gemini has no order-events WS, so
   * a fill is only ever recorded if the order was still in the executor's
   * in-memory pendingOrders map when the poll ran; lose that entry and the fill
   * is gone silently and permanently. Detection is deliberately NOT repair —
   * auto-ingesting historical fills into a live engine would re-open cycle and
   * cost-basis accounting mid-flight. Repair stays an operator action
   * (scripts/backfill-missing-fills.js).
   *
   * It also checks the second, independent way asset can go missing: the ledger
   * can be complete while the POSITION MODEL still fails to represent what the
   * account holds. Before issue #607, `heldOpenBuyCostBasis` decided a buy was
   * closed on a boolean — `sellOrderId` set and that sell has fills — with no
   * quantity check, and `sellOrderId` is re-stamped across merges and TP
   * replacements. So a buy order only partly sold counted as fully closed and
   * its unsold remainder disappeared from the model: bought, never sold, in no
   * body, no TP, invisible. gemini/ETHUSD was carrying 1.14 ETH in that state.
   * Sells now record per-buy consumption, but pre-#607 history still closes on
   * the boolean, so this asserts `balance == Σ body.assetQty + reserves`.
   *
   * The verdict below is published only from a COMPLETE history read:
   * getUnaccountedFills resolves after the adapter has walked the whole
   * requested range (resumably, in bounded steps — issue #966) and reports
   * failure otherwise, so a partial traversal never updates `fillDrift`.
   * @param {AbortSignal} [signal] - Cancels the history read when the engine stops
   * @returns {Promise<void>}
   */
  const sweepLedgerDrift = async (signal) => {
    const startDate = new Date(positionState.engineStartTime).toISOString();
    const result = await getUnaccountedFills(exchange, fillLedger, null, { startDate, pair: productId, signal });
    if (signal?.aborted) return;
    if (!result.success) {
      logger.warn(`⚠️ [${exchange}] Ledger drift sweep failed: ${result.error}`, { error: result.error });
      return;
    }

    const orders = result.unaccountedOrders || [];
    const asset = roundAsset(orders.reduce((sum, o) => sum + (o.side === 'buy' ? o.totalBtc : -o.totalBtc), 0));
    // Netted like `asset` above — a gross sum would report a matched missing
    // buy+sell as ~0 net asset but double the dollars.
    const usd = roundUSDC(orders.reduce((sum, o) => sum + (o.side === 'buy' ? o.totalUsdc : -o.totalUsdc), 0));
    fillDrift = {
      checkedAt: Date.now(),
      fills: result.unaccountedCount,
      orders: orders.length,
      netAsset: asset,
      usd,
      orderIds: orders.slice(0, 20).map(o => o.orderId),
    };

    if (result.unaccountedCount > 0) {
      // The exchange history is account-wide, so manual trades and other bots
      // on this product land here too — expected, hence info rather than warn.
      logger.info(
        `🩸 [${exchange}] Ledger drift: ${result.unaccountedCount} exchange fill(s) across ${orders.length} order(s) not in the ledger (foreign activity expected) — net ${asset} ${baseCurrency} / $${usd} unaccounted since ${startDate}`,
        {
          pair: productId,
          unaccountedFills: result.unaccountedCount,
          unaccountedOrders: orders.length,
          netAsset: asset,
          usd,
          since: startDate,
          orderIds: fillDrift.orderIds,
        }
      );
    }

    // After the drift verdict is logged, never before: this needs a second
    // network call (the account balance), and a routine rejection there must not
    // throw past the finding this sweep exists to report.
    await checkPositionCoverage().catch(err => {
      logger.warn(`⚠️ [${exchange}] Position coverage check failed: ${err.message}`, { error: err.message });
    });
  };

  /**
   * Start periodic reconciliation
   */
  const startReconciliation = () => {
    reconcileInterval = setInterval(() => {
      // A tick that lands under a backup fence is skipped, like a busy lock.
      if (engineLocks.isBackupFenced()) return;
      fencedWrite(`engine-reconcile:${fundLabel}`, reconcileTick).catch((err) => logger.error(`Reconcile failed: ${err.message}`));
    }, config.reconcileIntervalMs);
  };

  // Take-profit placement (regime-tp-placement): the dynamic TP percent, the
  // per-body TP (sized after the tier holdback) with its single retry, and
  // placeTakeProfitOrder with the legacy single-TP fall-through. The in-flight
  // placement guard and the dust-wait log map are the engine's own, passed by
  // reference. Built here, after every collaborator it captures is declared
  // and before the dry-run fill handlers, the reconcile loop, startup recovery
  // and the operator actions, which all take these functions.
  const {
    calculateDynamicTpPercent, placeBodyTp, placeBodyTpWithRetry, placeTakeProfitOrder,
  } = createTpPlacement({
    exchange, baseCurrency, isDryRun, config, logger,
    positionState, fillLedger, regimeDetector, macroRegime, positionSizer,
    tpPlacementInFlight, dustWaitLoggedQty,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getMarketState: () => marketState,
    getPriceIncrement: () => priceIncrement,
    getProductDetails: () => productDetails,
    lookupOrNull,
    handleOrderFill,
    saveLiveStateGuarded,
  });

  /**
   * Finish a cycle reset a body TP close still owes (#766) — its fill booked
   * the sell, then resetCycle threw, and the fill may never be re-delivered
   * (the WS path does not retry; polling retries are bounded and lost on
   * restart). Run from the reconcile tick, so it also covers a restart.
   * Skipped while a sweep or fill is in flight (either may be finishing it).
   */
  const completeOwedCycleReset = async () => {
    const owedFor = positionState.pendingCycleResetFor;
    if (!owedFor) return;
    if (engineLocks.isLadderBusy() || engineLocks.getFlags().fillInProgress > 0) return;
    const preserveOpenBodyBuys = (positionState.celestialBodies || []).length > 0;
    if (preserveOpenBodyBuys) {
      logger.warn(`⚠️ [${exchange}] Owed cycle reset for ${String(owedFor).slice(0, 8)} will carry buys owned by the open body into the new cycle`);
    }
    logger.warn(`🔁 [${exchange}] Completing the cycle reset owed by ${String(owedFor).slice(0, 8)}`);
    await resetCycle({ preserveOpenBodyBuys });
    saveLiveState();
    fillLedger.persist();
  };

  /**
   * Reset for new cycle. Serialised with every other ladder sweep (#766):
   * a TP close that lands mid-rebuild waits for it to finish, then cancels
   * the ladder it just placed. Reentrant, so a reset reached from inside a
   * sweep's own mid-cancel booking runs through.
   *
   * @param {{preserveOpenBodyBuys?: boolean, resetKind?: 'close'|'operator'}} [opts]
   *   - Treat buys owned by currently open bodies as post-close fills when
   *   paying an owed reset. Operator resets do not represent a completed
   *   trading cycle for optimizer accounting.
   * @returns {Promise<import('./regime-cycle-reset').CycleResetResult>}
   */
  const resetCycle = async ({ preserveOpenBodyBuys = false, resetKind = 'close' } = {}) => {
    const turnoverKind = resetKind === 'operator' ? 'operator' : 'close';
    // Buys that land while this reset waits its turn postdate the close just
    // like the sweep's own (#711 — see resetCycleLocked), e.g. a rung of the
    // ladder the in-flight rebuild just placed. Snapshot the closing cycle
    // before queueing so they are carried too. An owed reset can also mark
    // buys owned by currently open bodies as post-close fills.
    let resetContext = null;
    if (engineLocks.isLadderBusy() || preserveOpenBodyBuys) {
      const cycleId = fillLedger.getCurrentCycleId();
      const cycleFills = cycleFillsFor(cycleId);
      const openBodyBuyTradeIds = preserveOpenBodyBuys
        ? new Set(cycleFills
          .filter(fill => fill.side === 'buy' && isBuyAlreadyCommitted(positionState.celestialBodies, fill.orderId))
          .map(fill => fill.tradeId))
        : new Set();
      resetContext = {
        requestedCycleId: cycleId,
        baselineTurnoverGeneration: cycleResetGeneration,
        resetCause: turnoverKind,
        baselineTradeIds: new Set(cycleFills.filter(fill => !openBodyBuyTradeIds.has(fill.tradeId)).map(fill => fill.tradeId)),
      };
    }
    return engineLocks.withLadderLock(() => resetCycleLocked(resetContext, turnoverKind), {
      onTimeout: 'proceed',
      label: 'Cycle reset',
      exchange,
    });
  };

  /**
   * Number of cycle turnovers resetCycleLocked has performed. A reset with a
   * captured baseline compares it (not the cycle id, which an operator
   * recalculation can rename) to tell whether an earlier reset closed its cycle.
   */
  let cycleResetGeneration = 0;
  // The generation that closed each cycle. An operator turnover can supersede
  // a queued TP reset without making that TP close a duplicate, and a later TP
  // can close a different cycle before an earlier timed-out reset returns, so
  // a single latest-close generation is not enough for close accounting.
  const closeResetGenerationByCycleId = new Map();

  /**
   * A fresh ledger has no live cycle until its first reset: its fills are
   * stamped null, so the closing "cycle" is the null-cycle rows.
   * @param {string|null} cycleId - fillLedger.getCurrentCycleId() at call time
   */
  const cycleFillsFor = (cycleId) => (cycleId
    ? fillLedger.getCurrentCycleFills()
    : fillLedger.getAllFills().filter(f => f.cycleId == null));

  /**
   * @param {import('./regime-cycle-reset').CycleResetContext|null} queuedContext -
   *   baseline captured before waiting; null means capture at lock entry
   * @param {'close'|'operator'} [resetKind='close']
   * @returns {Promise<import('./regime-cycle-reset').CycleResetResult>}
   */
  const resetCycleLocked = async (queuedContext, resetKind = 'close') => {
    // Capture before the only await (ladder cancellation). Null is a real
    // first-cycle identity; generation, not a recalculatable ID, detects turnover.
    const closingCycleId = fillLedger.getCurrentCycleId();
    const resetContext = queuedContext || {
      requestedCycleId: closingCycleId,
      baselineTurnoverGeneration: cycleResetGeneration,
      baselineTradeIds: null,
      resetCause: resetKind,
    };
    const queuedSupersession = classifyResetSupersession(resetContext, {
      turnoverGeneration: cycleResetGeneration,
      closeGenerationByCycleId: closeResetGenerationByCycleId,
    });
    if (queuedSupersession) {
      logger.info(`🔄 [${exchange}] Queued cycle reset skipped — the cycle it was asked to close was already closed while it waited (now ${closingCycleId})`);
      positionState.pendingCycleResetFor = null;
      return queuedSupersession;
    }
    const closingCycleFills = () => cycleFillsFor(closingCycleId);
    let preSweepTradeIds = resetContext.baselineTradeIds;
    // A timed-out lock permits overlap: compare again after cancellation using
    // the generation at entry, while retaining the originally requested cycle.
    const sweepContext = { ...resetContext, baselineTurnoverGeneration: cycleResetGeneration };

    // Cancel remaining ladder orders - check both positionState and executor tracking
    const executorLadderOrders = orderExecutor.getPendingLadderOrders ? orderExecutor.getPendingLadderOrders() : [];
    const hasTrackedLadder = (positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) || executorLadderOrders.length > 0;
    if (positionState.ladderActive || hasTrackedLadder) {
      preSweepTradeIds = preSweepTradeIds || new Set(closingCycleFills().map(f => f.tradeId));
      const { cancelled, partialFills = 0 } = orderExecutor.cancelAllLadderOrders ? await orderExecutor.cancelAllLadderOrders() : { cancelled: 0 };
      if (cancelled > 0) logger.info(`🧹 [${exchange}] Cancelled ${cancelled} unfilled ladder orders${partialFills > 0 ? ` (${partialFills} partially filled during the cancel and were booked)` : ''}`);
      // Two resets that both timed out on the ladder lock can overlap here;
      // only the first to finish its sweep turns the cycle over (#766).
      const sweepSupersession = classifyResetSupersession(sweepContext, {
        turnoverGeneration: cycleResetGeneration,
        closeGenerationByCycleId: closeResetGenerationByCycleId,
      });
      if (sweepSupersession) {
        logger.info(`🔄 [${exchange}] Cycle reset skipped after its sweep — a concurrent reset already turned the cycle over`);
        return sweepSupersession;
      }
    }

    // Reset ladder state
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Reset cycle counters and entry tracking
    positionState.cycleBuys = 0;
    positionState.activeTpOrderId = null;
    positionState.lastTpPrice = 0;
    positionState.assetOnOrder = 0;
    positionState.anchorPrice = 0;
    positionState.scalingDisabled = false;
    positionState.scalingDisabledReason = null;
    loggedEntryBlockKinds = new Set();
    budgetExhaustedWarningLogged = false;
    announcedCaps = new Set();
    // Reset the low-balance pause throttle on cycle reset too (not only on the
    // funded-entry path): an earlier guard (risk/budget) can return before the
    // balance preflight, so without this a recovered-then-redrained wallet could
    // suppress the next distinct low-balance episode's log (#187 review).
    lowBalancePauseLogged = false;

    // Sync aggregate fields from any remaining bodies
    const bodies = positionState.celestialBodies || [];
    if (bodies.length > 0) {
      celestialHierarchy.syncPositionState(positionState, bodies);
    } else {
      positionState.totalAsset = 0;
      positionState.totalCostBasis = 0;
      positionState.avgCostBasis = 0;
    }

    // Buys that landed during the sweep — ingested under the closing cycle
    // (ingestFill stamps the cycle live at ingest time) but not in the
    // pre-sweep snapshot. Sells stay put: a sell landing in that window closes
    // buys of the cycle it was ingested under — so a window buy whose body a
    // TP already closed (possible across a queued reset's wait, #766) stays
    // with that sell in the closing cycle rather than splitting the pair. A
    // TP only placed (sellOrderId is stamped at placement) does not count, and
    // neither does a partial sale: a body that still owns the buy is open.
    const windowBuys = preSweepTradeIds
      ? closingCycleFills().filter(f => f.side === 'buy' && !preSweepTradeIds.has(f.tradeId))
      : [];
    // Snapshot sale evidence and body ownership synchronously at the same point
    // as the original carry decision; a placed TP alone is not a booked sale.
    const soldOrderIds = new Set();
    const openBuyOrderIds = new Set();
    for (const fill of windowBuys) {
      if (fill.sellOrderId && fillLedger.getRecordedSizeForOrder(fill.sellOrderId) > 0) {
        soldOrderIds.add(fill.sellOrderId);
        if (isBuyAlreadyCommitted(bodies, fill.orderId)) openBuyOrderIds.add(fill.orderId);
      }
    }
    const sweepBuys = selectCarryForwardBuys({ windowBuys, soldOrderIds, openBuyOrderIds });

    // Persist the boundary in regime-state.json with the other operator-owned
    // position state. The fill ledger remains the fallback for legacy state
    // files that predate this marker.
    positionState.activeCycleId = fillLedger.startNewCycle();
    cycleResetGeneration++;
    if (resetContext.resetCause === 'close') closeResetGenerationByCycleId.set(closingCycleId, cycleResetGeneration);
    // Any completed turnover pays off a body TP close's owed reset (#766).
    positionState.pendingCycleResetFor = null;
    // Persist WHEN the cycle began too: it is the boundary recalculateCycles
    // uses to fold null-cycle fills the engine missed during downtime into
    // this cycle, and an empty post-reset cycle has no fill to infer it from (#705).
    positionState.activeCycleStartedAt = fillLedger.getCurrentCycleStartedAt();

    // Those sweep buys belong to the cycle just started: re-tag them, and
    // count the orders a surviving body already owns toward the new cycle's
    // buy steps — cycleBuys was zeroed above, and without this a mid-cancel
    // body contributes nothing to the maxCycleBuys cap until a restart's
    // ledger auto-correct (#711). A carried row no body owns yet (booking
    // still in flight, or deferred to a retry) is counted by its own commit,
    // which now lands in the new cycle.
    if (sweepBuys.length > 0) {
      for (const fill of sweepBuys) fillLedger.updateFillCycleId(fill.tradeId, positionState.activeCycleId);
      const carriedOrderIds = [...new Set(sweepBuys.map(f => f.orderId))];
      positionState.cycleBuys = carriedOrderIds.filter(id => isBuyAlreadyCommitted(bodies, id)).length;
      fillLedger.persist();
      logger.info(`🔀 [${exchange}] Carried ${sweepBuys.length} buy fill(s) (${carriedOrderIds.length} order(s)) that landed during the ladder cancel into ${positionState.activeCycleId}; cycleBuys=${positionState.cycleBuys}`, {
        closingCycleId,
        newCycleId: positionState.activeCycleId,
        orderIds: carriedOrderIds,
        cycleBuys: positionState.cycleBuys,
      });
    }
    riskManager.resetCycleTracking();

    const bodyCount = bodies.length;
    const bodyLabel = bodyCount > 0 ? `, ${bodyCount} celestial bodies preserved` : '';
    logger.info(`🔄 [${exchange}] Cycle reset, starting new cycle${bodyLabel}`);
    // Only a reset that actually turned the cycle over reaches here — the
    // stale/duplicate queued resets returned above without announcing.
    tradeEvents.cycleReset(exchange, positionState.cyclesCompleted, positionState.realizedPnL || 0, {
      ...fundEventData,
      resetKind: resetContext.resetCause,
      closedCycleId: closingCycleId,
      cycleId: positionState.activeCycleId,
    });

    // If the fund is draining, this cycle's TP fill is the trigger to close.
    // Defer the engine stop to next tick so the current call stack
    // (saveLiveState, fillLedger.persist, etc.) finishes cleanly first.
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      positionState.lifecycle = LIFECYCLE.CLOSED;
      positionState.lifecycleChangedAt = Date.now();
      positionState.lifecycleClosedCycle = positionState.cyclesCompleted;
      logger.info(`🛑 [${exchange}] Fund drained — closing engine after cycle ${positionState.cyclesCompleted}`);
      tradeEvents.emitTradeEvent('fund_closed', exchange, `Fund closed after cycle ${positionState.cyclesCompleted}`, {
        cyclesCompleted: positionState.cyclesCompleted,
        reason: positionState.lifecycleReason,
      });
      scheduleLifecycleClosed();
    }
    return { turnedOver: true };
  };

  /**
   * Log hourly summary
   */
  const logHourlySummary = () => {
    const now = Date.now();
    if (now - lastHourlySummaryEventAt < HOURLY_SUMMARY_EVENT_MS) return;
    lastHourlySummaryEventAt = now;
    const regime = regimeDetector.getMode();
    const counts = orderExecutor.getPendingCounts();
    const riskSummary = riskManager.getSummary(positionState);

    logger.info(
      `📊 [${exchange}] ${modeLabel}Hour: regime=${regime} entries=${counts.entries} ` +
      `exposure=${riskSummary} ` +
      `atr=${fmtPrice(marketState.atr1m)} vol=${marketState.realizedVol.toFixed(2)}%`
    );

    const drawdown = (riskManager.getState().currentDrawdownPercent || 0).toFixed(1);
    tradeEvents.regimeHourlySummary(exchange, regime, counts.entries, riskSummary, drawdown, fundEventData);
  };

  // Set up dry-run callbacks now that all functions are defined
  if (isDryRun) {
    const { onBuyFill, onSellFill } = createDryRunFillHandlers({
      exchange, pair, baseCurrency, config, celestialHierarchy, tradeEvents, logger,
      getPositionState: () => positionState,
      getOrderExecutor: () => orderExecutor,
      getPriceIncrement: () => priceIncrement,
      placeBodyTp, resetCycle, recordCycleForOptimizer, recordCycleForSizeOptimizer,
      saveDryRunState, resaveAfterSizeOptimizerDryRun, updateRegimeConfig,
      roundPrice, roundAsset, roundUSDC, fmtPrice, calculateDynamicTpPercent,
    });
    // The executor fires these without awaiting them; pass the backup fence
    // like every other fill writer (#1945) and contain a rejection here.
    const fencedDryRunFill = (side, handler) => (...args) => fencedWrite(`engine-dry-run-fill:${fundLabel}`, () => handler(...args))
      .catch((err) => logger.error(`❌ [${exchange}] ${modeLabel}Dry-run ${side} fill handling failed: ${err.message}`, { side, error: err.message }));
    dryRunCallbacks.onBuyFill = fencedDryRunFill('buy', onBuyFill);
    dryRunCallbacks.onSellFill = fencedDryRunFill('sell', onSellFill);
  }

  // Set up live mode fill detection callback (backup for when WebSocket misses fills)
  if (!isDryRun) {
    liveCallbacks.onFillDetected = (orderId, status) => fencedWrite(`engine-fill:${fundLabel}`, async () => {
      // Partial-fill detection from polling reuses this callback. Dedup
      // on the (orderId, filledSize) tuple so a partial fill that grows
      // (e.g. 0.02 → 0.05 → 0.08) is processed once per advance instead
      // of being swallowed by orderId-only dedup. Terminal full-fill
      // callbacks keep orderId-only dedup since filledSize is final.
      // A terminal buy (including CANCELLED with an already-booked partial)
      // still needs retirement even when its cumulative fill size is unchanged.
      const isTerminal = isTerminalStatus(status);
      const terminalBuy = status.side?.toLowerCase() === 'buy' && isTerminal;
      const dedupKey = makeFillDedupKey(orderId, status.isPartialFill && !terminalBuy, status.filledSize);
      if (recentlyProcessedFills.has(dedupKey)) {
        logger.warn(`⚠️ [${exchange}] Duplicate fill callback for ${dedupKey}, skipping`);
        return;
      }
      recentlyProcessedFills.add(dedupKey);
      logger.info(`🔄 [${exchange}] Processing fill detected via polling: ${orderId} side=${status.side}${status.isPartialFill ? ' [PARTIAL]' : ''}`);
      // Convert status to the format handleOrderFill expects. isPartialFill
      // must propagate so handleOrderFill's cancelPartialFillOrder guard
      // (and partial-fill branch dedup) fires for polling-detected partials.
      const fillData = {
        orderId,
        side: status.side,
        status: status.status || 'FILLED',
        filledSize: status.filledSize,
        filledValue: status.filledValue,
        averageFilledPrice: status.averageFilledPrice,
        totalFees: status.totalFees,
        placedAt: status.placedAt, // Passed from order executor for fill time tracking
        isPartialFill: status.isPartialFill === true,
      };
      // handleOrderFill awaits network and persistence work. On failure,
      // DELETE this outer polling dedup key so a still-pending order (a
      // partial fill) is re-detected and re-processed by the next reconcile's
      // checkPendingOrderFills poll (ingestFill dedups by tradeId, so
      // already-ingested fills aren't double-counted on retry). handleOrderFill
      // clears its OWN inner buy/sell dedup key on throw (see its wrapper), so
      // every caller path retries cleanly. Note: a reject after the buy
      // branch's cycleBuys++/body push but during TP placement can still
      // double-count those in-memory — tracked for an ingest-guarded refactor
      // (issue #131).
      //
      // A TERMINAL fill (FILLED, or CANCELLED-with-a-booked-partial) is
      // different: checkPendingOrderFills / handleCancelledOrder already
      // deleted this order from pendingOrders before invoking this callback,
      // so "next reconcile" below can no longer rediscover it — a rejection
      // here would otherwise strand it forever on an exchange with no
      // order-event WS (Gemini/Crypto.com). This is true regardless of the
      // specific error: handleOrderFillImpl's own getOrderFills-failure
      // fallback (order-status synthetic booking) already absorbs the common
      // incompleteFills/lookup-failure case, but ANY other throw for a
      // terminal fill has the identical "will never be revisited" problem
      // (a rethrown lookup failure carries no incompleteFills flag, for
      // instance — issue #679 follow-up). A
      // still-PARTIALLY_FILLED order legitimately stays tracked and IS
      // re-detected by the next reconcile poll, so it keeps the original
      // "log and wait" behavior below.
      try {
        if (await handleOrderFill(fillData) === false) {
          recentlyProcessedFills.delete(dedupKey);
          return false;
        }
        incompleteFillRetries.delete(dedupKey);
      } catch (err) {
        recentlyProcessedFills.delete(dedupKey);
        if (isTerminal) {
          const attempt = (incompleteFillRetries.get(dedupKey) || 0) + 1;
          if (attempt <= incompleteFillMaxRetries) {
            incompleteFillRetries.set(dedupKey, attempt);
            logger.warn(
              `⚠️ [${exchange}] Terminal fill processing for ${orderId} failed (${err.message}) — scheduling engine-level retry ${attempt}/${incompleteFillMaxRetries} in ${incompleteFillRetryDelayMs}ms`,
              { orderId, side: status.side, error: err.message, attempt, incompleteFills: err.incompleteFills === true }
            );
            const retryTimer = setTimeout(() => {
              ttlTimers.delete(retryTimer);
              if (!isRunning) return; // engine stopped while this retry was pending
              liveCallbacks.onFillDetected(orderId, status);
            }, incompleteFillRetryDelayMs);
            ttlTimers.add(retryTimer);
            return;
          }
          incompleteFillRetries.delete(dedupKey);
          logger.error(
            `❌ [${exchange}] Terminal fill processing for ${orderId} still failing after ${attempt - 1} engine-level retries — giving up automatically; operator must reconcile (scripts/backfill-missing-fills.js, and the periodic ledger-drift sweep will also surface this)`,
            { orderId, side: status.side, error: err.message }
          );
          return;
        }
        logger.error(
          `❌ [${exchange}] Error processing polled fill ${orderId} (side=${status.side}): ${err.message} — will retry on next reconcile`,
          { orderId, side: status.side, error: err.message }
        );
        return false;
      }
    });
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  const getState = () => {
    refreshRealizedFromCyclePairs();
    return buildRegimeEngineStatus({
      exchange, pair, isRunning, isDryRun, config, marketState, positionState,
      regimeDetector, macroRegime, healthMonitor, tailEvents, riskManager,
      orderExecutor, fillDrift, positionCoverage, calculateApyMetrics,
      tpOptimizer, sizeOptimizer, fillLedger, closedTrades,
    });
  };

  /**
   * Force regime transition (manual override)
   * @param {string} newMode - New regime mode
   * @param {string} reason - Reason
   */
  const forceRegime = (newMode, reason) => {
    regimeDetector.forceTransition(newMode, reason);
  };

  /**
   * Pause engine (manual)
   * @param {string} reason - Reason
   */
  const pause = (reason) => {
    healthMonitor.pause(reason);
  };

  /**
   * Resume engine (manual)
   */
  const resume = () => {
    healthMonitor.resume();
  };

  /**
   * Mark fund as draining: block all new entries, cancel any pending entry
   * orders, and let the current take-profit cycle complete naturally. When
   * the cycle's TP fills, resetCycle() transitions the lifecycle to closed
   * and invokes callbacks.onLifecycleClosed so the host process can stop
   * the engine.
   * @param {string} [reason]
   * @returns {{success: boolean, lifecycle?: string, error?: string}}
   */
  const close = (reason) => {
    if (positionState.lifecycle === LIFECYCLE.CLOSED) {
      return { success: false, error: 'Fund is already closed' };
    }
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      return { success: false, error: 'Fund is already draining' };
    }
    positionState.lifecycle = LIFECYCLE.DRAINING;
    invalidateEntryAdmission();
    positionState.lifecycleChangedAt = Date.now();
    positionState.lifecycleReason = reason || null;
    if (!isDryRun) {
      saveLiveState();
    }
    // Cancel pending entry orders so the order book doesn't keep stale buys.
    // TP orders are NOT touched — they're what drains the cycle.
    orderExecutor.cancelAllEntries().catch((err) => {
      logger.warn(`⚠️ [${exchange}] Failed to cancel entries during close: ${err.message}`, { error: err.message });
    });
    logger.info(`🚦 [${exchange}] Fund draining${reason ? ` (${reason})` : ''} — new entries blocked, awaiting TP fill`);
    tradeEvents.emitTradeEvent('fund_draining', exchange, `Fund draining${reason ? `: ${reason}` : ''}`, {
      reason: reason || null,
      cyclesCompleted: positionState.cyclesCompleted,
    });
    return { success: true, lifecycle: LIFECYCLE.DRAINING };
  };

  // Sell settlement shares the engine's ledger, fill dedup and merge snapshots.
  // Read the active executor on demand so startup and test swaps stay visible.
  const { handleSellOrderFill } = createSellFillBooking({
    exchange, pair, productId, baseCurrency, config, logger, callbacks,
    positionState, fillLedger, closedTrades,
    recentlyProcessedSellFills, pendingMergeTpOrders, completedMergeTpOrders, dustWaitLoggedQty,
    getOrderExecutor: () => orderExecutor,
    isBodyTpSellOrder, bookTpCancelExecution, placeBodyTp,
    recordCycleForOptimizer, recordCycleForSizeOptimizer, resaveAfterSizeOptimizerLive,
    resetCycle, saveLiveState, getState,
  });

  // Placement-intent reconciliation (adopt / clear / block). Callers hold the engine lock.
  const {
    reconcilePlacementIntent, recoverPlacementIntent, reconcilePendingPlacements, blockingPlacementIntents,
  } = createPlacementReconciler({
    exchange, pair, productId, isDryRun, fillLedger, logger,
    getPositionState: () => positionState,
    getOrderExecutor: () => orderExecutor,
    getAdapter: () => adapter,
    saveLiveState: () => saveLiveState(),
  });

  // The reconcile loop (regime-reconcile): one pass and the steps it dispatches,
  // plus the terminal-entry catch-up it shares with startup recovery. The
  // interval, its handle and the fence around each tick stay here
  // (startReconciliation). Built here, after every collaborator it captures is
  // declared and before startup recovery, which takes catchUpTerminalEntry.
  const {
    catchUpTerminalEntry, reconcileEntryFills, sweepOrphanedSavedOrders,
    reconcileLegacyTp, reconcileBodyTps, reconcileRecoveredPosition, reconcileTick,
  } = createReconcileLoop({
    exchange, productId, isDryRun, config, logger,
    positionState, fillLedger, healthMonitor, positionSizer, engineLocks,
    recentlyProcessedFills, incompleteFillRetries,
    getIsRunning: () => isRunning,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getRecoveryModule: () => recoveryModule,
    lookupOrNull, restoredEntryStaleMs, stampKnownFilledSize,
    handleOrderFill, knownTpCancelExecution, bookTpCancelExecution,
    cancelBodyTpForReplace, placeBodyTp,
    reconcilePendingPlacements, completeOwedCycleReset,
    saveLiveState,
  });

  // Built here, after every collaborator it captures is declared; startImpl
  // only reaches it once start() runs, after the factory has returned.
  const startupRecovery = createStartupRecovery({
    exchange, pair, productId, baseCurrency, fundLabel, config, logger,
    positionState, replacePositionState, createInitialPositionState,
    fillLedger, closedTrades, pendingMergeTpOrders, completedMergeTpOrders,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getRecoveryModule: () => recoveryModule,
    getPriceIncrement: () => priceIncrement,
    lookupOrNull, restoredEntryStaleMs, calculateDynamicTpPercent,
    handleOrderFill, knownTpCancelExecution, bookTpCancelExecution, catchUpTerminalEntry,
    cancelBodyTpForReplace, placeBodyTp, placeTakeProfitOrder,
    recoverUnbookedOwnedEntryTranches, sealLegacyClosure,
    loadLiveState, saveLiveState, refreshRealizedFromCyclePairs,
    syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
  });

  /**
   * Get fund lifecycle state
   */
  const getLifecycle = () => ({
    lifecycle: positionState.lifecycle || LIFECYCLE.ACTIVE,
    lifecycleChangedAt: positionState.lifecycleChangedAt || null,
    lifecycleReason: positionState.lifecycleReason || null,
    lifecycleClosedCycle: positionState.lifecycleClosedCycle || null,
  });

  /**
   * Get current status (alias for getState for API consistency)
   * @returns {Object}
   */
  const getStatus = () => getState();

  /**
   * Update configuration
   * Tracks manual capital additions to depositedCapital
   * @param {Object} updates - Config updates
   */
  const updateConfig = (updates) => {
    // Direct depositedCapital edit - sync to position state
    if (updates.depositedCapital !== undefined && updates.depositedCapital !== config.depositedCapital) {
      positionState.depositedCapital = updates.depositedCapital > 0 ? roundUSDC(updates.depositedCapital) : 0;
      logger.info(`💵 [${exchange}] Deposited capital set to $${updates.depositedCapital > 0 ? updates.depositedCapital.toFixed(2) : 'auto-derive'}`);
      if (!isDryRun) saveLiveState();
      else saveDryRunState();
    }
    // Track manual capital additions (user deposits, not profits)
    // Skip auto-adjust when depositedCapital was explicitly provided (already handled above)
    if (updates.maxUsdcDeployed !== undefined && updates.maxUsdcDeployed !== config.maxUsdcDeployed && updates.depositedCapital === undefined) {
      const capitalChange = updates.maxUsdcDeployed - config.maxUsdcDeployed;
      if (capitalChange > 0) {
        // User added capital - update depositedCapital
        const prevDeposited = positionState.depositedCapital || positionState.originalCapital || config.maxUsdcDeployed;
        positionState.depositedCapital = roundUSDC(prevDeposited + capitalChange);
        logger.info(`💵 [${exchange}] Capital deposit: +$${capitalChange.toFixed(2)} (deposited: $${positionState.depositedCapital.toFixed(2)})`);
        // Save state to persist the deposit tracking
        if (!isDryRun) saveLiveState();
        else saveDryRunState();
      } else if (capitalChange < 0) {
        // User withdrew capital - reduce depositedCapital (but floor at 0)
        const prevDeposited = positionState.depositedCapital || positionState.originalCapital || config.maxUsdcDeployed;
        positionState.depositedCapital = roundUSDC(Math.max(0, prevDeposited + capitalChange));
        logger.info(`💸 [${exchange}] Capital withdrawal: $${Math.abs(capitalChange).toFixed(2)} (deposited: $${positionState.depositedCapital.toFixed(2)})`);
        if (!isDryRun) saveLiveState();
        else saveDryRunState();
      }
    }
    Object.assign(config, updates);

    // Forward macro config changes
    if (macroRegime) {
      macroRegime.updateConfig(updates);
    }

    logger.info(`🔧 [${exchange}] Regime engine config updated`);
  };

  /**
   * Get all fills from ledger
   * @returns {Array}
   */
  const getFills = () => fillLedger.getAllFills();

  /**
   * Get fill statistics
   * @returns {Object}
   */
  const getFillStats = () => fillLedger.getStats();

  /**
   * Get dry-run decision log
   * @param {number} [limit] - Maximum entries to return
   * @returns {Array|null}
   */
  const getDryRunLog = (limit = 100) => {
    if (isDryRun) {
      return orderExecutor.getDecisionLog(limit);
    }
    return null;
  };

  /**
   * Get dry-run P&L summary
   * @returns {Object|null}
   */
  const getDryRunPnL = () => {
    if (isDryRun) {
      return orderExecutor.getSimulatedPnL();
    }
    return null;
  };

  /**
   * Reset dry-run state (clears all simulated orders and history)
   * @returns {boolean}
   */
  const resetDryRun = () => {
    if (isDryRun) {
      orderExecutor.resetDryRunState();
      replacePositionState(createInitialPositionState());
      // Drop the in-memory risk manager's drawdown peak/pause too — otherwise
      // it survives the positionState wipe and the next metrics tick writes
      // the stale peak/pause right back into the fresh state (issue #742).
      riskManager.resetDrawdown();
      riskManager.resetCycleTracking();
      announcedCaps.clear();
      lastHourlySummaryEventAt = Date.now();
      // Clear saved state file
      dryRunState.clearState(exchange, pair);
      return true;
    }
    return false;
  };

  /**
   * Force resume from drawdown pause (manual override)
   * Resets peak equity to current level to allow trading to continue
   * @returns {{success: boolean, message: string}}
   */
  const forceResumeDrawdown = () => {
    hydrateDrawdownState();
    const riskState = riskManager.getState();
    if (!riskState.isDrawdownPaused) {
      return { success: false, message: 'Not in drawdown pause' };
    }

    // New peak = current fund equity, in the SAME unit updateDrawdown compares
    // against (computeFundEquity). The old P&L-unit value (market value − cost)
    // would re-base the peak to a number unrelated to the tracked equity.
    // Without a mark price there is no equity to re-base to, and clearing the
    // pause alone would just re-pause on the next tick.
    const price = marketState.lastPrice;
    if (!(price > 0)) {
      return { success: false, message: 'No market price yet — try again once the price feed is live' };
    }
    // Same reason refreshDrawdownGuard skips mid-mutation samples: a fill or
    // merge in flight can leave bodies and ledger momentarily inconsistent.
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: 'Position update in progress — try again in a moment' };
    }
    refreshRealizedFromCyclePairs();
    const { equity: currentEquity, capitalBase } = computeFundEquity(positionState, config, price);
    if (!(currentEquity > 0)) {
      return { success: false, message: `Fund equity is depleted ($${currentEquity.toFixed(2)}) — cannot re-base the drawdown peak` };
    }

    riskManager.forceResume(currentEquity, capitalBase);
    persistDrawdownState();
    if (!isDryRun) saveLiveStateGuarded('drawdown-resume');
    logger.info(`▶️ [${exchange}] Drawdown pause manually cleared, peak reset to $${currentEquity.toFixed(2)}`);

    return { success: true, message: `Resumed, peak reset to $${currentEquity.toFixed(2)}` };
  };

  const getOpenBodyCost = () => (positionState.celestialBodies || [])
    .reduce((sum, body) => sum + (body.costBasis || 0), 0);

  /**
   * Compute allocated capital defensively: use totalCostBasis but floor at
   * celestial body sum in case totalCostBasis is stale (e.g. after mode switch).
   */
  const getAllocatedCapital = () => Math.max(positionState.totalCostBasis || 0, getOpenBodyCost());

  /**
   * A ladder placement normally owns the ladder lock start to finish, so no
   * cycle reset can run under it. The one exception is a reset whose bounded
   * wait timed out and proceeded anyway (#766): it swept only the rungs placed
   * so far, and marking the rest active would leave a ladder resting into
   * the new cycle that nothing sweeps. Detect that and cancel it.
   * @param {number} generationAtStart - cycleResetGeneration when placement began
   * @param {string} label - log label
   * @returns {Promise<boolean>} true when the placed ladder was abandoned
   */
  const abandonLadderPlacedAcrossReset = async (generationAtStart, label) => {
    if (cycleResetGeneration === generationAtStart) return false;
    logger.warn(`⚠️ [${exchange}] ${label}: a cycle reset ran while the ladder was being placed (its ladder-lock wait timed out) — cancelling the ladder just placed`);
    await orderExecutor.cancelAllLadderOrders();
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];
    saveLiveState();
    return true;
  };

  // Entry evaluation (regime-entry): the mode-aware trigger, the reactive and
  // ladder entry paths and executeEntry. handleTicker still decides when an
  // evaluation runs and wraps it in the backup fence; the entry and ladder
  // locks and the admission captures are the engine's own. The log / alert
  // latches stay here (a cycle reset clears them, the episode state persists
  // announcedCaps), so the evaluator reads and replaces them through accessors.
  // Built here, after every collaborator it captures is declared.
  const { evaluateEntryTrigger, evaluateLadderEntry } = createEntryEvaluator({
    exchange, productId, isDryRun, config, exchangeConfig, logger, fundEventData,
    positionState, engineLocks,
    healthMonitor, tailEvents, regimeDetector, macroRegime, positionSizer, riskManager, ladderCalculator,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getMarketState: () => marketState,
    getPriceIncrement: () => priceIncrement,
    getCycleResetGeneration: () => cycleResetGeneration,
    getFlashCancelSweep: () => flashCancelSweep,
    getLoggedEntryBlockKinds: () => loggedEntryBlockKinds,
    setLoggedEntryBlockKinds: (v) => { loggedEntryBlockKinds = v; },
    getBudgetExhaustedWarningLogged: () => budgetExhaustedWarningLogged,
    setBudgetExhaustedWarningLogged: (v) => { budgetExhaustedWarningLogged = v; },
    getAnnouncedCaps: () => announcedCaps,
    setAnnouncedCaps: (v) => { announcedCaps = v; },
    getLowBalancePauseLogged: () => lowBalancePauseLogged,
    setLowBalancePauseLogged: (v) => { lowBalancePauseLogged = v; },
    lookupOrNull, blockingPlacementIntents, captureEntryAdmission, captureReactiveEntryAdmission,
    getAllocatedCapital, buildLadderFromMarket, abandonLadderPlacedAcrossReset,
    saveLiveState,
  });

  // Operator-triggered actions (position update/recalc, roll-up / Collapse All,
  // cycle reset, TP edits, ladder preview/rebuild/cancel, body inject/extend).
  // Each takes the same engineLocks hold and backup fence it took inline.
  // Built here, after every collaborator it captures is declared.
  const {
    updatePosition, extendBodiesFromRecoveredBuyRows, recalculateAndRefresh,
    _mergeBodyImpl, manualMergeBody, rollupAllBodies, resetCycleBuys,
    setBodyTpPercent, setBodyTpPrice, rebuildTP,
    previewLadder, rebuildLadder, cancelLadder,
    injectBody, extendBody, isExtendInFlight,
  } = createOperatorActions({
    exchange, pair, productId, baseCurrency, fundLabel, config, logger, callbacks,
    positionState, replacePositionState,
    fillLedger, riskManager, ladderCalculator, engineLocks,
    pendingMergeTpOrders, dustWaitLoggedQty,
    getIsRunning: () => isRunning,
    getAdapter: () => adapter,
    getOrderExecutor: () => orderExecutor,
    getMarketState: () => marketState,
    getPriceIncrement: () => priceIncrement,
    getCycleResetGeneration: () => cycleResetGeneration,
    lookupOrNull, captureEntryAdmission, getState, getStatus,
    handleOrderFillImpl, completeMergeSnapshot, cancelBodyTpForReplace,
    placeBodyTp, placeBodyTpWithRetry, placeTakeProfitOrder,
    resetCycle, getAllocatedCapital, buildLadderFromMarket, abandonLadderPlacedAcrossReset,
    saveLiveState, refreshRealizedFromCyclePairs,
    syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
  });

  fillLedger.setBuyCorrectionHandler(correction => {
    const next = projectBuyCorrection(positionState, correction);
    const derived = fillLedger.getDerivedRealizedPnL();
    next.realizedPnL = derived.realizedPnL;
    next.realizedAssetPnL = derived.realizedAssetPnL;
    next.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
    saveFundRegimeState(exchange, pair, { position: next, regime: regimeDetector.getState(),
      tpOptimizer: tpOptimizer.exportState(), sizeOptimizer: sizeOptimizer.exportState() });
    // Keep existing body references alive for any suspended fill/cancel path.
    for (const body of positionState.celestialBodies || []) {
      const projected = next.celestialBodies?.find(row => row.id === body.id);
      if (projected) Object.assign(body, projected);
    }
    const bodies = positionState.celestialBodies;
    Object.assign(positionState, next, { celestialBodies: bodies });
    config.maxUsdcDeployed = applyBuyCorrectionCapital(exchange, pair, correction);
    closedTrades.load();
    closedTrades.applyBuyCorrection(correction);
  });

  fillLedger.setSellCorrectionHandler(correction => {
    const next = structuredClone(positionState);
    next.appliedSellCorrections = [...new Set([...(next.appliedSellCorrections || []), correction.id])];
    const derived = fillLedger.getDerivedRealizedPnL();
    next.realizedPnL = derived.realizedPnL;
    next.realizedAssetPnL = derived.realizedAssetPnL;
    next.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
    if (next.celestialState) {
      next.celestialState.bodiesRealizedPnL = derived.realizedPnL;
      next.celestialState.bodiesRealizedAssetPnL = derived.realizedAssetPnL;
    }
    saveFundRegimeState(exchange, pair, { position: next, regime: regimeDetector.getState(),
      tpOptimizer: tpOptimizer.exportState(), sizeOptimizer: sizeOptimizer.exportState() });
    const bodies = positionState.celestialBodies;
    Object.assign(positionState, next, { celestialBodies: bodies });
    config.maxUsdcDeployed = applySellCorrectionCapital(exchange, pair, correction);
    closedTrades.load();
    closedTrades.applySellCorrection(correction);
  });

  /** Publish one generation of this fund's files as the backup fence holder. */
  const flushForBackup = () => engineLocks.runAsBackupHolder(() => {
    if (isDryRun) dryRunState.forceSave(exchange, snapshotDryRunState(), pair);
    else { saveLiveState(); fillLedger.persist({ force: true }); }
  });

  /**
   * Reopen the backup fence. Parked writers run once, in arrival order, and a
   * state save deferred during the hold is written now. Idempotent.
   */
  const releaseBackupHold = () => {
    if (!engineLocks.isBackupFenceHeld()) return;
    engineLocks.releaseBackupFence();
    flushDeferredSave();
  };

  /**
   * Quiesce this fund in place for a backup (#1945): close the backup fence
   * so every new writer parks, let the writers already past it finish
   * (bounded), then publish one generation of its files. The engine, its
   * websockets and its market data keep running throughout. Fails closed —
   * the fence is reopened and nothing is reported quiesced — when a writer
   * outlives the bound, the flush throws, or a stop ends the hold meanwhile.
   * @param {number} [timeoutMs]
   * @returns {Promise<{quiesced: boolean, error?: string}>}
   */
  const holdForBackup = async (timeoutMs = fillDrainMs) => {
    engineLocks.holdBackupFence();
    const idle = await engineLocks.waitForBackupIdle(timeoutMs);
    if (!engineLocks.isBackupFenceHeld()) return { quiesced: false, error: 'The fund stopped during the backup hold' };
    if (!idle.idle) {
      releaseBackupHold();
      const orders = idle.orderIds.length ? `; orders: ${idle.orderIds.join(', ')}` : '';
      return { quiesced: false, error: `Engine writers still in flight after ${timeoutMs / 1000}s (${idle.busy.join(', ')}${orders})` };
    }
    try {
      flushForBackup();
    } catch (err) {
      releaseBackupHold();
      return { quiesced: false, error: err.message };
    }
    return { quiesced: true };
  };

  return {
    start,
    stop,
    flushForBackup,
    holdForBackup,
    releaseBackupHold,
    isBackupHeld: () => engineLocks.isBackupFenceHeld(),
    getState,
    getStatus,
    forceRegime,
    pause,
    resume,
    close,
    getLifecycle,
    reconcilePlacementIntent,
    updateConfig,
    updatePosition,
    getFills,
    getFillPage: input => fillLedger.getFillPage(input, marketState.lastPrice),
    getFillAggregates: input => fillLedger.getFillAggregates(input),
    getFillLedger: () => fillLedger,
    recalculateAndRefresh,
    getFillStats,
    forceResumeDrawdown,
    manualMergeBody,
    rollupAllBodies,
    resetCycleBuys,
    setBodyTpPercent,
    setBodyTpPrice,
    rebuildTP,
    previewLadder,
    rebuildLadder,
    cancelLadder,
    injectBody,
    extendBody,
    // Dry-run specific methods
    isDryRun,
    getDryRunLog,
    getDryRunPnL,
    resetDryRun,
    // Expose internals for testing
    _getMarketState: () => marketState,
    _getPositionState: () => positionState,
    _getConfig: () => config,
    // #196 merge↔fill concurrency surface: setters to drive deterministic
    // interleavings and inject mock exchange deps, plus direct handles on the
    // internal closures the integration tests exercise. Test-only — never call
    // from production code.
    _test: {
      sealLegacyClosure: () => sealLegacyClosure(),
      setRunning: (v) => { isRunning = v; },
      setProductDetails: (v) => { productDetails = v; },
      setAdapter: (v) => { adapter = v; },
      setOrderExecutor: (v) => { orderExecutor = v; },
      handleTicker: (data) => handleTicker(data),
      evaluateEntryTrigger: () => evaluateEntryTrigger(),
      evaluateLadderEntry: () => evaluateLadderEntry(),
      setRecoveryModule: (v) => { recoveryModule = v; },
      startMetricsUpdater: () => startMetricsUpdater(),
      setMergeInProgress: engineLocks._test.setMergeInProgress,
      setReconcileInProgress: engineLocks._test.setReconcileInProgress,
      setFillInProgress: engineLocks._test.setFillInProgress,
      setDustMergeRetryAfter: (v) => { dustMergeRetryAfter = v; },
      setFillDrainMs: (v) => { fillDrainMs = v; },
      setFlashEntryWaitMs: (v) => { flashEntryWaitMs = v; },
      getFlashCancelSweep: () => flashCancelSweep,
      // Speeds up the incompleteFills engine-level retry (issue #679
      // follow-up) for tests — production keeps the 10s/5-attempt default.
      setIncompleteFillRetryTiming: (delayMs, maxRetries) => {
        incompleteFillRetryDelayMs = delayMs;
        if (maxRetries !== undefined) incompleteFillMaxRetries = maxRetries;
      },
      getIncompleteFillRetryCount: (dedupKey) => incompleteFillRetries.get(dedupKey) || 0,
      getFlags: () => ({ isRunning, dustMergeRetryAfter, ...engineLocks.getFlags() }),
      consolidateDustBodies,
      getDustWaitLoggedQty: () => new Map(dustWaitLoggedQty),
      setDustWaitLoggedQtyForTest: (bodyId, qty) => dustWaitLoggedQty.set(bodyId, qty),
      mergeBody: _mergeBodyImpl,
      handleOrderFill,
      handlePolledFill: (orderId, status) => liveCallbacks.onFillDetected(orderId, status),
      handleWsOrderUpdate: (data) => onWsOrderUpdate(data),
      handleEntryCancelled,
      getMergeTpSnapshots: () => ({ pending: new Map(pendingMergeTpOrders), completed: new Map(completedMergeTpOrders) }),
      sweepLedgerDrift,
      getFillDrift: () => fillDrift,
      getPositionCoverage: () => positionCoverage,
      reconcileTick,
      reconcileEntryFills,
      sweepOrphanedSavedOrders,
      reconcileLegacyTp,
      reconcileBodyTps,
      reconcileRecoveredPosition,
      reconcilePendingPlacements,
      checkOfflineOrderFills: () => startupRecovery.checkOfflineOrderFills(),
      // Background persistence guards (issue #532)
      saveLiveStateGuarded,
      saveDryRunStateGuarded,
      reloadStateFromDisk,
      getHealth: () => healthMonitor.getState(),
      healthMonitor,
      getPositionState: () => positionState,
      // Clear retry and expiring-record timers so tests can exit promptly.
      clearTimers: () => {
        for (const t of ttlTimers) clearTimeout(t);
        ttlTimers.clear();
        recentlyProcessedFills.clear();
        recentlyProcessedSellFills.clear();
        recentlyProcessedBuyFills.clear();
        completedMergeTpOrders.clear();
      },
      getExpiringStoreSizes: () => ({
        polling: recentlyProcessedFills.size,
        buy: recentlyProcessedBuyFills.size,
        sell: recentlyProcessedSellFills.size,
        completedMerge: completedMergeTpOrders.size,
      }),
      expiringStores: {
        polling: recentlyProcessedFills,
        buy: recentlyProcessedBuyFills,
        sell: recentlyProcessedSellFills,
        completedMerge: completedMergeTpOrders,
      },
      getExpiringTimerCount: () => recentlyProcessedFills.pendingTimerCount
        + recentlyProcessedBuyFills.pendingTimerCount
        + recentlyProcessedSellFills.pendingTimerCount
        + completedMergeTpOrders.pendingTimerCount,
      updateMetrics,
      ensureTakeProfitPlaced,
      refreshDrawdownGuard,
      getOrderExecutor: () => orderExecutor,
      resetCycle: () => resetCycle(),
      // A reset that timed out on the ladder lock and proceeded unserialised.
      resetCycleUnserialised: (opts = {}) => resetCycleLocked(null, opts.resetKind || 'close'),
      checkAllCaps: () => riskManager.checkAllCaps(positionState),
    },
  };
};

module.exports = {
  createRegimeEngine,
  createInitialMarketState,
  createInitialPositionState,
  restorePersistedCycleId,
  repairHistoricalFillAnnotations,
  planBodyGrowthFromRecoveredBuyRows,
  cancelPartialFillOrder,
  buildPartialFillData,
  makeFillDedupKey,
  resolveEntryBudget,
  isBuyAlreadyCommitted,
  isUnsettledBuyRow,
  collectBuyBookingBatch,
  boundRecoveredBuyRows,
  measureUnbookedOrderQty,
  shouldSkipBuyRecommit,
  isStrandedDustBody,
  isFullTpExecution,
  pruneStaleTpCancelMarkers,
};
