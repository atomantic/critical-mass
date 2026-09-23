// @ts-check
/**
 * Canonical buy↔sell cycle pairing and per-sell realized P&L (issue #697).
 *
 * The ONE rule set behind both the engine's `realizedPnL`/`realizedAssetPnL`
 * (src/fill-ledger.js computeRealizedFromCyclePairs, loaded via require(esm))
 * and the dashboard's Filled Orders rows and grand total
 * (admin/src/utils/regimeFillGroups.mjs). Keeping it in one pure module is what
 * guarantees the Position card and the Filled Orders total agree.
 *
 * Rules (see CLAUDE.md "P&L model"):
 *   - Buys aggregate per orderId; a buy with NO orderId (legacy/manual row) is
 *     keyed by its own tradeId so distinct rows never collapse together (#108).
 *   - Sells aggregate per orderId.
 *   - A buy pairs with the sell its `sellOrderId` names when that sell has
 *     fills. A `sellOrderId` naming a sell with NO fills (a TP that was
 *     re-placed under a new id) is redirected through `bodyId` to the latest
 *     filled sell of the same body; the bodyId is learned from any buy sharing
 *     that orphaned sellOrderId when the buy itself carries none.
 *   - Per-sell pnl: the bodyPnl/satellitePnl annotation, taken ONCE per
 *     orderId (it is written identically to every partial row). Otherwise
 *     proceeds − linked buy cost PRORATED by the quantity sold:
 *     cost × min(1, sold / linked size) — the engine's own proration
 *     (regime-engine.js proratedCostBasis). A sell with neither an annotation
 *     nor linked buys has no pnl (null) and counts toward unpairedSellQty.
 *   - Per-sell holdback: the bodyHoldbackAsset/satelliteHoldbackAsset
 *     annotation whenever it is non-null (regardless of isBodyOwned), else
 *     max(0, linked size − sold).
 *
 * Pure: never mutates its input. Held-open cost (consumedBy / legacy closure)
 * is a server concern and stays in fill-ledger.js.
 */

/**
 * Aggregation key for a buy fill: its orderId, or its tradeId when it has none.
 * @param {{orderId?: string|null, tradeId?: string|null}} fill
 * @returns {string}
 */
export const buyPairKey = (fill) => fill.orderId || `__noorder__:${fill.tradeId}`;

/**
 * Quote value of a fill. Ledger fills always carry quoteAmount; UI payloads
 * that don't fall back to size × price.
 * @param {{quoteAmount?: number, size?: number, price?: number}} fill
 * @returns {number}
 */
const quoteOf = (fill) => fill.quoteAmount || (fill.size || 0) * (fill.price || 0);

/**
 * Fee of a fill: netFee (net of rebates), else the gross fee.
 * @param {{netFee?: number, fee?: number}} fill
 * @returns {number}
 */
const feeOf = (fill) => fill.netFee ?? fill.fee ?? 0;

/**
 * Cost of a buy fill (quote + fee).
 * @param {any} fill
 * @returns {number}
 */
export const buyFillCost = (fill) => quoteOf(fill) + feeOf(fill);

/**
 * Proceeds of a sell fill (quote − fee).
 * @param {any} fill
 * @returns {number}
 */
export const sellFillProceeds = (fill) => quoteOf(fill) - feeOf(fill);

/**
 * @typedef {Object} PairedBuy
 * @property {string} key - buyPairKey
 * @property {number} size
 * @property {number} cost
 * @property {string|null} sellOrderId - first non-empty stamp across rows
 * @property {string|null} bodyId
 * @property {string|null} pairedSellOrderId - the filled sell it pairs with, or null
 *
 * @typedef {Object} PairedSell
 * @property {string} orderId
 * @property {number} size
 * @property {number} proceeds
 * @property {string|null} bodyId
 * @property {number} timestamp - latest fill timestamp
 * @property {boolean} hasPnlAnnotation
 * @property {boolean} hasHoldbackAnnotation
 * @property {string[]} buyKeys - keys of the buys paired with this sell
 * @property {number} linkedSize
 * @property {number} linkedCost
 * @property {number|null} pnl - null when unannotated and unpaired
 * @property {number} holdback
 *
 * @typedef {Object} CyclePairing
 * @property {Map<string, PairedBuy>} buys - by buyPairKey, in ledger order
 * @property {Map<string, PairedSell>} sells - by orderId, in ledger order
 * @property {number} realizedPnL - Σ per-sell pnl (unrounded)
 * @property {number} realizedAssetPnL - Σ per-sell holdback (unrounded)
 * @property {number} unpairedSellQty - Σ size of sells with no pnl
 */

/**
 * Pair buys to sells and price every sell. See the module header for the rules.
 * @param {Iterable<any>} fills - raw ledger fill rows (partials not pre-aggregated)
 * @returns {CyclePairing}
 */
export function pairCycleFills(fills) {
  /** @type {Map<string, PairedBuy>} */
  const buys = new Map();
  /** @type {Map<string, PairedSell & {annotatedPnl: number, annotatedHoldback: number}>} */
  const sells = new Map();

  for (const f of fills) {
    if (f.side === 'buy') {
      const key = buyPairKey(f);
      const ex = buys.get(key);
      if (ex) {
        ex.size += f.size || 0;
        ex.cost += buyFillCost(f);
        if (f.sellOrderId && !ex.sellOrderId) ex.sellOrderId = f.sellOrderId;
        if (f.bodyId && !ex.bodyId) ex.bodyId = f.bodyId;
      } else {
        buys.set(key, {
          key,
          size: f.size || 0,
          cost: buyFillCost(f),
          sellOrderId: f.sellOrderId || null,
          bodyId: f.bodyId || null,
          pairedSellOrderId: null,
        });
      }
    } else if (f.side === 'sell') {
      const annotatedPnl = f.bodyPnl ?? f.satellitePnl;
      const annotatedHoldback = f.bodyHoldbackAsset ?? f.satelliteHoldbackAsset;
      const ts = f.timestamp || 0;
      const ex = sells.get(f.orderId);
      if (ex) {
        ex.size += f.size || 0;
        ex.proceeds += sellFillProceeds(f);
        if (ts > ex.timestamp) ex.timestamp = ts;
        if (f.bodyId && !ex.bodyId) ex.bodyId = f.bodyId;
        if (!ex.hasPnlAnnotation && annotatedPnl != null) {
          ex.annotatedPnl = annotatedPnl;
          ex.hasPnlAnnotation = true;
        }
        if (!ex.hasHoldbackAnnotation && annotatedHoldback != null) {
          ex.annotatedHoldback = annotatedHoldback;
          ex.hasHoldbackAnnotation = true;
        }
      } else {
        sells.set(f.orderId, {
          orderId: f.orderId,
          size: f.size || 0,
          proceeds: sellFillProceeds(f),
          bodyId: f.bodyId || null,
          timestamp: ts,
          annotatedPnl: annotatedPnl ?? 0,
          hasPnlAnnotation: annotatedPnl != null,
          annotatedHoldback: annotatedHoldback ?? 0,
          hasHoldbackAnnotation: annotatedHoldback != null,
          buyKeys: [],
          linkedSize: 0,
          linkedCost: 0,
          pnl: null,
          holdback: 0,
        });
      }
    }
  }

  // bodyId → latest filled sell of that body (TP re-placement target).
  /** @type {Map<string, {orderId: string, timestamp: number}>} */
  const latestSellByBodyId = new Map();
  for (const sell of sells.values()) {
    if (!sell.bodyId) continue;
    const cur = latestSellByBodyId.get(sell.bodyId);
    if (!cur || sell.timestamp >= cur.timestamp) latestSellByBodyId.set(sell.bodyId, { orderId: sell.orderId, timestamp: sell.timestamp });
  }
  // Learn a bodyId for each orphaned sellOrderId from any buy that carries one.
  /** @type {Map<string, string>} */
  const bodyIdByOrphanSellId = new Map();
  for (const buy of buys.values()) {
    if (buy.sellOrderId && !sells.has(buy.sellOrderId) && buy.bodyId && !bodyIdByOrphanSellId.has(buy.sellOrderId)) {
      bodyIdByOrphanSellId.set(buy.sellOrderId, buy.bodyId);
    }
  }

  for (const buy of buys.values()) {
    const sid = buy.sellOrderId;
    if (!sid) continue;
    let target = sells.has(sid) ? sid : null;
    if (!target) {
      const bodyId = buy.bodyId || bodyIdByOrphanSellId.get(sid);
      target = (bodyId && latestSellByBodyId.get(bodyId)?.orderId) || null;
    }
    if (!target) continue;
    const sell = /** @type {any} */ (sells.get(target));
    buy.pairedSellOrderId = target;
    sell.buyKeys.push(buy.key);
    sell.linkedSize += buy.size;
    sell.linkedCost += buy.cost;
  }

  let realizedPnL = 0;
  let realizedAssetPnL = 0;
  let unpairedSellQty = 0;
  for (const sell of sells.values()) {
    const paired = sell.buyKeys.length > 0;
    if (sell.hasPnlAnnotation) {
      sell.pnl = sell.annotatedPnl;
    } else if (paired) {
      const soldFraction = sell.linkedSize > 0 ? Math.min(1, sell.size / sell.linkedSize) : 1;
      sell.pnl = sell.proceeds - sell.linkedCost * soldFraction;
    } else {
      sell.pnl = null;
      unpairedSellQty += sell.size;
    }
    if (sell.hasHoldbackAnnotation) {
      sell.holdback = sell.annotatedHoldback > 0 ? sell.annotatedHoldback : 0;
    } else if (paired) {
      sell.holdback = Math.max(0, sell.linkedSize - sell.size);
    }
    if (sell.pnl != null) realizedPnL += sell.pnl;
    realizedAssetPnL += sell.holdback;
  }

  return { buys, sells, realizedPnL, realizedAssetPnL, unpairedSellQty };
}
