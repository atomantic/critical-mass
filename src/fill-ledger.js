// @ts-check
/**
 * Fill Ledger
 *
 * Idempotent fill tracking with proper cost basis calculation.
 * Uses trade_id as primary key to prevent duplicate processing.
 * Maintains fill history and rebuilds position state from fills.
 */

const fs = require('fs');
const path = require('path');
const { resolveFundDataDir } = require('./migration');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { atomicWriteSync } = require('./state-tracker');
const { getBaseCurrency } = require('./config-utils');
const { fmtCurrency } = require('./shared-utils');
const { createContextLogger } = require('./logger');
// Canonical cycle pairing shared with the admin Filled Orders view (issue #697).
const { pairCycleFills, buyPairKey } = require('../shared/cycle-pairing.mjs');

/**
 * @typedef {import('./types').Fill} Fill
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * `consumedBy` key for consumption that sells recorded before per-order
 * consumption tracking existed (issue #607) had already taken from a buy.
 */
const LEGACY_CONSUMPTION_KEY = '__legacy__';

/**
 * Total base quantity recorded in a buy's `consumedBy` map.
 * @param {Object<string, number>} consumedBy
 * @returns {number}
 */
const sumConsumedBy = (consumedBy) => Object.values(consumedBy)
  .reduce((sum, qty) => sum + (Number.isFinite(qty) && qty > 0 ? qty : 0), 0);

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
  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
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
    seenTradeIds.add(fill.tradeId);
  }
  return null;
};

/**
 * Sell-ratio completion threshold: a cycle is completed when total sells cover
 * at least this fraction of bought asset volume (body TP sells, core TP sells,
 * or any combination).
 */
let CYCLE_COMPLETE_SELL_RATIO = 0.5;

/**
 * Set the completion threshold (for tests).
 * @param {number} val
 */
const setCycleCompleteSellRatioForTest = (val) => {
  CYCLE_COMPLETE_SELL_RATIO = val;
};

/**
 * Determine whether a cycle is completed based on total sell size vs buy size.
 * @param {Fill[]} cycleFills - All fills in the cycle
 * @param {number} [threshold=CYCLE_COMPLETE_SELL_RATIO] - Completion threshold
 * @returns {boolean} True if cycle is completed
 */
const isCompletedCycle = (cycleFills, threshold = CYCLE_COMPLETE_SELL_RATIO) => {
  let buys = 0;
  let sells = 0;
  for (const fill of cycleFills) {
    const size = Number(fill.size) || 0;
    if (fill.side === 'buy') buys += size;
    else if (fill.side === 'sell') sells += size;
  }
  return buys > 0 && (sells / buys) >= threshold;
};

/**
 * Group fills by cycleId and collect orphan fills (cycleId: null).
 * @param {Fill[]} allFills - Array of all fills
 * @returns {{ cycleMap: Map<string, Fill[]>, orphanFills: Fill[] }}
 */
const groupFillsByCycle = (allFills) => {
  const cycleMap = new Map();
  const orphanFills = [];
  for (const fill of allFills) {
    if (!fill.cycleId) {
      orphanFills.push(fill);
    } else {
      if (!cycleMap.has(fill.cycleId)) {
        cycleMap.set(fill.cycleId, []);
      }
      cycleMap.get(fill.cycleId).push(fill);
    }
  }
  return { cycleMap, orphanFills };
};

/**
 * Split orphan fills (cycleId: null) into recovered cycles based on buy-sell pattern.
 * A sell ends a cycle; the next buy starts a new cycle.
 * @param {Fill[]} orphanFills - Array of orphan fills
 * @returns {Array<{cycleId: string, fills: Fill[]}>} Recovered cycles with -recovered-N naming
 */
const splitOrphansIntoCycles = (orphanFills) => {
  if (!orphanFills || orphanFills.length === 0) return [];
  const sorted = [...orphanFills].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const rawCycles = [];
  let current = [];
  let lastWasSell = false;

  for (const fill of sorted) {
    if (lastWasSell && fill.side === 'buy') {
      if (current.length > 0) {
        rawCycles.push(current);
      }
      current = [];
    }
    current.push(fill);
    lastWasSell = (fill.side === 'sell');
  }
  if (current.length > 0) {
    rawCycles.push(current);
  }

  const result = [];
  for (let i = 0; i < rawCycles.length; i++) {
    const fills = rawCycles[i];
    const cycleId = `cycle-${fills[0].timestamp}-recovered-${i + 1}`;
    result.push({ cycleId, fills });
  }
  return result;
};

/**
 * Order IDs a fill is linked through: its own order, plus — for a buy — the
 * sell it was paired with (`sellOrderId`, stamped at TP placement) and every
 * sell recorded in its per-buy consumption map (`consumedBy`, issue #607).
 * @param {Fill} fill
 * @returns {string[]}
 */
const linkedOrderIdsOf = (fill) => {
  const ids = [];
  if (fill.orderId) ids.push(fill.orderId);
  if (fill.side === 'buy') {
    if (fill.sellOrderId) ids.push(fill.sellOrderId);
    if (fill.consumedBy && typeof fill.consumedBy === 'object') {
      for (const sellOrderId of Object.keys(fill.consumedBy)) {
        if (sellOrderId !== LEGACY_CONSUMPTION_KEY) ids.push(sellOrderId);
      }
    }
  }
  return ids;
};

/**
 * Attribute orphan fills (cycleId: null) to EXISTING cycles before the
 * leftovers are split into recovered cycles (issue #705). Pure — never
 * mutates a fill — so recalculateCycles and previewRecalculateCycles make the
 * identical decision.
 *
 * Orphans are first grouped into linked components (shared order ID, or a
 * buy's `sellOrderId` / `consumedBy` naming another orphan's sell), and each
 * component moves as a unit, so a linked buy can never be separated from its
 * (partial) sell — cycles are atomic (CLAUDE.md P&L model). A component is
 * placed by, in order:
 *   1. same order ID as fills already in a cycle (partial-fill rows of one
 *      order) — exactly one such cycle wins;
 *   2. otherwise buy↔sell linkage to fills already in a cycle — exactly one
 *      such cycle wins;
 *   3. otherwise, when it has NO linkage to any cycled fill, timestamp: a
 *      BUY-ONLY component folds into the live cycle only if every fill in it
 *      is at/after the live cycle's start boundary (a buy the engine missed
 *      during downtime inside the live cycle) AND no orphan sell left
 *      unplaced by linkage follows it (that sell would close it in a
 *      recovered cycle — e.g. an unlinked manual round trip). A component holding a sell
 *      never folds by time: the engine's own TP sells reach their cycle via
 *      linkage above, so an unlinked sell (e.g. a manual-trade import pair)
 *      is not the live cycle's buy(n) → sell(1) close and must not complete
 *      it or reduce its position.
 * Components linked to more than one cycle, holding an unlinked sell,
 * straddling the boundary, or predating it are left for recovered-cycle
 * placement, as before.
 *
 * @param {Object} params
 * @param {Map<string, Fill[]>} params.cycleMap - cycleId -> fills already carrying that cycleId
 * @param {Fill[]} params.orphanFills - Fills with no cycleId
 * @param {string|null} params.liveCycleId - The engine's live cycle
 * @param {number|null} params.liveStartTs - Earliest timestamp that belongs to the live cycle, or null when unknown
 * @returns {{ attributed: Array<{fill: Fill, cycleId: string, reason: 'order'|'link'|'timeframe'}>, remaining: Fill[], liveCount: number }}
 */
const attributeOrphanFills = ({ cycleMap, orphanFills, liveCycleId, liveStartTs }) => {
  if (!orphanFills || orphanFills.length === 0) return { attributed: [], remaining: [], liveCount: 0 };

  // Cycles each order ID appears in, by the fill's own order (strong) and by
  // any linkage (weak — includes strong).
  /** @type {Map<string, Set<string>>} */
  const ownOrderCycles = new Map();
  /** @type {Map<string, Set<string>>} */
  const linkedCycles = new Map();
  const addTo = (map, key, cycleId) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(cycleId);
  };
  for (const [cycleId, cycleFills] of cycleMap) {
    for (const fill of cycleFills) {
      if (fill.orderId) addTo(ownOrderCycles, fill.orderId, cycleId);
      for (const id of linkedOrderIdsOf(fill)) addTo(linkedCycles, id, cycleId);
    }
  }

  // Union-find over orphans sharing any linked order ID.
  const parent = orphanFills.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  /** @type {Map<string, number>} */
  const firstByOrderId = new Map();
  orphanFills.forEach((fill, i) => {
    for (const id of linkedOrderIdsOf(fill)) {
      if (firstByOrderId.has(id)) {
        const a = find(i);
        const b = find(firstByOrderId.get(id));
        if (a !== b) parent[a] = b;
      } else {
        firstByOrderId.set(id, i);
      }
    }
  });
  /** @type {Map<number, Fill[]>} */
  const components = new Map();
  orphanFills.forEach((fill, i) => {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(fill);
  });

  // Pass 1: linkage (same order, then buy↔sell links) against cycled fills.
  /** @type {Array<{members: Fill[], target: string|null, reason: 'order'|'link'|'timeframe', linked: boolean}>} */
  const decisions = [];
  for (const members of components.values()) {
    const strong = new Set();
    const weak = new Set();
    for (const fill of members) {
      for (const c of (fill.orderId && ownOrderCycles.get(fill.orderId)) || []) strong.add(c);
      for (const id of linkedOrderIdsOf(fill)) {
        for (const c of linkedCycles.get(id) || []) weak.add(c);
      }
    }
    let target = null;
    /** @type {'order'|'link'|'timeframe'} */
    let reason = 'order';
    if (strong.size > 0) {
      if (strong.size === 1) target = [...strong][0];
    } else if (weak.size > 0) {
      if (weak.size === 1) target = [...weak][0];
      reason = 'link';
    }
    decisions.push({ members, target, reason, linked: strong.size > 0 || weak.size > 0 });
  }

  // Timestamps of orphan sells that linkage could not place. They go on to
  // recovered-cycle splitting, which pairs a sell with the unlinked buys
  // before it — so a buy followed by such a sell (a manual round trip that
  // sync-fills re-imported without links) must stay with it rather than fold
  // into the live cycle, or the pair would be split across cycles.
  const unplacedSellTs = [];
  for (const { members, target } of decisions) {
    if (target) continue;
    for (const fill of members) {
      if (fill.side === 'sell') unplacedSellTs.push(Number(fill.timestamp));
    }
  }

  // Pass 2: fold wholly-unlinked, buy-only components that sit entirely
  // inside the live cycle's timeframe with no unplaced sell after them.
  const hasLiveBoundary = Boolean(liveCycleId) && Number.isFinite(liveStartTs);
  const attributed = [];
  const remaining = [];
  let liveCount = 0;
  for (const decision of decisions) {
    const { members, linked } = decision;
    if (!decision.target && !linked && hasLiveBoundary
      && members.every(f => f.side === 'buy' && Number(f.timestamp) >= /** @type {number} */ (liveStartTs))) {
      const earliest = Math.min(...members.map(f => Number(f.timestamp)));
      if (!unplacedSellTs.some(ts => ts >= earliest)) {
        decision.target = liveCycleId;
        decision.reason = 'timeframe';
      }
    }
    const { target, reason } = decision;
    if (target) {
      for (const fill of members) attributed.push({ fill, cycleId: target, reason });
      if (target === liveCycleId) liveCount += members.length;
    } else {
      remaining.push(...members);
    }
  }
  return { attributed, remaining, liveCount };
};

/**
 * Build mapping from old cycle IDs to sequential cycle-1, cycle-2... IDs.
 * Completed cycles are ordered first by timestamp, followed by active cycles.
 * The live cycle (`currentId`) is always numbered LAST, even when it has no
 * fills yet (a fresh post-reset cycle), so renumbering can never hand its ID
 * to a historical cycle or leave it colliding with a renumbered one (#675).
 * @param {Map<string, number>} cycleTimestamps - Map of cycleId -> earliest fill timestamp
 * @param {Set<string>} completedIds - Set of completed cycleIds
 * @param {string|null} [currentId=null] - The engine's live cycle ID
 * @returns {{ idMap: Map<string, string>, nextCycleNumber: number, renumbered: number }}
 */
const buildCycleRenumberingMap = (cycleTimestamps, completedIds, currentId = null) => {
  const completedEntries = [];
  const activeEntries = [];
  for (const [id, ts] of cycleTimestamps) {
    if (currentId && id === currentId) continue;
    if (completedIds.has(id)) completedEntries.push([id, ts]);
    else activeEntries.push([id, ts]);
  }
  completedEntries.sort((a, b) => a[1] - b[1]);
  activeEntries.sort((a, b) => a[1] - b[1]);
  const ordered = [...completedEntries, ...activeEntries];
  if (currentId) ordered.push([currentId]);

  let cycleNum = 1;
  let renumbered = 0;
  const idMap = new Map();
  for (const [oldId] of ordered) {
    const newId = `cycle-${cycleNum}`;
    idMap.set(oldId, newId);
    if (oldId !== newId) renumbered++;
    cycleNum++;
  }
  return { idMap, nextCycleNumber: cycleNum, renumbered };
};

/**
 * Collect the earliest fill timestamp for each cycle across existing cycles and orphan cycles.
 * @param {Map<string, Fill[]>} cycleMap - Map of cycleId -> array of fills
 * @param {Array<{cycleId: string, fills: Fill[]}>} [orphanCycles=[]] - Array of recovered orphan cycles
 * @returns {Map<string, number>} Map of cycleId -> earliest timestamp
 */
const collectCycleTimestamps = (cycleMap, orphanCycles = []) => {
  const cycleTimestamps = new Map();
  for (const [id, cycleFills] of cycleMap) {
    for (const fill of cycleFills) {
      const ts = Number(fill.timestamp) || 0;
      const existing = cycleTimestamps.get(id);
      if (existing === undefined || ts < existing) {
        cycleTimestamps.set(id, ts);
      }
    }
  }
  for (const { cycleId, fills: cycleFills } of orphanCycles) {
    for (const fill of cycleFills) {
      const ts = Number(fill.timestamp) || 0;
      const existing = cycleTimestamps.get(cycleId);
      if (existing === undefined || ts < existing) {
        cycleTimestamps.set(cycleId, ts);
      }
    }
  }
  return cycleTimestamps;
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
  // metadata fields that do not feed orderSizeIndex / cycleIndex.
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
  // updateFillCycleId, annotateFillsByOrderIds, claimCapitalCredit, and the
  // external markDirty() escape hatch for direct fill-object edits) calls
  // bumpLedgerVersion() alongside its existing dirtySinceLastPersist flag.
  let ledgerVersion = 0;
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
      if (!isReload) {
        // Cold-start corruption: throwing forces the operator to repair
        // (or move aside) the file before the engine boots, so a
        // post-start persist can't overwrite the recoverable contents.
        throw new Error(`fill-ledger at ${filePath} is corrupted or unreadable on cold start: ${err.message}. Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
      }
      // Corrupt/unreadable file: don't reset in-memory state. SIGUSR1
      // reload on a live ledger could otherwise turn a bad manual edit
      // or partial write into live data loss — the running process
      // would forget its last known-good state and the next persist
      // would rewrite the file with only the fills that arrive after
      // the reload. Operator can fix the file and re-fire SIGUSR1.
      logger.error(`❌ [${exchange}] fill-ledger corrupted or unreadable at ${filePath}: ${err.message} — keeping in-memory state (${fills.size} fills); operator must fix and reload`, {
        filePath,
        fillCount: fills.size,
        error: err.message,
      });
      return;
    }
    // Validate shape BEFORE resetCaches. Valid JSON like `{}` or `null`
    // would parse without throwing but the for-of below would crash —
    // resetCaches() would have already wiped the live ledger by then,
    // so the reload-on-malformed-payload would fall into the same data-
    // loss mode that the catch-block above guards against.
    if (!Array.isArray(data)) {
      if (!isReload) {
        throw new Error(`fill-ledger at ${filePath} is not an array on cold start (got ${data === null ? 'null' : typeof data}). Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
      }
      const actualType = data === null ? 'null' : typeof data;
      logger.error(`❌ [${exchange}] fill-ledger at ${filePath} is not an array (got ${actualType}) — keeping in-memory state (${fills.size} fills); operator must fix and reload`, {
        filePath,
        fillCount: fills.size,
        actualType,
      });
      return;
    }
    // Element-level validation: even an array can contain malformed
    // entries like `[null]` or `[{}]` that would crash on `fill.tradeId`
    // mid-loop, leaving the live ledger half-populated after the
    // already-run resetCaches. Pre-pass guarantees a clean reload-or-bail.
    //
    // Field-type validation is required, not just presence: the load-body
    // below calls `fill.cycleId.match(/^cycle-(\d+)$/)` which throws on
    // non-string cycleId (e.g. an object). A presence-only pre-pass would
    // accept `{tradeId:"t1", cycleId:{}}` and we'd crash mid-load AFTER
    // resetCaches has wiped the live ledger — re-introducing the data-loss
    // mode the pre-validation is meant to prevent.
    const invalidReason = findInvalidLedgerReason(data);
    if (invalidReason) {
      if (!isReload) {
        throw new Error(`fill-ledger at ${filePath} contains an invalid entry (${invalidReason}) on cold start. Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
      }
      logger.error(`❌ [${exchange}] fill-ledger at ${filePath} contains an invalid entry (${invalidReason}) — keeping in-memory state (${fills.size} fills); operator must fix and reload`, {
        filePath,
        fillCount: fills.size,
        invalidReason,
      });
      return;
    }
    // Clean slate before re-reading. The successful-read path mirrors
    // disk authoritatively (handles "operator removed fills via manual
    // reconciliation, then reloaded" — those removals must take effect).
    resetCaches();
    for (const fill of data) {
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
      fills.set(fill.tradeId, fill);
      // Populate cycle index
      if (fill.cycleId) {
        if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
        cycleIndex.get(fill.cycleId).add(fill.tradeId);
      }
    }
    // Rebuild orderSizeIndex from the canonical fills Map AFTER population.
    // load() can be called multiple times on a live ledger (regime-engine.js
    // re-loads on state reload). If we accumulated inside the loop above,
    // a second load() would double-count every persisted fill on top of
    // the existing totals — making getRecordedSizeForOrder over-report
    // and the market-data-service watermark believe orders are fully
    // ingested when they're not. Rebuilding from `fills` is idempotent.
    orderSizeIndex.clear();
    for (const f of fills.values()) {
      if (f.orderId) {
        const next = (orderSizeIndex.get(f.orderId) || 0) + (f.size || 0);
        orderSizeIndex.set(f.orderId, roundAsset(next));
      }
    }

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
      .sort((a, b) => a.timestamp - b.timestamp);

    atomicWriteSync(filePath, JSON.stringify(fillsArray, null, 2));
    dirtySinceLastPersist = false;
    writeCount += 1;
  };

  /**
   * Ingest a fill (idempotent)
   * @param {Object} fillData - Raw fill data from exchange
   * @param {number} [orderPlacedAt] - Optional timestamp when the order was placed (for fill time tracking)
   * @param {Object} [options]
   * @param {boolean} [options.skipPersist] - Skip the auto-persist (batch ingestion flushes once at the end)
   * @param {string|null} [options.cycleId] - Explicit cycle assignment. Defaults to the live
   *   currentCycleId. Pass `null` for fills that may be historical (sync/manual reconciliation):
   *   stamping a days-old fill with the live cycleId inflates current-cycle totals and can trip
   *   recalculateCycles' sell-ratio heuristic into marking the active cycle complete. A null-cycle
   *   fill is picked up by recalculateCycles' orphan logic and placed in its correct cycle by
   *   buy/sell pattern (issue #108). Note: pass the property explicitly — an absent `cycleId` key
   *   keeps the live-cycle default; only an explicit `null`/value overrides it.
   * @returns {{ingested: boolean, fill: Fill|null}} Result
   */
  const ingestFill = (fillData, orderPlacedAt = null, options = {}) => {
    const tradeId = fillData.tradeId || fillData.trade_id;

    // Idempotency check
    if (fills.has(tradeId)) {
      return { ingested: false, fill: null };
    }

    const fillTimestamp = fillData.tradeTime ? new Date(fillData.tradeTime).getTime() : Date.now();

    // Calculate fill time if we have order placement time
    const fillTimeMs = orderPlacedAt && orderPlacedAt > 0 ? fillTimestamp - orderPlacedAt : null;

    // Cycle assignment: default to the live cycle, but let callers ingesting
    // potentially-historical fills (sync-fills, manual-trade reconciliation)
    // pass an explicit cycleId (typically null) so old fills don't land in the
    // current cycle. Only override when the key is actually present — an absent
    // key must keep the live-cycle default (issue #108).
    const cycleId = 'cycleId' in options ? options.cycleId : currentCycleId;

    const fill = {
      tradeId,
      orderId: fillData.orderId || fillData.order_id,
      side: (fillData.side || '').toLowerCase(),
      price: parseFloat(fillData.price),
      size: parseFloat(fillData.size),
      quoteAmount: parseFloat(fillData.price) * parseFloat(fillData.size),
      // Accept an explicit fee/totalFees too — synthetic fills built from order
      // status (Coinbase eventual-consistency fallback) carry the known fee as
      // totalFees/fee but no totalCommission, and were previously persisted with
      // fee:0, permanently overstating that order's P&L (issue #210-C).
      fee: parseFloat(fillData.totalCommission || fillData.commission || fillData.fee || fillData.totalFees || 0),
      feeAsset: fillData.commissionAsset || fillData.fee_asset || 'USDC',
      rebate: parseFloat(fillData.rebate || 0),
      // Honor an explicitly-provided netFee (e.g. synthetic fills); otherwise
      // derive it from the gross fee minus rebate.
      netFee: (fillData.netFee !== undefined && fillData.netFee !== null)
        ? parseFloat(fillData.netFee)
        : parseFloat(fillData.totalCommission || fillData.commission || fillData.fee || fillData.totalFees || 0) - parseFloat(fillData.rebate || 0),
      liquidityIndicator: fillData.liquidityIndicator || fillData.liquidity_indicator || 'TAKER',
      timestamp: fillTimestamp,
      ingestedAt: Date.now(),
      cycleId,
      // Fill time tracking
      orderPlacedAt: orderPlacedAt || null,
      fillTimeMs: fillTimeMs,
    };

    fills.set(tradeId, fill);
    // Maintain cycle index
    if (fill.cycleId) {
      if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
      cycleIndex.get(fill.cycleId).add(tradeId);
    }
    // Maintain per-order size index for O(1) watermark lookups in retry loops.
    // Round to asset precision so accumulated float error can't keep the
    // retry chain running on a fully-recorded order (see load() for context).
    if (fill.orderId) {
      const next = (orderSizeIndex.get(fill.orderId) || 0) + (fill.size || 0);
      orderSizeIndex.set(fill.orderId, roundAsset(next));
    }
    dirtySinceLastPersist = true;
    bumpLedgerVersion();
    if (!options.skipPersist) persist();

    const fillTimeStr = fillTimeMs !== null ? ` (fill time: ${(fillTimeMs / 1000).toFixed(1)}s)` : '';
    logger.info(`📝 [${exchange}] Fill ingested: tradeId=${tradeId} orderId=${fill.orderId} ${fill.side} ${fill.size} ${baseCurrency} @ ${fmtPrice(fill.price)} (fee: $${fill.netFee.toFixed(4)})${fillTimeStr}`, {
      tradeId,
      orderId: fill.orderId,
      side: fill.side,
      size: fill.size,
      price: fill.price,
      netFee: fill.netFee,
      fillTimeMs,
    });

    return { ingested: true, fill };
  };

  /**
   * Get all fills for an order
   * @param {string} orderId - Order ID
   * @returns {Fill[]} Fills for the order
   */
  const getFillsForOrder = (orderId) => {
    return Array.from(fills.values())
      .filter(f => f.orderId === orderId)
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
   * Compute cycle statistics (P&L, holdback, cycle detail).
   * Pure helper that extracts duplicated cycle summary logic.
   * Skips body-owned, satellite, and body-linked fills in accounting.
   * @param {string} cycleId - The cycle identifier
   * @param {Fill[]} cycleFills - All fills in this cycle
   * @returns {{cycleDetail: object, pnl: number, holdbackAsset: number}} Cycle stats: detail row, unrounded pnl for accumulation, unrounded holdback
   */
  const computeCycleStats = (cycleId, cycleFills) => {
    let totalAsset = 0;
    let totalCost = 0;
    let sellProceeds = 0;
    let assetSold = 0;

    for (const fill of cycleFills) {
      // Skip body-owned fills — they have independent P&L tracking
      if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;

      if (fill.side === 'buy') {
        totalAsset += fill.size;
        totalCost += fill.quoteAmount + fill.netFee;
      } else if (fill.side === 'sell') {
        sellProceeds += fill.quoteAmount - fill.netFee;
        assetSold += fill.size;
      }
    }

    const avgCost = totalAsset > 0 ? totalCost / totalAsset : 0;
    const costBasisSold = avgCost * assetSold;
    const pnl = sellProceeds - costBasisSold;
    const holdbackAsset = totalAsset - assetSold;

    const cycleDetail = {
      cycleId,
      buys: cycleFills.filter(f => f.side === 'buy' && !f.isSatellite && !f.bodyId).length,
      sells: cycleFills.filter(f => f.side === 'sell' && !f.isSatellite && !f.bodyId).length,
      totalAssetBought: roundAsset(totalAsset),
      assetSold: roundAsset(assetSold),
      holdbackAsset: roundAsset(holdbackAsset),
      avgCost: roundUSDC(avgCost),
      sellPrice: assetSold > 0 ? roundUSDC(sellProceeds / assetSold) : 0,
      pnl: roundUSDC(pnl),
    };

    return { cycleDetail, pnl, holdbackAsset };
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
      if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;

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
  const hasProcessedTrade = (tradeId) => fills.has(tradeId);

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

  /**
   * Earliest timestamp that belongs to the live cycle (issue #705): the
   * persisted start time when known; otherwise (legacy state / inferred
   * cycle) the earliest fill already stamped into the live cycle. Null
   * when neither is known — an empty cycle restored without a start time has
   * no safe boundary, so nothing is folded into it by timestamp.
   * @param {Map<string, Fill[]>} cycleMap
   * @returns {number|null}
   */
  const resolveLiveCycleStartTs = (cycleMap) => {
    if (!currentCycleId) return null;
    // A known start time is authoritative: fills stamped into the live cycle
    // with older timestamps (e.g. DCA-merge synthetic pending buys dated at
    // order creation) must not drag the fold boundary back over unrelated
    // history.
    if (currentCycleStartedAt !== null) return currentCycleStartedAt;
    let startTs = null;
    for (const fill of cycleMap.get(currentCycleId) || []) {
      const ts = Number(fill.timestamp);
      if (Number.isFinite(ts) && (startTs === null || ts < startTs)) startTs = ts;
    }
    return startTs;
  };

  /**
   * Run attributeOrphanFills against the ledger's live cycle and add the
   * attributed fills to `cycleMap` (the local grouping only — the caller
   * decides whether to stamp them). Shared by recalculateCycles and
   * previewRecalculateCycles so both evaluate cycle completion AFTER folding.
   * @param {Map<string, Fill[]>} cycleMap - Mutated: attributed fills appended
   * @param {Fill[]} orphanFills
   * @returns {{ attributed: Array<{fill: Fill, cycleId: string, reason: 'order'|'link'|'timeframe'}>, remaining: Fill[], liveCount: number }}
   */
  const attributeOrphansIntoCycleMap = (cycleMap, orphanFills) => {
    const result = attributeOrphanFills({
      cycleMap,
      orphanFills,
      liveCycleId: currentCycleId,
      liveStartTs: resolveLiveCycleStartTs(cycleMap),
    });
    for (const { fill, cycleId } of result.attributed) {
      if (!cycleMap.has(cycleId)) cycleMap.set(cycleId, []);
      cycleMap.get(cycleId).push(fill);
    }
    return result;
  };

  /**
   * Recalculate cycles from fill history
   * - Identifies completed cycles (cycles with sells)
   * - Attributes orphan fills (cycleId: null) to existing cycles by order
   *   linkage, then folds unlinked ones that fall inside the live cycle's
   *   timeframe into it (issue #705) — before completion is evaluated
   * - Splits the remaining orphans into recovered cycles by buy/sell pattern
   * - Calculates BTC holdback per cycle and total reserves
   * - Never moves the live cycle: incomplete orphan groups stay in their own
   *   recovered cycles, and currentCycleId is only adopted from them when it
   *   was null. Renumbering keeps the live cycle last (#675).
   * @returns {{cyclesCompleted: number, realizedPnL: number, realizedAssetPnL: number, cycleDetails: Array, orphansFixed: number, orphansAttributed: number, liveCycleOrphansAttributed: number, activeCycleId: string|null, idMap: Object<string, string>}}
   */
  const recalculateCycles = () => {
    const allFills = Array.from(fills.values()).sort((a, b) => a.timestamp - b.timestamp);

    // Group fills by cycleId
    const { cycleMap, orphanFills: allOrphanFills } = groupFillsByCycle(allFills);

    // Attribute orphans to existing cycles (linkage first, then the live
    // cycle's timeframe) BEFORE completion is evaluated, so a folded sell
    // that completes a cycle is seen by cycleDetails and auto-link (#705).
    let orphansFixed = 0;
    const {
      attributed,
      remaining: orphanFills,
      liveCount: liveCycleOrphansAttributed,
    } = attributeOrphansIntoCycleMap(cycleMap, allOrphanFills);
    // Order-level annotations live on EVERY row of an order (TP placement,
    // body annotation and #607 consumption all write per-orderId), so a
    // recovered partial row of an already-annotated buy order inherits them —
    // otherwise it reads as an unowned core buy (core totals, legacy TP
    // linkage, boot orphan adoption) while its siblings belong to a body.
    const ORDER_LEVEL_BUY_FIELDS = ['isBodyOwned', 'bodyId', 'bodyTier', 'isSatellite', 'sellOrderId', 'consumedBy', 'consumedCostFraction'];
    for (const { fill, cycleId, reason } of attributed) {
      if (reason === 'order' && fill.side === 'buy') {
        const sibling = (cycleMap.get(cycleId) || []).find(f => f !== fill && f.orderId === fill.orderId && f.side === 'buy' && f.cycleId === cycleId);
        if (sibling) {
          for (const field of ORDER_LEVEL_BUY_FIELDS) {
            if (sibling[field] !== undefined && fill[field] === undefined) {
              fill[field] = field === 'consumedBy' ? { ...sibling[field] } : sibling[field];
            }
          }
        }
      }
      fill.cycleId = cycleId;
      // Record HOW the cycle was chosen. A 'timeframe' fold has no linkage to
      // any engine order — sync-fills imports every trade on the pair, manual
      // ones included — so boot's orphan-buy → body merge must not adopt it
      // and place a TP for it (R2 in docs/pnl-architecture.md).
      fill.cycleAttribution = reason;
      if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
      cycleIndex.get(cycleId).add(fill.tradeId);
      orphansFixed++;
      dirtySinceLastPersist = true;
      bumpLedgerVersion();
    }
    if (attributed.length > 0) {
      logger.info(`🔧 [${exchange}] Attributed ${attributed.length} orphan fills to existing cycles (${liveCycleOrphansAttributed} into live cycle ${currentCycleId})`, {
        attributed: attributed.length,
        liveCycleOrphansAttributed,
        cycleId: currentCycleId,
      });
    }

    // Identify completed cycles (sells have closed most of the position)
    const completedCycles = [];
    const activeCycles = [];

    for (const [cycleId, cycleFills] of cycleMap) {
      if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
        completedCycles.push({ cycleId, fills: cycleFills });
      } else {
        activeCycles.push({ cycleId, fills: cycleFills });
      }
    }

    // Calculate P&L and holdback for each completed cycle
    const cycleDetails = [];
    let totalRealizedPnL = 0;
    let totalRealizedAssetPnL = 0;

    // Global realized P&L via FIFO cost basis replay. This is the gold standard:
    // replay all buys and sells chronologically, track cost lots, compute realized
    // P&L on each sell. Independent of annotations and buy-sell linkage.
    let globalRealizedPnL = 0;
    let globalRealizedAssetPnL = 0;
    const costLots = []; // [{qty, unitCost}]
    for (const fill of allFills) {
      if (fill.side === 'buy') {
        const cost = fill.quoteAmount + fill.netFee;
        costLots.push({ qty: fill.size, unitCost: fill.size > 0 ? cost / fill.size : 0 });
      } else if (fill.side === 'sell') {
        const proceeds = fill.quoteAmount - fill.netFee;
        let remain = fill.size;
        let costBasis = 0;
        while (remain > 1e-12 && costLots.length > 0) {
          const lot = costLots[0];
          const use = Math.min(remain, lot.qty);
          costBasis += use * lot.unitCost;
          lot.qty -= use;
          remain -= use;
          if (lot.qty <= 1e-12) costLots.shift();
        }
        globalRealizedPnL += proceeds - costBasis;
      }
    }
    // Remaining lots = unsold position (holdback reserves + active position)
    globalRealizedAssetPnL = roundAsset(costLots.reduce((s, l) => s + l.qty, 0));
    globalRealizedPnL = roundUSDC(globalRealizedPnL);
    globalRealizedAssetPnL = roundAsset(globalRealizedAssetPnL);

    for (const { cycleId, fills: cycleFills } of completedCycles) {
      const { cycleDetail, pnl, holdbackAsset } = computeCycleStats(cycleId, cycleFills);
      cycleDetails.push(cycleDetail);
      totalRealizedPnL += pnl;
      totalRealizedAssetPnL += holdbackAsset;
    }

    // Assign the remaining orphan fills to recovered cycles by buy-sell
    // pattern: a sell ends a cycle, the next buy starts a new cycle.
    const hadCurrentCycle = Boolean(currentCycleId);
    const orphanCycles = splitOrphansIntoCycles(orphanFills);
    if (orphanCycles.length > 0) {
      logger.info(`🔧 [${exchange}] Split ${orphanFills.length} orphan fills into ${orphanCycles.length} cycles`, {
        orphanFillCount: orphanFills.length,
        orphanCycleCount: orphanCycles.length,
      });

      // Assign cycle IDs and calculate P&L for completed orphan cycles
      for (const { cycleId, fills: cycleFills } of orphanCycles) {
        // Assign cycle ID to all fills in this cycle
        if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
        for (const fill of cycleFills) {
          fill.cycleId = cycleId;
          fills.set(fill.tradeId, fill);
          cycleIndex.get(cycleId).add(fill.tradeId);
          orphansFixed++;
          dirtySinceLastPersist = true;
          bumpLedgerVersion();
        }

        // Check if this is a completed cycle. An incomplete orphan group stays
        // in its own recovered cycle — sync-fills / manual-trade-import
        // null-stamp historical fills on purpose (#108) — and must NEVER
        // displace the engine's live cycle (#675).
        if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
          const { cycleDetail, pnl, holdbackAsset } = computeCycleStats(cycleId, cycleFills);
          cycleDetails.push(cycleDetail);
          totalRealizedPnL += pnl;
          totalRealizedAssetPnL += holdbackAsset;
          completedCycles.push({ cycleId, fills: cycleFills });
        } else if (!hadCurrentCycle) {
          // No live cycle to preserve — adopt the latest incomplete orphan group.
          currentCycleId = cycleId;
          currentCycleStartedAt = null;
        }
      }

      const completedCycleCount = orphanCycles.filter(c => c.fills.some(f => f.side === 'sell')).length;
      logger.info(`🔧 [${exchange}] Assigned ${orphanFills.length} orphan fills to recovered cycles, found ${completedCycleCount} completed cycles`, {
        orphansFixed,
        completedCycleCount,
      });
    }

    // Renumber cycles only when orphan fills created new (recovered) cycle
    // IDs that need sequential numbering. Attributing orphans into existing
    // cycles creates no new IDs, so it keeps IDs stable.
    const cycleIdMap = {};
    if (orphanCycles.length > 0) {
      const cycleTimestamps = collectCycleTimestamps(cycleMap, orphanCycles);
      const completedIds = new Set(cycleDetails.map(d => d.cycleId));
      const { idMap, nextCycleNumber: cycleNum, renumbered } = buildCycleRenumberingMap(cycleTimestamps, completedIds, currentCycleId);
      for (const [oldId, newId] of idMap) {
        if (oldId !== newId) cycleIdMap[oldId] = newId;
      }

      if (renumbered > 0) {
        cycleIndex.clear();
        for (const fill of Array.from(fills.values())) {
          if (fill.cycleId && idMap.has(fill.cycleId)) {
            fill.cycleId = idMap.get(fill.cycleId);
            fills.set(fill.tradeId, fill);
            dirtySinceLastPersist = true;
            bumpLedgerVersion();
          }
          if (fill.cycleId) {
            if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
            cycleIndex.get(fill.cycleId).add(fill.tradeId);
          }
        }
        for (const detail of cycleDetails) {
          if (idMap.has(detail.cycleId)) detail.cycleId = idMap.get(detail.cycleId);
        }
        if (currentCycleId && idMap.has(currentCycleId)) {
          currentCycleId = idMap.get(currentCycleId);
        }
        logger.info(`🔢 [${exchange}] Renumbered ${renumbered} cycles to sequential IDs (cycle-1 through cycle-${cycleNum - 1})`, {
          renumbered,
          firstCycleId: 'cycle-1',
          lastCycleId: `cycle-${cycleNum - 1}`,
        });
      }
      nextCycleNumber = cycleNum;
    }

    // Auto-link buys to sells within completed cycles only (fixes orphaned buys display).
    // Skip active cycles to avoid linking unsold buys to early partial sells.
    //
    // This is legacy-core-only (#677): body/satellite buy linkage is owned by
    // TP placement (regime-engine.js) and boot annotation, not this heuristic.
    // In celestial mode a cycle can hold many bodies and is marked "completed"
    // once the sell ratio crosses CYCLE_COMPLETE_SELL_RATIO while other bodies
    // in the SAME cycle are still open with no TP placed yet (their buy has no
    // sellOrderId for a legitimate reason, not a crash to repair). Stamping
    // those open buys with an unrelated body's sell falsely closes them and
    // zeroes their heldOpenBuyCostBasis. Also never auto-link inside the
    // ledger's current (still-live) cycle — a body there may not even have
    // attempted its TP placement yet.
    let linkedCount = 0;
    const completedCycleIds = new Set(cycleDetails.map(d => d.cycleId));
    const cycleSellIds = new Map(); // cycleId -> first LEGACY (non-body/satellite) sell orderId
    for (const fill of fills.values()) {
      if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;
      if (fill.side === 'sell' && fill.cycleId && completedCycleIds.has(fill.cycleId) && !cycleSellIds.has(fill.cycleId)) {
        cycleSellIds.set(fill.cycleId, fill.orderId);
      }
    }
    for (const fill of fills.values()) {
      if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;
      if (fill.cycleId && fill.cycleId === currentCycleId) continue;
      // A buy folded in by timestamp alone (#705) was never part of the core
      // position the cycle's TP sold — stamping it would book its cost as
      // consumed by that sell (realized P&L / reserves / closed-trades).
      if (fill.cycleAttribution === 'timeframe') continue;
      if (fill.side === 'buy' && fill.cycleId && !fill.sellOrderId && completedCycleIds.has(fill.cycleId)) {
        const sellId = cycleSellIds.get(fill.cycleId);
        if (sellId) {
          fill.sellOrderId = sellId;
          linkedCount++;
          dirtySinceLastPersist = true;
          bumpLedgerVersion();
        }
      }
    }
    if (linkedCount > 0) {
      logger.info(`🔗 [${exchange}] Linked ${linkedCount} buys to their cycle sells`, {
        linkedCount,
      });
    }

    if (orphansFixed > 0 || linkedCount > 0) {
      persist();
    }

    return {
      cyclesCompleted: cycleDetails.length,
      realizedPnL: roundUSDC(totalRealizedPnL),
      realizedAssetPnL: roundAsset(totalRealizedAssetPnL),
      globalRealizedPnL: roundUSDC(globalRealizedPnL),
      globalRealizedAssetPnL: roundAsset(globalRealizedAssetPnL),
      cycleDetails,
      orphansFixed,
      // Orphans placed into existing cycles / into the live cycle (#705).
      // A non-zero live count changes live-cycle membership: callers must
      // resync their position counters (cycleBuys, totals) from the ledger.
      orphansAttributed: attributed.length,
      liveCycleOrphansAttributed,
      activeCycleId: currentCycleId,
      // old → new cycle ID for every cycle the renumbering renamed. Callers
      // holding a durable cycle ID (positionState.activeCycleId) must re-point
      // it through this map, or the next restart restores a stale name (#675).
      idMap: cycleIdMap,
    };
  };

  /**
   * Read-only sibling of recalculateCycles (issue #132). Computes the SAME
   * cycleDetails / orphansFixed / activeCycleId WITHOUT mutating any ledger
   * state — it never assigns cycleIds to fills, touches cycleIndex /
   * currentCycleId / nextCycleNumber, sets the dirty flag, or persists. This
   * lets the running-engine recalculate PREVIEW show full per-cycle detail and
   * the orphan-fix count without risking the engine's periodic save persisting
   * a recalc the operator may cancel.
   *
   * The P&L numbers (realizedPnL/realizedAssetPnL) intentionally come from the
   * cycle-pair source of truth (getDerivedRealizedPnL) — recalculateCycles' own
   * avgCost-prorated totals are diagnostic. Here we surface cycleDetails and
   * the orphan-fix count so the UI can render them.
   *
   * @returns {{cyclesCompleted: number, cycleDetails: Array, orphansFixed: number, orphansAttributed: number, liveCycleOrphansAttributed: number, activeCycleId: string|null, idMap: Object<string, string>}}
   */
  const previewRecalculateCycles = () => {
    const allFills = Array.from(fills.values()).sort((a, b) => a.timestamp - b.timestamp);

    // Group by cycleId; collect orphans (cycleId: null) separately.
    const { cycleMap, orphanFills: allOrphanFills } = groupFillsByCycle(allFills);

    // Same attribution as recalculateCycles (#705), applied to the local
    // grouping only — fills are never stamped — and BEFORE completion is
    // evaluated so preview and apply agree on which cycles completed.
    const {
      attributed,
      remaining: orphanFills,
      liveCount: liveCycleOrphansAttributed,
    } = attributeOrphansIntoCycleMap(cycleMap, allOrphanFills);

    const cycleDetails = [];
    for (const [cycleId, cycleFills] of cycleMap) {
      if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
        cycleDetails.push(computeCycleStats(cycleId, cycleFills).cycleDetail);
      }
    }

    // Replay orphan placement WITHOUT mutating fills — count how many would be
    // assigned and which would-be cycles complete vs become the active cycle.
    let orphansFixed = attributed.length;
    let previewActiveCycleId = currentCycleId;
    const hadCurrentCycle = Boolean(currentCycleId);
    const orphanCycles = splitOrphansIntoCycles(orphanFills);
    if (orphanCycles.length > 0) {
      for (const { cycleId, fills: cycleFills } of orphanCycles) {
        orphansFixed += cycleFills.length;
        if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
          cycleDetails.push(computeCycleStats(cycleId, cycleFills).cycleDetail);
        } else if (!hadCurrentCycle) {
          // Same rule as recalculateCycles: an orphan group only becomes the
          // active cycle when there is no live cycle to preserve (#675).
          previewActiveCycleId = cycleId;
        }
      }
    }

    // Renumber preview cycle IDs if orphan fills created new cycle IDs,
    // mirroring the renumbering in recalculateCycles without mutating fills.
    const cycleIdMap = {};
    if (orphanCycles.length > 0) {
      const cycleTimestamps = collectCycleTimestamps(cycleMap, orphanCycles);
      const completedIds = new Set(cycleDetails.map(d => d.cycleId));
      const { idMap } = buildCycleRenumberingMap(cycleTimestamps, completedIds, previewActiveCycleId);
      for (const [oldId, newId] of idMap) {
        if (oldId !== newId) cycleIdMap[oldId] = newId;
      }

      for (const detail of cycleDetails) {
        if (idMap.has(detail.cycleId)) detail.cycleId = idMap.get(detail.cycleId);
      }
      if (previewActiveCycleId && idMap.has(previewActiveCycleId)) {
        previewActiveCycleId = idMap.get(previewActiveCycleId);
      }
    }

    return {
      cyclesCompleted: cycleDetails.length,
      cycleDetails,
      orphansFixed,
      orphansAttributed: attributed.length,
      liveCycleOrphansAttributed,
      activeCycleId: previewActiveCycleId,
      idMap: cycleIdMap,
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
   */
  const annotateFillsByOrderIds = (orderIds, metadata) => {
    const ids = new Set(orderIds);
    let matched = false;
    for (const [, fill] of fills) {
      if (ids.has(fill.orderId)) {
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

  /**
   * Consumption state of one buy order, aggregated over its fill rows.
   * `consumedBy` maps sellOrderId → base quantity of this order that sell
   * consumed (sold + booked holdback). Rows ingested after a consumption was
   * recorded carry no map, so the maps are unioned across rows; every row
   * that has one carries the same keys/values.
   * @param {string} orderId - Buy order id
   * @returns {{size: number, cost: number, consumedBy: Object<string, number>|null, consumedQty: number|undefined, consumedCostFraction: number|undefined}|null}
   *   null when the ledger holds no buy fills for the order
   */
  const getBuyOrderConsumption = (orderId) => {
    let size = 0;
    let cost = 0;
    let consumedBy = null;
    let consumedCostFraction;
    let found = false;
    for (const f of fills.values()) {
      if (f.orderId !== orderId || f.side !== 'buy') continue;
      found = true;
      size += f.size || 0;
      cost += (f.quoteAmount || 0) + (f.netFee || 0);
      if (f.consumedBy && typeof f.consumedBy === 'object') consumedBy = { ...(consumedBy || {}), ...f.consumedBy };
      if (f.consumedCostFraction != null) consumedCostFraction = f.consumedCostFraction;
    }
    if (!found) return null;
    const consumedQty = consumedBy ? sumConsumedBy(consumedBy) : undefined;
    return { size, cost, consumedBy, consumedQty, consumedCostFraction };
  };

  /**
   * Record that sell `sellOrderId` consumed `qty` of buy order `buyOrderId`
   * (issue #607). This is the consumption record `sellOrderId` never was: a
   * buy order can be PARTLY closed, and computeRealizedFromCyclePairs holds
   * `size − Σ consumedBy` of it open instead of deciding closure on a boolean.
   *
   * Keyed by sell order, so re-booking the same sell (crash replay) overwrites
   * its own entry rather than consuming the buy twice. `legacySeedQty` is what
   * sells recorded before this field existed had already consumed; it seeds
   * the map only the first time a consumption is recorded for the order.
   * @param {string} buyOrderId
   * @param {string} sellOrderId
   * @param {number} qty - Base quantity this sell consumed from the order
   * @param {number} [legacySeedQty=0]
   * @returns {boolean} false when the ledger holds no buy fills for the order
   */
  const recordBuyConsumption = (buyOrderId, sellOrderId, qty, legacySeedQty = 0) => {
    if (!buyOrderId || !sellOrderId || !Number.isFinite(qty)) return false;
    const existing = getBuyOrderConsumption(buyOrderId);
    if (!existing) return false;
    const consumedBy = { ...(existing.consumedBy || {}) };
    if (!existing.consumedBy && legacySeedQty > 0) consumedBy[LEGACY_CONSUMPTION_KEY] = roundAsset(legacySeedQty);
    consumedBy[sellOrderId] = roundAsset(Math.max(0, qty));
    for (const f of fills.values()) {
      if (f.orderId === buyOrderId && f.side === 'buy') f.consumedBy = { ...consumedBy };
    }
    dirtySinceLastPersist = true;
    bumpLedgerVersion();
    return true;
  };

  /**
   * One-time seal of legacy closure (issue #607). A buy order no sell has
   * recorded consumption against, whose sellOrderId names a sell WITH fills,
   * is "closed" under the legacy boolean rule. That linkage is fragile: the
   * next TP placed for a later tranche of the same order re-stamps
   * sellOrderId on every row, and the quantity already sold under the old
   * link would resurface as open. Sealing records what the legacy rule
   * treated as closed as `consumedBy.__legacy__` while the link still says so:
   * the order's size minus what live body tranches still hold open.
   *
   * Idempotent: orders that already carry a consumedBy record are skipped.
   * @param {Map<string, number>} openQtyByOrder - orderId → open qty held by live tranches
   * @param {Set<string>} [skipOrderIds] - orders whose open qty is unknown; left unsealed
   * @returns {number} buy orders sealed
   */
  const sealLegacyClosedBuys = (openQtyByOrder = new Map(), skipOrderIds = new Set()) => {
    const sellOrderIdsWithFills = new Set();
    for (const f of fills.values()) if (f.side === 'sell' && f.orderId) sellOrderIdsWithFills.add(f.orderId);
    const byOrder = new Map();
    for (const f of fills.values()) {
      if (f.side !== 'buy' || !f.orderId) continue;
      const agg = byOrder.get(f.orderId) || { size: 0, rows: [], hasRecord: false, legacyClosed: false };
      agg.size += f.size || 0;
      agg.rows.push(f);
      if (f.consumedBy && typeof f.consumedBy === 'object') agg.hasRecord = true;
      if (f.sellOrderId && sellOrderIdsWithFills.has(f.sellOrderId)) agg.legacyClosed = true;
      byOrder.set(f.orderId, agg);
    }
    let sealed = 0;
    for (const [orderId, agg] of byOrder) {
      if (agg.hasRecord || !agg.legacyClosed || skipOrderIds.has(orderId)) continue;
      const seed = roundAsset(Math.max(0, agg.size - (openQtyByOrder.get(orderId) || 0)));
      for (const f of agg.rows) f.consumedBy = { [LEGACY_CONSUMPTION_KEY]: seed };
      sealed += 1;
    }
    if (sealed > 0) {
      dirtySinceLastPersist = true;
      bumpLedgerVersion();
    }
    return sealed;
  };

  /**
   * Idempotency guard for capital-growth credit (issue #210-B). Capital growth
   * (config.maxUsdcDeployed += pnl) is a non-idempotent config.json write that
   * happens mid-fill, before the fill-processed state is saved — so a crash
   * before saveLiveState lets the offline replay re-apply the same pnl. This
   * stamps the sell order's fills `capitalCredited` and persists BEFORE the
   * caller writes config, so a replay of the same sellOrderId is refused. The
   * mark-first ordering makes the only crash window a conservative under-credit
   * (never an inflated budget cap).
   * @param {string} orderId - Sell order id whose pnl is about to be credited
   * @returns {boolean} true if the caller should apply the credit; false if it
   *   was already credited on a prior (pre-crash) run.
   */
  const claimCapitalCredit = (orderId) => {
    if (!orderId) return true;
    let matched = false;
    let alreadyCredited = false;
    for (const [, fill] of fills) {
      if (fill.orderId === orderId) {
        matched = true;
        if (fill.capitalCredited) alreadyCredited = true;
        fill.capitalCredited = true;
        dirtySinceLastPersist = true;
      }
    }
    if (matched) bumpLedgerVersion();
    if (alreadyCredited) return false;
    if (matched) persist();
    return true;
  };

  /**
   * Source-of-truth derivation: walk the ledger by buy↔sell pairing and sum
   * per-cycle outcomes. The engine's contract is buy(n)→sell(1) per cycle:
   * every buy gets a sellOrderId stamp when its TP is *placed* (for
   * crash-resilient linkage); the buy only counts as closed once that sell
   * order has fills in this ledger.
   *
   * Pairing and per-sell pnl/holdback are shared/cycle-pairing.mjs
   * (pairCycleFills) — the same rules the dashboard's Filled Orders view uses
   * (issue #697):
   *   - Annotated sells: bodyPnl/satellitePnl, taken once per orderId. The
   *     engine prorates body cost basis when a TP sells less than full body
   *     content, so the annotation reflects the prorated calc.
   *   - Other sells: proceeds − linked buy cost × min(1, sold / linked size).
   *   - Buys pair by sellOrderId; an orphaned sellOrderId (re-placed TP) is
   *     redirected via bodyId to that body's latest filled sell.
   *
   *   realizedPnL          = Σ per-sell pnl
   *   realizedAssetPnL     = Σ holdback per sell (server annotation when present,
   *                          else max(0, Σ paired_buy_size − sell_size))
   *   heldOpenBuyCostBasis = per buy order:
   *                          - with a `consumedBy` record (issue #607):
   *                            cost × (size − Σ consumedBy) / size — the
   *                            unsold remainder of a partly-sold order stays held
   *                          - otherwise (legacy): full cost × (1 − consumedCostFraction)
   *                            when sellOrderId is absent or has no sell fills yet,
   *                            unless the pairing redirected it onto an unannotated
   *                            sell (its cost is then already in realizedPnL)
   *   heldOpenAssetQty     = the same, in base quantity
   *   ledgerNetAsset       = Σ buy size − Σ sell size over the whole ledger
   *
   * Every body sale records sold + booked holdback as consumed, so wherever
   * sells were booked with `consumedBy` records,
   * `ledgerNetAsset == heldOpenAssetQty + realizedAssetPnL` holds by
   * construction — the position-coverage identity, from the ledger alone.
   * Legacy boolean closure is what can break it (a partly-sold order read as
   * fully closed).
   *
   * Reserves (realizedAssetPnL) are treated as zero-cost: the cost was already
   * attributed to the paired sell's basis.
   *
   * Side-effect-free — safe to call on every status emit and state save.
   * @returns {{realizedPnL: number, realizedAssetPnL: number, heldOpenBuyCostBasis: number, heldOpenAssetQty: number, ledgerNetAsset: number, unpairedSellQty: number}}
   */
  const computeRealizedFromCyclePairsUncached = () => {
    // Pairing and per-sell pnl/holdback come from the shared rule set the
    // dashboard's Filled Orders rows also use (issue #697), so the Position
    // card and the Filled Orders grand total can never disagree.
    const pairing = pairCycleFills(fills.values());

    // Held-open cost is a ledger-only concern: aggregate buys per order
    // (keyed the same way as the pairing — tradeId for no-orderId rows, #108)
    // with their consumption records.
    const buyAggByOrderId = new Map();
    let ledgerNetAsset = 0;
    for (const f of fills.values()) {
      if (f.side === 'buy') {
        const aggKey = buyPairKey(f);
        const ex = buyAggByOrderId.get(aggKey);
        if (ex) {
          ex.size += f.size || 0;
          ex.cost += (f.quoteAmount || 0) + (f.netFee || 0);
          if (f.sellOrderId && !ex.sellOrderId) ex.sellOrderId = f.sellOrderId;
          // consumedCostFraction is annotated identically on every row of the
          // orderId (like bodyPnl) — take the latest non-null, not summed.
          if (f.consumedCostFraction != null) ex.consumedCostFraction = f.consumedCostFraction;
          // consumedBy is written to every row that existed when a sell was
          // booked; later-ingested rows of the same order carry none. Union.
          if (f.consumedBy && typeof f.consumedBy === 'object') ex.consumedBy = { ...(ex.consumedBy || {}), ...f.consumedBy };
        } else {
          buyAggByOrderId.set(aggKey, {
            size: f.size || 0,
            cost: (f.quoteAmount || 0) + (f.netFee || 0),
            sellOrderId: f.sellOrderId || null,
            consumedCostFraction: f.consumedCostFraction ?? 0,
            consumedBy: f.consumedBy && typeof f.consumedBy === 'object' ? { ...f.consumedBy } : null,
          });
        }
        ledgerNetAsset += f.size || 0;
      } else if (f.side === 'sell') {
        ledgerNetAsset -= f.size || 0;
      }
    }

    // sellOrderId is stamped at TP *placement* (crash-resilient buy→sell
    // linkage), not at fill — so a stamp alone doesn't mean the buy closed.
    // A buy is still open until its linked sell order has actual sell fills
    // in this ledger. Without this check every buy in an active body counts
    // as closed the moment its TP rests, zeroing heldOpenBuyCostBasis.
    let heldOpenBuyCostBasis = 0;
    let heldOpenAssetQty = 0;
    for (const [aggKey, buy] of buyAggByOrderId) {
      if (buy.consumedBy && Object.keys(buy.consumedBy).length > 0) {
        // Quantity-aware closure (issue #607). Sells record what they consumed
        // from each buy order, so a buy order can be PARTLY closed: its unsold
        // remainder stays held at its own pro-rata cost. sellOrderId plays no
        // part in closure here — it is a crash-resilience breadcrumb that is
        // re-stamped across merges and TP replacements, and a partly-sold
        // order carries it just like a fully-sold one.
        const consumed = Math.min(sumConsumedBy(buy.consumedBy), buy.size);
        const openQty = Math.max(0, buy.size - consumed);
        if (buy.size > 0) heldOpenBuyCostBasis += buy.cost * (openQty / buy.size);
        heldOpenAssetQty += openQty;
        continue;
      }
      const hasSellFills = !!buy.sellOrderId && pairing.sells.has(buy.sellOrderId);
      if (hasSellFills) continue;
      // A buy whose stamped TP id never filled but that the pairing redirected
      // (via bodyId) to an UNANNOTATED sell had its cost charged to that sell's
      // realized pnl — sold share as cost, the rest booked as holdback. Holding
      // it open too would count its cost twice. Redirects onto annotated sells
      // never priced this buy (e.g. a partial TP whose buys were re-linked to a
      // still-resting TP), so those keep the legacy rule below.
      const pairedSellOrderId = pairing.buys.get(aggKey)?.pairedSellOrderId;
      if (pairedSellOrderId && !pairing.sells.get(pairedSellOrderId)?.hasPnlAnnotation) continue;
      // Legacy boolean closure for buy orders no sell has recorded
      // consumption against (pre-#607 history, or a body whose tranches
      // could not account for its quantity): open until the linked sell
      // order has fills.
      // Held cost = the buy's cost MINUS the fraction already realized via
      // prior partial body-TP fills (issue #128). On a partial body-TP fill
      // the engine re-links the buy to a fresh resting TP and stamps
      // consumedCostFraction = realized-so-far / original. Counting the full
      // cost as held while that sold tranche's prorated cost is already in
      // realizedPnL (via bodyPnl) double-counts it, transiently understating
      // total return until the residual TP fills. Subtracting the consumed
      // fraction holds only the genuinely-open remainder.
      const consumed = buy.consumedCostFraction > 0 ? Math.min(buy.consumedCostFraction, 1) : 0;
      heldOpenBuyCostBasis += buy.cost * (1 - consumed);
      heldOpenAssetQty += buy.size * (1 - consumed);
    }

    return {
      realizedPnL: roundUSDC(pairing.realizedPnL),
      realizedAssetPnL: roundAsset(pairing.realizedAssetPnL),
      heldOpenBuyCostBasis: roundUSDC(heldOpenBuyCostBasis),
      heldOpenAssetQty: roundAsset(heldOpenAssetQty),
      ledgerNetAsset: roundAsset(ledgerNetAsset),
      unpairedSellQty: roundAsset(pairing.unpairedSellQty),
    };
  };

  // Memoization for computeRealizedFromCyclePairsUncached (issue #365). The
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
    const result = computeRealizedFromCyclePairsUncached();
    realizedRecomputeCount += 1;
    cachedRealized = { version: ledgerVersion, result };
    return { ...result };
  };

  /**
   * FIFO replay. Diagnostic only — not the source of truth.
   * Uncovered-sell handling: only the covered portion contributes to
   * realizedPnL; `remainingAssetQty` uses `total_buys − total_sells`.
   * @returns {{realizedPnL: number, remainingAssetQty: number, uncoveredSellQty: number, remainingLotCost: number, remainingLotQty: number}}
   */
  const computeFifoRealized = () => {
    const allFills = Array.from(fills.values()).sort((a, b) => a.timestamp - b.timestamp);
    let realizedPnL = 0;
    let totalBuyQty = 0;
    let totalSellQty = 0;
    let uncoveredSellQty = 0;
    const costLots = [];
    for (const fill of allFills) {
      if (fill.side === 'buy') {
        totalBuyQty += fill.size || 0;
        const cost = fill.quoteAmount + (fill.netFee || 0);
        costLots.push({ qty: fill.size, unitCost: fill.size > 0 ? cost / fill.size : 0 });
      } else if (fill.side === 'sell') {
        const sellQty = fill.size || 0;
        totalSellQty += sellQty;
        const proceeds = fill.quoteAmount - (fill.netFee || 0);
        let remain = sellQty;
        let costBasis = 0;
        while (remain > 1e-12 && costLots.length > 0) {
          const lot = costLots[0];
          const use = Math.min(remain, lot.qty);
          costBasis += use * lot.unitCost;
          lot.qty -= use;
          remain -= use;
          if (lot.qty <= 1e-12) costLots.shift();
        }
        // Count only the covered portion's proceeds — uncovered means the bot
        // didn't own that asset at sell time, so no profit to claim.
        const coveredQty = sellQty - remain;
        const adjustedProceeds = sellQty > 0 ? proceeds * (coveredQty / sellQty) : 0;
        realizedPnL += adjustedProceeds - costBasis;
        if (remain > 1e-9) uncoveredSellQty += remain;
      }
    }
    const remainingLotCost = costLots.reduce((s, l) => s + (l.qty * l.unitCost), 0);
    const remainingLotQty = costLots.reduce((s, l) => s + l.qty, 0);
    return {
      realizedPnL: roundUSDC(realizedPnL),
      remainingAssetQty: roundAsset(totalBuyQty - totalSellQty),
      uncoveredSellQty: roundAsset(uncoveredSellQty),
      // FIFO cost basis of the remaining (unsold) buy lots. Useful for
      // unrealized P&L: held_qty × current_price − remainingLotCost.
      // Note: when uncoveredSellQty > 0, remainingLotQty > true held qty
      // because uncovered sells didn't reduce lots. Callers should prefer
      // remainingAssetQty (the conservative buys−sells number) for qty.
      remainingLotCost: roundUSDC(remainingLotCost),
      remainingLotQty: roundAsset(remainingLotQty),
    };
  };

  /**
   * Source-of-truth derivation for position.realizedPnL and realizedAssetPnL.
   * @returns {{realizedPnL: number, realizedAssetPnL: number, unpairedSellQty: number, heldOpenBuyCostBasis: number, heldOpenAssetQty: number, ledgerNetAsset: number}}
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
      if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId) {
        uniqueBuyOrders.add(fill.orderId);
      }
    }
    return uniqueBuyOrders.size;
  };

  /**
   * Count unique buy ORDERS in the current cycle regardless of body ownership.
   * In celestial mode every engine buy is body-owned, so getCurrentCycleBuysCount
   * (which excludes body-owned buys) returns 0 and silently zeroes the restored
   * cycleBuys counter. This matches the live commitBuyCounter, which increments
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
    claimCapitalCredit,
    persist,
    /** Mark the in-memory ledger as dirty so the next persist() actually
     * writes to disk. Restricted contract: callers MUST limit mutations
     * to METADATA-ONLY fields that do not feed any derived index — i.e.
     * NOT tradeId, orderId, cycleId, or size. The orderSizeIndex (keyed
     * by orderId, summed by size) and cycleIndex (keyed by cycleId) are
     * not refreshed here; mutating an indexed field via this path would
     * persist new values to disk while in-memory lookups continued to
     * return stale results until the next reload. dca-converter.js uses
     * this only for the sellOrderId annotation, which is metadata. For
     * indexed-field changes use the dedicated mutators
     * (annotateFillsByOrderId, updateFillCycleId). */
    markDirty: () => { dirtySinceLastPersist = true; bumpLedgerVersion(); },
    load,
    // Test-only handle: returns the number of times persist() actually
    // wrote to disk (skipping the no-op short-circuit). Lets tests
    // assert "no-op when clean" without relying on filesystem mtime,
    // which has variable granularity across CI runners.
    _test: {
      getWriteCount: () => writeCount,
      getLedgerVersion: () => ledgerVersion,
      getRealizedRecomputeCount: () => realizedRecomputeCount,
      getFillTimeStatsRecomputeCount: () => fillTimeStatsRecomputeCount,
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
  getCachedFillLedger,
  getFillLedgerPath,
  CYCLE_COMPLETE_SELL_RATIO,
  isCompletedCycle,
  splitOrphansIntoCycles,
  attributeOrphanFills,
  groupFillsByCycle,
  collectCycleTimestamps,
  buildCycleRenumberingMap,
  setCycleCompleteSellRatioForTest,
};

Object.defineProperty(module.exports, 'CYCLE_COMPLETE_SELL_RATIO', {
  get: () => CYCLE_COMPLETE_SELL_RATIO,
  set: (val) => { CYCLE_COMPLETE_SELL_RATIO = val; },
  configurable: true,
  enumerable: true,
});

