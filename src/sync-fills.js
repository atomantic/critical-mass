// @ts-check
/**
 * Sync Fills — Exchange → Local Ledger Reconciliation
 *
 * Fetches trades from an exchange and reports the ones missing from the local
 * fill-ledger. Works for any supported exchange. Ingestion of the reported
 * fills goes through manual-trade import, not this module.
 */

const { getAdapter } = require('./adapters');
const { roundAsset, roundUSDC } = require('./volatility-utils');

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
 * Get unaccounted fills from exchange (fills not in the local ledger)
 * @param {string} exchange - Exchange name
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object} manualTradeStore - Manual trade store instance
 * @param {Object} options
 * @param {string} options.startDate - Required ISO date string
 * @param {string} [options.pair] - Fund pair/productId (e.g. 'ETH-USDC', 'ETHUSD'). Defaults to the legacy BTC pair for backward compatibility.
 * @param {AbortSignal} [options.signal] - Cancels the exchange history read
 * @param {(progress: import('./types').ReconciliationScanProgress) => void} [options.onProgress] - History-read progress
 * @returns {Promise<Object>} Unaccounted fills grouped by orderId
 */
const getUnaccountedFills = async (exchange, fillLedger, manualTradeStore, options = {}) => {
  const { startDate, pair, signal, onProgress } = options;
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
    normalizedFills = await adapter.getReconciliationFills(pair, startTimestampMs, { signal, onProgress });
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

module.exports = { getUnaccountedFills };
