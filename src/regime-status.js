// @ts-check
/**
 * Regime Status Synthesis (Stopped / Engine-Down)
 *
 * Canonical builder for the status payload served when a fund's regime
 * engine process is not running for the caller — cleanly stopped (the
 * engine PM2 process's own IPC handler answering `regime:status` with no
 * live engine instance), unreachable (the HTTP gateway's IPC-down
 * fallback), or between ticks while stopped (market-data-service's socket
 * stream). All three previously synthesized this payload independently
 * (issue #357), which let them drift — e.g. the socket stream never
 * re-derived P&L from the fill ledger while the other two did. Any future
 * change to the "engine not running" status shape now only needs to land
 * here.
 */

const { loadRegimeState, LIFECYCLE, describePlacementIntents } = require('./state-tracker');
const { getCachedFillLedger, createFillLedger } = require('./fill-ledger');
const { calculateApyMetrics } = require('./apy-calculator');
const celestialHierarchy = require('./celestial-hierarchy');
const { getRegimeConfig } = require('./config-utils');
const { resolveFundDataDir } = require('./migration');
const { createContextLogger } = require('./logger');

const statusLogger = (exchange, pair) => createContextLogger({ module: 'regime-status', exchange, pair });

/**
 * Best-effort last traded price read from an already-loaded fill ledger's
 * parsed fills (no disk I/O of its own — the ledger instance already did
 * that). Used as a stale-but-reasonable market.lastPrice fallback when no
 * live market snapshot is available, e.g. a hard dashboard refresh with no
 * prior socket snapshot to merge with.
 * @param {{getAllFills?: () => Array<{price?: number, timestamp?: number}>}} ledger
 * @returns {number}
 */
const lastPriceFromLedger = (ledger) => {
  const fills = ledger?.getAllFills ? ledger.getAllFills() : [];
  let latest = null;
  for (const fill of fills) {
    if (!latest || (fill.timestamp || 0) > (latest.timestamp || 0)) latest = fill;
  }
  return Number(latest?.price) || 0;
};

/**
 * Build the canonical "regime engine not running" status payload for a fund.
 *
 * Re-derives `realizedPnL` / `realizedAssetPnL` / `heldAssetCostBasis` from
 * the fill ledger's cycle-pair source of truth — the persisted
 * regime-state.json can be stale (engine stopped before a bugfix landed, or
 * an operator-edited ledger) — and assembles the same payload shape a
 * running engine's `getStatus()` returns, so downstream consumers (IPC
 * callers, HTTP routes, the Socket.IO stream, and the dashboard hooks that
 * read all three) never need to branch on running vs. stopped.
 *
 * @param {string} exchange
 * @param {string} pair
 * @param {Object} [options]
 * @param {{lastPrice?: number}|null} [options.market] - Live market snapshot to embed; when omitted, `market.lastPrice` falls back to the most recent fill price and `market.stale` is set
 * @param {Object|null} [options.regime] - Live regime-detector snapshot to embed (e.g. from a still-running market-data service); when omitted, falls back to the persisted regime state
 * @param {Function} [options.getOrderStatus] - Live order-status lookup passed through to `buildPersistedPendingOrders` so persisted TPs already known filled/cancelled are dropped rather than shown as phantom rows
 * @param {'STOPPED'|'ENGINE_DOWN'} [options.mode='STOPPED'] - `health.mode`: a clean operator/engine stop vs. an unreachable engine process
 * @param {boolean} [options.cachedLedger=true] - Use the read-only cached ledger (issue #183 — cheap for the HTTP/socket poll paths that call this repeatedly) instead of constructing a fresh instance. Ignored when `options.fillLedger` is provided.
 * @param {boolean} [options.requireExistingState=false] - Return `null` instead of a synthesized default when no regime-state.json exists yet, or it fails to load — lets a genuine IPC outage on a first-time fund surface as an error rather than a fake "stopped" status
 * @param {Object} [options.config] - Pre-loaded regime config (skips `getRegimeConfig`) — mainly for tests
 * @param {Object} [options.regimeState] - Pre-loaded `{position, regime, isDryRun}` state (skips `loadRegimeState`) — mainly for tests
 * @param {Object} [options.fillLedger] - Pre-loaded fill ledger instance (skips `getCachedFillLedger`/`createFillLedger`) — mainly for tests
 * @returns {Object|null} Status payload shape-compatible with a running engine's `getStatus()`, or `null` when `requireExistingState` is set and there's nothing on disk to report
 */
const buildStoppedRegimeStatus = (exchange, pair, options = {}) => {
  const {
    market = null,
    regime = null,
    getOrderStatus,
    mode = 'STOPPED',
    cachedLedger = true,
    requireExistingState = false,
  } = options;

  const logger = statusLogger(exchange, pair);

  // loadRegimeState synthesizes an initial empty state when no file exists,
  // so a caller that must distinguish "no fund data yet" from "cleanly
  // stopped with real data" (the HTTP offline fallback — it wants a true IPC
  // outage on a first-time fund to surface as a 503, not a fake stopped
  // status) needs the existence check up front. Skipped when the caller
  // already supplies regimeState directly (tests, mainly).
  if (requireExistingState && !options.regimeState) {
    const fs = require('fs');
    const path = require('path');
    const stateFile = path.join(resolveFundDataDir(exchange, pair), 'regime-state.json');
    if (!fs.existsSync(stateFile)) return null;
  }

  let savedState;
  try {
    savedState = options.regimeState || loadRegimeState(exchange, pair);
  } catch (err) {
    if (requireExistingState) return null;
    throw err;
  }

  const position = savedState?.position || null;
  const config = options.config || getRegimeConfig(exchange, pair);

  // Re-derive over the ledger so realizedPnL / realizedAssetPnL /
  // heldAssetCostBasis reflect current state — persisted values can be
  // stale (engine stopped before a bugfix landed, or operator-edited ledger).
  let ledger = null;
  if (position) {
    try {
      const productId = config.productId || pair;
      ledger = options.fillLedger || (cachedLedger
        ? getCachedFillLedger(exchange, productId, pair)
        : createFillLedger(exchange, productId, pair));
      const derived = ledger.getDerivedRealizedPnL();
      position.realizedPnL = derived.realizedPnL;
      position.realizedAssetPnL = derived.realizedAssetPnL;
      position.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
    } catch (e) {
      logger.warn(`⚠️ [${exchange}/${pair}] offline cycle-pair derivation failed: ${e.message}`, {
        action: 'offline-derive',
        error: e.message,
      });
    }
  }

  const lastPrice = market?.lastPrice || (ledger ? lastPriceFromLedger(ledger) : 0);
  const apy = position ? calculateApyMetrics(position, config, { lastPrice }) : {};
  const pendingOrders = celestialHierarchy.buildPersistedPendingOrders(position, getOrderStatus);
  const celestial = celestialHierarchy.buildCelestialPayload(position, config);

  const status = {
    isRunning: false,
    health: { mode },
    position,
    market: market || (lastPrice ? { lastPrice, stale: true } : null),
    regime: regime || savedState?.regime || null,
    pendingOrders,
    apy,
    lifecycle: {
      lifecycle: position?.lifecycle || LIFECYCLE.ACTIVE,
      lifecycleChangedAt: position?.lifecycleChangedAt || null,
      lifecycleReason: position?.lifecycleReason || null,
      lifecycleClosedCycle: position?.lifecycleClosedCycle || null,
    },
    celestial,
    // Unresolved placement intents must be visible precisely when the engine is
    // NOT running — a crash inside the dispatch window is the case that leaves
    // one behind (#472).
    placementIntents: describePlacementIntents(exchange, pair),
    isDryRun: savedState?.isDryRun || false,
  };

  // The dashboard's "Engine Unreachable" vs "Engine Stopped" banner reads
  // status.engineDown (not just health.mode) — only set it for the genuine
  // IPC-outage case so a clean stop doesn't alarm the operator.
  if (mode === 'ENGINE_DOWN') status.engineDown = true;

  return status;
};

module.exports = { buildStoppedRegimeStatus };
