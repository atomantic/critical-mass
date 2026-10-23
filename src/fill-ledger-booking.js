// @ts-check
/**
 * Per-order sell booking, buy consumption and capital-credit markers
 * (issue #1613). The ledger owns its fill map, dirty flag, version and
 * persistence; the store preserves the order of every mutation and write.
 */
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { LEGACY_CONSUMPTION_KEY } = require('./fill-ledger-recalc');
const { sumConsumedBy, mergeConsumedBy } = require('./fill-ledger-realized');

const createBookingStore = ({ fills, getFillsForOrder, setDirty, bumpLedgerVersion, persist }) => {
  /**
   * The committed body-TP booking of one sell order (issue #777), or null
   * when no booking has committed for it. Order-level: every row of a
   * booked order carries the same values, so this reads them ONCE — never
   * summed across the order's partial rows. A row ingested after the booking
   * carries no annotation yet and is skipped.
   *
   * `bookedSize` is the booking-commit marker: the cumulative base quantity
   * the committed bookings covered. A booking written before the marker
   * existed has none; its size is the rows that carry the annotation.
   * @param {string} orderId - Sell order id
   * @returns {{bodyPnl: number, bodyCostBasis: number, bodyBtcQty: number, bodyHoldbackAsset: number, bodyReservesSoldAsset: number, bookedSize: number, hasMarker: boolean}|null}
   */
  const getSellBooking = (orderId) => {
    if (!orderId) return null;
    let annotated = null;
    let annotatedSize = 0;
    for (const f of fills.values()) {
      if (f.orderId !== orderId || f.side !== 'sell' || f.bodyPnl == null) continue;
      if (!annotated) annotated = f;
      annotatedSize += Number(f.size) || 0;
    }
    if (!annotated) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const hasMarker = Number.isFinite(annotated.bodyBookedSize);
    return {
      bodyPnl: num(annotated.bodyPnl),
      bodyCostBasis: num(annotated.bodyCostBasis),
      bodyBtcQty: num(annotated.bodyBtcQty),
      bodyHoldbackAsset: num(annotated.bodyHoldbackAsset),
      bodyReservesSoldAsset: num(annotated.bodyReservesSoldAsset),
      bookedSize: hasMarker ? annotated.bodyBookedSize : roundAsset(annotatedSize),
      hasMarker,
    };
  };

  /**
   * Commit a body-TP sell booking onto its order (issue #777). The per-order
   * annotations are read once per orderId, so a second booking of the same
   * sell order — a partial then its remainder, or a cancel-race execution
   * beyond what an in-flight fill booked — must ADD to what the order already
   * carries, not replace it (a replacement drops the first tranche's P&L,
   * holdback and reserves from realizedPnL / realizedAssetPnL). With
   * `additive`, the quantity/value fields are summed onto the committed
   * booking and `bodyBookedSize` advances by this booking's size; without
   * it (a first booking, or a replay re-aggregating every row of the order)
   * the annotation replaces and `bodyBookedSize` is the booking's own size.
   *
   * `partialFill` reflects the LATEST booking: a remainder that closes the
   * body clears the earlier partial's flag.
   *
   * The rows this booking covered are stamped `bodyBooked` (row-level, unlike
   * the order-level annotation every row receives), so a row that reached the
   * ledger through another path (startup recovery, a dedup-skipped delivery)
   * is still recognisable as unbooked execution — see getUnbookedSellFills.
   * @param {string} orderId - Sell order id
   * @param {Object} annotation - Order-level fields for this booking alone
   * @param {{additive?: boolean, soldSize: number, bookedTradeIds?: Iterable<string>}} opts -
   *   `soldSize` is the base quantity this booking sold; `bookedTradeIds` the
   *   rows it aggregated (default: every row of the order)
   * @returns {number} the order's cumulative booked size after the commit
   */
  const commitSellBooking = (orderId, annotation, { additive = false, soldSize, bookedTradeIds } = /** @type {any} */ ({})) => {
    const booked = bookedTradeIds ? new Set(bookedTradeIds) : null;
    const prior = additive ? getSellBooking(orderId) : null;
    const sold = Number(soldSize) || 0;
    const merged = { ...annotation };
    if (prior) {
      const add = (field, round) => {
        const next = prior[field] + (Number(annotation[field]) || 0);
        return round ? round(next) : next;
      };
      merged.bodyPnl = add('bodyPnl');
      merged.bodyCostBasis = add('bodyCostBasis', roundUSDC);
      merged.bodyBtcQty = add('bodyBtcQty', roundAsset);
      merged.bodyHoldbackAsset = add('bodyHoldbackAsset', roundAsset);
      const reservesSold = add('bodyReservesSoldAsset', roundAsset);
      if (reservesSold > 0) merged.bodyReservesSoldAsset = reservesSold;
    }
    merged.bodyBookedSize = roundAsset((prior ? prior.bookedSize : 0) + sold);
    let matched = false;
    for (const fill of fills.values()) {
      if (fill.orderId !== orderId) continue;
      // A booking committed before the marker existed covered the rows that
      // carry its annotation (issue #777): keep them booked, or a later
      // pass would book them again as unbooked execution.
      const legacyBooked = prior && !prior.hasMarker && fill.bodyPnl != null;
      Object.assign(fill, merged);
      if (!merged.partialFill) delete fill.partialFill;
      if (!booked || booked.has(fill.tradeId) || legacyBooked) fill.bodyBooked = true;
      matched = true;
    }
    if (matched) {
      setDirty();
      bumpLedgerVersion();
    }
    return merged.bodyBookedSize;
  };

  /**
   * The rows of a sell order no committed booking covered (issue #777) —
   * execution still to book. Only meaningful once the order carries the
   * booking-commit marker (commitSellBooking stamps `bodyBooked` on the rows
   * it covers); for an order booked before the marker existed, or never
   * booked, returns null and the caller keeps its own row selection.
   * @param {string} orderId - Sell order id
   * @returns {Array<Object>|null}
   */
  const getUnbookedSellFills = (orderId) => {
    const booking = getSellBooking(orderId);
    if (!booking || !booking.hasMarker) return null;
    return getFillsForOrder(orderId).filter(f => f.side === 'sell' && f.size > 1e-9 && !f.bodyBooked);
  };

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
      if (f.consumedBy && typeof f.consumedBy === 'object') consumedBy = mergeConsumedBy(consumedBy, f.consumedBy);
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
   * its own entry rather than consuming the buy twice. A SECOND booking of
   * the same sell for execution the first never covered (issue #777 — a
   * partial then its remainder) passes `additive`, and adds to the entry.
   * `legacySeedQty` is what sells recorded before this field existed had
   * already consumed; it seeds the map only the first time a consumption is
   * recorded for the order.
   * @param {string} buyOrderId
   * @param {string} sellOrderId
   * @param {number} qty - Base quantity this sell consumed from the order
   * @param {number} [legacySeedQty=0]
   * @param {{additive?: boolean}} [opts]
   * @returns {boolean} false when the ledger holds no buy fills for the order
   */
  const recordBuyConsumption = (buyOrderId, sellOrderId, qty, legacySeedQty = 0, { additive = false } = {}) => {
    if (!buyOrderId || !sellOrderId || !Number.isFinite(qty)) return false;
    const existing = getBuyOrderConsumption(buyOrderId);
    if (!existing) return false;
    const consumedBy = { ...(existing.consumedBy || {}) };
    if (!existing.consumedBy && legacySeedQty > 0) consumedBy[LEGACY_CONSUMPTION_KEY] = roundAsset(legacySeedQty);
    const priorForSell = additive ? (Number(consumedBy[sellOrderId]) || 0) : 0;
    consumedBy[sellOrderId] = roundAsset(priorForSell + Math.max(0, qty));
    for (const f of fills.values()) {
      if (f.orderId === buyOrderId && f.side === 'buy') f.consumedBy = { ...consumedBy };
    }
    setDirty();
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
      setDirty();
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
   *
   * `creditedSize` keys the claim per booked amount (issue #777): the order's
   * cumulative booked size once this credit applies. A second booking of the
   * same sell for execution the first never covered carries a larger size and
   * is credited; a replay of an already-credited booking carries the same
   * size and is refused. Without it — and for an order credited before sizes
   * were recorded — the claim is per order: any prior credit refuses.
   * `replay` (a pass that ingested no new rows and re-aggregates the whole
   * order) also refuses on any prior credit — its size spans rows an earlier
   * booking already credited — but still records its size when it is first.
   * @param {string} orderId - Sell order id whose pnl is about to be credited
   * @param {number} [creditedSize] - Cumulative booked size this credit covers
   * @param {{replay?: boolean}} [opts]
   * @returns {boolean} true if the caller should apply the credit; false if it
   *   was already credited on a prior (pre-crash) run.
   */
  const claimCapitalCredit = (orderId, creditedSize, { replay = false } = {}) => {
    if (!orderId) return true;
    const sized = Number.isFinite(creditedSize);
    let matched = false;
    let credited = false;
    let creditedUpTo = -Infinity;
    for (const fill of fills.values()) {
      if (fill.orderId !== orderId) continue;
      matched = true;
      if (!fill.capitalCredited) continue;
      credited = true;
      // A credited row without a size predates sized claims: fully credited.
      creditedUpTo = Math.max(creditedUpTo, Number.isFinite(fill.capitalCreditedSize) ? fill.capitalCreditedSize : Infinity);
    }
    const alreadyCredited = credited && (!sized || replay || creditedSize <= creditedUpTo + 1e-9);
    const stampSize = alreadyCredited ? creditedUpTo : (sized ? roundAsset(creditedSize) : Infinity);
    for (const fill of fills.values()) {
      if (fill.orderId !== orderId) continue;
      fill.capitalCredited = true;
      if (Number.isFinite(stampSize)) fill.capitalCreditedSize = stampSize;
      else delete fill.capitalCreditedSize;
      setDirty();
    }
    if (matched) bumpLedgerVersion();
    if (alreadyCredited) return false;
    if (matched) persist();
    return true;
  };

  return {
    getSellBooking,
    commitSellBooking,
    getUnbookedSellFills,
    getBuyOrderConsumption,
    recordBuyConsumption,
    sealLegacyClosedBuys,
    claimCapitalCredit,
  };
};

module.exports = { createBookingStore };
