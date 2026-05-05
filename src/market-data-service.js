// @ts-check
/**
 * Market Data Service
 *
 * Maintains WebSocket connections for live market data streaming
 * even when the regime engine isn't running. Provides:
 * - Real-time price updates
 * - ATR and volatility calculations
 * - Regime detection (passive, no trading)
 *
 * This allows the UI to show live data before starting the engine.
 */

const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { calculateAllMetrics } = require('./volatility-utils');
const { getAdapter } = require('./adapters');
const { getRegimeConfig, getFundConfig, getDefaultPair, getBaseCurrency } = require('./config-utils');
const { loadRegimeState, LIFECYCLE } = require('./state-tracker');
const { createFillLedger } = require('./fill-ledger');
const { fundKey } = require('./shared-utils');
const { calculateApyMetrics } = require('./apy-calculator');
const celestialHierarchy = require('./celestial-hierarchy');

// Store active market data services keyed by `${exchange}::${pair}`
const marketDataServices = new Map();

// Only Coinbase is supported for WebSocket market data (other exchanges have different APIs)
const SUPPORTED_EXCHANGES = ['coinbase', 'cryptocom', 'gemini'];

/**
 * Fetch and ingest any new fills for an order, advancing the
 * lastIngestedFilledSize watermark on the tracked-order object only on
 * success. ingestFill is idempotent on tradeId, so re-fetching overlapping
 * fills (e.g. partial then terminal FILLED) is safe.
 *
 * @param {Object} deps
 * @param {{getOrderFills: Function}} deps.adapter
 * @param {{ingestFill: Function, persist: Function}} deps.fillLedger
 * @param {string} deps.exchange - For log prefixes only
 * @param {string} orderId
 * @param {Object} trackedOrder - Mutated: lastIngestedFilledSize updated on success
 * @param {number} cumulativeFilledSize - From the WS event (always cumulative)
 * @param {string} label - Log label, e.g. 'partial fill', 'FILLED', 'CANCELLED'
 * @returns {Promise<{fetched: boolean, fillsCount: number, ingestedCount: number}>}
 *   fetched=false means either adapter.getOrderFills() threw OR
 *   fillLedger.persist() threw — in both cases the watermark is NOT
 *   advanced and the caller should retry on the next WS update.
 *   fillsCount=0 with fetched=true means either: (a) the watermark
 *   already covered cumulativeFilledSize (early-out, no work needed),
 *   or (b) the exchange has not yet exposed any fills (e.g. Coinbase
 *   returns [] briefly right after a FILLED event). Callers that need
 *   to distinguish (a) from (b) should check the watermark themselves
 *   before calling — see handleOrderUpdate's FILLED branch.
 */
const ingestNewFillsForOrder = async (deps, orderId, trackedOrder, cumulativeFilledSize, label) => {
  const { adapter, fillLedger, exchange, isStopped = () => false } = deps;
  const lastSize = trackedOrder.lastIngestedFilledSize || 0;
  if (cumulativeFilledSize <= lastSize) {
    return { fetched: true, fillsCount: 0, ingestedCount: 0 };
  }

  // Sync trackedOrder.lastIngestedFilledSize from the actual ledger.
  // After a restart, trackedOrder is recreated with watermark=0 even
  // though fills may already be on disk; on adapter/persist failure
  // the caller would otherwise schedule a retry chain for an order
  // that's already fully recorded. Returns the reconciled size so the
  // failure paths can signal fetched=true (no work needed) when the
  // ledger already covers the WS-reported cumulative.
  const reconcileWatermarkFromLedger = () => {
    const recordedSize = fillLedger.getRecordedSizeForOrder
      ? fillLedger.getRecordedSizeForOrder(orderId)
      : (fillLedger.getFillsForOrder(orderId) || []).reduce((s, f) => s + (f.size || 0), 0);
    if (recordedSize > (trackedOrder.lastIngestedFilledSize || 0)) {
      trackedOrder.lastIngestedFilledSize = recordedSize;
    }
    return recordedSize;
  };

  let fills = [];
  try {
    fills = await adapter.getOrderFills(orderId);
  } catch (err) {
    console.log(`⚠️ [${exchange}] Failed to fetch fills for ${orderId}: ${err.message} — will retry on next update`);
    // Bail post-stop: the service may have been replaced during the await,
    // and writing to its now-stale fillLedger or trackedOrder via persist
    // / reconcile would corrupt the replacement service's state.
    if (isStopped()) return { fetched: false, fillsCount: 0, ingestedCount: 0 };
    // Try to flush any in-memory ledger state from a prior failed-persist
    // call before reading the ledger. If persist succeeds, in-memory is
    // in sync with disk and we can safely reconcile the watermark — covers
    // the post-restart case where fills are already on disk and the
    // adapter is just transiently unavailable, so the caller doesn't
    // schedule an unnecessary retry chain. If persist fails, the in-memory
    // ledger may be ahead of disk, so don't advance the watermark and
    // signal fetched=false so the caller retries (which will re-attempt
    // persist).
    let persistOk = true;
    try {
      fillLedger.persist();
    } catch (_persistErr) {
      persistOk = false;
    }
    if (persistOk) {
      const recordedSize = reconcileWatermarkFromLedger();
      if (recordedSize >= cumulativeFilledSize) {
        return { fetched: true, fillsCount: 0, ingestedCount: 0 };
      }
    }
    return { fetched: false, fillsCount: 0, ingestedCount: 0 };
  }

  // After awaiting I/O, recheck stopped — caller's service may have been
  // stopped during the fetch. Don't write to a now-stale fillLedger.
  if (isStopped()) {
    return { fetched: false, fillsCount: fills.length, ingestedCount: 0 };
  }

  if (fills.length === 0) {
    // Adapter has nothing to give us this round. Still attempt persist
    // (no-op when ledger is clean) so any in-memory fills from a
    // previous failed-persist call are flushed to disk. Also recompute
    // the watermark from the ledger: fills may already be present in
    // memory/disk from a prior call or restart with a populated ledger,
    // and without this update the retry chain would loop forever even
    // though the order is fully recorded.
    try {
      fillLedger.persist();
    } catch (err) {
      console.log(`⚠️ [${exchange}] Failed to persist ledger for ${orderId}: ${err.message} — will retry on next update`);
      // Don't reconcile from ledger here: persist failed, so the in-memory
      // ledger may be ahead of disk. Reading it would advance the
      // watermark past what's durably recorded — a subsequent crash
      // would lose those fills. Caller retries; the next persist attempt
      // will sync disk before we trust the ledger again.
      return { fetched: false, fillsCount: 0, ingestedCount: 0 };
    }
    reconcileWatermarkFromLedger();
    return { fetched: true, fillsCount: 0, ingestedCount: 0 };
  }

  // Pass placedAt for fill time tracking on buy orders (entry + ladder).
  // Without this for ladders, those fills disappear from the 7-day
  // fill-time statistics.
  const isBuyOrder = trackedOrder.type === 'entry' || trackedOrder.type === 'ladder_entry';
  const orderPlacedAt = isBuyOrder ? trackedOrder.placedAt : null;
  // skipPersist + a single trailing persist() is one synchronous JSON
  // rewrite per call, vs. one per fill if we let ingestFill auto-persist.
  // Matters on the partial-fill hot path where many small lots can fire
  // back-to-back WS updates.
  let ingestedCount = 0;
  for (const fill of fills) {
    const result = fillLedger.ingestFill(fill, orderPlacedAt, { skipPersist: true });
    if (result?.ingested) ingestedCount++;
  }

  // Always attempt persist at end-of-call. If a previous call's persist
  // threw, in-memory fills are ahead of disk; ingestFill's tradeId dedup
  // means a retry would return ingestedCount=0 with no chance to flush.
  // Calling persist() unconditionally rewrites the full atomic snapshot
  // and lets the next call catch up the disk. On failure we treat it the
  // same as an adapter failure: do NOT advance the watermark, signal
  // fetched=false so the caller retries.
  try {
    fillLedger.persist();
  } catch (err) {
    console.log(`⚠️ [${exchange}] Failed to persist ledger for ${orderId}: ${err.message} — will retry on next update`);
    return { fetched: false, fillsCount: fills.length, ingestedCount: 0 };
  }

  // Derive watermark from actual ledger contents — NOT cumulativeFilledSize.
  // Coinbase's getOrderFills returns all fills for an order, but Gemini and
  // Crypto.com synthesize getOrderFills from recent-trade queries and may
  // return only a subset. Setting the watermark to the WS-reported
  // cumulative would falsely claim "fully ingested" and suppress future
  // retries that would have caught the missing fills. Reading the ledger
  // ensures the watermark only advances by what actually landed.
  // O(1) via getRecordedSizeForOrder (orderSizeIndex) — getFillsForOrder
  // would scan + sort the full ledger, which gets slow on long-lived
  // ledgers since this fires on every WS update.
  const recordedSize = fillLedger.getRecordedSizeForOrder
    ? fillLedger.getRecordedSizeForOrder(orderId)
    : (fillLedger.getFillsForOrder(orderId) || []).reduce((s, f) => s + (f.size || 0), 0);
  trackedOrder.lastIngestedFilledSize = recordedSize;

  if (ingestedCount > 0) {
    console.log(`📥 [${exchange}] ${label} for ${orderId}: ingested ${ingestedCount} new fill(s), recorded=${recordedSize} of ${cumulativeFilledSize}`);
  }

  return { fetched: true, fillsCount: fills.length, ingestedCount };
};

const CANCEL_RETRY_BASE_MS = 30000;
const CANCEL_RETRY_MAX_MS = 300000; // 5 min cap on backoff
// Time budget for a single cancel-retry chain. Gemini and Crypto.com's
// getOrderFills are backed by recent-trade queries that age out, so a
// chain can never recover fills that fell out of that window — without
// a budget, those orders would loop forever. After this many ms of
// failed catch-up, settle with a loud warning so the order isn't stuck
// in retry indefinitely; an operator can manually reconcile if needed.
const CANCEL_RETRY_TIME_BUDGET_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Settle a tracked order on a CANCELLED/FAILED WS event, catching up any
 * unrecorded partial fills before marking it settled.
 *
 * Unlike the FILLED path, a terminally-cancelled order will not produce
 * follow-up WS events, so a transient adapter failure or empty-fills race
 * during the catch-up has no future event to retry against. Engine-restart
 * reconciliation does NOT recover cancelled-with-partials either — the
 * regime engine's startup branch for cancelled TPs (regime-engine.js
 * around line 1004) clears the saved orderId without ingesting fills. So
 * if we don't catch the partials here, they're lost permanently.
 *
 * Behavior:
 *   1. Synchronously flip trackedOrder.status to 'cancelled'/'failed' so
 *      getOrderStatus()-based filters stop showing the order as a phantom
 *      open row during any retry window.
 *   2. Try the catch-up fetch. On success, mark settled + schedule untrack.
 *   3. On failure or empty fills, schedule an exponential-backoff retry
 *      (capped at retryDelayMaxMs). Retries are indefinite — the only
 *      ways out are catch-up success or service stop (deps.scheduleTimeout
 *      is wrapped by the factory so stop() can clearTimeout the retry).
 *
 * @param {Object} deps
 * @param {{getOrderFills: Function}} deps.adapter
 * @param {{ingestFill: Function, persist: Function}} deps.fillLedger
 * @param {string} deps.exchange
 * @param {(orderId: string) => void} deps.markSettled
 * @param {(orderId: string) => void} deps.untrackOrder
 * @param {number} [deps.retryDelayBaseMs=CANCEL_RETRY_BASE_MS]
 * @param {number} [deps.retryDelayMaxMs=CANCEL_RETRY_MAX_MS]
 * @param {number} [deps.untrackDelayMs=60000]
 * @param {Function} [deps.scheduleTimeout=setTimeout] - Injected for tests
 *   AND so the factory can wrap it for cancellation on service stop
 * @param {string} orderId
 * @param {Object} trackedOrder - Mutated: status flipped synchronously
 * @param {string} status - 'CANCELLED' | 'FAILED'
 * @param {number} filledSize - Cumulative filledSize from WS event
 * @param {number} [attempt=0] - Current attempt index (0 = initial call)
 * @returns {Promise<{settledNow: boolean, retryScheduled: boolean}>}
 */
const settleCancelledOrder = async (deps, orderId, trackedOrder, status, filledSize, attempt = 0) => {
  const {
    adapter, fillLedger, exchange, markSettled, untrackOrder,
    retryDelayBaseMs = CANCEL_RETRY_BASE_MS,
    retryDelayMaxMs = CANCEL_RETRY_MAX_MS,
    retryTimeBudgetMs = CANCEL_RETRY_TIME_BUDGET_MS,
    untrackDelayMs = 60000,
    scheduleTimeout = setTimeout,
    isStopped = () => false,
    getCurrentFilledSize,
    now = Date.now,
  } = deps;

  if (isStopped()) return { settledNow: false, retryScheduled: false };

  // On retry attempts, consult the mutable target if the factory provided
  // one — replayed CANCELLED events with a larger cumulative filledSize
  // can advance the target after this chain was scheduled. Without
  // re-reading, the retry would catch up only to the stale captured
  // filledSize and stop short of the real cancelled quantity.
  if (attempt > 0 && typeof getCurrentFilledSize === 'function') {
    const latest = getCurrentFilledSize();
    if (typeof latest === 'number' && latest > filledSize) filledSize = latest;
  }

  if (attempt === 0) {
    console.log(`⚠️ [${exchange}] Tracked order ${orderId} ${status}`);
    // Flip status before the retry window so the offline pendingOrders
    // synthesizer (which relies on getOrderStatus to drop non-open orders)
    // doesn't keep emitting this order as a phantom open row.
    trackedOrder.status = status.toLowerCase();
    // Record the chain's start time so retries can enforce a time budget.
    trackedOrder._cancelRetryStartedAt = now();
  }

  const hadUnrecorded = filledSize > (trackedOrder.lastIngestedFilledSize || 0);
  let catchup = { fetched: true, fillsCount: 0, ingestedCount: 0 };
  if (hadUnrecorded) {
    const label = attempt === 0 ? status : `${status} (retry ${attempt})`;
    catchup = await ingestNewFillsForOrder({ adapter, fillLedger, exchange, isStopped }, orderId, trackedOrder, filledSize, label);
    // After the await, the service may have been stopped — bail before
    // we touch markSettled/scheduleTimeout, which would otherwise
    // mutate the stopped-service's state after a replacement is up.
    if (isStopped()) return { settledNow: false, retryScheduled: false };
  }

  // Settle only when the ledger actually covers the WS-reported cumulative
  // filledSize. A truthy fillsCount alone isn't sufficient: Gemini and
  // Crypto.com's adapters synthesize getOrderFills from recent-trade
  // queries and can return a partial set, so a non-empty response can
  // still leave the order short of the full cancelled quantity.
  // O(1) via getRecordedSizeForOrder; the cancel retry chain runs
  // indefinitely so we cannot afford an O(N) scan on every backoff tick.
  const recordedSize = fillLedger.getRecordedSizeForOrder
    ? fillLedger.getRecordedSizeForOrder(orderId)
    : (fillLedger.getFillsForOrder(orderId) || []).reduce((s, f) => s + (f.size || 0), 0);
  const stillNeedsCatchup = hadUnrecorded && (!catchup.fetched || recordedSize < filledSize);
  if (!stillNeedsCatchup) {
    markSettled(orderId);
    scheduleTimeout(() => untrackOrder(orderId), untrackDelayMs);
    return { settledNow: true, retryScheduled: false };
  }

  // Time budget exhausted? Settle anyway. Gemini and Crypto.com's
  // getOrderFills are backed by recent-trade queries that age fills
  // out, so the chain can never recover once partials fall outside
  // that window. Looping forever wastes adapter quota and never fires
  // terminal bookkeeping. The order's missed-fill data is on the
  // exchange and recoverable via manual reconciliation; we accept the
  // loss in the local ledger after this many ms of trying.
  const startedAt = trackedOrder._cancelRetryStartedAt || now();
  if (now() - startedAt > retryTimeBudgetMs) {
    console.log(`❌ [${exchange}] Cancel catch-up time budget (${Math.round(retryTimeBudgetMs / 60000)}min) exhausted for ${orderId} — settling without all partials. Manual reconciliation may be required if partials fell outside the adapter's recent-trade window.`);
    markSettled(orderId);
    scheduleTimeout(() => untrackOrder(orderId), untrackDelayMs);
    return { settledNow: true, retryScheduled: false, exhausted: true };
  }

  // Catchup didn't deliver. markSettled() is sticky and would block
  // future retries from running, so defer it. Retry indefinitely with
  // exponential backoff capped at retryDelayMaxMs — stop() in the factory
  // clears these timers so they can't outlive the service instance and
  // overwrite a replacement service's ledger.
  //
  // KNOWN LIMITATION: this retry state is in-memory only. If the API
  // process restarts before a retry succeeds, stop() cancels the timer
  // and the chain is lost — there is no durable marker for engine
  // startup to resume from. Combined with the engine's
  // cancelled-with-partials gap (see regime-engine.js KNOWN LIMITATION),
  // a transient adapter outage right around a cancel can permanently
  // drop the partials. Persisted retry markers + engine-side
  // reconciliation are deferred follow-ups.
  const nextDelay = Math.min(retryDelayBaseMs * Math.pow(2, attempt), retryDelayMaxMs);
  console.log(`⏳ [${exchange}] Scheduling cancel catch-up retry ${attempt + 1} for ${orderId} in ${Math.round(nextDelay / 1000)}s`);
  // Re-enter the retry through enqueueOrderWork (when the factory provides
  // it) so the retry callback serializes against any replayed CANCELLED/
  // FAILED WS update for the same orderId. Without this, two concurrent
  // settleCancelledOrder chains could fetch fills and mutate trackedOrder
  // at the same time. Tests that drive settleCancelledOrder directly
  // don't pass enqueueWork; the retry runs un-serialized in that case.
  const enqueueWork = deps.enqueueWork;
  scheduleTimeout(async () => {
    const run = () => settleCancelledOrder(deps, orderId, trackedOrder, status, filledSize, attempt + 1);
    try {
      if (enqueueWork) {
        await enqueueWork(orderId, run);
      } else {
        await run();
      }
    } catch (err) {
      console.log(`❌ [${exchange}] Cancel retry chain crashed for ${orderId}: ${err.message}`);
    }
  }, nextDelay);
  return { settledNow: false, retryScheduled: true };
};

/**
 * Returns a setTimeout wrapper that tracks scheduled timer IDs so they
 * can all be cancelled on service stop. Used by createMarketDataService
 * to keep cancel-retry / untrack timers from firing against a stopped
 * service's stale fillLedger after a replacement service has taken over.
 *
 * cancelAll() does two things:
 *   1. clearTimeout() on every queued (not-yet-fired) timer ID.
 *   2. Sets a "stopped" flag. Any in-flight wrapped callback that has
 *      already begun executing checks the flag immediately on entry and
 *      bails out before invoking the user fn — preventing post-stop
 *      writes through the user callback (e.g. fillLedger.persist()
 *      inside a retry that fired right before stop()).
 *
 * @returns {{ trackedSetTimeout: Function, cancelAll: () => number, size: () => number, isStopped: () => boolean }}
 */
const createTimerTracker = () => {
  const pending = new Set();
  let stopped = false;
  const trackedSetTimeout = (fn, delay) => {
    // Refuse to schedule new timers once stopped. A callback firing just
    // before cancelAll can still await and then call trackedSetTimeout
    // again (e.g. settleCancelledOrder scheduling its next retry or the
    // untrack TTL). Without this no-op those post-stop timers would be
    // added after cancelAll cleared the set and could mutate the now-
    // stale service instance later.
    if (stopped) return null;
    let id;
    const wrapped = async () => {
      pending.delete(id);
      // After cancelAll(), an already-queued but not-yet-clearTimeout-able
      // callback could still fire (race between setTimeout firing and
      // cancelAll iterating). The stopped flag closes that window: the
      // callback bails before touching any service-instance state.
      if (stopped) return;
      await fn();
    };
    id = setTimeout(wrapped, delay);
    pending.add(id);
    return id;
  };
  const cancelAll = () => {
    const n = pending.size;
    stopped = true;
    for (const id of pending) clearTimeout(id);
    pending.clear();
    return n;
  };
  // Cancel a single pending timer by the id returned from trackedSetTimeout.
  // No-op if id is null/undefined or the timer has already fired/been cancelled.
  // Used by callers that need to re-arm a timer with a fresher delay (e.g.,
  // partial-retry rescheduling on a fresh WS update) without leaking the
  // stale timer into the pending set.
  const cancel = (id) => {
    if (id == null || !pending.has(id)) return;
    clearTimeout(id);
    pending.delete(id);
  };
  return { trackedSetTimeout, cancel, cancelAll, size: () => pending.size, isStopped: () => stopped };
};

/**
 * Per-key serialization queue. Returns an enqueue(key, work) function
 * that chains async work for the same key to run strictly in arrival
 * order — different keys run concurrently. Used so partial / FILLED /
 * CANCELLED WS events for the same orderId process in order, since
 * websocket-feed fire-and-forgets onOrderUpdate (websocket-feed.js
 * lines 335-336).
 *
 * @returns {{ enqueue: (key: string, work: () => Promise<any>) => Promise<any>, size: () => number }}
 */
const createWorkQueue = () => {
  const chains = new Map(); // key -> Promise of latest enqueued work
  const enqueue = (key, work) => {
    const previous = chains.get(key) || Promise.resolve();
    // catch() prevents one failure from poisoning the chain for that key.
    const next = previous.catch(() => {}).then(() => work());
    chains.set(key, next);
    // Use .then(onFulfilled, onRejected) instead of .finally so rejection
    // from `next` is swallowed here (the caller of enqueue() owns the
    // returned promise's rejection); .finally would propagate it and
    // produce an unhandled rejection.
    const cleanup = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  };
  return { enqueue, size: () => chains.size };
};

const serviceKey = (exchange, pair) => fundKey(exchange, pair || getDefaultPair(exchange) || 'default');

/**
 * Create a market data service for a fund (exchange + pair).
 * Each fund needs its own service because the WebSocket feed subscribes to a
 * single product per connection.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {Object} Market data service instance
 */
const createMarketDataService = (exchange, pair) => {
  const resolvedPair = pair || getDefaultPair(exchange);
  let wsFeed = null;
  let regimeDetector = null;
  let fillLedger = null;
  let isConnected = false;
  let metricsUpdateInterval = null;
  let productId = null;
  let onStatusUpdateCallback = null;
  let lastStatusEmit = 0;
  const STATUS_EMIT_INTERVAL = 1000; // Throttle to ~1/sec to match chart buffer rate

  // Cache for regime state to avoid disk reads every second
  let cachedRegimeState = null;
  let cachedRegimeStateTime = 0;
  const REGIME_STATE_CACHE_MS = 10_000; // Reload from disk at most every 10s

  // Trade flow tracking — rolling window of recent trades for imbalance calculation
  const tradeFlowWindow = [] // { price, size, side, timestamp }
  const TRADE_FLOW_MAX_AGE_MS = 300_000 // 5 minutes

  // Market state (same structure as regime engine)
  const marketState = {
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
    lastUpdate: 0,
  };

  // Regime state
  const regimeState = {
    mode: 'HARVEST',
    since: Date.now(),
    reason: 'Initial state',
  };

  // Tracked open orders (from saved regime state)
  const trackedOrders = new Map(); // orderId -> { type, price, size, placedAt, status }
  // Orders the WS feed has already confirmed settled (filled/cancelled).
  // Kept in-memory so a cache reload can't resurrect a stale tpOrderId from
  // disk after the 60s trackedOrders TTL fires. Bounded to prevent unbounded
  // growth over long uptime — when full, the oldest entry is evicted (Map
  // preserves insertion order). New body TPs created after eviction will be
  // re-tracked from disk and the WS feed will re-detect any settlement.
  const SETTLED_MAX = 5000;
  const settledOrderIds = new Map(); // orderId -> 1 (Map for insertion-order eviction)
  const markSettled = (orderId) => {
    settledOrderIds.set(orderId, 1);
    if (settledOrderIds.size > SETTLED_MAX) {
      const oldest = settledOrderIds.keys().next().value;
      settledOrderIds.delete(oldest);
    }
  };

  // Pending background timers (cancel retries, untrack TTLs) tied to this
  // service instance. stop() clears them so a stopped service can't fire
  // delayed callbacks against a stale ledger / Map after a replacement
  // service for the same exchange/pair has been started.
  const timerTracker = createTimerTracker();
  const trackedSetTimeout = timerTracker.trackedSetTimeout;

  let onOrderFillCallback = null; // External callback for when orders fill

  // Pre-populate trackedOrders from a position (called at startup and on
  // every cache reload) so the WS feed can detect fills/cancels for every
  // persisted live order — TPs (sell), pending entries (buy), and ladder
  // entries (buy) — while the engine is stopped. Skips anything already
  // seen settled.
  const trackPersistedOrders = (pos) => {
    if (pos?.activeTpOrderId && !trackedOrders.has(pos.activeTpOrderId) && !settledOrderIds.has(pos.activeTpOrderId)) {
      trackedOrders.set(pos.activeTpOrderId, {
        type: 'take_profit',
        price: pos.lastTpPrice || 0,
        size: pos.assetOnOrder || pos.totalAsset || 0,
        placedAt: pos.lastEntryTime || Date.now(),
        status: 'open',
      });
      console.log(`📋 [${exchange}] Market data service tracking core TP: ${pos.activeTpOrderId}`);
    }
    for (const body of (pos?.celestialBodies || [])) {
      if (!body.tpOrderId || trackedOrders.has(body.tpOrderId) || settledOrderIds.has(body.tpOrderId)) continue;
      trackedOrders.set(body.tpOrderId, {
        type: 'body_tp',
        price: body.tpPrice || 0,
        size: body.assetOnOrder || body.assetQty || 0,
        placedAt: body.lastMergedAt || body.createdAt || Date.now(),
        status: 'open',
        bodyId: body.id,
      });
    }
    const trackEntries = (entries, type) => {
      for (const e of (entries || [])) {
        if (!e.orderId || trackedOrders.has(e.orderId) || settledOrderIds.has(e.orderId)) continue;
        trackedOrders.set(e.orderId, {
          type,
          price: e.price || 0,
          size: e.assetQty || 0,
          sizeUsdc: e.sizeUsdc,
          placedAt: e.placedAt || Date.now(),
          status: 'open',
        });
      }
    };
    trackEntries(pos?.pendingEntryOrders, 'entry');
    trackEntries(pos?.pendingLadderOrders, 'ladder_entry');
  };

  // Price history for calculations
  const priceHistory = [];
  const MAX_PRICE_HISTORY = 300; // 5 minutes of tick data

  /**
   * Start the market data service
   */
  const start = async () => {
    const adapter = getAdapter(exchange);

    // Try to load credentials with error handling
    let credentials;
    try {
      credentials = adapter.loadCredentials();
    } catch (err) {
      console.log(`⚠️ [${exchange}] Market data service: Failed to load credentials: ${err.message}`);
      return { success: false, error: err.message };
    }

    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      console.log(`⚠️ [${exchange}] Market data service: No API credentials, skipping`);
      return { success: false, error: 'No API credentials' };
    }

    const config = getRegimeConfig(exchange, resolvedPair);
    const fundConfig = getFundConfig(exchange, resolvedPair);
    productId = fundConfig.productId || resolvedPair || 'BTC-USDC';

    // Create regime detector for passive monitoring
    regimeDetector = createRegimeDetector(exchange, config);

    // Load any tracked orders from saved regime state.
    const savedState = loadRegimeState(exchange, resolvedPair);
    trackPersistedOrders(savedState.position);
    const bodyTpCount = (savedState.position?.celestialBodies || []).filter(b => b.tpOrderId).length;
    if (bodyTpCount > 0) console.log(`📋 [${exchange}] Market data service tracking ${bodyTpCount} body TP(s)`);

    // Create fill ledger for order fill tracking
    fillLedger = createFillLedger(exchange, productId, resolvedPair);

    // Create WebSocket feed
    wsFeed = createWebSocketFeed(exchange, {
      productId,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      onTicker: handleTicker,
      onTrade: handleTrade,
      onOrderUpdate: handleOrderUpdate,
      onConnect: () => {
        isConnected = true;
        console.log(`📊 [${exchange}] Market data service connected`);
      },
      onDisconnect: () => {
        isConnected = false;
        console.log(`📊 [${exchange}] Market data service disconnected`);
      },
      onError: (error) => {
        console.log(`❌ [${exchange}] Market data service error: ${error.message}`);
      },
    });

    // Connect WebSocket
    wsFeed.connect();

    // Start periodic metrics update via REST (for ATR calculations)
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
    }
    metricsUpdateInterval = setInterval(() => updateMetrics(adapter, productId), 60000);

    // Initial metrics fetch
    await updateMetrics(adapter, productId);

    console.log(`📊 [${exchange}] Market data service started for ${productId}`);
    return { success: true };
  };

  /**
   * Emit a throttled status update to the callback (for Socket.IO + chart buffer)
   */
  const emitStatus = () => {
    if (!onStatusUpdateCallback) return;
    const now = Date.now();
    if (now - lastStatusEmit < STATUS_EMIT_INTERVAL) return;
    lastStatusEmit = now;

    // Use cached regime state to avoid disk reads every second
    if (!cachedRegimeState || now - cachedRegimeStateTime > REGIME_STATE_CACHE_MS) {
      cachedRegimeState = loadRegimeState(exchange, resolvedPair);
      cachedRegimeStateTime = now;
      // Pick up any new body TPs created since startup so the WS feed can
      // detect their fills/cancels while the engine is stopped.
      trackPersistedOrders(cachedRegimeState?.position);
    }

    // Synthesize persisted TPs + the same enrichment fields the running
    // engine emits (apy, lifecycle, celestial summary) so a hard refresh
    // while the engine is stopped doesn't lose APY/capital sections or
    // misreport celestial as off between cycles. Each tick from this
    // service overwrites socketStatus, so the payload must be shape-
    // compatible with the running-engine status.
    const position = cachedRegimeState?.position || null;
    const bodies = position?.celestialBodies || [];
    const config = getRegimeConfig(exchange, resolvedPair);
    const market = getMarketState();
    // Drop persisted TPs the WS feed has already confirmed are no longer open
    // (filled/cancelled while the engine was stopped) — the engine can't
    // refresh state until it restarts, but we should not show phantom rows.
    const pendingOrders = celestialHierarchy.buildPersistedPendingOrders(position, getOrderStatus);

    onStatusUpdateCallback({
      isRunning: false,
      market,
      regime: getRegimeState(),
      position,
      pendingOrders,
      apy: position ? calculateApyMetrics(position, config, { lastPrice: market?.lastPrice || 0 }) : {},
      lifecycle: {
        lifecycle: position?.lifecycle || LIFECYCLE.ACTIVE,
        lifecycleChangedAt: position?.lifecycleChangedAt || null,
        lifecycleReason: position?.lifecycleReason || null,
        lifecycleClosedCycle: position?.lifecycleClosedCycle || null,
      },
      celestial: celestialHierarchy.buildCelestialPayload(position, config),
      health: { mode: 'STOPPED' },
      isDryRun: cachedRegimeState?.isDryRun || false,
    });
  };

  /**
   * Handle ticker updates
   */
  const handleTicker = (data) => {
    marketState.lastPrice = data.price;
    marketState.bid = data.bid;
    marketState.ask = data.ask;
    marketState.spread = data.ask - data.bid;
    marketState.lastUpdate = Date.now();

    // Add to price history
    priceHistory.push({
      price: data.price,
      timestamp: Date.now(),
    });

    // Trim history
    while (priceHistory.length > MAX_PRICE_HISTORY) {
      priceHistory.shift();
    }

    // Update regime detector with new price
    if (regimeDetector && marketState.atr1m > 0) {
      regimeDetector.update({
        lastPrice: data.price,
        atr1m: marketState.atr1m,
        realizedVol: marketState.realizedVol,
        volBaseline: marketState.volBaseline,
        vwapDistance: marketState.vwapDistance,
      });

      const mode = regimeDetector.getMode();
      if (mode !== regimeState.mode) {
        regimeState.mode = mode;
        regimeState.since = Date.now();
        regimeState.reason = `Detected via market data service`;
      }
    }

    // Push live data to UI + chart buffer
    emitStatus();
  };

  /**
   * Handle trade updates — accumulate into rolling window for buy/sell imbalance
   */
  const handleTrade = (data) => {
    if (!data?.price || !data?.size || !data?.side) return

    const now = Date.now()
    tradeFlowWindow.push({
      price: data.price,
      size: parseFloat(data.size),
      side: data.side, // 'buy' or 'sell' (taker side)
      timestamp: now,
    })

    // Prune entries older than 5 minutes
    while (tradeFlowWindow.length > 0 && tradeFlowWindow[0].timestamp < now - TRADE_FLOW_MAX_AGE_MS) {
      tradeFlowWindow.shift()
    }
  };

  // Per-orderId update serialization. websocket-feed invokes onOrderUpdate
  // without await (websocket-feed.js:335-336), so partial / FILLED /
  // CANCELLED events for the same order can race. Without serialization
  // a partial in-flight could ingest fills AFTER a later FILLED reads
  // the watermark, causing FILLED to hit the empty-fills race and never
  // settle. Chain updates per orderId so they process in arrival order.
  const orderWorkQueue = createWorkQueue();
  const enqueueOrderWork = (orderId, work) => orderWorkQueue.enqueue(orderId, work);

  // Allows tests to substitute a fake adapter without monkey-patching
  // the require cache (market-data-service destructures getAdapter at
  // module load, so cache patches arrive too late).
  let _adapterOverride = null;
  const getActiveAdapter = () => _adapterOverride || getAdapter(exchange);

  // Per-orderId pending-retry registries. Both are Maps storing a
  // mutable target so replayed WS events for the same order can advance
  // the cumulative filledSize a queued retry chain is targeting:
  //
  // - pendingTerminalRetries: orderId -> { filledSize }. Dedupes
  //   replayed FILLED/CANCELLED but lets a larger replayed cumulative
  //   reach the in-flight retry chain via the mutable target object.
  //
  // - pendingPartialRetries: orderId -> { filledSize, attempt }. Same
  //   pattern for OPEN-status partials.
  //
  // Terminal events preempt any pending partial entry — the queued
  // partial timer fires, finds no entry, and bails.
  const pendingTerminalRetries = new Map();
  const pendingPartialRetries = new Map();

  const clearPendingRetry = (orderId) => {
    pendingTerminalRetries.delete(orderId);
    pendingPartialRetries.delete(orderId);
  };

  const finalizeFilledOrder = (orderId, trackedOrder, filledSize, averageFilledPrice, totalFees) => {
    trackedOrder.status = 'filled';
    trackedOrder.filledSize = filledSize;
    trackedOrder.filledPrice = averageFilledPrice;
    trackedOrder.fees = totalFees;
    trackedOrder.filledAt = Date.now();
    clearPendingRetry(orderId);

    if (onOrderFillCallback) {
      onOrderFillCallback({
        orderId,
        type: trackedOrder.type,
        size: filledSize,
        price: averageFilledPrice,
        fees: totalFees,
        exchange,
      });
    }

    // Mark settled and prune from trackedOrders (settledOrderIds outlives
    // the 60s TTL so cache reloads can't resurrect this order).
    markSettled(orderId);
    trackedSetTimeout(() => trackedOrders.delete(orderId), 60000);
  };

  // Eventual-consistency retry for FILLED orders whose getOrderFills came
  // back empty (or whose adapter/persist threw). FILLED is terminal;
  // Coinbase is not guaranteed to emit another WS update, so without
  // this path the order would stay tracked forever.
  //
  // Earlier iterations of this PR fell back to synthesizing a fill from
  // the WS order-status data after one retry. That created a hazard: if
  // the engine later restarted before getOrderFills returned the real
  // exchange fills, startup reconciliation would ingest them with their
  // genuine tradeIds, leaving the ledger with both the synthetic and
  // the real records for one execution (overstating size/P&L). Indefinite
  // retry is safer — only real fills ever land in the ledger, and the
  // exponential backoff bounds the load on the adapter.
  const FILLED_RETRY_BASE_MS = 2000;
  const FILLED_RETRY_MAX_MS = 300000; // 5 min cap
  // Same Gemini/Crypto.com aged-out-fills concern as the cancel chain.
  // After this many ms of failed catch-up, settle the FILLED order with
  // a warning rather than retry forever.
  //
  // Coinbase's getOrderFills does not age fills out — a long outage that
  // outlasts the default budget can still recover later, so giving up
  // would silently drop recoverable fills. Use Infinity for Coinbase and
  // rely on service stop (timerTracker.cancelAll) to bound the chain.
  // Gemini and Crypto.com synthesize getOrderFills from recent-trade
  // queries that age out, so the bounded budget still applies.
  const FILLED_RETRY_TIME_BUDGET_MS = 6 * 60 * 60 * 1000;
  const filledRetryTimeBudgetMs = exchange === 'coinbase' ? Infinity : FILLED_RETRY_TIME_BUDGET_MS;

  // Bounded partial-fill ingest retry. Open orders are still active so
  // the next WS update will eventually trigger another attempt; this is
  // a backstop for the case where an OPEN order goes silent for a long
  // time after a transient ingest failure. Capped attempts so we don't
  // pile up timers for orders that may never fill again.
  const PARTIAL_RETRY_BASE_MS = 2000;
  const PARTIAL_RETRY_MAX_MS = 60000; // 1 min cap — order is still active
  const PARTIAL_MAX_ATTEMPTS = 5;

  const retryPartialIngest = async (orderId, trackedOrder, filledSize, attempt) => {
    if (!trackedOrders.has(orderId)) return;
    if (timerTracker.isStopped()) return;
    // Skip if a terminal event finalized the order — the FILLED/CANCELLED
    // path will own catch-up.
    if (trackedOrder.status === 'filled' || trackedOrder.status === 'cancelled' || trackedOrder.status === 'failed') {
      return;
    }
    if (filledSize <= (trackedOrder.lastIngestedFilledSize || 0)) return; // already covered

    const ingestDeps = { adapter: getActiveAdapter(), fillLedger, exchange, isStopped: timerTracker.isStopped };
    const result = await ingestNewFillsForOrder(ingestDeps, orderId, trackedOrder, filledSize, `partial retry ${attempt}`);
    if (timerTracker.isStopped()) return;

    if (filledSize <= (trackedOrder.lastIngestedFilledSize || 0)) return; // recovered

    // Still short. Reschedule up to the attempt cap; after that, let the
    // next WS event drive recovery (or the terminal-state catch-up).
    if (attempt + 1 <= PARTIAL_MAX_ATTEMPTS) {
      const reason = result.fetched ? 'ledger short of cumulative' : 'fetch/persist failed';
      schedulePartialRetry(orderId, trackedOrder, filledSize, attempt + 1, reason);
    } else {
      console.log(`⚠️ [${exchange}] Partial-fill ingest gave up for ${orderId} after ${PARTIAL_MAX_ATTEMPTS} attempts — relying on next WS event or terminal catch-up`);
    }
  };

  const armPartialTimer = (orderId, trackedOrder, entry, reason) => {
    // Cancel any previously-armed timer for this entry before scheduling
    // the fresh one. Without this, a sustained adapter outage with many
    // WS updates would accumulate one pending timer per update in
    // timerTracker, growing the pending set unboundedly and later flooding
    // the queue with stale no-op callbacks.
    if (entry.timerId != null) {
      timerTracker.cancel(entry.timerId);
      entry.timerId = null;
    }
    const delay = Math.min(PARTIAL_RETRY_BASE_MS * Math.pow(2, entry.attempt - 1), PARTIAL_RETRY_MAX_MS);
    console.log(`⏳ [${exchange}] partial ${orderId} ${reason} — retry ${entry.attempt}/${PARTIAL_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
    entry.timerId = trackedSetTimeout(
      () => enqueueOrderWork(orderId, async () => {
        // Read the (possibly updated) target out of the map; if the
        // entry was preempted by a terminal handler, bail.
        const cur = pendingPartialRetries.get(orderId);
        if (!cur) return;
        pendingPartialRetries.delete(orderId);
        try {
          await retryPartialIngest(orderId, trackedOrder, cur.filledSize, cur.attempt);
        } catch (err) {
          console.log(`❌ [${exchange}] partial retry chain crashed for ${orderId}: ${err.message}`);
        }
      }),
      delay
    );
  };

  const schedulePartialRetry = (orderId, trackedOrder, filledSize, attempt, reason) => {
    // If a terminal retry is pending, terminal supersedes partial — let
    // it own catch-up. (FILLED/CANCELLED handlers also preempt any
    // pending partial entry when they arm.)
    if (pendingTerminalRetries.has(orderId)) return;

    // If a partial retry is already pending and a fresh WS update
    // reports a larger cumulative, treat it as new work:
    //   - Reset the attempt counter so the new partial gets a fresh
    //     PARTIAL_MAX_ATTEMPTS budget. Without this, an entry that has
    //     burned through most of its retries would give up after one or
    //     two tries on the new larger value.
    //   - Re-arm the timer with the new attempt's (smaller) delay. The
    //     previous timer is cancelled inside armPartialTimer so the
    //     pending set doesn't grow unboundedly under sustained outage.
    //     Without rescheduling, an entry that has already backed off to
    //     a long delay (e.g. 60s) would sit on that stale delay despite
    //     the fresh exchange activity, leaving the new partial
    //     unrecorded until the stale timer fires.
    let entry = pendingPartialRetries.get(orderId);
    if (entry) {
      if (filledSize > entry.filledSize) {
        entry.filledSize = filledSize;
        entry.attempt = attempt;
        armPartialTimer(orderId, trackedOrder, entry, reason);
      }
      return;
    }

    entry = { filledSize, attempt, timerId: null };
    pendingPartialRetries.set(orderId, entry);
    armPartialTimer(orderId, trackedOrder, entry, reason);
  };

  const retryFilledIngest = async (orderId, trackedOrder, target, attempt) => {
    if (!trackedOrders.has(orderId)) return; // already removed by another path
    if (timerTracker.isStopped()) return;
    if (trackedOrder.status === 'filled' || trackedOrder.status === 'cancelled' || trackedOrder.status === 'failed') {
      return;
    }
    if (attempt === 1 && !trackedOrder._filledRetryStartedAt) {
      trackedOrder._filledRetryStartedAt = Date.now();
    }
    const startedAt = trackedOrder._filledRetryStartedAt || Date.now();
    if (Date.now() - startedAt > filledRetryTimeBudgetMs) {
      console.log(`❌ [${exchange}] FILLED retry time budget (${Math.round(filledRetryTimeBudgetMs / 60000)}min) exhausted for ${orderId} — settling. Manual reconciliation may be required if partials fell outside the adapter's recent-trade window.`);
      finalizeFilledOrder(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees);
      return;
    }

    // Read the latest target values — handleOrderUpdate's synchronous
    // prelude updates `target` in place when a replayed FILLED arrives,
    // so a replay during this retry's await is reflected here.
    const ingestDeps = { adapter: getActiveAdapter(), fillLedger, exchange, isStopped: timerTracker.isStopped };
    const result = await ingestNewFillsForOrder(ingestDeps, orderId, trackedOrder, target.filledSize, `FILLED retry ${attempt}`);
    if (timerTracker.isStopped()) return;

    // Re-read target AFTER the await — replays during ingestion may have
    // advanced the cumulative. If the watermark covers the latest target
    // (not just the value we passed to ingest), settle.
    if (target.filledSize <= (trackedOrder.lastIngestedFilledSize || 0)) {
      finalizeFilledOrder(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees);
      return;
    }

    const reason = result.fetched ? 'ledger short of cumulative' : 'fetch/persist failed';
    scheduleFilledRetry(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees, attempt + 1, reason);
  };

  const scheduleFilledRetry = (orderId, trackedOrder, filledSize, averageFilledPrice, totalFees, attempt, reason) => {
    // Update or create the pending target entry. Replays advance the
    // mutable filledSize / averageFilledPrice / totalFees so an in-flight
    // retry settles with the latest aggregates — not the stale ones
    // captured at original scheduling. The entry stays alive while the
    // retry is in flight (timerFiring=true) so handleOrderUpdate's
    // synchronous prelude can keep advancing it.
    let target = pendingTerminalRetries.get(orderId);
    if (target) {
      if (filledSize > target.filledSize) {
        target.filledSize = filledSize;
        target.averageFilledPrice = averageFilledPrice;
        target.totalFees = totalFees;
      }
      // If a timer is already pending for this entry, leave it.
      if (target.timerScheduled) return;
    } else {
      // Preempt any pending partial retry — terminal owns catch-up.
      pendingPartialRetries.delete(orderId);
      target = { filledSize, averageFilledPrice, totalFees, timerScheduled: false };
      pendingTerminalRetries.set(orderId, target);
    }
    target.timerScheduled = true;

    const delay = Math.min(FILLED_RETRY_BASE_MS * Math.pow(2, attempt - 1), FILLED_RETRY_MAX_MS);
    console.log(`⏳ [${exchange}] FILLED ${orderId} ${reason} — retry ${attempt} in ${Math.round(delay / 1000)}s`);
    trackedSetTimeout(
      () => enqueueOrderWork(orderId, async () => {
        target.timerScheduled = false;
        // Keep the entry alive during the retry so replayed FILLED
        // events arriving via handleOrderUpdate's synchronous prelude
        // can still update target.filledSize/averageFilledPrice/totalFees.
        // retryFilledIngest reads the latest values from `target` rather
        // than the stale captured arguments.
        try {
          await retryFilledIngest(orderId, trackedOrder, target, attempt);
        } catch (err) {
          console.log(`❌ [${exchange}] FILLED retry chain crashed for ${orderId}: ${err.message}`);
          scheduleFilledRetry(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees, attempt + 1, 'previous attempt threw');
        }
      }),
      delay
    );
  };

  // Drive a cancel/fail catch-up chain against settleCancelledOrder, with
  // the deps wiring needed to (a) keep the chain serialized through the
  // work queue, (b) feed the latest cumulative filledSize back into each
  // retry, and (c) flag the target as settled when the chain finishes so
  // replays with a larger cumulative can detect the gap and restart.
  //
  // markSettled is wrapped: settleCancelledOrder calls it on both the
  // synchronous-success path and on retry-success/budget-exhaust paths,
  // and the wrapper flips target.settled on the same Map entry that the
  // initial path stored. The wrapper propagates through the recursive
  // settleCancelledOrder retry (it passes its own deps through), so even
  // a chain that settles on attempt N still flips target.settled.
  //
  // Cancel-side untrack TTL is intentionally longer than the FILLED side
  // (60s). After a delayed WS reconnect a replayed CANCELLED with a
  // larger cumulative may arrive minutes after the initial settle —
  // 10 minutes covers most realistic reconnect windows so the restart
  // logic in processOrderUpdate can pick up the late partials. (Past
  // this window, partials are still recoverable on Coinbase via manual
  // reconciliation; on Gemini/Crypto.com the recent-trade window may
  // have aged them out anyway, which is the documented limitation.)
  const CANCEL_UNTRACK_DELAY_MS = 10 * 60 * 1000;
  const startCancelCatchup = (orderId, trackedOrder, status, filledSize, target) => {
    // Cancel any in-flight retry/untrack timer from a prior chain instance.
    // A fresh startCancelCatchup starts a new chain at attempt=0; without
    // this, the old chain's scheduled retry would compete against the new
    // one (each scheduling its own retry, doubling adapter pressure and
    // pinning a stale timer in the tracker until it fires).
    if (target.timerId != null) {
      timerTracker.cancel(target.timerId);
      target.timerId = null;
    }
    const ingestDeps = { adapter: getActiveAdapter(), fillLedger, exchange, isStopped: timerTracker.isStopped };
    return settleCancelledOrder(
      {
        ...ingestDeps,
        markSettled: (id) => { markSettled(id); target.settled = true; },
        untrackOrder: (id) => {
          // Skip if the chain has been re-armed (target.settled flipped
          // back to false by a replay-driven restart). A restart's new
          // settle will schedule its own untrack TTL when it completes;
          // letting this stale timer run would clear pendingTerminalRetries
          // and trackedOrders mid-flight, causing the restarted chain's
          // retries to bail out and the newly reported partials to be
          // dropped.
          if (!target.settled) return;
          clearPendingRetry(id);
          trackedOrders.delete(id);
        },
        untrackDelayMs: CANCEL_UNTRACK_DELAY_MS,
        // Wrap scheduleTimeout so we can cancel the latest scheduled timer
        // (retry OR untrack) when a replay arrives that needs to restart
        // the chain at attempt=0. The id stored is always the most-recent
        // schedule; settleCancelledOrder schedules at most one timer per
        // attempt, so the previous id is no longer needed once a new one
        // is recorded.
        scheduleTimeout: (fn, delay) => {
          const id = trackedSetTimeout(fn, delay);
          target.timerId = id;
          return id;
        },
        enqueueWork: enqueueOrderWork,
        // Coinbase's getOrderFills is the source of truth and never ages
        // out; capping the chain at 6h would silently drop fills the
        // adapter would still return after a long outage. Gemini and
        // Crypto.com synthesize fills from recent-trade queries that age
        // out, so the bounded budget still applies there.
        retryTimeBudgetMs: exchange === 'coinbase' ? Infinity : CANCEL_RETRY_TIME_BUDGET_MS,
        // Mutable target: replayed CANCELLED events advance target.filledSize
        // so each retry attempt re-reads the latest cumulative.
        getCurrentFilledSize: () => target.filledSize,
      },
      orderId, trackedOrder, status, filledSize
    );
  };

  /**
   * Handle order updates from WebSocket
   * Detects when tracked orders fill while engine isn't running.
   * Always returns a Promise so callers can chain .catch() — every early
   * return resolves to undefined rather than synchronously returning it,
   * which would break `handleOrderUpdate(data).catch(...)` at the regime
   * engine call site.
   */
  const handleOrderUpdate = async (data) => {
    if (!productId) return;
    if (timerTracker.isStopped()) return;
    const { orderId, status, filledSize, averageFilledPrice, totalFees } = data;
    if (!orderId || !trackedOrders.has(orderId)) return;

    // Synchronously advance any pending terminal target BEFORE the replay
    // enters the work queue. Otherwise a replay queued behind an in-flight
    // retry would update the target only after that retry has already
    // finalized the order with stale aggregates (the retry's await
    // resolves before the queued processOrderUpdate gets to run). This
    // window is the bug T63 flagged: between scheduleFilledRetry's timer
    // fire and retryFilledIngest's await completing, replays must still
    // be able to advance the in-flight target.
    //
    // For FILLED, also update averageFilledPrice/totalFees on equal-size
    // replays — the cumulative may match the original event but the
    // aggregates can be more complete on a post-reconnect replay (the
    // original may have arrived before the WS-side aggregation finalized).
    // Truthy guard on both fields: websocket-feed normalizes a missing
    // total_fees to 0, so a `!= null` check would let placeholder zeros
    // overwrite a previously-correct nonzero fee total. Real terminal
    // events for executed fills always carry positive aggregates.
    if (status === 'FILLED' || status === 'CANCELLED' || status === 'FAILED') {
      const target = pendingTerminalRetries.get(orderId);
      if (target) {
        if (filledSize > target.filledSize) target.filledSize = filledSize;
        if (status === 'FILLED') {
          if (averageFilledPrice) target.averageFilledPrice = averageFilledPrice;
          if (totalFees) target.totalFees = totalFees;
        }
      }
    }

    return enqueueOrderWork(orderId, () => processOrderUpdate(data));
  };

  const processOrderUpdate = async (data) => {
    if (timerTracker.isStopped()) return;
    const { orderId, status, filledSize, averageFilledPrice, totalFees } = data;
    if (!trackedOrders.has(orderId)) return;

    const trackedOrder = trackedOrders.get(orderId);

    // Skip replayed terminal events for orders we've already settled.
    // Without this an already-finalized FILLED would re-fire
    // onOrderFillCallback (the engine would see the same fill twice),
    // and an already-settled CANCELLED would schedule another untrack
    // timer.
    //
    // BUT: settleCancelledOrder flips trackedOrder.status to 'cancelled'/
    // 'failed' on attempt 0 to suppress the phantom open row during the
    // retry window. Without the pendingTerminalRetries check, this guard
    // would block replayed CANCELLED events from reaching the cancel
    // branch — so a larger replayed cumulative would never advance the
    // mutable target the in-flight retry chain reads. The retry could
    // settle short of the real cancelled quantity. Same for FILLED via
    // the partial-retry pendingPartialRetries.
    const inRetryChain = pendingTerminalRetries.has(orderId) || pendingPartialRetries.has(orderId);
    if (!inRetryChain && (trackedOrder.status === 'filled' || trackedOrder.status === 'cancelled' || trackedOrder.status === 'failed')) {
      return;
    }

    const ingestDeps = { adapter: getActiveAdapter(), fillLedger, exchange, isStopped: timerTracker.isStopped };

    // Non-terminal partial-fill ingest. Coinbase keeps status='OPEN' while
    // delivering incremental filledSize updates; without this path, a
    // partial fill that occurs while the engine is stopped would never
    // reach the ledger until the terminal FILLED event arrives — and if
    // the order is later cancelled without fully filling, the partial fill
    // would be lost entirely. Position-state updates remain the engine's
    // responsibility (we don't fire onOrderFillCallback here); we only
    // patch the ledger gap. ingestFill is idempotent on tradeId, so the
    // FILLED branch re-running this work is safe.
    if (status !== 'FILLED' && status !== 'CANCELLED' && status !== 'FAILED') {
      if (filledSize > (trackedOrder.lastIngestedFilledSize || 0)) {
        const result = await ingestNewFillsForOrder(ingestDeps, orderId, trackedOrder, filledSize, 'partial fill');
        if (timerTracker.isStopped()) return;
        // Schedule a bounded retry whenever the ledger doesn't yet cover
        // the WS cumulative. That includes both adapter/persist failures
        // (fetched=false) and the Gemini/Crypto.com case where fetched=
        // true but getOrderFills' recent-trade synthesis returned only
        // a subset. Open orders can stay open for hours without emitting
        // another WS event, so without this an executed partial would
        // sit unrecorded until cancel/FILLED catch-up.
        if (filledSize > (trackedOrder.lastIngestedFilledSize || 0)) {
          const reason = result.fetched ? 'ledger short of cumulative' : 'fetch/persist failed';
          schedulePartialRetry(orderId, trackedOrder, filledSize, 1, reason);
        }
      }
      return;
    }

    if (status === 'FILLED') {
      const baseCurr = getBaseCurrency(productId);
      console.log(`✅ [${exchange}] Tracked order ${orderId} FILLED: ${filledSize} ${baseCurr} @ $${averageFilledPrice}`);

      // Always go through the catch-up path. If partial-fill ingestion
      // already covered the watermark, ingestNewFillsForOrder early-returns
      // without an adapter call (no wasted I/O) — but pre-populating the
      // target gives the synchronous prelude a place to update aggregates
      // when a post-reconnect replay arrives with corrected price/fees.
      // Without this unification, the watermark-covered case would skip
      // target creation entirely and drop replays via the settled-status
      // guard.
      let target = pendingTerminalRetries.get(orderId);
      if (!target) {
        pendingPartialRetries.delete(orderId);
        target = { filledSize, averageFilledPrice, totalFees, timerScheduled: false };
        pendingTerminalRetries.set(orderId, target);
      }

      const result = await ingestNewFillsForOrder(ingestDeps, orderId, trackedOrder, target.filledSize, 'FILLED');
      if (timerTracker.isStopped()) return;

      // FILLED is terminal — Coinbase is not guaranteed to emit follow-
      // up WS events, so we cannot wait for "the next event" to retry.
      // Schedule a retry chain whenever the ledger doesn't yet cover
      // the WS-reported cumulative filledSize: that includes adapter/
      // persist failures (fetched=false) and the Gemini/Crypto.com
      // partial-history case where we ingested some fills but not all.
      // The retry re-enters via enqueueOrderWork so it serializes
      // against any later updates for the same order. Service stop
      // cancels these timers via timerTracker.cancelAll().
      if (!result.fetched) {
        scheduleFilledRetry(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees, 1, 'fetch/persist failed');
        return;
      }
      if ((trackedOrder.lastIngestedFilledSize || 0) < target.filledSize) {
        const reason = result.fillsCount === 0 ? 'has no fills yet' : 'ledger short of cumulative';
        scheduleFilledRetry(orderId, trackedOrder, target.filledSize, target.averageFilledPrice, target.totalFees, 1, reason);
        return;
      }
      // Finalize with the target's latest aggregates — replays during the
      // await may have advanced filledSize / averageFilledPrice / totalFees,
      // and the engine callback must see those, not the stale captures
      // from when this handler entered.
      const finalSize = target.filledSize;
      const finalPrice = target.averageFilledPrice;
      const finalFees = target.totalFees;
      // Drop the placeholder entry synchronously so a race-arriving replay
      // can't see a stale entry. finalizeFilledOrder also clears via
      // clearPendingRetry on its 60s untrack TTL.
      pendingTerminalRetries.delete(orderId);
      finalizeFilledOrder(orderId, trackedOrder, finalSize, finalPrice, finalFees);
    } else if (status === 'CANCELLED' || status === 'FAILED') {
      // CANCELLED/FAILED replay on an order with an existing
      // pendingTerminalRetries entry. Restart the chain via
      // startCancelCatchup whenever the WS-reported cumulative is ahead
      // of the ledger watermark, regardless of whether the prior chain
      // had settled or is still in flight:
      //
      //   - settled chain: a later replay reports more fills than the
      //     prior settle covered. Adapters that synthesize getOrderFills
      //     from recent-trade queries (Gemini, Crypto.com) can return
      //     only a partial set on the first cancel; restart fetches the
      //     missing partials before the untrack TTL clears the entry.
      //   - chain in flight: the existing chain's retry timer may be
      //     sitting on a long stale backoff (e.g., 5min cap). Restart
      //     cancels that stale timer (via startCancelCatchup's prelude)
      //     and reissues at attempt=0 so the fresh exchange data is
      //     processed promptly. On adapters with aging recent-trade
      //     windows, waiting on the stale backoff can push the missing
      //     fills out of the window and make catch-up unrecoverable.
      //
      // Compare filledSize against trackedOrder.lastIngestedFilledSize
      // (the actual ledger watermark) — NOT existingTarget.filledSize.
      // The prelude may have advanced target.filledSize during a prior
      // in-flight chain that ended up settling at a smaller cumulative
      // (the chain's attempt-0 path uses the call-time parameter, not
      // target.filledSize). Comparing against the watermark detects the
      // ledger gap that a restart needs to fill.
      const existingTarget = pendingTerminalRetries.get(orderId);
      if (existingTarget) {
        if (filledSize > (trackedOrder.lastIngestedFilledSize || 0)) {
          existingTarget.filledSize = filledSize;
          existingTarget.settled = false;
          await startCancelCatchup(orderId, trackedOrder, status, filledSize, existingTarget);
        }
        return;
      }
      // Preempt any pending partial retry — terminal owns catch-up.
      pendingPartialRetries.delete(orderId);
      // Pre-populate the pending entry BEFORE awaiting settleCancelledOrder.
      // settleCancelledOrder flips trackedOrder.status to 'cancelled' on
      // attempt 0 before its first await, so a replayed CANCELLED arriving
      // during that await would otherwise see status='cancelled' AND no
      // pendingTerminalRetries entry, hit the settled-status guard, and
      // be dropped — even if it carried a larger cumulative.
      const target = { filledSize };
      pendingTerminalRetries.set(orderId, target);
      await startCancelCatchup(orderId, trackedOrder, status, filledSize, target);
      // Don't delete the entry here. startCancelCatchup wraps markSettled
      // to flip target.settled when the chain finishes (synchronous or via
      // a scheduleTimeout retry). The entry stays alive so a later replay
      // with a larger cumulative can detect the gap above and restart
      // catch-up. The 60s untrack TTL fires clearPendingRetry to drop it.
    }
  };

  /**
   * Update volatility metrics via REST API
   */
  const updateMetrics = async (adapter, productId) => {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    let candles1m, candles5m;

    const [result1m, result5m] = await Promise.allSettled([
      adapter.getCandles(productId, oneHourAgo, now, 'ONE_MINUTE'),
      adapter.getCandles(productId, fourHoursAgo, now, 'FIVE_MINUTE'),
    ]);

    if (result1m.status === 'fulfilled' && result1m.value?.candles) {
      candles1m = result1m.value.candles;
    }
    if (result5m.status === 'fulfilled' && result5m.value?.candles) {
      candles5m = result5m.value.candles;
    }

    if (candles1m?.length > 0 || candles5m?.length > 0) {
      const metrics = calculateAllMetrics(candles1m || [], candles5m || [], marketState.lastPrice);

      marketState.atr1m = metrics.atr1m;
      marketState.atr5m = metrics.atr5m;
      marketState.realizedVol = metrics.realizedVol;
      marketState.volBaseline = metrics.volBaseline;
      marketState.vwap = metrics.vwap;
      marketState.vwapDistance = metrics.vwapDistance;
      marketState.recentSwing = metrics.recentSwing;
    }
  };

  /**
   * Stop the market data service
   */
  const stop = () => {
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
      metricsUpdateInterval = null;
    }

    if (wsFeed) {
      wsFeed.disconnect();
      wsFeed = null;
    }

    // Cancel any pending cancel-retry / untrack timers so they can't fire
    // against this service's now-stale fillLedger after a replacement
    // service has taken over and overwrite its writes.
    timerTracker.cancelAll();

    isConnected = false;
    console.log(`📊 [${exchange}] Market data service stopped`);
  };

  /**
   * Compute trade flow imbalance for a given time window
   * @param {number} windowMs - Window size in milliseconds
   * @returns {{ buyVolume: number, sellVolume: number, imbalance: number, tradeCount: number }}
   */
  const computeTradeFlow = (windowMs) => {
    const cutoff = Date.now() - windowMs
    let buyVolume = 0
    let sellVolume = 0
    let tradeCount = 0

    for (let i = tradeFlowWindow.length - 1; i >= 0; i--) {
      const t = tradeFlowWindow[i]
      if (t.timestamp < cutoff) break
      if (t.side === 'buy') buyVolume += t.size
      else sellVolume += t.size
      tradeCount++
    }

    const total = buyVolume + sellVolume
    const imbalance = total > 0 ? (buyVolume - sellVolume) / total : 0
    return { buyVolume, sellVolume, imbalance, tradeCount }
  }

  /**
   * Get current market state
   */
  const getMarketState = () => {
    const flow60 = computeTradeFlow(60_000)
    const flow300 = computeTradeFlow(300_000)

    return {
      ...marketState,
      connected: isConnected,
      tradeFlow: {
        imbalance60s: flow60.imbalance,
        imbalance300s: flow300.imbalance,
        buyVolume60s: flow60.buyVolume,
        sellVolume60s: flow60.sellVolume,
        tradeCount60s: flow60.tradeCount,
        updatedAt: Date.now(),
      },
    }
  };

  /**
   * Get current regime state
   */
  const getRegimeState = () => ({
    ...regimeState,
  });

  /**
   * Get full status
   */
  const getStatus = () => ({
    connected: isConnected,
    market: getMarketState(),
    regime: getRegimeState(),
    openOrders: getOpenOrders(),
  });

  /**
   * Get tracked open orders
   */
  const getOpenOrders = () => {
    const orders = [];
    for (const [orderId, order] of trackedOrders) {
      if (order.status === 'open') {
        orders.push({
          orderId,
          ...order,
        });
      }
    }
    return orders;
  };

  /**
   * Look up a tracked order's status without filtering on 'open'. Returns
   * the status string ('open' / 'filled' / 'cancelled' / etc.) or null if
   * the order isn't tracked at all. Used by stopped-engine status
   * synthesizers to drop persisted TPs that the WS feed has already
   * confirmed are no longer open. Consults settledOrderIds so the
   * filter still works after the 60s trackedOrders cleanup fires.
   */
  const getOrderStatus = (orderId) => {
    const o = trackedOrders.get(orderId);
    if (o) return o.status;
    if (settledOrderIds.has(orderId)) return 'settled';
    return null;
  };

  /**
   * Add an order to track
   */
  const trackOrder = (orderId, orderInfo) => {
    trackedOrders.set(orderId, {
      ...orderInfo,
      status: 'open',
    });
  };

  /**
   * Remove a tracked order
   */
  const untrackOrder = (orderId) => {
    trackedOrders.delete(orderId);
  };

  /**
   * Set callback for order fills
   */
  const setOnOrderFill = (callback) => {
    onOrderFillCallback = callback;
  };

  /**
   * Set callback for status updates (used by Socket.IO + chart buffer)
   */
  const setOnStatusUpdate = (callback) => {
    onStatusUpdateCallback = callback;
  };

  return {
    start,
    stop,
    getMarketState,
    getRegimeState,
    getStatus,
    isConnected: () => isConnected,
    getOpenOrders,
    getOrderStatus,
    trackOrder,
    untrackOrder,
    setOnOrderFill,
    setOnStatusUpdate,
    // Test hooks. Expose enough surface to drive processOrderUpdate
    // through a real factory instance without spinning up the WS feed.
    _test: {
      handleOrderUpdate,
      injectFillLedger: (ledger) => { fillLedger = ledger; },
      injectProductId: (id) => { productId = id; },
      injectAdapter: (a) => { _adapterOverride = a; },
      pendingTerminalRetries,
      pendingPartialRetries,
      timerTracker,
    },
  };
};

/**
 * Start market data service for a fund (exchange + pair).
 * @param {string} exchange
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 */
const startMarketDataService = async (exchange, pair) => {
  // Only supported for certain exchanges
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return { success: false, error: `Market data service not supported for ${exchange}` };
  }

  const key = serviceKey(exchange, pair);
  if (marketDataServices.has(key)) {
    return { success: true, message: 'Already running' };
  }

  const service = createMarketDataService(exchange, pair);
  const result = await service.start();

  if (result.success) {
    marketDataServices.set(key, service);
  }

  return result;
};

/**
 * Stop market data service for a fund (exchange + pair).
 */
const stopMarketDataService = (exchange, pair) => {
  const key = serviceKey(exchange, pair);
  const service = marketDataServices.get(key);
  if (service) {
    service.stop();
    marketDataServices.delete(key);
  }
};

/**
 * Get market data service for a fund (exchange + pair).
 */
const getMarketDataService = (exchange, pair) => {
  return marketDataServices.get(serviceKey(exchange, pair));
};

/**
 * Stop all market data services
 */
const stopAllMarketDataServices = () => {
  for (const [, service] of marketDataServices) {
    service.stop();
  }
  marketDataServices.clear();
};

module.exports = {
  createMarketDataService,
  startMarketDataService,
  stopMarketDataService,
  getMarketDataService,
  stopAllMarketDataServices,
  ingestNewFillsForOrder,
  settleCancelledOrder,
  createTimerTracker,
  createWorkQueue,
};
