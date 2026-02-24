// @ts-check
/**
 * Divergence Detection
 *
 * Identifies bullish and bearish divergences between price action
 * and RSI by comparing swing highs/lows in both series.
 */

/**
 * Find swing highs and lows in a value series
 * A swing high at index i means values[i] > all values in [i-order, i+order]
 * A swing low at index i means values[i] < all values in [i-order, i+order]
 * @param {number[]} values - Array of values
 * @param {number} [order=3] - Number of bars on each side to confirm swing
 * @returns {{highs: Array<{index: number, value: number}>, lows: Array<{index: number, value: number}>}}
 */
const findSwings = (values, order = 3) => {
  const highs = [];
  const lows = [];

  if (!values || values.length < order * 2 + 1) return { highs, lows };

  for (let i = order; i < values.length - order; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= order; j++) {
      if (values[i] <= values[i - j] || values[i] <= values[i + j]) isHigh = false;
      if (values[i] >= values[i - j] || values[i] >= values[i + j]) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ index: i, value: values[i] });
    if (isLow) lows.push({ index: i, value: values[i] });
  }

  return { highs, lows };
};

/**
 * Detect price/RSI divergence
 * Bearish: price makes higher highs while RSI makes lower highs
 * Bullish: price makes lower lows while RSI makes higher lows
 * @param {number[]} closes - Array of closing prices
 * @param {number[]} rsiValues - Array of RSI values (same length as closes)
 * @param {number} [lookback=20] - Number of bars to analyze
 * @returns {{type: 'bullish'|'bearish'|'none', strength: number}}
 */
const detectDivergence = (closes, rsiValues, lookback = 20) => {
  if (!closes || !rsiValues || closes.length < lookback || rsiValues.length < lookback) {
    return { type: 'none', strength: 0 };
  }

  const recentCloses = closes.slice(-lookback);
  const recentRSI = rsiValues.slice(-lookback);

  const priceSwings = findSwings(recentCloses);
  const rsiSwings = findSwings(recentRSI);

  // Bearish divergence: ascending price highs + descending RSI highs
  if (priceSwings.highs.length >= 2 && rsiSwings.highs.length >= 2) {
    const ph = priceSwings.highs.slice(-2);
    const rh = rsiSwings.highs.slice(-2);

    if (ph[1].value > ph[0].value && rh[1].value < rh[0].value) {
      const priceDelta = (ph[1].value - ph[0].value) / ph[0].value;
      const rsiDelta = (rh[0].value - rh[1].value) / rh[0].value;
      const strength = Math.min(1, (priceDelta + rsiDelta) * 5);
      return { type: 'bearish', strength };
    }
  }

  // Bullish divergence: descending price lows + ascending RSI lows
  if (priceSwings.lows.length >= 2 && rsiSwings.lows.length >= 2) {
    const pl = priceSwings.lows.slice(-2);
    const rl = rsiSwings.lows.slice(-2);

    if (pl[1].value < pl[0].value && rl[1].value > rl[0].value) {
      const priceDelta = (pl[0].value - pl[1].value) / pl[0].value;
      const rsiDelta = (rl[1].value - rl[0].value) / (rl[0].value || 1);
      const strength = Math.min(1, (priceDelta + rsiDelta) * 5);
      return { type: 'bullish', strength };
    }
  }

  return { type: 'none', strength: 0 };
};

module.exports = { findSwings, detectDivergence };
