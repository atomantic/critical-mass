// @ts-check
/**
 * Live fund status payload shared by GET /api/:exchange/status and the legacy
 * unprefixed GET /api/status, so the two can never drift apart.
 */

const stateTracker = require('./state-tracker');
const { getFundConfig, getBaseCurrency, getQuoteCurrency } = require('./config-utils');
const { createContextLogger } = require('./logger');

/**
 * Build the live status (price, balances, state) for one fund. Exchange API
 * failures are reported in `apiError` rather than thrown.
 * @param {string} exchange
 * @param {string} pair
 * @param {string} route - Express route pattern being served (log context)
 * @param {string} [module] - Log module name
 * @returns {Promise<Object>}
 */
async function buildFundStatus(exchange, pair, route, module = 'fund-status') {
  const { getAdapter } = require('./adapters');

  const config = getFundConfig(exchange, pair);
  const state = stateTracker.loadState(config, exchange, pair);

  let currentPrice = 0;
  let quoteBalance = { available: 0, hold: 0 };
  let assetBalance = { available: 0, hold: 0 };
  let keysConfigured = false;
  let apiError = null;
  const quoteCurrency = getQuoteCurrency(config.productId);

  const adapter = getAdapter(exchange);

  if (adapter.hasValidKeys && adapter.hasValidKeys()) {
    keysConfigured = true;
    // Each read is independent: a ticker without a usable price must not hide
    // the balances, and a transient balance error must not blank the price.
    const [quoteRes, assetRes, priceRes] = await Promise.allSettled([
      adapter.getAccountBalance(quoteCurrency),
      adapter.getAccountBalance(getBaseCurrency(config.productId)),
      adapter.getCurrentPrice(config.productId),
    ]);
    if (quoteRes.status === 'fulfilled') quoteBalance = quoteRes.value;
    if (assetRes.status === 'fulfilled') assetBalance = assetRes.value;
    if (priceRes.status === 'fulfilled') currentPrice = priceRes.value;
    const failed = [quoteRes, assetRes, priceRes].find((r) => r.status === 'rejected');
    if (failed) {
      apiError = failed.reason?.message || 'API connection failed';
      createContextLogger({ module, exchange, pair, route }).error(`❌ [${exchange}/${pair}] Status check failed: ${apiError}`, {
        action: 'status',
        productId: config.productId,
        error: apiError,
      });
    }
  }

  return {
    exchange,
    pair,
    currentPrice,
    quoteBalance,
    assetBalance,
    quoteCurrency,
    keysConfigured,
    apiError,
    config,
    state,
    failedSells: stateTracker.getFailedSellOrders(state),
    placementIntents: stateTracker.describePlacementIntents(exchange, pair),
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = { buildFundStatus };
