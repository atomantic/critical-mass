// @ts-check
/**
 * Fill ledger realized-P&L derivation (issue #1613).
 *
 * Pure, read-only functions over the ledger's fill rows: the cycle-pair
 * source of truth (`computeRealizedFromCyclePairs`) behind
 * position.realizedPnL / realizedAssetPnL / heldOpenBuyCostBasis, and the
 * diagnostics-only FIFO replay (`computeFifoRealized`). Neither mutates a
 * fill. `createFillLedger` (fill-ledger.js) owns the fills Map and the
 * ledgerVersion memoization, and exposes both under its unchanged method
 * names.
 *
 * The `consumedBy` record helpers live here because the held-open
 * derivation reads them; the ledger's consumption store imports them back.
 *
 * Accounting-critical: read the P&L model in CLAUDE.md and
 * docs/pnl-architecture.md before changing anything here.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
// Canonical cycle pairing shared with the admin Filled Orders view (issue #697).
const { pairCycleFills, buyPairKey } = require('../shared/cycle-pairing.mjs');

/**
 * @typedef {import('./types').Fill} Fill
 */

/**
 * Total base quantity recorded in a buy's `consumedBy` map.
 * @param {Object<string, number>} consumedBy
 * @returns {number}
 */
const sumConsumedBy = (consumedBy) => Object.values(consumedBy)
  .reduce((sum, qty) => sum + (Number.isFinite(qty) && qty > 0 ? qty : 0), 0);

/**
 * Rows carry cumulative per-order consumption snapshots. When snapshots
 * differ, preserve the greatest quantity recorded for each sell instead of
 * allowing whichever row happens to be visited last to erase it.
 * @param {Object<string, number>|null} current
 * @param {Object<string, number>} incoming
 * @returns {Object<string, number>}
 */
const mergeConsumedBy = (current, incoming) => {
  const merged = { ...(current || {}) };
  for (const [sellOrderId, quantity] of Object.entries(merged)) {
    if (!Number.isFinite(quantity) || quantity < 0) delete merged[sellOrderId];
  }
  for (const [sellOrderId, quantity] of Object.entries(incoming || {})) {
    if (!Number.isFinite(quantity) || quantity < 0) continue;
    merged[sellOrderId] = Math.max(merged[sellOrderId] || 0, quantity);
  }
  return merged;
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
 *                          − Σ bodyReservesSoldAsset (a stale TP that sold
 *                          more than its body held drew the excess out of
 *                          reserves — issue #770)
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
 *   untrackedSellQty     = Σ size of sell orders annotated `untrackedSell`
 *                          (foreign sells — manual/tooling — that closed no
 *                          cycle; issues #672/#750). Already inside
 *                          ledgerNetAsset; broken out so position coverage
 *                          can attribute the gap they open instead of the
 *                          engine guessing which holding they drew down.
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
 * @param {Map<string, Fill>|Fill[]} fills - the ledger rows; `.values()` must
 *   yield a fresh iterator on every call (it is walked twice)
 * @returns {{realizedPnL: number, realizedAssetPnL: number, heldOpenBuyCostBasis: number, heldOpenAssetQty: number, ledgerNetAsset: number, unpairedSellQty: number, untrackedSellQty: number}}
 */
const computeRealizedFromCyclePairs = (fills) => {
  // Pairing and per-sell pnl/holdback come from the shared rule set the
  // dashboard's Filled Orders rows also use (issue #697), so the Position
  // card and the Filled Orders grand total can never disagree.
  const pairing = pairCycleFills(fills.values());

  // Held-open cost is a ledger-only concern: aggregate buys per order
  // (keyed the same way as the pairing — tradeId for no-orderId rows, #108)
  // with their consumption records.
  const buyAggByOrderId = new Map();
  let ledgerNetAsset = 0;
  const untrackedSellOrderIds = new Set();
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
        if (f.consumedBy && typeof f.consumedBy === 'object') ex.consumedBy = mergeConsumedBy(ex.consumedBy, f.consumedBy);
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
      // Flag is per orderId: a row ingested after annotateFillsByOrderId ran
      // carries none, yet belongs to the same foreign order.
      if (f.untrackedSell && f.orderId) untrackedSellOrderIds.add(f.orderId);
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

  // Foreign sells (issues #672/#750): every row of a flagged order counts.
  let untrackedSellQty = 0;
  for (const orderId of untrackedSellOrderIds) untrackedSellQty += pairing.sells.get(orderId)?.size || 0;

  return {
    realizedPnL: roundUSDC(pairing.realizedPnL),
    realizedAssetPnL: roundAsset(pairing.realizedAssetPnL),
    heldOpenBuyCostBasis: roundUSDC(heldOpenBuyCostBasis),
    heldOpenAssetQty: roundAsset(heldOpenAssetQty),
    ledgerNetAsset: roundAsset(ledgerNetAsset),
    unpairedSellQty: roundAsset(pairing.unpairedSellQty),
    untrackedSellQty: roundAsset(untrackedSellQty),
  };
};

/**
 * FIFO replay. Diagnostic only — not the source of truth.
 * Uncovered-sell handling: only the covered portion contributes to
 * realizedPnL; `remainingAssetQty` uses `total_buys − total_sells`.
 * @param {Map<string, Fill>|Fill[]} fills - the ledger rows
 * @returns {{realizedPnL: number, remainingAssetQty: number, uncoveredSellQty: number, remainingLotCost: number, remainingLotQty: number}}
 */
const computeFifoRealized = (fills) => {
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

module.exports = {
  sumConsumedBy,
  mergeConsumedBy,
  computeRealizedFromCyclePairs,
  computeFifoRealized,
};
