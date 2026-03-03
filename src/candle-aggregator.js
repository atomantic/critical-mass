// @ts-check
/**
 * Candle Aggregator
 *
 * Builds multi-timeframe OHLCV candles from raw price ticks.
 * Ticks -> 1m candles -> aggregated into 3m, 5m, 15m, 1h via ring buffers.
 */

const TIMEFRAMES = {
  '1m': { intervalMs: 60_000, maxCandles: 180 },
  '3m': { intervalMs: 180_000, maxCandles: 160 },
  '5m': { intervalMs: 300_000, maxCandles: 180 },
  '15m': { intervalMs: 900_000, maxCandles: 180 },
  '1h':  { intervalMs: 3_600_000,   maxCandles: 200 },
  '10m': { intervalMs: 600_000,      maxCandles: 180 },
  '30m': { intervalMs: 1_800_000,    maxCandles: 120 },
  '2h':  { intervalMs: 7_200_000,    maxCandles: 100 },
  '4h':  { intervalMs: 14_400_000,   maxCandles: 60  },
  '1d':  { intervalMs: 86_400_000,   maxCandles: 365 },
  '1w':  { intervalMs: 604_800_000,  maxCandles: 52  },
};

const TIMEFRAME_KEYS = Object.keys(TIMEFRAMES);

/**
 * Floor a timestamp to the start of its candle interval
 * @param {number} timestamp - Unix ms timestamp
 * @param {number} intervalMs - Candle interval in milliseconds
 * @returns {number} Floored timestamp
 */
const floorTimestamp = (timestamp, intervalMs) =>
  Math.floor(timestamp / intervalMs) * intervalMs;

/**
 * Create a new empty candle
 * @param {number} price - Opening price
 * @param {number} timestamp - Candle open timestamp (floored)
 * @param {number} volume - Initial volume
 * @returns {{open: number, high: number, low: number, close: number, volume: number, timestamp: number}}
 */
const newCandle = (price, timestamp, volume = 0) => ({
  open: price,
  high: price,
  low: price,
  close: price,
  volume,
  timestamp,
});

/**
 * Create a candle aggregator instance
 * @returns {{processTick: (price: number, timestamp: number, volume?: number) => string[], getCandles: (timeframe: string) => Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>, seedCandles: (timeframe: string, candles: Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>) => void, getCurrentCandle: (timeframe: string) => {open: number, high: number, low: number, close: number, volume: number, timestamp: number} | null}}
 */
const createCandleAggregator = () => {
  /** @type {Record<string, Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>>} */
  const buffers = {};
  /** @type {Record<string, {open: number, high: number, low: number, close: number, volume: number, timestamp: number} | null>} */
  const current = {};

  for (const tf of TIMEFRAME_KEYS) {
    buffers[tf] = [];
    current[tf] = null;
  }

  /**
   * Push a completed candle into the ring buffer for a timeframe
   * @param {string} tf - Timeframe key
   * @param {{open: number, high: number, low: number, close: number, volume: number, timestamp: number}} candle
   */
  const pushCandle = (tf, candle) => {
    const buf = buffers[tf];
    buf.push(candle);
    const max = TIMEFRAMES[tf].maxCandles;
    if (buf.length > max) {
      buf.splice(0, buf.length - max);
    }
  };

  /**
   * Try to aggregate a newly completed 1m candle into higher timeframes
   * @param {{open: number, high: number, low: number, close: number, volume: number, timestamp: number}} oneMinCandle
   * @returns {string[]} List of timeframes that completed a candle
   */
  const aggregateUp = (oneMinCandle) => {
    const completed = [];

    for (const tf of TIMEFRAME_KEYS) {
      if (tf === '1m') continue;

      const intervalMs = TIMEFRAMES[tf].intervalMs;
      const candleStart = floorTimestamp(oneMinCandle.timestamp, intervalMs);
      const cur = current[tf];

      if (!cur || cur.timestamp !== candleStart) {
        // New candle period started - finalize old one if exists
        if (cur) {
          pushCandle(tf, cur);
          completed.push(tf);
        }
        current[tf] = newCandle(oneMinCandle.open, candleStart, oneMinCandle.volume);
        const c = current[tf];
        c.high = oneMinCandle.high;
        c.low = oneMinCandle.low;
        c.close = oneMinCandle.close;
      } else {
        // Update existing candle
        if (oneMinCandle.high > cur.high) cur.high = oneMinCandle.high;
        if (oneMinCandle.low < cur.low) cur.low = oneMinCandle.low;
        cur.close = oneMinCandle.close;
        cur.volume += oneMinCandle.volume;
      }
    }

    return completed;
  };

  /**
   * Process a price tick and build candles
   * @param {number} price - Current price
   * @param {number} timestamp - Tick timestamp (ms)
   * @param {number} [volume=0] - Tick volume
   * @returns {string[]} List of timeframes that completed a new candle
   */
  const processTick = (price, timestamp, volume = 0) => {
    const completedTimeframes = [];
    const intervalMs = TIMEFRAMES['1m'].intervalMs;
    const candleStart = floorTimestamp(timestamp, intervalMs);
    const cur1m = current['1m'];

    if (!cur1m || cur1m.timestamp !== candleStart) {
      // New 1m candle - finalize old one
      if (cur1m) {
        pushCandle('1m', cur1m);
        completedTimeframes.push('1m');
        // Aggregate the completed 1m candle into higher timeframes
        const higherCompleted = aggregateUp(cur1m);
        completedTimeframes.push(...higherCompleted);
      }
      current['1m'] = newCandle(price, candleStart, volume);
    } else {
      // Update current 1m candle
      if (price > cur1m.high) cur1m.high = price;
      if (price < cur1m.low) cur1m.low = price;
      cur1m.close = price;
      cur1m.volume += volume;
    }

    return completedTimeframes;
  };

  /**
   * Get completed candles for a timeframe (oldest first)
   * @param {string} timeframe - Timeframe key (1m, 3m, 5m, 15m, 1h)
   * @returns {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>}
   */
  const getCandles = (timeframe) => {
    if (!TIMEFRAMES[timeframe]) return [];
    return [...buffers[timeframe]];
  };

  /**
   * Get the current in-progress candle for a timeframe
   * @param {string} timeframe
   * @returns {{open: number, high: number, low: number, close: number, volume: number, timestamp: number} | null}
   */
  const getCurrentCandle = (timeframe) => {
    if (!current[timeframe]) return null;
    return { ...current[timeframe] };
  };

  /**
   * Seed historical candles for a timeframe (e.g., on startup from exchange API)
   * @param {string} timeframe - Timeframe key
   * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles - Oldest first
   */
  const seedCandles = (timeframe, candles) => {
    if (!TIMEFRAMES[timeframe] || !candles?.length) return;
    const max = TIMEFRAMES[timeframe].maxCandles;
    buffers[timeframe] = candles.slice(-max);
  };

  return { processTick, getCandles, seedCandles, getCurrentCandle };
};

module.exports = { createCandleAggregator, TIMEFRAMES, TIMEFRAME_KEYS };
