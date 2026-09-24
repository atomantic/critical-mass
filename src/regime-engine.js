// @ts-check
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
const { createFillLedger, LEGACY_CONSUMPTION_KEY } = require('./fill-ledger');
const { createClosedTrades } = require('./closed-trades');
const {
  createHealthMonitor,
  instrumentAdapterForHealth,
  isPersistenceOnlySafeReason,
  MAX_CONSECUTIVE_PERSISTENCE_FAILURES,
} = require('./health-monitor');
const { createTailEventsMonitor } = require('./tail-events');
const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { createPositionSizer } = require('./position-sizer');
const { createRiskManager, computeFundEquity } = require('./risk-manager');
const { createOrderExecutor } = require('./order-executor');
const { classifyBodyTpCancellation } = require('./cancellation-result');
const { createDryRunExecutor } = require('./dry-run-executor');
const { validateExecutor } = require('./executor-contract');
const { createRecoveryModule } = require('./recovery');
const { createTpOptimizer } = require('./tp-optimizer');
const { createSizeOptimizer } = require('./size-optimizer');
const { createLadderCalculator } = require('./ladder-calculator');
const { applyMarketMetrics, clamp, computeAdaptiveStaleMs, roundAsset, roundUSDC, roundPrice } = require('./volatility-utils');
const { createMacroRegime } = require('./macro-regime');
const { calculateApyMetrics: _calculateApyMetrics, initializeApyTracking: _initializeApyTracking } = require('./apy-calculator');
const { tradeEvents } = require('./trade-events');
const dryRunState = require('./dry-run-state');
const {
  loadRegimeState,
  saveRegimeState,
  LIFECYCLE,
  createInitialRegimePositionState,
  getBlockingPlacementIntents,
  describePlacementIntents,
  isBlockingPlacementIntent,
  resolvePlacementIntent,
} = require('./state-tracker');
const { resolveFundDataDir } = require('./migration');
const celestialHierarchy = require('./celestial-hierarchy');
const { fmtCurrency: fmtPrice, isFilledStatus, isCancelledStatus, isTerminalStatus, isOrderNotFoundError, isOrderStillOpen, floorToIncrement } = require('./shared-utils');
const { createContextLogger } = require('./logger');
const { createEngineLocks } = require('./engine-locks');

/** Interval between periodic metrics/regime-classification updates (ms) */
const METRICS_INTERVAL_MS = 60000;
// How often a fund that is blocked by an unresolved placement intent repeats
// the reason in its log (the guard itself is evaluated on every tick).
const PLACEMENT_BLOCK_LOG_INTERVAL_MS = 60_000;
// How long the engine-side intent check may be reused between ticker messages.
const PLACEMENT_INTENT_CACHE_MS = 1_000;

/**
 * Position fields a SIGUSR1 reload is allowed to take from disk. Everything
 * else (open orders, bodies, cycle bookkeeping) is owned by the running engine
 * and would be unsafe to overwrite from an operator's hand edit.
 */
const RELOADABLE_STATE_FIELDS = Object.freeze(['realizedPnL', 'realizedAssetPnL', 'celestialState']);

/**
 * Freeze a partial sell before changing its body. A cancel acknowledgement is
 * not terminal evidence: query status and cross-check the open-order snapshot.
 * Unknown outcomes retain the original identity for reconciliation/restart.
 */
const cancelPartialFillOrder = async (deps, orderId) => {
  const { adapter, exchange, pair, log = createContextLogger({ exchange, pair }).warn } = deps;
  let error;
  try {
    await adapter.cancelOrder(orderId);
  } catch (err) {
    error = err;
  }
  try {
    const order = await adapter.getOrder(orderId);
    if (isTerminalStatus(order)) {
      const openOrders = await adapter.getOpenOrders(pair);
      if (Array.isArray(openOrders) && !isOrderStillOpen(openOrders, orderId)) {
        return { cancelled: true, order };
      }
    }
  } catch (err) {
    error = err;
  }
  log(`⚠️ [${exchange}] Partial TP ${orderId} is not confirmed terminal — retaining tracking for reconciliation`,
    { orderId, orderType: 'body_tp' });
  return { cancelled: false, ...(error ? { error } : {}) };
};

/**
 * Shape an adapter `getOrder` result into the `fillData` payload that
 * `handleOrderFill` consumes. Centralizes parseFloat coercion of numeric
 * fields so every catch-up site treats missing/string values identically.
 * Defaults `isPartialFill: true` since every caller in this file uses it
 * for catch-up routes; pass `{ isPartialFill: false }` (or `placedAt`,
 * `status`) via extras to override.
 * @param {string} orderId
 * @param {'buy'|'sell'} side
 * @param {{status: string, filledSize?: number|string, filledValue?: number|string, averageFilledPrice?: number|string}} orderStatus
 * @param {Object} [extras] Field overrides merged onto the result
 * @returns {Object} fillData for handleOrderFill
 */
const buildPartialFillData = (orderId, side, orderStatus, extras = {}) => ({
  orderId,
  side,
  status: orderStatus.status,
  filledSize: parseFloat(orderStatus.filledSize || 0),
  filledValue: parseFloat(orderStatus.filledValue || 0),
  averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
  isPartialFill: true,
  ...extras,
});

/**
 * Build the shared in-memory dedup key used by WS and polling fill callbacks.
 * Partial fills are keyed by cumulative size so each advance is processed once;
 * terminal fills remain keyed by order ID.
 * @param {string} orderId
 * @param {boolean} isPartialFill
 * @param {number} [filledSize]
 * @returns {string}
 */
const makeFillDedupKey = (orderId, isPartialFill, filledSize = 0) =>
  isPartialFill ? `${orderId}:${(filledSize || 0).toFixed(8)}` : orderId;

/**
 * Decide how much USDC an entry can actually spend, given the requested size,
 * the real available wallet balance, and the minimum order size.
 *
 * The risk-manager usdc-cap check only compares deployed cost basis against
 * maxUsdcDeployed — it does NOT know the real wallet balance. Without this,
 * a cap set far above funded capital makes the engine keep firing entries the
 * exchange rejects with "Insufficient balance in source account" every cycle.
 *
 * Pure function (no I/O) so the trim/skip/cooldown branches are unit-testable.
 *
 * @param {number} requestedUsdc - Desired order size in USDC
 * @param {number|null} availableQuote - Real available quote balance, or null if it couldn't be fetched
 * @param {number} minSize - Minimum order size in USDC
 * @returns {{action: 'place'|'skip'|'cooldown', sizeUsdc?: number}}
 *   - 'place': proceed with sizeUsdc (possibly trimmed to the wallet balance)
 *   - 'skip': balance unverifiable — skip this entry without arming the cooldown
 *   - 'cooldown': wallet can't fund even the minimum — arm the insufficient-funds cooldown
 */
const resolveEntryBudget = (requestedUsdc, availableQuote, minSize) => {
  if (availableQuote == null) return { action: 'skip' };
  if (availableQuote >= requestedUsdc) return { action: 'place', sizeUsdc: requestedUsdc };
  if (availableQuote >= minSize) {
    // Floor (don't round) to the cent so the trimmed size never exceeds the real
    // balance — Math.round could push it back above the wallet and re-trigger the
    // very rejection this trim prevents.
    return { action: 'place', sizeUsdc: Math.floor(availableQuote * 100) / 100 };
  }
  return { action: 'cooldown' };
};

/**
 * True when some celestial body already lists `orderId` among its constituent
 * buy orders — i.e. a prior handleOrderFill attempt already committed this buy
 * (issue #131). Used to make the buy-fill branch idempotent against a retry
 * that re-enters after the dedup key was cleared on a post-commit throw.
 * @param {Array<{sourceOrderIds?: string[], buyOrders?: Array<{orderId: string}>}>} bodies
 * @param {string} orderId
 * @returns {boolean}
 */
const isBuyAlreadyCommitted = (bodies, orderId) =>
  (bodies || []).some(b =>
    (b.sourceOrderIds || []).includes(orderId) ||
    (b.buyOrders || []).some(bo => bo.orderId === orderId)
  );

/**
 * A buy fill row that no body ever booked: it carries none of the order-level
 * annotations a body writes. Only meaningful for an order no live body owns —
 * annotation repair and TP placement stamp EVERY row of an owned order, so a
 * booked-looking row of an owned order can still be unbooked (issue #756).
 * @param {Object} f - Fill ledger row
 * @returns {boolean}
 */
const isUnsettledBuyRow = (f) => f.side === 'buy' && !(f.bodyId || f.isBodyOwned || f.isSatellite || f.sellOrderId);

/**
 * How much of a buy order the live bodies' tranches fail to account for
 * (issue #756). A body records every tranche it books from an order as a
 * `buyOrders` entry, and a sale never shrinks that entry (it advances its
 * `consumedQty`), so the order's ledger size should equal what live tranches
 * hold plus what bodies that are gone consumed. The latter is only known
 * from #607 consumption records: the part of `ledger.consumedQty` live
 * tranches do not explain. Anything left over is ledger quantity no body
 * represents.
 *
 * Before #607 a sold-and-closed body left no such record, so for an order
 * split across a closed body and a live one this over-reads the shortfall —
 * callers must bound it with independent evidence before booking anything.
 * @param {Array<Object>} bodies - positionState.celestialBodies
 * @param {string} orderId - Buy order id
 * @param {{size: number, consumedQty?: number, consumedCostFraction?: number}} ledger - fillLedger.getBuyOrderConsumption(orderId)
 * @returns {{owned: boolean, measurable: boolean, trancheQty: number, trancheCost: number, shortfall: number}}
 *   `measurable` is false when a body references the order through something
 *   without a quantity (a tranche with no assetQty, or a sourceOrderId with
 *   no tranche) — its share is then unknown.
 */
const measureUnbookedOrderQty = (bodies, orderId, ledger) => {
  const legacyFraction = Math.min(Math.max(Number(ledger?.consumedCostFraction) || 0, 0), 1);
  let owned = false;
  let measurable = true;
  let trancheQty = 0;
  let trancheCost = 0;
  let trancheConsumed = 0;
  const seen = new Set();
  for (const body of (bodies || [])) {
    let measured = false;
    for (const entry of (body.buyOrders || [])) {
      if (!entry || entry.orderId !== orderId || seen.has(entry)) continue;
      seen.add(entry);
      owned = true;
      const size = Number(entry.assetQty) || 0;
      if (!(size > 0)) { measurable = false; continue; }
      measured = true;
      trancheQty += size;
      trancheCost += Number(entry.sizeUsdc) || 0;
      trancheConsumed += Number.isFinite(entry.consumedQty)
        ? Math.min(Math.max(entry.consumedQty, 0), size)
        : size * legacyFraction;
    }
    if ((body.sourceOrderIds || []).includes(orderId)) {
      owned = true;
      if (!measured) measurable = false;
    }
  }
  const consumedElsewhere = Math.max(0, (Number(ledger?.consumedQty) || 0) - trancheConsumed);
  const shortfall = (Number(ledger?.size) || 0) - trancheQty - consumedElsewhere;
  return { owned, measurable, trancheQty, trancheCost, shortfall };
};

/**
 * Pure predicate: did a body TP execute its whole PLANNED size? A TP is placed
 * for `body.assetOnOrder` (body.assetQty minus the designed holdback), so a
 * fill that covers ≥99% of it is a completed TP — its body closes and the
 * holdback is booked as reserves — even when the order was later reported
 * CANCELLED (the cancel-after-full-fill race). Mirrors the sell handler's own
 * isPartial check, including its legacy fallback for bodies with no recorded
 * assetOnOrder (issues #670, #744).
 * @param {{assetOnOrder?: number, assetQty?: number}|null|undefined} body
 * @param {number} filledSize - Cumulative size the TP executed
 * @returns {boolean}
 */
const isFullTpExecution = (body, filledSize) => {
  if (!body || !(filledSize > 0)) return false;
  const onOrder = body.assetOnOrder || 0;
  return onOrder > 0
    ? filledSize >= onOrder * 0.99
    : body.assetQty > 0 && filledSize / body.assetQty >= 0.95;
};

/**
 * Split a body TP's net holdback (`body.assetQty − sold`) into what the sale
 * adds to reserves and what it draws out of them (issue #770).
 *
 * A healthy TP sells `assetOnOrder < assetQty`, and the rest is booked as
 * zero-cost reserves. A stale TP sized for a larger, pre-deduction body can
 * sell MORE than the body still holds (the #744 merge-snapshot oversell). The
 * extra asset came out of the account's reserves: bodyPnl already charges the
 * whole remaining body cost against the full proceeds, so that asset's
 * proceeds are in realized USD at zero cost, and reserves must shrink by the
 * same quantity or it counts twice (as USD and as reserves still held).
 *
 * The drawdown is recorded as its own non-negative quantity rather than as a
 * negative holdback: the cycle pairing clamps negative holdback annotations
 * (legacy corrupt rows), and the startup annotation repair re-pairs any sell
 * carrying one. `bodyReservesSoldAsset` is subtracted from realizedAssetPnL
 * by shared/cycle-pairing.mjs.
 * @param {number} netHoldback - body.assetQty − sold qty, already rounded
 * @returns {{holdbackAsset: number, reservesSoldAsset: number}} both ≥ 0
 */
const splitTpHoldback = (netHoldback) => ({
  holdbackAsset: netHoldback > 0 ? netHoldback : 0,
  reservesSoldAsset: netHoldback < 0 ? -netHoldback : 0,
});

/**
 * Drop a persisted `pendingTpCancelExecution` marker once the body's TP has
 * moved off the order it was recorded for (issue #744). The marker is only
 * ever honoured while `body.tpOrderId === marker.orderId` (see
 * knownTpCancelExecution), and order ids are never reused, so after the TP
 * moves (booked through a plain status branch, re-placed, cleared) it is dead
 * state that would otherwise ride along in every save forever.
 * @param {Array<Object>|null|undefined} bodies
 * @returns {number} How many markers were dropped
 */
const pruneStaleTpCancelMarkers = (bodies) => {
  let pruned = 0;
  for (const body of bodies || []) {
    const marker = body && body.pendingTpCancelExecution;
    if (marker && marker.orderId !== body.tpOrderId) {
      delete body.pendingTpCancelExecution;
      pruned += 1;
    }
  }
  return pruned;
};

/**
 * Pure predicate: is this body stranded sub-min "dust"? — it has a positive qty,
 * no resting TP order, AND its entire qty rounds below the exchange minimum order
 * size, so a TP can never be placed for it on its own. Such a body must be
 * consolidated into another body to recover its value (issue #189).
 *
 * The `assetQty > 0` guard excludes empty/zero bodies (a zero body isn't value to
 * recover and must not trigger a merge that churns a healthy neighbour's TP); a
 * tiny-but-positive qty that rounds to 0 IS dust and should be consolidated.
 * @param {Object} body - Celestial body
 * @param {number} baseMinSize - Exchange minimum order size (base asset)
 * @param {number} baseIncrement - Exchange base-size increment for rounding
 * @returns {boolean}
 */
const isStrandedDustBody = (body, baseMinSize, baseIncrement) => {
  if (!body || body.tpOrderId || !(body.assetQty > 0)) return false;
  const inc = baseIncrement || 0.00000001;
  // floorToIncrement (epsilon-safe), NOT a naive Math.floor(qty/inc)*inc: for a
  // decimal increment like 0.01, float error under-floors exact multiples (0.29
  // → 0.28), which would misclassify a body sitting exactly at baseMinSize as
  // dust and wrongly merge a sellable body (codex review #195).
  const roundedFullQty = floorToIncrement(roundAsset(body.assetQty), inc);
  return roundedFullQty < baseMinSize;
};

/**
 * Freeze a body for the Race-3 merge-snapshot maps. Scalars are copied by the
 * spread; `buyOrders` gets its own array so a buy folded onto the live body
 * after the snapshot is not counted among the tranches the snapshot's TP
 * covered (issue #607). The tranche objects stay shared with the live body.
 * @param {Object} body
 * @returns {Object}
 */
const snapshotBody = (body) => ({ ...body, buyOrders: [...(body.buyOrders || [])] });

/**
 * Decide whether a buy-fill handling pass is a RETRY that must be skipped to
 * avoid double-counting (issue #131), vs. a legitimate new tranche (including an
 * advancing partial) that must process. The distinguishing signal is whether
 * any NEW fill rows were ingested this pass: ingestFill dedups by tradeId, so a
 * pure retry ingests nothing (ingestedCount === 0) and re-aggregates the full
 * order, whereas a real new/advancing fill brings new rows (ingestedCount > 0)
 * and must NOT be dropped even though a body already owns the orderId.
 * @param {number} ingestedCount - number of NEW fills ingested this pass
 * @param {Array} bodies - positionState.celestialBodies
 * @param {string} orderId
 * @returns {boolean} true → skip (retry after a body already committed)
 */
const shouldSkipBuyRecommit = (ingestedCount, bodies, orderId) =>
  ingestedCount === 0 && isBuyAlreadyCommitted(bodies, orderId);

/**
 * Build the dashboard pendingOrders payload: enrich the executor's tracked
 * orders with body/cost-basis metadata, then union any body TPs the executor
 * doesn't track in-memory (after engine stop, or pre-reconcile after start).
 */
const buildPendingOrders = (executorOrders, positionState) => {
  const bodies = positionState.celestialBodies || [];
  const enriched = executorOrders.map(order => {
    if (order.type === 'take_profit') {
      const body = bodies.find(b => b.tpOrderId === order.orderId);
      if (body) {
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        return {
          ...order,
          type: 'body_tp',
          tpPercent: body.avgPrice > 0 ? ((order.price - body.avgPrice) / body.avgPrice * 100).toFixed(2) : null,
          bodyId: body.id,
          bodyTier: body.tier,
          tierEmoji: tierCfg?.emoji || '🛰️',
          bodyAvgCost: body.avgPrice,
          bodyBtcQty: body.assetQty,
          bodyCostBasis: body.costBasis,
        };
      }
      if (positionState.avgCostBasis > 0) {
        return {
          ...order,
          tpPercent: ((order.price - positionState.avgCostBasis) / positionState.avgCostBasis * 100).toFixed(2),
        };
      }
      return order;
    }
    if (order.type === 'body_tp' || order.type === 'satellite_tp') {
      const body = bodies.find(b => b.tpOrderId === order.orderId);
      const avgPrice = body ? body.avgPrice : 0;
      const tierCfg = body ? celestialHierarchy.getTierConfig(body.tier) : null;
      return {
        ...order,
        tpPercent: avgPrice > 0 ? ((order.price - avgPrice) / avgPrice * 100).toFixed(2) : null,
        bodyId: body?.id || null,
        bodyTier: body?.tier || null,
        tierEmoji: tierCfg?.emoji || '🛰️',
        bodyAvgCost: avgPrice,
        bodyBtcQty: body?.assetQty ?? order.size,
        bodyCostBasis: body?.costBasis || 0,
      };
    }
    return order;
  });

  const known = new Set(enriched.map(o => o.orderId));
  for (const body of bodies) {
    if (!body.tpOrderId || known.has(body.tpOrderId)) continue;
    enriched.push(celestialHierarchy.buildBodyTpOrder(body));
  }
  return enriched;
};

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

/**
 * Restore the operator-selected cycle boundary before recovery rebuilds the
 * position from fills. Older state files omit this marker and deliberately
 * fall back to the fill-ledger heuristic.
 * @param {Object} fillLedger
 * @param {RegimePositionState} positionState
 * @param {Object} logger
 * @param {string} exchange
 * @returns {boolean} Whether a valid persisted cycle ID was applied
 */
const restorePersistedCycleId = (fillLedger, positionState, logger, exchange) => {
  const persistedCycleId = positionState?.activeCycleId;
  if (typeof persistedCycleId !== 'string' || !/^cycle-\d+$/.test(persistedCycleId)) {
    return false;
  }

  const previousCycleId = fillLedger.getCurrentCycleId();
  if (previousCycleId !== persistedCycleId) {
    logger.info(`🔄 [${exchange}] Restoring persisted active cycle: ${persistedCycleId}`, {
      previousCycleId,
      cycleId: persistedCycleId,
    });
  }
  // Carry the persisted start time (#705) so recalculateCycles has a live-
  // cycle boundary even while the post-reset cycle holds no fills yet.
  fillLedger.setCurrentCycleId(persistedCycleId, positionState.activeCycleStartedAt ?? null);
  return true;
};

/**
 * Repair historical fill annotations from ledger.
 * Performs four steps of self-healing for fills that predate annotation code:
 * 1. Recover orphan buys (unfilled bodies) by merging into historical bodies
 * 2. Annotate buy fills for active celestial bodies
 * 3. Match unannotated body sells to buys using 1% size fuzzy-match
 * 4. Rewrite -recovered- cycle IDs to current cycle
 * @param {Object} deps - Helper dependencies
 * @param {Object} deps.fillLedger - Fill ledger instance
 * @param {Object} deps.positionState - Current position state
 * @param {Object} deps.config - Engine configuration
 * @param {Object} deps.logger - Logger instance
 * @param {string} deps.baseCurrency - Asset symbol (e.g., 'BTC')
 * @param {number} deps.priceIncrement - Min price increment for TP rounding
 * @param {string} deps.exchange - Exchange name for logging
 * @param {Object} deps.celestialHierarchy - Celestial body manager
 * @param {Function} deps.calculateDynamicTpPercent - TP % calculator
 * @param {Function} deps.roundPrice - Price rounding utility
 * @param {Function} deps.roundAsset - Asset qty rounding utility
 * @param {Function} deps.fmtPrice - Price formatting utility
 */
const repairHistoricalFillAnnotations = ({
  fillLedger, positionState, config, logger, baseCurrency, priceIncrement, exchange,
  celestialHierarchy, calculateDynamicTpPercent, roundPrice, roundAsset, fmtPrice
}) => {
  // Retroactively annotate body fills that are missing isBodyOwned flag
  // This fixes historical fills that were processed before annotation code was deployed
  const currentCycleId = fillLedger.getCurrentCycleId();
  if (currentCycleId) {
    const cycleFills = fillLedger.getCurrentCycleFills();
    const coreTpOrderId = positionState.activeTpOrderId;
    let annotatedCount = 0;

    // 0. Recover orphan buys: ledger fills from current cycle that have no
    // bodyId AND aren't referenced by any body. These come from
    // handleOrderFill being interrupted (e.g. SIGINT during pm2 restart)
    // between fillLedger.ingestFill and the body-merge/annotation step.
    // Merge each orphan order into the historically-eligible body whose TP
    // is closest to where the orphan's TP would have landed. The body's
    // reconcile loop will then detect the assetQty/assetOnOrder mismatch
    // on the next tick and cancel-replace the TP at the new size.
    const knownBuyOrderIds = new Set();
    for (const body of (positionState.celestialBodies || [])) {
      for (const oid of (body.sourceOrderIds || [])) knownBuyOrderIds.add(oid);
      for (const buy of (body.buyOrders || [])) if (buy.orderId) knownBuyOrderIds.add(buy.orderId);
    }
    // Fills recalculateCycles folded into this cycle purely by timestamp
    // (#705) are excluded: nothing links them to an engine order (sync-fills
    // re-imports manual trades too), so adopting one into a body would place
    // an automatic sell for it — manual review only (R2, pnl-architecture.md).
    const orphanBuyFills = cycleFills.filter(f =>
      f.side === 'buy' && !f.bodyId
      && f.cycleAttribution !== 'timeframe'
      && !String(f.tradeId).startsWith('dca-convert')
      && !knownBuyOrderIds.has(f.orderId)
    );
    const orphansByOrderId = new Map();
    for (const f of orphanBuyFills) {
      if (!orphansByOrderId.has(f.orderId)) orphansByOrderId.set(f.orderId, []);
      orphansByOrderId.get(f.orderId).push(f);
    }

    let recoveredCount = 0;
    for (const [orderId, fills] of orphansByOrderId) {
      const summary = fillLedger.aggregateFills(fills);
      const fillTime = Math.max(...fills.map(f => f.timestamp));
      const newBuy = {
        assetQty: summary.totalSize,
        costBasis: summary.totalValue + (summary.totalFees || 0),
        avgPrice: summary.avgPrice,
        buyOrderId: orderId,
      };
      const candidateTpPrice = roundPrice(summary.avgPrice * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

      // Restrict to bodies that existed at the orphan's fill time
      const eligibleBodies = (positionState.celestialBodies || []).filter(b => !b.createdAt || b.createdAt <= fillTime);
      let target = celestialHierarchy.findMergeTarget(
        eligibleBodies, newBuy, config.maxUsdcDeployed, candidateTpPrice,
        config.maxCelestialBodies || 10, 0, config.maxOpenOrders,
        config.mergeProximityScale ?? 1.0
      );
      // Fallback: closest tpPrice among historical-eligible bodies
      if (!target) {
        let bestDist = Infinity;
        for (const b of eligibleBodies) {
          if (!b.tpPrice || b.tpPrice <= 0) continue;
          const d = Math.abs(b.tpPrice - candidateTpPrice);
          if (d < bestDist) { bestDist = d; target = b; }
        }
      }
      if (!target) {
        logger.warn(`⚠️ [${exchange}] Orphan buy ${orderId.slice(0, 8)} (${summary.totalSize.toFixed(8)} ${baseCurrency}): no eligible body to merge into, leaving unattributed`);
        continue;
      }

      const merged = celestialHierarchy.mergeIntoBody(target, newBuy, config.maxUsdcDeployed, orderId, logger);
      // Overwrite mergeIntoBody's Date.now() lastMergedAt with the orphan's
      // actual fill time, and the appended buyOrder's filledAt likewise.
      merged.lastMergedAt = fillTime;
      if (merged.buyOrders && merged.buyOrders.length > 0) {
        merged.buyOrders[merged.buyOrders.length - 1].filledAt = fillTime;
      }

      const annotation = { isBodyOwned: true, bodyId: merged.id, bodyTier: merged.tier };
      if (merged.tpOrderId) annotation.sellOrderId = merged.tpOrderId;
      fillLedger.annotateFillsByOrderId(orderId, annotation);

      // A still-tracked entry (or ladder rung) shrinks by what was just booked
      // from it, as the live fill path does — its remainder is the evidence startup uses to
      // prove a later tranche unbooked (issue #756).
      for (const list of ['pendingEntryOrders', 'pendingLadderOrders']) {
        if (!positionState[list]?.some(e => e.orderId === orderId)) continue;
        positionState[list] = positionState[list].map(e => (e.orderId !== orderId ? e : {
          ...e,
          assetQty: Math.max(0, (Number(e.assetQty) || 0) - newBuy.assetQty),
          sizeUsdc: Math.max(0, (Number(e.sizeUsdc) || 0) - newBuy.costBasis),
        }));
      }

      const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
      logger.info(`🔧 [${exchange}] Recovered orphan buy ${orderId.slice(0, 8)} (${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}) → body ${merged.id.slice(-8)} ${tierCfg.emoji} ${merged.tier}`);
      recoveredCount++;
    }

    if (recoveredCount > 0) {
      celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      logger.info(`🔧 [${exchange}] Recovered ${recoveredCount} orphan buy order(s) into bodies; reconcile loop will re-place affected TPs`);
    }

    // 1. Annotate buy fills for active celestial bodies (use both sourceOrderIds and buyOrders)
    // Also fix fills that have isBodyOwned but are missing bodyId (e.g. from DCA merge converter)
    for (const body of (positionState.celestialBodies || [])) {
      const annotation = { isBodyOwned: true, bodyId: body.id, bodyTier: body.tier };
      if (body.tpOrderId) annotation.sellOrderId = body.tpOrderId;
      const seen = new Set();
      for (const srcOrderId of (body.sourceOrderIds || [])) {
        const buyFills = cycleFills.filter(f => f.orderId === srcOrderId && !(f.isSatellite) && (!f.isBodyOwned || !f.bodyId));
        if (buyFills.length > 0) {
          fillLedger.annotateFillsByOrderId(srcOrderId, annotation);
          annotatedCount += buyFills.length;
        }
        seen.add(srcOrderId);
      }
      for (const buyOrder of (body.buyOrders || [])) {
        if (buyOrder.orderId === 'core-migration' || seen.has(buyOrder.orderId)) continue;
        const buyFills = cycleFills.filter(f => f.orderId === buyOrder.orderId && !(f.isSatellite) && (!f.isBodyOwned || !f.bodyId));
        if (buyFills.length > 0) {
          fillLedger.annotateFillsByOrderId(buyOrder.orderId, annotation);
          annotatedCount += buyFills.length;
        }
      }
    }

    // 2. Find unannotated or badly-annotated body sells
    // (non-core-TP sells missing isBodyOwned, or with negative PnL/holdback)
    const sellsToAnnotate = cycleFills.filter(f =>
      f.side === 'sell' && f.orderId !== coreTpOrderId
      && (!(f.isBodyOwned || f.isSatellite) || (f.bodyPnl ?? f.satellitePnl) < 0 || (f.bodyHoldbackAsset ?? f.satelliteHoldbackAsset) < 0)
    );
    const buyFills = cycleFills.filter(f => f.side === 'buy');
    const consumedBuyOrderIds = new Set();

    for (const sellFill of sellsToAnnotate) {
      // Find matching buy: similar BTC size, closest in time to the sell
      // (satellite TP is placed right after its buy, so the buy should be temporally close)
      const candidates = buyFills.filter(buy => {
        if (consumedBuyOrderIds.has(buy.orderId)) return false;
        const sizeRatio = buy.size / sellFill.size;
        return sizeRatio > 0.99 && sizeRatio < 1.01
          && buy.timestamp < sellFill.timestamp;
      });
      // Pick the candidate closest in time to the sell
      const matchingBuy = candidates.length > 0
        ? candidates.reduce((best, buy) =>
          (sellFill.timestamp - buy.timestamp) < (sellFill.timestamp - best.timestamp) ? buy : best
        )
        : null;

      if (matchingBuy) {
        consumedBuyOrderIds.add(matchingBuy.orderId);
        const costBasis = matchingBuy.quoteAmount + (matchingBuy.netFee || matchingBuy.fee || 0);
        const proceeds = sellFill.quoteAmount - (sellFill.netFee || sellFill.fee || 0);
        const pnl = proceeds - costBasis;
        const holdbackAsset = roundAsset(matchingBuy.size - sellFill.size);

        // Sanity check: body PnL should be positive and holdback non-negative
        if (pnl >= 0 && holdbackAsset >= 0) {
          fillLedger.annotateFillsByOrderId(sellFill.orderId, {
            isBodyOwned: true,
            bodyCostBasis: costBasis,
            bodyAvgPrice: matchingBuy.price,
            bodyBtcQty: matchingBuy.size,
            bodyHoldbackAsset: holdbackAsset,
            bodyPnl: pnl,
          });
          fillLedger.annotateFillsByOrderId(matchingBuy.orderId, { isBodyOwned: true, sellOrderId: sellFill.orderId });
          annotatedCount += 2;
          logger.info(`🔧 [${exchange}] Annotated body sell: ${sellFill.orderId.slice(0, 8)} PnL=$${pnl.toFixed(4)}, holdback=${holdbackAsset.toFixed(8)} ${baseCurrency}`);
        } else {
          // Mark as body-owned but without computed values (dashboard will show raw data)
          fillLedger.annotateFillsByOrderId(sellFill.orderId, { isBodyOwned: true });
          annotatedCount++;
          logger.warn(`⚠️ [${exchange}] Marked body sell ${sellFill.orderId.slice(0, 8)} (no matching buy found with valid PnL)`);
        }
      }
    }

    // 3. Fix fills with wrong cycle IDs (e.g., recovered-* cycles that belong here)
    // Only move fills that are within the current cycle's timeframe
    const currentCycleFills = fillLedger.getCurrentCycleFills();
    const cycleStartTs = currentCycleFills.length > 0
      ? Math.min(...currentCycleFills.map(f => f.timestamp))
      : Date.now();
    const allFillsRaw = fillLedger.getAllFills();
    for (const fill of allFillsRaw) {
      if (fill.cycleId && fill.cycleId.includes('-recovered-')
        && fill.cycleId !== currentCycleId && fill.timestamp >= cycleStartTs) {
        const oldCycleId = fill.cycleId;
        fillLedger.updateFillCycleId(fill.tradeId, currentCycleId);
        annotatedCount++;
        logger.info(`🔧 [${exchange}] Moved fill ${fill.tradeId.slice(0, 8)} from ${oldCycleId} to ${currentCycleId}`);
      }
    }

    if (annotatedCount > 0) {
      fillLedger.persist();
      logger.info(`🔧 [${exchange}] Annotated ${annotatedCount} satellite fills for correct tracking`);
    }
  }
};

/** Ledger rows the engine synthesized in place of real exchange fills. */
const PSEUDO_FILL_TRADE_ID = /^(synthetic-|consolidated-sell-)/;

/**
 * Plan how live bodies must grow to cover recovered partial rows of their own
 * buy orders (issue #752). recalculateCycles places a null-cycle buy row
 * that shares its orderId with a body-owned order into that order's cycle
 * and copies its ownership (`cycleAttribution: 'order'`, #705) — but the
 * body's assetQty/costBasis were sized from the rows known when the fill was
 * handled, so its TP stays sized for less than the position actually held.
 *
 * Guards — this is the engine's OWN linked order, never an unlinked import
 * (R2 in docs/pnl-architecture.md):
 *   - only orders with at least one `'order'`-attributed buy row are
 *     considered ('link' / 'timeframe' rows never grow a body);
 *   - the order has no synthetic gap row (which recovered rows may duplicate);
 *   - every owned row of the order names ONE bodyId, and exactly one live
 *     body — that one — records the order in its `buyOrders`;
 *   - growth is the exact shortfall of the order's full ledger totals over
 *     the body's recorded share (computeBuyOrderShortfall), so repeated
 *     calls converge, and it may not exceed the attributed rows' own size —
 *     a larger gap is some other discrepancy and is left for manual review.
 * Pure: never mutates the ledger or a body.
 * @param {Object} params
 * @param {Object} params.fillLedger - Fill ledger instance
 * @param {Object[]} params.celestialBodies - Live bodies
 * @returns {{ plans: Array<{body: Object, buyOrderId: string, totals: {assetQty: number, costBasis: number, avgPrice: number}, shortfall: {assetQty: number, costBasis: number, avgPrice: number}}>, skipped: Array<{buyOrderId: string, reason: string}> }}
 */
const planBodyGrowthFromRecoveredBuyRows = ({ fillLedger, celestialBodies }) => {
  const plans = [];
  const skipped = [];
  const bodies = celestialBodies || [];
  const candidateOrderIds = new Set();
  for (const f of fillLedger.getAllFills()) {
    if (f.side === 'buy' && f.cycleAttribution === 'order' && f.bodyId && f.orderId
      && !String(f.tradeId).startsWith('dca-convert')) {
      candidateOrderIds.add(f.orderId);
    }
  }
  for (const buyOrderId of candidateOrderIds) {
    const rows = fillLedger.getFillsForOrder(buyOrderId).filter(r => r.side === 'buy');
    // A pseudo row (`synthetic-<orderId>-<size>`, handleOrderFill's gap fill
    // when the exchange returned no fills) stands in for real executions that
    // sync-fills may since have re-imported under their real tradeIds — the
    // very rows attributed here. Summing both would grow the body by asset it
    // never bought, so leave such an order for manual review
    // (scripts/backfill-missing-fills.js replaces pseudo rows).
    if (rows.some(r => PSEUDO_FILL_TRADE_ID.test(String(r.tradeId)))) {
      skipped.push({ buyOrderId, reason: 'order has a synthetic gap row that recovered rows may duplicate' });
      continue;
    }
    const bodyIds = new Set(rows.map(r => r.bodyId).filter(Boolean));
    if (bodyIds.size !== 1) {
      skipped.push({ buyOrderId, reason: `rows name ${bodyIds.size} bodies` });
      continue;
    }
    const [bodyId] = bodyIds;
    const owners = bodies.filter(b => (b.buyOrders || []).some(bo => bo.orderId === buyOrderId));
    // No owner: the body already closed (its TP sold) — nothing live to grow.
    if (owners.length === 0) continue;
    if (owners.length !== 1 || owners[0].id !== bodyId) {
      skipped.push({ buyOrderId, reason: `order recorded by ${owners.length} live bodies, not only ${bodyId}` });
      continue;
    }
    const body = owners[0];
    const qty = rows.reduce((sum, r) => sum + (r.size || 0), 0);
    const quote = rows.reduce((sum, r) => sum + (r.quoteAmount || 0), 0);
    const totals = {
      assetQty: roundAsset(qty),
      costBasis: roundUSDC(rows.reduce((sum, r) => sum + (r.quoteAmount || 0) + (r.netFee || 0), 0)),
      avgPrice: qty > 0 ? quote / qty : 0,
    };
    const { shortfall } = celestialHierarchy.computeBuyOrderShortfall(body, totals, buyOrderId);
    if (!shortfall) continue;
    const attributedQty = rows
      .filter(r => r.cycleAttribution === 'order')
      .reduce((sum, r) => sum + (r.size || 0), 0);
    if (shortfall.assetQty > attributedQty + 0.00000001) {
      skipped.push({ buyOrderId, reason: `shortfall ${shortfall.assetQty} exceeds recovered rows ${roundAsset(attributedQty)}` });
      continue;
    }
    plans.push({ body, buyOrderId, totals, shortfall });
  }
  return { plans, skipped };
};

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

  /**
   * Identity fields for a closed trade, derived from the SELL's own fills.
   *
   * Every closedTrades.record() site must spread this instead of stamping
   * ad hoc. Reading live engine state at record time is wrong twice over:
   * resetCycle() advances the cycle counter BEFORE the trade is recorded
   * (filing it under a later cycle), and the offline-fill paths book a fill
   * that may have happened days earlier (dating it to engine-restart time).
   * The 612c14ce incident hit both — a cycle-18 sell written as cycle-21.
   * Live values remain as fallbacks only for a summary with no usable fills.
   *
   * `recordedAt` is deliberately NOT included: it means "when the engine
   * booked this", so Date.now() is correct for it.
   *
   * @param {{cycleId: string|null, lastTimestamp: number}} summary - aggregateFills result for the sell
   * @returns {{timestamp: number, cycleId: string|null}}
   */
  const sellTradeStamp = (summary) => ({
    timestamp: summary.lastTimestamp || Date.now(),
    cycleId: summary.cycleId ?? fillLedger.getCurrentCycleId(),
  });
  const healthMonitor = createHealthMonitor(exchange, config, {
    onSafeMode: async (reason) => {
      logger.warn(`⚠️ [${exchange}] SAFE mode: ${reason}`, { reason });
      // A disk fault is not an exchange fault (issue #532): the intervention is
      // to stop opening NEW entries (canPlaceEntry blocks them in SAFE), not to
      // cancel orders that are already resting. Pulling them because a write
      // failed would turn an unpersistable-state fault into an
      // unmanaged-position fault, which is strictly worse.
      if (!isPersistenceOnlySafeReason(reason)) {
        await orderExecutor.cancelAllEntries();
      }
      if (callbacks.onHealthChange) {
        callbacks.onHealthChange('SAFE', reason);
      }
    },
    onActiveMode: () => {
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
  let positionState = createInitialPositionState();
  let priceIncrement = 0.01; // Updated from product details in start()
  let productDetails = null; // Cached from start() for min-order-size checks

  // Track if cycle buys limit warning has been logged (to avoid log spam)
  let cycleBuysLimitWarningLogged = false;
  // Track if USDC cap exceeded warning has been logged (to avoid log spam)
  let usdcCapWarningLogged = false;
  // Track if budget exhausted warning has been logged (to avoid log spam)
  let budgetExhaustedWarningLogged = false;
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
   * (issue #673 codex round 3, #764). Searches BOTH saved lists: the executor
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
      // (issue #673 codex round 3): handleCancelledOrder resolved this
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

  // Create Macro Regime detector (multi-timeframe EMA overlay)
  const macroRegime = config.macroEnabled
    ? createMacroRegime(exchange, config, adapter, productId)
    : null;

  let isRunning = false;
  let isStarting = false; // reentrancy guard for start() (#113)
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
  // Cooldown after a failed dust consolidation so a body that can't currently be
  // merged (e.g. target TP partially filled) doesn't re-attempt+re-log every
  // cycle (#189). 0 = no cooldown.
  let dustMergeRetryAfter = 0;
  let stateSaveInterval = null;
  let fillDriftInterval = null;
  let fillDriftInFlight = false;
  // Most recent drift verdict, surfaced on getState() so the UI/operator sees a
  // leak without reading logs. null until the first sweep completes.
  let fillDrift = null;
  // Most recent "does the model cover what we actually hold" verdict, surfaced
  // on getState() alongside fillDrift. null until the first sweep completes.
  let positionCoverage = null;
  // Rate limit for the "placements blocked by an unresolved intent" log line.
  let placementBlockLoggedAt = 0;
  // Short-lived cache of the intent check. evaluateEntryTrigger runs on every
  // ticker message, and the authoritative refusal is order-manager's own fresh
  // read immediately before each dispatch — so this can only delay the
  // engine-side skip (and the operator's unblock) by up to a second, never let
  // a duplicate order through.
  let placementIntentCache = { at: 0, intents: [] };
  let insufficientFundsCooldownUntil = 0; // Cooldown after InsufficientFunds to prevent rapid retry spam
  const recentlyProcessedFills = new Set(); // Dedup guard: prevents double-processing when stale check and fill check race
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
  const recentlyProcessedSellFills = new Set(); // Dedup guard: prevents sell orders from being processed twice across WS/reconcile/polling
  const recentlyProcessedBuyFills = new Set(); // Dedup guard: prevents buy orders from being processed twice across WS/polling (would duplicate the body at full size)
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
  // tpOrderId → body snapshot (completed merges, auto-expire after 60s)
  const completedMergeTpOrders = new Map();

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
   * Record cycle completion for Size optimizer
   *
   * Feeds the optimizer the REAL available quote balance (the same
   * adapter.getAccountBalance() reading the ladder/entry preflight below use)
   * rather than config.maxUsdcDeployed. Passing the cap back in makes
   * calculateAdjustment() treat the cap itself as "spare" balance and ratchet
   * maxUsdcDeployed down toward zero on every evaluation, compounding across
   * cycles (issue #694) — the optimizer's own maxUsdcDeployed formula is
   * deliberately unbounded/un-rate-limited (see tests/size-optimizer.test.js),
   * so it trusted whatever balance it was given completely.
   *
   * @param {Object} cycleData - Data about the completed cycle
   * @returns {Promise<void>}
   */
  const recordCycleForSizeOptimizer = async (cycleData) => {
    if (!config.sizeAutoManaged) return;

    // getAccountBalance is ACCOUNT-wide, not fund-scoped (same caveat as
    // checkPositionCoverage above). With two+ funds on this exchange sharing
    // a quote currency (e.g. BTC-USDC and ETH-USDC both settling in USDC),
    // each fund's optimizer would otherwise see the WHOLE shared wallet and
    // could independently ratchet its OWN maxUsdcDeployed up toward ~90% of
    // that shared total — over-committing capital across sibling funds
    // (codex review, issue #694). Skip the fetch in that case, the same way
    // checkPositionCoverage skips its check, rather than act on unsound data.
    //
    // A fund's configured identity `pair` and its actual traded `productId`
    // can differ by quote currency (a documented, supported override — see
    // productIdMatchesPair in config-utils.js), so comparing raw `f.pair`
    // quote currencies can UNDER-count true sharing (codex review round 2).
    // Resolve each candidate's EFFECTIVE traded quote from its RAW per-pair
    // config block, not getFundConfig()/getRegimeConfig() (both DEFAULTS/
    // regime-merged results, so `.productId` is NEVER falsy there — it
    // silently reads back DEFAULTS.productId = 'BTC-USDC' for any fund with
    // no explicit override, making `|| f.pair` dead code and misclassifying
    // every such fund as quoting USDC; claude review round 3 caught this
    // exact trap, already worked around the same way in
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
    // evaluating against that now-unscoped stale value forever (codex review
    // round 2). A plain fetch failure/missing method is NOT forced this way
    // — sizeOptimizer.recordCycle() already treats availableBalance<=0 there
    // as "no fresh reading" and correctly keeps the last verified balance,
    // since a transient failure is expected to recover on its own.
    const balanceAmbiguous = sharingQuote.length > 1;
    const quoteBalance = (!balanceAmbiguous && typeof adapter.getAccountBalance === 'function')
      ? await adapter.getAccountBalance(quoteCurrency).catch(() => null)
      : null;
    const availableBalance = quoteBalance ? (parseFloat(quoteBalance.available) || 0) : 0;

    // This now runs AFTER resetCycle() at every call site (issue #694 review
    // round 1/2) — every caller awaits resetCycle() but then invokes this
    // function WITHOUT awaiting it (fire-and-forget, .catch()'d at the call
    // site) so its own network round-trip (adapter.getAccountBalance, up to
    // a 30s exchange timeout) never delays the caller's own
    // saveLiveState()/fillLedger.persist()/saveDryRunState() from durably
    // persisting the already-completed cycle close (codex review round 2). A
    // crash during this call loses only this one best-effort optimizer stats
    // sample, never P&L-critical state. Any throw here (sizeOptimizer.
    // recordCycle()'s own bookkeeping, or handleSizeAdjustment()'s
    // updateRegimeConfig disk write) is therefore also caught and swallowed
    // internally, so it can never become an unhandled rejection.
    try {
      if (balanceAmbiguous) {
        sizeOptimizer.invalidateBalance();
      }
      const adjustment = sizeOptimizer.recordCycle({
        stepsUsed: cycleData.stepsUsed || 0,
        capitalDeployed: cycleData.capitalDeployed || 0,
        completedAt: Date.now(),
        availableBalance,
      });

      if (adjustment) {
        handleSizeAdjustment(adjustment);
      }
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Size optimizer recording failed (non-fatal): ${err.message}`, { error: err.message });
    }
  };

  /**
   * Re-save after recordCycleForSizeOptimizer's detached (fire-and-forget)
   * call resolves, so its result isn't left only in memory (issue #694
   * review round 3). Guarded: this runs inside a `.finally()` on a promise
   * chain nobody awaits, so an unguarded throw (e.g. a disk fault —
   * ENOSPC/EACCES/EROFS — surfacing from saveLiveState()/fillLedger.persist())
   * would be a genuinely unhandled promise rejection, which can crash a live
   * trading process with resting orders on the exchange — precisely the
   * hazard saveLiveStateGuarded exists to prevent for every other background
   * caller in this file (claude review round 3).
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

  /**
   * Save dry-run state to disk
   */
  const saveDryRunState = () => {
    if (!isDryRun) return;

    // Persist macro regime state into position for recovery
    if (macroRegime) {
      positionState.macroRegime = macroRegime.getState();
    }

    dryRunState.saveState(exchange, {
      isDryRun: true,
      executor: orderExecutor.exportState(),
      position: { ...positionState },
      tpOptimizer: tpOptimizer.exportState(),
      sizeOptimizer: sizeOptimizer.exportState(),
    }, pair);
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
    orderExecutor.importState(savedState.executor);

    // Restore position state
    if (savedState.position) {
      positionState = { ...createInitialPositionState(), ...savedState.position };
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
    saveRegimeState(positionState, regimeState, exchange, tpOptimizerState, sizeOptimizerState, pair);
  };

  /**
   * Persist live state from a BACKGROUND caller — the 5-minute save timer and
   * the SIGUSR1 reload — where a synchronous throw is an uncaughtException that
   * terminates a live trading process with resting orders on the exchange
   * (issue #532). `saveRegimeState`'s terminal `atomicWriteSync` rethrows on
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
   * SIGUSR1 handler: re-read regime state and the fill ledger from disk so an
   * operator can apply a manual state fix without restarting the engine.
   *
   * Guarded because a throw from a signal listener is an uncaughtException, and
   * the exact workflow this exists for — hand-editing regime-state.json — is
   * also the one that produces a malformed file. `loadRegimeState` throws by
   * design on unreadable/non-object JSON, so a typo used to kill a live trading
   * process (issue #532). It throws BEFORE anything is mutated, which is what
   * makes the reload all-or-nothing: a failed reload leaves in-memory state
   * exactly as it was rather than half-merging RELOADABLE_STATE_FIELDS.
   * @returns {boolean} Whether state was reloaded
   */
  const reloadStateFromDisk = () => {
    const startedAt = Date.now();
    logger.info(`🔄 [${exchange}] SIGUSR1 received — reloading state from disk`);
    try {
      const savedState = loadRegimeState(exchange, pair);
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

    const savedState = loadRegimeState(exchange, pair);
    const pos = savedState.position;
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

    positionState = { ...createInitialPositionState(), ...savedState.position };
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

  /**
   * Apply capital growth idempotently per sell order (issue #210-B). The credit
   * is a non-idempotent config.json write; claiming the credit in the fill
   * ledger (persisted before this write) makes a crash-replay of the same
   * sellOrderId a no-op instead of a double-apply that inflates the budget cap.
   * The claim is keyed per booked amount (issue #777): a second booking of
   * the same sell order for execution the first never covered is credited
   * too, while a replay of an already-credited booking is not.
   * @param {string} sellOrderId
   * @param {number} pnl
   * @param {{bookedSize: number, replay: boolean}} [booking] - From
   *   planSellBooking: the order's cumulative booked size once this booking
   *   commits, and whether the pass re-aggregates the whole order (a replay
   *   refuses on any prior credit)
   * @returns {number} maxUsdcDeployed BEFORE this credit (unchanged when already credited)
   */
  const creditCapitalGrowth = (sellOrderId, pnl, booking) => {
    const prevMaxUsdc = config.maxUsdcDeployed;
    if (!fillLedger.claimCapitalCredit(sellOrderId, booking?.bookedSize, { replay: !!booking?.replay })) {
      logger.info(
        `ℹ️ [${exchange}] Capital growth for ${sellOrderId?.slice(0, 8)} already credited — skipping re-apply (crash-replay idempotency #210-B)`,
        { orderId: sellOrderId }
      );
      return prevMaxUsdc;
    }
    config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
    updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });
    return prevMaxUsdc;
  };

  /**
   * How a body-TP sell booking lands on the fill ledger (issue #777). The
   * per-order annotations (bodyPnl, holdback, reserves sold, consumedBy, the
   * capital credit) are read once per orderId, so a SECOND booking of an
   * order that already committed one — a partial then its remainder, or a
   * cancel-race execution beyond what an in-flight fill booked (#227/#770) —
   * must add to it. It does only when this pass aggregated rows it just
   * ingested: those rows cannot be part of the committed booking. A pass that
   * ingested nothing re-aggregates every row of the order (a crash replay),
   * so it replaces, exactly as before.
   * @param {string} orderId - Sell order id
   * @param {number} soldSize - Base quantity this booking sold
   * @param {boolean} rowsAreNew - The booking aggregates only newly ingested rows
   * @returns {{additive: boolean, replay: boolean, bookedSize: number}}
   *   bookedSize is the order's cumulative booked size once this booking
   *   commits; `replay` marks a pass that re-aggregated the whole order
   */
  const planSellBooking = (orderId, soldSize, rowsAreNew) => {
    const prior = rowsAreNew ? fillLedger.getSellBooking(orderId) : null;
    return {
      additive: !!prior,
      replay: !rowsAreNew,
      bookedSize: roundAsset((prior ? prior.bookedSize : 0) + (Number(soldSize) || 0)),
    };
  };

  /**
   * Check for orders that filled while offline
   * @returns {Promise<{tpFilled: boolean, entriesFilled: number}>}
   */
  const checkOfflineOrderFills = async () => {
    const openOrders = await adapter.getOpenOrders(productId);
    const openOrderIds = new Set(openOrders.map(o => o.orderId));

    let tpFilled = false;
    let entriesFilled = 0;

    // Recover legacy/core TPs through the same accounting and dedup as live fills.
    const legacyTpOrderId = positionState.activeTpOrderId;
    if (legacyTpOrderId && !openOrderIds.has(legacyTpOrderId)) {
      try {
        const orderStatus = await adapter.getOrder(legacyTpOrderId);
        if (isFilledStatus(orderStatus)) {
          await handleOrderFill(buildPartialFillData(legacyTpOrderId, 'sell', orderStatus, {
            source: 'offline',
          }));
          tpFilled = true;
        }
      } catch (err) {
        logger.error(
          `❌ [${exchange}] TP ${legacyTpOrderId} offline fill recovery failed: ${err.message} — retaining tracking for retry`,
          { orderId: legacyTpOrderId, orderType: 'take_profit', error: err.message }
        );
      }
    }

    // Check for celestial body TP orders that filled or were cancelled while offline
    // Prefetch order statuses for all body TPs no longer in openOrderIds in
    // parallel — sequential awaits made startup O(N) round-trips on a fund
    // with many bodies (the 51-orphan ETHUSD case took ~25s on Gemini).
    const offlineBodies = positionState.celestialBodies || [];
    const bodiesToCheck = offlineBodies.filter(b => b.tpOrderId && !openOrderIds.has(b.tpOrderId));
    const bodyStatuses = await Promise.all(
      bodiesToCheck.map(b => adapter.getOrder(b.tpOrderId).catch(() => null))
    );
    const bodyStatusByOrderId = new Map(
      bodiesToCheck.map((b, i) => [b.tpOrderId, bodyStatuses[i]])
    );

    for (const body of [...offlineBodies]) {
      if (body.tpOrderId && !openOrderIds.has(body.tpOrderId)) {
        const orderStatus = bodyStatusByOrderId.get(body.tpOrderId);

        // A cancel-for-replace whose booking failed before the restart (#670)
        // persisted the execution it knew about. Book from it rather than
        // from a CANCELLED status that may omit (or understate) the filled
        // size — otherwise the branches below would book too little, or clear
        // the TP and re-place against the unreduced body, losing the sale.
        const knownExecution = isCancelledStatus(orderStatus) ? knownTpCancelExecution(body, orderStatus) : null;
        if (knownExecution) {
          orderExecutor.markSettled(body.tpOrderId);
          // bookTpCancelExecution contains its own failure (keeps the marker
          // and the TP identity for the reconcile retry).
          await bookTpCancelExecution(body, body.tpOrderId, knownExecution, 'Startup recovery');
          continue;
        }

        // Catch CANCELLED-with-partials at startup (Gemini heartbeat-cancels
        // open orders during downtime). The interval reconciler would catch
        // this too, but only after reconcileIntervalMs.
        if (isCancelledStatus(orderStatus) && orderStatus.filledSize > 0) {
          const tierCfg = celestialHierarchy.getTierConfig(body.tier);
          logger.info(
            `${tierCfg.emoji} [${exchange}] Body TP ${body.tpOrderId} ${orderStatus.status} while offline with ${orderStatus.filledSize} partial fill — routing through handleOrderFill`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status, filledSize: orderStatus.filledSize }
          );
          orderExecutor.markSettled(body.tpOrderId);
          // Contain per body. handleOrderFill THROWS when the partial sell's
          // cancellation is unresolved (issue #316) — e.g. the open-order
          // cross-check failed. Without this, one unresolved body aborts the
          // whole offline-recovery pass and every remaining body is skipped.
          // The reconcile loop re-checks each body on its own tick anyway, so
          // logging and moving on is the correct degradation (mirrors the
          // reconcile loop's terminal guard, issue #99).
          try {
            await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', orderStatus));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} offline partial-fill recovery failed: ${err.message} — retrying on next reconcile`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
            );
          }
          continue;
        }

        // Cancelled-without-partials: clear the stale tpOrderId so the engine
        // places a fresh TP on first tick. Without this, body.tpOrderId points
        // at a dead order and placeBodyTp would skip (it gates on !tpOrderId).
        if (isCancelledStatus(orderStatus)) {
          logger.warn(
            `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${orderStatus.status} while offline (no partials) — clearing for re-placement`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status }
          );
            orderExecutor.removeBodyTracking(body.tpOrderId);
            body.tpOrderId = null;
          body.tpPrice = 0;
          body.assetOnOrder = 0;
          // The old TP is already gone — whatever fresh TP gets placed next
          // (ensureTakeProfitPlaced, sized from the CURRENT assetQty) is
          // already correct. Clear needsTpReprice here too, or the later
          // savedBodies reprice pass (issue #726) would skip this body
          // entirely on THIS startup (its guard requires a tpOrderId), and a
          // future restart would needlessly cancel+replace the
          // freshly-placed, already-correctly-sized TP (codex delta review,
          // round 5).
          if (body.needsTpReprice) body.needsTpReprice = false;
          continue;
        }

        // Same FILLED-or-completion=100 pattern as the core TP path above.
        if (isFilledStatus(orderStatus)) {
          const tierCfg = celestialHierarchy.getTierConfig(body.tier);
          logger.info(
            `${tierCfg.emoji} [${exchange}] Body TP ${body.tpOrderId} filled while offline — routing through handleOrderFill`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status }
          );
          orderExecutor.markSettled(body.tpOrderId);
          // Contain per body (issue #316), same as the cancelled-with-partials
          // branch above: one unresolved body must not abort recovery of the
          // rest. Routing through the canonical pipeline (#367) — instead of
          // duplicating its ~90 lines of fill aggregation, prorated cost basis,
          // holdback, capital growth credit, source-buy linking and
          // closedTrades.record inline — also picks up the cycle reset when
          // this was the last body, which the old inline path omitted entirely.
          try {
            await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', orderStatus));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} offline full-fill recovery failed: ${err.message} — retrying on next reconcile`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
            );
          }
        }
      }
    }

    // Check for entry orders that filled while offline
    const pendingEntries = orderExecutor.getPendingEntries();
    for (const [orderId] of pendingEntries) {
      if (!openOrderIds.has(orderId)) {
        const orderStatus = await adapter.getOrder(orderId);
        if (isFilledStatus(orderStatus)) {
          logger.info(
            `✅ [${exchange}] Entry order ${orderId} filled while offline — routing through handleOrderFill`,
            { orderId, orderType: 'entry', status: orderStatus.status }
          );
          entriesFilled++;

          // Contain per entry (issue #316): one unresolved entry must not abort
          // recovery of subsequent pending entries/bodies. Routing through the
          // canonical pipeline (#367) — instead of mutating flat totalAsset/
          // totalCostBasis with no celestial body and falling back to the legacy
          // monolithic TP — creates/merges the proper celestial body and places
          // its dynamic TP, keeping the hierarchy in sync with position state.
          try {
            await handleOrderFill(buildPartialFillData(orderId, 'buy', orderStatus, {
              placedAt: orderExecutor.getOrderPlacedAt(orderId),
            }));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Entry ${orderId.slice(0, 8)} offline fill recovery failed: ${err.message} — retrying on next reconcile`,
              { orderId, orderType: 'entry', error: err.message }
            );
          }
        }
      }
    }

    return { tpFilled, entriesFilled };
  };

  /**
   * Re-evaluate position after downtime
   * Checks if market has moved significantly and adjusts strategy accordingly
   * @param {number} currentPrice - Current market price
   */
  const reEvaluateAfterDowntime = (currentPrice) => {
    if (positionState.totalAsset <= 0) {
      logger.info(`ℹ️ [${exchange}] No position to re-evaluate`);
      return;
    }

    const lastEntryPrice = positionState.lastEntryPrice || positionState.avgCostBasis;
    if (lastEntryPrice <= 0) return;

    const priceChange = ((currentPrice - lastEntryPrice) / lastEntryPrice) * 100;
    const priceChangeAbs = Math.abs(priceChange);

    logger.info(`📊 [${exchange}] Re-evaluating position: price moved ${priceChange.toFixed(2)}% since last entry (${fmtPrice(lastEntryPrice)} -> ${fmtPrice(currentPrice)})`);

    // Re-anchor price for volatility triggers
    positionState.anchorPrice = currentPrice;
    logger.info(`⚓ [${exchange}] Re-anchored price to ${fmtPrice(currentPrice)}`);

    // If price dropped significantly (>5%), consider the position may need attention
    if (priceChange < -5) {
      logger.warn(`⚠️ [${exchange}] Price dropped ${priceChangeAbs.toFixed(2)}% while offline - position unrealized P&L affected`);
    }

    // If price rose significantly and we have a position, TP might need updating
    if (priceChange > 3 && positionState.totalAsset > 0) {
      logger.info(`📈 [${exchange}] Price rose ${priceChangeAbs.toFixed(2)}% while offline - TP order may need adjustment`);
      // TP order will be re-evaluated naturally on next metrics update
    }
  };

  // APY calculation delegates to extracted module
  const calculateApyMetrics = () => _calculateApyMetrics(positionState, config, marketState);
  const initializeApyTracking = () => _initializeApyTracking(
    positionState, config, exchange,
    isDryRun ? () => orderExecutor.getFilledOrders() : undefined,
    productId
  );

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

    // Recover state from exchange (skip in dry-run mode)
    if (!isDryRun) {
      // First, try to load saved state for faster startup.
      // A corrupt regime-state.json throws by design (issue #108 — booting with
      // a zeroed position would abandon a live one). Refusing to trade is right;
      // throwing out of start() is not: it propagates to the engine process's
      // `startup().catch` → process.exit(1) → PM2 restart → the same corrupt
      // file, burning the restart budget in under a minute and leaving resting
      // orders with no process watching them. Return a structured failure
      // instead so the process stays up and regime:status can report it (#532).
      let hasSavedState;
      try {
        hasSavedState = loadLiveState();
      } catch (err) {
        logger.error(
          `❌ [${fundLabel}] Cannot start — operator must repair state before trading resumes: ${err.message}`,
          { action: 'start', error: err.message }
        );
        tradeEvents.emitTradeEvent('error', exchange, `Engine start blocked: ${err.message}`, {
          action: 'start', pair, error: err.message,
        });
        return { success: false, error: err.message, needsOperator: true };
      }

      // An operator reset is a durable boundary, not a new fill. Restore it
      // before exchange recovery and cycleBuys auto-correction; otherwise the
      // fill ledger's active-cycle heuristic can resurrect the pre-reset cycle
      // and immediately re-apply the buy limit after a restart.
      if (hasSavedState) {
        restorePersistedCycleId(fillLedger, positionState, logger, exchange);
      }

      // Then recover/validate from exchange (source of truth)
      const { position } = await recoveryModule.recoverState(fillLedger, orderExecutor);

      // Merge recovered position with any saved state
      // IMPORTANT: If saved state shows totalAsset=0 with cyclesCompleted>0, this means
      // a cycle was properly completed and reset. The recovery from fills will show
      // the "holdback" BTC as position (sum of buys minus sells), but this is NOT
      // an active position - it's accumulated BTC reserves from completed cycles.
      // Trust the saved state in this case.
      const savedTpOrderId = positionState.activeTpOrderId;
      const savedTpPrice = positionState.lastTpPrice;
      const savedTotalBTC = positionState.totalAsset;
      const savedCyclesCompleted = positionState.cyclesCompleted;
      // Cross-validate: if fill ledger has buys in the current cycle, the cycle is NOT completed
      // (saved state may have been corrupted by a previous buggy restart). In celestial mode
      // every engine buy is body-owned, so count ALL buys — getCurrentCycleBuysCount excludes
      // body-owned buys and would wrongly report an active cycle as completed (issue #210-A).
      const celestialMode = config.celestialEnabled !== false;
      const fillLedgerHasBuys = celestialMode
        ? fillLedger.getCurrentCycleAllBuysCount() > 0
        : fillLedger.getCurrentCycleBuysCount() > 0;
      const cycleWasCompleted = hasSavedState && savedTotalBTC === 0 && savedCyclesCompleted > 0
        && !fillLedgerHasBuys;

      if (cycleWasCompleted) {
        logger.info(`ℹ️ [${exchange}] Saved state shows completed cycle (${savedCyclesCompleted} cycles, 0 ${baseCurrency} position) - trusting saved state over recovery`);
      }

      positionState = {
        ...createInitialPositionState(),
        ...positionState, // Keep saved fields (realizedPnL, cyclesCompleted, celestialBodies, etc.)
        // Only override position fields that come from fill-ledger rebuild
        // (NOT realizedPnL, cyclesCompleted, celestialBodies, celestialState, etc.)
        totalAsset: cycleWasCompleted ? 0 : position.totalAsset,
        totalCostBasis: cycleWasCompleted ? 0 : position.totalCostBasis,
        avgCostBasis: cycleWasCompleted ? 0 : position.avgCostBasis,
        cycleBuys: cycleWasCompleted ? 0 : position.cycleBuys,
        lastEntryPrice: position.lastEntryPrice || positionState.lastEntryPrice,
        lastEntryTime: position.lastEntryTime || positionState.lastEntryTime,
        anchorPrice: position.anchorPrice || positionState.anchorPrice,
        activeTpOrderId: savedTpOrderId, // Restore TP tracking (not in fills)
        lastTpPrice: savedTpPrice,
      };

      // Auto-correct cycleBuys from fill ledger (source of truth). In celestial
      // mode all engine buys are body-owned, so count ALL current-cycle buys —
      // getCurrentCycleBuysCount excludes them and would zero the restored
      // counter, letting a mid-cycle restart double the per-cycle step exposure
      // (issue #210-A).
      const actualCycleBuys = celestialMode
        ? fillLedger.getCurrentCycleAllBuysCount()
        : fillLedger.getCurrentCycleBuysCount();
      if (positionState.cycleBuys !== actualCycleBuys) {
        logger.info(`🔧 [${exchange}] Auto-correcting cycleBuys: ${positionState.cycleBuys} -> ${actualCycleBuys} (from fill ledger)`);
        positionState.cycleBuys = actualCycleBuys;
      }

      // Book entry tranches the ledger holds but no owning body records
      // (issue #756) first, so the seal counts them as open.
      const recoveredEntryTranches = await recoverUnbookedOwnedEntryTranches().catch(err => {
        logger.warn(`⚠️ [${exchange}] Unbooked entry tranche recovery failed: ${err.message}`, { error: err.message });
        return 0;
      });
      if (recoveredEntryTranches > 0) {
        logger.info(`🔧 [${exchange}] Booked unrecorded tranches of ${recoveredEntryTranches} entry order(s) into their own bodies`);
      }

      // Seal legacy closure into per-buy consumption records while the
      // sellOrderId links still say which orders were closed (issue #607).
      // Must run BEFORE anything that can place a body TP — offline fill
      // recovery, TP repricing — because placeBodyTp re-stamps sellOrderId
      // on every row of the order, erasing the evidence.
      const sealedLegacy = sealLegacyClosure();
      if (sealedLegacy > 0) {
        fillLedger.persist();
        logger.info(`🔒 [${exchange}] Sealed legacy closure of ${sealedLegacy} buy order(s) into consumption records`);
      }

      // Check for orders that filled while we were offline (non-critical, continue on error)
      const offlineFills = await checkOfflineOrderFills().catch(err => {
        logger.warn(`⚠️ [${exchange}] Failed to check offline fills: ${err.message}`, { error: err.message });
        return { tpFilled: false, entriesFilled: 0 };
      });
      if (offlineFills.tpFilled || offlineFills.entriesFilled > 0) {
        logger.info(`📋 [${exchange}] Processed offline fills: TP=${offlineFills.tpFilled}, entries=${offlineFills.entriesFilled}`);
      }

      // Get current price and re-evaluate position
      const currentPrice = await adapter.getCurrentPrice(productId);
      if (currentPrice > 0 && positionState.totalAsset > 0) {
        reEvaluateAfterDowntime(currentPrice);
      }

      // If we have position but no TP order, place one
      if (positionState.totalAsset > 0 && !positionState.activeTpOrderId) {
        logger.info(`📝 [${exchange}] Position exists but no TP order, will place after metrics update`);
      }

      // Restore TP order tracking if we have an active TP order ID - but validate it exists first.
      // EXPIRED is a terminal cancellation per order-manager.js:49 — without
      // excluding it here, an EXPIRED order would be restored as an open TP
      // and block placement of a replacement. Same precedent across the
      // codebase: order-manager / order-executor / market-data-service all
      // treat EXPIRED as terminal-cancelled.
      if (positionState.activeTpOrderId) {
        let tpOrderStatus = null;
        let tpLookupFailed = false;
        try {
          tpOrderStatus = await adapter.getOrder(positionState.activeTpOrderId);
        } catch (err) {
          // Same rule as the body-TP restore below: only definitive not-found
          // clears tracking; transient failures must not orphan a live order.
          tpLookupFailed = !isOrderNotFoundError(err);
        }
        const tpOrderExists = tpLookupFailed || (tpOrderStatus
          && tpOrderStatus.status !== 'CANCELLED'
          && tpOrderStatus.status !== 'FAILED'
          && tpOrderStatus.status !== 'EXPIRED');

        if (tpOrderExists) {
          // Check if a celestial body owns this TP — restore as body_tp if so
          const bodyOwner = (positionState.celestialBodies || []).find(b => b.tpOrderId === positionState.activeTpOrderId);
          if (bodyOwner) {
            const placedAt = tpOrderStatus?.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now());
            orderExecutor.restoreBodyTpOrder(bodyOwner.id, positionState.activeTpOrderId, bodyOwner.assetQty, positionState.lastTpPrice, placedAt);
            logger.info(`📋 [${exchange}] Restored legacy TP as body_tp: ${positionState.activeTpOrderId.slice(0, 8)} → body ${bodyOwner.id.slice(-8)}`);
            positionState.activeTpOrderId = null;
            positionState.lastTpPrice = 0;
            positionState.assetOnOrder = 0;
          } else {
            orderExecutor.restorePendingOrder(positionState.activeTpOrderId, {
              type: 'take_profit',
              price: positionState.lastTpPrice,
              size: positionState.assetOnOrder || positionState.totalAsset,
              sizeUsdc: (positionState.lastTpPrice || 0) * (positionState.assetOnOrder || positionState.totalAsset),
              placedAt: tpOrderStatus?.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now()),
              status: 'open',
            });
            logger.info(`📋 [${exchange}] Restored TP order tracking: ${positionState.activeTpOrderId} @ ${fmtPrice(positionState.lastTpPrice)}`);
          }
        } else {
          // TP order no longer exists on exchange - clear tracking so a new one gets placed.
          //
          // KNOWN LIMITATION: cancelled-with-fills recovery is incomplete here.
          // The exchange may report status=CANCELLED with completionPercentage
          // anywhere in (0, 100] — both the partial case (cancel won the race
          // before all the asset filled) AND the full case (completion=100,
          // cancel-after-fill: the order completed in full before the cancel
          // was processed) land in this branch. checkOfflineOrderFills (which
          // ran earlier in startup) is the canonical fill-ingest path; if it
          // succeeded, positionState.totalAsset already reflects the sale and
          // clearing activeTpOrderId here is correct (no replacement TP gets
          // placed because totalAsset is 0). If it MISSED fills (REST call
          // failed, recent-trade window aged out, etc.), this branch will
          // clear the tracking and a subsequent regime tick can place a
          // replacement TP for an already-(partially-)sold position — even
          // ingesting fills here is insufficient on its own, because a
          // correct fix must also reduce positionState.totalAsset, recompute
          // avgCostBasis, and account for realized P&L from the sell.
          //
          // The same gap applies if the API process restarted while a market-
          // data-service cancel-retry was still pending — those retries live
          // in-memory only, so a restart loses them.
          //
          // The market-data-service catch-up retry covers the common case
          // while the engine is stopped. Engine-side recovery on startup +
          // disk-persisted retry markers are deferred; do not extend this
          // branch to ingest fills until that bookkeeping is in place.
          logger.warn(`⚠️ [${exchange}] Saved TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
          positionState.activeTpOrderId = null;
          positionState.lastTpPrice = 0;
          positionState.assetOnOrder = 0;
        }
      }

      // Cancel stale orders flagged for cleanup (e.g. partially-filled TPs from prior crashes)
      if (positionState._cancelOnStartup?.length > 0) {
        for (const staleOrderId of [...positionState._cancelOnStartup]) {
          const cancelResult = await adapter.cancelOrder(staleOrderId).catch(() => ({ success: false }));
          if (cancelResult.success) {
            logger.info(`🗑️ [${exchange}] Cancelled stale order from _cancelOnStartup: ${staleOrderId}`);
          } else {
            const status = await adapter.getOrder(staleOrderId).catch(() => null);
            if (status && (status.status === 'FILLED' || status.status === 'CANCELLED')) {
              logger.info(`ℹ️ [${exchange}] Stale order ${staleOrderId} already ${status.status}`);
            } else {
              logger.warn(`⚠️ [${exchange}] Failed to cancel stale order ${staleOrderId}`);
              continue; // Keep failed IDs for next startup
            }
          }
          positionState._cancelOnStartup = positionState._cancelOnStartup.filter(id => id !== staleOrderId);
        }
        if (positionState._cancelOnStartup.length === 0) {
          delete positionState._cancelOnStartup;
        }
      }

      // Restore celestial body TP order tracking from saved state
      const savedBodies = positionState.celestialBodies || [];
      if (savedBodies.length > 0) {
        let restoredBodies = 0;
        let expiredBodies = 0;

        // Backfill buyOrders for bodies that predate the tracking field
        for (const body of savedBodies) {
          if (!body.buyOrders) {
            body.buyOrders = (body.sourceOrderIds || []).map(oid => ({
              orderId: oid,
              price: body.avgPrice,
              assetQty: 0,
              sizeUsdc: 0,
              filledAt: body.createdAt || Date.now(),
            }));
          }
        }

        // Self-heal avgPrice for bodies where roundUSDC truncated precision
        for (const body of savedBodies) {
          if (body.assetQty > 0 && body.costBasis > 0) {
            const correctedAvg = body.costBasis / body.assetQty;
            if (Math.abs(correctedAvg - body.avgPrice) / correctedAvg > 0.001) {
              logger.info(`🔧 [${exchange}] correcting body avgPrice bodyId=${body.id} old=${body.avgPrice} new=${correctedAvg}`);
              body.avgPrice = correctedAvg;
            }
          }
        }

        for (const body of [...savedBodies]) {
          if (!body.tpOrderId) continue;

          let bodyStatus = null;
          let bodyLookupFailed = false;
          try {
            bodyStatus = await adapter.getOrder(body.tpOrderId);
          } catch (err) {
            // Only a definitive not-found means the order is gone. Network/
            // API failures keep the saved tpOrderId and restore tracking from
            // saved state below; the interval reconciler re-checks once
            // connectivity returns (see isOrderNotFoundError).
            bodyLookupFailed = !isOrderNotFoundError(err);
          }
          // Mirror the core-TP exists check: EXPIRED is terminal cancellation.
          const bodyExists = bodyLookupFailed || (bodyStatus
            && bodyStatus.status !== 'CANCELLED'
            && bodyStatus.status !== 'FAILED'
            && bodyStatus.status !== 'EXPIRED');

          if (bodyExists && isFilledStatus(bodyStatus)) {
            // Body filled while offline — handled in checkOfflineOrderFills above
            continue;
          }

          if (bodyExists) {
            const bodyPlacedAt = bodyStatus?.createdTime ? new Date(bodyStatus.createdTime).getTime() : Date.now();
            orderExecutor.restoreBodyTpOrder(
              body.id,
              body.tpOrderId,
              body.assetOnOrder || body.assetQty,
              body.tpPrice,
              bodyPlacedAt
            );
            restoredBodies++;
          } else {
            // Body TP no longer on exchange — re-place TP.
            // Same KNOWN LIMITATION as the core-TP branch above: cancelled-
            // with-fills recovery is incomplete. Both the partial case
            // (completion in (0,100)) and the full case (completion=100,
            // cancel-after-fill where the order finished before the cancel
            // was processed) land here — bodyExists filters out CANCELLED/
            // FAILED/EXPIRED before the FILLED-or-completion=100 short-
            // circuit at the top of this if. A body TP that filled before
            // cancellation needs body.assetQty / body.costBasis proration
            // and realized-P&L accounting; without it the replacement TP
            // would be sized incorrectly. checkOfflineOrderFills handles the
            // happy path; engine-side recovery is deferred.
            body.tpOrderId = null;
            expiredBodies++;
            // The old TP is already gone — whatever fresh TP gets placed
            // below (ensureTakeProfitPlaced, or the reprice pass below for
            // an overpriced %) will size against the CURRENT (already-grown)
            // assetQty. Nothing left for the reprice pass to cancel, so
            // clear the flag here too; otherwise a needless cancel+re-place
            // of the freshly-placed, already-correctly-sized TP would fire
            // on the NEXT restart (codex delta review, round 5).
            if (body.needsTpReprice) body.needsTpReprice = false;
          }
        }

        if (restoredBodies > 0) logger.info(`🌌 [${exchange}] Restored ${restoredBodies} celestial body TP orders`);
        if (expiredBodies > 0) logger.warn(`⚠️ [${exchange}] ${expiredBodies} body TP orders need re-placement`);

        // Reprice any restored body TPs whose TP% exceeds the effective max
        // (fixes bodies that were placed with uncapped holdback floor), OR
        // that a manual buy extend flagged needsTpReprice while this engine
        // was stopped (issue #726 — extendPersistedBody grew the body's
        // assetQty but had no adapter/executor to safely cancel the live TP
        // itself, so it left a marker for this pass to pick up instead).
        // Every body that still carries a tpOrderId here had its executor
        // tracking restored just above, so cancel through the executor —
        // cancelBodyTpForReplace books any tranche sold during the cancel
        // instead of re-listing it (issue #670).
        for (const body of [...savedBodies]) {
          if (!body.tpOrderId || body.avgPrice <= 0) continue;
          const currentTpPct = ((body.tpPrice - body.avgPrice) / body.avgPrice) * 100;
          const bTierCfg = celestialHierarchy.getTierConfig(body.tier);
          const bEffectiveMax = config.tpMaxPercent * (bTierCfg.tpMaxScale || 1);
          // A manual TP override means the operator intentionally set this
          // PERCENTAGE — never second-guess it via the overpriced-vs-max
          // check below. But needsTpReprice is about SIZE, not price:
          // placeBodyTp reapplies body.manualTpPct whenever it re-places
          // (~line 5452), so a manual-TP body extended while the engine was
          // stopped must still go through this cancel+replace — skipping it
          // here left its TP undersized forever and the flag never cleared
          // (codex delta review, round 5).
          const overpriced = body.manualTpPct == null && currentTpPct > bEffectiveMax * 1.01;
          if (overpriced || body.needsTpReprice) {
            const reason = overpriced
              ? `TP% ${currentTpPct.toFixed(2)}% exceeds max ${bEffectiveMax.toFixed(2)}%`
              : 'extended by a manual buy import while stopped';
            logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} needs TP reprice (${reason}) — cancelling and repricing`);
            const oldTp = body.tpOrderId;
            const outcome = await cancelBodyTpForReplace(body, 'Startup reprice');
            if (outcome === 'cancelled') {
              body.needsTpReprice = false;
              await placeBodyTp(body);
            } else if (outcome === 'booked') {
              // cancelBodyTpForReplace already booked the tranche that sold
              // during the cancel and re-placed a right-sized TP for the
              // body's new (reduced) shape itself — nothing left to do.
              body.needsTpReprice = false;
            } else if (outcome === 'filled') {
              logger.info(`📋 [${exchange}] Body TP ${oldTp.slice(0, 8)} needing reprice already filled — polling will process`);
            } else if (outcome === 'unresolved') {
              logger.warn(
                `⚠️ [${exchange}] Failed to cancel body TP ${oldTp} needing reprice`,
                { bodyId: body.id, orderId: oldTp }
              );
            }
            // 'booking_failed': leave needsTpReprice set — the reconcile
            // loop retries the booking independently, and a future startup
            // retries this pass too.
          }
        }
      }

      // Detect orphaned sell orders on exchange that we lost track of
      const exchangeOpenOrders = await adapter.getOpenOrders(productId);
      const trackedSellIds = new Set();
      if (positionState.activeTpOrderId) trackedSellIds.add(positionState.activeTpOrderId);
      for (const body of (positionState.celestialBodies || [])) {
        if (body.tpOrderId) trackedSellIds.add(body.tpOrderId);
      }
      const orphanedSells = exchangeOpenOrders.filter(o =>
        o.side.toUpperCase() === 'SELL' && !trackedSellIds.has(o.orderId) && o.size > 0
      );

      // Log orphaned sell orders but do NOT adopt them. Automatic reclamation
      // is unsafe — it can sell non-engine assets (user holdings, other bots).
      if (orphanedSells.length > 0) {
        for (const order of orphanedSells) {
          logger.warn(`⚠️ [${exchange}] Untracked sell order on exchange: ${order.orderId.slice(0, 8)} ${order.size.toFixed(8)} ${baseCurrency} @ ${fmtPrice(order.price)} — NOT adopting (manual review required)`);
        }
      }

      // Repair historical fill annotations (orphan recovery, size fuzzy-match, -recovered- cycle rewrites)
      repairHistoricalFillAnnotations({
        fillLedger, positionState, config, logger, baseCurrency, priceIncrement, exchange,
        celestialHierarchy, calculateDynamicTpPercent, roundPrice, roundAsset, fmtPrice
      });

      // Sync position totals from celestial bodies (ensures recovery didn't zero them out)
      if ((positionState.celestialBodies || []).length > 0) {
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      }

      // Load closed-trades audit log, then always attempt migration. migrateFromFills
      // is a no-op when trades.length > 0, so this is safe to call unconditionally
      // and it self-heals the case where closed-trades.json was cleared to "[]" but
      // the file still exists (load() returns true for empty file → migrate was
      // skipped, leaving the audit log permanently out-of-sync with the ledger).
      closedTrades.load();
      closedTrades.migrateFromFills(fillLedger);

      // Recalculate cycles from fill ledger for cycle counting and per-cycle details.
      const recalcResult = fillLedger.recalculateCycles();
      // Orphan recovery may renumber cycles. Re-point the durable boundary
      // (#606) at the ledger's live cycle and persist it now, or the next
      // restart restores a stale ID that names a different cycle (#675).
      // Folding null-cycle fills into the live cycle (#705) changes its
      // membership, so the counters restored above must be re-derived too.
      const cycleIdChanged = syncActiveCycleIdAfterRecalc(recalcResult);
      if (resyncLiveCycleCountersAfterRecalc(recalcResult) || cycleIdChanged) saveLiveState();
      if (recalcResult.cyclesCompleted > 0 || recalcResult.orphansFixed > 0 || sealedLegacy > 0) {
        positionState.cyclesCompleted = recalcResult.cyclesCompleted;
        refreshRealizedFromCyclePairs();
        logger.info(`📋 [${exchange}] Cycle-pair realized: $${positionState.realizedPnL.toFixed(2)} USD, ${positionState.realizedAssetPnL.toFixed(6)} ${baseCurrency} reserves (${recalcResult.cyclesCompleted} cycles)`);
      }

      // Backfill APY tracking start time from earliest fill in ledger
      const allFills = fillLedger.getAllFills();
      if (allFills.length > 0) {
        const earliestFillTime = allFills.reduce((earliest, fill) => {
          return fill.timestamp < earliest ? fill.timestamp : earliest;
        }, Infinity);
        if (earliestFillTime !== Infinity && (!positionState.engineStartTime || positionState.engineStartTime > earliestFillTime)) {
          positionState.engineStartTime = earliestFillTime;
          positionState.initialCapital = config.maxUsdcDeployed || 10000;
          // Only set originalCapital if not already set (preserve true starting value)
          if (!positionState.originalCapital) {
            positionState.originalCapital = positionState.initialCapital;
          }
          logger.info(`📊 [${exchange}] APY tracking backfilled to first fill: ${new Date(earliestFillTime).toISOString()}, original=$${positionState.originalCapital}`);
        }
      }

      // Restore pending entry orders from saved state (instead of canceling them)
      const savedPendingEntries = positionState.pendingEntryOrders || [];
      const savedOrderIds = new Set(savedPendingEntries.map(e => e.orderId));

      // Reuse exchangeOpenOrders from orphan satellite detection above
      const openEntries = exchangeOpenOrders.filter(o => o.side.toUpperCase() === 'BUY');

      // Pre-build ladder order ID set so we don't flag them as orphans
      const savedLadderIds = new Set((positionState.pendingLadderOrders || []).map(o => o.orderId));

      // Load corrective buy order IDs to avoid cancelling them as orphans
      const correctiveBuyIds = new Set();
      try {
        const cbPath = require('path').join(resolveFundDataDir(exchange, pair), 'pending-corrective-buys.json');
        const cbData = JSON.parse(require('fs').readFileSync(cbPath, 'utf8'));
        for (const cb of cbData) {
          if (!cb.filled && !cb.cancelled) correctiveBuyIds.add(cb.buyOrderId);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error(
            `[regime-engine] Error reading pending-corrective-buys.json: ${err.message}`,
            { error: err.message, errorCode: err.code, path: 'pending-corrective-buys.json' }
          );
        }
      }

      // Load manual trade recovery buy order IDs to avoid cancelling them as orphans
      try {
        const mtPath = require('path').join(resolveFundDataDir(exchange, pair), 'manual-trades.json');
        const mtData = JSON.parse(require('fs').readFileSync(mtPath, 'utf8'));
        for (const mt of (mtData.trades || [])) {
          if (mt.buyOrderId && mt.status === 'buy_pending') correctiveBuyIds.add(mt.buyOrderId);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error(
            `[regime-engine] Error reading manual-trades.json: ${err.message}`,
            { error: err.message, errorCode: err.code, path: 'manual-trades.json' }
          );
        }
      }

      let restoredEntries = 0;
      let orphanedEntries = 0;

      /**
       * Book the already-filled tranche of an entry that is still open on the
       * exchange through the standard fill pipeline (issue #671), so it joins
       * a celestial body, gets a TP, and shrinks the tracked pending entry.
       * A failure is logged, not thrown: the caller has already restored the
       * order's executor tracking, so the live poll/WS path books the fills
       * once the engine is running — and since nothing was ingested here,
       * that later pass sees every row as new instead of a deduped remainder.
       * @param {Object} order - Open order from getOpenOrders
       * @param {number} placedAt - Order placement time (ms)
       * @param {string} label - Log label for the calling branch
       * @returns {Promise<void>}
       */
      const bookStartupOpenEntryPartial = async (order, placedAt, label) => {
        const fillArgs = { status: order.status || 'OPEN', isPartialFill: true, placedAt };
        // Rows no body ever booked were ingested by the pre-#671 startup path.
        // The normal pass below would dedup them away and build the body from
        // only the newer tranches, so commit them into a body first, on their
        // own. Rows a body already booked are settled and never rebooked.
        const legacyRows = isBuyAlreadyCommitted(positionState.celestialBodies, order.orderId)
          ? []
          : fillLedger.getFillsForOrder(order.orderId)
            .filter(isUnsettledBuyRow);
        // What this call commits is measured from the order's tranches, so a
        // throw can shrink the entry by exactly that (issue #756).
        const tranchesOf = () => (positionState.celestialBodies || [])
          .flatMap(b => (b.buyOrders || []).filter(bo => bo && bo.orderId === order.orderId));
        const tranchesBefore = new Set(tranchesOf());
        const entryBefore = (positionState.pendingEntryOrders || []).find(e => e.orderId === order.orderId);
        try {
          if (legacyRows.length > 0) {
            // A current-cycle order was already counted by the cycleBuys
            // auto-correct above; a first commit here would count it again.
            const alreadyCounted = fillLedger.getCurrentCycleFills()
              .some(f => f.side === 'buy' && f.orderId === order.orderId);
            const cycleBuysBefore = positionState.cycleBuys;
            try {
              await handleOrderFill(buildPartialFillData(order.orderId, 'buy', order, {
                ...fillArgs,
                filledSize: legacyRows.reduce((sum, f) => sum + Number(f.size || 0), 0),
                confirmedFills: legacyRows,
              }));
            } finally {
              if (alreadyCounted && positionState.cycleBuys === cycleBuysBefore + 1) {
                positionState.cycleBuys = cycleBuysBefore;
              }
            }
          }
          await handleOrderFill(buildPartialFillData(order.orderId, 'buy', order, fillArgs));
        } catch (err) {
          logger.error(`❌ [${exchange}] Could not book offline partial fills for ${label} ${order.orderId}: ${err.message} — will pick them up on the next reconcile/poll`, {
            orderId: order.orderId,
            error: err.message,
            incompleteFills: err.incompleteFills === true,
          });
          // A throw after a body took a tranche but before the pending entry
          // shrank would leave the entry at its full notional beside that
          // body, overstating deployed capital. Shrink it by exactly the
          // tranches this call committed — not to the exchange's remainder,
          // which would also subtract tranches that are still unbooked (a
          // legacy-row pass that committed and then threw leaves the main
          // pass's tranches to the live path, which shrinks the entry
          // itself when it books them).
          if (entryBefore) {
            const committed = tranchesOf().filter(bo => !tranchesBefore.has(bo));
            const qty = committed.reduce((sum, bo) => sum + (Number(bo.assetQty) || 0), 0);
            const cost = committed.reduce((sum, bo) => sum + (Number(bo.sizeUsdc) || 0), 0);
            positionState.pendingEntryOrders = (positionState.pendingEntryOrders || []).map(e => (
              e.orderId !== order.orderId ? e : {
                ...e,
                assetQty: Math.max(0, (Number(entryBefore.assetQty) || 0) - qty),
                sizeUsdc: Math.max(0, (Number(entryBefore.sizeUsdc) || 0) - cost),
              }
            ));
          }
        }
      };

      for (const order of openEntries) {
        if (savedOrderIds.has(order.orderId)) {
          // This is our order - restore tracking instead of canceling
          const savedEntry = savedPendingEntries.find(e => e.orderId === order.orderId);
          const restoredPlacedAt = order.createdTime ? new Date(order.createdTime).getTime() : (savedEntry.placedAt || Date.now());
          orderExecutor.restorePendingOrder(order.orderId, {
            type: 'entry',
            price: savedEntry.price,
            size: savedEntry.assetQty,
            sizeUsdc: savedEntry.sizeUsdc,
            placedAt: restoredPlacedAt,
          });
          restoredEntries++;
          logger.info(`🔄 [${exchange}] Restored pending entry: ${order.orderId} @ ${fmtPrice(savedEntry.price)}`);

          // Check if order has any fills while offline (partial fills).
          // Route them through the standard fill pipeline (issue #671) so the
          // tranche lands in a celestial body (with a TP) and shrinks the
          // tracked entry. Ingesting straight into the ledger here left the
          // tranche in no body: the later terminal fill deduped those rows
          // and built its body from the new tranche alone.
          if (order.filledSize && order.filledSize > 0) {
            logger.info(`✅ [${exchange}] Entry ${order.orderId} has partial fills (${order.filledSize})`);
            await bookStartupOpenEntryPartial(order, restoredPlacedAt, 'entry');
          }
        } else if (correctiveBuyIds.has(order.orderId)) {
          logger.info(`📋 [${exchange}] Skipping corrective buy order ${order.orderId.slice(0, 8)} (tracked in pending-corrective-buys)`);
        } else if (!savedLadderIds.has(order.orderId)) {
          // Check if this "orphan" has partial fills — if so, restore it instead of cancelling
          if (order.filledSize && order.filledSize > 0) {
            logger.info(`📦 [${exchange}] Orphan entry ${order.orderId.slice(0, 8)} has partial fills (${order.filledSize} ${baseCurrency}) — restoring instead of cancelling`);
            // Every sibling restorePendingOrder({type: 'entry', ...}) call in
            // this file sets `size` to the order's ORIGINAL placed quantity
            // (e.g. savedEntry.assetQty above), not what's left unfilled —
            // the dashboard reads it as the "of N" denominator alongside
            // filledSize (RegimeDashboard.jsx: "X of Y filled"). order.size
            // is now the REMAINING unfilled quantity (issue #684); use
            // order.originalSize here to match the established convention.
            const orphanPlacedAt = order.createdTime ? new Date(order.createdTime).getTime() : Date.now();
            orderExecutor.restorePendingOrder(order.orderId, {
              type: 'entry',
              price: order.price,
              size: order.originalSize,
              sizeUsdc: order.originalSize * order.price,
              placedAt: orphanPlacedAt,
            });
            // Keep the adopted order in the persisted pending list so it
            // survives the next restart, then book its filled tranche through
            // the standard pipeline (issue #671) — which also shrinks this
            // entry from its original quantity to its unfilled remainder.
            if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
            if (!positionState.pendingEntryOrders.some(e => e.orderId === order.orderId)) {
              // The orphan-buy recovery above may already have booked some of
              // it into a body; track only what no body holds (issue #756).
              const held = (positionState.celestialBodies || [])
                .flatMap(b => b.buyOrders || [])
                .filter(bo => bo && bo.orderId === order.orderId);
              const heldQty = held.reduce((sum, bo) => sum + (Number(bo.assetQty) || 0), 0);
              const heldCost = held.reduce((sum, bo) => sum + (Number(bo.sizeUsdc) || 0), 0);
              positionState.pendingEntryOrders.push({
                orderId: order.orderId,
                price: order.price,
                assetQty: Math.max(0, order.originalSize - heldQty),
                sizeUsdc: Math.max(0, order.originalSize * order.price - heldCost),
                placedAt: orphanPlacedAt,
              });
            }
            await bookStartupOpenEntryPartial(order, orphanPlacedAt, 'orphan entry');
            restoredEntries++;
          } else {
            // Orphan entry with no fills — cancel it
            orphanedEntries++;
            logger.info(`🧹 [${exchange}] Cancelling orphan entry order ${order.orderId} (not tracked by regime engine)`);
            const cancelResult = await adapter.cancelOrder(order.orderId);
            if (cancelResult.success) {
              logger.info(`✅ [${exchange}] Cancelled orphan entry ${order.orderId.slice(0, 8)}`);
            } else {
              const orphanStatus = await adapter.getOrder(order.orderId).catch(() => null);
              if (orphanStatus?.status === 'FILLED') {
                logger.info(`📋 [${exchange}] Orphan entry ${order.orderId.slice(0, 8)} already filled — recovery will process`);
              } else {
                logger.warn(
                  `⚠️ [${exchange}] Failed to cancel orphan entry ${order.orderId.slice(0, 8)}: ${cancelResult.errorMessage || 'unknown'}`,
                  { orderId: order.orderId, orderType: 'entry', error: cancelResult.errorMessage || 'unknown' }
                );
              }
            }
          }
        }
      }

      if (restoredEntries > 0) {
        logger.info(`✅ [${exchange}] Restored ${restoredEntries} pending entry orders from state`);
      }
      if (orphanedEntries > 0) {
        logger.info(`🧹 [${exchange}] Cancelled ${orphanedEntries} orphan entry orders`);
      }

      const allOpenIds = new Set(exchangeOpenOrders.map(o => o.orderId));

      // Catch up fills for saved entries that became terminal during downtime.
      // The for-loop above only iterates exchangeOpenOrders, so saved entries
      // that already cleared on the exchange skip its partial-fill ingest path;
      // without this catch-up they would be purged below with no ledger record.
      const terminalSavedEntries = savedPendingEntries.filter(e => !allOpenIds.has(e.orderId));
      // Prefetch statuses in parallel; handleOrderFill is still sequential
      // since it mutates positionState.
      const entryStatuses = await Promise.all(
        terminalSavedEntries.map(e => adapter.getOrder(e.orderId).catch(err => ({ __err: err })))
      );
      let caughtUpEntries = 0;
      // Orders whose catch-up handleOrderFill threw (issue #679's stricter
      // getOrderFills contract) — must NOT be purged below with no ledger
      // record. Re-armed via restorePendingOrder (inside catchUpTerminalEntry) so the
      // next reconcile's checkPendingOrderFills polls this (already-terminal
      // on the exchange) order again and routes it through the
      // retry-hardened live polling fill path.
      const failedCatchUpIds = new Set();
      for (let i = 0; i < terminalSavedEntries.length; i++) {
        const savedEntry = terminalSavedEntries[i];
        const orderStatus = entryStatuses[i];
        if (!orderStatus || orderStatus.__err) {
          if (orderStatus?.__err) {
            logger.warn(
              `⚠️ [${exchange}] Failed to catch up offline entry ${savedEntry.orderId.slice(0, 8)}: ${orderStatus.__err.message}`,
              { orderId: savedEntry.orderId, error: orderStatus.__err.message }
            );
          }
          continue;
        }
        // Shared with reconcileTick's orphan sweep (issue #764): honors the
        // saved row's knownFilledSize high-water mark, so a restart during the
        // exposure window can't misread a real partial as an empty cancel just
        // because this fresh poll under-reports filledSize. On a throw (issue
        // #679's stricter getOrderFills contract) it has already re-armed
        // executor tracking for the SAME orderId and stamped the resolved size
        // onto the row; keep it in pendingEntryOrders (below) instead of
        // purging it.
        const result = await catchUpTerminalEntry(savedEntry, orderStatus, 'entry');
        if (result.outcome === 'filled') caughtUpEntries++;
        else if (result.outcome === 'failed') failedCatchUpIds.add(savedEntry.orderId);
        // 'empty': truly empty cancel, ok to purge below
      }
      if (caughtUpEntries > 0) {
        logger.info(`📥 [${exchange}] Caught up ${caughtUpEntries} offline-terminal entries before purge`);
      }
      if (failedCatchUpIds.size > 0) {
        logger.info(`🔁 [${exchange}] Re-armed ${failedCatchUpIds.size} offline-terminal entries whose fill catch-up failed, for retry`);
      }

      // Remove saved pending entries that are no longer open on the exchange
      // (filled or cancelled while engine was offline — fills already ingested above).
      // A failed catch-up (failedCatchUpIds) is retained even though it is
      // also not open on the exchange — it needs a retry, not a purge.
      // Filters the LIVE list, not the savedPendingEntries snapshot: the
      // handleOrderFill calls above shrank partially-filled entries to their
      // unfilled remainder and appended adopted orphans (issue #671), and
      // re-filtering the stale snapshot would silently undo both. A failed
      // catch-up may have thrown AFTER handleOrderFill already dropped its
      // entry from the live list, so those are re-added from the snapshot.
      const livePendingEntries = positionState.pendingEntryOrders || [];
      const liveIds = new Set(livePendingEntries.map(e => e.orderId));
      const currentPendingEntries = [
        ...livePendingEntries,
        ...savedPendingEntries.filter(e => failedCatchUpIds.has(e.orderId) && !liveIds.has(e.orderId)),
      ];
      if (currentPendingEntries.length > 0) {
        positionState.pendingEntryOrders = currentPendingEntries.filter(
          e => allOpenIds.has(e.orderId) || failedCatchUpIds.has(e.orderId)
        );
        const purged = currentPendingEntries.length - positionState.pendingEntryOrders.length;
        if (purged > 0) {
          logger.info(`🧹 [${exchange}] Purged ${purged} stale pending entry orders (filled/cancelled while offline)`);
        }
      }

      // Catch up saved ladder rungs that went terminal while offline, the same
      // way as entries above (issue #764): the restore block below keeps only
      // rungs still open on the exchange, so without this a rung that filled —
      // or was cancelled with a partial, possibly recorded only as its
      // knownFilledSize — would be dropped with nothing booked. A failed
      // catch-up is retained (re-armed by catchUpTerminalEntry) for the
      // reconcile sweep to retry, exactly like failedCatchUpIds for entries.
      const savedLadderSnapshot = positionState.pendingLadderOrders || [];
      const terminalSavedLadder = savedLadderSnapshot.filter(o => !allOpenIds.has(o.orderId));
      const failedLadderCatchUpIds = new Set();
      if (terminalSavedLadder.length > 0) {
        const ladderStatuses = await Promise.all(
          terminalSavedLadder.map(o => adapter.getOrder(o.orderId).catch(err => ({ __err: err })))
        );
        for (let i = 0; i < terminalSavedLadder.length; i++) {
          const savedRung = terminalSavedLadder[i];
          const orderStatus = ladderStatuses[i];
          if (!orderStatus || orderStatus.__err) {
            // Unknown status — keep the row rather than drop a possible fill;
            // the reconcile sweep re-polls it.
            logger.warn(
              `⚠️ [${exchange}] Failed to check offline ladder rung ${savedRung.orderId.slice(0, 8)}: ${orderStatus?.__err?.message || 'no status'} — keeping it for the reconcile sweep`,
              { orderId: savedRung.orderId, orderType: 'ladder_entry', error: orderStatus?.__err?.message }
            );
            failedLadderCatchUpIds.add(savedRung.orderId);
            continue;
          }
          if (!isTerminalStatus(orderStatus)) {
            // Missing from the open-orders snapshot but not terminal (a
            // listing race) — keep it for the sweep, which re-arms live rungs.
            failedLadderCatchUpIds.add(savedRung.orderId);
            continue;
          }
          const result = await catchUpTerminalEntry(savedRung, orderStatus, 'ladder_entry');
          if (result.outcome === 'failed') failedLadderCatchUpIds.add(savedRung.orderId);
        }
        // A catch-up that threw after handleOrderFill already dropped the live
        // row must not lose it — re-add from the snapshot (as entries do).
        const liveLadderIds = new Set((positionState.pendingLadderOrders || []).map(o => o.orderId));
        const droppedRetained = savedLadderSnapshot.filter(
          o => failedLadderCatchUpIds.has(o.orderId) && !liveLadderIds.has(o.orderId)
        );
        if (droppedRetained.length > 0) {
          positionState.pendingLadderOrders = [...(positionState.pendingLadderOrders || []), ...droppedRetained];
        }
      }

      // Restore or cancel persisted ladder orders. Gated on the PRE-catch-up
      // snapshot: a catch-up that booked (and so removed) every rung must still
      // reach the ladderActive=false reset below, exactly as the old purge of
      // those same no-longer-open rungs did.
      const savedLadderOrders = positionState.pendingLadderOrders || [];
      if (positionState.ladderActive && savedLadderSnapshot.length > 0) {
        let restoredLadder = 0;
        let cancelledLadder = 0;

        for (const order of openEntries) {
          if (savedLadderIds.has(order.orderId)) {
            const savedOrder = savedLadderOrders.find(o => o.orderId === order.orderId);
            orderExecutor.restorePendingOrder(order.orderId, {
              type: 'ladder_entry',
              price: savedOrder.price,
              size: savedOrder.assetQty,
              sizeUsdc: savedOrder.sizeUsdc,
              ladderIndex: savedOrder.ladderIndex,
              placedAt: order.createdTime ? new Date(order.createdTime).getTime() : (savedOrder.placedAt || Date.now()),
            });
            restoredLadder++;
          }
        }

        // Remove any saved ladder orders that are no longer open on the exchange
        // — except rungs whose offline catch-up above must be retried.
        const openOrderIds = new Set(openEntries.map(o => o.orderId));
        positionState.pendingLadderOrders = savedLadderOrders.filter(
          o => openOrderIds.has(o.orderId) || failedLadderCatchUpIds.has(o.orderId)
        );

        cancelledLadder = savedLadderOrders.length - positionState.pendingLadderOrders.length;

        if (positionState.pendingLadderOrders.length === 0) {
          positionState.ladderActive = false;
        }

        if (restoredLadder > 0) logger.info(`✅ [${exchange}] Restored ${restoredLadder} pending ladder orders`);
        if (cancelledLadder > 0) logger.info(`ℹ️ [${exchange}] ${cancelledLadder} saved ladder orders no longer open on exchange`);
      }

      // Ensure all celestial bodies have TP orders
      // (covers bodies with null tpOrderId from saved state, e.g. after a cancelled TP wasn't re-placed)
      const bodiesNeedingTp = (positionState.celestialBodies || []).filter(b => !b.tpOrderId && b.assetQty > 0);
      if (bodiesNeedingTp.length > 0) {
        logger.info(`🔧 [${exchange}] ${bodiesNeedingTp.length} celestial bodies need TP orders`);
        for (const body of bodiesNeedingTp) {
          await placeBodyTp(body);
        }
      }

      // Log untracked position asset but do NOT create recovery bodies or place sells.
      // Automatic sell placement for untracked assets is unsafe — it can sell non-engine holdings.
      const allRecoveryBodies = positionState.celestialBodies || [];
      if (allRecoveryBodies.length > 0 && positionState.totalAsset > 0) {
        const trackedBtc = allRecoveryBodies.reduce((sum, b) => sum + b.assetQty, 0);
        const untrackedAsset = roundAsset(positionState.totalAsset - trackedBtc);
        if (untrackedAsset > 0.00000100) {
          logger.warn(`⚠️ [${exchange}] ${untrackedAsset.toFixed(8)} ${baseCurrency} in position not tracked by any body — manual review required`);
        }
      }

      // Update TP if we have position but no order, OR if existing TP has drifted below minimum
      if (positionState.totalAsset > 0) {
        if (!positionState.activeTpOrderId) {
          await placeTakeProfitOrder();
        } else if (positionState.lastTpPrice > 0 && positionState.avgCostBasis > 0) {
          const currentTpPct = ((positionState.lastTpPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100;
          if (currentTpPct < config.tpMinPercent) {
            logger.warn(`⚠️ [${exchange}] TP has drifted below minimum: ${currentTpPct.toFixed(3)}% < ${config.tpMinPercent}% — rebuilding`);
            await placeTakeProfitOrder({ forceUpdate: true });
          }
        }
      }

      // Save initial state after recovery
      saveLiveState();
    } else {
      // Try to load saved dry-run state
      const loaded = loadDryRunState();
      if (!loaded) {
        logger.info(`🧪 [${exchange}] [DRY-RUN] No saved state, starting fresh`);
        positionState = createInitialPositionState();
      }
    }

    // Initialize APY tracking if not already set (preserves existing tracking from saved state)
    initializeApyTracking();

    // Restore macro regime state if available
    if (macroRegime && positionState.macroRegime) {
      macroRegime.restoreState(positionState.macroRegime);
    }

    // Auto-close: if fund is draining but position is fully empty after recovery,
    // transition to closed immediately instead of running an empty engine.
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      const bodies = positionState.celestialBodies || [];
      const hasPosition = (positionState.totalAsset || 0) > 0 || bodies.length > 0;
      if (!hasPosition) {
        positionState.lifecycle = LIFECYCLE.CLOSED;
        positionState.lifecycleChangedAt = Date.now();
        positionState.lifecycleClosedCycle = positionState.cyclesCompleted || 0;
        logger.info(`🛑 [${exchange}] Draining fund has empty position — auto-closing`);
        if (!isDryRun) saveLiveState();
        if (callbacks.onLifecycleClosed) {
          setImmediate(() => {
            try { callbacks.onLifecycleClosed(); } catch (err) {
              logger.warn(`⚠️ [${exchange}] onLifecycleClosed callback error: ${err.message}`, { error: err.message });
            }
          });
        }
        return { success: true, autoClosed: true };
      }
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
      stateSaveInterval = setInterval(() => saveLiveStateGuarded('state-save-timer'), 300000);
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
          if (fillDriftInFlight) return;
          fillDriftInFlight = true;
          sweepLedgerDrift()
            .catch(err => {
              logger.error(`❌ [${exchange}] Ledger drift sweep failed: ${err.message}`, { error: err.message });
            })
            .finally(() => { fillDriftInFlight = false; });
        }, driftSweepMs);
      }
    } else {
      // Start periodic state saving for dry-run (every 60 seconds)
      stateSaveInterval = setInterval(saveDryRunState, 60000);
    }

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

    // SIGUSR1: reload state from disk (for applying manual state fixes without restart)
    if (!isDryRun) {
      process.on('SIGUSR1', reloadStateFromDisk);
      // Store for cleanup
      positionState._sigusr1Handler = reloadStateFromDisk;
    }

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
  const start = async () => {
    if (isRunning || isStarting) {
      logger.warn(`⚠️ [${exchange}] ${modeLabel}Regime engine already ${isRunning ? 'running' : 'starting'}`);
      return { success: false, error: 'Engine already running' };
    }
    isStarting = true;
    try {
      return await startImpl();
    } finally {
      isStarting = false;
    }
  };

  /**
   * Stop the regime engine
   */
  const stop = async () => {
    if (!isRunning) return;

    logger.info(`🛑 [${exchange}] Stopping regime engine`);

    // Mark as not running FIRST to prevent callbacks from taking action
    isRunning = false;

    // Persist-then-cleanup, with the teardown in `finally`: a throwing state
    // save used to abandon stop() before the timer/websocket cleanup below, so
    // a "stopped" engine kept ticking and kept writing. The rejection still
    // reaches callers (the backup-restore quiescence gate, issue #429) — the
    // engine is quiet, but its last state was not saved.
    try {
      // Save state before stopping
      if (isDryRun) {
        dryRunState.forceSave(exchange, {
          isDryRun: true,
          executor: orderExecutor.exportState(),
          position: { ...positionState },
          tpOptimizer: tpOptimizer.exportState(),
          // Include sizeOptimizer so dry-run restarts don't lose sizing
          // adjustments (saveDryRunState persists it; forceSave omitted it) (#113).
          sizeOptimizer: sizeOptimizer.exportState(),
        }, pair);
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
        // Remove SIGUSR1 handler
        if (positionState._sigusr1Handler) {
          process.removeListener('SIGUSR1', positionState._sigusr1Handler);
          delete positionState._sigusr1Handler;
        }
      }
    } finally {
      // Deregister this fund from the shared heartbeat (the adapter only
      // clears the timer when no other fund still needs it). Mirrors the
      // !isDryRun condition in start() so a dry-run engine can never
      // deregister a live fund's heartbeat.
      if (!isDryRun && adapter.stopHeartbeat) {
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

      // Stop macro regime
      if (macroRegime) {
        macroRegime.stop();
      }

      tailEvents.cleanup();

      // Clear all TTL timers to prevent post-shutdown state mutations
      for (const t of ttlTimers) clearTimeout(t);
      ttlTimers.clear();
      recentlyProcessedFills.clear();
      recentlyProcessedSellFills.clear();
      recentlyProcessedBuyFills.clear();
      pendingMergeTpOrders.clear();
      completedMergeTpOrders.clear();

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
      onOrderUpdate: (data) => {
        if (isRunning) {
          handleOrderUpdate(data).catch(err => logger.error(
            `❌ [${exchange}] handleOrderUpdate error: ${err.message}`,
            { orderId: data.orderId, error: err.message }
          ));
        }
      },
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

    // Evaluate entry trigger (fire-and-forget, catch to prevent unhandled rejection)
    evaluateEntryTrigger().catch(err => logger.warn(
      `⚠️ [${exchange}] Entry evaluation failed: ${err.message}`,
      { error: err.message }
    ));

    // In dry-run mode, check if any orders should fill based on current price
    if (isDryRun) {
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

    marketState.trades.push(data);

    // Prune old trades (keep 3 min)
    const cutoff = Date.now() - 3 * 60 * 1000;
    marketState.trades = marketState.trades.filter(t => t.timestamp >= cutoff);

    // Update trade imbalance
    updateTradeImbalance();
  };

  /**
   * Handle order update from WebSocket
   * @param {Object} data - Order data
   */
  const handleOrderUpdate = async (data) => {
    healthMonitor.recordOrderUpdate();

    if (data.status === 'FILLED') {
      await handleOrderFill(data);
    } else if (data.status === 'CANCELLED') {
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
        logger.warn(`⚠️ [${exchange}] WS CANCELLED ${data.orderId} with ${data.filledSize} ${fullyFilled ? 'full' : 'partial'} fill — routing through handleOrderFill before dropping tracking`);
        orderExecutor.markSettled(data.orderId);
        await handleOrderFill(fullyFilled
          ? { ...data, status: 'FILLED', isPartialFill: false }
          : buildPartialFillData(data.orderId, data.side, data));
      }
      orderExecutor.handleOrderCancel(data.orderId);
      // Remove cancelled entry from persisted pending orders
      if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
        const before = positionState.pendingEntryOrders.length;
        positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
          e => e.orderId !== data.orderId
        );
        if (positionState.pendingEntryOrders.length < before) {
          saveLiveState();
        }
      }
    }
  };

  /**
   * Drop a terminal order from the persisted pending-entry / ladder lists.
   * Shared by the normal commit path and the skip-recommit early return, which
   * would otherwise leave the entry (and its deployedInPosition share) behind.
   * @param {string} orderId
   * @returns {void}
   */
  const retireTrackedEntry = (orderId) => {
    let changed = false;
    if (positionState.pendingEntryOrders?.length > 0) {
      const before = positionState.pendingEntryOrders.length;
      positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(e => e.orderId !== orderId);
      changed = positionState.pendingEntryOrders.length !== before;
    }
    if (positionState.pendingLadderOrders?.length > 0) {
      const before = positionState.pendingLadderOrders.length;
      positionState.pendingLadderOrders = positionState.pendingLadderOrders.filter(o => o.orderId !== orderId);
      changed = changed || positionState.pendingLadderOrders.length !== before;
    }
    if (changed) saveLiveState();
  };

  /**
   * Seal the legacy boolean closure into consumption records (issue #607),
   * crediting each order with what live body tranches still hold open.
   * @returns {number} buy orders sealed
   */
  const sealLegacyClosure = () => {
    const openQtyByOrder = new Map();
    // Orders a live body references through something it cannot measure — a
    // tranche with no positive assetQty (bodies from before buyOrders tracked
    // quantities) or a sourceOrderId with no tranche at all. Their open qty is
    // unknown, so they are left unsealed rather than marked fully closed.
    const unmeasured = new Set();
    const seen = new Set();
    for (const body of (positionState.celestialBodies || [])) {
      const measured = new Set();
      for (const entry of (body.buyOrders || [])) {
        if (!entry || !entry.orderId || entry.orderId === 'core-migration' || seen.has(entry)) continue;
        seen.add(entry);
        const size = Number(entry.assetQty) || 0;
        if (!(size > 0)) { unmeasured.add(entry.orderId); continue; }
        measured.add(entry.orderId);
        const prior = Number.isFinite(entry.consumedQty)
          ? entry.consumedQty
          : size * Math.min(Math.max(fillLedger.getBuyOrderConsumption(entry.orderId)?.consumedCostFraction ?? 0, 0), 1);
        openQtyByOrder.set(entry.orderId, (openQtyByOrder.get(entry.orderId) || 0) + Math.max(0, size - prior));
      }
      for (const id of (body.sourceOrderIds || [])) {
        if (id && id !== 'core-migration' && !measured.has(id)) unmeasured.add(id);
      }
    }
    // A still-tracked entry or ladder rung no live body owns can hold rows
    // ingested at boot without booking (the pre-#671 startup path, the
    // recovery module; issue #756). They are unsold — this boot books them
    // into a body (bookStartupOpenEntryPartial, or the orphan-buy recovery)
    // — so they are open, not part of what an earlier tranche's sale closed.
    const trackedOrderIds = [...(positionState.pendingEntryOrders || []), ...(positionState.pendingLadderOrders || [])]
      .map(e => e?.orderId).filter(Boolean);
    for (const orderId of new Set(trackedOrderIds)) {
      if (isBuyAlreadyCommitted(positionState.celestialBodies, orderId)) continue;
      const unbooked = fillLedger.getFillsForOrder(orderId)
        .filter(isUnsettledBuyRow)
        .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      if (unbooked > 0) openQtyByOrder.set(orderId, (openQtyByOrder.get(orderId) || 0) + unbooked);
    }
    return fillLedger.sealLegacyClosedBuys(openQtyByOrder, unmeasured);
  };

  /**
   * Book ledger quantity of a still-tracked entry order that no body
   * represents although a live body owns the order (issue #756).
   *
   * The pre-#671 startup path ingested an open entry's offline tranche
   * straight into the fill ledger. When a body already owned the order (the
   * live run booked an earlier tranche), annotation repair and every later TP
   * placement stamp that body onto ALL of the order's rows, so the tranche
   * looks booked, and handleOrderFill — seeing only duplicate rows of an
   * owned order — skips it. No per-row flag can tell it apart, so this
   * compares quantities, and books only what two independent measures agree
   * is missing:
   *   - bodies: the order's ledger size minus what live tranches hold and
   *     what #607 records say closed bodies consumed (measureUnbookedOrderQty).
   *     Blind to a pre-#607 sale of a tranche in a body that is gone.
   *   - the entry: every tranche the live path booked shrank the persisted
   *     entry (handleOrderFill's shrinkTracked); the pre-#671 startup ingest
   *     did not. So the exchange's placed size minus the entry's remaining
   *     size is what was ever booked, and the ledger's excess over it is not.
   *     Blind to a body committed without the entry shrinking — rejected
   *     below when it books less than live tranches hold.
   * Both are blind to a pre-#607 sale by a body that is gone AND held a
   * tranche the entry never shrank for, so an order is also skipped when any
   * gone body's sale since it started filling is not proven (by its
   * closed-trade record) to exclude it.
   * The missing quantity becomes a body of its own at the cost the ledger
   * shows beyond the tranches bodies hold, and the entry shrinks by it (both saved together, so a
   * restart finds nothing missing). A new body, not a merge: this runs before
   * offline TP fills are booked, and a body whose TP sold offline would
   * report the unsold tranche folded into it as holdback profit. Its TP is
   * placed with every other TP-less body at the end of startup.
   *
   * An order NO live body owns, whose every row a gone body stamped (issue
   * #772), has no live tranche to measure against. Its gone bodies' closed-
   * trade records stand in for them, but only when they prove how much of
   * the order those bodies held (provenGoneBodyHolding): each held nothing
   * but this order, closed with a live-recorded sale, and no other body
   * sale since the order started filling can have drawn from it. That
   * figure and the entry's measure must agree, and #607 consumption, where
   * recorded, must match it; the tranche is then booked at the order's
   * average cost. Anything short of that is only reported.
   *
   * Runs BEFORE sealLegacyClosure so the seal counts the tranche as open
   * rather than as closed by an earlier sale, and before anything that
   * books fills or places TPs. Orders it cannot prove are logged and left
   * as they are.
   * @returns {Promise<number>} orders whose missing tranche was booked
   */
  const recoverUnbookedOwnedEntryTranches = async () => {
    const EPS = 1e-8;
    // Two independent quantity measures must agree to within this — a few
    // roundAsset() steps (8 dp each) of summed closed-trade figures.
    const HOLDING_TOLERANCE = 5e-8;
    const candidates = [];
    const seenOrders = new Set();
    // Ladder rungs are tracked and shrunk exactly like entries.
    const tracked = [
      ...(positionState.pendingEntryOrders || []).map(entry => ({ entry, list: 'pendingEntryOrders' })),
      ...(positionState.pendingLadderOrders || []).map(entry => ({ entry, list: 'pendingLadderOrders' })),
    ];
    for (const { entry, list } of tracked) {
      const orderId = entry?.orderId;
      if (!orderId || seenOrders.has(orderId)) continue;
      seenOrders.add(orderId);
      const ledger = fillLedger.getBuyOrderConsumption(orderId);
      if (!ledger || !(ledger.size > 0)) continue;
      const measure = measureUnbookedOrderQty(positionState.celestialBodies, orderId, ledger);
      if (!measure.owned) {
        // A body that owned the order and stamped every row of it may be gone
        // (its TP sold) while a tranche it never held is still in the ledger.
        // Nothing live bounds how much the gone bodies held, so this is booked
        // only when their closed-trade records prove it (issue #772), and
        // reported otherwise. Rows no body stamped are booked this boot by
        // bookStartupOpenEntryPartial / the orphan-buy recovery instead.
        if (!fillLedger.getFillsForOrder(orderId).some(isUnsettledBuyRow)) {
          candidates.push({ entry, list, orderId, ledger, measure, reportOnly: true });
        }
        continue;
      }
      if (!(measure.shortfall > EPS)) continue;
      if (!measure.measurable) {
        logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: ledger holds ${roundAsset(measure.shortfall)} ${baseCurrency} more than its bodies record, but a body references it without a tranche quantity — manual review required`, { orderId });
        continue;
      }
      candidates.push({ entry, list, orderId, ledger, measure });
    }
    if (candidates.length === 0) return 0;

    let openOrders;
    try {
      openOrders = await adapter.getOpenOrders(productId);
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Could not check ${candidates.length} entry order(s) for unbooked tranches: ${err.message} — retrying on next start`, { error: err.message });
      return 0;
    }

    // A body sale that predates #607 left no consumption record, so neither
    // measure sees a closed body's share of an order — and a body committed
    // without the entry shrinking (a post-commit throw, or the pre-#756
    // orphan recovery) inflates the entry's measure by that same share. Only
    // book an order no gone body's sale could have held part of: one whose
    // closed-trade record lists its buy orders without this one.
    const liveBodyIds = new Set((positionState.celestialBodies || []).map(b => b.id));
    let tradeBySell = null;
    let allTrades = null;
    const loadTrades = () => {
      if (tradeBySell) return;
      closedTrades.load();
      allTrades = closedTrades.getAll();
      tradeBySell = new Map(allTrades.filter(t => t.sellOrderId).map(t => [t.sellOrderId, t]));
    };
    /**
     * Find the first body sale since the order started filling that is not
     * proven to exclude it. `provenBodyIds` are gone bodies whose share of
     * the order is already accounted for (the unowned case below).
     * @returns {Object|null} the offending sell row, or null when none
     */
    const unprovenBodySale = (orderId, { skipLiveBodies, provenBodyIds = new Set() }) => {
      loadTrades();
      const firstFillAt = Math.min(...fillLedger.getFillsForOrder(orderId).filter(f => f.side === 'buy').map(f => f.timestamp || 0));
      for (const f of fillLedger.getAllFills()) {
        if (f.side !== 'sell' || !f.orderId || (f.timestamp || 0) < firstFillAt) continue;
        // A body sale is known by its annotation or, where annotation repair
        // has not run yet, by its closed-trade record.
        const trade = tradeBySell.get(f.orderId);
        const bodyId = f.bodyId || trade?.bodyId;
        if (!trade && !(f.bodyId || f.isBodyOwned || f.isSatellite)) continue;
        if (skipLiveBodies && bodyId && liveBodyIds.has(bodyId)) continue;
        if (trade && trade.bodyId && provenBodyIds.has(trade.bodyId)) continue;
        if (Array.isArray(trade?.buyOrderIds) && !trade.buyOrderIds.includes(orderId)) continue;
        return f;
      }
      return null;
    };
    const goneBodySaleMayHold = (orderId, ledger) => {
      if (ledger.consumedBy) return false;
      return unprovenBodySale(orderId, { skipLiveBodies: true }) !== null;
    };

    /**
     * How much of an order no live body owns the gone bodies that held it
     * are PROVEN to have held (issue #772), from their closed-trade records.
     *
     * Every row of such an order carries a gone body's stamp, so nothing on
     * the rows or in live state bounds that body's share. A closed-trade
     * record does, but only when the body held nothing else: `qtySold` and
     * `holdbackAsset` are body-wide, and a body mixing orders cannot say which
     * order its sale drew from. So the figure is proven only when:
     *   - at least one closed-trade record lists the order, every such record
     *     belongs to a gone body, and every record of those bodies (all their
     *     sales, partial or full) lists this order and no other;
     *   - each such body closed (a full, non-partial sale) and every record is
     *     `source: 'live'` — the migration backfill writes holdbackAsset 0
     *     because it cannot know it, so its figure is not a held quantity;
     *   - every row of the order names one of them (a row marked owned
     *     without a bodyId could be another gone body's);
     *   - every body sale since the order started filling — a live body's
     *     too — is one of theirs or is recorded as excluding the order (a
     *     merge-snapshot sale writes no closed-trade record, and a live body
     *     whose snapshot sold part of this order no longer lists it); and
     *   - #607 consumption, where recorded, agrees: no `__legacy__` seed (the
     *     seal, or a first sale's seed, already counted the unbooked tranche
     *     as sold) and Σ consumedBy equals the held figure.
     * A body's held quantity is what its sales consumed: sold, plus the
     * holdback booked as reserves on the full fill.
     * @returns {{heldQty: number}|{reason: string}}
     */
    const provenGoneBodyHolding = (orderId, ledger) => {
      if (ledger.consumedBy && Object.prototype.hasOwnProperty.call(ledger.consumedBy, LEGACY_CONSUMPTION_KEY)) {
        return { reason: 'its consumption record already counts pre-#607 sales as a lump that may include the tranche' };
      }
      loadTrades();
      const listing = allTrades.filter(t => Array.isArray(t.buyOrderIds) && t.buyOrderIds.includes(orderId));
      if (listing.length === 0) return { reason: 'no closed-trade record says which body sold its booked part' };
      const bodyIds = new Set();
      for (const t of listing) {
        if (!t.bodyId) return { reason: 'a non-body sale lists it' };
        if (liveBodyIds.has(t.bodyId)) return { reason: 'a live body sold part of it' };
        bodyIds.add(t.bodyId);
      }
      let heldQty = 0;
      for (const bodyId of bodyIds) {
        const sales = allTrades.filter(t => t.bodyId === bodyId);
        let closed = false;
        for (const t of sales) {
          const ids = Array.isArray(t.buyOrderIds) ? t.buyOrderIds : [];
          if (ids.length === 0 || ids.some(id => id !== orderId)) {
            return { reason: `body ${String(bodyId).slice(-8)} also held other buys, so its sales do not say how much of this order it held` };
          }
          if (t.source !== 'live') return { reason: `body ${String(bodyId).slice(-8)} has a sale with no recorded holdback` };
          const sold = Number(t.qtySold) || 0;
          if (t.isPartial) {
            heldQty += sold;
          } else {
            closed = true;
            heldQty += Math.max(sold + (Number(t.holdbackAsset) || 0), sold);
          }
        }
        if (!closed) return { reason: `body ${String(bodyId).slice(-8)} has no closing sale on record` };
      }
      // Every row must be attributable to a proven body: a row marked owned
      // (isBodyOwned / isSatellite / sellOrderId) without a bodyId could be
      // another gone body's whose share no record here accounts for.
      const strayRow = fillLedger.getFillsForOrder(orderId)
        .find(f => f.side === 'buy' && !bodyIds.has(f.bodyId));
      if (strayRow) {
        return { reason: strayRow.bodyId
          ? `body ${String(strayRow.bodyId).slice(-8)} stamped it but has no sale on record listing it`
          : 'a row of it names no body, so which body held it is unknown' };
      }
      const sale = unprovenBodySale(orderId, { skipLiveBodies: false, provenBodyIds: bodyIds });
      if (sale) return { reason: `sale ${String(sale.orderId).slice(0, 8)} since it started filling is not proven to exclude it` };
      if (ledger.consumedBy && Math.abs((Number(ledger.consumedQty) || 0) - heldQty) > HOLDING_TOLERANCE) {
        return { reason: `its consumption record (${roundAsset(Number(ledger.consumedQty) || 0)}) disagrees with the closed trades (${roundAsset(heldQty)})` };
      }
      return { heldQty };
    };

    /**
     * Book `qty` of the order into a body of its own and shrink the tracked
     * entry by it (saved by the caller together with the body).
     */
    const bookMissedTranche = ({ list, orderId, qty, unitCost, buyRows }) => {
      const costBasis = roundUSDC(unitCost * qty);
      const body = celestialHierarchy.createNewBody({ assetQty: qty, costBasis, avgPrice: costBasis / qty }, orderId);
      // Date the tranche by the order's latest fill (the missed tranche is
      // not identifiable row by row), not by this startup.
      const lastFillAt = Math.max(...buyRows.map(f => f.timestamp || 0));
      if (lastFillAt > 0) {
        body.lastMergedAt = lastFillAt;
        body.buyOrders[0].filledAt = lastFillAt;
      }
      positionState.celestialBodies = positionState.celestialBodies || [];
      positionState.celestialBodies.push(body);
      positionState[list] = positionState[list].map(e => (e.orderId !== orderId ? e : {
        ...e,
        assetQty: Math.max(0, (Number(e.assetQty) || 0) - qty),
        sizeUsdc: Math.max(0, (Number(e.sizeUsdc) || 0) - costBasis),
      }));
      return body;
    };

    let recovered = 0;
    for (const { entry, list, orderId, ledger, measure, reportOnly } of candidates) {
      let placedQty = 0;
      const open = (openOrders || []).find(o => o.orderId === orderId);
      if (open) {
        placedQty = Number(open.originalSize) || ((Number(open.filledSize) || 0) + (Number(open.size) || 0));
      } else {
        // A terminal order reports no placed size; a full fill's filled size is it.
        const status = await adapter.getOrder(orderId).catch(() => null);
        if (status && isFilledStatus(status)) placedQty = Number(status.filledSize) || 0;
      }
      if (!(placedQty > 0)) {
        if (!reportOnly) {
          logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: ledger holds ${roundAsset(measure.shortfall)} ${baseCurrency} its bodies do not record, but the order's placed size is unknown — left for manual review`, { orderId });
        }
        continue;
      }
      const everBooked = placedQty - (Number(entry.assetQty) || 0);
      const buyRows = fillLedger.getFillsForOrder(orderId).filter(f => f.side === 'buy' && f.size > 0);
      if (reportOnly) {
        // No live body owns the order and gone bodies stamped every row of it
        // (issue #772). Book only when the closed trades prove what those
        // bodies held AND that agrees with the entry's own measure; anything
        // short of that is reported for manual review.
        const gap = roundAsset(ledger.size - everBooked);
        if (!(gap > EPS)) continue;
        const details = { orderId, placedQty, entryQty: entry.assetQty, ledgerQty: ledger.size };
        const proof = provenGoneBodyHolding(orderId, ledger);
        if (!('heldQty' in proof)) {
          logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: ledger holds ${gap} ${baseCurrency} more than its tracked remainder says was ever booked, and no live body owns the order — possibly a tranche a closed body never held, but ${proof.reason}; manual review required`, { ...details, reason: proof.reason });
          continue;
        }
        const closedGap = roundAsset(ledger.size - proof.heldQty);
        if (Math.abs(closedGap - gap) > HOLDING_TOLERANCE) {
          // The entry shrank for more or less than the closed bodies held: a
          // body committed without the shrink, or one gone without a sale.
          logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: its tracked remainder says ${gap} ${baseCurrency} was never booked, but the closed bodies that held it leave ${closedGap} ${baseCurrency} — the measures disagree, manual review required`, { ...details, heldQty: proof.heldQty });
          continue;
        }
        const qty = roundAsset(Math.min(gap, closedGap));
        // The missed rows are not identifiable, and no live tranche's cost can
        // be subtracted out: the order's average stands in.
        const body = bookMissedTranche({ list, orderId, qty, unitCost: ledger.cost / ledger.size, buyRows });
        recovered++;
        logger.warn(`🔧 [${exchange}] Entry ${orderId.slice(0, 8)}: booked ${qty} ${baseCurrency} the ledger held but neither a live body nor the closed bodies that owned the order recorded (pre-#671 startup ingest) → body ${body.id.slice(-8)} @ ${fmtPrice(body.avgPrice)}`, {
          ...details, bodyId: body.id, qty, costBasis: body.costBasis, heldQty: proof.heldQty,
        });
        continue;
      }
      if (everBooked < measure.trancheQty - EPS) {
        logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: its tracked remainder says ${roundAsset(Math.max(0, everBooked))} ${baseCurrency} was booked, less than its bodies hold (${roundAsset(measure.trancheQty)}) — cannot prove the ${roundAsset(measure.shortfall)} ${baseCurrency} gap unbooked, left for manual review`, { orderId, placedQty, entryQty: entry.assetQty, trancheQty: measure.trancheQty });
        continue;
      }
      const qty = roundAsset(Math.min(measure.shortfall, ledger.size - everBooked));
      if (!(qty > EPS)) {
        // Bodies miss part of the ledger but the entry says it was all booked:
        // most likely a pre-#607 sale by a body that is gone.
        logger.info(`ℹ️ [${exchange}] Entry ${orderId.slice(0, 8)}: bodies hold ${roundAsset(measure.shortfall)} ${baseCurrency} less than its ledger, but its tracked remainder shows nothing unbooked — nothing booked (review manually if it persists)`, { orderId, placedQty, entryQty: entry.assetQty, ledgerQty: ledger.size });
        continue;
      }
      if (goneBodySaleMayHold(orderId, ledger)) {
        logger.warn(`⚠️ [${exchange}] Entry ${orderId.slice(0, 8)}: bodies hold ${roundAsset(measure.shortfall)} ${baseCurrency} less than its ledger, but a closed body may have sold part of it before consumption records existed — cannot prove the gap unbooked, manual review required`, { orderId, placedQty, entryQty: entry.assetQty, ledgerQty: ledger.size });
        continue;
      }

      // The missed tranche's cost is what the order cost beyond the tranches
      // bodies hold, when that residual is exactly the missed tranche (no
      // gone body's share mixed in) and its tranche records are sane (a
      // fill-price spread bounds the residual). Otherwise the order's average
      // stands in.
      const rowUnitCosts = buyRows.map(f => ((f.quoteAmount || 0) + (f.netFee || 0)) / f.size);
      const residualQty = ledger.size - measure.trancheQty;
      const residualUnit = Math.abs(residualQty - qty) <= EPS ? (ledger.cost - measure.trancheCost) / residualQty : NaN;
      const unitCost = residualUnit >= Math.min(...rowUnitCosts) * (1 - 1e-6) && residualUnit <= Math.max(...rowUnitCosts) * (1 + 1e-6)
        ? residualUnit
        : ledger.cost / ledger.size;
      const body = bookMissedTranche({ list, orderId, qty, unitCost, buyRows });
      recovered++;
      logger.warn(`🔧 [${exchange}] Entry ${orderId.slice(0, 8)}: booked ${qty} ${baseCurrency} the ledger held but no body recorded (pre-#671 startup ingest) → body ${body.id.slice(-8)} @ ${fmtPrice(body.avgPrice)}`, {
        orderId, bodyId: body.id, qty, costBasis: body.costBasis, placedQty, trancheQty: measure.trancheQty, ledgerQty: ledger.size,
      });
    }
    if (recovered > 0) {
      celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      saveLiveState();
    }
    return recovered;
  };

  /**
   * What a PRE-#607 buy order had already lost before its first consumption
   * record: everything the ledger bought on it that no live tranche still
   * holds open. Only the tranches of the body being sold are in the plan, but
   * an order filled in advancing partials can be split across bodies, one of
   * them closed long ago under sellOrderId closure — seeding from this body
   * alone would read that sold part as open forever. Orders whose every
   * tranche was created under #607 (finite `consumedQty`) are not seeded this
   * way: for them, ledger quantity no tranche holds is genuinely unsold and
   * must stay visible.
   *
   * For pre-#607 orders this is deliberately the conservative reading: the
   * ledger cannot tell a tranche another body sold from one no body ever
   * attributed (the leaked 1.14 ETH), so both keep their legacy "closed"
   * status. Resurrecting the second kind would double count inventory the
   * operator already adopted into a body (scripts/adopt-untracked-asset.js,
   * which is how that gap is repaired), and resurrecting the first would leave
   * a permanent phantom. The exchange-balance coverage check still sees it.
   * @param {{orders: Map<string, Object>, entries: Array<{entry: Object}>}} plan
   * @param {(orderId: string) => (Object|null)} consumptionOf - Cached getBuyOrderConsumption
   * @param {(entry: Object) => number} legacyFraction
   * @returns {Map<string, number>} orderId → seed, only for legacy orders
   */
  const legacyConsumptionSeeds = (plan, consumptionOf, legacyFraction) => {
    const seeds = new Map();
    const tranchesByOrder = new Map();
    const seen = new Set();
    const addTranche = (entry) => {
      if (!entry || seen.has(entry) || !plan.orders.has(entry.orderId)) return;
      seen.add(entry);
      if (!tranchesByOrder.has(entry.orderId)) tranchesByOrder.set(entry.orderId, []);
      tranchesByOrder.get(entry.orderId).push(entry);
    };
    for (const { entry } of plan.entries) addTranche(entry);
    for (const body of (positionState.celestialBodies || [])) {
      for (const entry of (body.buyOrders || [])) addTranche(entry);
    }
    for (const [orderId, tranches] of tranchesByOrder) {
      const ledger = consumptionOf(orderId);
      if (!ledger || ledger.consumedBy) continue;
      if (tranches.every(t => Number.isFinite(t.consumedQty))) continue;
      const openAll = tranches.reduce((sum, t) => {
        const size = Number(t.assetQty) || 0;
        const prior = Number.isFinite(t.consumedQty) ? t.consumedQty : size * legacyFraction(t);
        return sum + Math.max(0, size - prior);
      }, 0);
      seeds.set(orderId, Math.max(0, ledger.size - openAll));
    }
    return seeds;
  };

  /**
   * Record on the fill ledger which buy orders a body sale consumed, and how
   * much of each (issue #607). This is what lets computeRealizedFromCyclePairs
   * hold the unsold remainder of a partly-sold buy order open instead of
   * reading `sellOrderId` as "fully closed". The consumption is spread over
   * the body's tranches (`body.buyOrders`) by celestialHierarchy.planBodyConsumption,
   * and each tranche's `consumedQty` is advanced to match.
   *
   * Call BEFORE the body's assetQty/costBasis are reduced for this sale.
   * @param {Object} args
   * @param {Array} args.entries - The tranches the sold TP covered (body.buyOrders)
   * @param {number} args.bodyQty - Body assetQty before this sale
   * @param {number} args.qty - Base quantity consumed: sold + booked holdback
   * @param {boolean} args.closesBody - The sale closed the TP's body: every
   *   tranche it covered is consumed in full
   * @param {string} args.sellOrderId
   * @param {string} args.bodyId - For logging
   * @param {boolean} [args.additive] - A second booking of the same sell
   *   order (issue #777): add to its consumption instead of replacing it
   * @returns {void} Buys with no open tranche stay on legacy sellOrderId /
   *   consumedCostFraction closure.
   */
  const recordBodyConsumption = ({ entries, bodyQty, qty, closesBody, sellOrderId, bodyId, additive = false }) => {
    // getBuyOrderConsumption scans the whole ledger; a collapsed body can hold
    // hundreds of tranches, so look each order up once per sale.
    const consumptionCache = new Map();
    const consumptionOf = (orderId) => {
      if (!consumptionCache.has(orderId)) consumptionCache.set(orderId, fillLedger.getBuyOrderConsumption(orderId));
      return consumptionCache.get(orderId);
    };
    const legacyFraction = (entry) => consumptionOf(entry.orderId)?.consumedCostFraction ?? 0;
    const plan = celestialHierarchy.planBodyConsumption(entries, bodyQty, qty, legacyFraction, { closesBody });
    if (plan) {
      // Before the tranches advance: the seeds read their pre-sale state.
      const legacySeeds = legacyConsumptionSeeds(plan, consumptionOf, legacyFraction);
      for (const { entry, next } of plan.entries) entry.consumedQty = roundAsset(next);
      for (const [orderId, { delta, prior }] of plan.orders) {
        if (delta > 0) fillLedger.recordBuyConsumption(orderId, sellOrderId, delta, legacySeeds.get(orderId) ?? prior, { additive });
      }
    }
    const coverage = plan ? plan.coverage : 0;
    if (coverage < 0.99) {
      logger.warn(
        `⚠️ [${exchange}] Body ${String(bodyId).slice(-8)} tranches account for ${(coverage * 100).toFixed(1)}% of its ${roundAsset(bodyQty)} ${baseCurrency} — the rest of sale ${String(sellOrderId).slice(0, 8)} is not recorded per buy order (legacy closure)`,
        { bodyId, sellOrderId, bodyQty, qty, coverage, tranches: (entries || []).length }
      );
    }
  };

  /**
   * Compose a body sale's consumed-cost ratio into each source buy's OWN
   * consumedCostFraction (issue #704) — the legacy fallback for buys a sale
   * cannot record per order. Stamping one body-level scalar on every buy
   * retroactively charged a buy folded in after an earlier partial sale with
   * that sale's consumption.
   *
   * Skips every buy the per-order model tracks: one with a consumedBy record
   * (the fraction is ignored for it) or a tranche with a `consumedQty` (it
   * would seed that tranche's first record, charging it twice — and a fold-in
   * a merge-snapshot TP never covered must not be charged at all).
   * @param {Object} body - Body whose source buys to annotate
   * @param {number} ratio - Fraction of the pool's remaining cost this sale removed
   */
  const stampConsumedCostFraction = (body, ratio) => {
    const tracked = new Set((body.buyOrders || [])
      .filter(e => e && e.orderId && (Number(e.assetQty) || 0) > 0 && Number.isFinite(e.consumedQty))
      .map(e => e.orderId));
    for (const srcId of new Set([
      ...(body.sourceOrderIds || []),
      ...((body.buyOrders || []).map(b => b.orderId)),
    ])) {
      if (!srcId || srcId === 'core-migration' || tracked.has(srcId)) continue;
      const prior = fillLedger.getBuyOrderConsumption(srcId);
      if (!prior || prior.consumedBy) continue;
      fillLedger.annotateFillsByOrderId(srcId, {
        consumedCostFraction: 1 - (1 - (prior.consumedCostFraction ?? 0)) * (1 - ratio),
      });
    }
  };

  /**
   * Handle order fill
   * @param {Object} fillData - Fill data
   */
  const handleOrderFillImpl = async (fillData, dedupRef) => {
    // dedupRef is a per-call holder: the buy/sell branches record the inner
    // dedup key they add ({ set, key }) into it so the wrapper can clear that
    // key if processing throws. A per-call object (not a shared closure var)
    // keeps this correct even if two handleOrderFill calls interleave across
    // awaits (WS vs polling).
    // An open partial buy must remain in BOTH pending-order stores: the
    // executor map drives future polls and the position list survives restart.
    // CANCELLED-with-execution is terminal even when isPartialFill is true.
    const keepEntryTracked = fillData.isPartialFill
      && fillData.side?.toLowerCase() === 'buy' && !isTerminalStatus(fillData);
    // Snapshot the legacy core TP id BEFORE any await (issue #672): a
    // concurrent fill's resetCycle() nulls positionState.activeTpOrderId, and
    // the untracked-sell branch below must still recognise this order as the
    // engine's own TP when deciding whether it may close the cycle.
    const entryCoreTpOrderId = positionState.activeTpOrderId;
    // Freeze a partially-filled sell before resizing — see cancelPartialFillOrder.
    if (fillData.isPartialFill && fillData.side?.toLowerCase() === 'sell') {
      const cancellation = await cancelPartialFillOrder({ adapter, exchange, pair: productId }, fillData.orderId);
      if (!cancellation.cancelled) {
        throw new Error(`Partial TP ${fillData.orderId} cancellation unresolved; retry reconciliation`);
      }
      // The sell may have advanced or fully filled while cancellation was in flight.
      const knownFilledSize = fillData.filledSize || 0;
      fillData = buildPartialFillData(fillData.orderId, 'sell', cancellation.order, {
        isPartialFill: !isFilledStatus(cancellation.order),
        totalFees: cancellation.order.totalFees,
        source: fillData.source,
      });
      // Some exchanges omit cumulative filledSize on a CANCELLED status (the
      // executor then reports its polled high-water mark instead). Filled size
      // only grows, so never let the frozen status undercut a size the caller
      // already knew — the trade-level fill check below still has to match it.
      const statusOmittedSize = !(parseFloat(cancellation.order.filledSize) > 0);
      if (!(fillData.filledSize >= knownFilledSize)) fillData.filledSize = knownFilledSize;
      // Require the final fill set before accounting; never synthesize a stale
      // partial from the pre-cancel poll while the fills endpoint catches up.
      const finalFills = await adapter.getOrderFills(fillData.orderId);
      const finalSize = finalFills.reduce((sum, fill) => sum + Number(fill.size || 0), 0);
      // With no size on the status, the known size may be only the executor's
      // polled high-water mark, below the true final fill. The trade-level
      // fills are then the best evidence — accept them when they cover at
      // least what was known, or the size check below throws on every retry.
      if (statusOmittedSize && Number.isFinite(finalSize) && finalSize > 0 && finalSize >= knownFilledSize - 1e-8) {
        fillData.filledSize = finalSize;
      }
      if (!(fillData.filledSize > 0) || !Number.isFinite(finalSize) || Math.abs(finalSize - fillData.filledSize) > 1e-8) {
        throw new Error(`Partial TP ${fillData.orderId} final fills incomplete; retry reconciliation`);
      }
      fillData.confirmedFills = finalFills;
      // A body TP that executed its whole planned size is a completed TP,
      // not a partial, even when the exchange reports it CANCELLED (or still
      // OPEN with a sub-1% sliver, now frozen) and carries no
      // completionPercentage for isFilledStatus to read. Without this, the
      // reconcile / startup partial routes force the partial branch: the
      // designed holdback stays an active body and is re-listed for sale
      // (issue #744). Same classification as bookTpCancelExecution (#670).
      if (fillData.isPartialFill) {
        const tpBody = (positionState.celestialBodies || []).find(b => b.tpOrderId === fillData.orderId);
        if (isFullTpExecution(tpBody, fillData.filledSize)) fillData.isPartialFill = false;
      }
    }

    // getOrderFills now rejects (issue #679) instead of silently returning a
    // partial/empty set when the order-detail/status lookup fails or the
    // matched fills fall short of the exchange's own filled quantity. A
    // throw and an empty array both mean "we could not confirm the real
    // trade-level fills," so treat them the same: fall through to the
    // existing empty-rawFills retry, and ultimately the order-status
    // synthetic-fill fallback below (originally built for Coinbase's
    // empty-array eventual-consistency case) — that fallback is the
    // pre-existing safety net for exactly this situation, sourced from
    // fillData (order status, from a SEPARATE already-succeeded
    // adapter.getOrder call), never from the failed getOrderFills call.
    let rawFills;
    if (fillData.confirmedFills) {
      rawFills = fillData.confirmedFills;
    } else {
      try {
        rawFills = await adapter.getOrderFills(fillData.orderId);
      } catch (err) {
        logger.warn(
          `⚠️ [${exchange}] getOrderFills failed for ${fillData.orderId}: ${err.message} — will retry once, then fall back to order-status data if it still fails`,
          { orderId: fillData.orderId, side: fillData.side, error: err.message, incompleteFills: err.incompleteFills === true }
        );
        rawFills = [];
      }
    }

    // If getOrderFills returned empty (either because it legitimately found no
    // fills yet, or because it just threw above), but we have fill data from
    // order status (polling detection), retry once after a short delay -
    // Coinbase has eventual consistency, and Crypto.com/Gemini's own scan may
    // need a moment longer than getOrderFills' internal retry budget.
    if (rawFills.length === 0 && fillData.filledSize > 0) {
      logger.info(
        `⏳ [${exchange}] No fills yet for ${fillData.orderId}, retrying in 2s (status shows ${fillData.filledSize} filled)`,
        { orderId: fillData.orderId, side: fillData.side, filledSize: fillData.filledSize, retryDelayMs: 2000 }
      );
      await new Promise(r => setTimeout(r, 2000));
      try {
        rawFills = await adapter.getOrderFills(fillData.orderId);
      } catch (err) {
        logger.warn(
          `⚠️ [${exchange}] getOrderFills still failing for ${fillData.orderId} after the retry: ${err.message} — falling back to order-status data`,
          { orderId: fillData.orderId, side: fillData.side, error: err.message, incompleteFills: err.incompleteFills === true }
        );
        rawFills = [];
      }
    }

    // Get order placement time for fill time tracking (entry orders only)
    // Use placedAt from fillData (polling callback) or fall back to order executor lookup
    const orderPlacedAt = fillData.side.toLowerCase() === 'buy'
      ? (fillData.placedAt || orderExecutor.getOrderPlacedAt(fillData.orderId))
      : null;

    // The live cycle these rows are stamped with — the buy branch compares it
    // at commit time to detect a cycle turnover mid-pass (issue #711).
    const ingestCycleId = fillLedger.getCurrentCycleId();

    // Ingest each fill and collect the normalized fills
    const ingestedFills = [];
    for (const fill of rawFills) {
      const result = fillLedger.ingestFill(fill, orderPlacedAt);
      if (result.fill) {
        ingestedFills.push(result.fill);
      }
    }

    // Use ingested fills (which have quoteAmount) for aggregation
    // Fall back to getting fills from ledger if all were duplicates
    let fillsToAggregate = ingestedFills.length > 0
      ? ingestedFills
      : fillLedger.getFillsForOrder(fillData.orderId);

    // Last resort: if the order's CUMULATIVE ledger total for this orderId
    // (everything ever ingested for it, including whatever the loop above
    // just added) still falls short of what order status says filled,
    // synthesize a fill for the GAP rather than the whole size. Deliberately
    // compares against the cumulative LEDGER total, not fillsToAggregate —
    // fillsToAggregate is this PASS's delta only (by design: an advancing
    // partial's ingestedFills naturally excludes already-ingested rows via
    // ingestFill's tradeId dedup), so comparing filledSize (a cumulative
    // order-status figure) against it would misfire on every ordinary
    // advancing partial, treating its by-design-partial "delta" as a false
    // shortfall. This covers two cases the same way: no prior fills at all
    // (ledgerTotal=0, gap=the full filledSize — the original Coinbase
    // eventual-consistency case this fallback was built for) AND an order a
    // body already partially owns from an earlier partial fill, whose
    // TERMINAL rescan then failed (ledgerTotal=the earlier partial only,
    // gap=the newly-filled remainder) — issue #679 follow-up, codex
    // convergence review: previously a failed terminal rescan fell back to
    // the stale ledger-only total, and shouldSkipBuyRecommit (below) then
    // retired the order as "already owned, nothing new" without ever
    // booking the remainder — the exchange's larger filledSize never
    // reached the position model.
    // Gate gap synthesis to TERMINAL fills only (Claude convergence review,
    // round 4): a still-live partial (keepEntryTracked) must stay
    // retryable, never synthesized. Without this gate, an advancing
    // partial whose getOrderFills failed would synthesize the gap as a
    // phantom row under a fixed tradeId; once a LATER poll succeeds and
    // ingests the real trade (a genuinely different tradeId), the phantom
    // row is never retired, and the body/ledger over-state by the
    // phantom's size. A terminal fill has no "later real poll" to
    // reconcile against — this is the final word on that order — so
    // synthesizing its gap is safe (and is exactly the case this fallback
    // exists for: no more retries will ever arrive to supersede it).
    const isTerminalFill = isTerminalStatus(fillData);
    const existingFillsForOrder = fillLedger.getFillsForOrder(fillData.orderId);
    const ledgerTotalForOrder = existingFillsForOrder.reduce((sum, f) => sum + Number(f.size || 0), 0);
    const fillGap = fillData.filledSize > 0 ? fillData.filledSize - ledgerTotalForOrder : 0;
    if (isTerminalFill && fillGap > 1e-9 && fillData.averageFilledPrice > 0) {
      logger.warn(
        `⚠️ [${exchange}] Using order status data as fallback for ${fillData.orderId}: gap ${fillGap} of ${fillData.filledSize} @ ${fmtPrice(fillData.averageFilledPrice)}`,
        {
          orderId: fillData.orderId,
          side: fillData.side,
          filledSize: fillData.filledSize,
          ledgerTotalForOrder,
          fillGap,
          averageFilledPrice: fillData.averageFilledPrice,
        }
      );
      // fillData.totalFees is CUMULATIVE for the whole order (Coinbase's
      // getOrder() reports the running total, not a per-poll delta) — the
      // fee owed on JUST this gap is that cumulative figure minus whatever
      // fee prior fills for this order already booked, never the whole
      // cumulative figure again (codex convergence review, round 5: the
      // prior version zeroed the fee whenever ledgerTotalForOrder > 0,
      // silently dropping the new tranche's fee to $0 instead of crediting
      // the unbooked delta). When there is no prior partial, this
      // collapses to the full cumulative fee, matching the original
      // no-prior-fills case.
      const alreadyBookedFees = existingFillsForOrder.reduce((sum, f) => sum + Number(f.netFee || 0), 0);
      const feeDelta = Math.max(0, (fillData.totalFees || 0) - alreadyBookedFees);
      const syntheticFill = {
        // Suffixed with the cumulative filledSize (not a bare per-orderId
        // id): a later pass computing a DIFFERENT (larger) gap for the
        // same order must ingest as a genuinely new row, not silently
        // no-op as a duplicate of an earlier, smaller gap.
        tradeId: `synthetic-${fillData.orderId}-${fillData.filledSize}`,
        orderId: fillData.orderId,
        side: fillData.side.toLowerCase(),
        price: fillData.averageFilledPrice,
        size: fillGap,
        quoteAmount: fillGap * fillData.averageFilledPrice,
        // Carry the known fee in BOTH fee and netFee so ingestFill persists it
        // instead of defaulting to 0 (issue #210-C).
        totalFees: feeDelta,
        netFee: feeDelta,
        timestamp: Date.now(),
      };
      // Ingest synthetic fill into ledger. result.fill is null when
      // ingestFill treats this exact tradeId as an already-seen duplicate
      // (e.g. a retry that re-computed the identical gap) — in that case
      // NOTHING new actually landed in the ledger this pass, so
      // fillsToAggregate/ingestedFills must NOT be credited with it either:
      // doing so (as an earlier round of this fix did, falling back to the
      // raw un-ingested syntheticFill object) let the body absorb the gap
      // every such pass while the ledger only ever recorded it once —
      // codex convergence review, round 4. When it DOES ingest, this
      // becomes fillsToAggregate's ONLY entry (never old-rows-plus-gap):
      // downstream "advancing partial" handling ADDS summary.totalSize
      // onto the EXISTING body's assetQty, mirroring the success path
      // where ingestedFills already contains only the NEW delta —
      // aggregating the stale rows too would double-count what they
      // already contributed when first ingested. Also count it in
      // ingestedFills — gates shouldSkipBuyRecommit below, so an order a
      // body already owns is not treated as "nothing new" when this gap
      // fill is exactly the new thing.
      const result = fillLedger.ingestFill(syntheticFill, orderPlacedAt);
      if (result.fill) {
        fillsToAggregate = [result.fill];
        ingestedFills.push(result.fill);
      } else {
        logger.info(
          `ℹ️ [${exchange}] Gap fill for ${fillData.orderId} already ingested — nothing new to aggregate this pass`,
          { orderId: fillData.orderId, fillGap }
        );
      }
    }

    // Determine if buy or sell
    if (fillData.side.toLowerCase() === 'buy') {
      // Nothing to book this pass — no new fills were ingested, nothing was
      // already in the ledger for this orderId to fall back on, AND gap
      // synthesis either didn't apply (gated to terminal fills only) or
      // found no gap. Falling through would aggregateFills([]) into a
      // ZERO-value summary and still commit a body off it below: assetQty/
      // costBasis 0, cycleBuys incremented, lastEntryPrice set to 0,
      // buy_filled emitted, and findMergeTarget free to cancel/re-place a
      // REAL body's TP against a phantom candidate price of 0 (Claude delta
      // review, round 6). fillsToAggregate falls back to
      // getFillsForOrder(orderId) whenever nothing new was ingested, so an
      // empty result here also guarantees ledgerTotalForOrder was 0 —
      // i.e. this orderId owns no body yet, so bailing out cannot strand an
      // advancing partial or duplicate an already-committed buy (that case
      // is instead handled by shouldSkipBuyRecommit below, which only runs
      // once fillsToAggregate/summary are known non-degenerate).
      if (fillsToAggregate.length === 0) {
        if (isTerminalFill) {
          // A terminal order with genuinely no discoverable fills is an
          // anomaly, not a normal "still filling" state — throw so the
          // engine-level bounded retry (isTerminalStatus gate in
          // onFillDetected's catch) or the startup catch-up path re-arms
          // it, rather than silently committing nothing and losing the
          // fill.
          throw Object.assign(
            new Error(`[${exchange}] No fills available to book for terminal buy order ${fillData.orderId} (status shows ${fillData.filledSize} filled) — refusing to commit a zero-value body`),
            { incompleteFills: true }
          );
        }
        logger.info(
          `⏳ [${exchange}] No fills to aggregate yet for still-live buy ${fillData.orderId} (status shows ${fillData.filledSize} filled) — leaving retryable for the next poll/reconcile`,
          { orderId: fillData.orderId, filledSize: fillData.filledSize }
        );
        return;
      }

      // Every row we hold for this order was already booked by a body that is
      // gone now (its TP sold it, or it was otherwise retired) while the entry
      // kept resting — and this pass brought nothing new. Falling through
      // would rebuild a body from those settled rows (the getFillsForOrder
      // fallback above) and list a TP for asset that was already sold. The
      // first poll after a restart lands here: the executor's partial-size
      // tracker starts at 0, so the order's unchanged filledSize reads as an
      // advance (issue #671).
      // Rows no body booked yet (if any) are still booked on their own.
      if (ingestedFills.length === 0
        && !isBuyAlreadyCommitted(positionState.celestialBodies, fillData.orderId)) {
        const unsettled = fillsToAggregate.filter(isUnsettledBuyRow);
        if (unsettled.length === 0) {
          logger.info(`⏭️ [${exchange}] Buy ${fillData.orderId} holds only tranches a retired body already settled and no new fills — nothing to book`);
          if (!keepEntryTracked) {
            retireTrackedEntry(fillData.orderId);
            orderExecutor.handleOrderFill(fillData.orderId);
          }
          return;
        }
        fillsToAggregate = unsettled;
      }

      // Buy-fill dedup across WS vs polling. Without it, a buy detected by both
      // the polling path (which starts the multi-hundred-ms handleOrderFill
      // chain, incl. a possible 2s retry) and a late WS FILLED event for the
      // same order would run the buy branch twice — falling back to the full
      // getFillsForOrder set on the second pass and creating a duplicate body
      // at full size (cycleBuys double-incremented). Mirrors the sell dedup.
      // For partials, key on filled size so an advancing partial still processes.
      const buyDedupKey = makeFillDedupKey(fillData.orderId, keepEntryTracked, fillData.filledSize);
      if (recentlyProcessedBuyFills.has(buyDedupKey)) {
        logger.info(`⏭️ [${exchange}] Buy fill already processed, skipping: ${buyDedupKey}`);
        return;
      }
      recentlyProcessedBuyFills.add(buyDedupKey);
      if (dedupRef) { dedupRef.set = recentlyProcessedBuyFills; dedupRef.key = buyDedupKey; }
      const tb = setTimeout(() => { recentlyProcessedBuyFills.delete(buyDedupKey); ttlTimers.delete(tb); }, 5 * 60 * 1000);
      ttlTimers.add(tb);

      // Idempotency guard against a RETRY that already committed this buy
      // (issue #131). The dedup key above is CLEARED when handleOrderFill throws
      // (so a transient failure on the early getOrderFills fetch can retry), but
      // cycleBuys++ and celestialBodies.push() below mutate in-memory state that
      // ingestFill's tradeId dedup does NOT protect. If a prior attempt threw
      // AFTER committing the body (e.g. placeBodyTp rejected), the next reconcile/
      // poll re-runs this branch and would double-count: a second cycleBuys and a
      // duplicate body for the same buyOrderId (→ duplicate TP).
      //
      // CRITICAL: gate on ingestedFills.length === 0. A retry brings NO new
      // fills (ingestFill is idempotent by tradeId, so the re-fetch dedups and
      // fillsToAggregate falls back to the full getFillsForOrder set) — that is
      // the only case we must skip. An ADVANCING PARTIAL buy fill, by contrast,
      // brings new trade rows (ingestedFills.length > 0) and MUST process even
      // though a body already owns the orderId — otherwise the later tranche is
      // dropped from the body / TP sizing and computeRealizedFromCyclePairs
      // (which aggregates buys by orderId) under-reports its cost. Without this
      // gate the orderId-only guard would swallow every advancing partial.
      if (shouldSkipBuyRecommit(ingestedFills.length, positionState.celestialBodies, fillData.orderId)) {
        logger.info(`⏭️ [${exchange}] Buy ${fillData.orderId} already owned by a body and no new fills ingested — skipping re-commit (retry after partial failure); reconcile will repair any missing TP`);
        // The re-commit is what's redundant, not the bookkeeping. A TERMINAL
        // status can land here when the partial poll already ingested every fill
        // row the exchange had exposed, and returning outright would strand the
        // persisted pending-entry (and its share of deployedInPosition) until a
        // restart, even though the executor has already dropped the order.
        if (!keepEntryTracked) {
          retireTrackedEntry(fillData.orderId);
          orderExecutor.handleOrderFill(fillData.orderId);
        }
        return;
      }

      // Check if this is a ladder order fill (use positionState since polling may delete from pendingOrders before callback)
      const isLadderFill =
        (positionState.pendingLadderOrders &&
          positionState.pendingLadderOrders.some(o => o.orderId === fillData.orderId)) ||
        orderExecutor.isLadderOrder(fillData.orderId);

      const summary = fillLedger.aggregateFills(fillsToAggregate);

      // Was this exchange order ALREADY represented by a body before this pass?
      // An advancing partial (orderId already owned, new fills this pass) must
      // process its new tranche but must NOT consume a second cycleBuys step —
      // cycleBuys counts buy ORDERS filled in the cycle, and one order that
      // fills across multiple events is a single buy (codex P2). A brand-new
      // order increments; an advancing partial only refreshes entry tracking.
      const orderAlreadyOwned = isBuyAlreadyCommitted(positionState.celestialBodies, fillData.orderId);

      // Commit the cycleBuys/lastEntry counter exactly once, at the point the
      // body that owns this orderId is committed (issue #131). Idempotent within
      // a single handleOrderFill call via committedBuyCounter; the gated guard
      // above prevents a separate retry from re-entering after a body exists.
      let committedBuyCounter = false;
      const commitBuyCounter = () => {
        if (committedBuyCounter) return;
        committedBuyCounter = true;
        // Only a genuinely new buy order advances the cycle-buy count; an
        // advancing partial of an already-owned order refreshes entry tracking
        // without re-counting the order (codex P2).
        if (!orderAlreadyOwned) positionState.cycleBuys += 1;
        positionState.lastEntryPrice = summary.avgPrice;
        positionState.lastEntryTime = Date.now();
        // A resetCycle can start a new cycle while this pass awaits between
        // ingest and commit (a TP close racing a ladder-cancel booking, or any
        // concurrent fill). The body — and the step counted above — land in
        // the NEW cycle, so the rows it books must too; left under the closed
        // cycle, a restart's ledger auto-correct would undo the step and the
        // buy would sit in a cycle whose sell never consumed it (#711).
        //
        // A null ingestCycleId (a fresh ledger, no live cycle yet at ingest
        // time — the fund's first-ever cycle close) is a turnover too: the
        // truthy check below used to require BOTH ids, so this pass fell
        // through, the rows stayed stamped null, and a restart's ledger
        // auto-correct (folding by timestamp against activeCycleStartedAt)
        // never folds them in because they predate the cycle boundary —
        // cycleBuys silently drops by one and maxCycleBuys loosens (#774).
        // Comparing `f.cycleId === ingestCycleId` below already matches
        // null-tagged rows correctly when ingestCycleId is null, so only the
        // guard needed the `ingestCycleId &&` requirement dropped.
        const liveCycleId = fillLedger.getCurrentCycleId();
        if (liveCycleId && liveCycleId !== ingestCycleId) {
          // An advancing partial of an already-owned order skipped the
          // increment above (counted in the closed cycle); if the new cycle
          // has no row of it yet, this move makes it one of that cycle's buy
          // orders, so count it there too or the ledger and counter disagree.
          const liveHadOrder = fillLedger.getCurrentCycleFills()
            .some(f => f.side === 'buy' && f.orderId === fillData.orderId);
          let moved = 0;
          for (const f of fillsToAggregate) {
            if (f.side === 'buy' && f.cycleId === ingestCycleId && f.tradeId) {
              fillLedger.updateFillCycleId(f.tradeId, liveCycleId);
              moved++;
            }
          }
          if (moved > 0 && orderAlreadyOwned && !liveHadOrder) positionState.cycleBuys += 1;
          if (moved > 0) {
            logger.info(`🔀 [${exchange}] Cycle turned over while buy ${fillData.orderId} was booking — moved ${moved} fill(s) ${ingestCycleId} → ${liveCycleId}`, {
              orderId: fillData.orderId, fromCycleId: ingestCycleId, toCycleId: liveCycleId, moved,
            });
          }
        }
      };

      // Celestial hierarchy: create new buy descriptor
      const newBuy = {
        assetQty: summary.totalSize,
        costBasis: summary.totalValue + summary.totalFees,
        avgPrice: summary.avgPrice,
        buyOrderId: fillData.orderId,
      };

      // Calculate candidate TP price for merge proximity check
      const candidateTpPrice = roundPrice(summary.avgPrice * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

      // Find merge target among existing celestial bodies
      const bodies = positionState.celestialBodies || [];
      let mergeTarget = celestialHierarchy.findMergeTarget(
        bodies, newBuy, config.maxUsdcDeployed, candidateTpPrice,
        config.maxCelestialBodies || 10, orderExecutor.getPendingCounts().total, config.maxOpenOrders,
        config.mergeProximityScale ?? 1.0
      );

      // NOTE: cycleBuys / lastEntry* are committed AFTER the body is created or
      // merged below (issue #131). Incrementing here — before the merge-cancel
      // await (cancelBodyTpOrder) — meant a reject there left a stranded
      // cycleBuys++ with no body owning the orderId, which the
      // buyAlreadyCommitted guard above could not detect on retry, so the next
      // reconcile re-incremented. Deferring the counter to post-commit keeps the
      // increment and the body atomic with respect to a retry.

      const fillTypeLabel = isLadderFill ? '[LADDER] ' : '';

      // Partial-fill pre-check (mirror _mergeBodyImpl's guard, issue #201). If the
      // merge target's TP has ALREADY partially filled, merging would fold the new
      // buy onto the target's stale assetQty/costBasis (which still include the
      // sold tranche) — leaving the body claiming asset the account no longer
      // holds and double-attributing the sold tranche's cost. Don't merge; route
      // the buy to its own new body instead.
      if (mergeTarget && mergeTarget.tpOrderId) {
        const targetTpStatus = await adapter.getOrder(mergeTarget.tpOrderId).catch(() => null);
        if (targetTpStatus && targetTpStatus.filledSize > 0) {
          logger.warn(`⚠️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP partially filled (${targetTpStatus.filledSize} ${baseCurrency}) — routing buy to its own body (issue #201)`);
          mergeTarget = null;
        }
      }

      if (mergeTarget) {
        // Race 3: snapshot merge target before cancel in case TP fills in-flight
        if (mergeTarget.tpOrderId) {
          pendingMergeTpOrders.set(mergeTarget.tpOrderId, snapshotBody(mergeTarget));
        }
        const cancelResult = await orderExecutor.cancelBodyTpOrder(mergeTarget.id, mergeTarget.tpOrderId);
        const cancellationOutcome = classifyBodyTpCancellation(cancelResult);
        if (cancellationOutcome === 'filled' || cancellationOutcome === 'unresolved') {
          if (mergeTarget.tpOrderId) pendingMergeTpOrders.delete(mergeTarget.tpOrderId);
          logger.warn(`⚠️ [${exchange}] Body ${mergeTarget.id.slice(-8)} TP ${cancellationOutcome === 'filled' ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
          mergeTarget = null;
        } else if (cancellationOutcome === 'cancelled_with_execution') {
          // Partial-during-cancel race (issue #227): the pre-check above saw the
          // target TP clean, but it partially filled WHILE we were cancelling.
          // safeCancelOrder now surfaces the sold quantity via filledSize, so we
          // react to it directly instead of folding the buy onto the target's
          // now-stale assetQty/costBasis (which still include the just-sold
          // tranche). Mirror the pre-check: route the buy to its own body and
          // clear the cancelled TP. The Race-3 snapshot below carries the sold
          // tranche to the merge-snapshot sell handler, which deducts it from the
          // target and re-places a correctly-sized TP.
          logger.warn(`⚠️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP filled ${cancelResult.filledSize} ${baseCurrency} during cancel — routing buy to its own body (issue #227)`);
          const soldTp = mergeTarget.tpOrderId;
          // A WS/poll fill for soldTp that landed while this cancel was in
          // flight is handled by the merge-snapshot branch, which consumes the
          // pending snapshot and deducts the tranche from mergeTarget (issue
          // #770). Everything that handler ingested for soldTp is booked, so
          // the immediate booking below must only run for execution beyond
          // it: re-booking the same cumulative size against a fresh snapshot
          // of the already-deducted body double-counts the sale whenever the
          // two deliveries' dedup keys differ (a terminal event keys on the
          // bare orderId, this booking on orderId:size).
          // "Booked" means the handler committed its booking: the per-order
          // bodyBookedSize marker (issue #777), written synchronously with
          // the body mutation — not merely that the snapshot left the map (a
          // handler that threw after consuming it booked nothing) nor that
          // the order carries a bodyPnl from some other booking. Execution
          // beyond the marker is booked below, and adds to it.
          const snapshotConsumed = !!soldTp && !pendingMergeTpOrders.has(soldTp);
          const committedBooking = snapshotConsumed ? fillLedger.getSellBooking(soldTp) : null;
          const alreadyBookedSize = committedBooking && committedBooking.hasMarker ? committedBooking.bookedSize : 0;
          const skipImmediateBooking = snapshotConsumed
            && !((cancelResult.filledSize || 0) > alreadyBookedSize + 1e-9);
          if (skipImmediateBooking) {
            logger.info(
              `ℹ️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP ${soldTp.slice(0, 8)} execution (${cancelResult.filledSize} ${baseCurrency}) was already booked by its in-flight fill — not re-booking (#770)`,
              { orderId: soldTp, filledSize: cancelResult.filledSize, alreadyBookedSize }
            );
          }
          if (soldTp && !skipImmediateBooking) {
            pendingMergeTpOrders.delete(soldTp);
            completedMergeTpOrders.set(soldTp, snapshotBody(mergeTarget));
            const t = setTimeout(() => { completedMergeTpOrders.delete(soldTp); ttlTimers.delete(t); }, 300000);
            ttlTimers.add(t);
          }
          // Clear the cancelled TP so no body references a dead order; the
          // merge-snapshot handler re-places a right-sized TP after deducting.
          mergeTarget.tpOrderId = null;
          mergeTarget.tpPrice = 0;
          mergeTarget.assetOnOrder = 0;
          saveLiveState();
          // cancelBodyTpOrder has just removed this order from ALL executor
          // tracking (pendingOrders included) — a future poll can no longer find
          // it to discover the fill, and if this WS connection happens to also
          // be degraded right now, nothing else will ever invoke the
          // merge-snapshot sell handler above. We already have everything the
          // handler needs (cancelResult's fill details), so book it ourselves
          // immediately instead of hoping a WS event arrives (issue #227
          // follow-up). handleOrderFill's own dedup guard makes this safe even
          // if a WS/poll event for the same fill also arrives independently.
          if (soldTp && !skipImmediateBooking) {
            await handleOrderFill(buildPartialFillData(soldTp, 'sell', {
              status: 'CANCELLED',
              filledSize: cancelResult.filledSize,
              filledValue: cancelResult.filledValue,
              averageFilledPrice: cancelResult.averageFilledPrice,
            }, { totalFees: cancelResult.totalFees || 0 })).catch((err) => {
              logger.warn(
                `⚠️ [${exchange}] Failed to book merge-target partial fill for ${soldTp.slice(0, 8)} immediately: ${err.message} — relying on a later WS/poll event`,
                { orderId: soldTp, error: err.message }
              );
            });
          } else if (skipImmediateBooking && mergeTarget.assetQty > 0
            && (positionState.celestialBodies || []).includes(mergeTarget)) {
            // The in-flight fill's snapshot handler left the cancel and the
            // re-place to this continuation (it saw the body still pointing at
            // soldTp), and no booking will run to re-arm the deducted body.
            await placeBodyTp(mergeTarget);
          }
          mergeTarget = null;
        } else {
          // Cancel succeeded — move to completed with TTL
          if (mergeTarget.tpOrderId) {
            pendingMergeTpOrders.delete(mergeTarget.tpOrderId);
            completedMergeTpOrders.set(mergeTarget.tpOrderId, snapshotBody(mergeTarget));
            const t = setTimeout(() => { completedMergeTpOrders.delete(mergeTarget.tpOrderId); ttlTimers.delete(t); }, 300000);
            ttlTimers.add(t);
          }
          // Clear body TP fields so placeBodyTp can re-place after merge
          // (cancelBodyTpOrder only removes executor tracking, not body state)
          mergeTarget.tpOrderId = null;
          mergeTarget.tpPrice = 0;
          mergeTarget.assetOnOrder = 0;
          // Persist before re-place: a crash between cancel and new TP would
          // otherwise resurrect the orphaned tpOrderId on restart.
          saveLiveState();
        }
      }

      if (mergeTarget) {
        // MERGE: merge into existing body, possibly promote, re-place TP
        const merged = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed, undefined, logger);
        // Replace old body with merged body in array
        const idx = positionState.celestialBodies.findIndex(b => b.id === merged.id);
        if (idx !== -1) positionState.celestialBodies[idx] = merged;

        // Annotate merged buy fills with body metadata (matches new-body annotation at line ~1903)
        fillLedger.annotateFillsByOrderId(fillData.orderId, { isBodyOwned: true, bodyId: merged.id, bodyTier: merged.tier });

        // Check for cascading promotions
        celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);

        // Sync aggregate fields for backward compatibility
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        // Commit the buy counter NOW — atomic with the body merge, BEFORE the TP
        // await below (issue #131/#132 P3). If placeBodyTpWithRetry rejects after
        // this, the body already owns the orderId so the gated guard skips the
        // retry; the increment is preserved (not stranded). ingestedFills>0 here
        // means this is a real new tranche, not a retry.
        commitBuyCounter();

        await placeBodyTpWithRetry(merged, 'Merge');

        // Defense-in-depth: verify TP covers updated body size after merge
        if (merged.tpOrderId && merged.assetOnOrder > 0 && merged.tpPrice > 0) {
          const tierCfgCheck = celestialHierarchy.getTierConfig(merged.tier);
          const { sellQty } = positionSizer.calculateTakeProfitSize(
            merged.assetQty, merged.avgPrice, merged.tpPrice, tierCfgCheck.holdbackScale
          );
          if (Math.abs(sellQty - merged.assetOnOrder) > 0.00000001) {
            logger.warn(`⚠️ [${exchange}] Stale TP detected for body ${merged.id.slice(-8)}: onOrder=${merged.assetOnOrder}, expected=${sellQty} — cancelling for re-place`);
            if (await cancelBodyTpForReplace(merged, 'Post-merge stale-size') === 'cancelled') {
              await placeBodyTp(merged);
            }
          }
        }

        const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
        logger.info(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy merged into ${merged.tier}: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${merged.id.slice(-8)} (${merged.assetQty.toFixed(6)} ${baseCurrency}, avg=${fmtPrice(merged.avgPrice)})`);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `${fillTypeLabel}${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)} [merged→${merged.tier}]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          bodyId: merged.id,
          bodyTier: merged.tier,
          isMerge: true,
          isLadderFill,
        });
      } else {
        // NEW BODY: Create new celestial body with its own TP
        const body = celestialHierarchy.createNewBody(newBuy, fillData.orderId);
        positionState.celestialBodies = positionState.celestialBodies || [];
        positionState.celestialBodies.push(body);

        // Sync aggregate fields
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        // Commit the buy counter NOW — atomic with the body push, BEFORE the TP
        // await below (issue #131/#132 P3). A placeBodyTp rejection after this
        // leaves the body owning the orderId so the gated guard skips the retry
        // and the increment is preserved.
        commitBuyCounter();

        const bodyTpPlaced = await placeBodyTp(body);

        if (!bodyTpPlaced) {
          logger.warn(`⚠️ [${exchange}] Body TP placement failed for ${body.id.slice(-8)}, body persists without TP`);
        }

        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        logger.info(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy filled → created ${body.tier} body: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${body.id.slice(-8)}`);

        // Annotate buy fills with body metadata
        fillLedger.annotateFillsByOrderId(fillData.orderId, { isBodyOwned: true, bodyId: body.id, bodyTier: body.tier });

        tradeEvents.emitTradeEvent('buy_filled', exchange, `${fillTypeLabel}${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)} [new ${body.tier}]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          bodyId: body.id,
          bodyTier: body.tier,
          isLadderFill,
        });
      }

      // Safety net: commitBuyCounter is normally called inside the merge/new-body
      // branch (atomic with the body commit). This call is a no-op if already
      // committed; it only fires if some future path reached here without
      // committing a body — keeping cycleBuys consistent.
      commitBuyCounter();

      // Remove filled entry from persisted pending orders — but ONLY once the
      // order is terminal. A PARTIAL buy fill leaves the order live on the book
      // with an unfilled remainder; dropping it here left the in-memory
      // pendingOrders map as the sole tracking, so a restart (or any path that
      // clears it) orphaned the remaining tranche forever. Gemini has no
      // order-events WS, so `checkPendingOrderFills` over that map is the ONLY
      // detector of the order completing — nothing re-derives it from the
      // exchange. That leaked 1.204 ETH of ETHUSD buys across 61 fills before
      // it was caught; see docs/fill-ledger-sell-linkage.md.
      //
      // A partial keeps the order tracked but must SHRINK it to the unfilled
      // remainder: apy-calculator sums pendingEntryOrders' sizeUsdc into
      // deployedInPosition alongside the bodies' costBasis, so leaving the
      // original full size there double-counts the tranche already committed to
      // a body and under-reports availableCapital until the remainder fills.
      const entryIsTerminal = !keepEntryTracked;
      // Shrink by what this pass actually booked. `summary` covers only the new
      // fills when `ingestedFills` is non-empty, but falls back to ALL of the
      // order's fills otherwise — and on the synthetic-fill path that fallback
      // is reachable for a second partial (the synthetic row is ingested for
      // partial 1, so nothing is "new", yet no body owns the order and
      // shouldSkipBuyRecommit does not intercept). Subtracting the cumulative
      // size from an already-shrunk entry would double-count the first tranche.
      const bookedSize = ingestedFills.length > 0
        ? ingestedFills.reduce((sum, f) => sum + (f.size || 0), 0)
        : summary.totalSize;
      const bookedCost = ingestedFills.length > 0
        ? ingestedFills.reduce((sum, f) => sum + (f.size || 0) * (f.price || 0) + (f.netFee || 0), 0)
        : summary.totalValue + summary.totalFees;
      const shrinkTracked = (orders) => orders.map(o => (o.orderId !== fillData.orderId ? o : {
        ...o,
        assetQty: Math.max(0, (o.assetQty || 0) - bookedSize),
        sizeUsdc: Math.max(0, (o.sizeUsdc || 0) - bookedCost),
      }));

      if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
        positionState.pendingEntryOrders = entryIsTerminal
          ? positionState.pendingEntryOrders.filter(e => e.orderId !== fillData.orderId)
          : shrinkTracked(positionState.pendingEntryOrders);
      }

      // Same rule for a ladder rung: a partially filled rung is still resting on
      // the book, so it stays tracked — at its remaining size.
      if (isLadderFill && positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) {
        positionState.pendingLadderOrders = entryIsTerminal
          ? positionState.pendingLadderOrders.filter(o => o.orderId !== fillData.orderId)
          : shrinkTracked(positionState.pendingLadderOrders);
      }

      // Ladder orders stay in place on individual fills (no reprice).
      // Rebuild happens only after cycle reset.

      // Persist state immediately after buy fill to prevent loss on crash
      saveLiveState();
      fillLedger.persist();

    } else if (fillData.side.toLowerCase() === 'sell') {
      // Sell-fill dedup: skip if already processed (prevents double-processing across WS/reconcile/polling)
      // For partial fills, use a composite key with filled size to allow incremental processing
      const dedupKey = makeFillDedupKey(fillData.orderId, fillData.isPartialFill, fillData.filledSize);
      if (recentlyProcessedSellFills.has(dedupKey)) {
        logger.info(`⏭️ [${exchange}] Sell fill already processed, skipping: ${dedupKey}`);
        return;
      }
      recentlyProcessedSellFills.add(dedupKey);
      if (dedupRef) { dedupRef.set = recentlyProcessedSellFills; dedupRef.key = dedupKey; }
      const t1 = setTimeout(() => { recentlyProcessedSellFills.delete(dedupKey); ttlTimers.delete(t1); }, 5 * 60 * 1000);
      ttlTimers.add(t1);

      // An order that already committed a booking books only the rows no
      // booking covered yet (issue #777): whatever this pass ingested, plus
      // any row that reached the ledger another way (startup recovery, a
      // dedup-skipped delivery) — so that execution is booked, and added to
      // the committed booking, instead of re-booking every row of the order
      // as a replay. With nothing unbooked this IS a replay: all rows, as before.
      let sellRowsAreNew = ingestedFills.length > 0;
      const unbookedSellFills = fillLedger.getUnbookedSellFills(fillData.orderId);
      if (unbookedSellFills && unbookedSellFills.length > 0) {
        fillsToAggregate = unbookedSellFills;
        sellRowsAreNew = true;
      }
      const bookedTradeIds = fillsToAggregate.map(f => f.tradeId);

      // UNIFIED BODY TP FILL — find matching celestial body by TP order ID
      const summary = fillLedger.aggregateFills(fillsToAggregate);
      const booking = planSellBooking(fillData.orderId, summary.totalSize, sellRowsAreNew);

      // Race 3: check merge-snapshot maps first (fill arrived for body removed during merge)
      const mergeSnapshot = pendingMergeTpOrders.get(fillData.orderId)
        || completedMergeTpOrders.get(fillData.orderId);
      if (mergeSnapshot) {
        // Process fill using snapshot data — body was already merged/removed
        pendingMergeTpOrders.delete(fillData.orderId);
        completedMergeTpOrders.delete(fillData.orderId);

        const tierCfg = celestialHierarchy.getTierConfig(mergeSnapshot.tier);
        const proceeds = summary.totalValue - summary.totalFees;
        // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
        const soldRatio = mergeSnapshot.assetQty > 0 ? Math.min(summary.totalSize / mergeSnapshot.assetQty, 1) : 1;
        const proratedCostBasis = roundUSDC(mergeSnapshot.costBasis * soldRatio);
        const pnl = proceeds - proratedCostBasis;
        const { holdbackAsset, reservesSoldAsset } = splitTpHoldback(roundAsset(mergeSnapshot.assetQty - summary.totalSize));

        // Detect a TRUE partial fill of the snapshot's own TP — NOT "does the
        // live body still hold asset" (a healthy 100%-of-assetOnOrder fill
        // ALWAYS leaves designed holdback behind, per the holdback-vs-partial
        // distinction this codebase treats as load-bearing: summary.totalSize
        // === body.assetQty is never true on a healthy fill). Mirrors the
        // normal partial-fill path's isPartial check (:~3210) using
        // mergeSnapshot.assetOnOrder — the frozen size the cancelled/fired TP
        // was actually placed for (snapshotted before assetOnOrder is cleared
        // to 0 on cancel, both in the buy-merge race above and in
        // bookExecutionDuringCancel's roll-up snapshots). Deliberately does
        // NOT OR in `fillData.isPartialFill`: every caller that reaches this
        // branch via buildPartialFillData (the #227/#368 immediate
        // self-booking paths) hardcodes that flag to `true` regardless of
        // whether the fill was actually partial, so it is not a usable signal
        // here (unlike the normal path's other callers).
        const onOrder = mergeSnapshot.assetOnOrder || 0;
        // Same whole-inventory rule as the normal path (issue #770).
        const isPartialSnapshotFill = !(mergeSnapshot.assetQty > 0 && summary.totalSize >= mergeSnapshot.assetQty)
          && (onOrder > 0
            ? summary.totalSize < onOrder * 0.99
            : soldRatio < 0.95);

        // Deduct the sold tranche from the LIVE merged body (issue #201). If a buy
        // folded onto this body in the Race-3 window (between the partial-fill
        // pre-check and the TP cancel), the merged body still contains the qty/cost
        // this snapshot sell just realized. Without deducting, the body claims asset
        // the account no longer holds and the sold tranche's cost is double-counted
        // (once here via bodyPnl, once retained in the merged body's costBasis).
        const liveMerged = (positionState.celestialBodies || []).find(b => b.id === mergeSnapshot.id);
        // The body is still OPEN only when `liveMerged` exists AND this was a
        // true partial fill of its TP — a healthy complete-of-assetOnOrder
        // fill closes the cycle (reserves booked, bodiesCompleted counted)
        // exactly like the normal path, even though this branch never splices
        // the now-empty-of-obligation body out of celestialBodies (issue
        // #617/#669).
        const liveOwnsRemainder = !!liveMerged && isPartialSnapshotFill;

        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        if (!liveOwnsRemainder) cs.bodiesCompleted += 1;
        positionState.celestialState = cs;

        const prevMaxUsdc = creditCapitalGrowth(fillData.orderId, pnl, booking);

        orderExecutor.removeBodyTracking(fillData.orderId);

        // Record the consumption against the tranches the SNAPSHOT covered —
        // its buyOrders array is copied when the snapshot is taken, so a buy
        // folded onto the live body in the Race-3 window is not charged for a
        // TP it was never part of. The tranche objects themselves are shared
        // with the live body, which is what advances its consumedQty.
        //
        // Consume exactly what leaves a body. A true partial with the live body
        // still present consumes only the sold qty (the block below deducts
        // nothing else), so held cost keeps matching the bodies. A complete
        // fill closes the snapshot body even though its live object remains:
        // sold + booked holdback, every tranche it covered in full — and the
        // block below removes the same whole snapshot from the live body, so
        // the holdback is not also left in it as inventory (issue #718).
        // With no live body, the snapshot body closed only if no other body
        // holds its tranches (issue #607): a roll-up moves the snapshot's
        // tranche objects into the surviving target, so "the snapshot body's
        // id is gone" does not mean its asset left the model — a late fill of
        // the source's old TP (the completedMergeTpOrders window) must not
        // close tranches a live body still carries.
        const snapshotTranches = new Set(mergeSnapshot.buyOrders || []);
        const heldElsewhere = (positionState.celestialBodies || [])
          .some(b => (b.buyOrders || []).some(e => snapshotTranches.has(e)));
        const snapshotClosed = liveMerged ? !liveOwnsRemainder : !heldElsewhere;
        recordBodyConsumption({
          entries: mergeSnapshot.buyOrders,
          bodyQty: mergeSnapshot.assetQty,
          // A closing sale consumes exactly the snapshot's own quantity; any
          // excess came out of reserves (issue #770).
          qty: snapshotClosed ? mergeSnapshot.assetQty : summary.totalSize,
          closesBody: snapshotClosed,
          sellOrderId: fillData.orderId,
          bodyId: mergeSnapshot.id,
          additive: booking.additive,
        });

        if (liveMerged) {
          // consumedCostFraction must reflect what FRACTION OF THE DOLLAR COST
          // this sale actually removed from the live pool — NOT a quantity
          // ratio. `proratedCostBasis` (below) is priced off the frozen
          // `mergeSnapshot.costBasis`, so when a buy folded onto this SAME live
          // body in the Race-3 window at a DIFFERENT price than the original
          // body's avg price (the fold-in is part of liveMerged's pool and its
          // sourceOrderIds, which this stamps), a quantity-based ratio
          // (sold-size / live-qty) diverges from the dollar fraction actually
          // deducted, and Σ buy.cost*(1-consumedCostFraction) would no longer
          // reconcile to liveMerged.costBasis. Pricing the ratio directly off
          // the dollar amount removed (proratedCostBasis / pre-deduction
          // liveMerged.costBasis) makes that reconciliation exact by
          // construction, regardless of the fold-in's price.
          //
          // What leaves the live pool depends on whether the snapshot body
          // closed. A true partial removes only the sold tranche at its
          // prorated cost. A complete fill removes the WHOLE snapshot — sold
          // qty plus the designed holdback just booked as zero-cost reserves,
          // at its full cost — exactly as the normal path splices a filled
          // body out entirely. Deducting only the sold qty there left the
          // holdback in the live body as well as in reserves, so it was
          // counted twice and re-listed for sale (issue #718). Only a fold-in
          // the snapshot's TP never covered stays behind. A sale beyond the
          // snapshot's own quantity drew the excess from reserves
          // (bodyReservesSoldAsset, issue #770), so it must not ALSO come out
          // of the fold-in.
          const removedQty = snapshotClosed ? mergeSnapshot.assetQty : summary.totalSize;
          const removedCost = snapshotClosed ? mergeSnapshot.costBasis : proratedCostBasis;
          const liveConsumedRatio = liveMerged.costBasis > 0
            ? Math.min(removedCost / liveMerged.costBasis, 1)
            : 1;

          liveMerged.assetQty = roundAsset(Math.max(0, liveMerged.assetQty - removedQty));
          liveMerged.costBasis = roundUSDC(Math.max(0, liveMerged.costBasis - removedCost));

          // Track the cumulative fraction of the body's ORIGINAL cost basis
          // already realized via partial sells (mirrors the normal partial-fill
          // path at :3159-3168). Without this, heldOpenBuyCostBasis counts the
          // full buy cost as still-open while the sold tranche's prorated cost
          // is simultaneously realized via bodyPnl above — double-counting it.
          const prevConsumed = liveMerged.consumedCostFraction || 0;
          liveMerged.consumedCostFraction = 1 - (1 - prevConsumed) * (1 - liveConsumedRatio);
          if (snapshotClosed) {
            // The closed snapshot's tranches (consumed in full above) leave
            // the live body with its asset, so its next TP neither re-links
            // them nor spreads a later sale over them. Link them to THIS sell
            // like the normal full-fill path does: a TP re-placed on the live
            // body after the snapshot re-stamped them with an order this
            // branch cancels, which would leave an untracked buy held open
            // with no body to re-link it. The untouched fold-in pool must not
            // be charged this sale's cost fraction.
            liveMerged.buyOrders = (liveMerged.buyOrders || []).filter(e => !snapshotTranches.has(e));
            const keptIds = new Set(liveMerged.buyOrders.map(e => e && e.orderId));
            const closedIds = new Set([
              ...(mergeSnapshot.sourceOrderIds || []),
              ...(mergeSnapshot.buyOrders || []).map(e => e && e.orderId),
            ]);
            liveMerged.sourceOrderIds = (liveMerged.sourceOrderIds || [])
              .filter(id => keptIds.has(id) || !closedIds.has(id));
            const closedOnlyIds = [...closedIds].filter(id => id && id !== 'core-migration' && !keptIds.has(id));
            if (closedOnlyIds.length > 0) {
              fillLedger.annotateFillsByOrderIds(closedOnlyIds, { sellOrderId: fillData.orderId });
            }
            liveMerged.avgPrice = liveMerged.assetQty > 0 ? liveMerged.costBasis / liveMerged.assetQty : 0;
          } else {
            // Legacy fallback for buys the sale could not record per order. A
            // tracked buy ignores this fraction — and a tracked fold-in the
            // snapshot's TP never covered must not be charged it at all.
            stampConsumedCostFraction(liveMerged, liveConsumedRatio);
          }
        }

        // Commit the booking the moment the body mutation above is done —
        // synchronously with it, before any await below (issue #777). The
        // per-order bodyBookedSize this writes is the booking-commit marker
        // the buy-merge #227 continuation reads to decide what an in-flight
        // fill already booked: written any later, a throw in the stale-TP
        // cancel / re-place below would leave a deducted body with no marker,
        // and the continuation would book the same sale on top of it.
        fillLedger.commitSellBooking(fillData.orderId, {
          isBodyOwned: true,
          bodyId: mergeSnapshot.id,
          bodyTier: mergeSnapshot.tier,
          // The prorated cost of the SOLD tranche, not the full snapshot cost —
          // matches the normal partial-fill path (:~3318), which always records
          // proratedCostBasis regardless of partial/complete (proratedCostBasis
          // already equals the full cost when soldRatio is 1).
          bodyCostBasis: proratedCostBasis,
          bodyAvgPrice: mergeSnapshot.avgPrice,
          bodyBtcQty: liveOwnsRemainder ? summary.totalSize : mergeSnapshot.assetQty,
          bodyHoldbackAsset: liveOwnsRemainder ? 0 : holdbackAsset,
          ...(!liveOwnsRemainder && reservesSoldAsset > 0 && { bodyReservesSoldAsset: reservesSoldAsset }),
          bodyPnl: pnl,
          mergeSnapshot: true,
          ...(liveOwnsRemainder && { partialFill: true }),
        }, { additive: booking.additive, soldSize: summary.totalSize, bookedTradeIds });

        if (liveMerged) {
          if (liveMerged.tpOrderId && liveMerged.tpOrderId === fillData.orderId) {
            // The body still points at the snapshotted order itself: this
            // fill landed while a buy-merge / roll-up cancel of that same
            // order is still in flight (issue #744). Its execution is the one
            // THIS handler is booking, and the merge continuation owns the
            // cancel and the re-place — cancelling, booking or re-placing here
            // would double-book the sale or leave a second TP live next to
            // the one the continuation places. Only a body this sale drained
            // drops the identity (nothing left to re-arm), so it is removed
            // below and reconcile can never re-book the order against it.
            if (snapshotClosed && !(liveMerged.assetQty > 0)) {
              liveMerged.tpOrderId = null;
              liveMerged.tpPrice = 0;
              liveMerged.assetOnOrder = 0;
              if (orderExecutor.removeBodyTracking) orderExecutor.removeBodyTracking(fillData.orderId);
            }
          } else if (liveMerged.tpOrderId) {
            // The resting TP was sized for the pre-deduction (oversized) qty — cancel
            // and clear it so a correctly-sized TP is re-placed for the remaining body.
            const staleTp = liveMerged.tpOrderId;
            let cancelResult;
            try {
              cancelResult = await orderExecutor.cancelBodyTpOrder(liveMerged.id, staleTp);
            } catch (err) {
              logger.error(
                `❌ [${exchange}] Failed to cancel merge-snapshot body TP ${staleTp}: ${err.message} — keeping the existing TP identity and skipping replacement`,
                { bodyId: liveMerged.id, orderId: staleTp, cancellationOutcome: 'rejected', error: err.message }
              );
            }

            const staleOutcome = cancelResult ? classifyBodyTpCancellation(cancelResult) : null;
            if (staleOutcome === 'cancelled') {
              liveMerged.tpOrderId = null;
              liveMerged.tpPrice = 0;
              liveMerged.assetOnOrder = 0;
              if (orderExecutor.removeBodyTracking) orderExecutor.removeBodyTracking(staleTp);
            } else if (staleOutcome === 'cancelled_with_execution') {
              // The stale TP sold a tranche while we cancelled it, and
              // cancelBodyTpOrder has already dropped its executor tracking —
              // no poll will ever find that sale (issue #744, the #670 class).
              // Book it now through the normal body-TP sell path: liveMerged
              // still carries tpOrderId = staleTp, so that path deducts the
              // tranche from the (already snapshot-deducted) live body, records
              // its consumption, and re-places a right-sized TP — or closes the
              // body on a full-size fill. Nested: we are already inside a fill
              // or a roll-up, so the fill gate must not be re-entered. On a
              // booking failure the body keeps tpOrderId = staleTp plus the
              // pendingTpCancelExecution marker, and reconcile retries it.
              logger.warn(
                `⚠️ [${exchange}] Merge-snapshot: body ${liveMerged.id.slice(-8)} TP ${staleTp.slice(0, 8)} sold ${cancelResult.filledSize} ${baseCurrency} during its stale-size cancel — booking before re-place (#744)`,
                { bodyId: liveMerged.id, orderId: staleTp, filledSize: cancelResult.filledSize }
              );
              // The stale TP was sized for the PRE-deduction body, so its
              // assetOnOrder can exceed what the live body still holds. Cap it
              // at the body before booking: the sell handler classifies
              // full-vs-partial against assetOnOrder, and a sale covering the
              // whole remaining body must close it — as a partial it would
              // drive assetQty negative.
              if (liveMerged.assetOnOrder > liveMerged.assetQty) liveMerged.assetOnOrder = liveMerged.assetQty;
              await bookTpCancelExecution(liveMerged, staleTp, cancelResult, 'Merge-snapshot stale-size', { nested: true });
            } else if (cancelResult) {
              logger.error(
                `❌ [${exchange}] Merge-snapshot body TP cancellation was not confirmed for ${staleTp} — keeping the existing TP identity and skipping replacement`,
                {
                  bodyId: liveMerged.id,
                  orderId: staleTp,
                  cancellationOutcome: 'unconfirmed',
                  cancelled: false,
                  filled: Boolean(cancelResult.filled),
                  filledSize: cancelResult.filledSize || 0,
                }
              );
            }
          }
        }

        // A closed snapshot with no fold-in drains the live body to zero: drop
        // it like the normal full-fill path does rather than leave an empty
        // body that never re-arms (issue #718). No cycle reset here: a body
        // drains to zero only when its TP executed during a merge cancel, and
        // that caller is either a buy-merge about to create the buy's own body
        // or a roll-up whose other body remains. A TP whose cancel was not
        // confirmed keeps the body so reconciliation can still find that order.
        if (liveMerged && snapshotClosed && !(liveMerged.assetQty > 0) && !liveMerged.tpOrderId) {
          // In place: the buy-merge caller still holds this array.
          const drainedIdx = positionState.celestialBodies.indexOf(liveMerged);
          if (drainedIdx !== -1) positionState.celestialBodies.splice(drainedIdx, 1);
        }

        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        // Re-place a correctly-sized TP on the deducted body (issue #201) —
        // unless booking its stale TP's cancel-race execution just closed and
        // removed it (issue #744): a detached body must not list a TP.
        if (liveMerged && liveMerged.assetQty > 0 && !liveMerged.tpOrderId
          && (positionState.celestialBodies || []).includes(liveMerged)) {
          await placeBodyTp(liveMerged);
        }

        logger.info(`${tierCfg.emoji} [${exchange}] Merge-snapshot TP filled (${mergeSnapshot.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

        tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [merge-snapshot]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          pnl,
          holdbackAsset: liveOwnsRemainder ? 0 : holdbackAsset,
          ...(!liveOwnsRemainder && reservesSoldAsset > 0 && { reservesSoldAsset }),
          bodyId: mergeSnapshot.id,
          bodyTier: mergeSnapshot.tier,
          mergeSnapshot: true,
          ...(liveOwnsRemainder && { isPartialFill: true, remainingAsset: liveMerged.assetQty }),
        });

        saveLiveState();
        fillLedger.persist();
        orderExecutor.handleOrderFill(fillData.orderId);
        return;
      }

      // Find the body whose tpOrderId matches this fill
      const bodies = positionState.celestialBodies || [];
      const bodyIdx = bodies.findIndex(b => b.tpOrderId === fillData.orderId);

      // Fallback: check legacy satellite tracking (pre-celestial migration)
      const legacySatellite = null;

      if (bodyIdx !== -1) {
        // CELESTIAL BODY TP FILL (full or partial)
        const body = bodies[bodyIdx];
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        const proceeds = summary.totalValue - summary.totalFees;
        // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
        const soldRatio = body.assetQty > 0 ? Math.min(summary.totalSize / body.assetQty, 1) : 1;
        const proratedCostBasis = roundUSDC(body.costBasis * soldRatio);
        const pnl = proceeds - proratedCostBasis;
        const { holdbackAsset, reservesSoldAsset } = splitTpHoldback(roundAsset(body.assetQty - summary.totalSize));

        // Detect a TRUE partial fill: the TP was placed for body.assetOnOrder
        // but the exchange filled less than that. This is distinct from
        // designed holdback (totalSize === assetOnOrder < assetQty on a healthy
        // 100% fill). Comparing against assetQty (the old soldRatio<0.95 check)
        // misclassified healthy fills as partial whenever holdback ≳ 5% of the
        // body — zeroing the reserve and re-listing it for sale (issue #107 M1).
        // Fall back to the soldRatio heuristic only when assetOnOrder is
        // missing (legacy bodies / migration) so behavior degrades safely.
        const onOrder = body.assetOnOrder || 0;
        // A sale that took the body's whole inventory is never a partial, even
        // when a stale TP's assetOnOrder (sized for a larger, pre-deduction
        // body) says it filled less than planned: nothing is left to re-list,
        // and the partial path would drive assetQty negative. Designed
        // holdback keeps a healthy fill strictly below assetQty (issue #770).
        const soldWholeBody = body.assetQty > 0 && summary.totalSize >= body.assetQty;
        const isPartial = !soldWholeBody && (fillData.isPartialFill ||
          (onOrder > 0
            ? summary.totalSize < onOrder * 0.99 // 1% tolerance for rounding/fees
            : soldRatio < 0.95));

        // Update celestial state
        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        if (!isPartial) cs.bodiesCompleted += 1;
        positionState.celestialState = cs;
        // Partial fills are handled naturally — FIFO sees only the actual sold qty.

        // Grow capital (idempotent per booked amount — issues #210-B, #777)
        const prevMaxUsdc = creditCapitalGrowth(fillData.orderId, pnl, booking);

        // Record per buy order what this sale consumed (issue #607), before
        // the body is reduced. A partial consumes only what sold (no reserve
        // is booked); a full fill consumes the whole body — sold + the
        // holdback booked as reserves.
        recordBodyConsumption({
          entries: body.buyOrders,
          bodyQty: body.assetQty,
          // A closing sale consumes exactly the body; any excess came out of
          // reserves (bodyReservesSoldAsset, issue #770).
          qty: isPartial ? summary.totalSize : body.assetQty,
          closesBody: !isPartial,
          sellOrderId: fillData.orderId,
          bodyId: body.id,
          additive: booking.additive,
        });

        // Annotate the sell with its body booking, committed synchronously
        // with the credit and consumption above — before any await below, so
        // a concurrent booking of the same order cannot interleave between
        // the plan and the commit, and a later throw cannot leave a mutated
        // body without its commit marker. Adds to a booking this order
        // already committed when this pass booked new execution (issue #777).
        // body.assetQty/avgPrice are still the pre-sale values here.
        fillLedger.commitSellBooking(fillData.orderId, {
          isBodyOwned: true,
          bodyId: body.id,
          bodyTier: body.tier,
          bodyCostBasis: proratedCostBasis,
          bodyAvgPrice: body.avgPrice,
          bodyBtcQty: isPartial ? summary.totalSize : body.assetQty,
          bodyHoldbackAsset: isPartial ? 0 : holdbackAsset,
          ...(!isPartial && reservesSoldAsset > 0 && { bodyReservesSoldAsset: reservesSoldAsset }),
          bodyPnl: pnl,
          ...(isPartial && { partialFill: true }),
        }, { additive: booking.additive, soldSize: summary.totalSize, bookedTradeIds });

        let closesCycle = false;
        if (isPartial) {
          // PARTIAL FILL: reduce body size, keep body active, re-place TP for remaining
          const remainingAsset = roundAsset(body.assetQty - summary.totalSize);
          const remainingCostBasis = roundUSDC(body.costBasis * (1 - soldRatio));

          // Track the cumulative fraction of the body's ORIGINAL cost basis that
          // has now been realized via partial sells (issue #128). This partial
          // consumed `soldRatio` of the CURRENT (remaining) body; compose it
          // with any prior consumption so the fraction is relative to the
          // original: consumed = 1 − Π(1 − soldRatioᵢ). Annotating the source
          // buys with it lets computeRealizedFromCyclePairs subtract the
          // already-realized portion from heldOpenBuyCostBasis while the residual
          // TP rests — otherwise the sold tranche's cost is double-counted (once
          // realized via bodyPnl, once held), transiently understating return.
          const prevConsumed = body.consumedCostFraction || 0;
          body.consumedCostFraction = 1 - (1 - prevConsumed) * (1 - soldRatio);
          // Legacy fallback for buys the sale could not record per order.
          stampConsumedCostFraction(body, soldRatio);

          body.assetQty = remainingAsset;
          body.costBasis = remainingCostBasis;
          // avgPrice stays the same (weighted average of buys doesn't change)

          // Remove old TP tracking — engine will re-place for correct remaining size
          orderExecutor.removeBodyTracking(fillData.orderId);
          body.tpOrderId = null;
          body.tpPrice = 0;
          body.assetOnOrder = 0;

          // Sync aggregate fields
          celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

          logger.info(`${tierCfg.emoji} [${exchange}] Body TP PARTIAL fill (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, remaining=${remainingAsset} ${baseCurrency}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

          tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [PARTIAL]`, {
            assetAmount: summary.totalSize,
            price: summary.avgPrice,
            pnl,
            holdbackAsset: remainingAsset,
            bodyId: body.id,
            bodyTier: body.tier,
            isPartialFill: true,
            remainingAsset,
          });

          // Re-place TP for remaining body size
          await placeBodyTp(body);
        } else {
          // FULL FILL: remove body entirely
          // Remove body from array
          positionState.celestialBodies.splice(bodyIdx, 1);

          // Remove executor tracking
          orderExecutor.removeBodyTracking(fillData.orderId);

          // Sync aggregate fields
          celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

          const remaining = positionState.celestialBodies.length;
          logger.info(`${tierCfg.emoji} [${exchange}] Body TP filled (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackAsset.toFixed(6)} ${baseCurrency}${reservesSoldAsset > 0 ? ` (sold ${reservesSoldAsset.toFixed(6)} ${baseCurrency} beyond the body — drawn from reserves, #770)` : ''}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed} (${remaining} remaining)`);

          tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
            assetAmount: summary.totalSize,
            price: summary.avgPrice,
            pnl,
            holdbackAsset,
            ...(reservesSoldAsset > 0 && { reservesSoldAsset }),
            bodyId: body.id,
            bodyTier: body.tier,
            bodiesRemaining: remaining,
            capitalGrowth: pnl,
            newMaxUsdcDeployed: config.maxUsdcDeployed,
          });

          // No bodies left: the cycle closes. The reset runs below, after this
          // sell's P&L annotation and closed-trade record are committed (#766).
          closesCycle = positionState.celestialBodies.length === 0;
        }

        // Link source buy fills to this sell order for buy→sell display linkage.
        // Skip on partial fills: placeBodyTp above already re-linked the buys to
        // the re-placed TP for the remainder — stamping the filled orderId here
        // would clobber that linkage and make the remaining tranche's cost basis
        // vanish from heldOpenBuyCostBasis until the residual TP fills.
        if (!isPartial) {
          const annotatedSrcIds = new Set();
          for (const srcId of (body.sourceOrderIds || [])) {
            fillLedger.annotateFillsByOrderId(srcId, { sellOrderId: fillData.orderId });
            annotatedSrcIds.add(srcId);
          }
          for (const buyOrder of (body.buyOrders || [])) {
            if (buyOrder.orderId !== 'core-migration' && !annotatedSrcIds.has(buyOrder.orderId)) {
              fillLedger.annotateFillsByOrderId(buyOrder.orderId, { sellOrderId: fillData.orderId });
            }
          }
        }

        // Record the aggregate closed trade. A second booking of the same
        // order adds its newly-booked tranche; a replay remains idempotent.
        closedTrades.record({
          sellOrderId: fillData.orderId,
          ...sellTradeStamp(summary),
          recordedAt: Date.now(),
          qtySold: summary.totalSize,
          sellProceeds: roundUSDC(proceeds),
          sellFees: roundUSDC(summary.totalFees),
          costBasis: proratedCostBasis,
          buyAvgPrice: roundUSDC(body.avgPrice),
          pnl: roundUSDC(pnl),
          holdbackAsset: isPartial ? 0 : holdbackAsset,
          ...(!isPartial && reservesSoldAsset > 0 && { reservesSoldAsset }),
          isPartial,
          bodyId: body.id,
          bodyTier: body.tier,
          buyOrderIds: [...(body.sourceOrderIds || []), ...(body.buyOrders || []).map(b => b.orderId)].filter(id => id !== 'core-migration'),
          source: 'live',
        }, { additive: booking.additive });

        // If no bodies remain, do a full cycle reset — AFTER the bookkeeping
        // above, persisted first: resetCycle can wait on the ladder lock behind
        // an in-flight rebuild (#766), and a crash during that wait must not
        // lose this sell's bodyPnl/holdback annotation (the realized-P&L source
        // of truth) with the body it came from already gone.
        if (closesCycle) {
          positionState.cyclesCompleted += 1;

          const actualTpPct = body.avgPrice > 0
            ? ((summary.avgPrice - body.avgPrice) / body.avgPrice) * 100
            : 0;
          // Durable "this close still owes a cycle reset" marker: once the sell
          // is annotated, a retry of this fill (after resetCycle throws) takes
          // the already-processed branch below, which finishes the reset from
          // it instead of skipping it.
          positionState.pendingCycleResetFor = fillData.orderId;
          saveLiveState();
          fillLedger.persist();
          // Capture before resetCycle() zeroes cycleBuys, and run the
          // optimizer's real-balance fetch (issue #694) AFTER resetCycle()
          // flips the fill-ledger's cycle boundary (fillLedger.startNewCycle())
          // — not before it — so the network round-trip never widens the
          // window where a concurrent entry evaluation (gated only by
          // isEntryInProgress(), not isMutatingPosition()) could land a buy
          // fill still attributed to the closing cycle (Claude review).
          const cycleBuysAtClose = positionState.cycleBuys;
          // try/finally: resetCycle()'s only network call (ladder cancel)
          // runs before any state mutation, so a throw there means nothing
          // else in resetCycle() ran either — but capitalDeployed/stepsUsed
          // above are already committed facts about this fill, independent
          // of whether the ladder cleanup succeeds. Recording them in
          // `finally` means a resetCycle() failure (the sell itself is
          // already booked and persisted above, so it is never re-booked)
          // can never permanently drop this cycle from the optimizer's stats
          // (codex review round 1). A reset that reports it was stale skips
          // those samples below because another close already counted it.
          // Deliberately NOT awaited: the caller's own saveLiveState()/
          // fillLedger.persist() (below) durably persist this already-
          // completed sell/cycle-close before the optimizer's balance-fetch
          // (up to a 30s exchange timeout) gets a chance to delay them — a
          // crash during that fetch loses only this one best-effort
          // optimizer stats sample, never the P&L-critical state (codex
          // review round 2). recordCycleForSizeOptimizer never rejects (its
          // own body is try/caught), so no unhandled-rejection risk. Once
          // it DOES resolve, re-save so the recorded sample/balance isn't
          // left ONLY in memory until some unrelated future save happens to
          // pick it up (codex review round 3) — cheap and idempotent, same
          // as the periodic save timer already does.
          let resetResult;
          try {
            resetResult = await resetCycle();
          } finally {
            // Keep the close count persisted before the reset wait above, but
            // undo it when a queued reset discovers that an earlier reset
            // already turned over this cycle. Optimizer samples describe a
            // completed cycle too, so the stale close must not feed either.
            if (resetResult?.turnedOver === false) {
              positionState.cyclesCompleted -= 1;
            } else {
              recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
              recordCycleForSizeOptimizer({
                stepsUsed: cycleBuysAtClose,
                capitalDeployed: body.costBasis,
              }).catch(() => {}).finally(resaveAfterSizeOptimizerLive);
            }
          }
        }

        saveLiveState();
        fillLedger.persist();
        if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

      } else {
        // UNTRACKED SELL — could be a core TP from before migration
        const summary2 = fillLedger.aggregateFills(fillsToAggregate);

        // Guard: check if fills for this order are already annotated as body TP.
        // This catches duplicate body TP fills from cancel-and-replace races where both the
        // old and new TP orders fill simultaneously — the first is processed correctly, the
        // second arrives after the body is removed and would otherwise trigger a false cycle.
        const existingFills = fillLedger.getFillsForOrder(fillData.orderId);
        const alreadyProcessedAsBody = existingFills.some(f => f.isBodyOwned || f.isSatellite);
        if (alreadyProcessedAsBody) {
          // A retry of a body TP close whose cycle reset failed after the sell
          // was booked (#766): finish the reset the first pass owed.
          if (positionState.pendingCycleResetFor === fillData.orderId
            && (positionState.celestialBodies || []).length === 0) {
            logger.warn(`🔁 [${exchange}] Sell ${fillData.orderId.slice(0,8)} already booked — completing its pending cycle reset`);
            await resetCycle();
            positionState.pendingCycleResetFor = null;
            saveLiveState();
            fillLedger.persist();
            return;
          }
          logger.info(`⏭️ [${exchange}] Sell ${fillData.orderId.slice(0,8)} already processed as body TP, skipping`);
          return;
        }

        // Guard (issue #672): only the engine's OWN legacy core TP may close
        // the cycle. The exchange user channel delivers every sell on the
        // product — a manual sale of reserves, the DCA/manual-trades tooling,
        // scripts — and between celestial cycles there are no bodies, so
        // without this a foreign sell was booked as a cycle close crediting
        // its full proceeds to maxUsdcDeployed. Ownership is proven by:
        //  - the core TP id snapshotted before any await, or still current;
        //  - the executor tracking it as `take_profit` (pending, active, or
        //    recently settled — covers polling-backstop / cancel-race paths);
        //  - a prior pass having already claimed its capital credit — a
        //    retry of a close whose resetCycle() already nulled
        //    activeTpOrderId must still finish closing idempotently.
        const sellOrderId = fillData.orderId;
        const isOwnCoreTp = !!sellOrderId && (
          sellOrderId === entryCoreTpOrderId
          || sellOrderId === positionState.activeTpOrderId
          || (typeof orderExecutor.isTrackedTpOrder === 'function' && orderExecutor.isTrackedTpOrder(sellOrderId))
          || existingFills.some(f => f.capitalCredited)
        );

        // Guard: if celestial bodies still exist, this is NOT a legitimate cycle-closing TP.
        // It's likely a duplicate/untracked satellite sell. Log and annotate but don't complete the cycle.
        const remainingBodies = (positionState.celestialBodies || []).length;
        if (remainingBodies > 0 || !isOwnCoreTp) {
          const reason = remainingBodies > 0
            ? `${remainingBodies} celestial bodies still active`
            : 'not the engine\'s take-profit order (manual/external sell?)';
          logger.warn(`⚠️ [${exchange}] Untracked sell ${String(sellOrderId).slice(0,8)} (${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}) — ${reason}, skipping cycle completion`);
          // Position model is deliberately left untouched (issue #750). Which
          // holding a foreign sell drew down — zero-cost reserves or the
          // managed position — is unknowable from the fill, so any
          // attribution to totalAsset/totalCostBasis (or realizedAssetPnL)
          // would be a guess that corrupts P&L either way. The ledger keeps
          // the fact instead: `untrackedSell` rows lower ledgerNetAsset and
          // are broken out as `untrackedSellQty`, so the position-coverage
          // sweep (positionCoverage.ledger.untrackedSold) shows the gap and
          // its cause. Resolution is an operator action.
          if (remainingBodies === 0 && positionState.totalAsset > 0) {
            logger.warn(
              `⚖️ [${exchange}] Untracked sell ${String(sellOrderId).slice(0,8)} may have consumed the held position (${positionState.totalAsset} ${baseCurrency}) — position left unchanged; see positionCoverage.ledger.untrackedSold, operator review required`,
              { pair: productId, orderId: sellOrderId, soldQty: summary2.totalSize, totalAsset: positionState.totalAsset, reserves: positionState.realizedAssetPnL || 0 }
            );
          }
          fillLedger.annotateFillsByOrderId(sellOrderId, { untrackedSell: true });
          saveLiveState();
          fillLedger.persist();
        } else {
          const proceeds = summary2.totalValue - summary2.totalFees;
          const soldCostBasis = summary2.totalSize * positionState.avgCostBasis;
          const pnl = proceeds - soldCostBasis;
          const holdbackAsset = roundAsset(positionState.totalAsset - summary2.totalSize);

          positionState.assetOnOrder = 0;

          // Idempotency guard (issue #679 follow-up, codex convergence
          // review round 4) — scoped to ONLY the two truly non-idempotent
          // counter bumps (cyclesCompleted++, capital credit), not the
          // whole block. An earlier round of this fix gated resetCycle()
          // and closedTrades.record behind this SAME claim, which
          // stranded an in-progress cycle close forever whenever
          // resetCycle()'s own network cancel call failed afterward: the
          // claim was already persisted by claimCapitalCredit, so a retry
          // never got back into the block to finish closing. Both of
          // those retry safely on their own — closedTrades.record dedupes
          // by sellOrderId alone (see dedupKeyFor in closed-trades.js), and
          // resetCycle's state resets are
          // already state-gated/idempotent (its one non-idempotent step,
          // fillLedger.startNewCycle(), landing twice on a genuine retry
          // only costs a spare cycle-number boundary — cosmetic, never a
          // P&L figure) — so they stay UNGATED below and always run.
          // Captured here (claim-gated, same reasoning as tp_filled below) and
          // fed to the size optimizer AFTER resetCycle() runs — not inline —
          // so the optimizer's real-balance network fetch (issue #694) never
          // sits between the capital credit and resetCycle()'s
          // fillLedger.startNewCycle() cycle-boundary flip. Widening that gap
          // with an awaited round-trip would let a concurrent entry
          // evaluation (gated only by isEntryInProgress(), not
          // isMutatingPosition() — unlike refreshDrawdownGuard/
          // consolidateDustBodies) land a buy fill that gets attributed to
          // the closing cycle instead of the new one (Claude review).
          let sizeOptimizerCycleData = null;
          if (!fillLedger.claimCapitalCredit(fillData.orderId)) {
            logger.info(
              `ℹ️ [${exchange}] Untracked sell ${fillData.orderId.slice(0, 8)} capital already credited — skipping re-apply, still completing the cycle close`,
              { orderId: fillData.orderId }
            );
          } else {
            positionState.cyclesCompleted += 1;

            // Capital was already claimed (fillLedger.claimCapitalCredit)
            // above as the idempotency gate — apply it directly rather
            // than calling creditCapitalGrowth, which would re-claim and
            // (seeing it already claimed) skip applying pnl.
            const prevMaxUsdc = config.maxUsdcDeployed;
            config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
            updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

            logger.info(`✅ [${exchange}] TP filled (untracked): ${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

            // tp_filled + the optimizer recorders belong to the SAME
            // claim-gated commit as cyclesCompleted++ / the capital credit
            // (Claude delta review, round 6). They were previously below,
            // ungated, alongside resetCycle()/closedTrades.record — so a
            // retry after the claim already succeeded (capital credited,
            // resetCycle awaiting a network cancel that then failed) would
            // re-emit tp_filled and re-feed the optimizers on every retry,
            // and once resetCycle() DID complete, avgCostBasis is reset to
            // 0, so a subsequent retry's actualTpPct calc below would also
            // be wrong. resetCycle()/closedTrades.record stay outside this
            // gate (they retry idempotently on their own).
            const actualTpPct = positionState.avgCostBasis > 0
              ? ((summary2.avgPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100
              : 0;
            tradeEvents.emitTradeEvent('tp_filled', exchange, `${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
              assetAmount: summary2.totalSize,
              price: summary2.avgPrice,
              pnl,
              holdbackAsset,
              capitalGrowth: pnl,
              newMaxUsdcDeployed: config.maxUsdcDeployed,
            });
            recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
            sizeOptimizerCycleData = {
              stepsUsed: positionState.cycleBuys,
              capitalDeployed: soldCostBasis,
            };
          }

          // Link current-cycle buy fills to this sell order for buy→sell display linkage (skip body-owned)
          const cycleFills = fillLedger.getCurrentCycleFills();
          const buyOrderIds = new Set();
          for (const fill of cycleFills) {
            // Timestamp-folded buys (#705) are not in the core position this TP sold.
            if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId && fill.cycleAttribution !== 'timeframe') {
              fillLedger.annotateFillsByOrderId(fill.orderId, { sellOrderId: fillData.orderId });
              buyOrderIds.add(fill.orderId);
            }
          }

          // Preserve the legacy audit record before resetCycle clears its
          // cost basis. Safe to call every pass — record() accumulates only a
          // newly-booked tranche and leaves a replay unchanged.
          closedTrades.record({
            sellOrderId: fillData.orderId,
            ...sellTradeStamp(summary2),
            recordedAt: Date.now(),
            qtySold: summary2.totalSize,
            sellProceeds: roundUSDC(proceeds),
            sellFees: roundUSDC(summary2.totalFees),
            costBasis: roundUSDC(soldCostBasis),
            buyAvgPrice: roundUSDC(positionState.avgCostBasis),
            pnl: roundUSDC(pnl),
            holdbackAsset,
            isPartial: false,
            bodyId: null,
            bodyTier: null,
            buyOrderIds: [...buyOrderIds],
            source: fillData.source || 'live',
          }, { additive: booking.additive });

          // try/finally: if resetCycle() throws (its only network call — the
          // ladder cancel — runs before any state mutation, so a throw there
          // means resetCycle() changed nothing), the outer dedup-clear/retry
          // path retries this fill, but `claimCapitalCredit` will then return
          // false and sizeOptimizerCycleData would never be set again —
          // permanently dropping this cycle from the optimizer's stats
          // (codex review round 1, P2). Recording it here regardless of
          // resetCycle()'s outcome closes that gap; the underlying figures
          // were already fixed, committed facts before resetCycle() ran.
          // Deliberately NOT awaited: saveLiveState()/fillLedger.persist()
          // below durably persist this already-completed cycle close before
          // the optimizer's balance-fetch (up to a 30s exchange timeout) gets
          // a chance to delay them — a crash during that fetch loses only
          // this one best-effort optimizer stats sample, never the
          // P&L-critical state (codex review round 2). Never rejects (its
          // own body is try/caught), so no unhandled-rejection risk. Once it
          // DOES resolve, re-save so the recorded sample/balance isn't left
          // ONLY in memory until some unrelated future save picks it up
          // (codex review round 3).
          try {
            await resetCycle();
          } finally {
            if (sizeOptimizerCycleData) {
              recordCycleForSizeOptimizer(sizeOptimizerCycleData).catch(() => {}).finally(resaveAfterSizeOptimizerLive);
            }
          }
          saveLiveState();
          fillLedger.persist();
        }
      }
    }

    if (!keepEntryTracked) orderExecutor.handleOrderFill(fillData.orderId);
  };

  /**
   * Wrapper around handleOrderFillImpl: if processing throws AFTER the inner
   * buy/sell dedup key was added (e.g. during TP placement or persistence),
   * clear that key so the next reconcile/poll retry re-processes the fill
   * instead of skipping it as "already processed" until the 5-min TTL. Applies
   * to ALL callers (WS, reconcile, polling) — the polling callback also clears
   * its own outer recentlyProcessedFills key (issue #99 follow-up).
   */
  const handleOrderFill = async (fillData) => {
    const dedupRef = { set: null, key: null };
    try {
      // withFillGate increments the in-flight fill count (so dust consolidation
      // will not START a merge mid-fill) and waits out an already-running merge
      // (#196). Deadlock-free because withMergeLock never consults the fill gate.
      return await engineLocks.withFillGate(
        () => handleOrderFillImpl(fillData, dedupRef),
        { exchange, orderId: fillData.orderId }
      );
    } catch (err) {
      if (dedupRef.set) dedupRef.set.delete(dedupRef.key);
      throw err;
    }
  };

  /**
   * Cancel a body's TP so the caller can re-place it (operator TP edit,
   * reconcile stale-size, post-merge stale-size, startup reprice) — issue #670.
   *
   * A TP can sell a tranche WHILE it is being cancelled; cancelBodyTpOrder
   * still reports `cancelled: true` (with filledSize > 0) and has already
   * dropped all executor tracking for the order, so no poll will ever find
   * that sale. Re-placing for the full, un-reduced body would then list asset
   * the body no longer holds. classifyBodyTpCancellation tells the outcomes
   * apart:
   * - `cancelled`: clears the body's TP fields → returns 'cancelled' (the
   *   only outcome on which the caller re-places).
   * - `cancelled_with_execution`: books the sale immediately through the
   *   normal body-TP sell path — the body still carries `tpOrderId = oldTp`,
   *   so the sell handler finds it, records per-buy consumption, prorates
   *   qty/cost, credits capital, and re-places a right-sized TP itself (or
   *   closes the body on a full-size fill) → returns 'booked', or
   *   'booking_failed' if the booking threw. The caller must NOT re-place.
   * - `filled` / `unresolved`: leaves the TP untouched → returned as-is.
   *
   * Books through the handleOrderFill wrapper so an operator edit waits out
   * an in-flight merge like any other fill (none of the callers hold the
   * merge lock, so this cannot self-stall), and a failed booking releases its
   * dedup key. If booking fails, the body keeps `tpOrderId = oldTp` so the
   * reconcile loop re-discovers the CANCELLED order's partial and books it on
   * a later tick.
   * @param {Object} body - Celestial body whose TP is being replaced
   * @param {string} context - Log label for the calling path
   * @returns {Promise<'cancelled'|'booked'|'booking_failed'|'filled'|'unresolved'>}
   */
  const cancelBodyTpForReplace = async (body, context) => {
    const oldTp = body.tpOrderId;
    if (!oldTp) return 'cancelled';
    const cancelResult = await orderExecutor.cancelBodyTpOrder(body.id, oldTp);
    const outcome = classifyBodyTpCancellation(cancelResult);
    if (outcome === 'cancelled') {
      orderExecutor.removeBodyTracking(oldTp);
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
      return 'cancelled';
    }
    if (outcome !== 'cancelled_with_execution') return outcome;

    logger.warn(
      `⚠️ [${exchange}] ${context}: body ${body.id.slice(-8)} TP ${oldTp.slice(0, 8)} sold ${cancelResult.filledSize} ${baseCurrency} during cancel — booking before re-place (#670)`,
      { bodyId: body.id, orderId: oldTp, filledSize: cancelResult.filledSize, context }
    );
    return bookTpCancelExecution(body, oldTp, cancelResult, context);
  };

  /**
   * The execution a failed cancel-for-replace booking recorded for this
   * body's current TP (see bookTpCancelExecution), when the exchange's
   * CANCELLED status does not report MORE than it — a status that omits the
   * size, or reports a smaller one, must not override what we already knew.
   * @param {Object} body
   * @param {Object|null} status - Exchange order status for body.tpOrderId
   * @returns {Object|null}
   */
  const knownTpCancelExecution = (body, status) => {
    const known = body.pendingTpCancelExecution;
    if (!known || !body.tpOrderId || known.orderId !== body.tpOrderId) return null;
    return (parseFloat(status?.filledSize) || 0) > known.filledSize ? null : known;
  };

  /**
   * Book a body TP's execution that was reported by a cancel (see
   * cancelBodyTpForReplace) through the normal body-TP sell path. The body
   * must still carry `tpOrderId = orderId`.
   *
   * On failure the known execution is kept on the body as
   * `pendingTpCancelExecution` (persisted with it), so the reconcile loop can
   * retry the booking even when the exchange's CANCELLED status omits the
   * filled size — otherwise it would read "cancelled, nothing filled", clear
   * the TP and re-place against the unreduced body, losing the sale.
   * @param {Object} body
   * @param {string} orderId - The cancelled TP
   * @param {{filledSize: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number}} execution
   * @param {string} context - Log label
   * @param {{nested?: boolean}} [opts] - `nested: true` when the caller is
   *   itself running inside handleOrderFillImpl or a roll-up merge
   * @returns {Promise<'booked'|'booking_failed'>}
   */
  const bookTpCancelExecution = async (body, orderId, execution, context, { nested = false } = {}) => {
    // A TP that executed its whole planned size before the cancel landed
    // (the cancel-after-full-fill race) is a completed TP, not a partial:
    // route it as terminal so the sell handler closes the body and books its
    // designed holdback as reserves instead of re-listing that holdback. The
    // partial-fill flag would otherwise force the partial branch whenever the
    // exchange's status carries no completionPercentage.
    const executedFullTp = isFullTpExecution(body, execution.filledSize);
    const fillData = buildPartialFillData(orderId, 'sell', {
      status: executedFullTp ? 'FILLED' : 'CANCELLED',
      filledSize: execution.filledSize,
      filledValue: execution.filledValue,
      averageFilledPrice: execution.averageFilledPrice,
    }, { totalFees: execution.totalFees || 0, ...(executedFullTp && { isPartialFill: false }) });
    try {
      if (nested) {
        // Already inside a fill (fill gate held) or a roll-up (merge lock
        // held): the wrapper's fill gate would wait on that same merge hold
        // for its full window (see bookExecutionDuringCancel), so run the
        // handler directly and release its dedup key on failure ourselves,
        // exactly as the wrapper would.
        const dedupRef = { set: null, key: null };
        try {
          await handleOrderFillImpl(fillData, dedupRef);
        } catch (err) {
          if (dedupRef.set) dedupRef.set.delete(dedupRef.key);
          throw err;
        }
      } else {
        await handleOrderFill(fillData);
      }
    } catch (err) {
      body.pendingTpCancelExecution = {
        orderId,
        filledSize: execution.filledSize,
        filledValue: execution.filledValue || 0,
        averageFilledPrice: execution.averageFilledPrice || 0,
        totalFees: execution.totalFees || 0,
      };
      saveLiveState();
      logger.warn(
        `⚠️ [${exchange}] ${context}: failed to book body ${body.id.slice(-8)} TP ${orderId.slice(0, 8)} execution during cancel: ${err.message} — keeping TP identity for reconciliation`,
        { bodyId: body.id, orderId, error: err.message, context }
      );
      return 'booking_failed';
    }
    delete body.pendingTpCancelExecution;
    return 'booked';
  };

  /**
   * Update trade imbalance from recent trades
   */
  const updateTradeImbalance = () => {
    const recentTrades = marketState.trades;
    if (recentTrades.length === 0) {
      marketState.tradeImbalance = 0;
      return;
    }

    let buyVol = 0;
    let sellVol = 0;

    for (const trade of recentTrades) {
      if (trade.side === 'buy') {
        buyVol += trade.size;
      } else {
        sellVol += trade.size;
      }
    }

    const totalVol = buyVol + sellVol;
    if (totalVol > 0) {
      // Imbalance: +1 = all buys, -1 = all sells, 0 = balanced
      marketState.tradeImbalance = (buyVol - sellVol) / totalVol;
    }
  };

  /**
   * Start periodic metrics updater
   */
  const startMetricsUpdater = () => {
    // updateMetrics is async and awaits exchange/order calls that can reject;
    // an unhandled rejection in a bare interval callback would crash the
    // process, so guard every invocation.
    const runMetrics = () =>
      updateMetrics().catch((err) =>
        logger.error(`❌ [${exchange}] Metrics update crashed: ${err.message}`, { error: err.message })
      );
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
   * Seed the risk manager's drawdown tracker from the persisted snapshot once
   * per engine instance, so a restart keeps an active pause and the peak.
   */
  let drawdownStateHydrated = false;
  const hydrateDrawdownState = () => {
    if (drawdownStateHydrated) return;
    drawdownStateHydrated = true;
    riskManager.restoreState(positionState.drawdownGuard);
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

    const dust = bodies.find(b => isStrandedDustBody(b, baseMinSize, baseIncrement));
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

    const result = await manualMergeBody(dust.id, { targetId: target.id, label: 'Auto-consolidation (dust)' });
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

    logger.warn(
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
   * @returns {Promise<void>}
   */
  const sweepLedgerDrift = async () => {
    const startDate = new Date(positionState.engineStartTime).toISOString();
    const result = await getUnaccountedFills(exchange, fillLedger, null, { startDate, pair: productId });
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
      logger.warn(
        `🩸 [${exchange}] Ledger drift: ${result.unaccountedCount} exchange fill(s) across ${orders.length} order(s) missing from the ledger — net ${asset} ${baseCurrency} / $${usd} unaccounted since ${startDate}`,
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
   * Build the payload orderExecutor.restorePendingOrder expects from a saved
   * pendingEntryOrders/pendingLadderOrders row, shared by catchUpTerminalEntry's
   * failure path and reconcileTick's still-resting orphan re-arm.
   * @param {{price?: number, assetQty?: number, sizeUsdc?: number, placedAt?: number, ladderIndex?: number}} savedEntry
   * @param {'entry'|'ladder_entry'} entryType
   */
  const buildRestoreSpec = (savedEntry, entryType) => {
    const restoreSpec = {
      type: entryType,
      price: savedEntry.price,
      size: savedEntry.assetQty,
      sizeUsdc: savedEntry.sizeUsdc,
      placedAt: savedEntry.placedAt || Date.now(),
    };
    if (entryType === 'ladder_entry' && savedEntry.ladderIndex !== undefined) {
      restoreSpec.ladderIndex = savedEntry.ladderIndex;
    }
    return restoreSpec;
  };

  /**
   * Route a single already-terminal (FILLED, or CANCELLED/EXPIRED with a
   * partial) saved entry/ladder order through the canonical fill pipeline —
   * or report it safe to retire when it's a genuinely empty cancel.
   *
   * Shared by startImpl's offline entry catch-up and reconcileTick's orphan
   * sweep (issues #673, #764), so both honor a saved row's knownFilledSize
   * and handle a failed handleOrderFill the same retry-safe way (issue #679's
   * stricter getOrderFills contract: a throw must not silently drop a real
   * fill).
   *
   * @param {{orderId: string, price?: number, assetQty?: number, sizeUsdc?: number, placedAt?: number, ladderIndex?: number, knownFilledSize?: number}} savedEntry
   * @param {{status?: string, filledSize?: number}} orderStatus - already known to be terminal (FILLED/CANCELLED/EXPIRED/FAILED)
   * @param {'entry'|'ladder_entry'} [entryType]
   * @returns {Promise<{outcome: 'filled'|'empty'|'failed', error?: Error}>}
   */
  const catchUpTerminalEntry = async (savedEntry, orderStatus, entryType = 'entry') => {
    const isFullFilled = isFilledStatus(orderStatus);
    // A later independent poll of an already-cancelled order can under-report
    // filledSize versus what was already resolved (via order-executor's own
    // partialFillTracker high-water mark) at the moment it was first detected
    // cancelled — the same adapter quirk handleCancelledOrder's own fallback
    // exists for. onEntryCancelled stamps that resolved value onto the saved
    // row as knownFilledSize before this function ever sees it; never trust a
    // fresh read that's SMALLER than what's already confirmed known (codex
    // review, issue #673 round 3).
    const partialSize = Math.max(parseFloat(orderStatus.filledSize || 0), savedEntry.knownFilledSize || 0);
    if (!isFullFilled && partialSize <= 0) {
      return { outcome: 'empty' }; // truly empty cancel — safe for the caller to purge, no fill to record
    }
    logger.info(
      `📥 [${exchange}] Catching up terminal ${entryType} ${savedEntry.orderId.slice(0, 8)}: status=${orderStatus.status}, filled=${partialSize}`,
      { orderId: savedEntry.orderId, entryType, status: orderStatus.status, filledSize: partialSize }
    );
    orderExecutor.markSettled(savedEntry.orderId);
    try {
      await handleOrderFill(buildPartialFillData(savedEntry.orderId, 'buy', orderStatus, {
        status: isFullFilled ? 'FILLED' : orderStatus.status,
        isPartialFill: !isFullFilled,
        placedAt: savedEntry.placedAt,
        // Override with the max-of-known size computed above — orderStatus's
        // own (possibly stale) filledSize must not silently win over a
        // confirmed higher known value.
        filledSize: partialSize,
      }));
      return { outcome: 'filled' };
    } catch (err) {
      // The status lookup above already proved this order has a real fill —
      // losing this catch-up attempt must not silently drop it. Re-arm
      // executor tracking for the SAME orderId so the ordinary live polling
      // path (checkPendingOrderFills → onFillDetected, with its own #679
      // bounded engine-level retry) rediscovers and re-processes it on the
      // next tick, instead of leaving it an orphan indefinitely.
      logger.warn(
        `⚠️ [${exchange}] Failed to catch up terminal ${entryType} ${savedEntry.orderId.slice(0, 8)}: ${err.message} — re-arming tracking for retry instead of dropping it`,
        { orderId: savedEntry.orderId, entryType, error: err.message, incompleteFills: err.incompleteFills === true }
      );
      // Persist the size this attempt resolved onto the saved row (issue
      // #764): restorePendingOrder does not repopulate the executor's
      // partialFillTracker, so if the re-armed order is later re-detected
      // cancelled through checkPendingOrderFills → handleCancelledOrder with
      // an under-reporting status, knownFilledSize is the only record of the
      // partial. Stamp the caller's row object too — startImpl re-adds its
      // pre-catch-up snapshot row when handleOrderFill already dropped the
      // live one before throwing.
      if (partialSize > 0) {
        savedEntry.knownFilledSize = Math.max(savedEntry.knownFilledSize || 0, partialSize);
        stampKnownFilledSize(savedEntry.orderId, partialSize);
      }
      orderExecutor.restorePendingOrder(savedEntry.orderId, buildRestoreSpec(savedEntry, entryType));
      return { outcome: 'failed', error: err };
    }
  };

  /**
   * One reconciliation pass. Extracted from the setInterval callback so the
   * #196 lock-release integration test can drive a single tick directly (via the
   * _test hooks) without a lingering interval. Behaviour is identical to the
   * inlined callback it replaced.
   */
  const reconcileTick = () => {
      if (!isRunning) return; // Guard against firing after stop
      return engineLocks.withReconcileLock(async () => {
      // Collect every async chain this tick dispatches so the reconcile lock is
      // held until ALL of them settle — the body-TP chains below cancel/replace
      // TPs fire-and-forget, and clearing the flag on the recovery promise alone
      // would let a merge (or the next reconcile tick) race an in-flight TP
      // re-placement (#189 review).
      await reconcilePendingPlacements();
      await completeOwedCycleReset().catch((err) => {
        logger.error(`❌ [${exchange}] Owed cycle reset failed (will retry next reconcile): ${err.message}`, { error: err.message });
      });
      const pending = [];

      // Check for entry fills that WebSocket might have missed
      if (orderExecutor.capabilities?.liveReconciliation) {
        pending.push(orderExecutor.checkPendingOrderFills()
          .then(result => {
            // A SUCCESSFUL order-status poll proves the order-status REST path
            // is alive even when no WS order event has arrived. lastOrderUpdateMs
            // was otherwise refreshed ONLY by WS order events, so a resting TP
            // that legitimately goes quiet for >staleOrdersMs (default 60s, equal
            // to reconcileIntervalMs) tripped stale_orders → SAFE during normal
            // operation. Gate on result.polled > 0 (at least one getOrder
            // round-trip actually returned) — NOT on mere promise resolution:
            // getOrder failures are swallowed to null, so resolving with zero
            // successful polls (REST down, or no pending orders) must NOT stamp
            // liveness, or the stale-orders net couldn't detect a simultaneously
            // dead WS feed + dead REST poll (issue #110 M6).
            if (result.polled > 0) healthMonitor.recordOrderUpdate();
            if (result.filled > 0 || result.cancelled > 0) {
              logger.info(`🔄 [${exchange}] Reconcile fill check: ${result.filled} filled, ${result.cancelled} cancelled`);
            }
          })
          .catch(err => {
            logger.error(`❌ [${exchange}] Fill check failed: ${err.message}`, { error: err.message });
          }));
      }

      // Sweep for saved entry/ladder orders that have fallen out of the
      // executor's own tracking without ever reaching a terminal outcome in
      // positionState (issue #673). checkPendingOrderFills (above) and
      // handleCancelledOrder both delete a terminal order from
      // orderExecutor's pendingOrders BEFORE invoking onFillDetected, and
      // onFillDetected's engine-level retry (issue #679) is bounded — once it
      // exhausts its retries it gives up, but only a SUCCESSFUL
      // handleOrderFill removes the row from positionState.pendingEntryOrders
      // / pendingLadderOrders. Nothing else re-polled those lists at
      // runtime — only the startup catch-up did — so a transient error after
      // a buy fill could leave it invisible to both the executor and the
      // fill pipeline until the process restarted. This sweep re-detects the
      // gap every reconcile tick instead.
      if (orderExecutor.capabilities?.liveReconciliation) {
        pending.push((async () => {
          const trackedIds = new Set(
            orderExecutor.getPendingOrdersList()
              .filter(o => o.type === 'entry' || o.type === 'ladder_entry')
              .map(o => o.orderId)
          );
          // Dedupe by orderId (entry list wins ties) rather than concatenating
          // both lists directly — an orderId should never legitimately sit in
          // both, but if a stray duplicate row ever did, processing it twice
          // in the same pass would waste a redundant getOrder/handleOrderFill
          // round trip and, on a failure, let the second restorePendingOrder
          // call silently overwrite the first with the wrong type/ladderIndex
          // (claude review, issue #673).
          const orphanMap = new Map();
          for (const savedEntry of positionState.pendingEntryOrders || []) {
            if (!orphanMap.has(savedEntry.orderId)) orphanMap.set(savedEntry.orderId, { savedEntry, entryType: 'entry' });
          }
          for (const savedEntry of positionState.pendingLadderOrders || []) {
            if (!orphanMap.has(savedEntry.orderId)) orphanMap.set(savedEntry.orderId, { savedEntry, entryType: 'ladder_entry' });
          }
          const orphans = [...orphanMap.values()].filter(({ savedEntry }) => !trackedIds.has(savedEntry.orderId));

          for (const { savedEntry, entryType } of orphans) {
            // The dedup key for any terminal buy collapses to the bare
            // orderId (makeFillDedupKey), regardless of isPartialFill/size.
            // If the polling callback path is already mid-flight or
            // engine-level-retrying (issue #679) this exact order, skip it
            // BEFORE spending a getOrder round trip — let it finish instead
            // of racing a second handleOrderFill call for the same orderId.
            // shouldSkipBuyRecommit dedups any true overlap that slips past
            // this, but avoiding the race (and the wasted network call) is
            // cheaper than relying on that alone. If it eventually exhausts
            // its retries, both maps clear the key and this sweep catches it
            // up on a later tick.
            if (recentlyProcessedFills.has(savedEntry.orderId) || incompleteFillRetries.has(savedEntry.orderId)) {
              continue;
            }

            let orderStatus;
            try {
              orderStatus = await adapter.getOrder(savedEntry.orderId);
            } catch (err) {
              logger.warn(
                `⚠️ [${exchange}] Reconcile: could not check orphaned ${entryType} ${savedEntry.orderId.slice(0, 8)} (untracked by executor): ${err.message} — will retry next tick`,
                { orderId: savedEntry.orderId, entryType, error: err.message }
              );
              continue;
            }
            if (!isTerminalStatus(orderStatus)) {
              // Still live on the exchange (OPEN/PARTIALLY_FILLED) — re-arm
              // executor tracking instead of merely skipping it, so the
              // ordinary checkPendingOrderFills polling path (with its own
              // advancing-partial routing via partialFillTracker) picks it
              // back up on the next tick. Without this, an order that fell
              // out of tracking while still resting would only ever be
              // re-checked by THIS sweep's own terminal-only gate, silently
              // missing any intermediate partial fill until it eventually
              // reaches a terminal state (codex review, issue #673 round 2).
              orderExecutor.restorePendingOrder(savedEntry.orderId, buildRestoreSpec(savedEntry, entryType));
              continue;
            }

            logger.warn(
              `⚠️ [${exchange}] Reconcile: orphaned ${entryType} ${savedEntry.orderId.slice(0, 8)} is ${orderStatus.status} but missing from executor tracking — catching up`,
              { orderId: savedEntry.orderId, entryType, status: orderStatus.status }
            );
            const result = await catchUpTerminalEntry(savedEntry, orderStatus, entryType);
            if (result.outcome === 'empty') {
              // Truly empty cancel — safe to purge, nothing to record.
              if (entryType === 'ladder_entry') {
                positionState.pendingLadderOrders = (positionState.pendingLadderOrders || [])
                  .filter(o => o.orderId !== savedEntry.orderId);
              } else {
                positionState.pendingEntryOrders = (positionState.pendingEntryOrders || [])
                  .filter(e => e.orderId !== savedEntry.orderId);
              }
              saveLiveState();
            }
          }
        })().catch(err => {
          logger.error(`❌ [${exchange}] Orphaned entry/ladder sweep failed: ${err.message}`, { error: err.message });
        }));
      }

      // Check for TP order fill that WebSocket might have missed
      if (!isDryRun && positionState.activeTpOrderId) {
        pending.push(adapter.getOrder(positionState.activeTpOrderId)
          .then(async (orderStatus) => {
            // Coinbase can flip completionPercentage to 100 a tick before status
            // flips to FILLED — match the rest of the codebase's fill detection so
            // the reconcile backstop acts during that window (issue #155).
            if (isFilledStatus(orderStatus)) {
              logger.info(
                `✅ [${exchange}] Reconcile detected TP order ${positionState.activeTpOrderId} filled (WebSocket missed)`,
                { orderId: positionState.activeTpOrderId, orderType: 'take_profit', status: orderStatus.status }
              );
              // Build fill data in the format handleOrderFill expects
              const fillData = {
                orderId: positionState.activeTpOrderId,
                side: 'sell',
                status: 'FILLED',
                filledSize: parseFloat(orderStatus.filledSize || 0),
                filledValue: parseFloat(orderStatus.filledValue || 0),
                averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
              };
              orderExecutor.markSettled(positionState.activeTpOrderId);
              await handleOrderFill(fillData);
            }
          })
          .catch(err => {
            // Order not found might mean it was cancelled or doesn't exist
            if (isOrderNotFoundError(err)) {
              logger.warn(
                `⚠️ [${exchange}] TP order ${positionState.activeTpOrderId} not found on exchange, clearing`,
                { orderId: positionState.activeTpOrderId, orderType: 'take_profit', error: err.message }
              );
              const cancelledTpId = positionState.activeTpOrderId;
              positionState.activeTpOrderId = null;
              orderExecutor.handleOrderCancel(cancelledTpId);
            } else {
              logger.error(
                `❌ [${exchange}] TP order check failed: ${err.message}`,
                { orderId: positionState.activeTpOrderId, orderType: 'take_profit', error: err.message }
              );
            }
          }));
      }

      // Check celestial body TP orders for fills/cancellations that WebSocket might have missed
      const activeBodies = positionState.celestialBodies || [];
      if (activeBodies.length > 0) {
        for (const body of [...activeBodies]) {
          if (!body.tpOrderId) continue;
          pending.push(adapter.getOrder(body.tpOrderId)
            .then(async (bodyStatus) => {
              if (isFilledStatus(bodyStatus)) {
                const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                logger.info(
                  `${tierCfg.emoji} [${exchange}] Reconcile detected body TP ${body.tpOrderId} filled`,
                  { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', status: bodyStatus.status }
                );
                const fillData = {
                  orderId: body.tpOrderId,
                  side: 'sell',
                  status: 'FILLED',
                  filledSize: parseFloat(bodyStatus.filledSize || 0),
                  filledValue: parseFloat(bodyStatus.filledValue || 0),
                  averageFilledPrice: parseFloat(bodyStatus.averageFilledPrice || 0),
                };
                orderExecutor.markSettled(body.tpOrderId);
                await handleOrderFill(fillData);
              } else if (isCancelledStatus(bodyStatus)) {
                const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                // A cancel-for-replace whose booking failed (#670) left the
                // execution it knew about on the body; retry with it rather
                // than trusting a status that may omit the filled size.
                const knownExecution = knownTpCancelExecution(body, bodyStatus);
                if (knownExecution) {
                  orderExecutor.markSettled(body.tpOrderId);
                  await bookTpCancelExecution(body, body.tpOrderId, knownExecution, 'Reconcile retry');
                } else if (bodyStatus.filledSize > 0) {
                  // Route partials through handleOrderFill before re-placing — otherwise
                  // they're lost (Gemini has no order-events WS, and polling drops the
                  // order from pendingOrders once it sees CANCELLED).
                  logger.warn(
                    `⚠️ [${exchange}] Reconcile detected body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${bodyStatus.status} with ${bodyStatus.filledSize} partial fill — routing through handleOrderFill`,
                    {
                      bodyId: body.id,
                      orderId: body.tpOrderId,
                      status: bodyStatus.status,
                      filledSize: bodyStatus.filledSize,
                    }
                  );
                  orderExecutor.markSettled(body.tpOrderId);
                  await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', bodyStatus));
                } else {
                  // A freshly-placed TP can transiently read CANCELLED/FAILED from
                  // Coinbase's eventually-consistent historical-order endpoint
                  // (getOrder), even while the order is genuinely live on the book.
                  // Trusting that single read here clears tracking AND re-places —
                  // orphaning the live order and leaving a duplicate sell (the
                  // 0824cc36 incident: getOrder said CANCELLED 6s after placement,
                  // order stayed open for days). The startup path is immune because
                  // it cross-checks getOpenOrders (openOrderIds) first; mirror that
                  // here before acting on a terminal status.
                  const openOrders = await adapter.getOpenOrders(productId).catch(() => null);
                  // openOrders === null → getOpenOrders failed; treat as
                  // inconclusive and keep the order (never orphan on a failed check).
                  const stillOpen = openOrders === null || isOrderStillOpen(openOrders, body.tpOrderId);
                  if (stillOpen) {
                    logger.warn(
                      `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} read ${bodyStatus.status} but still OPEN on exchange — ignoring false terminal status`,
                      { bodyId: body.id, orderId: body.tpOrderId, status: bodyStatus.status, stillOpen: true }
                    );
                  } else {
                    logger.warn(
                      `⚠️ [${exchange}] Reconcile detected body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${bodyStatus.status} — clearing for re-placement`,
                      { bodyId: body.id, orderId: body.tpOrderId, status: bodyStatus.status }
                    );
                    orderExecutor.removeBodyTracking(body.tpOrderId);
                    body.tpOrderId = null;
                    body.tpPrice = 0;
                    body.assetOnOrder = 0;
                    saveLiveState();
                    await placeBodyTp(body);
                  }
                }
              } else if (bodyStatus.status === 'OPEN' || bodyStatus.status === 'PENDING' || bodyStatus.status === 'PARTIALLY_FILLED') {
                if (bodyStatus.filledSize > 0) {
                  // Route partials through handleOrderFill — cancelPartialFillOrder
                  // freezes the order and the partial-fill branch resizes the body,
                  // which also handles the stale-size case implicitly.
                  logger.warn(
                    `⚠️ [${exchange}] Reconcile: body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} has ${bodyStatus.filledSize} partial fill while OPEN — routing through handleOrderFill`,
                    {
                      bodyId: body.id,
                      orderId: body.tpOrderId,
                      status: bodyStatus.status,
                      filledSize: bodyStatus.filledSize,
                    }
                  );
                  orderExecutor.markSettled(body.tpOrderId);
                  await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', bodyStatus));
                } else {
                  // Pure stale-size detection (body merged/modified, TP placed for old size).
                  const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                  const { sellQty } = positionSizer.calculateTakeProfitSize(
                    body.assetQty, body.avgPrice, body.tpPrice, tierCfg.holdbackScale
                  );
                  if (Math.abs(sellQty - body.assetOnOrder) > 0.00000001) {
                    logger.warn(`⚠️ [${exchange}] Reconcile: body ${body.id.slice(-8)} TP stale (onOrder=${body.assetOnOrder}, expected=${sellQty}) — cancelling for re-place`);
                    if (await cancelBodyTpForReplace(body, 'Reconcile stale-size') === 'cancelled') {
                      saveLiveState();
                      await placeBodyTp(body);
                    }
                  }
                }
              }
            })
            .catch(async (err) => {
              // Order not found or invalid — likely cancelled externally or ID no longer valid
              if (isOrderNotFoundError(err)) {
                logger.warn(
                  `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} not found on exchange — clearing for re-placement`,
                  { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
                );
                orderExecutor.removeBodyTracking(body.tpOrderId);
                body.tpOrderId = null;
                body.tpPrice = 0;
                body.assetOnOrder = 0;
                saveLiveState();
                await placeBodyTp(body);
              }
            })
            // Terminal guard: this getOrder chain is fire-and-forget inside the
            // loop, and both the .then and .catch handlers above await
            // handleOrderFill / placeBodyTp, which can themselves reject. Without
            // this, such a rejection escapes as an unhandled rejection and
            // crashes the process (Node ≥15) — the reconcile loop re-checks this
            // body on the next tick anyway (issue #99).
            .catch(err => {
              logger.error(
                `❌ [${exchange}] Body ${body.id.slice(-8)} TP reconcile handler error: ${err.message}`,
                { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
              );
            }));
        }
      }

      pending.push(recoveryModule.reconcile(positionState, fillLedger)
        .then(result => {
          if (result.updated) {
            // MERGE the recomputed balance/qty fields into the EXISTING state —
            // do NOT wholesale-replace. rebuildPositionFromFills returns a
            // minimal object (activeTpOrderId:null, cyclesCompleted:0, no
            // lifecycle / ladder / pending-order / macroRegime fields), so a
            // wholesale swap would: flip a DRAINING fund back to ACTIVE, null
            // activeTpOrderId while the core TP still rests (→ duplicate sell),
            // drop ladderActive/pendingLadderOrders/pendingEntryOrders (→ double
            // ladders + orphaned orders), and reset cyclesCompleted. Only the
            // fields rebuildPositionFromFills authoritatively recomputes from
            // the ledger are copied over (issue #97).
            const rebuilt = result.position;
            const RECONCILED_FIELDS = [
              'totalAsset', 'totalCostBasis', 'avgCostBasis', 'cycleBuys',
              'lastEntryPrice', 'lastEntryTime', 'anchorPrice',
            ];
            for (const field of RECONCILED_FIELDS) {
              if (rebuilt[field] !== undefined) positionState[field] = rebuilt[field];
            }
            // Re-sync totals from bodies (celestial mode): rebuildPositionFromFills
            // skips body-owned fills, so when bodies exist the body-derived
            // aggregate is authoritative and overrides the core-only totals above.
            const bodies = positionState.celestialBodies || [];
            if (bodies.length > 0) {
              celestialHierarchy.syncPositionState(positionState, bodies);
            }
            // rebuildPositionFromFills excludes body-owned buys, so the cycleBuys
            // copied above is 0 in celestial mode — restore it from the all-buys
            // count so a reconcile-triggered rebuild doesn't wipe the live counter
            // and re-open per-cycle step exposure (issue #210-A).
            if (config.celestialEnabled !== false) {
              positionState.cycleBuys = fillLedger.getCurrentCycleAllBuysCount();
            }
            logger.info(`🔄 [${exchange}] Position reconciled from exchange (${bodies.length} bodies, lifecycle=${positionState.lifecycle || 'n/a'} preserved)`);
          }
        })
        .catch(err => {
          logger.error(`❌ [${exchange}] Reconciliation failed: ${err.message}`, { error: err.message });
        }));

      // Release the lock only after every dispatched chain settles (#189 review).
      return Promise.allSettled(pending);
      });
  };

  /**
   * Start periodic reconciliation
   */
  const startReconciliation = () => {
    reconcileInterval = setInterval(reconcileTick, config.reconcileIntervalMs);
  };

  /**
   * Evaluate volatility-based entry trigger (mode-aware)
   * Delegates to either reactive or ladder entry evaluation based on config
   */
  const evaluateEntryTrigger = async () => {
    // Prevent concurrent entry evaluations (race condition from rapid ticker updates)
    if (engineLocks.isEntryInProgress()) return;

    // A placement whose outcome we could not establish (ambiguous response we
    // could not reconcile, or a crash inside the dispatch window) leaves a
    // durable intent on disk. While one is outstanding, an order we cannot see
    // may be resting live against this fund's capital, so no new entry may be
    // submitted — and because the record is on disk, the guard survives a
    // restart. Monitoring, fill processing, TP repair, cancels and lifecycle
    // operations all keep running; only NEW entries are held.
    if (blockingPlacementIntents().length > 0) return;

    // Determine effective entry mode
    let effectiveMode = config.entryMode || 'reactive';

    // Auto-switch to ladder mode if enabled and volatility is expanded
    if (config.ladderAutoSwitch && marketState.volBaseline > 0) {
      const volExpansion = marketState.realizedVol / marketState.volBaseline;
      const volThreshold = config.ladderAutoSwitchVolMult || 2.0;
      if (volExpansion >= volThreshold) {
        if (effectiveMode !== 'ladder') {
          logger.info(`🔀 [${exchange}] Auto-switch: reactive→ladder (volExpansion=${volExpansion.toFixed(2)}x >= ${volThreshold}x threshold, rVol=${marketState.realizedVol.toFixed(4)} baseline=${marketState.volBaseline.toFixed(4)})`);
        }
        effectiveMode = 'ladder';
      }
    }

    // Don't switch modes mid-cycle if we have an active position
    // (prevents inconsistent behavior during a trade cycle)
    if (positionState.totalAsset > 0) {
      // If ladder is active, stay in ladder mode
      if (positionState.ladderActive) {
        effectiveMode = 'ladder';
      } else {
        // Otherwise stay in reactive mode
        effectiveMode = 'reactive';
      }
    }

    if (effectiveMode === 'ladder') {
      await evaluateLadderEntry();
    } else {
      await evaluateReactiveEntry();
    }
  };

  /**
   * Evaluate reactive entry trigger (original volatility-based logic)
   */
  const evaluateReactiveEntry = async () => {
    const now = Date.now();

    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;

    // Don't place a new reactive entry if there's already a pending entry OR a
    // resting ladder rung on the exchange. ladder_entry orders were previously
    // invisible to this guard, so after ladderAutoSwitch reverted to reactive
    // mode (vol dropped before any rung filled, totalAsset still 0) reactive
    // entries stacked on top of the full-budget ladder — over-committing
    // beyond maxUsdcDeployed (issue #107 M5).
    const pending = orderExecutor.getPendingCounts();
    if (pending.entries > 0 || pending.ladderEntries > 0) return;

    // Skip if in insufficient funds cooldown (prevents rapid retry spam on 406 errors)
    if (now < insufficientFundsCooldownUntil) return;

    const timeSinceLastEntry = now - positionState.lastEntryTime;

    // Minimum interval guard
    if (timeSinceLastEntry < config.minIntervalMs) return;

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Check tail events
    const tailCheck = tailEvents.canPlaceEntry(positionState.cycleBuys);
    if (!tailCheck.allowed) return;

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Calculate price move from anchor
    const priceMove = positionState.anchorPrice > 0
      ? Math.abs(marketState.lastPrice - positionState.anchorPrice)
      : Infinity;

    const volTrigger = marketState.atr1m > 0 && priceMove >= config.kFactor * marketState.atr1m;
    const timeTrigger = timeSinceLastEntry >= config.maxIntervalMs;

    if (volTrigger || timeTrigger) {
      await engineLocks.withEntryLock(() =>
        executeEntry(volTrigger ? 'volatility' : 'timer')
      );
    }
  };

  /**
   * Evaluate ladder entry - pre-position liquidity ladder
   */
  const evaluateLadderEntry = async () => {
    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;

    // Skip if in insufficient funds cooldown
    if (Date.now() < insufficientFundsCooldownUntil) return;

    // Skip if ladder already active with pending orders
    if (positionState.ladderActive && positionState.pendingLadderOrders.length > 0) {
      return;
    }

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Skip tail events check — ladder IS the flash event strategy,
    // orders should stay in place regardless of spread/depth/flash conditions

    // Fund drawdown pause blocks NEW ladders too (the reactive path gets it via
    // canPlaceEntry). Already-resting rungs are left alone.
    if (riskManager.getState().isDrawdownPaused) return;

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Claim the entry lock BEFORE the first await. Ticker events fire many
    // times per second; the balance fetch below is an async gap, and the
    // evaluateEntryTrigger guard (`if (engineLocks.isEntryInProgress()) return`)
    // only blocks re-entry once this flag is set. Setting it after the await
    // (the old bug) let every tick that landed during the balance round-trip
    // place its own full-budget ladder — multi-x budget over-commitment, with
    // only the last ladder's orders tracked (issue #98). All early-returns from
    // here must clear it, so the rest of the function runs under withEntryLock.
    if (engineLocks.isEntryInProgress()) return;
    // A rebuild/cancel/cycle-reset sweep in flight owns the ladder (#766): it
    // may have cleared ladderActive mid-sweep, and placing here would stack a
    // second ladder on the one it is about to place. Skip — the next tick
    // re-evaluates — rather than queue: taken without waiting, so held for the
    // whole placement and a sweep requested meanwhile runs after it.
    await engineLocks.withEntryLock(() => engineLocks.withLadderLock(async () => {
      // Calculate remaining budget, capped at actual available balance
      let remainingBudget = config.maxUsdcDeployed - positionState.totalCostBasis;
      const quoteCurrency = getQuoteCurrency(productId);
      const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
      if (!quoteBalance) {
        // Can't verify balance — skip ladder to avoid placing orders we can't fund
        return;
      }
      const availableQuote = parseFloat(quoteBalance.available) || 0;
      if (availableQuote < remainingBudget) {
        remainingBudget = availableQuote;
      }

      // Quick sanity check - need at least 1 order worth of budget
      if (remainingBudget < config.baseSizeUsdc) {
        if (!budgetExhaustedWarningLogged) {
          logger.info(`ℹ️ [${exchange}] Insufficient budget for ladder: $${remainingBudget.toFixed(2)} available (${quoteCurrency}=${availableQuote.toFixed(2)}) < $${config.baseSizeUsdc}`);
          budgetExhaustedWarningLogged = true;
        }
        return;
      }

      const placeLadder = async () => {
        // Build ladder first to determine actual level count (may be fewer than config due to min-size filtering)
        const ladder = ladderCalculator.buildLadder(
          marketState.lastPrice,
          remainingBudget,
          {
            atr: marketState.atr1m,
            volBaseline: marketState.volBaseline,
            realizedVol: marketState.realizedVol,
            athDistance: marketState.athDistance || 0,
            ath: marketState.ath || 0,
            priceIncrement,
          }
        );

        if (ladder.levels.length === 0) {
          if (!budgetExhaustedWarningLogged) {
            logger.info(`ℹ️ [${exchange}] Ladder build produced 0 levels for budget $${remainingBudget.toFixed(2)}`);
            budgetExhaustedWarningLogged = true;
          }
          return;
        }

        // Check order limit using actual built level count
        const pendingCounts = orderExecutor.getPendingCounts();
        const requiredSlots = ladder.levels.length + 1; // +1 for TP order

        if (pendingCounts.total + requiredSlots > config.maxOpenOrders) {
          logger.warn(`⚠️ [${exchange}] Insufficient order slots for ladder: need ${requiredSlots}, max=${config.maxOpenOrders}, current=${pendingCounts.total}`);
          return;
        }

        logger.info(`📊 [${exchange}] Building ladder: ${ladderCalculator.getSummary(ladder)}`);

        // Place ladder orders
        const generationAtPlace = cycleResetGeneration;
        const result = await orderExecutor.placeLadderOrders(ladder.levels);
        if (await abandonLadderPlacedAcrossReset(generationAtPlace, 'Ladder placement')) return;

        // Update position state
        positionState.ladderActive = true;
        positionState.ladderPlacedAt = Date.now();
        positionState.ladderLowerBound = ladder.lowerBound;
        positionState.pendingLadderOrders = result.orders;

        logger.info(`📊 [${exchange}] Ladder placed: ${result.orders.length} levels from ${fmtPrice(marketState.lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`);

        tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
          levels: result.orders.length,
          topPrice: marketState.lastPrice,
          bottomPrice: ladder.lowerBound,
          lowerBoundPct: ladder.lowerBoundPct,
          totalBudget: ladder.totalBudget,
          failedCount: result.failedCount,
        });

        // Persist state
        saveLiveState();
      };

      await placeLadder();
    }, { wait: false }));
  };

  /**
   * Execute entry
   * @param {string} triggerType - What triggered the entry
   */
  const executeEntry = async (triggerType) => {
    const regime = regimeDetector.getMode();

    // Calculate size (apply macro multiplier to sizing)
    const sizing = positionSizer.calculateEntrySize({
      regime,
      cycleBuys: positionState.cycleBuys,
      totalCostBasis: positionState.totalCostBasis,
      currentPrice: marketState.bid,
      avgCostBasis: positionState.avgCostBasis,
    });

    // Apply macro regime size multiplier
    const macroMult = macroRegime ? macroRegime.getMultipliers() : { sizeMult: 1.0, tpMult: 1.0, offsetMult: 1.0 };
    sizing.sizeUsdc = roundUSDC(sizing.sizeUsdc * macroMult.sizeMult);

    // Enforce minimum order size floor (after all multipliers, skip zero-size regimes)
    const minSize = config.minOrderSizeUsdc || exchangeConfig.minOrderSize || 1;
    const remainingBudget = roundUSDC(Math.max(0, config.maxUsdcDeployed - positionState.totalCostBasis));
    if (sizing.sizeUsdc > 0) {
      // If remaining budget can't fit 2 orders at minimum, use it all in one last order
      // But only if remaining budget is at least the minimum order size
      if (remainingBudget >= minSize && remainingBudget < minSize * 2) {
        sizing.sizeUsdc = remainingBudget;
      } else if (sizing.sizeUsdc < minSize) {
        sizing.sizeUsdc = minSize;
      }
    }

    // Check risk caps
    const assetQty = positionSizer.calculateBTCQuantity(sizing.sizeUsdc, marketState.bid);
    const riskCheck = riskManager.canPlaceEntry(positionState, assetQty, sizing.sizeUsdc);

    // Handle cycle buys auto-reset (time-based reset after being at max limit)
    if (riskCheck.shouldResetCycleBuys) {
      logger.info(`🔄 [${exchange}] Cycle buys auto-reset triggered, resetting buys ${positionState.cycleBuys} -> 0`);
      positionState.cycleBuys = 0;
      cycleBuysLimitWarningLogged = false;
    }

    if (!riskCheck.allowed) {
      // Only log certain warnings once until they reset (to avoid log spam)
      const isLadderLimit = riskCheck.reason.startsWith('cycle_buys_limit_reached');
      const isUsdcCap = riskCheck.reason.startsWith('usdc_cap_exceeded');
      const shouldSkipLog = (isLadderLimit && cycleBuysLimitWarningLogged) || (isUsdcCap && usdcCapWarningLogged);
      if (!shouldSkipLog) {
        logger.warn(`⚠️ [${exchange}] Entry blocked: ${riskCheck.reason}`);
        if (isLadderLimit) cycleBuysLimitWarningLogged = true;
        if (isUsdcCap) usdcCapWarningLogged = true;
      }
      return;
    }

    // Check for zero/budget-exhausted (with spam protection)
    if (sizing.sizeUsdc <= 0) {
      if (!budgetExhaustedWarningLogged) {
        logger.info(`ℹ️ [${exchange}] Budget exhausted`);
        budgetExhaustedWarningLogged = true;
      }
      return;
    }

    // Real-balance preflight (see resolveEntryBudget): cap entries at the real
    // available quote balance so a maxUsdcDeployed cap above funded capital can't
    // make the engine hot-loop on unfundable orders. Mirror the ladder path.
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    const availableQuote = quoteBalance ? (quoteBalance.available || 0) : null;
    const budget = resolveEntryBudget(sizing.sizeUsdc, availableQuote, minSize);
    if (budget.action === 'skip') {
      // Balance unverifiable — skip this entry rather than risk an unfundable order.
      return;
    }
    if (budget.action === 'cooldown') {
      const cooldownMs = config.insufficientFundsCooldownMs || 60000;
      insufficientFundsCooldownUntil = Date.now() + cooldownMs;
      // Log once per low-balance episode, not on every cooldown re-trigger — the
      // pause re-fires each cycle while the wallet stays underfunded (#187). The
      // flag resets below once an entry can be funded again.
      if (!lowBalancePauseLogged) {
        logger.info(`⏸️ [${exchange}] Wallet ${quoteCurrency} balance $${(availableQuote || 0).toFixed(2)} below min order $${minSize} — pausing entries for ${cooldownMs / 1000}s`);
        lowBalancePauseLogged = true;
      }
      return;
    }
    lowBalancePauseLogged = false;
    sizing.sizeUsdc = budget.sizeUsdc;

    // Calculate dynamic offset based on momentum direction
    // UP momentum: smaller offset to get fills before price rises further
    // DOWN momentum: larger offset to catch the falling price
    // NEUTRAL: use default config offset
    const momentumDirection = marketState.momentum?.direction || 'neutral';
    let effectiveOffsetBps;
    if (momentumDirection === 'up') {
      effectiveOffsetBps = config.entryOffsetUpBps;
    } else if (momentumDirection === 'down') {
      effectiveOffsetBps = config.entryOffsetDownBps;
    } else {
      effectiveOffsetBps = config.entryOffsetBps;
    }

    // Apply macro regime offset multiplier
    effectiveOffsetBps = Math.round(effectiveOffsetBps * macroMult.offsetMult);

    // Give the bid time proportional to how far below mid it rests: a deep
    // momentum-down bid on the fixed orderStaleMs timer gets cancelled long
    // before price can plausibly reach it (~8% fill at 18bps/120s), defeating
    // the catch-the-dip intent. Floor orderStaleMs, cap maxIntervalMs.
    const entryStaleMs = computeAdaptiveStaleMs(effectiveOffsetBps, marketState.atr1m, marketState.lastPrice, config);

    // Place entry with dynamic offset
    let result;
    const isInsufficientFundsMessage = (msg) => {
      if (typeof msg !== 'string') return false;
      const m = msg.toLowerCase();
      return (
        m.includes('insufficientfunds') ||
        m.includes('insufficient_available_balance') ||
        m.includes('insufficient_fund') || // Coinbase enum: INSUFFICIENT_FUND / PREVIEW_INSUFFICIENT_FUND
        m.includes('insufficient balance') || // Coinbase human msg: "Insufficient balance in source account"
        m.includes('insufficient fund')
      );
    };

    try {
      result = await orderExecutor.placeEntryBid(sizing.sizeUsdc, marketState.bid, marketState.ask, 0, effectiveOffsetBps, entryStaleMs);
    } catch (err) {
      if (isInsufficientFundsMessage(err.message) || err.status === 406) {
        const cooldownMs = config.insufficientFundsCooldownMs || 60000;
        insufficientFundsCooldownUntil = Date.now() + cooldownMs;
        logger.info(`⏸️ [${exchange}] Insufficient funds — pausing entries for ${cooldownMs / 1000}s`);
        return;
      }
      throw err; // Re-throw other errors
    }

    // Coinbase returns insufficient-funds as {success:false, errorMessage:"INSUFFICIENT_FUND"}
    // rather than throwing — apply the same cooldown so we don't hot-loop on a drained wallet.
    if (result && result.success === false && isInsufficientFundsMessage(result.errorMessage)) {
      const cooldownMs = config.insufficientFundsCooldownMs || 60000;
      insufficientFundsCooldownUntil = Date.now() + cooldownMs;
      logger.info(`⏸️ [${exchange}] Insufficient funds — pausing entries for ${cooldownMs / 1000}s`);
      return;
    }

    if (result.success) {
      positionState.lastEntryTime = Date.now();
      positionState.anchorPrice = marketState.lastPrice;

      // Persist entry order to state for recovery across restarts
      if (!isDryRun) {
        if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
        positionState.pendingEntryOrders.push({
          orderId: result.orderId,
          price: result.price,
          assetQty: result.assetQty,
          sizeUsdc: sizing.sizeUsdc,
          placedAt: Date.now(),
        });
        saveLiveState();
      }

      const macroLabel = macroRegime ? ` macro=${macroRegime.getMode()}(×${macroMult.sizeMult})` : '';
      logger.info(`📝 [${exchange}] Entry placed: regime=${regime}${macroLabel} buys=${positionState.cycleBuys} size=$${sizing.sizeUsdc} price=${fmtPrice(result.price)} trigger=${triggerType} momentum=${momentumDirection} offset=${effectiveOffsetBps}bps`);

      tradeEvents.emitTradeEvent('entry_placed', exchange, `$${sizing.sizeUsdc} @ ${fmtPrice(result.price)}`, {
        regime,
        macroMode: macroRegime ? macroRegime.getMode() : null,
        macroSizeMult: macroMult.sizeMult,
        step: positionState.cycleBuys,
        sizeUsdc: sizing.sizeUsdc,
        price: result.price,
        trigger: triggerType,
        momentum: momentumDirection,
        offsetBps: effectiveOffsetBps,
      });
    }
  };

  /**
   * Calculate base dynamic TP percentage (without tier adjustments)
   * Used for candidate TP calculations and merge proximity checks
   * @returns {number} TP percentage
   */
  const calculateDynamicTpPercent = () => {
    const { recentSwing, lastPrice } = marketState;
    let tpPercent = recentSwing > 0 && lastPrice > 0
      ? (config.tpMult * recentSwing / lastPrice) * 100
      : config.tpMinPercent;

    const regime = regimeDetector.getMode();
    if (regime === 'CAUTION') tpPercent *= 1.5;
    else if (regime === 'TREND') tpPercent *= 0.8;

    const macroTpMult = macroRegime ? macroRegime.getMultipliers().tpMult : 1.0;
    tpPercent *= macroTpMult;

    return clamp(tpPercent, config.tpMinPercent, config.tpMaxPercent);
  };

  /**
   * Place or update TP order for a celestial body
   * Calculates tier-specific TP, applies holdback, places via executor
   * @param {Object} body - CelestialBody
   * @returns {Promise<boolean>} Whether TP was successfully placed
   */
  const placeBodyTp = async (body) => {
    // Extract hints immediately so they never leak if we return early
    const mergeMaxTpPct = body._maxTpPct ?? null;
    const overrideTpPct = body._overrideTpPct ?? null;
    delete body._maxTpPct;
    delete body._overrideTpPct;

    if (body.tpOrderId) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} already has TP ${body.tpOrderId.slice(0, 8)}, skipping duplicate placement`);
      return false;
    }

    // Prevent concurrent TP placement for the same body (race between fill handler and safety-net loop)
    if (tpPlacementInFlight.has(body.id)) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} TP placement already in-flight, skipping`);
      return false;
    }

    tpPlacementInFlight.add(body.id);
    try {

    // Get tier-specific TP percentage
    const baseTpPct = calculateDynamicTpPercent();
    const { tpPercent: tierTpPct } = celestialHierarchy.calculateBodyTpPercent(baseTpPct, body.tier, config.tpMaxPercent);

    // Get tier holdback scale
    const tierCfg = celestialHierarchy.getTierConfig(body.tier);

    // Holdback ratio (needed for fee floor calculation below)
    const holdbackRatio = Math.min((config.holdbackRatio ?? 0.5) * (tierCfg.holdbackScale || 1), 0.95);

    // Minimum profit floor: TP% must clear round-trip fees + $0.01 net USDC profit.
    // Because holdback retains BTC, only (1-h) of gross profit becomes USDC proceeds,
    // so the required TP% = (roundTripFees + minProfit/costBasis) / (1-h)
    const feeRatePerSide = config.feeRate || 0.001; // conservative 10 bps default
    const feeFloorPct = ((2 * feeRatePerSide) + (0.01 / body.costBasis)) / (1 - holdbackRatio) * 100;

    // Holdback floor: TP% must generate enough profit for at least 1 satoshi holdback
    // Only applied when achievable within the tier's effective max TP —
    // tiny bodies that can't produce 1 sat holdback at a reasonable price just get normal TP
    const holdbackFloorPct = (0.00000001 * body.avgPrice) / (body.assetQty * holdbackRatio) * 100;
    const effectiveMax = config.tpMaxPercent * (tierCfg.tpMaxScale || 1);

    const minTpPct = holdbackFloorPct <= effectiveMax
      ? Math.max(feeFloorPct, holdbackFloorPct)
      : feeFloorPct;
    let finalTpPct = Math.min(Math.max(tierTpPct, minTpPct), effectiveMax);

    if (overrideTpPct != null) {
      // User-specified override: use exactly this TP%, subject to fee floor only
      finalTpPct = Math.max(overrideTpPct, minTpPct);
    } else if (body.manualTpPct != null) {
      // Persisted manual override: re-use the user's last manual TP% on re-placement
      finalTpPct = Math.max(body.manualTpPct, minTpPct);
    } else if (mergeMaxTpPct != null) {
      // Merge cap: after a manual merge, TP% must not exceed the pre-merge target's TP%.
      // This guarantees the combined sell price is lower (lower avgPrice × capped TP%).
      finalTpPct = Math.max(Math.min(finalTpPct, mergeMaxTpPct), minTpPct);
    }

    let tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), priceIncrement);

    // Guard: never place a TP at or below the body's avg price (would realize a loss)
    if (tpPrice <= body.avgPrice) {
      logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} TP price ${fmtPrice(tpPrice)} <= avgPrice ${fmtPrice(body.avgPrice)}, skipping placement to prevent negative P&L`);
      return false;
    }

    // Calculate sell qty with tier-specific holdback
    let { sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
      body.assetQty,
      body.avgPrice,
      tpPrice,
      tierCfg.holdbackScale
    );

    // Post-hoc P&L validation: simulate the fill and bump TP% if rounding
    // still causes negative USDC P&L or insufficient holdback
    for (let bump = 0; bump < 10; bump++) {
      const estSellProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
      const estPnl = estSellProceeds - body.costBasis;
      if (estPnl >= 0.01 && holdbackQty >= 0.00000001) break;
      finalTpPct += 0.01;
      tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), priceIncrement);
      ({ sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
        body.assetQty, body.avgPrice, tpPrice, tierCfg.holdbackScale
      ));
    }

    // Final guard: skip if estimated P&L is still negative (e.g. effectiveMax too low)
    const finalEstProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
    const finalEstPnl = finalEstProceeds - body.costBasis;
    if (finalEstPnl < 0.01) {
      logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} estimated PnL $${finalEstPnl.toFixed(4)} < $0.01 at TP ${fmtPrice(tpPrice)} (${finalTpPct.toFixed(3)}%), skipping to prevent negative P&L`);
      return false;
    }

    if (sellQty <= 0) {
      logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} sell qty is 0 after holdback`);
      return false;
    }

    // Pre-check sell qty against exchange minimum order size to avoid failed placements.
    // If holdback pushes qty below minimum, sell the full body (zero holdback).
    // If even the full body is below minimum, skip — it needs more buys to consolidate.
    if (productDetails?.baseMinSize) {
      const baseMinSize = parseFloat(productDetails.baseMinSize);
      const baseIncrement = parseFloat(productDetails.baseIncrement) || 0.00000001;
      const roundedSellQty = floorToIncrement(sellQty, baseIncrement);

      if (roundedSellQty < baseMinSize) {
        const fullQty = roundAsset(body.assetQty);
        const roundedFullQty = floorToIncrement(fullQty, baseIncrement);

        if (roundedFullQty >= baseMinSize) {
          const fullProceeds = fullQty * tpPrice * (1 - feeRatePerSide);
          const fullPnl = fullProceeds - body.costBasis;
          if (fullPnl >= 0.01) {
            logger.info(`📏 [${exchange}] Body ${body.id.slice(-8)} sellQty ${sellQty} below exchange min ${baseMinSize}, selling full qty ${fullQty} (no holdback)`);
            sellQty = fullQty;
            holdbackQty = 0;
          } else {
            logger.info(`🚫 [${exchange}] Body ${body.id.slice(-8)} full qty ${fullQty} PnL $${fullPnl.toFixed(4)} < $0.01 even without holdback, skipping`);
            return false;
          }
        } else {
          // Re-log only when this body's rounded qty changes (consolidation
          // progress); otherwise a permanently-stranded dust body floods the
          // log every cycle (#187).
          if (dustWaitLoggedQty.get(body.id) !== roundedFullQty) {
            logger.info(`📏 [${exchange}] Body ${body.id.slice(-8)} assetQty ${fullQty} (rounded ${roundedFullQty}) below exchange min ${baseMinSize}, waiting for consolidation`);
            dustWaitLoggedQty.set(body.id, roundedFullQty);
          }
          return false;
        }
      }
    }

    let result;
    try {
      // body.avgPrice is the body's real, already-tracked average buy price —
      // pass it through so the dry-run executor can seed this body's own
      // cost basis from it instead of falling back to a global cross-body
      // running average that drifts in a trending market (issue #213E
      // follow-up: that fallback is the PRIMARY path in a celestial-hierarchy
      // engine, since it never trades through the legacy single-cycle path
      // that resets it). No-op for the live executor, which already tracks
      // cost basis on `body.costBasis` independently of order placement.
      result = await orderExecutor.placeBodyTpOrder(sellQty, tpPrice, body.id, body.avgPrice);
    } catch (err) {
      logger.warn(
        `⚠️ [${exchange}] Body TP placement error for ${body.id.slice(-8)}: ${err.message}`,
        { bodyId: body.id, orderType: 'body_tp', error: err.message }
      );
      return false;
    }

    if (result.success) {
      body.tpOrderId = result.orderId;
      body.tpPrice = tpPrice;
      body.assetOnOrder = sellQty;

      // Re-aggregate position-level fields so positionState.assetOnOrder reflects
      // ALL bodies' TP orders, not just the most-recently-placed one. Without this,
      // satellite bodies created after the main body's TP leave assetOnOrder stale,
      // making the dashboard's "On Order" panel under-report by the satellite size.
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

      // Link all source buy fills to this sell order (use both sourceOrderIds and buyOrders for coverage)
      // A large merged body can own hundreds of buys. Persist all links in one
      // ledger write before reporting success, rather than blocking the engine
      // with a full-ledger rewrite for every buy (and timing out the gateway).
      const sourceIds = new Set(body.sourceOrderIds || []);
      for (const buyOrder of (body.buyOrders || [])) {
        if (buyOrder.orderId && buyOrder.orderId !== 'core-migration') sourceIds.add(buyOrder.orderId);
      }
      fillLedger.annotateFillsByOrderIds(sourceIds, {
        sellOrderId: result.orderId, bodyId: body.id, bodyTier: body.tier,
      });

      logger.info(`${tierCfg.emoji} [${exchange}] Body TP placed (${body.tier}): ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency}, body=${body.id.slice(-8)})`);

      tradeEvents.emitTradeEvent('body_tp_placed', exchange, `${tierCfg.emoji} ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)}`, {
        bodyId: body.id,
        bodyTier: body.tier,
        assetQty: body.assetQty,
        costBasis: body.costBasis,
        avgPrice: body.avgPrice,
        tpPrice,
        sellQty,
        holdbackQty,
      });

      return true;
    }

    logger.warn(
      `⚠️ [${exchange}] Failed to place body TP for ${body.id.slice(-8)}: ${result.errorMessage}`,
      { bodyId: body.id, orderType: 'body_tp', error: result.errorMessage }
    );
    return false;

    } finally {
      tpPlacementInFlight.delete(body.id);
    }
  };

  /** Place body TP with a single retry on failure to avoid leaving body without sell */
  const placeBodyTpWithRetry = async (body, context) => {
    let placed = await placeBodyTp(body);
    if (!placed && !body.tpOrderId) {
      logger.warn(`⚠️ [${exchange}] ${context} TP placement failed for body ${body.id.slice(-8)}, retrying after 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      placed = await placeBodyTp(body);
      if (!placed && !body.tpOrderId) {
        logger.error(
          `🚨 [${exchange}] ${context} TP retry failed for body ${body.id.slice(-8)} — body has no sell order, will re-place on next reconcile`,
          { bodyId: body.id, orderType: 'body_tp', operation: context }
        );
      }
    }
    return placed;
  };

  /**
   * Place or update take-profit order (legacy compat for untracked core position)
   * In celestial mode, body TPs are managed via placeBodyTp()
   * @param {Object} [options] - Options
   * @param {boolean} [options.forceUpdate] - Bypass anti-churn (use after buy fills)
   */
  const placeTakeProfitOrder = async (options = {}) => {
    // In celestial mode, update all body TPs instead
    if (positionState.celestialBodies && positionState.celestialBodies.length > 0) {
      // Cancel any lingering legacy TP order — but only if no body owns it
      if (positionState.activeTpOrderId) {
        const ownedByBody = positionState.celestialBodies.some(b => b.tpOrderId === positionState.activeTpOrderId);
        if (!ownedByBody) {
          logger.info(`🧹 [${exchange}] Cancelling legacy TP ${positionState.activeTpOrderId.substring(0, 8)} — celestial mode active`);
          await orderExecutor.cancelTpOrder();
        }
        positionState.activeTpOrderId = null;
        positionState.lastTpPrice = 0;
        positionState.assetOnOrder = 0;
      }

      // Snapshot the array to avoid visiting bodies added concurrently by fill handlers
      const bodiesToCheck = [...positionState.celestialBodies];
      for (const body of bodiesToCheck) {
        if (!body.tpOrderId) {
          await placeBodyTp(body);
        }
      }
      return;
    }

    // Legacy path for untracked core position
    const tpPrice = calculateDynamicTP();

    const { sellQty, holdbackQty, profitAssetValue } = positionSizer.calculateTakeProfitSize(
      positionState.totalAsset,
      positionState.avgCostBasis,
      tpPrice
    );

    if (sellQty <= 0) return;

    const result = await orderExecutor.placeTakeProfitOrder(sellQty, tpPrice, options);

    if (result.filledDuringCancel && result.filledOrderId) {
      // Old TP filled while we were trying to cancel-and-replace — route to fill handler.
      // The cancel-replace path already removed the order from pendingOrders, so the
      // engine's terminal handleOrderFill cleanup would log a spurious "orphan" warning
      // without this markSettled.
      logger.info(`📋 [${exchange}] TP filled during cancel-and-replace, routing to fill handler: ${result.filledOrderId}`);
      // placeTakeProfitOrder's cancel attempt already fetched this order's terminal
      // status to discover the fill — use those fields directly rather than
      // re-fetching via a second, redundant getOrder() call whose own failure
      // would otherwise silently drop the fill entirely (issue #227 follow-up).
      // Fall back to a fresh fetch only if that data is missing for some reason.
      let fillData = result.filledSize > 0 ? result : null;
      if (!fillData) {
        fillData = await adapter.getOrder(result.filledOrderId).catch(() => null);
      }
      if (fillData) {
        orderExecutor.markSettled(result.filledOrderId);
        await handleOrderFill({
          orderId: result.filledOrderId,
          side: 'sell',
          status: 'FILLED',
          filledSize: parseFloat(fillData.filledSize || 0),
          filledValue: parseFloat(fillData.filledValue || 0),
          averageFilledPrice: parseFloat(fillData.averageFilledPrice || 0),
          totalFees: parseFloat(fillData.totalFees || 0),
        });
      }
      return;
    }

    if (result.success) {
      positionState.activeTpOrderId = result.orderId;
      positionState.lastTpPrice = tpPrice;
      positionState.assetOnOrder = sellQty;

      // Link all current-cycle non-body buys to this sell order (skip body-owned buys)
      const cycleFills = fillLedger.getCurrentCycleFills();
      for (const fill of cycleFills) {
        // Timestamp-folded buys (#705) are not in the core position this TP sells.
        if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId && fill.cycleAttribution !== 'timeframe') {
          fillLedger.annotateFillsByOrderId(fill.orderId, { sellOrderId: result.orderId });
        }
      }

      if (result.updated) {
        logger.info(`📝 [${exchange}] TP ${result.orderId ? 'updated' : 'placed'}: ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency} ≈$${profitAssetValue.toFixed(2)})`);
      }
    }
  };

  /**
   * Calculate dynamic take-profit price (legacy for core position)
   * @returns {number}
   */
  const calculateDynamicTP = () => {
    const { avgCostBasis } = positionState;
    const tpPercent = calculateDynamicTpPercent();
    return roundPrice(avgCostBasis * (1 + tpPercent / 100), priceIncrement);
  };

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
   * @param {{preserveOpenBodyBuys?: boolean}} [opts] - Treat buys owned by
   *   currently open bodies as post-close fills when paying an owed reset.
   * @returns {Promise<{turnedOver: boolean}>}
   */
  const resetCycle = async ({ preserveOpenBodyBuys = false } = {}) => {
    // Buys that land while this reset waits its turn postdate the close just
    // like the sweep's own (#711 — see resetCycleLocked), e.g. a rung of the
    // ladder the in-flight rebuild just placed. Snapshot the closing cycle
    // before queueing so they are carried too. An owed reset can also mark
    // buys owned by currently open bodies as post-close fills.
    let queuedFrom = null;
    if (engineLocks.isLadderBusy() || preserveOpenBodyBuys) {
      const cycleId = fillLedger.getCurrentCycleId();
      const cycleFills = cycleFillsFor(cycleId);
      const openBodyBuyTradeIds = preserveOpenBodyBuys
        ? new Set(cycleFills
          .filter(fill => fill.side === 'buy' && isBuyAlreadyCommitted(positionState.celestialBodies, fill.orderId))
          .map(fill => fill.tradeId))
        : new Set();
      queuedFrom = {
        generation: cycleResetGeneration,
        tradeIds: new Set(cycleFills.filter(fill => !openBodyBuyTradeIds.has(fill.tradeId)).map(fill => fill.tradeId)),
      };
    }
    return engineLocks.withLadderLock(() => resetCycleLocked(queuedFrom), {
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

  /**
   * A fresh ledger has no live cycle until its first reset: its fills are
   * stamped null, so the closing "cycle" is the null-cycle rows.
   * @param {string|null} cycleId - fillLedger.getCurrentCycleId() at call time
   */
  const cycleFillsFor = (cycleId) => (cycleId
    ? fillLedger.getCurrentCycleFills()
    : fillLedger.getAllFills().filter(f => f.cycleId == null));

  /**
   * @param {{generation: number, tradeIds: Set<string>}|null} queuedFrom -
   *   the baseline rows when this reset queued or preserves open-body buys
   * @returns {Promise<{turnedOver: boolean}>}
   */
  const resetCycleLocked = async (queuedFrom) => {
    // The closing cycle's rows as they stand BEFORE the ladder sweep below —
    // the only await in this function. A buy row that shows up in the closing
    // cycle after the sweep landed while it ran: a rung that partially filled
    // before its cancel took is booked synchronously by cancelAllLadderOrders
    // (#674), and a concurrent WS/poll fill can land in the same window. The
    // closing TP never consumed such a buy, so it opens the NEW cycle (#711).
    // A reset that queued for the ladder lock uses its pre-queue snapshot
    // instead (#766).
    const closingCycleId = fillLedger.getCurrentCycleId();
    // A reset with a captured baseline is stale if another reset already
    // closed the cycle it was asked to close (for example, two TP closes
    // during one rebuild). Running it anyway would close the NEW cycle under
    // a body still open in it, splitting that body's buy from its sell.
    if (queuedFrom && queuedFrom.generation !== cycleResetGeneration) {
      logger.info(`🔄 [${exchange}] Queued cycle reset skipped — the cycle it was asked to close was already closed while it waited (now ${closingCycleId})`);
      positionState.pendingCycleResetFor = null;
      return { turnedOver: false };
    }
    const closingCycleFills = () => cycleFillsFor(closingCycleId);
    let preSweepTradeIds = queuedFrom ? queuedFrom.tradeIds : null;
    const generationAtEntry = cycleResetGeneration;

    // Cancel remaining ladder orders - check both positionState and executor tracking
    const executorLadderOrders = orderExecutor.getPendingLadderOrders ? orderExecutor.getPendingLadderOrders() : [];
    const hasTrackedLadder = (positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) || executorLadderOrders.length > 0;
    if (positionState.ladderActive || hasTrackedLadder) {
      preSweepTradeIds = preSweepTradeIds || new Set(closingCycleFills().map(f => f.tradeId));
      const { cancelled, partialFills = 0 } = orderExecutor.cancelAllLadderOrders ? await orderExecutor.cancelAllLadderOrders() : { cancelled: 0 };
      if (cancelled > 0) logger.info(`🧹 [${exchange}] Cancelled ${cancelled} unfilled ladder orders${partialFills > 0 ? ` (${partialFills} partially filled during the cancel and were booked)` : ''}`);
      // Two resets that both timed out on the ladder lock can overlap here;
      // only the first to finish its sweep turns the cycle over (#766).
      if (cycleResetGeneration !== generationAtEntry) {
        logger.info(`🔄 [${exchange}] Cycle reset skipped after its sweep — a concurrent reset already turned the cycle over`);
        return { turnedOver: false };
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
    cycleBuysLimitWarningLogged = false;
    usdcCapWarningLogged = false;
    budgetExhaustedWarningLogged = false;
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
    const closedBySale = (f) => f.sellOrderId
      && fillLedger.getRecordedSizeForOrder(f.sellOrderId) > 0
      && !isBuyAlreadyCommitted(bodies, f.orderId);
    const sweepBuys = preSweepTradeIds
      ? closingCycleFills().filter(f => f.side === 'buy' && !preSweepTradeIds.has(f.tradeId) && !closedBySale(f))
      : [];

    // Persist the boundary in regime-state.json with the other operator-owned
    // position state. The fill ledger remains the fallback for legacy state
    // files that predate this marker.
    positionState.activeCycleId = fillLedger.startNewCycle();
    cycleResetGeneration++;
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
      if (callbacks.onLifecycleClosed) {
        setImmediate(() => {
          try { callbacks.onLifecycleClosed(); } catch (err) {
            logger.warn(`⚠️ [${exchange}] onLifecycleClosed callback error: ${err.message}`, { error: err.message });
          }
        });
      }
    }
    return { turnedOver: true };
  };

  /**
   * Log hourly summary
   */
  const logHourlySummary = () => {
    const regime = regimeDetector.getMode();
    const counts = orderExecutor.getPendingCounts();
    const riskSummary = riskManager.getSummary(positionState);

    logger.info(
      `📊 [${exchange}] ${modeLabel}Hour: regime=${regime} entries=${counts.entries} ` +
      `exposure=${riskSummary} ` +
      `atr=${fmtPrice(marketState.atr1m)} vol=${marketState.realizedVol.toFixed(2)}%`
    );
  };

  // Set up dry-run callbacks now that all functions are defined
  if (isDryRun) {
    dryRunCallbacks.onBuyFill = async (orderId, assetQty, price, costBasis) => {
      const newBuy = { assetQty, costBasis, avgPrice: price, buyOrderId: orderId };
      const candidateTpPrice = roundPrice(price * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

      const bodies = positionState.celestialBodies || [];
      let mergeTarget = celestialHierarchy.findMergeTarget(
        bodies, newBuy, config.maxUsdcDeployed, candidateTpPrice,
        config.maxCelestialBodies || 10, orderExecutor.getPendingCounts().total, config.maxOpenOrders,
        config.mergeProximityScale ?? 1.0
      );

      positionState.cycleBuys += 1;
      positionState.lastEntryPrice = price;
      positionState.lastEntryTime = Date.now();

      if (positionState.pendingLadderOrders?.length > 0) {
        positionState.pendingLadderOrders = positionState.pendingLadderOrders.filter(o => o.orderId !== orderId);
        if (positionState.pendingLadderOrders.length === 0) {
          positionState.ladderActive = false;
        }
      }

      if (mergeTarget) {
        const cancelResult = await orderExecutor.cancelBodyTpOrder(mergeTarget.id, mergeTarget.tpOrderId);
        if (!cancelResult.cancelled) {
          logger.warn(`⚠️ [${exchange}] [DRY-RUN] Body ${mergeTarget.id.slice(-8)} TP ${cancelResult.filled ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
          mergeTarget = null;
        } else {
          // Clear body TP fields so placeBodyTp can re-place after merge
          mergeTarget.tpOrderId = null;
          mergeTarget.tpPrice = 0;
          mergeTarget.assetOnOrder = 0;
        }
      }

      if (mergeTarget) {
        const merged = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed, undefined, logger);
        const idx = positionState.celestialBodies.findIndex(b => b.id === merged.id);
        if (idx !== -1) positionState.celestialBodies[idx] = merged;

        celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
        await placeBodyTp(merged);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [merged→${merged.tier}]`, {
          assetAmount: assetQty, price, bodyId: merged.id, bodyTier: merged.tier, isMerge: true, isDryRun: true,
        });
      } else {
        const body = celestialHierarchy.createNewBody(newBuy, orderId);
        positionState.celestialBodies = positionState.celestialBodies || [];
        positionState.celestialBodies.push(body);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
        await placeBodyTp(body);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [new ${body.tier}]`, {
          assetAmount: assetQty, price, bodyId: body.id, bodyTier: body.tier, isDryRun: true,
        });
      }

      saveDryRunState();
    };

    dryRunCallbacks.onSellFill = async (orderId, assetQty, price, proceeds, pnl) => {
      // Find matching celestial body by TP order ID
      const bodies = positionState.celestialBodies || [];
      const bodyIdx = bodies.findIndex(b => b.tpOrderId === orderId);

      if (bodyIdx !== -1) {
        // CELESTIAL BODY TP FILL in dry-run
        const body = bodies[bodyIdx];
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        const holdbackAsset = roundAsset(body.assetQty - assetQty);

        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        cs.bodiesCompleted += 1;
        positionState.celestialState = cs;

        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        positionState.celestialBodies.splice(bodyIdx, 1);
        orderExecutor.removeBodyTracking(orderId);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        logger.info(`${tierCfg.emoji} [${exchange}] [DRY-RUN] Body TP filled (${body.tier}): ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc.toFixed(2)}→$${config.maxUsdcDeployed.toFixed(2)}`);

        tradeEvents.emitTradeEvent('body_tp_filled', exchange, `[DRY-RUN] ${tierCfg.emoji} ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
          assetAmount: assetQty, price, pnl, holdbackAsset,
          bodyId: body.id, bodyTier: body.tier, isDryRun: true,
        });

        // If no bodies remain, full cycle reset
        if (positionState.celestialBodies.length === 0) {
          positionState.cyclesCompleted += 1;
          const actualTpPct = body.avgPrice > 0 ? ((price - body.avgPrice) / body.avgPrice) * 100 : 0;

          const optimalAnalytics = isDryRun
            ? orderExecutor.getOptimalTpAnalytics() : null;
          const lastCycle = optimalAnalytics?.cycles?.[optimalAnalytics.cycles.length - 1];
          const optimalTpPct = lastCycle?.optimalTpPct || actualTpPct;

          recordCycleForOptimizer({ optimalTpPct, actualTpPct });
          // Capture before resetCycle() zeroes cycleBuys; run the optimizer's
          // real-balance fetch (issue #694) AFTER resetCycle() flips the
          // cycle boundary — see the live-mode call site's comment for why.
          const cycleBuysAtClose = positionState.cycleBuys;
          // try/finally: see the live-mode call site's comment — a
          // resetCycle() failure must not permanently drop this cycle from
          // the optimizer's stats on retry (codex review round 1, P2).
          // Deliberately NOT awaited — see the live-mode call site's comment
          // on why (codex review round 2: don't delay saveDryRunState() below
          // on the optimizer's balance-fetch). Once it DOES resolve, re-save
          // so the recorded sample/balance isn't left only in memory until
          // some unrelated future save picks it up (codex review round 3).
          try {
            await resetCycle();
          } finally {
            recordCycleForSizeOptimizer({
              stepsUsed: cycleBuysAtClose,
              capitalDeployed: body.costBasis,
            }).catch(() => {}).finally(resaveAfterSizeOptimizerDryRun);
          }
        }
      } else {
        // Fallback: untracked sell (legacy core TP or unknown)
        const holdbackAsset = roundAsset(positionState.totalAsset - assetQty);
        positionState.assetOnOrder = 0;
        positionState.cyclesCompleted += 1;

        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        logger.info(`💰 [${exchange}] [DRY-RUN] Capital growth: $${prevMaxUsdc.toFixed(2)} → $${config.maxUsdcDeployed.toFixed(2)} (+$${pnl.toFixed(2)})`);

        tradeEvents.emitTradeEvent('tp_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
          assetAmount: assetQty, price, pnl, holdbackAsset, isDryRun: true,
        });

        const actualTpPct = positionState.avgCostBasis > 0
          ? ((price - positionState.avgCostBasis) / positionState.avgCostBasis) * 100 : 0;
        recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
        // Capture before resetCycle() zeroes cycleBuys/totalCostBasis; run the
        // optimizer's real-balance fetch (issue #694) AFTER resetCycle() flips
        // the cycle boundary — see the live-mode call site's comment for why.
        const cycleBuysAtClose = positionState.cycleBuys;
        const totalCostBasisAtClose = positionState.totalCostBasis;
        // try/finally: see the live-mode call site's comment — a resetCycle()
        // failure must not permanently drop this cycle from the optimizer's
        // stats on retry (codex review round 1, P2).
        // Deliberately NOT awaited — see the live-mode call site's comment
        // (codex review round 2: don't delay saveDryRunState() below on the
        // optimizer's balance-fetch). Once it DOES resolve, re-save so the
        // recorded sample/balance isn't left only in memory until some
        // unrelated future save picks it up (codex review round 3).
        try {
          await resetCycle();
        } finally {
          recordCycleForSizeOptimizer({
            stepsUsed: cycleBuysAtClose,
            capitalDeployed: totalCostBasisAtClose,
          }).catch(() => {}).finally(resaveAfterSizeOptimizerDryRun);
        }
      }

      saveDryRunState();
    };
  }

  // Set up live mode fill detection callback (backup for when WebSocket misses fills)
  if (!isDryRun) {
    liveCallbacks.onFillDetected = async (orderId, status) => {
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
      const t2 = setTimeout(() => { recentlyProcessedFills.delete(dedupKey); ttlTimers.delete(t2); }, 60000);
      ttlTimers.add(t2);
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
      // order-executor invokes this callback fire-and-forget (no await/catch),
      // and handleOrderFill awaits network + fs work that can reject on a
      // routine API blip. An unhandled rejection here crashes the process
      // (Node ≥15) mid-fill, leaving state partially mutated. Contain it and
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
      // instance — issue #679 follow-up, codex + coordinator review). A
      // still-PARTIALLY_FILLED order legitimately stays tracked and IS
      // re-detected by the next reconcile poll, so it keeps the original
      // "log and wait" behavior below.
      try {
        await handleOrderFill(fillData);
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
      }
    };
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  const getState = () => {
    refreshRealizedFromCyclePairs();
    return ({
    isRunning,
    isDryRun,
    market: marketState,
    position: positionState,
    regime: regimeDetector.getState(),
    macro: macroRegime ? macroRegime.getState() : null,
    health: healthMonitor.getState(),
    pause: tailEvents.getPauseState(),
    risk: riskManager.getState(),
    orders: orderExecutor.getPendingCounts(),
    pendingOrders: orderExecutor.capabilities?.liveReconciliation
      ? buildPendingOrders(orderExecutor.getPendingOrdersList(), positionState)
      : [],
    fillDrift,
    positionCoverage,
    apy: calculateApyMetrics(),
    dryRun: isDryRun ? orderExecutor.getDryRunState() : null,
    tpOptimizer: tpOptimizer.getStatus(),
    sizeOptimizer: sizeOptimizer.getStatus(),
    fillTimeStats: fillLedger.getFillTimeStats ? fillLedger.getFillTimeStats(7) : null,
    closedTradesSummary: {
      totalPnl: closedTrades.getTotalPnL(),
      totalHoldback: closedTrades.getTotalHoldback(),
      count: closedTrades.getCount(),
    },
    effectiveStaleMs: orderExecutor.capabilities?.liveReconciliation ? orderExecutor.getEffectiveStaleMs() : config.orderStaleMs,
    // Include current config for real-time dashboard updates
    config: {
      maxUsdcDeployed: config.maxUsdcDeployed,
      baseSizeUsdc: config.baseSizeUsdc,
      maxCycleBuys: config.maxCycleBuys,
      tpMinPercent: config.tpMinPercent,
      tpMaxPercent: config.tpMaxPercent,
      holdbackRatio: config.holdbackRatio,
      // Same fee the engine actually budgets when sizing/gating a TP (placeBodyTp's
      // feeFloorPct) — exposed so the dashboard's Open Orders "est." columns never
      // hard-code a fee guess of their own. See issue #698.
      feeRatePerSide: config.feeRate || 0.001,
      entryMode: config.entryMode || 'reactive',
      ladderAutoSwitch: config.ladderAutoSwitch || false,
      ladderMaxAthDropPct: config.ladderMaxAthDropPct || 80,
      ladderSpacingMode: config.ladderSpacingMode || 'sqrt',
      ladderSizeMode: config.ladderSizeMode || 'fibonacci',
      ladderMinSpacingPct: config.ladderMinSpacingPct || 0.5,
      celestialEnabled: config.celestialEnabled !== false,
      maxCelestialBodies: config.maxCelestialBodies || 10,
      mergeProximityScale: config.mergeProximityScale ?? 1.0,
      macroEnabled: config.macroEnabled || false,
    },
    // Effective entry mode (may differ from config due to auto-switch)
    entryMode: (() => {
      let mode = config.entryMode || 'reactive';
      if (config.ladderAutoSwitch && marketState.volBaseline > 0) {
        const volExpansion = marketState.realizedVol / marketState.volBaseline;
        if (volExpansion >= (config.ladderAutoSwitchVolMult || 2.0)) {
          mode = 'ladder';
        }
      }
      return mode;
    })(),
    // Auto-switch debug info
    autoSwitch: config.ladderAutoSwitch ? {
      volExpansion: marketState.volBaseline > 0 ? parseFloat((marketState.realizedVol / marketState.volBaseline).toFixed(2)) : 0,
      threshold: config.ladderAutoSwitchVolMult || 2.0,
      wouldTrigger: marketState.volBaseline > 0 && (marketState.realizedVol / marketState.volBaseline) >= (config.ladderAutoSwitchVolMult || 2.0),
    } : null,
    ladder: positionState.ladderActive ? {
      active: true,
      placedAt: positionState.ladderPlacedAt,
      lowerBound: positionState.ladderLowerBound,
      pendingOrders: positionState.pendingLadderOrders?.length || 0,
      committedUsdc: (positionState.pendingLadderOrders || []).reduce((sum, o) => sum + (o.sizeUsdc || 0), 0),
    } : null,
    celestial: celestialHierarchy.buildCelestialPayload(positionState, config),
    // Body TP aggregates (legacy key "satellites" kept for UI compat)
    satellites: {
      enabled: config.celestialEnabled !== false,
      active: (positionState.celestialBodies || []).length,
      completed: positionState.celestialState?.bodiesCompleted || 0,
      realizedPnL: positionState.celestialState?.bodiesRealizedPnL || 0,
      realizedAssetPnL: positionState.celestialState?.bodiesRealizedAssetPnL || 0,
      orders: (positionState.celestialBodies || []).map(b => ({
        buyOrderId: b.id?.substring(0, 8),
        tpOrderId: b.tpOrderId,
        assetQty: b.assetQty,
        costBasis: b.costBasis,
        avgPrice: b.avgPrice,
        tpPrice: b.tpPrice,
        assetOnOrder: b.assetOnOrder,
        placedAt: b.createdAt,
      })),
    },
    lifecycle: {
      lifecycle: positionState.lifecycle || LIFECYCLE.ACTIVE,
      lifecycleChangedAt: positionState.lifecycleChangedAt || null,
      lifecycleReason: positionState.lifecycleReason || null,
      lifecycleClosedCycle: positionState.lifecycleClosedCycle || null,
    },
    placementIntents: isDryRun ? [] : describePlacementIntents(exchange, pair),
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

  /**
   * Unresolved placement intents for this fund, with rate-limited logging so a
   * blocked engine says why once a minute instead of once a tick.
   * @returns {Array<Object>} Blocking intents (empty when placements may proceed)
   */
  const blockingPlacementIntents = () => {
    if (isDryRun) return [];
    const now0 = Date.now();
    if (now0 - placementIntentCache.at < PLACEMENT_INTENT_CACHE_MS) return placementIntentCache.intents;

    const blocking = getBlockingPlacementIntents(exchange, pair);
    placementIntentCache = { at: now0, intents: blocking };
    if (blocking.length === 0) {
      placementBlockLoggedAt = 0;
      return blocking;
    }
    const now = Date.now();
    if (now - placementBlockLoggedAt > PLACEMENT_BLOCK_LOG_INTERVAL_MS) {
      placementBlockLoggedAt = now;
      const [oldest] = blocking;
      logger.error(`⏸️ [${exchange}] New entries blocked — ${blocking.length} unresolved placement intent(s); oldest ${oldest.action ?? 'order'} ${oldest.id} awaiting automatic exchange reconciliation`, {
        pendingIntents: blocking.length,
        intentId: oldest.id,
        action: oldest.action ?? null,
        clientOrderId: oldest.clientOrderId ?? null,
      });
    }
    return blocking;
  };

  /**
   * Operator reconcile of one unresolved placement intent.
   *
   * `adopt` re-runs the authoritative client-order-id lookup and, only on a
   * positive find, adopts the real exchange order into normal tracking before
   * clearing the intent. `discard` clears an intent the operator has confirmed
   * never became a live order. Both are exactly-once: the disk row is removed
   * as part of the action, so a duplicate call finds nothing to act on.
   *
   * Automatic reconciliation uses the same durable adoption path and clears
   * only positively identified terminal orders with zero fills.
   * @param {string} intentId - Intent id to reconcile
   * @param {'adopt'|'discard'} action - Operator decision
   * @returns {Promise<{success: boolean, message?: string, error?: string, adoptedOrderId?: string}>} Result
   */
  const reconcilePlacementIntent = async (intentId, action, { automatic = false } = {}) => {
    if (action !== 'adopt' && action !== 'discard') {
      return { success: false, error: `Unknown reconcile action '${action}' (expected 'adopt' or 'discard')` };
    }
    const intent = describePlacementIntents(exchange, pair).find(i => i.id === intentId && isBlockingPlacementIntent(i));
    if (!intent) {
      return { success: false, error: `No unresolved placement intent ${intentId} on this fund (an in-flight dispatch is not reconcilable)` };
    }

    if (action === 'discard') {
      const removed = resolvePlacementIntent(exchange, pair, intentId);
      if (!removed) return { success: false, error: `Placement intent ${intentId} was already resolved` };
      logger.warn(`🧹 [${exchange}] Operator discarded placement intent ${intentId} (${intent.action ?? 'order'}) — placements resume`, {
        intentId,
        action: intent.action ?? null,
        clientOrderId: intent.clientOrderId ?? null,
      });
      placementIntentCache = { at: 0, intents: [] };
      return { success: true, message: `Discarded ${intent.action ?? 'placement'} intent — placements resume for this fund` };
    }

    if (!intent.clientOrderId) {
      return { success: false, error: 'This intent carries no client order id (the process died before the response), so it cannot be looked up. Check the exchange manually, cancel any duplicate, then discard it.' };
    }
    if (typeof adapter.findOrderByClientOrderId !== 'function') {
      return { success: false, error: `${exchange} cannot look up an order by client id; check the exchange manually, then discard the intent` };
    }

    const found = await adapter.findOrderByClientOrderId(intent.clientOrderId, productId).catch((err) => ({ __lookupError: err }));
    if (found?.__lookupError) {
      return { success: false, error: `Lookup failed (${found.__lookupError.message}) — the intent stays pending; we must not assume the order is absent` };
    }
    // Some adapters search bounded history, so null alone cannot safely release
    // an old intent. A positively identified terminal order with no fills can.
    if (automatic && found?.orderId && ['CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(found.status)
      && found.filledSize === 0) {
      const removed = resolvePlacementIntent(exchange, pair, intentId);
      placementIntentCache = { at: 0, intents: [] };
      return { success: removed, message: 'Exchange confirmed an unfilled terminal order; placements may resume' };
    }
    if (automatic && found && !['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(found.status)) {
      return { success: false, error: 'Exchange order status remains unknown; retrying automatically' };
    }
    if (automatic && !found) return { success: false, error: 'No matching order found; retaining the intent and retrying automatically' };
    if (!found) {
      return { success: false, error: `The exchange reports no order for client id ${intent.clientOrderId}. If you have confirmed that, discard the intent instead — an empty lookup is never auto-cleared.` };
    }

    // Recheck after the lookup await. From here through persistence and removal
    // there are no awaits, so concurrent operator requests cannot interleave.
    // Keep the intent until tracking reaches disk: a failed write must leave
    // placements blocked and allow this adoption to be retried.
    if (!describePlacementIntents(exchange, pair).some(i => i.id === intentId)) {
      return { success: false, error: `Placement intent ${intentId} was already resolved` };
    }

    if (!orderExecutor.capabilities?.liveReconciliation) {
      return { success: false, error: 'This executor cannot adopt orders; the placement intent remains unresolved' };
    }
    if (!found.orderId) return { success: false, error: 'Exchange lookup returned no order id; the placement intent remains unresolved' };
    const entry = intent.action === 'entry_bid' || intent.action === 'entry_replacement';
    const ladder = intent.action === 'ladder_entry';
    const legacyTp = ['take_profit', 'take_profit_taker', 'take_profit_replacement'].includes(intent.action);
    const body = intent.action === 'body_tp'
      ? (positionState.celestialBodies || []).find(b => b.id === intent.bodyId)
      : null;
    if (!entry && !ladder && !legacyTp && !body) {
      return { success: false, error: 'No position owner exists for this placement; the intent remains unresolved' };
    }
    const existingTp = body?.tpOrderId || (legacyTp ? positionState.activeTpOrderId : null);
    if (existingTp && existingTp !== found.orderId) {
      return { success: false, error: 'The position already owns another TP; reconcile the exchange orders before adopting this placement' };
    }
    const adopted = orderExecutor.adoptPlacement(found, intent);

    // Mirror what a normal entry placement persists, so restart recovery and
    // the cancel/fill bookkeeping see the adopted order too. Deduped by order
    // id, since this path is reachable only once per intent but the list is
    // also rebuilt from disk on restart.
    if (entry) {
      if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
      if (!positionState.pendingEntryOrders.some(e => e.orderId === found.orderId)) {
        positionState.pendingEntryOrders.push({
          orderId: found.orderId,
          price: intent.price ?? 0,
          assetQty: intent.size ?? 0,
          sizeUsdc: intent.sizeUsdc ?? 0,
          placedAt: intent.createdAt ?? Date.now(),
        });
      }
    }
    if (ladder) {
      positionState.pendingLadderOrders ||= [];
      if (!positionState.pendingLadderOrders.some(o => o.orderId === found.orderId)) {
        positionState.pendingLadderOrders.push({
          orderId: found.orderId, ladderIndex: intent.ladderIndex,
          price: intent.price ?? 0, assetQty: intent.size ?? 0,
          sizeUsdc: intent.sizeUsdc ?? 0, placedAt: intent.createdAt ?? Date.now(),
        });
      }
      positionState.ladderActive = true;
      positionState.ladderPlacedAt ||= intent.createdAt ?? Date.now();
    }
    if (body) {
      body.tpOrderId = found.orderId;
      body.tpPrice = intent.price ?? 0;
      body.assetOnOrder = intent.size ?? 0;
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      const sourceIds = new Set(body.sourceOrderIds || []);
      for (const buy of (body.buyOrders || [])) {
        if (buy.orderId && buy.orderId !== 'core-migration') sourceIds.add(buy.orderId);
      }
      fillLedger.annotateFillsByOrderIds(sourceIds, {
        sellOrderId: found.orderId, bodyId: body.id, bodyTier: body.tier,
      });
    }
    if (legacyTp) {
      positionState.activeTpOrderId = found.orderId;
      positionState.lastTpPrice = intent.price ?? 0;
      positionState.assetOnOrder = intent.size ?? 0;
      const sourceIds = new Set(fillLedger.getCurrentCycleFills()
        .filter(f => f.side === 'buy' && !f.isBodyOwned && !f.isSatellite && !f.bodyId && f.cycleAttribution !== 'timeframe')
        .map(f => f.orderId));
      fillLedger.annotateFillsByOrderIds(sourceIds, { sellOrderId: found.orderId });
    }
    if (!isDryRun) {
      saveLiveState();
      fillLedger.persist();
    }
    resolvePlacementIntent(exchange, pair, intentId);

    logger.info(`ℹ️ ✅ [${exchange}] ${automatic ? 'Automatically adopted' : 'Operator adopted'} exchange order ${found.orderId} for placement intent ${intentId} (${intent.action ?? 'order'})`, {
      intentId,
      orderId: found.orderId,
      clientOrderId: intent.clientOrderId,
      action: intent.action ?? null,
      tracked: adopted.tracked,
    });
    placementIntentCache = { at: 0, intents: [] };
    return { success: true, adoptedOrderId: found.orderId, message: adopted.message };
  };

  // Run under the periodic reconciliation lock, before polling fills or TP
  // repair. Sequential lookups avoid bursts and cannot overlap another tick.
  const reconcilePendingPlacements = async () => {
    if (isDryRun || typeof adapter.findOrderByClientOrderId !== 'function') return;
    for (const intent of getBlockingPlacementIntents(exchange, pair)) {
      if (!intent.clientOrderId) continue;
      try {
        const result = await reconcilePlacementIntent(intent.id, 'adopt', { automatic: true });
        if (!result.success) logger.warn(`⏳ [${exchange}] Placement ${intent.id}: ${result.error}`);
      } catch (err) {
        logger.warn(`⏳ [${exchange}] Placement ${intent.id} recovery will retry: ${err.message}`);
      }
    }
  };

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
      positionState = createInitialPositionState();
      // Drop the in-memory risk manager's drawdown peak/pause too — otherwise
      // it survives the positionState wipe and the next metrics tick writes
      // the stale peak/pause right back into the fresh state (issue #742).
      riskManager.resetDrawdown();
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

  /**
   * Update position state externally (e.g., from recalculate)
   * @param {Object} newPosition - New position values to merge
   */
  const updatePosition = (newPosition) => {
    positionState = {
      ...positionState,
      ...newPosition,
    };
    saveLiveState();
    logger.info(`🔄 [${exchange}] Position updated externally: buys=${positionState.cycleBuys}, cycles=${positionState.cyclesCompleted}, ${baseCurrency} reserves=${positionState.realizedAssetPnL}`);
  };

  /** Tail of the serialized extendBodiesFromRecoveredBuyRows runs. */
  let recoveredGrowthChain = Promise.resolve();

  /**
   * Grow each body that owns recovered partial rows of its own buy order
   * (planBodyGrowthFromRecoveredBuyRows, #752) via extendBody, which cancels
   * the body's TP BEFORE growing it and re-places it at the new size. Runs at
   * start (once live) and after an operator recalc. Fire-and-forget (callers
   * don't wait on exchange round trips) but serialized, and idempotent —
   * extendBody merges only the order's remaining shortfall, so a failed or
   * repeated attempt is simply retried by the next recalc or start.
   * @returns {Promise<void>}
   */
  const extendBodiesFromRecoveredBuyRows = () => {
    // Chain onto any earlier run so back-to-back recalcs never overlap; each
    // run plans against the bodies as they are when it starts.
    recoveredGrowthChain = recoveredGrowthChain.then(async () => {
      const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger, celestialBodies: positionState.celestialBodies });
      for (const { buyOrderId, reason } of skipped) {
        logger.warn(`⚠️ [${exchange}] Recovered buy rows of ${String(buyOrderId).slice(0, 8)} not merged into a body (${reason}) — manual review`, { buyOrderId, reason });
      }
      for (const { body, buyOrderId, totals } of plans) {
        try {
          const res = await extendBody(body.id, totals, buyOrderId);
          if (!res.success) logger.warn(`⚠️ [${exchange}] Could not grow body ${body.id.slice(-8)} from recovered rows of buy ${String(buyOrderId).slice(0, 8)}: ${res.error}`, { bodyId: body.id, buyOrderId, error: res.error });
        } catch (err) {
          logger.error(`❌ [${exchange}] Growing body ${body.id.slice(-8)} from recovered rows of buy ${String(buyOrderId).slice(0, 8)} failed: ${err.message}`, { bodyId: body.id, buyOrderId, error: err.message });
        }
      }
    }).catch((err) => {
      logger.error(`❌ [${exchange}] Recovered-row body growth failed: ${err.message}`, { error: err.message });
    });
    return recoveredGrowthChain;
  };

  /**
   * Recompute cycle boundaries on the engine's OWN ledger and re-derive P&L
   * from the cycle-pair source of truth. Used by the regime:recalculate
   * handler so it never has to (a) instantiate a second ledger on the same
   * file (lost-update race), (b) write FIFO/closed-trades totals as
   * realizedPnL, or (c) blind-merge a rebuilt position into the live engine
   * (which would null activeTpOrderId and resurrect stale bodies). It mutates
   * only realizedPnL / realizedAssetPnL / heldAssetCostBasis / cyclesCompleted
   * — never order tracking, lifecycle, or ladder state (issue #96) — except
   * that a body owning recovered rows of its own buy order is then grown
   * through extendBody, which re-places that body's TP (#752).
   * @returns {{cyclesCompleted:number, realizedPnL:number, realizedAssetPnL:number, cycleDetails:any[], orphansFixed:number, activeCycleId:string|null}}
   */
  const recalculateAndRefresh = () => {
    // Anchor the ledger on the durable boundary first so renumbering keeps
    // THAT cycle last and reports its rename in idMap (#675).
    restorePersistedCycleId(fillLedger, positionState, logger, exchange);
    const recalc = fillLedger.recalculateCycles();
    syncActiveCycleIdAfterRecalc(recalc);
    resyncLiveCycleCountersAfterRecalc(recalc);
    positionState.cyclesCompleted = recalc.cyclesCompleted;
    // Source of truth — cycle pairs, NOT FIFO/closed-trades. Also updates
    // realizedAssetPnL and heldAssetCostBasis and persists.
    refreshRealizedFromCyclePairs();
    saveLiveState();
    extendBodiesFromRecoveredBuyRows();
    return {
      cyclesCompleted: recalc.cyclesCompleted,
      realizedPnL: positionState.realizedPnL,
      realizedAssetPnL: positionState.realizedAssetPnL,
      cycleDetails: recalc.cycleDetails,
      orphansFixed: recalc.orphansFixed,
      activeCycleId: recalc.activeCycleId,
    };
  };

  /**
   * Manually merge a body into the next-highest body by TP price.
   * Cancels both TPs, combines all buys, re-places a single merged TP.
   * @param {string} bodyId - ID of the source body (lower TP) to roll up
   * @returns {Promise<{success: boolean, message: string, mergedBody?: Object}>}
   */
  // Inner merge primitive — assumes the caller holds the merge lock (see the
  // manualMergeBody wrapper). opts.targetId forces a specific merge target
  // (used by the dust consolidator, which must NOT rely on tpPrice ordering —
  // a restored sub-min body can carry a stale tpPrice); opts.label customises
  // the log prefix (#189).
  const _mergeBodyImpl = async (bodyId, opts = {}) => {
    const { targetId = null, label = 'Manual roll-up' } = opts;
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    const bodies = positionState.celestialBodies || [];
    if (bodies.length < 2) {
      return { success: false, message: 'Need at least 2 bodies to merge' };
    }
    const source = bodies.find(b => b.id === bodyId);
    if (!source) {
      return { success: false, message: `Body ${bodyId} not found` };
    }

    let target;
    if (targetId != null) {
      // Explicit target (dust consolidation): merge source INTO this body.
      target = bodies.find(b => b.id === targetId && b.id !== source.id);
      if (!target) {
        return { success: false, message: `Target body ${targetId} not found` };
      }
    } else {
      // Default: merge into the next-highest body by tpPrice (lowest tpPrice above source's).
      const candidates = bodies
        .filter(b => b.id !== source.id && b.tpPrice > source.tpPrice)
        .sort((a, b) => a.tpPrice - b.tpPrice);
      if (candidates.length === 0) {
        return { success: false, message: 'No higher body to merge into (this is the highest)' };
      }
      target = candidates[0];
    }

    // Check both orders for partial fills before merging
    for (const body of [source, target]) {
      if (body.tpOrderId) {
        const orderStatus = await adapter.getOrder(body.tpOrderId).catch(() => null);
        if (orderStatus && orderStatus.filledSize > 0) {
          const which = body === source ? 'Source' : 'Target';
          return { success: false, message: `${which} body ${body.id.slice(-8)} has a partially filled TP order (${orderStatus.filledSize} filled) — cannot merge` };
        }
      }
    }

    logger.info(`🔗 [${exchange}] ${label}: merging body ${source.id.slice(-8)} (TP ${fmtPrice(source.tpPrice)}) → ${target.id.slice(-8)} (TP ${fmtPrice(target.tpPrice)})`);

    // Race 3: snapshot both bodies before cancelling TPs
    // If a TP fills between cancel and state removal, the fill handler uses the snapshot
    const sourceSnapshot = snapshotBody(source);
    const targetSnapshot = snapshotBody(target);
    if (source.tpOrderId) pendingMergeTpOrders.set(source.tpOrderId, sourceSnapshot);
    if (target.tpOrderId) pendingMergeTpOrders.set(target.tpOrderId, targetSnapshot);

    // Capture pre-merge TP% so the merged body's TP% can only decrease, never increase.
    // Merging cheaper buys lowers avgPrice; capping at prevTpPct ensures the absolute
    // sell price also decreases (new tpPrice = lowerAvgPrice × cappedTpPct < oldTpPrice).
    const prevTargetTpPct = targetSnapshot.tpPrice > 0 && targetSnapshot.avgPrice > 0
      ? (targetSnapshot.tpPrice / targetSnapshot.avgPrice - 1) * 100
      : null;

    // A body TP that executes a tranche WHILE we're cancelling it (issue #368,
    // mirrors the buy-merge precedent at #227) still reports cancelled: true —
    // classifyBodyTpCancellation is what tells clean cancels apart from
    // execution-bearing ones. The Race-3 snapshots set above (before either
    // cancel call) let handleOrderFillImpl's merge-snapshot branch find the
    // still-live body (neither source nor target has been removed from
    // celestialBodies yet at this point), deduct the sold qty/prorated cost,
    // and re-place a right-sized TP — all in one call, reusing the exact same
    // booking path the buy-merge race already relies on. We call
    // handleOrderFillImpl directly (not the handleOrderFill wrapper) because
    // the wrapper's fill gate waits on this merge hold — going through it
    // would self-stall for its full 15s wait window every time.
    const bookExecutionDuringCancel = async (body, snapshot, cancelResult) => {
      const soldTp = snapshot.tpOrderId;
      pendingMergeTpOrders.delete(soldTp);
      completedMergeTpOrders.set(soldTp, snapshot);
      const t = setTimeout(() => { completedMergeTpOrders.delete(soldTp); ttlTimers.delete(t); }, 300000);
      ttlTimers.add(t);
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
      saveLiveState();
      await handleOrderFillImpl(buildPartialFillData(soldTp, 'sell', {
        status: 'CANCELLED',
        filledSize: cancelResult.filledSize,
        filledValue: cancelResult.filledValue,
        averageFilledPrice: cancelResult.averageFilledPrice,
      }, { totalFees: cancelResult.totalFees || 0 }), { set: null, key: null }).catch((err) => {
        logger.warn(
          `⚠️ [${exchange}] Failed to book body TP partial fill for ${soldTp.slice(0, 8)} immediately: ${err.message} — relying on a later WS/poll event`,
          { orderId: soldTp, error: err.message }
        );
      });
      return soldTp;
    };

    // Cancel source TP
    const srcCancel = await orderExecutor.cancelBodyTpOrder(source.id, source.tpOrderId);
    const srcOutcome = classifyBodyTpCancellation(srcCancel);
    if (srcOutcome === 'filled' || srcOutcome === 'unresolved') {
      // Clean up snapshots
      if (source.tpOrderId) pendingMergeTpOrders.delete(source.tpOrderId);
      if (target.tpOrderId) pendingMergeTpOrders.delete(target.tpOrderId);
      const reason = srcOutcome === 'filled' ? 'already filled' : 'cancel failed';
      logger.warn(`⚠️ [${exchange}] Source body ${source.id.slice(-8)} TP ${reason}, aborting roll-up`);
      return { success: false, message: `Source TP ${reason}` };
    }
    if (srcOutcome === 'cancelled_with_execution') {
      // Target's TP was never touched (we cancel source first) — just drop its
      // snapshot and abort; booking deducts the sold qty/cost from the
      // still-live source body and re-arms a right-sized TP on it directly, so
      // there's nothing left needing this roll-up attempt.
      if (target.tpOrderId) pendingMergeTpOrders.delete(target.tpOrderId);
      const soldTp = await bookExecutionDuringCancel(source, sourceSnapshot, srcCancel);
      logger.warn(`⚠️ [${exchange}] Source body ${source.id.slice(-8)} TP filled ${srcCancel.filledSize} ${baseCurrency} during cancel — booked ${soldTp.slice(-8)}, aborting roll-up (#368)`);
      return { success: false, message: `Source TP filled during cancel (${srcCancel.filledSize} ${baseCurrency}) — booked, roll-up aborted` };
    }
    // Clean cancel — clear source body TP fields
    source.tpOrderId = null;
    source.tpPrice = 0;
    source.assetOnOrder = 0;

    // Cancel target TP
    const tgtCancel = await orderExecutor.cancelBodyTpOrder(target.id, target.tpOrderId);
    const tgtOutcome = classifyBodyTpCancellation(tgtCancel);
    if (tgtOutcome === 'filled' || tgtOutcome === 'unresolved') {
      // Clean up snapshots
      if (sourceSnapshot.tpOrderId) pendingMergeTpOrders.delete(sourceSnapshot.tpOrderId);
      if (target.tpOrderId) pendingMergeTpOrders.delete(target.tpOrderId);
      // Restore source TP to avoid leaving it dangling
      const reason = tgtOutcome === 'filled' ? 'already filled' : 'cancel failed';
      logger.warn(`⚠️ [${exchange}] Target body ${target.id.slice(-8)} TP ${reason}, restoring source TP`);
      await placeBodyTp(source);
      saveLiveState();
      return { success: false, message: `Target TP ${reason}, source restored` };
    }
    if (tgtOutcome === 'cancelled_with_execution') {
      // Source's TP was already cleanly cancelled above, so it needs restoring
      // before we abort (mirrors the failed-cancel branch above). Booking
      // deducts the sold qty/cost from the still-live target body and re-arms
      // a right-sized TP on it directly.
      if (sourceSnapshot.tpOrderId) pendingMergeTpOrders.delete(sourceSnapshot.tpOrderId);
      const soldTp = await bookExecutionDuringCancel(target, targetSnapshot, tgtCancel);
      logger.warn(`⚠️ [${exchange}] Target body ${target.id.slice(-8)} TP filled ${tgtCancel.filledSize} ${baseCurrency} during cancel — booked ${soldTp.slice(-8)}, restoring source TP, aborting roll-up (#368)`);
      await placeBodyTp(source);
      saveLiveState();
      return { success: false, message: `Target TP filled during cancel (${tgtCancel.filledSize} ${baseCurrency}) — booked, source restored, roll-up aborted` };
    }
    // Clean cancel — clear target body TP fields
    target.tpOrderId = null;
    target.tpPrice = 0;
    target.assetOnOrder = 0;

    // Merge bodies (pure data)
    const merged = celestialHierarchy.mergeBodies(target, source, config.maxUsdcDeployed, logger);

    // Remove source from celestialBodies
    positionState.celestialBodies = positionState.celestialBodies.filter(b => b.id !== source.id);

    // Move snapshots from pending → completed (5min TTL for late-arriving fills)
    if (sourceSnapshot.tpOrderId) {
      pendingMergeTpOrders.delete(sourceSnapshot.tpOrderId);
      completedMergeTpOrders.set(sourceSnapshot.tpOrderId, sourceSnapshot);
      const t3 = setTimeout(() => { completedMergeTpOrders.delete(sourceSnapshot.tpOrderId); ttlTimers.delete(t3); }, 300000);
      ttlTimers.add(t3);
    }
    if (targetSnapshot.tpOrderId) {
      pendingMergeTpOrders.delete(targetSnapshot.tpOrderId);
      completedMergeTpOrders.set(targetSnapshot.tpOrderId, targetSnapshot);
      const t4 = setTimeout(() => { completedMergeTpOrders.delete(targetSnapshot.tpOrderId); ttlTimers.delete(t4); }, 300000);
      ttlTimers.add(t4);
    }

    // Check cascading promotions and sync aggregates
    celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    // Re-annotate source body's fills with merged body's ID
    for (const srcId of (source.sourceOrderIds || [])) {
      fillLedger.annotateFillsByOrderId(srcId, { bodyId: merged.id, bodyTier: merged.tier });
    }
    for (const buyOrder of (source.buyOrders || [])) {
      if (buyOrder.orderId && buyOrder.orderId !== 'core-migration') {
        fillLedger.annotateFillsByOrderId(buyOrder.orderId, { bodyId: merged.id, bodyTier: merged.tier });
      }
    }

    // Place new combined TP (handles holdback, annotation for ALL source buy fills).
    // Cap TP% at the pre-merge target level so the sell price can only go down after merge.
    if (prevTargetTpPct != null) merged._maxTpPct = prevTargetTpPct;
    await placeBodyTpWithRetry(merged, 'Roll-up');

    // Persist
    saveLiveState();
    fillLedger.persist();

    const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
    logger.info(`${tierCfg.emoji} [${exchange}] Roll-up complete: body ${merged.id.slice(-8)} now ${merged.tier} (${merged.assetQty.toFixed(6)} ${baseCurrency}, $${merged.costBasis.toFixed(2)}, ${merged.buyOrders?.length || 0} buys)`);

    tradeEvents.emitTradeEvent('body_rollup', exchange, `${tierCfg.emoji} Merged → ${merged.tier}: ${merged.assetQty.toFixed(6)} ${baseCurrency}`, {
      mergedBodyId: merged.id,
      mergedTier: merged.tier,
      assetQty: merged.assetQty,
      costBasis: merged.costBasis,
      avgPrice: merged.avgPrice,
      sourceBodyId: source.id,
      buyCount: merged.buyOrders?.length || 0,
    });

    // Push updated status via WebSocket so dashboard animation refreshes immediately
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

    return {
      success: true,
      message: `Merged ${source.id.slice(-8)} → ${merged.id.slice(-8)} (${merged.tier})`,
      mergedBody: {
        id: merged.id,
        tier: merged.tier,
        assetQty: merged.assetQty,
        costBasis: merged.costBasis,
        avgPrice: merged.avgPrice,
        buyCount: merged.buyOrders?.length || 0,
      },
    };
  };

  /**
   * Public single-body merge. Acquires the merge lock (deferring if a merge or
   * reconcile is already running) so a metrics-timer dust merge can't interleave
   * with an operator roll-up or the reconcile loop (#189). Nested callers that
   * already hold the lock (rollupAllBodies) reenter rather than self-deadlocking.
   * @param {string} bodyId
   * @param {{targetId?: string, label?: string}} [opts]
   */
  const manualMergeBody = async (bodyId, opts = {}) =>
    engineLocks.withMergeLock(() => _mergeBodyImpl(bodyId, opts));

  /**
   * Collapse every celestial body into a single body with one TP order.
   * Iteratively rolls up the lowest-TP body into the next-highest using
   * manualMergeBody until only one body remains.
   * @returns {Promise<{success: boolean, message: string, mergedCount?: number, finalBody?: Object}>}
   */
  const rollupAllBodies = async () => {
    if (!isRunning) return { success: false, message: 'Engine not running' };
    const startCount = (positionState.celestialBodies || []).length;
    if (startCount < 2) {
      return { success: false, message: `Need at least 2 bodies to collapse, found ${startCount}` };
    }
    // Acquire the merge lock ONCE for the whole collapse (defer to any in-flight
    // merge/reconcile). Inner manualMergeBody calls reenter that hold (#189).
    return engineLocks.withMergeLock(async () => {
      logger.info(`🔗 [${exchange}] Collapse-all triggered: ${startCount} bodies → 1`);

      let mergedCount = 0;
      let lastResult = null;
      // Safety bound: each iteration removes one body, so we can't need more than startCount-1
      for (let i = 0; i < startCount - 1; i++) {
        const bodies = positionState.celestialBodies || [];
        if (bodies.length < 2) break;
        const lowest = [...bodies].sort((a, b) => (a.tpPrice || 0) - (b.tpPrice || 0))[0];
        const result = await manualMergeBody(lowest.id);
        if (!result.success) {
          return {
            success: false,
            message: `Collapse aborted after ${mergedCount} merges: ${result.message}`,
            mergedCount,
          };
        }
        mergedCount++;
        lastResult = result;
      }

      return {
        success: true,
        message: `Collapsed ${startCount} bodies into 1 (${mergedCount} merges)`,
        mergedCount,
        finalBody: lastResult?.mergedBody || null,
      };
    });
  };

  /**
   * Operator action: reset the accumulation cycle to re-enable buying after the
   * cycle buy-limit (maxCycleBuys) has paused new entries. Reuses the engine's
   * persistent resetCycle() primitive — sets cycleBuys=0, starts a new fill-ledger
   * cycle (so getCurrentCycleAllBuysCount() reads 0 and the reset survives a
   * restart), preserves open celestial bodies and their take-profits, and resets
   * risk-manager cycle tracking. Persists immediately so the new cycle boundary
   * survives a kill.
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const resetCycleBuys = async () => {
    if (!isRunning) return { success: false, message: 'Engine not running' };
    // Also gate on in-flight fills (as consolidateDustBodies does via
    // isMutatingPosition): a fill mid-handling may be ingested into the ledger
    // under the about-to-be-superseded cycle but not yet reflected in
    // positionState.cycleBuys — resetting the cycle boundary underneath it
    // desyncs cycleBuys from the ledger and a restart's auto-correct can
    // silently erase a real buy step (issue #232 follow-up).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }
    // An operator reset must not queue behind (or, after the wait bound, run
    // alongside) a ladder rebuild/cancel/reset in flight (#766) — refuse like
    // rebuildLadder/cancelLadder. Uncontended, resetCycle below takes the
    // ladder lock synchronously, so nothing can slip in between.
    if (engineLocks.isLadderBusy()) {
      return { success: false, message: engineLocks.describeBusy('ladder') };
    }
    // resetCycle() treats a DRAINING lifecycle as "this cycle boundary is the
    // close trigger" and transitions straight to CLOSED (stopping the engine
    // via onLifecycleClosed) — an operator clicking "resume buying" while the
    // fund happens to also be draining must not silently close/stop it
    // instead (issue #232 follow-up).
    if (positionState.lifecycle === LIFECYCLE.DRAINING || positionState.lifecycle === LIFECYCLE.CLOSED) {
      return { success: false, message: `Fund lifecycle is ${positionState.lifecycle} — cycle reset is not applicable` };
    }
    // resetCycle() unconditionally nulls positionState.activeTpOrderId/assetOnOrder
    // without cancelling the exchange order first — safe when it's called after
    // that TP already filled (its only other call sites), but in legacy core
    // mode (celestialEnabled: false) hitting the cycle-buy cap does NOT imply
    // the TP filled — it's typically still resting live, covering the whole
    // accumulated position. Wiping tracking here would orphan a real order: a
    // later fill would arrive with no positionState.activeTpOrderId to match,
    // and a restart before it fills would lose the ability to restore it
    // (issue #232 follow-up). Celestial mode is unaffected — its TPs live on
    // each body, not on this legacy field.
    if (positionState.activeTpOrderId) {
      return { success: false, message: 'A take-profit order is still resting — cancel or wait for it before resetting the cycle' };
    }
    logger.info(`🔄 [${exchange}] Operator reset-cycle: cycleBuys ${positionState.cycleBuys} -> 0, starting new cycle`);
    await resetCycle();
    await saveLiveState();
    return { success: true, message: 'Cycle reset — buying re-enabled', status: getStatus() };
  };

  /**
   * Manually set the TP% for a specific celestial body.
   * Cancels the existing TP, then re-places it at the specified percentage above avgPrice.
   * The override is subject to the fee floor (cannot be set so low it loses money).
   * @param {string} bodyId
   * @param {number} tpPct - Desired TP% (e.g. 2.5 means 2.5% above avgPrice)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPercent = async (bodyId, tpPct) => {
    if (!isRunning) return { success: false, message: 'Engine not running' };

    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };

    if (body.tpOrderId) {
      const outcome = await cancelBodyTpForReplace(body, 'Manual TP edit');
      if (outcome !== 'cancelled') {
        // A tranche that sold during the cancel was booked by the helper,
        // which also re-placed a right-sized TP — the operator can retry the
        // edit against the reduced body.
        const reason = {
          filled: 'already filled',
          unresolved: 'cancel failed',
          booked: 'sold during cancel — sale booked and the TP re-sized to what the body still holds; retry to apply the new TP',
          booking_failed: 'sold during cancel — booking deferred to reconciliation',
        }[outcome];
        saveLiveState();
        const state = getState();
        if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(state);
        return { success: false, message: `Existing TP ${reason}`, status: state };
      }
    }

    body.manualTpPct = tpPct;
    body._overrideTpPct = tpPct;
    const placed = await placeBodyTp(body);

    if (!placed) {
      return { success: false, message: `Could not place TP at ${tpPct.toFixed(2)}% — below fee floor or invalid` };
    }

    const tierCfg = celestialHierarchy.getTierConfig(body.tier);
    logger.info(`${tierCfg.emoji} [${exchange}] Manual TP% set: body ${body.id.slice(-8)} @ ${tpPct.toFixed(2)}% → ${fmtPrice(body.tpPrice)}`);

    saveLiveState();
    const state = getState();
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(state);

    return {
      success: true,
      message: `TP set to ${body.tpPrice ? fmtPrice(body.tpPrice) : `${tpPct.toFixed(2)}%`} for body ${bodyId.slice(-8)}`,
      status: state,
    };
  };

  /**
   * Manually set the TP limit price for a specific celestial body.
   * Converts to TP% internally and delegates to the same placement flow.
   * @param {string} bodyId
   * @param {number} limitPrice - Desired limit price (must be above avgPrice + fee floor)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPrice = async (bodyId, limitPrice) => {
    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };
    if (body.avgPrice <= 0) return { success: false, message: 'Body has no avg price' };
    if (limitPrice <= body.avgPrice) return { success: false, message: `Price must be above avg cost ${fmtPrice(body.avgPrice)}` };

    const tpPct = ((limitPrice - body.avgPrice) / body.avgPrice) * 100;
    return setBodyTpPercent(bodyId, tpPct);
  };

  /**
   * Force rebuild of TP sell order with current position
   * Useful when position state was corrected manually
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildTP = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if (positionState.totalAsset <= 0) {
      return { success: false, message: 'No position to protect' };
    }
    logger.info(`🔄 [${exchange}] Manual TP rebuild requested for ${positionState.totalAsset.toFixed(8)} ${baseCurrency}`);
    await placeTakeProfitOrder({ forceUpdate: true });
    return { success: true, message: `TP rebuilt for ${positionState.totalAsset.toFixed(8)} ${baseCurrency} @ ${fmtPrice(positionState.lastTpPrice)}` };
  };

  /**
   * Preview what a ladder rebuild would place (dry calculation, no orders)
   * @returns {{success: boolean, message?: string, preview?: Object}}
   */
  /**
   * Compute allocated capital defensively: use totalCostBasis but floor at
   * celestial body sum in case totalCostBasis is stale (e.g. after mode switch).
   */
  const getAllocatedCapital = () => {
    const bodiesCost = (positionState.celestialBodies || []).reduce((sum, b) => sum + (b.costBasis || 0), 0);
    return Math.max(positionState.totalCostBasis || 0, bodiesCost);
  };

  const previewLadder = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;

    // Fetch actual exchange balance to cap budget at reality
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    const exchangeBalance = quoteBalance ? (parseFloat(quoteBalance.available) || 0) : null;
    if (exchangeBalance !== null && exchangeBalance < remainingBudget) {
      remainingBudget = exchangeBalance;
    }

    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      const balanceStr = exchangeBalance !== null ? `$${exchangeBalance.toFixed(2)}` : 'unknown';
      return { success: false, message: `Exchange ${quoteCurrency} balance (${balanceStr}) below min order ($${config.baseSizeUsdc || 50}). Budget shows $${budgetRemaining} remaining but exchange only has ${balanceStr} ${quoteCurrency}.` };
    }

    const ladder = ladderCalculator.buildLadder(
      marketState.lastPrice,
      remainingBudget,
      {
        atr: marketState.atr1m,
        volBaseline: marketState.volBaseline,
        realizedVol: marketState.realizedVol,
        athDistance: marketState.athDistance || 0,
        ath: marketState.ath || 0,
        priceIncrement,
      }
    );

    return {
      success: true,
      preview: {
        levelCount: ladder.levels.length,
        levels: ladder.levels.map(l => ({
          price: l.price,
          sizeUsdc: l.sizeUsdc,
          assetQty: l.assetQty,
          distancePct: l.distancePct,
        })),
        lowerBound: ladder.lowerBound,
        lowerBoundPct: ladder.lowerBoundPct,
        totalBudget: ladder.totalBudget,
        allocatedCapital,
        exchangeBalance,
        maxUsdcDeployed: config.maxUsdcDeployed,
        currentPrice: marketState.lastPrice,
      },
    };
  };

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

  /**
   * Cancel existing ladder orders and rebuild from scratch
   * Bypasses health/regime guards (user-initiated)
   *
   * Holds the ladder lock from the first check to the last placement (#766),
   * so a TP close's resetCycle that lands mid-rebuild queues behind it and
   * then sweeps the fresh ladder, and a rebuild requested mid-reset runs
   * after the reset. Gives up with a busy message if another sweep is stuck.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildLadder = () => engineLocks.withLadderLock(rebuildLadderLocked, {
    onTimeout: 'refuse',
    label: 'Ladder rebuild',
    exchange,
  });

  /** @returns {Promise<{success: boolean, message: string}>} */
  const rebuildLadderLocked = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }
    // A manual rebuild places fresh buy rungs — the drawdown pause (#693)
    // applies; the operator clears it explicitly via Resume first.
    if (riskManager.getState().isDrawdownPaused) {
      return { success: false, message: 'Drawdown pause active — resume from the drawdown pause before rebuilding the ladder' };
    }
    // Don't start a ladder sweep mid-fill/merge/reconcile (same gate as
    // resetCycleBuys): a TP close's resetCycle runs inside a fill and sweeps
    // the ladder itself, and a sweep started underneath it can book a
    // mid-cancel rung while the cycle turns over (issue #711).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    if (!quoteBalance) {
      return { success: false, message: 'Could not fetch account balance — skipping ladder' };
    }
    const availableQuote = parseFloat(quoteBalance.available) || 0;
    if (availableQuote < remainingBudget) {
      remainingBudget = availableQuote;
    }
    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      return { success: false, message: `Exchange ${quoteCurrency} balance ($${availableQuote.toFixed(2)}) below min order size ($${config.baseSizeUsdc || 50}). Budget says $${budgetRemaining} available but only $${availableQuote.toFixed(2)} ${quoteCurrency} on exchange. Deposit more ${quoteCurrency} or lower baseSizeUsdc.` };
    }

    logger.info(`🔄 [${exchange}] Manual ladder rebuild requested, budget=$${remainingBudget.toFixed(2)} (allocated=$${allocatedCapital.toFixed(2)})`);

    // Re-check after the balance await above: don't size a ladder against a
    // position a fill that started meanwhile is still mutating (issue #711).
    // A fill that starts AFTER this point and closes the cycle no longer
    // races the sweep: its resetCycle queues on the ladder lock this rebuild
    // holds, then cancels the ladder placed below (#766).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    // Cancel existing ladder orders
    let midCancelSpend = 0;
    let partialFillReservations = [];
    let unbookedFills = [];
    if (positionState.ladderActive) {
      const cancelResult = await orderExecutor.cancelAllLadderOrders();
      // The cost estimate covers newly recorded partial tranches for the
      // balance clamp. The reservation details let the deployed-cap check
      // below distinguish a booked body from a poll callback still in flight.
      midCancelSpend = Number(cancelResult.partialFillsCost) || 0;
      partialFillReservations = Array.isArray(cancelResult.partialFillReservations) ? cancelResult.partialFillReservations : [];
      unbookedFills = Array.isArray(cancelResult.unbookedFills) ? cancelResult.unbookedFills : [];
      const filledDuringCancel = midCancelSpend + unbookedFills.reduce((sum, u) => sum + (Number(u.cost) || 0), 0);
      const spendNote = filledDuringCancel > 0 ? ` ($${filledDuringCancel.toFixed(2)} filled during the cancel)` : '';
      logger.info(`🧹 [${exchange}] Cancelled ${cancelResult.cancelled} existing ladder orders${spendNote}`);
    }

    // Reset ladder state
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // A rung can partially fill in the race window before the cancel above
    // took, and that fill is now booked into a body synchronously as part of
    // cancelAllLadderOrders (issue #674) — re-derive the budget from the
    // CURRENT state before sizing the new ladder, so a fill discovered
    // mid-cancel isn't missing from the math.
    //
    // Cash: the clamp must not size rungs against quote those fills spent
    // (issue #711). Where filling happened, re-read the balance: on exchanges
    // that hold quote for resting orders the fill was paid from the hold, so
    // the pre-cancel snapshot already excludes it and subtracting again would
    // wrongly starve the rebuild; elsewhere the fresh read reflects the spend.
    // Capped at the pre-cancel snapshot so a rebuild with a fill sizes the
    // same as one without (released holds are not newly counted). If the
    // re-read fails, fall back to subtracting the spend (conservative).
    const cancelTimeSpend = midCancelSpend + unbookedFills.reduce((sum, u) => sum + (Number(u.cost) || 0), 0);
    let postCancelQuote = availableQuote;
    if (cancelTimeSpend > 0) {
      const freshBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
      postCancelQuote = freshBalance
        ? Math.min(availableQuote, parseFloat(freshBalance.available) || 0)
        : Math.max(0, availableQuote - cancelTimeSpend);
    }
    // Deployed cap: derived after that await, so a fill committed during it
    // is counted and the new ladder can't push deployed capital past
    // maxUsdcDeployed. Partial and fully-filled rungs both reserve only the
    // size the persisted ledger still lacks; any recorded tranche is already
    // represented in a body's costBasis or was sold and its capital returned.
    // A polled partial may still be waiting on its fire-and-forget booking
    // callback when the cancel sweep returns. Reserve that tranche just like a
    // completely-filled rung, re-reading the ledger now so a callback that
    // finished during the sweep is not counted twice. Do not await those
    // callbacks here: a TP-close booking can be queued on the ladder lock this
    // rebuild owns.
    const unbookedSpend = [...unbookedFills, ...partialFillReservations].reduce((sum, u) => {
      const unbookedSize = Math.max(0, (Number(u.filledSize) || 0) - fillLedger.getRecordedSizeForOrder(u.orderId));
      return sum + unbookedSize * (Number(u.unitCost) || 0);
    }, 0);
    const postCancelAllocated = getAllocatedCapital() + unbookedSpend;
    remainingBudget = Math.min(config.maxUsdcDeployed - postCancelAllocated, postCancelQuote);
    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      return { success: false, message: `Budget dropped below min order size after a fill landed during ladder cancel ($${remainingBudget.toFixed(2)} left — $${(config.maxUsdcDeployed - postCancelAllocated).toFixed(2)} under the deployed cap, $${postCancelQuote.toFixed(2)} ${quoteCurrency} available). The old ladder was cancelled but not rebuilt — call rebuildLadder again if appropriate.` };
    }
    if (postCancelAllocated !== allocatedCapital || postCancelQuote !== availableQuote) {
      logger.info(`🔄 [${exchange}] Re-derived ladder budget after a cancel-time fill: $${remainingBudget.toFixed(2)} (allocated=$${postCancelAllocated.toFixed(2)}, was $${allocatedCapital.toFixed(2)}; available ${quoteCurrency}=$${postCancelQuote.toFixed(2)}, was $${availableQuote.toFixed(2)})`);
    }

    // Build new ladder
    const ladder = ladderCalculator.buildLadder(
      marketState.lastPrice,
      remainingBudget,
      {
        atr: marketState.atr1m,
        volBaseline: marketState.volBaseline,
        realizedVol: marketState.realizedVol,
        athDistance: marketState.athDistance || 0,
        ath: marketState.ath || 0,
        priceIncrement,
      }
    );

    if (ladder.levels.length === 0) {
      return { success: false, message: 'Ladder build produced 0 levels — price may be at or below floor' };
    }

    logger.info(`📊 [${exchange}] Rebuilding ladder: ${ladderCalculator.getSummary(ladder)}`);

    // Place ladder orders
    const generationAtPlace = cycleResetGeneration;
    const result = await orderExecutor.placeLadderOrders(ladder.levels);
    if (await abandonLadderPlacedAcrossReset(generationAtPlace, 'Ladder rebuild')) {
      return { success: false, message: 'A cycle reset ran while the new ladder was being placed, so it was cancelled — rebuild again if appropriate.' };
    }

    // Update position state
    positionState.ladderActive = true;
    positionState.ladderPlacedAt = Date.now();
    positionState.ladderLowerBound = ladder.lowerBound;
    positionState.pendingLadderOrders = result.orders;

    const msg = `Ladder rebuilt: ${result.orders.length} levels from ${fmtPrice(marketState.lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`;
    logger.info(`📊 [${exchange}] ${msg}`);

    tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
      levels: result.orders.length,
      topPrice: marketState.lastPrice,
      bottomPrice: ladder.lowerBound,
      lowerBoundPct: ladder.lowerBoundPct,
      totalBudget: ladder.totalBudget,
      failedCount: result.failedCount,
      manual: true,
    });

    // Persist state
    saveLiveState();

    return { success: true, message: msg };
  };

  /**
   * Cancel the ladder and switch to reactive entries. Serialised with the
   * other ladder sweeps on the ladder lock (#766) — see rebuildLadder.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const cancelLadder = () => engineLocks.withLadderLock(cancelLadderLocked, {
    onTimeout: 'refuse',
    label: 'Ladder cancel',
    exchange,
  });

  /** @returns {Promise<{success: boolean, message: string}>} */
  const cancelLadderLocked = async () => {
    if (!isRunning) return { success: false, message: 'Engine not running' };
    // Same gate as rebuildLadder (issue #711): don't sweep the ladder
    // underneath an in-flight fill/merge/reconcile.
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    const hadLadder = positionState.ladderActive;
    let cancelled = 0;

    if (hadLadder) {
      const result = await orderExecutor.cancelAllLadderOrders();
      cancelled = result.cancelled;
      logger.info(`🧹 [${exchange}] Cancelled ${cancelled} ladder orders`);
    }

    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Switch config to reactive
    config.entryMode = 'reactive';
    updateRegimeConfig(exchange, pair, { entryMode: 'reactive' });

    saveLiveState();

    const msg = hadLadder
      ? `Cancelled ${cancelled} ladder orders, switched to reactive mode`
      : 'No active ladder — switched to reactive mode';
    logger.info(`🔄 [${exchange}] ${msg}`);
    return { success: true, message: msg };
  };

  /**
   * Inject an externally-created celestial body into the running engine.
   * Syncs position aggregates, places TP, and saves state.
   * @param {Object} body - A body created via celestialHierarchy.createNewBody()
   * @returns {Promise<{success: boolean, bodyId: string, tpPlaced: boolean}>}
   */
  const injectBody = async (body) => {
    if (!isRunning) return { success: false, error: 'Engine not running' };
    positionState.celestialBodies = positionState.celestialBodies || [];
    // Defense in depth (issue #691): the caller (manual-trade-import's
    // importBuy) is expected to guard against re-injecting a body for a
    // retried buy, but a duplicate here would place a second live TP sell
    // for the same fill, eating into other bodies' inventory/holdback. Refuse
    // a body whose id already exists, or whose originating buy order is
    // already committed to a live body — checking the FULL sourceOrderIds/
    // buyOrders collections (codex review), not just index [0]: mergeIntoBody
    // (celestial-hierarchy.js) concatenates a merged-away body's
    // sourceOrderIds onto the survivor's, so a since-merged buy order can sit
    // anywhere in that array, not only at the front. Same predicate as
    // isBuyAlreadyCommitted (issue #131), inlined here to keep the matching
    // body reference for the error result.
    const injectedOrderId = body.sourceOrderIds?.[0];
    const duplicate = positionState.celestialBodies.find(
      (b) => b.id === body.id
        || (injectedOrderId && (
          (b.sourceOrderIds || []).includes(injectedOrderId)
          || (b.buyOrders || []).some((bo) => bo.orderId === injectedOrderId)
        ))
    );
    if (duplicate) {
      logger.warn(`⚠️ [${exchange}] Injected body ${body.id} refused: duplicate of existing body ${duplicate.id} (source order ${duplicate.sourceOrderIds?.[0]})`);
      return { success: false, error: 'duplicate body', bodyId: duplicate.id, tpPlaced: !!duplicate.tpOrderId };
    }
    positionState.celestialBodies.push(body);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    const tpResult = await placeBodyTp(body);
    saveLiveState();
    logger.info(`📦 [${exchange}] Injected body ${body.id} (${body.tier}): ${body.assetQty} BTC @ $${body.avgPrice.toFixed(2)}, TP placed: ${!!tpResult}`);
    return { success: true, bodyId: body.id, tpPlaced: !!tpResult };
  };

  /** Body ids with an extendBody in progress. */
  const extendInFlight = new Set();

  /**
   * Extend an already-live body with fills for its OWN buy order that
   * arrived after the body was first created (issue #726): the buy order
   * was still filling at first import, so the body — and its already-placed
   * TP — were sized only to the fills seen at that time. A later retry with
   * the fuller fill set must not silently drop the difference (the omission
   * this function exists to close).
   *
   * Grows assetQty/costBasis/avgPrice via the same celestialHierarchy.
   * mergeIntoBody a live DCA-buy-fill merge uses, then cancels and
   * re-places the body's TP (mirrors setBodyTpPercent/the startup reprice
   * pass, via cancelBodyTpForReplace — issue #670) so it covers the grown
   * assetQty. Per CLAUDE.md, `assetQty - assetOnOrder` IS the designed
   * holdback — but only for the BOUNDED, PLANNED fraction
   * calculateTakeProfitSize computes at TP-placement time. Leaving a stale
   * TP in place after growing assetQty would silently balloon that fraction
   * past what was ever planned: at sell time `proratedCostBasis` shrinks
   * (it's `costBasis × soldQty/assetQty`, and assetQty just grew) while the
   * unsold remainder grows, so the new fill's real cost basis is never
   * charged to `bodyPnl` and the fill's whole value leaks into
   * `bodyHoldbackAsset` as fabricated zero-cost profit — inflating Total
   * P&L (codex delta review).
   *
   * Idempotent across a crash between this call succeeding (saveLiveState
   * below) and the caller's own fill-ledger linkage write, AND across
   * compounding retries where more of the order fills again before the
   * ledger link ever lands (codex review, round 3 — the naive "compare a
   * caller-computed delta's total against already-recorded" version of this
   * check still double-counted: if extend #1 applies d1 but crashes before
   * the ledger link, and MORE fills (d2) arrive before the retry, the
   * retry's caller-computed delta covers d1+d2 again, re-adding the
   * already-applied d1). `totals` is therefore the buy order's FULL current
   * totals — every fill known for it, linked or not — not a delta. This
   * function computes the exact shortfall itself: what `totals` says should
   * be recorded, minus what this body's own `buyOrders` bookkeeping already
   * shows recorded for that orderId. That shortfall is merged (never
   * `totals` directly), so however many times this is called for the same
   * buyOrderId, in whatever order relative to crashes or new fills, the
   * body converges to exactly `totals` — never more.
   *
   * @param {string} bodyId - Body to extend (must still be live in this engine)
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals - buyOrderId's FULL current fill totals (not a delta)
   * @param {string} buyOrderId - The buy order `totals` describes
   * @returns {Promise<{success: boolean, error?: string, bodyId?: string, tier?: string, alreadyApplied?: boolean, tpPlaced?: boolean}>}
   */
  const extendBody = async (bodyId, totals, buyOrderId) => {
    if (!isRunning) return { success: false, error: 'Engine not running' };
    const body = (positionState.celestialBodies || []).find((b) => b.id === bodyId);
    if (!body) return { success: false, error: 'Body not found' };
    // One extend per body at a time (#752): a second caller (a recalc's
    // recovered-row growth, a manual import) would compute the same shortfall
    // before the first merged it, then merge it again after its own cancel —
    // and its cancel could null a TP the first had just re-placed.
    if (extendInFlight.has(body.id)) {
      return { success: false, error: 'Extend already in progress for this body — retry once it settles' };
    }
    extendInFlight.add(body.id);
    try {
      return await extendBodyLocked(body, totals, buyOrderId);
    } finally {
      extendInFlight.delete(body.id);
    }
  };

  /**
   * extendBody's work, run while the body holds its extendInFlight slot.
   * @param {Object} body
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals
   * @param {string} buyOrderId
   * @returns {Promise<{success: boolean, error?: string, bodyId?: string, tier?: string, alreadyApplied?: boolean, tpPlaced?: boolean}>}
   */
  const extendBodyLocked = async (body, totals, buyOrderId) => {
    const { recordedQty, shortfall } = celestialHierarchy.computeBuyOrderShortfall(body, totals, buyOrderId);
    if (!shortfall) {
      logger.info(`📦 [${exchange}] Extend for body ${body.id} / buy ${buyOrderId} already applied (${recordedQty} >= ${totals.assetQty}) — no-op retry`);
      return { success: true, bodyId: body.id, tier: body.tier, alreadyApplied: true };
    }

    // Cancel the existing TP BEFORE growing the body, so the re-place below
    // sizes against the grown assetQty, not the stale one.
    if (body.tpOrderId) {
      const cancelOutcome = await cancelBodyTpForReplace(body, 'Manual buy extend');
      if (cancelOutcome !== 'cancelled') {
        // 'booked' / 'booking_failed': a tranche sold during the cancel —
        // cancelBodyTpForReplace already booked that sale (or deferred it
        // to reconciliation) and re-placed a right-sized TP for the body's
        // NEW (reduced) shape itself, through the normal sell path. Merging
        // this extend on top now would race whatever that path just did.
        // 'filled' / 'unresolved': nothing was touched. Either way, fail
        // this attempt so the caller's ledger rows stay unlinked and
        // retryable (its contract) rather than silently dropping the fill
        // or double-booking against a body that just changed underneath us.
        saveLiveState();
        return { success: false, error: `Existing TP ${cancelOutcome} — retry the extend once reconciled` };
      }
    }

    celestialHierarchy.mergeIntoBody(body, shortfall, config.maxUsdcDeployed, buyOrderId, logger);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    const tpResult = await placeBodyTpWithRetry(body, 'ManualExtend');
    saveLiveState();
    logger.info(`📦 [${exchange}] Extended body ${body.id} (${body.tier}) with ${shortfall.assetQty} additional ${baseCurrency} from buy ${buyOrderId} (now ${body.assetQty} ${baseCurrency} total, TP re-placed: ${!!tpResult})`);
    return { success: true, bodyId: body.id, tier: body.tier, tpPlaced: !!tpResult };
  };

  return {
    start,
    stop,
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
      setMergeInProgress: engineLocks._test.setMergeInProgress,
      setReconcileInProgress: engineLocks._test.setReconcileInProgress,
      setFillInProgress: engineLocks._test.setFillInProgress,
      setDustMergeRetryAfter: (v) => { dustMergeRetryAfter = v; },
      // Speeds up the incompleteFills engine-level retry (issue #679
      // follow-up) for tests — production keeps the 10s/5-attempt default.
      setIncompleteFillRetryTiming: (delayMs, maxRetries) => {
        incompleteFillRetryDelayMs = delayMs;
        if (maxRetries !== undefined) incompleteFillMaxRetries = maxRetries;
      },
      getIncompleteFillRetryCount: (dedupKey) => incompleteFillRetries.get(dedupKey) || 0,
      getFlags: () => ({ isRunning, dustMergeRetryAfter, ...engineLocks.getFlags() }),
      consolidateDustBodies,
      mergeBody: _mergeBodyImpl,
      handleOrderFill,
      handlePolledFill: (orderId, status) => liveCallbacks.onFillDetected(orderId, status),
      handleEntryCancelled,
      getMergeTpSnapshots: () => ({ pending: new Map(pendingMergeTpOrders), completed: new Map(completedMergeTpOrders) }),
      sweepLedgerDrift,
      getFillDrift: () => fillDrift,
      getPositionCoverage: () => positionCoverage,
      reconcileTick,
      reconcilePendingPlacements,
      checkOfflineOrderFills,
      // Background persistence guards (issue #532)
      saveLiveStateGuarded,
      reloadStateFromDisk,
      getHealth: () => healthMonitor.getState(),
      getPositionState: () => positionState,
      // Clear the background TTL timers a merge/fill schedules (5-min dedup
      // sweeps) so a test process can exit without waiting on them.
      clearTimers: () => { for (const t of ttlTimers) clearTimeout(t); ttlTimers.clear(); },
      updateMetrics,
      ensureTakeProfitPlaced,
      refreshDrawdownGuard,
      getOrderExecutor: () => orderExecutor,
      resetCycle: () => resetCycle(),
      // A reset that timed out on the ladder lock and proceeded unserialised.
      resetCycleUnserialised: () => resetCycleLocked(null),
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
  measureUnbookedOrderQty,
  shouldSkipBuyRecommit,
  isStrandedDustBody,
  isFullTpExecution,
  pruneStaleTpCancelMarkers,
};
