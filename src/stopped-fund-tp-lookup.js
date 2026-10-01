/**
 * Resolve the persisted take-profit order of a stopped fund (issue #863).
 *
 * A rejected exchange lookup must never be reported as "no open orders": the
 * sell may still be resting at the exchange. Failures return an explicit
 * `{ ok: false }` result (error logged with context) instead of a null that
 * callers would treat as an empty list. A successful non-OPEN result is a
 * genuine "not open" answer.
 */

const UNAVAILABLE_MESSAGE = 'Open orders unavailable: exchange order lookup failed';

/**
 * @param {Object} args
 * @param {{getOrder: (id: string) => Promise<any>}} args.adapter
 * @param {Object} args.position - Persisted position state
 * @param {string} args.exchange
 * @param {string} args.pair
 * @param {{error: (msg: string, data?: Object) => void}} args.logger
 * @returns {Promise<{ok: true, order: Object|null} | {ok: false, error: string}>}
 */
async function lookupStoppedFundTpOrder({ adapter, position, exchange, pair, logger }) {
  const orderId = position.activeTpOrderId;
  let orderStatus;
  try {
    orderStatus = await adapter.getOrder(orderId);
  } catch (err) {
    logger.error(`❌ [${exchange}/${pair}] Stopped-fund TP lookup failed for ${orderId}: ${err.message}`, {
      action: 'open-orders-tp-lookup',
      exchange,
      pair,
      orderId,
      errorCode: err.code ?? err.status ?? null,
      error: err.message,
      stack: err.stack,
    });
    return { ok: false, error: UNAVAILABLE_MESSAGE };
  }
  if (!orderStatus || orderStatus.status !== 'OPEN') return { ok: true, order: null };
  return {
    ok: true,
    order: {
      orderId,
      type: 'take_profit', side: 'sell',
      price: position.lastTpPrice || 0,
      size: position.assetOnOrder || position.totalAsset || 0,
      status: 'open',
      placedAt: position.lastEntryTime || null,
    },
  };
}

module.exports = { lookupStoppedFundTpOrder, UNAVAILABLE_MESSAGE };
