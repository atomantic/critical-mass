// @ts-check
/**
 * Manual Trade Import
 *
 * Operator-facing reconciliation of trades made outside the regime engine.
 * These are the only paths that write directly into the fill ledger (the
 * documented source of truth for realized P&L — see CLAUDE.md) and, on the
 * sell-first recovery path, place a live exchange order.
 *
 * Extracted from engines/coinbase-engine.js so the behavior is testable: the
 * engine module calls startup() and registers process signal handlers at module
 * scope, so it can never be require()d from a test. The engine keeps only the
 * IPC wiring that resolves the fund's adapter/ledger/store and delegates here.
 *
 * Ordering contract (issue #423) — both rules exist because the ledger is live
 * state that the running engine persists on its own schedule:
 *  1. Validate every input BEFORE the first ledger or store mutation, so a
 *     rejected request leaves no trace on disk.
 *  2. Fetch ALL fill sets before ingesting ANY of them, so a late failure can
 *     never leave unpaired buy rows behind. Per CLAUDE.md, a buy whose
 *     `sellOrderId` is absent counts toward `heldOpenBuyCostBasis` — orphan buy
 *     rows permanently inflate the dashboard's open-position figure and are not
 *     self-healing.
 */

const { createNewBody, syncPositionState, mergeIntoBody, computeBuyOrderShortfall } = require('./celestial-hierarchy');
const { loadRegimeState, saveRegimeState } = require('./state-tracker');
const { STATUS, INTENT_PHASE, SIZE_EPSILON, getUncoveredSize } = require('./manual-trades');
const { FillValidationError, validateFillInput, LEGACY_CONSUMPTION_KEY } = require('./fill-ledger');
const { readBooleanFlag, isFilledStatus, isCancelledStatus } = require('./shared-utils');
const { getRegimeConfig } = require('./config-utils');

/** Logger used when a caller supplies none (tests, CLI paths). */
const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Canonical product key for comparing a fund's configured productId against
 * the identity an exchange reports on a fill/order (issue #1023). Exchanges
 * spell the same market differently (Coinbase `BTC-USDC`, Crypto.com
 * `BTC_USDC`, Gemini `btcusd`), so each is folded to its own canonical form —
 * but the quote currency is never dropped or merged, so USD and USDC (or EUR)
 * markets stay distinct. Gemini is the one deliberate alias: its adapter
 * maps a `-USDC` fund product onto the `usd` symbol.
 */
const canonicalProduct = (exchange, productId) => {
  const raw = String(productId ?? '').trim();
  if (!raw) return '';
  if (exchange === 'gemini') return raw.toLowerCase().replace(/[-_/]/g, '').replace('usdc', 'usd');
  return raw.toUpperCase().replace(/[-_/]/g, '-');
};

const lc = (value) => String(value).toLowerCase();

const toLedgerFill = (raw, orderId, defaultSide) => ({
  tradeId: raw.tradeId,
  orderId,
  side: raw.side?.toLowerCase() || defaultSide,
  price: raw.price,
  size: raw.size,
  totalCommission: raw.totalCommission || raw.commission || 0,
  commission: raw.commission || 0,
  rebate: raw.rebate || 0,
  // Pass raw.netFee through AS-IS (no `|| raw.commission` fallback) —
  // codex delta review, round 4: falling back to the GROSS commission
  // here short-circuited fillLedger.ingestFill's own rebate-aware
  // default (`commission - rebate`), which only applies when `netFee`
  // is `undefined`/`null` on the input. That silently made every
  // manually-imported buy's ledger-row `netFee` equal gross commission
  // regardless of any rebate — invisible until a rebated fill's cost
  // basis was compared against a later reconciliation computed the
  // same (now-correct) way.
  netFee: raw.netFee,
  liquidityIndicator: raw.liquidityIndicator || 'TAKER',
  tradeTime: raw.tradeTime,
  fee_asset: 'USDC',
});

/**
 * Validate every fill of one order against the ledger's ingestion rules
 * WITHOUT mutating anything. Returns an error string for the first invalid
 * fill, or null. Call before ingestAdapterFills so a malformed fill can never
 * be acknowledged as a successful import or leave a half-ingested order.
 */
const validateAdapterFills = (fills, orderId, defaultSide) => {
  for (const raw of fills) {
    try {
      validateFillInput(toLedgerFill(raw, orderId, defaultSide));
    } catch (err) {
      if (!(err instanceof FillValidationError)) throw err;
      return `${err.message} (order ${orderId}, trade ${raw.tradeId ?? 'unknown'})`;
    }
  }
  return null;
};

/**
 * Ingest adapter fills into the fill ledger, accumulating totals.
 *
 * Manual-trade reconciliation fills can be days old, so `cycleId: null` keeps
 * them out of the live cycle (issue #108); `recalculateCycles`' orphan logic
 * places them in the correct cycle by buy/sell pattern. Persisting is left to
 * the caller so a multi-order import writes once, atomically.
 *
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object[]} fills - Raw adapter fills
 * @param {string} orderId - Exchange order id the fills belong to
 * @param {'buy'|'sell'} defaultSide - Side to use when a fill omits its own
 * @returns {{ tradeIds: string[], totalSize: number, totalQuote: number }}
 */
const ingestAdapterFills = (fillLedger, fills, orderId, defaultSide) => {
  const tradeIds = [];
  let totalSize = 0;
  let totalQuote = 0;
  for (const raw of fills) {
    tradeIds.push(raw.tradeId);
    totalSize += raw.size;
    totalQuote += raw.price * raw.size;
    fillLedger.ingestFill(toLedgerFill(raw, orderId, defaultSide), null, { skipPersist: true, cycleId: null });
  }
  return { tradeIds, totalSize, totalQuote };
};

/** Volume-weighted average price, safe on an empty fill set. */
const averagePrice = (totalQuote, totalSize) => (totalSize > 0 ? totalQuote / totalSize : 0);

/** Milliseconds of the first fill, used as the leg's timestamp. */
const legTimestamp = (fills) => new Date(fills[0].tradeTime).getTime();

/** Backoff between client-id lookups right after an ambiguous placement. */
const RECOVERY_LOOKUP_RETRY_DELAYS_MS = [500, 1000];

/**
 * Whether an order found by client id never recovered anything and can never
 * execute: off the book (or rejected) with no executions. Anything else —
 * open, filled, or terminal with partial executions — is a real attempt.
 * @param {{status?: string, filledSize?: number}} order
 */
const isNeverExecuted = (order) => (isCancelledStatus(order) || String(order.status || '').toUpperCase() === 'REJECTED')
  && !(Number(order.filledSize) > 0);

/**
 * Exchange-agnostic product identity: Coinbase `BTC-USDC`, Crypto.com
 * `CRO_USD` and Gemini `btcusd` (which quotes USDC funds in USD) all compare
 * on base asset + USD quote.
 */
const productKey = (productId) => String(productId || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/usdc$/, 'usd');

/**
 * Key for the store's per-sell lock. Every operation that can place, link or
 * settle a recovery buy for one sell shares it, so they run one at a time.
 */
const recoveryLockKey = (trade) => trade.sellOrderId || `trade:${trade.id}`;

/**
 * Why a sell-first trade cannot start a new recovery attempt right now, or
 * null when it can (issue #1034). A replacement is allowed only once every
 * earlier attempt is confirmed terminal — an active or unconfirmed order may
 * still execute, and a second order beside it would over-recover.
 * @returns {string|null}
 */
const recoveryRefusal = (trade) => {
  if (trade.tradeType !== 'sell_first') return `Manual trade ${trade.id} is not a sell-first recovery`;
  // An unrecorded placement (issue #1058) is an unconfirmed attempt too.
  if (trade.recoveryIntent) {
    return `Recovery buy with client order id ${trade.recoveryIntent.clientOrderId} is unconfirmed — a replacement is allowed only after the exchange confirms whether it exists`;
  }
  const live = (trade.recoveryAttempts || []).find((a) => !a.outcome);
  if (live || trade.status === STATUS.BUY_PENDING) {
    return `Recovery buy ${live?.orderId || trade.buyOrderId} is still active or unconfirmed — use Check Status; a replacement is allowed only after the exchange confirms it filled or cancelled`;
  }
  if (trade.status !== STATUS.SELL_RECORDED && trade.status !== STATUS.BUY_CANCELLED) {
    return `Manual trade ${trade.id} is ${trade.status}; there is no recovery to retry`;
  }
  if (getUncoveredSize(trade) === 0) return `Manual trade ${trade.id} has nothing left to recover`;
  return null;
};

/**
 * Create the manual-trade importer for one fund.
 *
 * @param {Object} deps
 * @param {string} deps.exchange - Exchange name
 * @param {string} [deps.pair] - Resolved trading pair
 * @param {Object} deps.adapter - Exchange adapter (getOrderFills/getOrder/placeLimitBuy)
 * @param {Object} deps.fillLedger - Fill ledger for this fund (engine's own when running)
 * @param {Object} deps.store - Manual trade store for this fund
 * @param {Object} [deps.fundConfig] - Fund config, read for productId
 * @param {Object} [deps.logger] - Context logger
 * @param {((body: Object) => Promise<Object>)|null} [deps.injectBody] - Injects a
 *   new celestial body into the running engine; null when no engine is up, in
 *   which case the body is persisted to regime-state.json instead.
 * @param {((bodyId: string, totals: Object, buyOrderId: string) => Promise<Object>)|null} [deps.extendBody] -
 *   Grows an already-live body with fills that arrived after it was created
 *   (issue #726 — a retried import of a still-filling buy order) and
 *   re-places its TP sized to the grown assetQty; takes the buy order's
 *   FULL current totals, not a delta. Null when no engine is up, in which
 *   case the persisted body on regime-state.json is extended directly
 *   instead (synchronously, and flagged `needsTpReprice` rather than
 *   touched if it already carries a live TP from before the engine stopped).
 * @param {number[]} [deps.recoveryLookupRetryDelaysMs] - Backoff between
 *   client-id lookups after an ambiguous recovery-buy placement (tests pass [])
 * @returns {Object} importSell / importBuy / importPair / checkPendingBuy / retryRecovery / resumeBodyImport / recoverPendingBodyIntents / recoverPendingRecoveryIntents
 */
const createManualTradeImporter = ({
  exchange,
  pair,
  adapter,
  fillLedger,
  store,
  fundConfig,
  logger,
  injectBody = null,
  extendBody = null,
  recoveryLookupRetryDelaysMs = RECOVERY_LOOKUP_RETRY_DELAYS_MS,
}) => {
  const log = logger || NOOP_LOGGER;
  const ok = (extra) => ({ success: true, exchange, pair, ...extra });
  const fail = (error) => ({ success: false, error });

  const expectedProduct = () => fundConfig?.productId || 'BTC-USDC';

  /**
   * Check that an order and its fills really are the requested role (buy/sell)
   * of THIS fund's product (issue #1023). Runs before any ledger/store
   * mutation or order placement. Per-fill identity is checked when present;
   * when any fill omits side/product/order id, the authoritative order record
   * (`metadata`, else adapter.getOrder) must supply and match it. Identity that
   * cannot be established fails closed — it is never assumed from the request.
   *
   * @param {Object[]|null} fills - Adapter fills for the order (null to check metadata alone)
   * @param {string} orderId - Requested exchange order id
   * @param {'buy'|'sell'} role - Side the operator says this order is
   * @param {Object} [metadata] - Already-fetched order record, if the caller has one
   * @returns {Promise<string|null>} Error message, or null when identity is verified
   */
  const verifyOrderIdentity = async (fills, orderId, role, metadata) => {
    const wantProduct = canonicalProduct(exchange, expectedProduct());
    const wrongSide = (side) => `Order ${orderId} is a ${lc(side)} order, not a ${role}`;
    const wrongProduct = (product) => `Order ${orderId} is for product ${product}, not this fund's ${expectedProduct()}`;
    let needsMetadata = !fills || fills.length === 0;

    for (const raw of fills || []) {
      if (raw.orderId == null || raw.orderId === '') needsMetadata = true;
      else if (String(raw.orderId) !== String(orderId)) {
        return `Fill ${raw.tradeId ?? 'unknown'} belongs to order ${raw.orderId}, not requested order ${orderId}`;
      }
      if (!raw.side) needsMetadata = true;
      else if (lc(raw.side) !== role) return wrongSide(raw.side);
      if (!raw.productId) needsMetadata = true;
      else if (canonicalProduct(exchange, raw.productId) !== wantProduct) return wrongProduct(raw.productId);
    }
    if (!needsMetadata) return null;

    let order = metadata;
    if (!order) {
      try {
        order = await adapter.getOrder(orderId);
      } catch (err) {
        return `Cannot verify identity of order ${orderId}: ${err.message}`;
      }
    }
    if (order?.orderId && String(order.orderId) !== String(orderId)) {
      return `Order lookup returned ${order.orderId}, not requested order ${orderId}`;
    }
    if (!order?.side || !order?.productId) {
      return `Cannot verify side/product of order ${orderId}: exchange returned no identity`;
    }
    if (lc(order.side) !== role) return wrongSide(order.side);
    if (canonicalProduct(exchange, order.productId) !== wantProduct) return wrongProduct(order.productId);
    return null;
  };

  /**
   * Fetch one order's fills and verify its identity, normalizing every failure
   * mode to `{ error }`.
   * @returns {Promise<{ fills?: Object[], error?: string }>}
   */
  const fetchOrderFills = async (orderId, side) => {
    let fills;
    try {
      fills = await adapter.getOrderFills(orderId);
    } catch (err) {
      return { error: `Failed to fetch ${side} order fills: ${err.message}` };
    }
    if (!fills || fills.length === 0) return { error: `No fills found for ${side} order ${orderId}` };
    const mismatch = await verifyOrderIdentity(fills, orderId, side);
    if (mismatch) return { error: mismatch };
    return { fills };
  };

  /**
   * Sell-first recovery import: record a manual sell and optionally place (or
   * link) the buy that recovers the sold asset.
   *
   * @param {Object} payload
   * @param {string} payload.sellOrderId
   * @param {string|number} [payload.recoveryBuyPrice] - Limit price for a new recovery buy
   * @param {string} [payload.existingBuyOrderId] - Already-placed buy to link instead
   * @param {string} [payload.note]
   */
  const importSell = async ({ sellOrderId, recoveryBuyPrice, existingBuyOrderId, note } = {}) => {
    if (!sellOrderId) return fail('sellOrderId is required');

    // Validate BEFORE touching the ledger or the store: the pre-extraction code
    // ingested fills and persisted the trade record first and only then parsed
    // the price, so a bad price reported failure over already-mutated disk state.
    const placingRecoveryBuy = Boolean(recoveryBuyPrice) && !existingBuyOrderId;
    const buyPrice = placingRecoveryBuy ? parseFloat(String(recoveryBuyPrice)) : 0;
    if (placingRecoveryBuy && (!Number.isFinite(buyPrice) || buyPrice <= 0)) {
      return fail('Invalid recoveryBuyPrice');
    }

    // Serialize per sell on the store (shared by every importer instance) so
    // overlapping requests cannot both pass the buyOrderId check and place a
    // duplicate recovery buy while the first placement is still awaiting.
    return store.withSellLock(sellOrderId, () =>
      importSellLocked({ sellOrderId, existingBuyOrderId, note, placingRecoveryBuy, buyPrice }));
  };

  const importSellLocked = async ({ sellOrderId, existingBuyOrderId, note, placingRecoveryBuy, buyPrice }) => {
    const { fills: sellFills, error } = await fetchOrderFills(sellOrderId, 'sell');
    if (error) return fail(error);

    const invalidSell = validateAdapterFills(sellFills, sellOrderId, 'sell');
    if (invalidSell) return fail(invalidSell);
    // A linked existing buy must really be a buy of this fund's product before
    // anything is persisted (issue #1023).
    if (existingBuyOrderId) {
      const invalidLink = await verifyOrderIdentity(null, existingBuyOrderId, 'buy');
      if (invalidLink) return fail(invalidLink);
    }
    const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, sellFills, sellOrderId, 'sell');
    fillLedger.persist();

    // Idempotent by sellOrderId — a retry returns the existing record.
    let trade = store.addManualSell({
      sellOrderId,
      sellPrice: averagePrice(totalQuote, totalSize),
      sellSize: totalSize,
      sellQuoteAmount: totalQuote,
      sellTimestamp: legTimestamp(sellFills),
      sellFillTradeIds: tradeIds,
      note: note || '',
    });

    // An earlier placement whose outcome was never recorded (crash, restart,
    // transport error) may be live on the exchange. Resolve it before placing
    // or linking anything, so the checks below see the adopted order (#1058).
    if (placingRecoveryBuy || existingBuyOrderId) {
      const blocked = await resolvePendingIntent(trade.id);
      if (blocked) return fail(blocked);
      trade = store.getById(trade.id);
    }

    if (existingBuyOrderId) {
      if (trade.buyOrderId && trade.buyOrderId !== existingBuyOrderId) {
        const hint = trade.status === STATUS.BUY_CANCELLED ? ' (that buy is terminal — use Link replacement on the tracked trade instead)' : '';
        return fail(`Sell ${sellOrderId} is already associated with buy order ${trade.buyOrderId}; refusing to overwrite with ${existingBuyOrderId}${hint}`);
      }
      // Re-linking the order already on record is a retry, not a new attempt:
      // relinking would reopen a settled (filled or cancelled) order as pending.
      if (!trade.buyOrderId) {
        store.linkExistingBuy(trade.id, existingBuyOrderId);
        log.info(`ℹ️ 📝 [${exchange}] Manual trade: linked existing buy order ${existingBuyOrderId}`, { orderId: existingBuyOrderId });
      }
    } else if (placingRecoveryBuy && trade.buyOrderId) {
      // Operator retried an import whose recovery buy is already on the book.
      // Store idempotency alone does not stop a second placeLimitBuy here —
      // this guard is what prevents the duplicate live order.
      log.info(`ℹ️ 📝 [${exchange}] Manual trade: recovery buy ${trade.buyOrderId} already placed for sell ${sellOrderId} — skipping duplicate order`, { orderId: trade.buyOrderId, sellOrderId });
    } else if (placingRecoveryBuy) {
      // Recover exactly what was sold.
      const placed = await placeRecoveryBuy(trade, totalSize, buyPrice);
      if (!placed.success) return fail(placed.error);
    }

    return ok({ trade: store.getById(trade.id) });
  };

  /**
   * Ask the exchange whether a recorded recovery intent's order exists
   * (issue #1058) and settle the intent accordingly:
   *  - found and live/executed → adopt it as the trade's recovery buy;
   *  - positively absent, or off the book with no executions → release;
   *  - lookup failed or unsupported → keep blocking, with the reason recorded
   *    as the trade's lastCheck so the row explains why nothing was placed.
   * Callers must hold the sell's lock.
   * @param {Object} trade - Trade carrying a recoveryIntent
   * @param {{retryDelaysMs?: number[]}} [opts] - Retries a not-found lookup
   *   (only right after a placement, when the order may not be indexed yet)
   * @returns {Promise<{adopted?: boolean, released?: boolean, blocked?: boolean, orderId?: string, error?: string}>}
   */
  const reconcileRecoveryIntent = async (trade, { retryDelaysMs = [] } = {}) => {
    const intent = trade.recoveryIntent;
    const block = (reason) => {
      const error = `Recovery buy for sell ${trade.sellOrderId} (client order id ${intent.clientOrderId}) may already be on the exchange: ${reason}. No new buy will be placed until the exchange confirms it — retry once it is reachable, or check the exchange for that client order id`;
      store.recordCheck(trade.id, { error });
      log.warn(`⚠️ [${exchange}] Manual trade: ${error}`, { tradeId: trade.id, clientOrderId: intent.clientOrderId });
      return { blocked: true, error };
    };
    if (typeof adapter.findOrderByClientOrderId !== 'function') {
      return block(`${exchange} cannot look up orders by client order id`);
    }

    let found = null;
    for (let attempt = 0; ; attempt++) {
      try {
        found = await adapter.findOrderByClientOrderId(intent.clientOrderId, intent.productId);
      } catch (err) {
        return block(`the client order id lookup failed (${err.message})`);
      }
      if (found || attempt >= retryDelaysMs.length) break;
      await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
    }

    if (found && !found.orderId) return block('the exchange returned a match with no order id');
    if (found && !isNeverExecuted(found)) {
      store.recordRecoveryBuy(trade.id, found.orderId, intent.price, intent.size);
      log.warn(`⚠️ [${exchange}] Manual trade: adopted recovery buy ${found.orderId} (status ${found.status}) found by client order id ${intent.clientOrderId} — no duplicate placed`, {
        tradeId: trade.id,
        orderId: found.orderId,
        clientOrderId: intent.clientOrderId,
        status: found.status,
      });
      return { adopted: true, orderId: found.orderId };
    }

    const message = `Recovery buy with client order id ${intent.clientOrderId} ${found ? `is ${found.status} with no executions` : 'was never received by the exchange'} — released`;
    store.releaseRecoveryIntent(trade.id, message);
    log.info(`ℹ️ 📝 [${exchange}] Manual trade: ${message}`, {
      tradeId: trade.id,
      clientOrderId: intent.clientOrderId,
      status: found?.status ?? null,
    });
    return { released: true };
  };

  /**
   * Settle a trade's unrecorded recovery placement, if any, before a new
   * placement or link is considered. Callers must hold the sell's lock.
   * @param {string} tradeId
   * @returns {Promise<string|null>} Why the trade is still blocked, or null
   */
  const resolvePendingIntent = async (tradeId) => {
    const trade = store.getById(tradeId);
    if (!trade?.recoveryIntent) return null;
    const resolved = await reconcileRecoveryIntent(trade);
    return resolved.blocked ? resolved.error : null;
  };

  /**
   * Place a recovery buy for a sell-first trade behind a durable intent
   * (issue #1058). The intent, carrying a deterministic client order id, is
   * persisted before submission; an acceptance converts it into the trade's
   * recovery buy in one store write, a clean rejection releases it, and a
   * throw (whose order may still have landed) is reconciled by client order
   * id before reporting anything. Callers must hold the sell's lock and have
   * resolved any earlier intent.
   * @param {Object} trade - Sell-first trade with no recorded or pending buy
   * @param {number} size
   * @param {number} price
   * @returns {Promise<{success: boolean, orderId?: string, adopted?: boolean, error?: string}>}
   */
  const placeRecoveryBuy = async (trade, size, price) => {
    const productId = fundConfig?.productId || 'BTC-USDC';
    let intent;
    try {
      intent = store.recordRecoveryIntent(trade.id, { productId, size, price });
    } catch (err) {
      return { success: false, error: `Failed to record recovery buy intent; nothing was placed: ${err.message}` };
    }

    let result;
    let ambiguous = null;
    try {
      result = await adapter.placeLimitBuy(productId, size, price, { postOnly: false, clientOrderId: intent.clientOrderId });
      // Accepted without an id: the order may be live but cannot be tracked
      // by exchange id, so it is resolved by client id like a throw.
      if (result?.success && !result.orderId) ambiguous = 'accepted without an order id';
    } catch (err) {
      ambiguous = err.message;
    }
    if (ambiguous) {
      log.warn(`⚠️ [${exchange}] Manual trade: recovery buy placement outcome unknown (${ambiguous}) — reconciling by client order id ${intent.clientOrderId}`, {
        tradeId: trade.id,
        clientOrderId: intent.clientOrderId,
      });
      const resolved = await reconcileRecoveryIntent(store.getById(trade.id), { retryDelaysMs: recoveryLookupRetryDelaysMs });
      if (resolved.adopted) return { success: true, orderId: resolved.orderId, adopted: true };
      return { success: false, error: `Failed to place recovery buy: ${ambiguous}${resolved.blocked ? `. ${resolved.error}` : ''}` };
    }
    if (!result?.success) {
      store.releaseRecoveryIntent(trade.id);
      return { success: false, error: `Failed to place recovery buy: ${result?.errorMessage || 'unknown'}` };
    }
    store.recordRecoveryBuy(trade.id, result.orderId, price, size);
    log.info(`ℹ️ 📝 [${exchange}] Manual trade: placed recovery buy ${size} @ $${price} (orderId=${result.orderId})`, { orderId: result.orderId, buySize: size, buyPrice: price, clientOrderId: intent.clientOrderId });
    return { success: true, orderId: result.orderId };
  };

  /**
   * Reconcile every recovery intent left unresolved by a crash or restart
   * (issue #1058), so an order that reached the exchange becomes a tracked
   * pending buy without waiting for the operator to retry that sell. Each sell
   * resolves under its own lock; a failed lookup keeps that intent blocking.
   * @returns {Promise<Array<{tradeId: string, adopted?: boolean, released?: boolean, blocked?: boolean, error?: string}>>}
   */
  const recoverPendingRecoveryIntents = async () => {
    const results = [];
    for (const pending of store.getPendingRecoveryIntents()) {
      const result = await store.withSellLock(recoveryLockKey(pending), async () => {
        const trade = store.getById(pending.id);
        if (!trade?.recoveryIntent) return { released: true };
        return reconcileRecoveryIntent(trade);
      }).catch((err) => ({ blocked: true, error: err.message }));
      results.push({ tradeId: pending.id, ...result });
    }
    return results;
  };

  /**
   * Poll a pending recovery buy and settle it once the exchange reports it
   * terminal. A fill completes the trade; a cancellation (CANCELLED / EXPIRED /
   * FAILED) first ingests whatever the order executed, then leaves the trade
   * BUY_CANCELLED so retryRecovery can cover the remainder (issue #1034).
   * @param {Object} payload
   * @param {string} payload.tradeId
   */
  const checkPendingBuy = async ({ tradeId } = {}) => {
    if (!tradeId) return fail('tradeId is required');

    const trade = store.getById(tradeId);
    if (!trade) return fail(`Manual trade ${tradeId} not found`);
    // Shares importSell/retryRecovery's lock so an attempt is never settled
    // while a concurrent request is deciding whether to replace it.
    return store.withSellLock(recoveryLockKey(trade), () => checkPendingBuyLocked(tradeId));
  };

  const checkPendingBuyLocked = async (tradeId) => {
    const trade = store.getById(tradeId);
    if (trade.status !== STATUS.BUY_PENDING || !trade.buyOrderId) {
      return ok({ trade, message: 'No pending buy to check' });
    }
    const buyOrderId = trade.buyOrderId;
    // A failed or inconclusive check changes nothing but the row's explanation:
    // the association and BUY_PENDING stay, so the order is never forgotten.
    const checkFailed = (error) => {
      store.recordCheck(tradeId, { error });
      return fail(error);
    };
    const attempt = (trade.recoveryAttempts || []).find((a) => a.orderId === buyOrderId && !a.outcome);
    if (!attempt) return checkFailed(`Buy order ${buyOrderId} has no open recovery attempt on manual trade ${tradeId}`);

    let orderStatus;
    try {
      orderStatus = await adapter.getOrder(buyOrderId);
    } catch (err) {
      return checkFailed(`Failed to check buy order: ${err.message}`);
    }

    const normalizedStatus = (orderStatus?.status || '').toUpperCase();
    const filled = isFilledStatus(orderStatus);

    if (!filled && !isCancelledStatus(orderStatus)) {
      const message = `Buy order is ${normalizedStatus || 'UNKNOWN'}`;
      store.recordCheck(tradeId, { message });
      return ok({
        trade: store.getById(tradeId),
        orderStatus: normalizedStatus,
        filledPercent: orderStatus?.completionPercentage || 0,
        message,
      });
    }

    // Terminal either way: reconcile the order's own executions before deciding
    // what is still missing. A cancelled order can have partially executed.
    let buyFills;
    try {
      buyFills = (await adapter.getOrderFills(buyOrderId)) || [];
    } catch (err) {
      return checkFailed(`Buy order ${filled ? 'filled' : normalizedStatus} but failed to fetch fills: ${err.message}`);
    }
    if (filled && buyFills.length === 0) {
      return checkFailed(`Buy order filled but no fills found for order ${buyOrderId}`);
    }
    const mismatch = await verifyOrderIdentity(buyFills, buyOrderId, 'buy', orderStatus);
    if (mismatch) return checkFailed(mismatch);
    const invalidBuy = validateAdapterFills(buyFills, buyOrderId, 'buy');
    if (invalidBuy) return checkFailed(invalidBuy);
    const visibleSize = buyFills.reduce((sum, f) => sum + f.size, 0);
    // Executions the exchange admits to but no visible fill shows yet are
    // unverified, not zero — settling now could replace them and over-recover.
    // filledSize is authoritative; a response that reports progress only as a
    // percentage is sized from our own order (1% slack for increment dust).
    const completion = Number(orderStatus?.completionPercentage) || 0;
    const hasFilledSize = Number.isFinite(Number(orderStatus?.filledSize)) && orderStatus?.filledSize !== null && orderStatus?.filledSize !== undefined;
    const reportedSize = hasFilledSize ? Number(orderStatus.filledSize) : ((attempt.size || 0) * completion) / 100;
    const slack = hasFilledSize ? SIZE_EPSILON : Math.max(SIZE_EPSILON, (attempt.size || 0) * 0.01);
    if (reportedSize > visibleSize + slack) {
      return checkFailed(`Buy order ${buyOrderId} is ${normalizedStatus || 'FILLED'} with ${reportedSize} executed, but only ${visibleSize} is visible in its fills so far — check again before retrying`);
    }
    if (visibleSize <= SIZE_EPSILON && completion > 0) {
      return checkFailed(`Buy order ${buyOrderId} is ${normalizedStatus || 'FILLED'} at ${orderStatus.completionPercentage}% complete, but none of its fills are visible yet — check again before retrying`);
    }

    const remainingBefore = getUncoveredSize(trade);
    const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, buyFills, buyOrderId, 'buy');
    if (buyFills.length > 0) {
      // Pair the buy to its sell so it is not counted as an open position.
      fillLedger.annotateFillsByOrderId(buyOrderId, { sellOrderId: trade.sellOrderId });
    }
    fillLedger.persist();

    // An order we placed was sized to the remainder, so its fill completes the
    // recovery (the adapter floors size to the product increment, which can
    // leave sub-increment dust). A linked replacement is the operator's own
    // order and completes it only when its executions actually cover the rest.
    const coversByFill = filled && attempt.kind === 'placed';
    const remainingSize = coversByFill ? 0 : Math.max(0, Math.round((remainingBefore - totalSize) * 1e10) / 1e10);
    const statusLabel = normalizedStatus || 'FILLED';
    let message = 'Recovery buy filled';
    if (!coversByFill && remainingSize <= SIZE_EPSILON) {
      message = `Recovery buy ${buyOrderId} was ${statusLabel} after recovering the full quantity`;
    } else if (!coversByFill && totalSize > 0) {
      message = `Recovery buy ${buyOrderId} was ${statusLabel} after executing ${totalSize}; ${remainingSize} still to recover`;
    } else if (!coversByFill) {
      message = `Recovery buy ${buyOrderId} was ${statusLabel} with no executions; retry or link a replacement`;
    }
    const settled = store.settleRecoveryAttempt(tradeId, {
      outcome: filled ? 'filled' : 'cancelled',
      exchangeStatus: statusLabel,
      completesRecovery: coversByFill,
      filledSize: totalSize,
      filledQuote: totalQuote,
      fillTradeIds: tradeIds,
      message,
    });
    if (!settled) return checkFailed(`Buy order ${buyOrderId} has no open recovery attempt on manual trade ${tradeId}`);

    if (settled.status === STATUS.COMPLETED) {
      log.info(`ℹ️ ✅ [${exchange}] Manual trade completed: sold ${trade.sellSize} @ $${trade.sellPrice.toFixed(2)}, bought back ${settled.buySize} @ $${settled.buyPrice.toFixed(2)}`, {
        tradeId,
        buyOrderId,
        sellOrderId: trade.sellOrderId,
        buySize: settled.buySize,
        buyPrice: settled.buyPrice,
      });
      return ok({ trade: settled, filled, completed: true, message });
    }

    log.warn(`⚠️ [${exchange}] Manual trade: ${message}`, { tradeId, buyOrderId, sellOrderId: trade.sellOrderId, recoveredSize: totalSize, remainingSize });
    return ok({ trade: settled, cancelled: true, recoveredSize: totalSize, remainingSize, message });
  };

  /**
   * Continue a sell-first recovery whose earlier attempt is confirmed terminal
   * (issue #1034): place a new buy for exactly the uncovered remainder, or link
   * a validated replacement order. The original sell, its ledger rows and the
   * earlier attempts' history are untouched.
   * @param {Object} payload
   * @param {string} payload.tradeId
   * @param {string|number} [payload.recoveryBuyPrice] - Limit price for a new buy
   * @param {string} [payload.existingBuyOrderId] - Already-placed replacement to link instead
   */
  const retryRecovery = async ({ tradeId, recoveryBuyPrice, existingBuyOrderId } = {}) => {
    if (!tradeId) return fail('tradeId is required');
    const hasPrice = recoveryBuyPrice !== undefined && recoveryBuyPrice !== null && recoveryBuyPrice !== '';
    const linking = existingBuyOrderId !== undefined && existingBuyOrderId !== null && existingBuyOrderId !== '';
    if (hasPrice === linking) return fail('Provide exactly one of recoveryBuyPrice or existingBuyOrderId');
    if (linking && (typeof existingBuyOrderId !== 'string' || !existingBuyOrderId.trim())) {
      return fail('existingBuyOrderId must be a non-blank string');
    }
    const buyPrice = linking ? 0 : Number(recoveryBuyPrice);
    if (!linking && (!Number.isFinite(buyPrice) || buyPrice <= 0)) return fail('Invalid recoveryBuyPrice');

    const trade = store.getById(tradeId);
    if (!trade) return fail(`Manual trade ${tradeId} not found`);
    return store.withSellLock(recoveryLockKey(trade), () => (linking
      ? linkReplacementLocked(tradeId, existingBuyOrderId.trim())
      : placeReplacementLocked(tradeId, buyPrice)));
  };

  const placeReplacementLocked = async (tradeId, buyPrice) => {
    // An adopted earlier placement leaves the trade BUY_PENDING, which the
    // refusal below then reports instead of placing beside it (issue #1058).
    const blocked = await resolvePendingIntent(tradeId);
    if (blocked) return fail(blocked);
    const trade = store.getById(tradeId);
    const refusal = recoveryRefusal(trade);
    if (refusal) return fail(refusal);

    const placed = await placeRecoveryBuy(trade, getUncoveredSize(trade), buyPrice);
    if (!placed.success) return fail(placed.error);
    return ok({ trade: store.getById(trade.id), placed: true });
  };

  const linkReplacementLocked = async (tradeId, buyOrderId) => {
    const blocked = await resolvePendingIntent(tradeId);
    if (blocked) return fail(blocked);
    const trade = store.getById(tradeId);
    const refusal = recoveryRefusal(trade);
    if (refusal) return fail(refusal);

    if (trade.recoveryAttempts.some((a) => a.orderId === buyOrderId)) {
      return fail(`Buy order ${buyOrderId} was already used by this recovery`);
    }

    let order;
    try {
      order = await adapter.getOrder(buyOrderId);
    } catch (err) {
      return fail(`Could not validate replacement buy ${buyOrderId}: ${err.message}`);
    }
    if (!order) return fail(`Could not validate replacement buy ${buyOrderId}: no order returned`);
    // Fail closed: an order whose side or product the exchange did not report
    // could be another asset's buy, whose fills would then close this sell.
    const side = String(order.side || '').toUpperCase();
    if (side !== 'BUY') return fail(`Order ${buyOrderId} is ${side ? `a ${side} order` : 'not verifiably a buy'}; only a buy can recover this sell`);
    const productId = fundConfig?.productId || 'BTC-USDC';
    if (productKey(order.productId) !== productKey(productId)) {
      return fail(`Order ${buyOrderId} is for ${order.productId || 'an unreported product'}, not this fund's ${productId}`);
    }
    const executed = Number(order.filledSize) || 0;
    if (isCancelledStatus(order) && executed <= SIZE_EPSILON) {
      return fail(`Replacement buy ${buyOrderId} is already ${String(order.status).toUpperCase()} with no executions — it cannot recover anything`);
    }
    // getOrder does not report an order's full size, but once it has executed
    // anything the completion percentage reveals it; refuse one that would
    // over-recover. (An untouched open order cannot be sized this way.)
    const completion = Number(order.completionPercentage) || 0;
    const orderSize = completion > 0 ? Math.max(executed, (executed * 100) / completion) : executed;
    const remaining = getUncoveredSize(trade);
    if (orderSize > remaining + SIZE_EPSILON) {
      return fail(`Replacement buy ${buyOrderId} is for ${orderSize}, more than the ${remaining} still to recover`);
    }
    // Checked after the await, synchronously with the link below, so two
    // sells racing to link the same order cannot both claim it.
    const owner = store.getAll().find((t) => t.id !== trade.id
      && (t.buyOrderId === buyOrderId || (t.recoveryAttempts || []).some((a) => a.orderId === buyOrderId)));
    if (owner) return fail(`Buy order ${buyOrderId} already belongs to manual trade ${owner.id}`);

    store.linkExistingBuy(trade.id, buyOrderId);
    log.info(`ℹ️ 📝 [${exchange}] Manual trade: linked replacement recovery buy ${buyOrderId}`, { tradeId, orderId: buyOrderId, remaining });
    return ok({ trade: store.getById(trade.id), linked: true });
  };

  /** Whether a live/persisted body owns this buy order (by id or bookkeeping). */
  const bodyOwnsOrder = (body, bodyId, buyOrderId) => body.id === bodyId
    || body.sourceOrderIds?.includes(buyOrderId)
    || body.buyOrders?.some((order) => order.orderId === buyOrderId);

  /**
   * Persist a freshly created body when no engine is running. The engine picks
   * it up on next start and places its take-profit order. Idempotent for a
   * resumed intent (issue #1022): a body already on disk for this buy — same
   * id, or a survivor that absorbed it — is returned instead of pushed again.
   * @returns {{bodyId: string, tier: string}|null} The body on disk, or null
   *   when there is no position state to persist into
   */
  const persistBodyToDisk = (body) => {
    const saved = loadRegimeState(exchange, pair);
    if (!saved.position) return null;
    saved.position.celestialBodies = saved.position.celestialBodies || [];
    const existing = saved.position.celestialBodies.find((b) => bodyOwnsOrder(b, body.id, body.sourceOrderIds?.[0]));
    if (existing) return { bodyId: existing.id, tier: existing.tier };
    saved.position.celestialBodies.push(body);
    syncPositionState(saved.position, saved.position.celestialBodies);
    saveRegimeState(saved.position, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, pair);
    return { bodyId: body.id, tier: body.tier };
  };

  /**
   * Find the body that durably owns this buy (issue #1022). A ledger bodyId
   * alone is NOT proof — the pre-#1022 importer stamped one optimistically
   * before any body was saved. Two kinds of evidence count:
   *  - live: a body on regime-state.json owns the order (by id, or through
   *    sourceOrderIds/buyOrders after a merge);
   *  - retired: a body sale demonstrably consumed THIS buy — a per-sell
   *    `consumedBy` entry (written only when a body sale books against the
   *    buy) naming a booked sell, or the buy's sellOrderId naming a sell
   *    booked to this buy's own body identity (the intent's id or a bodyId
   *    on its rows, which merges re-stamp). Linkage alone is NOT evidence:
   *    recalculateCycles stamps a cycle's sell — possibly another body's
   *    sale — onto every buy of a >=50%-sold cycle for display, and the
   *    legacy closure seal derives `consumedBy.__legacy__` from that link.
   * Every path that removes a body books a TP sale first, so this separates a
   * legitimately sold body — which must never be recreated — from one that was
   * never committed.
   * @param {string} buyOrderId
   * @param {string|null|undefined} bodyId - Expected id (intent or ledger)
   * @returns {{bodyId: string, tier?: string, live: boolean}|null}
   */
  const findCommittedBody = (buyOrderId, bodyId) => {
    const persisted = loadRegimeState(exchange, pair).position?.celestialBodies
      ?.find((body) => bodyOwnsOrder(body, bodyId, buyOrderId));
    if (persisted) return { bodyId: persisted.id, tier: persisted.tier, live: true };
    const rows = fillLedger.getFillsForOrder(buyOrderId);
    const ownBodyIds = new Set([bodyId, ...rows.map((row) => row.bodyId)].filter(Boolean));
    const bookedSale = (sellOrderId, acceptBody) => fillLedger.getFillsForOrder(sellOrderId)
      .find((row) => row.side === 'sell' && row.bodyId && acceptBody(row.bodyId));
    for (const row of rows) {
      for (const [sellOrderId, qty] of Object.entries(row.consumedBy || {})) {
        if (sellOrderId === LEGACY_CONSUMPTION_KEY || !(Number(qty) > 0)) continue;
        const booked = bookedSale(sellOrderId, () => true);
        if (booked) return { bodyId: booked.bodyId, live: false };
      }
    }
    for (const sellOrderId of new Set(rows.map((row) => row.sellOrderId).filter(Boolean))) {
      const booked = bookedSale(sellOrderId, (id) => ownBodyIds.has(id));
      if (booked) return { bodyId: booked.bodyId, live: false };
    }
    return null;
  };

  /**
   * Extend a body already persisted to regime-state.json (engine not
   * running) with fills that arrived after it was first written (issue
   * #726 — mirrors regime-engine's own extendBody for the running-engine
   * case). Unlike that case, this path has no adapter/executor to safely
   * cancel a resting TP with — a persisted body CAN already carry a real
   * `tpOrderId` (placed while the engine was running, before it was
   * stopped) — so instead of touching it directly, a body that already has
   * one is flagged `needsTpReprice: true`. The engine's existing "startup
   * reprice" pass (regime-engine.js, cancelBodyTpForReplace / issue #670)
   * picks that flag up on next start and cancels+re-places through the
   * adapter it has there, exactly as it already does for an overpriced TP%
   * (codex delta review — leaving a stale TP in place would otherwise
   * silently understate its assetOnOrder relative to the grown assetQty
   * beyond the system's planned holdback fraction, per CLAUDE.md). A body
   * with no tpOrderId yet needs no flag — the engine's normal
   * ensureTakeProfitPlaced pass places one fresh, already sized correctly
   * from the grown assetQty.
   *
   * Idempotent the same way regime-engine's extendBody is, INCLUDING across
   * compounding retries where more of the order fills again before the
   * ledger link ever lands (codex review, round 3 — a naive delta-based
   * idempotency check still double-counted an already-applied portion in
   * that case). `totals` is therefore the buy order's FULL current totals —
   * every fill known for it, linked or not — not a delta. The exact
   * shortfall (what `totals` says should be recorded, minus what this
   * body's own `buyOrders` bookkeeping already shows recorded for that
   * orderId) is what actually gets merged, so however many times this is
   * called for the same buyOrderId the body converges to exactly `totals`,
   * never more.
   * @param {string} bodyId - Body to extend, as previously written by persistBodyToDisk
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals - buyOrderId's FULL current fill totals (not a delta)
   * @param {string} buyOrderId - The buy order `totals` describes
   * @returns {{success: boolean, bodyId?: string, tier?: string, error?: string, alreadyApplied?: boolean, needsTpReprice?: boolean}}
   */
  const extendPersistedBody = (bodyId, totals, buyOrderId) => {
    const saved = loadRegimeState(exchange, pair);
    if (!saved.position) return { success: false, error: 'No position state on disk' };
    const body = (saved.position.celestialBodies || []).find((b) => b.id === bodyId);
    if (!body) return { success: false, error: 'Body not found' };
    const { shortfall } = computeBuyOrderShortfall(body, totals, buyOrderId);
    if (!shortfall) {
      return { success: true, bodyId: body.id, tier: body.tier, alreadyApplied: true, needsTpReprice: !!body.needsTpReprice };
    }
    // maxUsdcDeployed lives in the regime config (adjusted at cycle-completion
    // time), not fundConfig — fetch it fresh rather than trusting a
    // constructor-time snapshot, since the engine (persisting its own
    // adjustments via updateRegimeConfig) is, by definition, not running on
    // this path.
    const { maxUsdcDeployed } = getRegimeConfig(exchange, pair);
    mergeIntoBody(body, shortfall, maxUsdcDeployed, buyOrderId, log);
    const hadTp = !!body.tpOrderId;
    if (hadTp) body.needsTpReprice = true;
    syncPositionState(saved.position, saved.position.celestialBodies);
    saveRegimeState(saved.position, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, pair);
    return { success: true, bodyId: body.id, tier: body.tier, needsTpReprice: hadTp };
  };

  /**
   * Buy-first import: record a manual buy and, by default, turn it into a
   * celestial body so the engine places a take-profit against it.
   *
   * Idempotent by buyOrderId end-to-end (issue #691): a retry (IPC timeout,
   * or a thrown injectBody after the ledger/store writes) returns the
   * already-imported trade with `alreadyImported: true` instead of creating
   * a second body and placing a second live TP sell for the same fill.
   *
   * Recoverable end-to-end (issue #1022): body creation is a durable intent
   * on the trade record, written before the body is published. The body is
   * saved BEFORE the ledger is stamped with its ownership or the trade moves
   * to TP_PENDING, and an interrupted intent is resumed — with the same body
   * identity — on the next import of the buy or on recoverPendingBodyIntents.
   * Creation and recovery for one buy are serialized on the shared store.
   *
   * @param {Object} payload
   * @param {string} payload.buyOrderId
   * @param {string} [payload.note]
   * @param {boolean} [payload.createBody=true]
   */
  const importBuy = async (payload = {}) => {
    const { buyOrderId, note } = payload;
    if (!buyOrderId) return fail('buyOrderId is required');

    // Validate before the first ledger/store mutation (issue #423's ordering
    // contract, extended to this flag by issue #454): createBody selects
    // between ledger-only import and injecting/persisting a body that may
    // place a live TP order, so a non-boolean (e.g. the string "false") must
    // never reach that branch.
    const createBodyFlag = readBooleanFlag(payload, 'createBody', true);
    if (createBodyFlag.error) return fail(createBodyFlag.error);
    const createBody = createBodyFlag.value;

    return store.withBuyLock(buyOrderId, () => importBuyLocked({ buyOrderId, note, createBody }));
  };

  const importBuyLocked = async ({ buyOrderId, note, createBody }) => {
    const { fills: buyFills, error } = await fetchOrderFills(buyOrderId, 'buy');
    if (error) return fail(error);

    const invalidBuy = validateAdapterFills(buyFills, buyOrderId, 'buy');
    if (invalidBuy) return fail(invalidBuy);
    const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, buyFills, buyOrderId, 'buy');
    fillLedger.persist();

    const avgBuyPrice = averagePrice(totalQuote, totalSize);
    // Idempotent by buyOrderId — a retry returns the existing record.
    // Keep the store's pre-import snapshot separate from the newly-created
    // record. A terminal engine fill can already own this order in a body
    // before its first manual-import record exists; using the just-created
    // full exchange totals as the body's prior quantity would hide the excess
    // tranche from the idempotent body extension below.
    const existingTrade = store.getAll().find((row) => row.buyOrderId === buyOrderId) || null;
    const trade = store.addManualBuy({
      buyOrderId,
      buyPrice: avgBuyPrice,
      buySize: totalSize,
      buyQuoteAmount: totalQuote,
      buyTimestamp: legTimestamp(buyFills),
      buyFillTradeIds: tradeIds,
      note: note || '',
    });

    // An interrupted body creation resumes BEFORE anything below reads
    // ownership (issue #1022): either its body is found/proven and linked, or
    // it is published now under the same identity. Growth since the intent was
    // written is then handled by the extend path below like any other retry.
    if (trade.bodyIntent?.phase === INTENT_PHASE.PENDING) {
      const resumed = await resumeBodyIntent(trade);
      if (!resumed.success) return fail(resumed.error);
    }

    // Retry guard (issue #691, mirrors importSell's #423 guard): addManualBuy
    // is idempotent at the STORE layer, but a retry that reaches this point
    // would still create and inject a SECOND body for the same fill, placing
    // a second live TP sell that eats into other bodies' inventory. A body
    // was already created for this trade iff bodyId is set (markTpPlaced
    // stamps it right after the first successful injectBody/persistBodyToDisk
    // below) or the status already advanced to TP_PENDING.
    const orderRows = fillLedger.getFillsForOrder(buyOrderId);
    const ledgerBodyId = orderRows.find((row) => row.bodyId)?.bodyId;
    // A crash after persisting a body but before markTpPlaced leaves the
    // store without its bodyId. The ledger normally retains the link; the
    // persisted body's order bookkeeping also recovers a missing annotation.
    const persistedBodyId = !trade.bodyId && !ledgerBodyId
      ? loadRegimeState(exchange, pair).position?.celestialBodies?.find((body) => bodyOwnsOrder(body, null, buyOrderId))?.id
      : null;
    let currentBodyId = ledgerBodyId || trade.bodyId || persistedBodyId;
    if (currentBodyId || trade.status === STATUS.TP_PENDING) {
      // A prior manual import of this buy that never committed a body intent
      // may have left only the pre-#1022 optimistic ledger stamp (or a
      // TP_PENDING status derived from it) with no body behind it. Prove a
      // body was committed before reporting success; otherwise fail
      // retryably rather than claim managed inventory and a pending TP that
      // nothing owns (issue #1022).
      if (existingTrade && trade.bodyIntent?.phase !== INTENT_PHASE.COMMITTED) {
        const committed = findCommittedBody(buyOrderId, currentBodyId);
        if (!committed) {
          log.warn(`⚠️ [${exchange}] Manual buy import: buy ${buyOrderId} claims body ${currentBodyId || '(none)'} but no committed body or retirement evidence exists — refusing to report it imported`, {
            bodyId: currentBodyId,
            buyOrderId,
          });
          return fail(`Buy ${buyOrderId} claims body ${currentBodyId || '(none)'}, but no saved body or closed-body evidence was found; the import was not completed and can be retried once ownership is repaired`);
        }
        // A live body on disk is the authoritative owner — a merge survivor
        // replaces whatever stale id the ledger or trade record still names.
        currentBodyId = committed.live ? committed.bodyId : (currentBodyId || committed.bodyId);
      }
      // The buy order may have still been FILLING when the body above was
      // created — ingestAdapterFills already wrote any fills that arrived
      // since into the ledger (it runs unconditionally, before this guard).
      // Detect and reconcile that gap instead of silently dropping it
      // (issue #726) — the additional asset is real and owned; leaving it
      // out makes it invisible to the position model and to every future
      // retry, which would keep re-detecting the identical gap forever.
      //
      // Gate on the DURABLE bookkeeping — trade.buySize (refreshed below,
      // on every successful reconciliation) vs the ledger's current full
      // fill total — NOT on a ledger row's bodyId (codex delta review,
      // round 4). A row's bodyId is not a reliable "already reconciled"
      // signal on its own: placeBodyTp's TP-placement annotation, the
      // startup re-annotator, and Collapse-All's re-stamp (regime-engine.js)
      // all blanket-stamp bodyId onto EVERY row for an orderId once a body
      // exists for it — including a fill that arrived AFTER the body's
      // assetQty was last grown (a slow sync-fills ingest, or a crash
      // between this fill's ingest+persist and a PRIOR extend's own save).
      // Such a row would already show a bodyId despite the body never
      // having actually absorbed it, and the old unlinked-row check would
      // have taken the fast path below and hidden the gap for good.
      const fullQty = orderRows.reduce((sum, r) => sum + r.size, 0);
      const priorRecordedQty = existingTrade ? (existingTrade.buySize || 0) : 0;

      const linkTrade = () => {
        if (currentBodyId && (currentBodyId !== trade.bodyId || trade.bodyIntent?.phase !== INTENT_PHASE.COMMITTED)) {
          store.markTpPlaced(trade.id, currentBodyId);
        }
      };

      if (fullQty <= priorRecordedQty + 0.00000001) {
        linkTrade();
        // Identity/economic replacement can change cost without new inventory.
        // The ledger's durable journal already reconciled the body; refresh the
        // import record from its full totals, including unresolved coverage.
        const fullQuote = orderRows.reduce((sum, row) => sum + row.quoteAmount, 0);
        store.refreshBuyTotals(trade.id, {
          buyPrice: averagePrice(fullQuote, fullQty), buySize: fullQty,
          buyQuoteAmount: fullQuote, buyFillTradeIds: orderRows.map(row => row.tradeId),
        });
        log.info(`ℹ️ 📦 [${exchange}] Manual buy import: buy ${buyOrderId} already has body ${currentBodyId} — skipping duplicate body creation`, {
          bodyId: currentBodyId,
          buyOrderId,
        });
        return ok({ trade: store.getById(trade.id), alreadyImported: true });
      }

      // extendBody/extendPersistedBody take the buy order's FULL current
      // totals (every row) rather than a delta — a delta-only idempotency
      // check still double-counts an already-applied portion when MORE
      // fills arrive before a crashed extend's retry (codex review, round
      // 3: extend #1 applies d1 but crashes before the ledger link; if d2
      // arrives before the retry, a delta of d1+d2 would re-add the
      // already-applied d1). Both functions compute the exact shortfall
      // themselves — `totals` minus what the body's own `buyOrders`
      // bookkeeping already recorded for this orderId — so however many
      // times this runs for the same buyOrderId, the body converges to
      // exactly `totals`, never more.
      //
      // Ledger rows carry `quoteAmount` (price × size) and `netFee` (fee
      // net of rebate) — the SAME convention the body-creation path below
      // now also sources its initial costBasis from (codex delta review:
      // the two used to disagree — creation summed gross adapter commission
      // while this summed net-of-rebate ledger fee — so a shortfall
      // computed as `totals.costBasis - recorded.cost` could absorb that
      // mismatch and go negative on a tiny extra fill).
      const fullQuote = orderRows.reduce((sum, r) => sum + r.quoteAmount, 0);
      const fullCostBasis = orderRows.reduce((sum, r) => sum + r.quoteAmount + r.netFee, 0);
      const totals = { assetQty: fullQty, costBasis: fullCostBasis, avgPrice: averagePrice(fullQuote, fullQty) };
      const growthQty = fullQty - priorRecordedQty; // for logging only

      // Attempt the extend BEFORE linking anything (codex review): linking
      // the ledger rows to currentBodyId unconditionally, win or lose, would
      // make a FAILED extend permanently unrecoverable.
      const extended = extendBody
        ? await extendBody(currentBodyId, totals, buyOrderId)
        : extendPersistedBody(currentBodyId, totals, buyOrderId);

      if (!extended.success) {
        // The body couldn't absorb the growth — most likely its TP fully
        // closed and it was spliced out of the live position between the
        // first import and this retry, or (engine running) its existing TP
        // sold a tranche during the cancel-for-replace race and needs to
        // settle before another attempt. Leave the ledger and trade record
        // exactly as they were — trade.buySize is the gate above, so a
        // future retry re-detects this same gap and tries again once it's
        // fixable — and fail the call outright rather than reporting
        // success: the caller (the admin import UI) treats `success: true`
        // as "done, remove this order from the unaccounted list," which
        // would permanently hide an asset that ended up nowhere.
        log.warn(`⚠️ [${exchange}] Manual buy import: buy ${buyOrderId} has ${growthQty} new fill(s) beyond body ${currentBodyId}, but that body could not be extended (${extended.error || 'not found'}) — leaving the import retryable`, {
          bodyId: currentBodyId,
          buyOrderId,
          growthQty,
          error: extended.error,
        });
        return fail(`Failed to extend body ${currentBodyId} with ${growthQty} additional fill(s) for buy ${buyOrderId}: ${extended.error || 'body not found'}`);
      }

      // Extend succeeded — NOW link the new rows to the body's current
      // (post-merge-aware) id, keep the trade record's own bodyId pointer in
      // sync, and refresh its recorded buy totals to the FULL current fill
      // set (totalSize/totalQuote/avgBuyPrice/tradeIds, computed above from
      // every fill fetched this call) instead of leaving them stuck at
      // whatever partial amount was known when the trade was first created
      // (issue #726 codex review). Refreshing buySize is also what makes
      // the durable gate above work on the NEXT retry.
      fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: currentBodyId, isBodyOwned: true, isSatellite: true, bodyTier: extended.tier });
      fillLedger.persist();
      linkTrade();
      store.refreshBuyTotals(trade.id, {
        buyPrice: avgBuyPrice,
        buySize: totalSize,
        buyQuoteAmount: totalQuote,
        buyFillTradeIds: tradeIds,
      });
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: buy ${buyOrderId} extended body ${currentBodyId} with ${growthQty} additional fill(s) instead of creating a duplicate${extended.needsTpReprice ? ' (TP reprice deferred to next engine start)' : ''}`, {
        bodyId: currentBodyId,
        buyOrderId,
        growthQty,
        needsTpReprice: !!extended.needsTpReprice,
      });

      return ok({ trade: store.getById(trade.id), alreadyImported: true, extended: true, needsTpReprice: !!extended.needsTpReprice });
    }

    // The durable close-check for a body that closed between attempts lives
    // in the guard above now: any ledger bodyId routes there, and an
    // unconfirmed one must be proven by findCommittedBody (issue #1022).
    if (!createBody) return ok({ trade: store.getById(trade.id) });

    // Source cost basis from the ledger's own `quoteAmount + netFee` rows —
    // NOT gross adapter commission summed from raw buyFills — to match the
    // exact convention the retry-guard's extend path above (and every other
    // ledger-row reducer in this codebase, e.g. fill-ledger.js:811) uses. A
    // mismatched convention here (gross vs net-of-rebate) would make a later
    // extend's `shortfall.costBasis = totals.costBasis - recorded.cost`
    // absorb the gross/net difference on these very first fills, and could
    // go negative on a small extra fill (codex delta review).
    const createdRows = fillLedger.getFillsForOrder(buyOrderId);
    const costBasis = createdRows.reduce((sum, r) => sum + r.quoteAmount + r.netFee, 0);
    const body = createNewBody({
      assetQty: totalSize,
      costBasis,
      avgPrice: avgBuyPrice,
    }, buyOrderId);

    // Durable intent FIRST (issue #1022): from here on every interruption —
    // a crash, a thrown injectBody, an ENOSPC publishing regime-state.json —
    // resumes this exact body rather than leaving ledger ownership with no
    // body behind it.
    const intentTrade = store.recordBodyIntent(trade.id, body);
    const published = await publishBodyIntent(intentTrade);
    if (!published.success) return fail(published.error);
    return ok({ trade: store.getById(trade.id), ...(published.duplicate ? { alreadyImported: true } : {}) });
  };

  /**
   * Commit a body intent once its body is durable (or proven retired): stamp
   * the buy's ledger rows with that body's ownership, then move the trade to
   * TP_PENDING and seal the intent. Ownership is written strictly AFTER the
   * body exists (issue #1022), and both writes are idempotent, so a crash
   * between them is finished by the next resume.
   * @param {Object} trade
   * @param {string} bodyId
   * @param {{tier?: string, annotate?: boolean}} [opts]
   */
  const commitBodyIntent = (trade, bodyId, { tier, annotate = true } = {}) => {
    if (annotate) {
      fillLedger.annotateFillsByOrderId(trade.buyOrderId, {
        bodyId, isBodyOwned: true, isSatellite: true, ...(tier ? { bodyTier: tier } : {}),
      });
      fillLedger.persist();
    }
    store.markTpPlaced(trade.id, bodyId);
    return { success: true, bodyId };
  };

  /**
   * Publish a pending intent's body — into the running engine, or onto
   * regime-state.json when none is up — and commit it.
   * @param {Object} trade - Trade carrying a pending bodyIntent
   * @returns {Promise<{success: boolean, bodyId?: string, duplicate?: boolean, error?: string}>}
   */
  const publishBodyIntent = async (trade) => {
    const { buyOrderId } = trade;
    // A fresh copy every attempt: the engine mutates the body it accepts, and
    // the stored payload must stay exactly what the intent recorded.
    const body = JSON.parse(JSON.stringify(trade.bodyIntent.body));

    if (injectBody) {
      const injectResult = await injectBody(body);
      // injectBody's own defense-in-depth (regime-engine.js) refuses a body
      // whose id or originating buy order already exists among the live
      // bodies — e.g. an earlier attempt pushed it and then threw. Never
      // point the trade/ledger at a refused phantom; link the real body the
      // engine already holds instead.
      if (injectResult && injectResult.success === false && injectResult.bodyId) {
        log.warn(`⚠️ [${exchange}] Manual buy import: buy ${buyOrderId} injectBody refused a duplicate — linked to existing body ${injectResult.bodyId}`, {
          bodyId: injectResult.bodyId,
          intentBodyId: body.id,
          buyOrderId,
        });
        return { ...commitBodyIntent(trade, injectResult.bodyId), duplicate: true };
      }
      // Any other refusal (e.g. 'Engine not running' from a race with
      // regime:start/stop) means the body was NEVER pushed and has no live TP.
      // Keep the durable intent so the row remains actionable after reload.
      // Never mark TP_PENDING against a body nothing tracks.
      if (injectResult && injectResult.success === false) {
        log.warn(`⚠️ [${exchange}] Manual buy import: injectBody failed for buy ${buyOrderId} (${injectResult.error || 'unknown error'}) — leaving the trade retryable`, {
          buyOrderId,
          error: injectResult.error,
        });
        return { success: false, error: `Failed to inject body: ${injectResult.error || 'unknown error'}` };
      }
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: injected body ${body.id} into running engine (TP placed: ${injectResult?.tpPlaced})`, {
        bodyId: body.id,
        buyOrderId,
        tpPlaced: injectResult?.tpPlaced,
      });
      return commitBodyIntent(trade, body.id, { tier: body.tier });
    }

    const persisted = persistBodyToDisk(body);
    if (!persisted) {
      // Nothing was saved. Keep the authorized import pending for retry once
      // its position state is available, including after a page reload.
      log.warn(`⚠️ [${exchange}] Manual buy import: no position state for body ${body.id} — leaving the trade retryable`, {
        bodyId: body.id,
        buyOrderId,
      });
      return { success: false, error: `Failed to persist body: no position state for ${exchange}/${pair}` };
    }
    log.info(`ℹ️ 📦 [${exchange}] Manual buy import: saved body ${persisted.bodyId} to disk (engine not running, TP will be placed on start)`, {
      bodyId: persisted.bodyId,
      buyOrderId,
    });
    return commitBodyIntent(trade, persisted.bodyId, { tier: persisted.tier });
  };

  /**
   * Resume an interrupted body intent (issue #1022). A body already durable
   * for the buy, or proven retired by a sale, is linked as-is — never
   * re-published, so replay cannot resurrect sold inventory. Otherwise the
   * body never committed and is published now under its recorded identity.
   * @param {Object} trade - Trade carrying a pending bodyIntent
   */
  const resumeBodyIntent = async (trade) => {
    const committed = findCommittedBody(trade.buyOrderId, trade.bodyIntent.bodyId);
    if (committed) {
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: resumed intent for buy ${trade.buyOrderId} — body ${committed.bodyId} already ${committed.live ? 'saved' : 'retired'}, linking it`, {
        bodyId: committed.bodyId,
        buyOrderId: trade.buyOrderId,
      });
      return commitBodyIntent(trade, committed.bodyId, { tier: committed.tier, annotate: committed.live });
    }
    log.warn(`⚠️ [${exchange}] Manual buy import: resuming interrupted body creation for buy ${trade.buyOrderId} (body ${trade.bodyIntent.bodyId})`, {
      bodyId: trade.bodyIntent.bodyId,
      buyOrderId: trade.buyOrderId,
    });
    // The persisted intent is the page's recovery handle. A repeated refusal
    // must not erase it and strand this already-imported buy after reload.
    return publishBodyIntent(trade);
  };

  /**
   * Finish exactly one interrupted buy import from its durable body payload.
   * Unlike importing the exchange order again, this requires no fill lookup
   * and cannot report a completed publication as failed because that read is
   * unavailable. A stale retry of a committed intent is a no-op.
   * @param {{tradeId?: string}} [payload]
   */
  const resumeBodyImport = async (payload = {}) => {
    const tradeId = payload?.tradeId;
    if (typeof tradeId !== 'string' || !tradeId.trim()) return fail('tradeId must be a non-blank string');
    const trade = store.getById(tradeId);
    if (!trade) return fail(`Manual trade ${tradeId} not found`);
    if (trade.tradeType !== 'buy_first' || !trade.buyOrderId) return fail(`Manual trade ${tradeId} is not a buy import`);

    return store.withBuyLock(trade.buyOrderId, async () => {
      const current = store.getById(tradeId);
      if (current?.bodyIntent?.phase === INTENT_PHASE.COMMITTED) {
        return ok({ trade: current, alreadyImported: true });
      }
      if (current?.bodyIntent?.phase !== INTENT_PHASE.PENDING) {
        return fail(`Manual trade ${tradeId} has no interrupted body import to resume`);
      }
      try {
        const result = await resumeBodyIntent(current);
        if (!result.success) return fail(result.error);
        return ok({ trade: store.getById(tradeId) });
      } catch (err) {
        return fail(`Could not resume body import: ${err.message}`);
      }
    });
  };

  /**
   * Resume every interrupted body intent for this fund (issue #1022). Run
   * before new import work so a crashed import is healed on cold start even
   * when the operator never retries that exact buy. Each buy resumes under
   * its own lock; one failure never blocks the others.
   * @returns {Promise<Array<{buyOrderId: string, success: boolean, bodyId?: string, error?: string}>>}
   */
  const recoverPendingBodyIntents = async () => {
    const results = [];
    for (const pending of store.getPendingBodyIntents()) {
      const { buyOrderId } = pending;
      const result = await store.withBuyLock(buyOrderId, async () => {
        const trade = store.getById(pending.id);
        if (trade?.bodyIntent?.phase !== INTENT_PHASE.PENDING) return { success: true, bodyId: trade?.bodyId };
        return resumeBodyIntent(trade);
      }).catch((err) => ({ success: false, error: err.message }));
      if (!result.success) {
        log.warn(`⚠️ [${exchange}] Manual buy import: recovery of buy ${buyOrderId} did not complete (${result.error}) — will retry`, {
          buyOrderId,
          error: result.error,
        });
      }
      results.push({ buyOrderId, ...result });
    }
    return results;
  };

  /**
   * Paired import: a buy and its closing sell, both already filled.
   * @param {Object} payload
   * @param {string} payload.buyOrderId
   * @param {string} payload.sellOrderId
   * @param {string} [payload.note]
   */
  const importPair = async ({ buyOrderId, sellOrderId, note } = {}) => {
    if (!buyOrderId || !sellOrderId) return fail('Both buyOrderId and sellOrderId are required');

    // Fetch BOTH legs before ingesting EITHER. Ingesting the buy first left
    // unpaired buy rows in the live ledger whenever the sell fetch failed,
    // inflating heldOpenBuyCostBasis for a position that was already closed.
    const buy = await fetchOrderFills(buyOrderId, 'buy');
    if (buy.error) return fail(buy.error);
    const sell = await fetchOrderFills(sellOrderId, 'sell');
    if (sell.error) return fail(sell.error);

    const invalidLeg = validateAdapterFills(buy.fills, buyOrderId, 'buy') || validateAdapterFills(sell.fills, sellOrderId, 'sell');
    if (invalidLeg) return fail(invalidLeg);
    const buyTotals = ingestAdapterFills(fillLedger, buy.fills, buyOrderId, 'buy');
    const sellTotals = ingestAdapterFills(fillLedger, sell.fills, sellOrderId, 'sell');

    // Link buy fills to their sell so the cycle is closed for P&L.
    fillLedger.annotateFillsByOrderId(buyOrderId, { sellOrderId });
    fillLedger.persist();

    const avgBuyPrice = averagePrice(buyTotals.totalQuote, buyTotals.totalSize);
    const avgSellPrice = averagePrice(sellTotals.totalQuote, sellTotals.totalSize);

    const trade = store.addPairedTrade(
      {
        buyOrderId,
        buyPrice: avgBuyPrice,
        buySize: buyTotals.totalSize,
        buyQuoteAmount: buyTotals.totalQuote,
        buyTimestamp: legTimestamp(buy.fills),
        buyFillTradeIds: buyTotals.tradeIds,
      },
      {
        sellOrderId,
        sellPrice: avgSellPrice,
        sellSize: sellTotals.totalSize,
        sellQuoteAmount: sellTotals.totalQuote,
        sellTimestamp: legTimestamp(sell.fills),
        sellFillTradeIds: sellTotals.tradeIds,
      },
      note,
    );

    // Both orders are now accounted for — drop them from the unaccounted view.
    store.dismissFills([buyOrderId, sellOrderId]);

    log.info(`ℹ️ 📝 [${exchange}] Manual paired import: buy ${buyTotals.totalSize} @ $${avgBuyPrice.toFixed(2)} + sell ${sellTotals.totalSize} @ $${avgSellPrice.toFixed(2)}`, {
      buyOrderId,
      sellOrderId,
      buySize: buyTotals.totalSize,
      sellSize: sellTotals.totalSize,
    });

    return ok({ trade: store.getById(trade.id) });
  };

  return { importSell, importBuy, importPair, checkPendingBuy, retryRecovery, resumeBodyImport, recoverPendingBodyIntents, recoverPendingRecoveryIntents };
};

module.exports = { createManualTradeImporter };
