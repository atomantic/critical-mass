// @ts-check
/**
 * Sync Fills — Exchange → Local Ledger Reconciliation
 *
 * Fetches all trades from an exchange, compares with the local fill-ledger,
 * and ingests any missing fills. Works for any supported exchange.
 */

const { getAdapter } = require('./adapters');
const { getAuthHeaders } = require('./adapters/coinbase/auth');
const { loadRegimeState } = require('./state-tracker');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { log } = require('./logger');

/** Group an array of fill objects by orderId into a Map */
const groupFillsByOrder = (fills) => {
  const map = new Map();
  for (const f of fills) {
    if (!map.has(f.orderId)) map.set(f.orderId, []);
    map.get(f.orderId).push(f);
  }
  return map;
};

/**
 * Fetch all Coinbase fills since a timestamp using paginated brokerage API
 * @param {Object} adapter - Coinbase adapter (used for credentials)
 * @param {number} startTimestampMs
 * @returns {Promise<Array>}
 */
const fetchAllCoinbaseFills = async (adapter, startTimestampMs) => {
  const { apiKey, apiSecret } = adapter.loadCredentials();
  const allFills = [];
  let cursor = null;
  const startISO = new Date(startTimestampMs).toISOString();

  for (let page = 0; page < 50; page++) {
    let apiPath = `/api/v3/brokerage/orders/historical/fills?product_id=BTC-USDC&start_sequence_timestamp=${startISO}&limit=500`;
    if (cursor) apiPath += `&cursor=${cursor}`;

    const headers = getAuthHeaders(apiKey, apiSecret, 'GET', apiPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(`https://api.coinbase.com${apiPath}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Coinbase API ${resp.status}: ${body}`);
      }
      const data = await resp.json();
      const fills = data.fills || [];
      allFills.push(...fills);
      cursor = data.cursor || null;
      if (!cursor) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return allFills;
};

/**
 * Normalize raw exchange fills to a common format
 * @param {string} exchange
 * @param {Array} rawFills
 * @returns {Map<string, Object>} Map of tradeId → normalized fill
 */
const normalizeFills = (exchange, rawFills) => {
  const fills = new Map();

  for (const raw of rawFills) {
    let fill;

    if (exchange === 'gemini') {
      const tid = (raw.tid || '').toString();
      if (fills.has(tid)) continue;
      const price = parseFloat(raw.price || 0);
      const amount = parseFloat(raw.amount || 0);
      fill = {
        tradeId: tid,
        orderId: (raw.order_id || '').toString(),
        side: (raw.type || '').toLowerCase(),
        price,
        size: amount,
        quoteAmount: price * amount,
        fee: parseFloat(raw.fee_amount || 0),
        feeCurrency: raw.fee_currency || 'USD',
        timestamp: raw.timestampms || (raw.timestamp * 1000),
        liquidityIndicator: raw.is_maker ? 'MAKER' : 'TAKER',
      };
    } else if (exchange === 'coinbase') {
      const tid = raw.trade_id;
      if (fills.has(tid)) continue;
      const price = parseFloat(raw.price);
      const rawSize = parseFloat(raw.size);
      // Coinbase returns size in quote currency (USDC) for some order types
      const sizeInQuote = raw.size_in_quote === true || raw.size_in_quote === 'true';
      const size = sizeInQuote ? rawSize / price : rawSize;
      const quoteAmount = sizeInQuote ? rawSize : price * size;
      fill = {
        tradeId: tid,
        orderId: raw.order_id,
        side: raw.side.toLowerCase(),
        price,
        size,
        quoteAmount,
        fee: parseFloat(raw.commission || 0),
        feeCurrency: 'USDC',
        timestamp: new Date(raw.trade_time).getTime(),
        liquidityIndicator: raw.liquidity_indicator || 'TAKER',
      };
    } else {
      continue;
    }

    fills.set(fill.tradeId, fill);
  }

  return fills;
};

/**
 * Sync fills from exchange to local ledger
 * @param {string} exchange - Exchange name
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object} [options]
 * @param {boolean} [options.dryRun] - If true, don't persist changes
 * @returns {Promise<Object>} Sync result
 */
const syncFills = async (exchange, fillLedger, options = {}) => {
  const { dryRun = false } = options;
  const adapter = getAdapter(exchange);
  const state = loadRegimeState(exchange);
  const engineStart = state.position?.engineStartTime;

  if (!engineStart) {
    return { success: false, error: 'No engine start time found in regime state' };
  }

  log('INFO', `[${exchange}] Sync fills: fetching trades since ${new Date(engineStart).toISOString()}`);

  let rawFills;
  try {
    if (exchange === 'gemini') {
      rawFills = await adapter.getAllTrades('btcusd', engineStart);
    } else if (exchange === 'coinbase') {
      rawFills = await fetchAllCoinbaseFills(adapter, engineStart);
    } else {
      return { success: false, error: `Sync not yet supported for ${exchange}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to fetch trades: ${err.message}` };
  }

  const exchangeFills = normalizeFills(exchange, rawFills);
  log('INFO', `[${exchange}] Sync fills: ${exchangeFills.size} trades from exchange`);

  const ledgerFills = fillLedger.getAllFills();
  const ledgerByTradeId = new Map();
  for (const f of ledgerFills) {
    ledgerByTradeId.set(f.tradeId, f);
  }

  const missingFills = [];
  for (const [tid, exFill] of exchangeFills) {
    if (!ledgerByTradeId.has(tid)) {
      missingFills.push(exFill);
    }
  }

  const orphanedFills = [];
  for (const [tradeId] of ledgerByTradeId) {
    if (tradeId.startsWith('dca-convert-')) continue;
    if (!exchangeFills.has(tradeId)) {
      orphanedFills.push(ledgerByTradeId.get(tradeId));
    }
  }

  missingFills.sort((a, b) => a.timestamp - b.timestamp);

  // Batch ingest: skipPersist on each fill, persist once at the end
  const ingested = [];
  if (!dryRun) {
    for (const exFill of missingFills) {
      const result = fillLedger.ingestFill({
        tradeId: exFill.tradeId,
        orderId: exFill.orderId,
        side: exFill.side,
        price: exFill.price,
        size: exFill.size,
        totalCommission: exFill.fee,
        commission: exFill.fee,
        rebate: 0,
        netFee: exFill.fee,
        liquidityIndicator: exFill.liquidityIndicator,
        tradeTime: new Date(exFill.timestamp).toISOString(),
        fee_asset: exFill.feeCurrency,
        // Reconciliation fills can be days old — never stamp them with the live
        // cycle. Null routes them through recalculateCycles' orphan placement
        // by buy/sell pattern (issue #108).
      }, null, { skipPersist: true, cycleId: null });
      if (result.ingested) {
        ingested.push(exFill);
      }
    }
    if (ingested.length > 0) fillLedger.persist();
  }

  // Pre-group missing fills by orderId for O(n) aggregation
  const fillsByOrderId = groupFillsByOrder(missingFills);

  const missingBuys = missingFills.filter(f => f.side === 'buy');
  const missingSells = missingFills.filter(f => f.side === 'sell');

  const result = {
    success: true,
    dryRun,
    exchange,
    exchangeTotal: exchangeFills.size,
    ledgerTotal: ledgerFills.length,
    missing: missingFills.length,
    orphaned: orphanedFills.length,
    ingested: ingested.length,
    missingBuys: {
      count: missingBuys.length,
      btc: roundAsset(missingBuys.reduce((s, f) => s + f.size, 0)),
      usdc: roundUSDC(missingBuys.reduce((s, f) => s + f.quoteAmount, 0)),
    },
    missingSells: {
      count: missingSells.length,
      btc: roundAsset(missingSells.reduce((s, f) => s + f.size, 0)),
      usdc: roundUSDC(missingSells.reduce((s, f) => s + f.quoteAmount, 0)),
    },
    missingOrders: [...fillsByOrderId.entries()].map(([orderId, fills]) => {
      const totalBtc = fills.reduce((s, f) => s + f.size, 0);
      const totalUsdc = fills.reduce((s, f) => s + f.quoteAmount, 0);
      return {
        orderId,
        side: fills[0].side,
        totalBtc: roundAsset(totalBtc),
        totalUsdc: roundUSDC(totalUsdc),
        avgPrice: roundUSDC(totalBtc > 0 ? totalUsdc / totalBtc : 0),
        fillCount: fills.length,
        time: new Date(fills[0].timestamp).toISOString(),
      };
    }),
    orphanedOrders: orphanedFills.map(f => ({
      tradeId: f.tradeId,
      orderId: f.orderId,
      side: f.side,
      size: f.size,
      price: f.price,
    })),
  };

  log('INFO', `[${exchange}] Sync fills complete: ${result.missing} missing, ${result.ingested} ingested, ${result.orphaned} orphaned`);

  return result;
};

/**
 * Get unaccounted fills from exchange (fills not in the local ledger)
 * @param {string} exchange - Exchange name
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object} manualTradeStore - Manual trade store instance
 * @param {Object} options
 * @param {string} options.startDate - Required ISO date string
 * @returns {Promise<Object>} Unaccounted fills grouped by orderId
 */
const getUnaccountedFills = async (exchange, fillLedger, manualTradeStore, options = {}) => {
  const { startDate } = options;
  if (!startDate) {
    return { success: false, error: 'startDate is required' };
  }

  const startTimestampMs = new Date(startDate).getTime();
  if (isNaN(startTimestampMs)) {
    return { success: false, error: 'Invalid startDate format' };
  }

  const adapter = getAdapter(exchange);

  let rawFills;
  try {
    if (exchange === 'coinbase') {
      rawFills = await fetchAllCoinbaseFills(adapter, startTimestampMs);
    } else if (exchange === 'gemini') {
      rawFills = await adapter.getAllTrades('btcusd', startTimestampMs);
    } else {
      return { success: false, error: `Not supported for ${exchange}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to fetch trades: ${err.message}` };
  }

  const exchangeFills = normalizeFills(exchange, rawFills);

  // Filter out fills already in ledger and dismissed fills
  const unaccounted = [];
  for (const [tid, exFill] of exchangeFills) {
    if (fillLedger.hasProcessedTrade(tid)) continue;
    if (manualTradeStore && manualTradeStore.isFillDismissed(exFill.orderId)) continue;
    unaccounted.push(exFill);
  }

  const byOrderId = groupFillsByOrder(unaccounted);

  const orders = [...byOrderId.entries()].map(([orderId, fills]) => {
    const totalBtc = fills.reduce((s, f) => s + f.size, 0);
    const totalUsdc = fills.reduce((s, f) => s + f.quoteAmount, 0);
    return {
      orderId,
      side: fills[0].side,
      totalBtc: roundAsset(totalBtc),
      totalUsdc: roundUSDC(totalUsdc),
      avgPrice: roundUSDC(totalBtc > 0 ? totalUsdc / totalBtc : 0),
      fillCount: fills.length,
      time: new Date(fills[0].timestamp).toISOString(),
      fills: fills.map(f => ({
        tradeId: f.tradeId,
        price: f.price,
        size: f.size,
        quoteAmount: roundUSDC(f.quoteAmount),
        fee: f.fee,
        timestamp: f.timestamp,
      })),
    };
  }).sort((a, b) => b.time < a.time ? -1 : b.time > a.time ? 1 : 0);

  return {
    success: true,
    exchange,
    startDate,
    exchangeTotal: exchangeFills.size,
    ledgerTotal: fillLedger.getFillCount(),
    unaccountedCount: unaccounted.length,
    unaccountedOrders: orders,
  };
};

module.exports = { syncFills, getUnaccountedFills, fetchAllCoinbaseFills, normalizeFills };
