// @ts-check
/**
 * Sync Fills — Exchange → Local Ledger Reconciliation
 *
 * Fetches all trades from an exchange, compares with the local fill-ledger,
 * and ingests any missing fills. Works for any supported exchange.
 */

const { getAdapter } = require('./adapters');
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

const indexFillsByTradeId = (fills) => new Map(fills.map(fill => [fill.tradeId, fill]));

/**
 * Sync fills from exchange to local ledger
 * @param {string} exchange - Exchange name
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object} [options]
 * @param {boolean} [options.dryRun] - If true, don't persist changes
 * @param {string} [options.pair] - Fund pair/productId (e.g. 'ETH-USDC', 'ETHUSD'). Defaults to the legacy BTC pair for backward compatibility.
 * @returns {Promise<Object>} Sync result
 */
const syncFills = async (exchange, fillLedger, options = {}) => {
  const { dryRun = false, pair } = options;
  const adapter = getAdapter(exchange);
  const state = loadRegimeState(exchange, pair);
  const engineStart = state.position?.engineStartTime;

  if (!engineStart) {
    return { success: false, error: 'No engine start time found in regime state' };
  }

  log('INFO', `[${exchange}] Sync fills: fetching trades since ${new Date(engineStart).toISOString()}`);

  let normalizedFills;
  try {
    normalizedFills = await adapter.getReconciliationFills(pair, engineStart);
  } catch (err) {
    return { success: false, error: `Failed to fetch trades: ${err.message}` };
  }

  const exchangeFills = indexFillsByTradeId(normalizedFills);
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
 * @param {string} [options.pair] - Fund pair/productId (e.g. 'ETH-USDC', 'ETHUSD'). Defaults to the legacy BTC pair for backward compatibility.
 * @returns {Promise<Object>} Unaccounted fills grouped by orderId
 */
const getUnaccountedFills = async (exchange, fillLedger, manualTradeStore, options = {}) => {
  const { startDate, pair } = options;
  if (!startDate) {
    return { success: false, error: 'startDate is required' };
  }

  const startTimestampMs = new Date(startDate).getTime();
  if (isNaN(startTimestampMs)) {
    return { success: false, error: 'Invalid startDate format' };
  }

  const adapter = getAdapter(exchange);

  let normalizedFills;
  try {
    normalizedFills = await adapter.getReconciliationFills(pair, startTimestampMs);
  } catch (err) {
    return { success: false, error: `Failed to fetch trades: ${err.message}` };
  }

  const exchangeFills = indexFillsByTradeId(normalizedFills);

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

module.exports = { syncFills, getUnaccountedFills };
