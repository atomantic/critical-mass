// @ts-check
/**
 * Divergence Detection
 *
 * Identifies bullish and bearish divergences between price action
 * and an indicator series by comparing swing highs/lows in both.
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
 * Core swing divergence detection between a price series and any indicator series.
 * Uses epsilon-safe delta normalisation so it works for both bounded (RSI 0-100)
 * and unbounded/signed indicators (MACD histogram).
 * @param {number[]} recentCloses - Already-sliced price window
 * @param {number[]} recentIndicator - Already-sliced indicator window (same length)
 * @param {((arr: number[]) => boolean)|null} [preFilter=null] - Optional guard on indicator values
 * @returns {{type: 'bullish'|'bearish'|'none', strength: number}}
 */
const detectSwingDivergence = (recentCloses, recentIndicator, preFilter = null) => {
  if (preFilter && !preFilter(recentIndicator)) return { type: 'none', strength: 0 };

  const priceSwings = findSwings(recentCloses);
  const indSwings = findSwings(recentIndicator);

  // Bearish: price higher highs + indicator lower highs
  if (priceSwings.highs.length >= 2 && indSwings.highs.length >= 2) {
    const ph = priceSwings.highs.slice(-2);
    const ih = indSwings.highs.slice(-2);
    if (ph[1].value > ph[0].value && ih[1].value < ih[0].value) {
      const priceDelta = (ph[1].value - ph[0].value) / ph[0].value;
      const indDelta = Math.abs(ih[0].value) > 1e-8 ? (ih[0].value - ih[1].value) / Math.abs(ih[0].value) : 0;
      return { type: 'bearish', strength: Math.min(1, (priceDelta + indDelta) * 5) };
    }
  }

  // Bullish: price lower lows + indicator higher lows
  if (priceSwings.lows.length >= 2 && indSwings.lows.length >= 2) {
    const pl = priceSwings.lows.slice(-2);
    const il = indSwings.lows.slice(-2);
    if (pl[1].value < pl[0].value && il[1].value > il[0].value) {
      const priceDelta = (pl[0].value - pl[1].value) / pl[0].value;
      const indDelta = Math.abs(il[0].value) > 1e-8 ? (il[1].value - il[0].value) / Math.abs(il[0].value) : 0;
      return { type: 'bullish', strength: Math.min(1, (priceDelta + indDelta) * 5) };
    }
  }

  return { type: 'none', strength: 0 };
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
  return detectSwingDivergence(closes.slice(-lookback), rsiValues.slice(-lookback));
};

// Guard for MACD: require enough warmed-up (non-zero) histogram bars in the lookback window
const macdPreFilter = (arr) => arr.filter(v => v !== 0).length >= arr.length / 2;

/**
 * Detect MACD histogram divergence
 * Bearish: price makes higher highs while histogram makes lower highs
 * Bullish: price makes lower lows while histogram makes higher lows (less negative)
 * @param {number[]} closes - Array of closing prices
 * @param {number[]} macdHistogram - Full histogram series (zeros at start, same length as closes)
 * @param {number} [lookback=20]
 * @returns {{type: 'bullish'|'bearish'|'none', strength: number}}
 */
const detectMACDDivergence = (closes, macdHistogram, lookback = 20) => {
  if (!closes || !macdHistogram || closes.length < lookback || macdHistogram.length < lookback) {
    return { type: 'none', strength: 0 };
  }
  return detectSwingDivergence(closes.slice(-lookback), macdHistogram.slice(-lookback), macdPreFilter);
};

module.exports = { findSwings, detectDivergence, detectMACDDivergence };
