// @ts-check
/**
 * Fill Ledger
 *
 * Idempotent fill tracking with proper cost basis calculation.
 * Uses trade_id as primary key to prevent duplicate processing.
 * Maintains fill history and rebuilds position state from fills.
 */

const fs = require('fs');
const { randomUUID } = require('crypto');
const { createTransactionsReadView } = require('./transactions-regime-query');
const path = require('path');
const { resolveFundDataDir } = require('./migration');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { atomicWriteSync } = require('./state-tracker');
const { applyPersistedBuyCorrection } = require('./buy-fill-correction');
const { applyPersistedSellCorrection } = require('./sell-fill-correction');
const { getBaseCurrency } = require('./config-utils');
const { fmtCurrency } = require('./shared-utils');
const { isFiniteNumber } = require('./value-guards');
const { createContextLogger } = require('./logger');
// Canonical cycle pairing shared with the admin Filled Orders view (issue #697).
const { isBodyOwnedFill } = require('../shared/cycle-pairing.mjs');
// Realized P&L derivation (issue #1613).
const realized = require('./fill-ledger-realized');
const { createCycleApplication } = require('./fill-ledger-cycle-application');
const { createBookingStore } = require('./fill-ledger-booking');
// Synthetic coverage reconciliation (issue #1613).
const {
  isUnresolvedSyntheticCoverage,
  getBookableReconciliationFills,
  createSyntheticCoverage,
} = require('./fill-ledger-synthetic-coverage');
// The public legacy consumption key remains exported by this module.
// Recalculation planning/application and booking live in their own modules.
const { LEGACY_CONSUMPTION_KEY } = require('./fill-ledger-recalc');

/**
 * @typedef {import('./types').Fill} Fill
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * On-disk format revision of fill-ledger.json. Every persisted row carries it
 * as `formatVersion`; the file stays a bare array so backup, migration and DCA
 * conversion tooling keep working. A build refuses a ledger containing a row
 * stamped newer than it understands (issue #1397): running an older build over
 * newer trading data is unsupported, because fields it does not maintain
 * (e.g. `consumedBy`, `bodyBookedSize`) would go stale and be misread on the
 * next upgrade. Rows with no stamp predate versioning (revision 0).
 * Bump this whenever a field's meaning changes in a way an older build would
 * mishandle.
 */
const LEDGER_FORMAT_VERSION = 1;

/**
 * @param {Array<Object>} data - ledger rows
 * @returns {number} highest formatVersion found (0 when none stamped)
 */
const maxLedgerFormatVersion = (data) => data.reduce((max, fill) => {
  const v = Number(fill?.formatVersion);
  return Number.isFinite(v) && v > max ? v : max;
}, 0);

/**
 * Get fill ledger file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory. The persist()
 * function below mkdirs before writing.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to fill ledger file
 */
const getFillLedgerPath = (exchange, pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'fill-ledger.json');
};

/** Typed error: an incoming fill failed boundary validation and was NOT ingested. */
class FillValidationError extends Error {
  constructor(reason, fillData) {
    super(`Invalid fill rejected: ${reason}`);
    this.name = 'FillValidationError';
    this.reason = reason;
    this.tradeId = fillData?.tradeId ?? fillData?.trade_id;
    this.orderId = fillData?.orderId ?? fillData?.order_id;
  }
}

// Strict numeric parse: rejects numeric-prefix strings ('12abc'), blanks, NaN,
// and non-number/string types. Returns NaN when invalid.
const strictNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

/**
 * Validate and normalize a raw incoming fill into the fields ingestFill
 * persists. Mirrors findInvalidLedgerReason so a successful ingest can never
 * publish a row the next cold start rejects. Preserves legacy defaults
 * (missing tradeTime → now, missing fees → 0) and signed net fees/rebates.
 */
const normalizeFillInput = (fillData) => {
  const fail = (reason) => { throw new FillValidationError(reason, fillData); };
  if (!fillData || typeof fillData !== 'object') fail('fill is not an object');
  const tradeId = fillData.tradeId || fillData.trade_id;
  if (typeof tradeId !== 'string' || !tradeId) fail('missing or non-string tradeId');
  const side = typeof fillData.side === 'string' ? fillData.side.toLowerCase() : '';
  if (side !== 'buy' && side !== 'sell') fail("side must be 'buy' or 'sell'");
  const price = strictNumber(fillData.price);
  if (!Number.isFinite(price) || price <= 0) fail('price must be a finite positive number');
  const size = strictNumber(fillData.size);
  if (!Number.isFinite(size) || size <= 0) fail('size must be a finite positive number');
  if (!Number.isFinite(price * size)) fail('quoteAmount must be finite');
  const optionalNumber = (value, label) => {
    const n = value ? strictNumber(value) : 0;
    if (!Number.isFinite(n)) fail(`${label} must be a finite number`);
    return n;
  };
  const fee = optionalNumber(fillData.totalCommission || fillData.commission || fillData.fee || fillData.totalFees, 'fee');
  const rebate = optionalNumber(fillData.rebate, 'rebate');
  let netFee = fee - rebate;
  if (fillData.netFee !== undefined && fillData.netFee !== null) {
    netFee = strictNumber(fillData.netFee);
    if (!Number.isFinite(netFee)) fail('netFee must be a finite number');
  }
  const orderId = fillData.orderId || fillData.order_id;
  if (orderId != null && typeof orderId !== 'string') fail('orderId must be a string when present');
  let fillTimestamp = Date.now();
  if (fillData.tradeTime) {
    fillTimestamp = new Date(fillData.tradeTime).getTime();
    if (!Number.isFinite(fillTimestamp)) fail('tradeTime is not a valid timestamp');
  }
  return { tradeId, fillTimestamp, orderId, price, size, fee, rebate, netFee };
};

/**
 * Validate a parsed-from-JSON ledger payload against the same shape rules
 * load() applies before resetCaches. Returns null when the payload is
 * acceptable, or a human-readable reason string for the first invalid
 * entry. Shared between load()'s pre-pass and persist({force:true})'s
 * "preserve operator edits" short-circuit so they agree on what counts
 * as repairable vs preservable.
 *
 * Fields required by aggregateFills/rebuildPositionFromFills are
 * validated as REQUIRED (not "when present"): a row missing side, size,
 * price, quoteAmount, netFee/fee, or timestamp would otherwise produce
 * NaN totals downstream and silently corrupt position / P&L state.
 * tradeIds are also checked for uniqueness because load() stores
 * entries in a Map keyed by tradeId and a duplicate would silently
 * overwrite the earlier row.
 *
 * @param {unknown} data - JSON-parsed file content
 * @returns {string | null} reason if invalid, else null
 */
const findInvalidLedgerReason = (data) => {
  if (!Array.isArray(data)) return 'top-level value is not an array';
  const seenTradeIds = new Set();
  for (const fill of data) {
    if (!fill || typeof fill !== 'object') return 'non-object entry';
    if (typeof fill.tradeId !== 'string' || !fill.tradeId) return 'missing or non-string tradeId';
    if (seenTradeIds.has(fill.tradeId)) return `duplicate tradeId '${fill.tradeId}'`;
    if (fill.side !== 'buy' && fill.side !== 'sell') return "side must be 'buy' or 'sell'";
    if (!isFiniteNumber(fill.size)) return 'size must be a finite number';
    // rebuildPositionFromFills restores lastEntryPrice / anchorPrice
    // directly from fill.price; a NaN/null price would poison entry
    // tracking and slip through aggregateFills (which uses quoteAmount,
    // not price, so an inconsistent pair would also escape there).
    if (!isFiniteNumber(fill.price)) return 'price must be a finite number';
    if (!isFiniteNumber(fill.quoteAmount)) return 'quoteAmount must be a finite number';
    // Legacy ledgers (pre-rebate-split) wrote `fee` only without
    // `netFee`. Downstream regime-engine.js:1259-1260 already reads
    // via `fill.netFee || fill.fee`, so accept either; load()
    // backfills `netFee` from `fee` for the in-memory copy so the
    // many other call sites that read `fill.netFee` directly never
    // see undefined.
    if (!isFiniteNumber(fill.netFee) && !isFiniteNumber(fill.fee)) return 'netFee or fee must be a finite number';
    if (!isFiniteNumber(fill.timestamp)) return 'timestamp must be a finite number';
    // orderId is optional (legacy/manual entries may omit it; downstream
    // truthiness-guards every read), but MUST be a string when present.
    if (fill.orderId != null && typeof fill.orderId !== 'string') return 'orderId must be a string when present';
    if (fill.cycleId != null && typeof fill.cycleId !== 'string') return 'cycleId must be a string when present';
    const reconciledTrades = fill.syntheticCoverage?.reconciledTrades;
    if (reconciledTrades != null && !Array.isArray(reconciledTrades)) {
      return 'syntheticCoverage.reconciledTrades must be an array when present';
    }
    const reconciledTradeIds = new Set();
    let reconciledSize = 0;
    for (const allocation of reconciledTrades || []) {
      if (!allocation || typeof allocation !== 'object'
        || typeof allocation.tradeId !== 'string' || !allocation.tradeId
        || !isFiniteNumber(allocation.size) || allocation.size <= 0
        || !isFiniteNumber(allocation.quoteAmount) || !isFiniteNumber(allocation.fee)
        || !isFiniteNumber(allocation.netFee) || !isFiniteNumber(allocation.rebate)
        || reconciledTradeIds.has(allocation.tradeId)) {
        return 'syntheticCoverage.reconciledTrades contains an invalid allocation';
      }
      reconciledTradeIds.add(allocation.tradeId);
      reconciledSize += allocation.size;
    }
    if (reconciledSize > fill.size + 1e-9) {
      return 'syntheticCoverage.reconciledTrades exceeds covered fill size';
    }
    const originalEconomics = fill.syntheticCoverage?.originalEconomics;
    if (originalEconomics != null && ['quoteAmount', 'fee', 'netFee', 'rebate']
      .some(key => !isFiniteNumber(originalEconomics[key]))) return 'invalid original synthetic economics';
    const corrections = fill.buyEconomicCorrections;
    if (corrections != null && !Array.isArray(corrections)) return 'invalid buy correction journal';
    for (const correction of corrections || []) {
      if (!correction || typeof correction.id !== 'string' || !correction.id
        || correction.orderId !== fill.orderId || !isFiniteNumber(correction.size) || correction.size <= 0
        || !isFiniteNumber(correction.costDelta) || !isFiniteNumber(correction.consumedQty)
        || correction.consumedQty < 0 || correction.consumedQty > correction.size + 1e-8
        || typeof correction.owned !== 'boolean' || !['pending', 'applied'].includes(correction.status)
        || !Array.isArray(correction.sells) || correction.sells.some(sell =>
          !sell || typeof sell.sellOrderId !== 'string' || !sell.sellOrderId
          || !isFiniteNumber(sell.costDelta) || !isFiniteNumber(sell.capitalCreditFraction)
          || sell.capitalCreditFraction < 0 || sell.capitalCreditFraction > 1)) {
        return 'invalid buy correction journal';
      }
    }
    const sellCorrections = fill.sellEconomicCorrections;
    if (sellCorrections != null && !Array.isArray(sellCorrections)) return 'invalid sell correction journal';
    for (const correction of sellCorrections || []) {
      if (!correction || typeof correction.id !== 'string' || !correction.id
        || correction.orderId !== fill.orderId
        || ['quoteDelta', 'netFeeDelta', 'bodyPnlDelta', 'satellitePnlDelta', 'capitalDelta',
          'auditProceedsDelta', 'auditFeesDelta', 'auditPnlDelta'].some(key => !isFiniteNumber(correction[key]))
        || !['pending', 'applied'].includes(correction.status)) {
        return 'invalid sell correction journal';
      }
    }
    seenTradeIds.add(fill.tradeId);
  }
  return null;
};

/**
 * Create fill ledger instance
 * @param {string} exchange - Exchange name
 * @param {string} [productId] - Product ID (e.g. 'BTC-USDC') used to derive base currency for logs
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair (resolved when ledger is created)
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.quiet=false] - Suppress the routine "Loaded N fills" /
 *   "Restored active cycle" info logs. Read-only gateway consumers that
 *   construct a throwaway ledger per HTTP request set this so they don't spam
 *   the gateway log on every dashboard poll; engines/scripts leave it off so
 *   their once-per-process boot diagnostic is still emitted. Corruption
 *   warnings/errors are always logged regardless.
 * @returns {Object} Fill ledger instance
 */
const createFillLedger = (exchange, productId, pair, opts = {}) => {
  const quiet = opts.quiet === true;
  const cycleCompletionRatio = typeof opts.cycleCompleteSellRatio === 'number' ? opts.cycleCompleteSellRatio : undefined;
  const logger = createContextLogger({ exchange, pair: pair || productId });
  /** @type {Map<string, Fill>} */
  const fills = new Map();
  /** @type {Map<string, Set<string>>} cycleId -> Set of tradeIds for O(1) cycle lookups */
  const cycleIndex = new Map();
  /** @type {Map<string, number>} orderId -> total recorded size for O(1) watermark lookups in hot retry loops */
  const orderSizeIndex = new Map();
  /** @type {Map<string, Set<string>>} orderId -> tradeIds for order-scoped lookups */
  const orderIdIndex = new Map();
  // Avoid scanning the whole ledger on ordinary fill ingestion.
  const syntheticOrders = new Set();
  // Identity-only real fills are stored on their synthetic coverage rows.
  // This index keeps their replay check O(1) after a reload.
  const reconciledTradeIds = new Set();
  let buyCorrectionHandler = correction => applyPersistedBuyCorrection(exchange, pair, correction, getDerivedRealizedPnL());
  let sellCorrectionHandler = correction => applyPersistedSellCorrection(exchange, pair, correction, getDerivedRealizedPnL());
  let currentCycleId = null;
  // When the live cycle began (ms), if known: set by startNewCycle() or
  // restored from the persisted positionState.activeCycleStartedAt. Null when
  // the live cycle was inferred (load() heuristic, legacy state) — only then
  // does the fill attribution boundary fall back to the cycle's earliest fill,
  // and an empty cycle has no boundary at all (issue #705).
  let currentCycleStartedAt = null;
  let nextCycleNumber = 1;
  // True when in-memory state has been mutated since the last successful
  // persist. Lets persist() short-circuit when there's nothing new to
  // write, so callers (e.g. unbounded retry loops in market-data-service)
  // can call persist() defensively on every tick without churning the
  // ledger file or blocking the event loop on every backoff. External
  // callers that mutate fill objects directly (via getAllFills /
  // getFillsForOrder) MUST call markDirty() so the next persist actually
  // flushes their changes — and per its contract may only mutate
  // metadata fields that do not feed orderSizeIndex / orderIdIndex / cycleIndex.
  let dirtySinceLastPersist = false;
  // Tracks whether load() has ever completed (file present or absent) so
  // corruption-recovery branches can distinguish a live SIGUSR1 reload
  // (preserve in-memory) from a cold-start boot (throw, force operator
  // intervention). Without this, a cold start with a corrupt file would
  // boot with an empty ledger and the next successful persist would
  // overwrite the recoverable file with only post-start fills, silently
  // discarding history.
  let hasLoadedSuccessfully = false;
  const baseCurrency = getBaseCurrency(productId);
  const fmtPrice = fmtCurrency;

  // Monotonic counter bumped on every mutation to `fills` (or to metadata
  // read by the derived-P&L / fill-time-stats computations below). Used
  // ONLY to invalidate the memoized results in computeRealizedFromCyclePairs
  // and getFillTimeStats — it never feeds a computed value itself, so a
  // missed bump can only cause a stale read, never a wrong formula. Every
  // mutator (resetCaches/load, ingestFill, recalculateCycles,
  // updateFillCycleId, annotateFillsByOrderIds, commitSellBooking,
  // recordBuyConsumption, claimCapitalCredit, and the
  // external markDirty() escape hatch for direct fill-object edits) calls
  // bumpLedgerVersion() alongside its existing dirtySinceLastPersist flag.
  const ledgerInstance = randomUUID();
  let ledgerVersion = 0;
  const transactionsReadView = createTransactionsReadView(
    () => Array.from(fills.values()),
    () => `${ledgerInstance}:${ledgerVersion}`,
  );
  const bumpLedgerVersion = () => {
    ledgerVersion += 1;
  };

  /**
   * Load fill ledger from disk
   */
  const resetCaches = () => {
    // Reset all in-memory state to empty. load() may be called more than
    // once on a live ledger instance (regime-engine SIGUSR1 reload), so
    // every load path must start clean — otherwise stale fills from a
    // prior load (or from before a manual reconciliation removed them
    // from disk) would survive and inflate getRecordedSizeForOrder.
    // currentCycleId/nextCycleNumber are part of that state — without
    // resetting them, a reload to an empty ledger would keep attributing
    // new fills to the prior cycle.
    fills.clear();
    cycleIndex.clear();
    orderSizeIndex.clear();
    orderIdIndex.clear();
    syntheticOrders.clear();
    reconciledTradeIds.clear();
    currentCycleId = null;
    currentCycleStartedAt = null;
    nextCycleNumber = 1;
    // Clear the dirty flag too. After a reload, in-memory matches disk,
    // so a defensive persist() on the next tick must be a no-op rather
    // than rewriting the just-loaded snapshot — preserves the "clean
    // persists are a no-op" contract that avoids file churn on every
    // retry-loop call to persist().
    dirtySinceLastPersist = false;
    // The ledger contents are about to change (cleared, then possibly
    // repopulated by load()) — invalidate the memoized derived-P&L /
    // fill-time-stats caches unconditionally, even though this leaves
    // the ledger empty when there is no file to reload from.
    bumpLedgerVersion();
  };

  // Refuse cold-start corruption before any persist can overwrite history.
  // A live reload keeps its last known-good caches until the operator repairs
  // the file and reloads again. The reason carries the legacy message grammar.
  const refuseLoad = (filePath, isReload, reason, logFields) => {
    if (!isReload) {
      throw new Error(`fill-ledger at ${filePath} ${reason.coldStart}. Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
    }
    logger.error(`❌ [${exchange}] fill-ledger ${reason.reload} — keeping in-memory state (${fills.size} fills); operator must fix and reload`, {
      filePath,
      fillCount: fills.size,
      ...logFields,
    });
  };

  // Legacy negative-holdback repair (issue #779): between #769 and #770
  // (both unreleased — never shipped in v2.25.0 or earlier) the engine
  // could book a stale-TP oversell (a sale beyond what the body/satellite
  // still held) as a NEGATIVE bodyHoldbackAsset/satelliteHoldbackAsset
  // annotation. #770 changed the engine to record this instead as
  // holdback 0 + a non-negative bodyReservesSoldAsset (see
  // docs/pnl-architecture.md "Reserves sold by an oversized stale TP").
  // Rows written in that window still carry the old negative shape, and
  // the pairing (shared/cycle-pairing.mjs) clamps a negative holdback to
  // 0 rather than crediting the sold reserves — silently overstating
  // realizedAssetPnL by the oversold quantity. Rewrite in place, on
  // every load, so every reader (including a read-only diagnostic script
  // or getCachedFillLedger's gateway instance) computes correct P&L
  // immediately. Idempotent: a fill already carrying a positive
  // bodyReservesSoldAsset is left untouched (already repaired, or an
  // inconsistent state not ours to guess at), and a repaired row has a
  // non-negative holdback on the next load, so it is never touched twice.
  // Deliberately NOT auto-persisted here — same reasoning as the netFee
  // backfill just below: `quiet`/no-quiet is a logging hint, not an
  // ownership signal (several read-only scripts, e.g.
  // scripts/analyze-unaccounted.js, construct a non-quiet ledger purely
  // to inspect it), so writing back from inside load() would make ANY
  // caller — not just the owning engine — a second, uncoordinated writer
  // of a live fund's ledger file, racing a running engine's own persists
  // (issue #779). The repair rides along on the
  // owning engine's own next dirtying persist() instead, the same way
  // the netFee backfill's in-memory-only fix eventually reaches disk.
  const repairLegacyFill = (fill) => {
    // Legacy-ledger backfill: pre-rebate-split fills only had `fee`,
    // not `netFee`. The pre-pass validator accepts either; here we
    // synthesize netFee from fee so the many downstream consumers
    // that read fill.netFee directly (aggregateFills,
    // rebuildPositionFromFills, recalculateCycles, etc.) never see
    // undefined. The on-disk file isn't auto-rewritten — the next
    // dirtying mutation will trigger the upgraded shape via persist.
    if (typeof fill.netFee !== 'number' && typeof fill.fee === 'number') {
      fill.netFee = fill.fee;
    }
    if (fill.side === 'sell') {
      // Mirror the same body-first fallback shared/cycle-pairing.mjs
      // uses to read the annotation, so we neutralize exactly the
      // field the pairing would otherwise clamp to 0.
      const annotatedHoldback = fill.bodyHoldbackAsset ?? fill.satelliteHoldbackAsset;
      if (typeof annotatedHoldback === 'number' && annotatedHoldback < 0
        && !(Number(fill.bodyReservesSoldAsset) > 0)) {
        if (fill.bodyHoldbackAsset != null) {
          fill.bodyHoldbackAsset = 0;
        } else {
          fill.satelliteHoldbackAsset = 0;
        }
        fill.bodyReservesSoldAsset = roundAsset(Math.abs(annotatedHoldback));
        return true;
      }
    }
    return false;
  };

  const restoreCycleState = () => {
    // Restore currentCycleId from loaded fills
    // Find the most recent cycle that's still active (sells haven't closed out the position)
    const cycleStats = new Map(); // cycleId -> { buysAsset, sellsAsset }
    for (const fill of fills.values()) {
      if (!fill.cycleId) continue;
      if (!cycleStats.has(fill.cycleId)) {
        cycleStats.set(fill.cycleId, { buysAsset: 0, sellsAsset: 0 });
      }
      const stats = cycleStats.get(fill.cycleId);
      if (fill.side === 'buy') stats.buysAsset += fill.size;
      else if (fill.side === 'sell') stats.sellsAsset += fill.size;
    }

    // Find an active cycle - prefer most recent
    // A cycle is "active" if it has not been fully closed (any unsold portion remains)
    const allFills = Array.from(fills.values()).sort((a, b) => b.timestamp - a.timestamp);
    for (const fill of allFills) {
      if (!fill.cycleId) continue;
      const stats = cycleStats.get(fill.cycleId);
      if (!stats || stats.buysAsset === 0) continue;
      const sellRatio = stats.sellsAsset / stats.buysAsset;
      if (sellRatio < 1.0) {
        currentCycleId = fill.cycleId;
        if (!quiet) {
          logger.info(`📖 [${exchange}] Restored active cycle: ${currentCycleId} (${(sellRatio * 100).toFixed(1)}% sells)`, {
            cycleId: currentCycleId,
            sellRatio,
          });
        }
        break;
      }
    }

    // Initialize nextCycleNumber from existing cycle IDs
    let maxCycleNum = 0;
    for (const fill of fills.values()) {
      if (!fill.cycleId) continue;
      const match = fill.cycleId.match(/^cycle-(\d+)$/);
      if (match) {
        maxCycleNum = Math.max(maxCycleNum, parseInt(match[1], 10));
      }
    }
    nextCycleNumber = maxCycleNum + 1;
  };

  const rebuildLoadedOrderIndexes = () => {
    // Rebuild order indexes from the canonical fills Map AFTER population.
    // load() can be called multiple times on a live ledger (regime-engine.js
    // re-loads on state reload). If we accumulated while populating fills,
    // a second load() would double-count every persisted fill on top of
    // the existing totals — making getRecordedSizeForOrder over-report
    // and the market-data-service watermark believe orders are fully
    // ingested when they're not. Rebuilding from `fills` is idempotent.
    orderSizeIndex.clear();
    orderIdIndex.clear();
    for (const f of fills.values()) {
      if (!orderIdIndex.has(f.orderId)) orderIdIndex.set(f.orderId, new Set());
      orderIdIndex.get(f.orderId).add(f.tradeId);
      if (isUnresolvedSyntheticCoverage(f)) syntheticOrders.add(f.orderId);
      if (f.orderId) {
        const next = (orderSizeIndex.get(f.orderId) || 0) + (f.size || 0);
        orderSizeIndex.set(f.orderId, roundAsset(next));
      }
    }
  };

  const load = () => {
    const filePath = getFillLedgerPath(exchange, pair);
    // Reload-vs-cold-start signal. Either a prior successful load OR any
    // already-ingested fills means there is in-memory state worth
    // preserving. Without this distinction, a cold-start boot against a
    // corrupt file would silently start with an empty ledger and the
    // next persist would overwrite the recoverable file with only
    // post-start fills — destroying the historical record.
    const isReload = hasLoadedSuccessfully || fills.size > 0;
    if (!fs.existsSync(filePath)) {
      // Initial load (no file yet) leaves the freshly-constructed empty
      // caches in place. SIGUSR1 reload (regime-engine.js calls load()
      // on the live ledger) preserves whatever is in memory so a
      // momentarily-missing file (e.g., operator's edit/rename window)
      // doesn't wipe live data. To intentionally clear, write `[]` to
      // the file — that loads cleanly to empty state.
      if (!quiet) {
        logger.info(`📖 [${exchange}] fill-ledger not found at ${filePath} — preserving in-memory state (${fills.size} fills)`, {
          filePath,
          fillCount: fills.size,
        });
      }
      hasLoadedSuccessfully = true;
      return;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return refuseLoad(filePath, isReload, {
        coldStart: `is corrupted or unreadable on cold start: ${err.message}`,
        reload: `corrupted or unreadable at ${filePath}: ${err.message}`,
      }, { error: err.message });
    }
    // Validate shape BEFORE resetCaches. Valid JSON like `{}` or `null`
    // would parse without throwing but the for-of below would crash —
    // resetCaches() would have already wiped the live ledger by then,
    // so the reload-on-malformed-payload would fall into the same data-
    // loss mode that the catch-block above guards against.
    if (!Array.isArray(data)) {
      const actualType = data === null ? 'null' : typeof data;
      return refuseLoad(filePath, isReload, {
        coldStart: `is not an array on cold start (got ${actualType})`,
        reload: `at ${filePath} is not an array (got ${actualType})`,
      }, { actualType });
    }
    // Refuse newer-format data before anything else: an older build must not
    // interpret (or later rewrite) a ledger it cannot fully understand.
    const newerFormat = maxLedgerFormatVersion(data);
    if (newerFormat > LEDGER_FORMAT_VERSION) {
      return refuseLoad(filePath, isReload, {
        coldStart: `was written by a newer build (format v${newerFormat}; this build supports up to v${LEDGER_FORMAT_VERSION}). Running an older build over newer trading data is not supported — upgrade to the build that wrote it, or restore a backup taken before the upgrade (see UPGRADE.md)`,
        reload: `at ${filePath} was written by a newer build (format v${newerFormat}; this build supports up to v${LEDGER_FORMAT_VERSION}) — refusing to load; see UPGRADE.md`,
      }, { newerFormat, supported: LEDGER_FORMAT_VERSION });
    }
    // Element-level validation: even an array can contain malformed
    // entries like `[null]` or `[{}]` that would crash on `fill.tradeId`
    // mid-loop, leaving the live ledger half-populated after the
    // already-run resetCaches. Pre-pass guarantees a clean reload-or-bail.
    //
    // Field-type validation is required, not just presence: cycle restore
    // calls `fill.cycleId.match(/^cycle-(\d+)$/)` which throws on
    // non-string cycleId (e.g. an object). A presence-only pre-pass would
    // accept `{tradeId:"t1", cycleId:{}}` and we'd crash mid-load AFTER
    // resetCaches has wiped the live ledger — re-introducing the data-loss
    // mode the pre-validation is meant to prevent.
    const invalidReason = findInvalidLedgerReason(data);
    if (invalidReason) {
      return refuseLoad(filePath, isReload, {
        coldStart: `contains an invalid entry (${invalidReason}) on cold start`,
        reload: `at ${filePath} contains an invalid entry (${invalidReason})`,
      }, { invalidReason });
    }
    // Clean slate before re-reading. The successful-read path mirrors
    // disk authoritatively (handles "operator removed fills via manual
    // reconciliation, then reloaded" — those removals must take effect).
    resetCaches();
    let negativeHoldbackRepairCount = 0;
    for (const fill of data) {
      if (repairLegacyFill(fill)) negativeHoldbackRepairCount++;
      // The stamp is a persistence concern: persist() re-adds it, so in-memory
      // rows keep the exact shape they had before versioning.
      delete fill.formatVersion;
      fills.set(fill.tradeId, fill);
      for (const allocation of fill.syntheticCoverage?.reconciledTrades || []) {
        reconciledTradeIds.add(allocation.tradeId);
      }
      // Populate cycle index
      if (fill.cycleId && fill.size > 1e-9) {
        if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
        cycleIndex.get(fill.cycleId).add(fill.tradeId);
      }
    }
    if (negativeHoldbackRepairCount > 0 && !quiet) {
      logger.warn(`🩹 [${exchange}] Repaired ${negativeHoldbackRepairCount} legacy negative-holdback fill(s) into bodyReservesSoldAsset in memory (issue #779) — not written to disk by this load; reaches disk whenever this ledger instance is next persisted`, {
        repairedCount: negativeHoldbackRepairCount,
      });
    }
    rebuildLoadedOrderIndexes();

    restoreCycleState();

    hasLoadedSuccessfully = true;
    if (!quiet) {
      logger.info(`📖 [${exchange}] Loaded ${fills.size} fills from ledger`, {
        fillCount: fills.size,
      });
    }
  };

  // Counter for tests: increments only when persist() actually writes to
  // disk (after the dirty-flag short-circuit). Tests assert the no-op
  // contract of persist() against this counter rather than filesystem
  // mtime, since mtime granularity varies across CI filesystems and
  // produces flaky assertions.
  let writeCount = 0;

  /**
   * Persist fill ledger to disk. No-op when nothing has changed since the
   * last successful persist — callers can invoke this defensively on
   * every retry tick without churning the ledger file.
   */
  const persist = (options = {}) => {
    const { force = false } = options;
    const filePath = getFillLedgerPath(exchange, pair);
    if (!dirtySinceLastPersist) {
      // Clean shutdowns must still write when the on-disk file has gone
      // missing (operator rm, transient unmount, etc.) — otherwise
      // regime-engine.stop()'s defensive persist() would no-op, the
      // process exits, and the next boot's load() sees no file and
      // treats it as a fresh deployment with empty history. Subsequent
      // persists would then write a file containing only post-restart
      // fills, silently destroying the recoverable in-memory ledger
      // that the dirty-flag short-circuit refused to flush.
      if (!fs.existsSync(filePath)) {
        // fall through to write
      } else if (!force) {
        return;
      } else {
        // `force: true` — used by shutdown paths to flush a healthy
        // in-memory snapshot when the on-disk file became unreadable /
        // truncated externally during the run. Honor force ONLY when
        // the on-disk content would survive load()'s pre-pass: if the
        // file is a valid array of well-shaped fill rows, the operator
        // may have made manual reconciliation edits that we should not
        // clobber with our (potentially-staler) in-memory state.
        // findInvalidLedgerReason runs the same per-row checks load()
        // does, so partial corruption modes (`[validFill, null]`,
        // duplicates, missing required fields on a later row) are
        // detected and rewritten — not silently preserved as the next
        // boot's load() would reject them, defeating the repair-on-stop
        // path. Operators can still SIGUSR1-reload before stop if they
        // want on-disk edits applied to the engine before shutdown.
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (findInvalidLedgerReason(parsed) === null) return;
        } catch (_) {
          // unparseable — fall through and rewrite from in-memory
        }
      }
    }

    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fillsArray = Array.from(fills.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(fill => (fill.formatVersion >= LEDGER_FORMAT_VERSION ? fill : { ...fill, formatVersion: LEDGER_FORMAT_VERSION }));

    atomicWriteSync(filePath, JSON.stringify(fillsArray, null, 2));
    dirtySinceLastPersist = false;
    writeCount += 1;
  };

  // Synthetic coverage reconciliation (issue #1613): planners and mutators
  // bound to this ledger's maps; dirty flag, persistence and version stay here.
  const coverage = createSyntheticCoverage({
    fills, cycleIndex, orderSizeIndex, orderIdIndex, syntheticOrders, reconciledTradeIds,
  });

  /**
   * Ingest a fill (idempotent)
   * @param {Object} fillData - Raw fill data from exchange
   * @param {number} [orderPlacedAt] - Optional timestamp when the order was placed (for fill time tracking)
   * @param {Object} [options]
   * @param {boolean} [options.skipPersist] - Batch ordinary fills until the caller flushes.
   *   Synthetic coverage reconciliations always persist atomically before returning.
   * @param {string|null} [options.cycleId] - Explicit cycle assignment. Defaults to the live
   *   currentCycleId. Pass `null` for fills that may be historical (sync/manual reconciliation):
   *   stamping a days-old fill with the live cycleId inflates current-cycle totals and can trip
   *   recalculateCycles' sell-ratio heuristic into marking the active cycle complete. A null-cycle
   *   fill is picked up by recalculateCycles' orphan logic and placed in its correct cycle by
   *   buy/sell pattern (issue #108). Note: pass the property explicitly — an absent `cycleId` key
   *   keeps the live-cycle default; only an explicit `null`/value overrides it.
   * @returns {{ingested: boolean, fill: Fill|null, identityReplacement?: boolean, newQuantity?: number, bookableFills?: Fill[]}} Result.
   *   For a synthetic-coverage reconciliation, `fill` records only excess
   *   quantity (zero for an identity-only execution); `bookableFills` also
   *   includes covered rows that still need booking based on their saved state.
   */
  const ingestFill = (fillData, orderPlacedAt = null, options = {}) => {
    resumeBuyCorrections();
    resumeSellCorrections();
    // Normalize + validate BEFORE dedup or any mutation so a malformed upstream
    // record can never reserve an ID, advance an index, or reach disk (a record
    // the cold-start validator would reject). Throws FillValidationError.
    const { tradeId, fillTimestamp, orderId, price, size, fee, rebate, netFee } = normalizeFillInput(fillData);

    // Idempotency check
    if (fills.has(tradeId) || reconciledTradeIds.has(tradeId)) {
      return { ingested: false, fill: null };
    }

    // Calculate fill time if we have order placement time
    const fillTimeMs = orderPlacedAt && orderPlacedAt > 0 ? fillTimestamp - orderPlacedAt : null;

    // Cycle assignment: default to the live cycle, but let callers ingesting
    // potentially-historical fills (sync-fills, manual-trade reconciliation)
    // pass an explicit cycleId (typically null) so old fills don't land in the
    // current cycle. Only override when the key is actually present — an absent
    // key must keep the live-cycle default (issue #108).
    const cycleId = 'cycleId' in options ? options.cycleId : currentCycleId;

    const reported = {
      tradeId,
      orderId,
      side: fillData.side.toLowerCase(),
      price,
      size,
      quoteAmount: price * size,
      // Accept an explicit fee/totalFees too — synthetic fills built from order
      // status (Coinbase eventual-consistency fallback) carry the known fee as
      // totalFees/fee but no totalCommission, and were previously persisted with
      // fee:0, permanently overstating that order's P&L (issue #210-C).
      fee,
      feeAsset: fillData.commissionAsset || fillData.fee_asset || 'USDC',
      rebate,
      // Honor an explicitly-provided netFee (e.g. synthetic fills); otherwise
      // derived from the gross fee minus rebate (see normalizeFillInput).
      netFee,
      liquidityIndicator: fillData.liquidityIndicator || fillData.liquidity_indicator || 'TAKER',
      timestamp: fillTimestamp,
      ingestedAt: Date.now(),
      cycleId,
      ...(fillData.syntheticCoverage ? { syntheticCoverage: { ...fillData.syntheticCoverage } } : {}),
      // Fill time tracking
      orderPlacedAt: orderPlacedAt || null,
      fillTimeMs: fillTimeMs,
    };

    const reconciliation = coverage.reconcile(reported);
    const row = reconciliation ? reconciliation.ledgerExecution : reported;
    const replacements = reconciliation?.replacements || [];
    const rollback = coverage.captureIngestRollback(row, tradeId, reconciliation);
    const dirtyBeforeIngest = dirtySinceLastPersist;
    if (reconciliation?.mode === 'preserve') {
      coverage.recordPreservedCoverage(row, reconciliation, tradeId);
    }
    coverage.applyCoverageReplacements(replacements);
    // Identity-only executions are represented by their real ID in the
    // synthetic rows' reconciliation metadata. Avoid persisting a zero-size
    // row that could enter cycle reconstruction or ordinary fill aggregates.
    if (row.size > 1e-9) fills.set(tradeId, row);
    coverage.refreshSyntheticOrder(row, reconciliation);
    coverage.indexIngestedFill(row, tradeId, replacements);
    if (row.buyEconomicCorrection) {
      coverage.journalBuyEconomicCorrection(row, reconciliation);
    }
    if (row.sellEconomicCorrection) {
      coverage.journalSellEconomicCorrection(row, reconciliation);
    }
    dirtySinceLastPersist = true;
    bumpLedgerVersion();
    // Replacement changes which trade IDs own already-booked execution. A
    // later row in a batch can reject before the caller's final persist, so
    // this transition must publish now even when ordinary rows are batched.
    // The rollback snapshot keeps memory/indexes retryable if publication fails.
    if (!options.skipPersist || reconciliation) {
      try {
        persist();
      } catch (err) {
        // Atomic file publication kept the old disk state. Keep the matching
        // memory/index state too, so retry cannot mistake a failed replacement
        // for a durable duplicate.
        if (rollback) {
          coverage.restoreIngestRollback(rollback, row, tradeId);
          dirtySinceLastPersist = dirtyBeforeIngest;
          bumpLedgerVersion();
        }
        throw err;
      }
    }

    resumeBuyCorrections();
    resumeSellCorrections();

    const fillTimeStr = fillTimeMs !== null ? ` (fill time: ${(fillTimeMs / 1000).toFixed(1)}s)` : '';
    logger.info(`📝 [${exchange}] Fill ingested: tradeId=${tradeId} orderId=${row.orderId} ${row.side} ${row.size} ${baseCurrency} @ ${fmtPrice(row.price)} (fee: $${row.netFee.toFixed(4)})${fillTimeStr}`, {
      tradeId,
      orderId: row.orderId,
      side: row.side,
      size: row.size,
      price: row.price,
      netFee: row.netFee,
      fillTimeMs,
    });

    const bookableFills = getBookableReconciliationFills(row, reconciliation);
    const newQuantity = reconciliation
      ? (reconciliation.mode === 'preserve' ? reconciliation.newSize : 0)
      : row.size;
    return {
      ingested: true,
      fill: row,
      identityReplacement: newQuantity <= 1e-9 && Boolean(reconciliation),
      newQuantity,
      bookableFills,
    };
  };

  /** Resume each published correction before processing another execution.
   * Errors propagate: a pending correction must never be returned as a
   * successful duplicate/import. The journal remains durable until every
   * target has acknowledged its own idempotency marker.
   */
  const resumeBuyCorrections = () => {
    for (const row of fills.values()) {
      for (const correction of row.buyEconomicCorrections || []) {
        if (correction.status !== 'pending') continue;
        if (correction.owned || correction.sells.length) buyCorrectionHandler(correction);
        correction.status = 'applied';
        dirtySinceLastPersist = true;
        bumpLedgerVersion();
        try { persist(); } catch (err) { correction.status = 'pending'; throw err; }
      }
    }
  };

  /** Resume each published sell correction after its ledger journal is durable. */
  const resumeSellCorrections = () => {
    for (const row of fills.values()) {
      for (const correction of row.sellEconomicCorrections || []) {
        if (correction.status !== 'pending') continue;
        sellCorrectionHandler(correction);
        correction.status = 'applied';
        dirtySinceLastPersist = true;
        bumpLedgerVersion();
        try { persist(); } catch (err) { correction.status = 'pending'; throw err; }
      }
    }
  };

  /**
   * Get all fills for an order
   * @param {string} orderId - Order ID
   * @returns {Fill[]} Fills for the order
   */
  const getFillsForOrder = (orderId) => {
    return Array.from(orderIdIndex.get(orderId) || [], tradeId => fills.get(tradeId))
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Get fills for current cycle
   * @returns {Fill[]} Fills in current cycle
   */
  const getCurrentCycleFills = () => {
    if (!currentCycleId) return [];
    const tradeIds = cycleIndex.get(currentCycleId);
    if (!tradeIds || tradeIds.size === 0) return [];
    const result = [];
    for (const id of tradeIds) {
      const fill = fills.get(id);
      if (fill) result.push(fill);
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Rebuild position state from fills
   * @param {Fill[]} [fillsToProcess] - Specific fills to process (defaults to current cycle)
   * @returns {RegimePositionState} Rebuilt position state
   */
  const rebuildPositionFromFills = (fillsToProcess) => {
    const chronoFills = fillsToProcess || getCurrentCycleFills();

    // Reorder linked buy-sell pairs so buys process before their sells,
    // even when a corrective buy has a later timestamp than its sell.
    const buysBySellOrderId = new Map();
    for (const f of chronoFills) {
      if (f.side === 'buy' && f.sellOrderId) {
        if (!buysBySellOrderId.has(f.sellOrderId)) buysBySellOrderId.set(f.sellOrderId, []);
        buysBySellOrderId.get(f.sellOrderId).push(f);
      }
    }
    let targetFills = chronoFills;
    if (buysBySellOrderId.size > 0) {
      const result = [];
      const emitted = new Set();
      for (const fill of chronoFills) {
        if (emitted.has(fill.tradeId)) continue;
        if (fill.side === 'sell') {
          const linkedBuys = buysBySellOrderId.get(fill.orderId);
          if (linkedBuys) {
            for (const buy of linkedBuys) {
              if (!emitted.has(buy.tradeId)) {
                result.push(buy);
                emitted.add(buy.tradeId);
              }
            }
          }
        }
        result.push(fill);
        emitted.add(fill.tradeId);
      }
      targetFills = result;
    }

    let totalAsset = 0;
    let totalCostBasis = 0;
    let realizedPnL = 0;
    let lastEntryPrice = 0;
    let lastEntryTime = 0;
    const uniqueBuyOrders = new Set();

    for (const fill of targetFills) {
      // Skip body-owned fills — they have independent position tracking
      if (isBodyOwnedFill(fill)) continue;

      // A buy recalculateCycles folded into this cycle by timestamp alone
      // (#705) counts toward the cycle's buy limit, but nothing links it to
      // an engine order (sync-fills re-imports manual trades too), so it must
      // not enter the position the core TP is sized from — that would place
      // an automatic sell for it (R2 in docs/pnl-architecture.md).
      if (fill.cycleAttribution === 'timeframe') {
        if (fill.side === 'buy') uniqueBuyOrders.add(fill.orderId);
        continue;
      }

      if (fill.side === 'buy') {
        const costBasis = fill.quoteAmount + fill.netFee;
        totalAsset = roundAsset(totalAsset + fill.size);
        totalCostBasis = roundUSDC(totalCostBasis + costBasis);
        uniqueBuyOrders.add(fill.orderId);
        lastEntryPrice = fill.price;
        lastEntryTime = fill.timestamp;
      } else if (fill.side === 'sell') {
        const proceeds = fill.quoteAmount - fill.netFee;
        const avgCost = totalAsset > 0 ? totalCostBasis / totalAsset : 0;
        const soldCostBasis = fill.size * avgCost;
        realizedPnL = roundUSDC(realizedPnL + (proceeds - soldCostBasis));

        totalAsset = roundAsset(totalAsset - fill.size);
        if (totalAsset < 0) {
          logger.warn(`⚠️ [${exchange}] rebuildPositionFromFills: negative ${baseCurrency} ${totalAsset} after sell ${fill.tradeId}, clamping to 0`, {
            tradeId: fill.tradeId,
            baseCurrency,
            totalAsset,
          });
          totalAsset = 0;
          totalCostBasis = 0;
        } else {
          totalCostBasis = roundUSDC(totalCostBasis - soldCostBasis);
        }
      }
    }

    const avgCostBasis = totalAsset > 0 ? totalCostBasis / totalAsset : 0;

    return {
      totalAsset,
      totalCostBasis,
      avgCostBasis,
      cycleBuys: uniqueBuyOrders.size,
      lastEntryPrice,
      lastEntryTime,
      anchorPrice: lastEntryPrice,
      activeTpOrderId: null,
      lastTpPrice: 0,
      cyclesCompleted: 0,
      unrealizedPnL: 0,
      realizedPnL,
      maxDrawdownSeen: 0,
      scalingDisabled: false,
      scalingDisabledReason: null,
    };
  };

  /**
   * Start a new trading cycle
   * @param {number} [startedAt=Date.now()] - When the cycle began (ms). Callers
   *   persist it (positionState.activeCycleStartedAt) so a restart can restore
   *   the boundary even while the cycle has no fills yet (issue #705).
   * @returns {string} New cycle ID
   */
  const startNewCycle = (startedAt = Date.now()) => {
    currentCycleId = `cycle-${nextCycleNumber}`;
    currentCycleStartedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
    nextCycleNumber++;
    logger.info(`🔄 [${exchange}] Started new cycle: ${currentCycleId}`, {
      cycleId: currentCycleId,
    });
    return currentCycleId;
  };

  /**
   * Get current cycle ID
   * @returns {string|null}
   */
  const getCurrentCycleId = () => currentCycleId;

  /**
   * When the live cycle began, or null when unknown (issue #705).
   * @returns {number|null}
   */
  const getCurrentCycleStartedAt = () => currentCycleStartedAt;

  /**
   * Set current cycle ID (for recovery)
   * @param {string|null} cycleId
   * @param {number|null} [startedAt=null] - Persisted start time of that cycle
   *   (positionState.activeCycleStartedAt); anything else clears it to unknown.
   */
  const setCurrentCycleId = (cycleId, startedAt = null) => {
    currentCycleId = cycleId;
    currentCycleStartedAt = cycleId && typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
      ? startedAt
      : null;
    // A persisted reset can name a cycle with no fills yet, so load() cannot
    // infer its number from the ledger. Reserve it when restoring the boundary
    // or the next reset will reuse this ID and retain its buy count.
    const match = typeof cycleId === 'string' && cycleId.match(/^cycle-(\d+)$/);
    if (match) nextCycleNumber = Math.max(nextCycleNumber, Number(match[1]) + 1);
  };

  /**
   * Check if a trade has been processed
   * @param {string} tradeId - Trade ID to check
   * @returns {boolean}
   */
  const hasProcessedTrade = (tradeId) => fills.has(tradeId) || reconciledTradeIds.has(tradeId);

  /**
   * Get fill count
   * @returns {number}
   */
  const getFillCount = () => fills.size;

  /**
   * Get all fills
   * @returns {Fill[]}
   */
  const getAllFills = () => Array.from(fills.values());

  /**
   * Get fill statistics
   * @returns {Object} Stats summary
   */
  const getStats = () => {
    const allFills = Array.from(fills.values());
    const buyFills = allFills.filter(f => f.side === 'buy');
    const sellFills = allFills.filter(f => f.side === 'sell');

    const totalBuyValue = buyFills.reduce((sum, f) => sum + f.quoteAmount, 0);
    const totalSellValue = sellFills.reduce((sum, f) => sum + f.quoteAmount, 0);
    const totalBuyAsset = buyFills.reduce((sum, f) => sum + f.size, 0);
    const totalSellAsset = sellFills.reduce((sum, f) => sum + f.size, 0);
    const totalFees = allFills.reduce((sum, f) => sum + f.netFee, 0);

    return {
      totalFills: allFills.length,
      buyFills: buyFills.length,
      sellFills: sellFills.length,
      totalBuyValue: roundUSDC(totalBuyValue),
      totalSellValue: roundUSDC(totalSellValue),
      totalBuyAsset: roundAsset(totalBuyAsset),
      totalSellAsset: roundAsset(totalSellAsset),
      netAsset: roundAsset(totalBuyAsset - totalSellAsset),
      totalFees: roundUSDC(totalFees),
      currentCycleId,
    };
  };

  /**
   * Get fill time statistics for entry orders
   * @param {number} [sinceDays=7] - Only include fills from the last N days
   * @returns {{count: number, avgMs: number, minMs: number, maxMs: number, p50Ms: number, p90Ms: number, staleCount: number, staleRate: number}}
   */
  const getFillTimeStatsUncached = (sinceDays = 7) => {
    const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);

    // Get buy fills with fill time data
    const fillsWithTime = Array.from(fills.values())
      .filter(f => f.side === 'buy' && f.fillTimeMs !== null && f.fillTimeMs !== undefined && f.timestamp >= cutoff)
      .map(f => f.fillTimeMs)
      .sort((a, b) => a - b);

    if (fillsWithTime.length === 0) {
      return {
        count: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p90Ms: 0,
        staleCount: 0,
        staleRate: 0,
      };
    }

    const sum = fillsWithTime.reduce((acc, t) => acc + t, 0);
    const avg = sum / fillsWithTime.length;

    // Calculate percentiles
    const p50Index = Math.floor(fillsWithTime.length / 2);
    const p90Index = Math.floor(fillsWithTime.length * 0.9);

    // Count "stale" fills (took longer than 30s default)
    const staleThreshold = 30000; // 30 seconds
    const staleCount = fillsWithTime.filter(t => t > staleThreshold).length;

    return {
      count: fillsWithTime.length,
      avgMs: Math.round(avg),
      minMs: fillsWithTime[0],
      maxMs: fillsWithTime[fillsWithTime.length - 1],
      p50Ms: fillsWithTime[p50Index],
      p90Ms: fillsWithTime[Math.min(p90Index, fillsWithTime.length - 1)],
      staleCount,
      staleRate: roundUSDC((staleCount / fillsWithTime.length) * 100),
    };
  };

  // Memoization for getFillTimeStatsUncached (issue #365), same
  // ledgerVersion-based invalidation as computeRealizedFromCyclePairs. This
  // one also depends on wall-clock time (the `sinceDays` cutoff slides
  // forward every millisecond, aging fills out of the window even with no
  // ledger mutation), so the cache key additionally includes a coarse
  // "time bucket" — the cached value is reused only within the same
  // 1-minute window, which is far more granular than the multi-day
  // `sinceDays` cutoff it approximates and keeps the 1Hz status-tick caller
  // (getState()) hitting cache on every call in between.
  const FILL_TIME_STATS_BUCKET_MS = 60 * 1000;
  let cachedFillTimeStats = null; // { sinceDays, bucket, version, result }
  // Test-only: counts actual (non-cached) recomputations, mirroring
  // realizedRecomputeCount above.
  let fillTimeStatsRecomputeCount = 0;
  const getFillTimeStats = (sinceDays = 7) => {
    const bucket = Math.floor(Date.now() / FILL_TIME_STATS_BUCKET_MS);
    if (
      cachedFillTimeStats &&
      cachedFillTimeStats.sinceDays === sinceDays &&
      cachedFillTimeStats.bucket === bucket &&
      cachedFillTimeStats.version === ledgerVersion
    ) {
      return { ...cachedFillTimeStats.result };
    }
    const result = getFillTimeStatsUncached(sinceDays);
    fillTimeStatsRecomputeCount += 1;
    cachedFillTimeStats = { sinceDays, bucket, version: ledgerVersion, result };
    return { ...result };
  };

  /**
   * Get fills since a timestamp
   * @param {number} since - Timestamp
   * @returns {Fill[]}
   */
  const getFillsSince = (since) => {
    return Array.from(fills.values())
      .filter(f => f.timestamp >= since)
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Calculate aggregate stats for fills
   * @param {Fill[]} fillsToAggregate - Fills to aggregate
   * @returns {{totalSize: number, totalValue: number, totalFees: number, avgPrice: number, cycleId: string|null, lastTimestamp: number}}
   */
  const aggregateFills = (fillsToAggregate) => {
    let totalSize = 0;
    let totalValue = 0;
    let totalFees = 0;
    // `cycleId` is taken from the EARLIEST fill and `lastTimestamp` from the
    // latest, so a closed trade can be stamped with the cycle/time the sell
    // actually belongs to. Callers must NOT substitute getCurrentCycleId() or
    // Date.now(): resetCycle() advances the cycle counter before the closed
    // trade is recorded, and the offline-fill paths record a fill that may
    // have happened days earlier. Reading live values there misfiles the
    // trade under a later cycle and dates it to engine-restart time (the
    // 612c14ce incident: a cycle-18 sell recorded as cycle-21). Earliest —
    // not latest — cycle so a partial fill straddling a cycle reset can't
    // drift the trade forward into the new cycle.
    let earliestTs = Infinity;
    let latestTs = 0;
    let cycleId = null;

    for (const fill of fillsToAggregate) {
      totalSize += fill.size;
      totalValue += fill.quoteAmount;
      totalFees += fill.netFee;
      if (fill.timestamp <= earliestTs) {
        earliestTs = fill.timestamp;
        cycleId = fill.cycleId ?? null;
      }
      if (fill.timestamp > latestTs) latestTs = fill.timestamp;
    }

    return {
      totalSize: roundAsset(totalSize),
      totalValue: roundUSDC(totalValue),
      totalFees: roundUSDC(totalFees),
      avgPrice: totalSize > 0 ? totalValue / totalSize : 0,
      cycleId,
      lastTimestamp: latestTs,
    };
  };

  // Cycle repair mutates the owner's maps and scalar state through explicit
  // accessors; preview shares its planner without applying any mutation.
  const { planRecalculation, recalculateCycles } = createCycleApplication({
    fills,
    cycleIndex,
    logger,
    exchange,
    cycleCompletionRatio,
    persist,
    bumpLedgerVersion,
    setDirty: () => { dirtySinceLastPersist = true; },
    get currentCycleId() { return currentCycleId; },
    set currentCycleId(value) { currentCycleId = value; },
    get currentCycleStartedAt() { return currentCycleStartedAt; },
    set currentCycleStartedAt(value) { currentCycleStartedAt = value; },
    get nextCycleNumber() { return nextCycleNumber; },
    set nextCycleNumber(value) { nextCycleNumber = value; },
  });

  /**
   * Read-only sibling of recalculateCycles (issue #132). Returns the SAME
   * cycleDetails / orphansFixed / activeCycleId — it runs the same planner —
   * WITHOUT applying the plan: it never assigns cycleIds to fills, touches
   * cycleIndex / currentCycleId / nextCycleNumber, sets the dirty flag, or
   * persists. This lets the running-engine recalculate PREVIEW show full
   * per-cycle detail and the orphan-fix count without risking the engine's
   * periodic save persisting a recalc the operator may cancel.
   *
   * The P&L numbers (realizedPnL/realizedAssetPnL) intentionally come from the
   * cycle-pair source of truth (getDerivedRealizedPnL) — recalculateCycles' own
   * avgCost-prorated totals are diagnostic. Here we surface cycleDetails and
   * the orphan-fix count so the UI can render them.
   *
   * @returns {{cyclesCompleted: number, cycleDetails: Array, orphansFixed: number, orphansAttributed: number, liveCycleOrphansAttributed: number, activeCycleId: string|null, idMap: Object<string, string>}}
   */
  const previewRecalculateCycles = () => {
    const plan = planRecalculation();
    return {
      cyclesCompleted: plan.cycleDetails.length,
      cycleDetails: plan.cycleDetails,
      orphansFixed: plan.orphansFixed,
      orphansAttributed: plan.attributed.length,
      liveCycleOrphansAttributed: plan.liveCycleOrphansAttributed,
      activeCycleId: plan.activeCycleId,
      idMap: plan.idMap,
    };
  };

  /**
   * Update a fill's cycleId
   * @param {string} tradeId - Trade ID
   * @param {string} cycleId - New cycle ID
   */
  const updateFillCycleId = (tradeId, cycleId) => {
    const fill = fills.get(tradeId);
    if (fill) {
      // Remove from old cycle index
      if (fill.cycleId && cycleIndex.has(fill.cycleId)) {
        cycleIndex.get(fill.cycleId).delete(tradeId);
      }
      fill.cycleId = cycleId;
      fills.set(tradeId, fill);
      dirtySinceLastPersist = true;
      bumpLedgerVersion();
      // Add to new cycle index
      if (cycleId) {
        if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
        cycleIndex.get(cycleId).add(tradeId);
      }
    }
  };

  /**
   * Annotate a fill with additional metadata (e.g. celestial body TP data)
   * @param {Iterable<string>} orderIds - Order IDs to annotate fills for
   * @param {Object} metadata - Key-value pairs to merge into the fill (bodyId, bodyTier, isBodyOwned, etc.)
   * @param {{include?: (fill: Fill) => boolean}} [options] - `include` limits
   *   the annotation to the rows it accepts (default: every row of the orders)
   */
  const annotateFillsByOrderIds = (orderIds, metadata, { include } = {}) => {
    const ids = new Set(orderIds);
    let matched = false;
    for (const [, fill] of fills) {
      if (ids.has(fill.orderId) && (!include || include(fill))) {
        Object.assign(fill, metadata);
        matched = true;
        dirtySinceLastPersist = true;
      }
    }
    if (matched) bumpLedgerVersion();
    // Persist when sellOrderId is set to ensure it survives restarts
    if (matched && metadata.sellOrderId) {
      persist();
    }
  };

  // Keep single-order callers on the same persistence contract.
  const annotateFillsByOrderId = (orderId, metadata) => annotateFillsByOrderIds([orderId], metadata);

  const {
    getSellBooking,
    commitSellBooking,
    getUnbookedSellFills,
    getBuyOrderConsumption,
    recordBuyConsumption,
    sealLegacyClosedBuys,
    claimCapitalCredit,
  } = createBookingStore({
    fills,
    getFillsForOrder,
    setDirty: () => { dirtySinceLastPersist = true; },
    bumpLedgerVersion,
    persist,
  });

  // Realized P&L derivation (cycle-pair source of truth and the FIFO
  // diagnostic) is the pure, read-only fill-ledger-realized.js (issue #1613);
  // the ledger owns only the memoization over ledgerVersion.
  //
  // Memoization for realized.computeRealizedFromCyclePairs (issue #365). The
  // ledger is immutable between order fills/annotations, yet getState()
  // calls this on every ~1s status tick — cache the result and only
  // recompute when ledgerVersion has moved since the cached call. A stale
  // read is unacceptable, so this NEVER changes what's returned — it only
  // skips re-scanning `fills` and re-allocating the aggregation Maps when
  // nothing has mutated. Returns a shallow copy so a caller mutating the
  // result (there are none today, but the contract should hold regardless)
  // can't corrupt the cached value for the next reader.
  let cachedRealized = null; // { version: number, result: object }
  // Test-only: counts actual (non-cached) recomputations so tests can prove
  // memoization without relying on wall-clock timing.
  let realizedRecomputeCount = 0;
  const computeRealizedFromCyclePairs = () => {
    if (cachedRealized && cachedRealized.version === ledgerVersion) {
      return { ...cachedRealized.result };
    }
    const result = realized.computeRealizedFromCyclePairs(fills);
    realizedRecomputeCount += 1;
    cachedRealized = { version: ledgerVersion, result };
    return { ...result };
  };

  /**
   * FIFO replay. Diagnostic only — not the source of truth.
   * See computeFifoRealized in fill-ledger-realized.js.
   */
  const computeFifoRealized = () => realized.computeFifoRealized(fills);

  /**
   * Source-of-truth derivation for position.realizedPnL and realizedAssetPnL.
   * @returns {{realizedPnL: number, realizedAssetPnL: number, unpairedSellQty: number, heldOpenBuyCostBasis: number, heldOpenAssetQty: number, ledgerNetAsset: number, untrackedSellQty: number}}
   */
  const getDerivedRealizedPnL = () => computeRealizedFromCyclePairs();

  /**
   * Get the count of unique buy orders in the current cycle
   * @returns {number} Unique buy order count
   */
  const getCurrentCycleBuysCount = () => {
    const cycleFills = getCurrentCycleFills();
    const uniqueBuyOrders = new Set();
    for (const fill of cycleFills) {
      // Skip body-owned buys — they have independent position tracking
      if (fill.side === 'buy' && !isBodyOwnedFill(fill)) {
        uniqueBuyOrders.add(fill.orderId);
      }
    }
    return uniqueBuyOrders.size;
  };

  /**
   * Count unique buy ORDERS in the current cycle regardless of body ownership.
   * In celestial mode every engine buy is body-owned, so getCurrentCycleBuysCount
   * (which excludes body-owned buys) returns 0 and silently zeroes the restored
   * cycleBuys counter. This matches the live commitBuyAccounting, which increments
   * once per unique buy order (body-owned or core) in the cycle (issue #210-A).
   * @returns {number} Unique buy order count (all ownership)
   */
  const getCurrentCycleAllBuysCount = () => {
    const cycleFills = getCurrentCycleFills();
    const uniqueBuyOrders = new Set();
    for (const fill of cycleFills) {
      if (fill.side === 'buy') {
        uniqueBuyOrders.add(fill.orderId);
      }
    }
    return uniqueBuyOrders.size;
  };

  // Initialize by loading from disk
  load();

  return {
    ingestFill,
    resumeBuyCorrections,
    resumeSellCorrections,
    setBuyCorrectionHandler: handler => { buyCorrectionHandler = handler; },
    setSellCorrectionHandler: handler => { sellCorrectionHandler = handler; },
    getFillsForOrder,
    /** O(1) watermark lookup. Use this in hot paths instead of getFillsForOrder + reduce. */
    getRecordedSizeForOrder: (orderId) => orderSizeIndex.get(orderId) || 0,
    getCurrentCycleFills,
    getCurrentCycleBuysCount,
    getCurrentCycleAllBuysCount,
    getCurrentCycleStartedAt,
    rebuildPositionFromFills,
    startNewCycle,
    getCurrentCycleId,
    setCurrentCycleId,
    hasProcessedTrade,
    getFillCount,
    getAllFills,
    getFillPage: input => transactionsReadView.query(input),
    getFillAggregates: () => transactionsReadView.aggregates(),
    getStats,
    getFillTimeStats,
    getFillsSince,
    aggregateFills,
    recalculateCycles,
    previewRecalculateCycles,
    computeFifoRealized,
    computeRealizedFromCyclePairs,
    getDerivedRealizedPnL,
    updateFillCycleId,
    getBuyOrderConsumption,
    recordBuyConsumption,
    sealLegacyClosedBuys,
    annotateFillsByOrderId,
    annotateFillsByOrderIds,
    getSellBooking,
    getUnbookedSellFills,
    commitSellBooking,
    claimCapitalCredit,
    persist,
    /** Mark the in-memory ledger as dirty so the next persist() actually
     * writes to disk. Restricted contract: callers MUST limit mutations
     * to METADATA-ONLY fields that do not feed any derived index — i.e.
     * NOT tradeId, orderId, cycleId, or size. The orderSizeIndex (keyed
     * by orderId, summed by size), orderIdIndex (keyed by orderId), and
     * cycleIndex (keyed by cycleId) are not refreshed here; mutating an indexed field via this path would
     * persist new values to disk while in-memory lookups continued to
     * return stale results until the next reload. dca-converter.js uses
     * this only for the sellOrderId annotation, which is metadata. For
     * indexed-field changes use the dedicated mutators
     * (annotateFillsByOrderId, updateFillCycleId). */
    markDirty: () => { dirtySinceLastPersist = true; bumpLedgerVersion(); },
    /** True when in-memory fills hold changes the next persist() would write.
     * A load() now would discard them (resetCaches clears the flag too), so
     * the engine's SIGUSR1 reload refuses while this is set (issue #1407). */
    isDirty: () => dirtySinceLastPersist,
    load,
    // Test-only handle: returns the number of times persist() actually
    // wrote to disk (skipping the no-op short-circuit). Lets tests
    // assert "no-op when clean" without relying on filesystem mtime,
    // which has variable granularity across CI runners.
    _test: {
      getWriteCount: () => writeCount,
      getLedgerVersion: () => ledgerVersion,
      getTransactionsRecomputeCount: transactionsReadView.getRecomputeCount,
      getRealizedRecomputeCount: () => realizedRecomputeCount,
      getFillTimeStatsRecomputeCount: () => fillTimeStatsRecomputeCount,
      reconcileSyntheticCoverage: coverage.reconcile,
    },
  };
};

/**
 * Read-only fill-ledger cache for the gateway. Keyed on (exchange|pair) and
 * invalidated by the ledger file's mtime+size, so repeated dashboard polls
 * reuse an already-loaded instance instead of re-reading and re-parsing the
 * whole file (multi-MB / tens of thousands of rows) on every request — which
 * otherwise blocks the gateway event loop on each poll (issue #183).
 *
 * ONLY for read-only consumers (status/summary/cost-basis HTTP routes). The
 * returned instance is shared across requests; callers must NOT mutate it
 * (no ingestFill/persist/annotate). Engines/scripts that own a mutable live
 * ledger must keep using createFillLedger directly. The cache is per-process,
 * so the gateway and each engine keep independent caches.
 * @type {Map<string, {ledger: Object, mtimeMs: number, size: number}>}
 */
const _readOnlyLedgerCache = new Map();

/**
 * Get a cached, quiet, read-only fill ledger for the given fund. Reloads only
 * when the on-disk file's mtime or size changes; otherwise returns the cached
 * instance without touching disk.
 * @param {string} exchange
 * @param {string} [productId]
 * @param {string} [pair]
 * @returns {Object} Fill ledger instance (read-only — do not mutate)
 */
const getCachedFillLedger = (exchange, productId, pair) => {
  const filePath = getFillLedgerPath(exchange, pair);
  let mtimeMs = 0;
  let size = 0;
  let exists = false;
  try {
    const st = fs.statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
    exists = true;
  } catch { /* missing file → not cached (see below) */ }

  // Only cache funds whose ledger file actually exists. `pair` reaches this from
  // the HTTP layer format-validated but NOT existence-checked, so a client
  // polling /summary?pair=<bogus> (many valid-format values) would otherwise
  // insert a permanent cache entry + empty ledger per distinct value and grow
  // the gateway heap without bound. A nonexistent fund just builds a throwaway
  // (cheap: load() early-returns on the missing file) and is never cached.
  if (!exists) return createFillLedger(exchange, productId, pair, { quiet: true });

  // Note: key intentionally omits productId — it only feeds log formatting in the
  // ledger, never a value returned to read-only callers, so a (rare) productId
  // divergence for the same (exchange,pair) can't affect cached results.
  const key = `${exchange}|${pair}`;
  const cached = _readOnlyLedgerCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.ledger;
  }

  const ledger = createFillLedger(exchange, productId, pair, { quiet: true });
  _readOnlyLedgerCache.set(key, { ledger, mtimeMs, size });
  return ledger;
};

module.exports = {
  createFillLedger,
  LEDGER_FORMAT_VERSION,
  LEGACY_CONSUMPTION_KEY,
  FillValidationError,
  validateFillInput: normalizeFillInput,
  getCachedFillLedger,
  getFillLedgerPath,
};
