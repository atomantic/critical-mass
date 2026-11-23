// @ts-check
const { getBaseCurrency } = require('./config-utils');

/**
 * Whether an engine's price tick may enter a series that is BTC by definition
 * (the candle cache, which is seeded with BTC for every exchange, and the BTC
 * UpDown predictor). Both are keyed by exchange only, so a tick must come from
 * the exchange's default pair, and that pair must be BTC.
 *
 * @param {string} exchange
 * @param {string | null | undefined} pair - the tick's pair; older engines omit it
 * @param {(exchange: string) => string | null} getDefaultPair
 * @returns {boolean}
 */
const acceptsBtcTick = (exchange, pair, getDefaultPair) => {
  const defaultPair = getDefaultPair(exchange);
  if (pair && pair !== defaultPair) return false;
  return getBaseCurrency(defaultPair ?? pair) === 'BTC';
};

module.exports = { acceptsBtcTick };
