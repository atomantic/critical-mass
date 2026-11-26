// @ts-check

const { LEGACY_CONSUMPTION_KEY } = require('./fill-ledger');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { fmtCurrency: fmtPrice, isFilledStatus } = require('./shared-utils');
const { isBuyAlreadyCommitted, isUnsettledBuyRow, measureUnbookedOrderQty } = require('./regime-pure-helpers');
const celestialHierarchy = require('./celestial-hierarchy');

/**
 * Repair owned entry tranches at startup. Recovery runs before sealing legacy
 * consumption, so a proven open tranche is counted in its original cycle.
 * @param {Object} deps
 */
const createEntryTrancheRecovery = ({
  exchange, productId, baseCurrency, config, logger, positionState,
  fillLedger, closedTrades, getAdapter, lookupOrNull, saveLiveState,
}) => {
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
      openOrders = await getAdapter().getOpenOrders(productId);
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
        const status = await lookupOrNull('getOrder', orderId, getAdapter().getOrder(orderId));
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

  return { recoverUnbookedOwnedEntryTranches, sealLegacyClosure };
};

module.exports = { createEntryTrancheRecovery };
