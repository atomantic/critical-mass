// @ts-check
/**
 * Fill ledger cycle recalculation — the pure planning half (issue #1335).
 *
 * `recalculateCycles` (operator-triggered repair) and
 * `previewRecalculateCycles` (its read-only preview) both run
 * `planCycleRecalculation` below: group fills by cycle, attribute orphan
 * fills to existing cycles (#705), derive the annotation patches attributed
 * rows inherit (#752), classify completed vs active cycles, split the
 * remaining orphans into recovered cycles, and renumber (#675). The planner
 * never mutates a fill or any ledger state, so preview and apply cannot
 * disagree. `fill-ledger-cycle-application.js` applies the plan to the
 * ledger's state, runs the legacy auto-link and persists.
 *
 * Accounting-adjacent: cycle ids feed `computeRealizedFromCyclePairs`. Read
 * the P&L model in CLAUDE.md before changing anything here.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
const { isBodyOwnedFill } = require('../shared/cycle-pairing.mjs');

/**
 * @typedef {import('./types').Fill} Fill
 */

/**
 * `consumedBy` key for consumption that sells recorded before per-order
 * consumption tracking existed (issue #607) had already taken from a buy.
 * Defined here because orphan linkage skips it; `fill-ledger.js` imports and
 * re-exports it.
 */
const LEGACY_CONSUMPTION_KEY = '__legacy__';

/**
 * Sell-ratio completion threshold: a cycle is completed when total sells cover
 * at least this fraction of bought asset volume (body TP sells, core TP sells,
 * or any combination).
 */
const CYCLE_COMPLETE_SELL_RATIO = 0.5;

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
 * Order-level annotations: written per orderId (annotateFillsByOrderId), so
 * every partial row of one order carries the same values. A recovered row of
 * an annotated order inherits them from a sibling row (#705 buys, #752 sells).
 * Taking a sell's P&L annotation once per orderId (shared/cycle-pairing.mjs)
 * is what makes copying it onto another row of the same order safe.
 */
const ORDER_LEVEL_FIELDS = {
  buy: ['isBodyOwned', 'bodyId', 'bodyTier', 'isSatellite', 'sellOrderId', 'consumedBy', 'consumedCostFraction'],
  sell: [
    'isBodyOwned', 'bodyId', 'bodyTier', 'isSatellite',
    'bodyCostBasis', 'bodyAvgPrice', 'bodyBtcQty', 'bodyHoldbackAsset', 'bodyReservesSoldAsset', 'bodyPnl', 'bodyBookedSize',
    'satellitePnl', 'satelliteHoldbackAsset', 'sellCorrectionPnlRemainder', 'partialFill', 'mergeSnapshot', 'untrackedSell',
  ],
};

/**
 * Annotation patches for fills attributeOrphanFills placed into existing
 * cycles (issues #705, #752). Pure — returns patches, never mutates — so
 * recalculateCycles (applies them) and previewRecalculateCycles (evaluates
 * patched copies) agree.
 *
 *   1. A row whose order already has rows in the target cycle copies that
 *      sibling's order-level fields it lacks (buy AND sell rows — a body TP
 *      sell row that sync-fills re-imported keeps its bodyPnl /
 *      bodyHoldbackAsset / ownership, instead of reading as a legacy sell).
 *   2. A sell with no sibling row, placed by buy→sell linkage, inherits
 *      OWNERSHIP only (isBodyOwned / bodyId / bodyTier / isSatellite) from the
 *      buys that link to it, when every such buy is owned by the same body.
 *      Its P&L is then priced by cycle pairing's linked-cost proration — the
 *      same numbers the source of truth already derives for it. A sell linked
 *      from any core buy (or from several bodies) is left alone.
 *
 * Without this an attributed body sell reads as a legacy core sell: it
 * enters core position rebuilds and computeCycleStats, and auto-link can
 * stamp unrelated core buys with it.
 *
 * @param {Array<{fill: Fill, cycleId: string}>} attributed
 * @param {Map<string, Fill[]>} cycleMap - Already holds the attributed fills
 * @returns {Map<Fill, Object>} fill → fields to assign
 */
const deriveAttributedAnnotations = (attributed, cycleMap) => {
  /** @type {Map<Fill, Object>} */
  const patches = new Map();
  if (!attributed || attributed.length === 0) return patches;
  const attributedFills = new Set(attributed.map(a => a.fill));

  // 1. Sibling copy.
  for (const { fill, cycleId } of attributed) {
    const fields = ORDER_LEVEL_FIELDS[fill.side];
    if (!fields || !fill.orderId) continue;
    const sibling = (cycleMap.get(cycleId) || []).find(f =>
      f !== fill && !attributedFills.has(f) && f.orderId === fill.orderId && f.side === fill.side);
    if (!sibling) continue;
    const patch = {};
    for (const field of fields) {
      if (sibling[field] !== undefined && fill[field] === undefined) {
        patch[field] = field === 'consumedBy' ? { ...sibling[field] } : sibling[field];
      }
    }
    if (Object.keys(patch).length > 0) patches.set(fill, patch);
  }

  // 2. Linked-buy ownership for sibling-less sells (sees step-1 patches).
  const view = (f) => (patches.has(f) ? { ...f, ...patches.get(f) } : f);
  for (const { fill, cycleId } of attributed) {
    if (fill.side !== 'sell' || !fill.orderId || patches.has(fill) || isBodyOwnedFill(fill)) continue;
    const cycleFills = cycleMap.get(cycleId) || [];
    if (cycleFills.some(f => !attributedFills.has(f) && f.orderId === fill.orderId && f.side === 'sell')) continue;
    const linkedBuys = cycleFills.map(view).filter(f => f.side === 'buy' && (
      f.sellOrderId === fill.orderId
      || (f.consumedBy && typeof f.consumedBy === 'object'
        && Object.prototype.hasOwnProperty.call(f.consumedBy, fill.orderId))
    ));
    if (linkedBuys.length === 0 || !linkedBuys.every(isBodyOwnedFill)) continue;
    const bodyIds = new Set(linkedBuys.map(f => f.bodyId || null));
    if (bodyIds.size !== 1) continue;
    const [bodyId] = bodyIds;
    const tiers = new Set(linkedBuys.map(f => f.bodyTier).filter(Boolean));
    const patch = { isBodyOwned: true };
    if (bodyId) patch.bodyId = bodyId;
    if (tiers.size === 1) patch.bodyTier = [...tiers][0];
    if (linkedBuys.every(f => f.isSatellite)) patch.isSatellite = true;
    patches.set(fill, patch);
  }
  return patches;
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
    if (isBodyOwnedFill(fill)) continue;

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
 * Earliest timestamp that belongs to the live cycle (issue #705): the
 * persisted start time when known; otherwise (legacy state / inferred
 * cycle) the earliest fill already stamped into the live cycle. Null
 * when neither is known — an empty cycle restored without a start time has
 * no safe boundary, so nothing is folded into it by timestamp.
 * @param {Map<string, Fill[]>} cycleMap
 * @param {string|null} liveCycleId
 * @param {number|null} liveCycleStartedAt - Persisted start time of the live cycle
 * @returns {number|null}
 */
const resolveLiveCycleStartTs = (cycleMap, liveCycleId, liveCycleStartedAt) => {
  if (!liveCycleId) return null;
  // A known start time is authoritative: fills stamped into the live cycle
  // with older timestamps (e.g. DCA-merge synthetic pending buys dated at
  // order creation) must not drag the fold boundary back over unrelated
  // history.
  if (liveCycleStartedAt !== null) return liveCycleStartedAt;
  let startTs = null;
  for (const fill of cycleMap.get(liveCycleId) || []) {
    const ts = Number(fill.timestamp);
    if (Number.isFinite(ts) && (startTs === null || ts < startTs)) startTs = ts;
  }
  return startTs;
};

/**
 * @typedef {Object} CycleRecalculationPlan
 * @property {Array<{fill: Fill, cycleId: string, reason: 'order'|'link'|'timeframe'}>} attributed -
 *   Orphans placed into existing cycles (#705); `fill` is the ledger's own row, to be stamped.
 * @property {Map<Fill, Object>} patches - Order-level annotations attributed rows inherit (#752), to be assigned.
 * @property {number} liveCycleOrphansAttributed - How many of `attributed` went into the live cycle.
 * @property {number} orphanFillCount - Orphans left over for recovered cycles.
 * @property {Array<{cycleId: string, fills: Fill[]}>} orphanCycles - Recovered cycles, under their
 *   pre-renumbering `-recovered-N` IDs, holding the ledger's own rows.
 * @property {string|null} adoptedCycleId - Latest incomplete recovered cycle (pre-renumbering ID)
 *   adopted as the live cycle; only ever set when there was no live cycle (#675).
 * @property {{idMap: Map<string, string>, nextCycleNumber: number, renumbered: number}|null} renumbering -
 *   buildCycleRenumberingMap output; null when no recovered cycles were created.
 * @property {Array<Object>} cycleDetails - Completed cycles' stats rows, under final (renumbered) IDs.
 * @property {number} realizedPnL - Unrounded avgCost-prorated P&L of the completed cycles (diagnostic).
 * @property {number} realizedAssetPnL - Unrounded holdback of the completed cycles (diagnostic).
 * @property {number} orphansFixed - Orphan fills that get a cycle (attributed + recovered).
 * @property {string|null} activeCycleId - Live cycle after adoption and renumbering.
 * @property {Object<string, string>} idMap - old → new ID for every cycle the renumbering renames.
 */

/**
 * Plan a cycle recalculation over a ledger's fills (issue #1335). Pure:
 * never mutates a fill or any ledger state. Completion and stats are
 * evaluated on attributed rows with their inherited patches applied to
 * copies, which matches the ledger applying the patches to its rows.
 *   - Attributes orphan fills (cycleId: null) to existing cycles by order
 *     linkage, then folds unlinked ones that fall inside the live cycle's
 *     timeframe into it (issue #705) — before completion is evaluated
 *   - Splits the remaining orphans into recovered cycles by buy/sell pattern
 *   - Calculates BTC holdback per cycle and total reserves
 *   - Never moves the live cycle: incomplete orphan groups stay in their own
 *     recovered cycles, and the live cycle is only adopted from them when it
 *     was null. Renumbering keeps the live cycle last (#675).
 * @param {Object} params
 * @param {Iterable<Fill>} params.fills - Every fill in the ledger
 * @param {string|null} params.liveCycleId - The engine's live cycle
 * @param {number|null} params.liveCycleStartedAt - Persisted start time of the live cycle, or null when unknown
 * @param {number} [params.cycleCompletionRatio] - Completion threshold override (isCompletedCycle default otherwise)
 * @returns {CycleRecalculationPlan}
 */
const planCycleRecalculation = ({ fills, liveCycleId, liveCycleStartedAt, cycleCompletionRatio }) => {
  const allFills = Array.from(fills).sort((a, b) => a.timestamp - b.timestamp);

  // Group fills by cycleId; collect orphans (cycleId: null) separately.
  const { cycleMap, orphanFills: allOrphanFills } = groupFillsByCycle(allFills);

  // Attribute orphans to existing cycles (linkage first, then the live
  // cycle's timeframe) BEFORE completion is evaluated, so a folded sell
  // that completes a cycle is seen by cycleDetails and auto-link (#705).
  const { attributed, remaining, liveCount } = attributeOrphanFills({
    cycleMap,
    orphanFills: allOrphanFills,
    liveCycleId,
    liveStartTs: resolveLiveCycleStartTs(cycleMap, liveCycleId, liveCycleStartedAt),
  });
  for (const { fill, cycleId } of attributed) {
    if (!cycleMap.has(cycleId)) cycleMap.set(cycleId, []);
    cycleMap.get(cycleId).push(fill);
  }
  // Order-level annotations live on EVERY row of an order (TP placement,
  // body annotation and #607 consumption all write per-orderId), so a
  // recovered partial row of an already-annotated order inherits them —
  // otherwise a body buy row reads as an unowned core buy (core totals,
  // legacy TP linkage, boot orphan adoption), and a body TP sell row as a
  // legacy core sell (core stats, auto-link) (#705, #752).
  // Rows an earlier recalc already attributed (#705 shipped before #752)
  // are re-derived too, so existing ledgers heal; patches only ever fill
  // fields a row lacks, so re-deriving is idempotent. Timestamp folds have
  // no order linkage to inherit from.
  const earlier = [];
  for (const [cycleId, cycleFills] of cycleMap) {
    for (const fill of cycleFills) {
      if (fill.cycleId === cycleId && fill.cycleAttribution && fill.cycleAttribution !== 'timeframe') {
        earlier.push({ fill, cycleId });
      }
    }
  }
  const patches = deriveAttributedAnnotations([...attributed, ...earlier], cycleMap);
  // Evaluate the inherited annotations on copies, so the cycleDetails match
  // what the ledger's rows read once the patches are applied.
  if (patches.size > 0) {
    for (const [id, cycleFills] of cycleMap) {
      cycleMap.set(id, cycleFills.map(f => (patches.has(f) ? { ...f, ...patches.get(f) } : f)));
    }
  }

  // Calculate P&L and holdback for each completed cycle (sells have closed
  // most of the position).
  const cycleDetails = [];
  let realizedPnL = 0;
  let realizedAssetPnL = 0;
  for (const [cycleId, cycleFills] of cycleMap) {
    if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
      const { cycleDetail, pnl, holdbackAsset } = computeCycleStats(cycleId, cycleFills);
      cycleDetails.push(cycleDetail);
      realizedPnL += pnl;
      realizedAssetPnL += holdbackAsset;
    }
  }

  // Assign the remaining orphan fills to recovered cycles by buy-sell
  // pattern: a sell ends a cycle, the next buy starts a new cycle. An
  // incomplete orphan group stays in its own recovered cycle — sync-fills /
  // manual-trade-import null-stamp historical fills on purpose (#108) — and
  // must NEVER displace the engine's live cycle (#675).
  const orphanCycles = splitOrphansIntoCycles(remaining);
  let orphansFixed = attributed.length;
  let adoptedCycleId = null;
  // Recovered cycles' totals are summed on their own, then added, so the
  // floating-point totals keep their historical association order.
  let recoveredPnL = 0;
  let recoveredHoldbackAsset = 0;
  for (const { cycleId, fills: cycleFills } of orphanCycles) {
    orphansFixed += cycleFills.length;
    if (isCompletedCycle(cycleFills, cycleCompletionRatio)) {
      const { cycleDetail, pnl, holdbackAsset } = computeCycleStats(cycleId, cycleFills);
      cycleDetails.push(cycleDetail);
      recoveredPnL += pnl;
      recoveredHoldbackAsset += holdbackAsset;
    } else if (!liveCycleId) {
      // No live cycle to preserve — adopt the latest incomplete orphan group.
      adoptedCycleId = cycleId;
    }
  }
  realizedPnL += recoveredPnL;
  realizedAssetPnL += recoveredHoldbackAsset;
  let activeCycleId = adoptedCycleId !== null ? adoptedCycleId : liveCycleId;

  // Renumber cycles only when orphan fills created new (recovered) cycle
  // IDs that need sequential numbering. Attributing orphans into existing
  // cycles creates no new IDs, so it keeps IDs stable.
  let renumbering = null;
  /** @type {Object<string, string>} */
  const idMap = {};
  if (orphanCycles.length > 0) {
    const cycleTimestamps = collectCycleTimestamps(cycleMap, orphanCycles);
    const completedIds = new Set(cycleDetails.map(d => d.cycleId));
    renumbering = buildCycleRenumberingMap(cycleTimestamps, completedIds, activeCycleId);
    for (const [oldId, newId] of renumbering.idMap) {
      if (oldId !== newId) idMap[oldId] = newId;
    }
    for (const detail of cycleDetails) {
      if (renumbering.idMap.has(detail.cycleId)) detail.cycleId = renumbering.idMap.get(detail.cycleId);
    }
    if (activeCycleId && renumbering.idMap.has(activeCycleId)) {
      activeCycleId = renumbering.idMap.get(activeCycleId);
    }
  }

  return {
    attributed,
    patches,
    liveCycleOrphansAttributed: liveCount,
    orphanFillCount: remaining.length,
    orphanCycles,
    adoptedCycleId,
    renumbering,
    cycleDetails,
    realizedPnL,
    realizedAssetPnL,
    orphansFixed,
    activeCycleId,
    idMap,
  };
};

module.exports = {
  LEGACY_CONSUMPTION_KEY,
  ORDER_LEVEL_FIELDS,
  CYCLE_COMPLETE_SELL_RATIO,
  isCompletedCycle,
  groupFillsByCycle,
  splitOrphansIntoCycles,
  attributeOrphanFills,
  buildCycleRenumberingMap,
  collectCycleTimestamps,
  planCycleRecalculation,
};
