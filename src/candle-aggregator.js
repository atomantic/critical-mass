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
  // Volume of the in-progress 1m bucket as it appeared in the most recent 1m REST seed.
  // Used to net out the boundary minute when a directly-fetched higher-timeframe REST
  // seed (which already includes it) later has that 1m bucket rolled up. Captured from
  // the SEED (not live current['1m']) on purpose: live ticks carry ticker volume — e.g.
  // 24h rolling volume (server.js) — which is not comparable to per-bucket REST volume,
  // so subtracting it would clamp the higher-tf seed to zero (issue #145).
  /** @type {{timestamp: number, volume: number} | null} */
  let boundary1mSeed = null;

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
    const tail = buf[buf.length - 1];
    if (tail && tail.timestamp === candle.timestamp) {
      // Replace rather than append — never emit two candles with the same
      // timestamp (issue #145 backstop; the primary fix promotes the in-progress
      // seeded bucket to `current` in seedCandles, but this guards any seed that
      // bypasses that path).
      buf[buf.length - 1] = candle;
    } else {
      buf.push(candle);
    }
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
   * @param {number} [now=Date.now()] - Current time, used to detect the in-progress bucket
   * @param {{boundaryInclusive?: boolean}} [opts] - `boundaryInclusive: true` marks a
   *   directly-fetched seed whose in-progress higher-timeframe candle already includes the
   *   live 1m boundary bucket's partial volume (see the deduction below). Derived seeds —
   *   built from already-completed candles — must leave this false.
   */
  const seedCandles = (timeframe, candles, now = Date.now(), { boundaryInclusive = false } = {}) => {
    if (!TIMEFRAMES[timeframe] || !candles?.length) return;
    const { maxCandles, intervalMs } = TIMEFRAMES[timeframe];
    const seeded = candles.slice(-maxCandles);
    // The seed fetch usually includes the still-open bucket as a partial candle.
    // Promote it to `current` (instead of leaving it in the completed buffer) so
    // live ticks continue that same candle — otherwise aggregation starts a fresh
    // candle for the same timestamp and emits a duplicate at the seed/live
    // boundary, and the live candle under-reports ticks before service start
    // (issue #145).
    const newest = seeded[seeded.length - 1];
    const isInProgress = !!newest && newest.timestamp === floorTimestamp(now, intervalMs);
    // seedAll() runs non-blocking after the live tick listener is wired (server.js),
    // so ticks may have already built current[tf] while this fetch was pending. Never
    // destroy that live in-progress candle (issue #145).
    const existing = current[timeframe];
    if (isInProgress) {
      const promoted = { ...newest };
      // A directly-fetched higher-timeframe seed already aggregates the in-progress 1m
      // bucket's volume up to fetch time. aggregateUp later rolls the FULL 1m candle into
      // this same candle, so deduct the boundary minute now to avoid counting it twice
      // (which spikes volume-derived signals). Use the 1m REST SEED's volume (captured
      // below) — the same data source as this higher-tf REST seed, hence comparable — NOT
      // live current['1m'].volume, which carries non-comparable ticker volume (24h rolling,
      // per server.js) that would clamp the seed to zero. Only volume double-counts (roll-up
      // uses max/min/overwrite for high/low/close); derived seeds exclude the boundary
      // minute and pass boundaryInclusive=false. (issue #145)
      if (boundaryInclusive && timeframe !== '1m' && boundary1mSeed &&
          floorTimestamp(boundary1mSeed.timestamp, intervalMs) === promoted.timestamp) {
        promoted.volume = Math.max(0, promoted.volume - boundary1mSeed.volume);
      }
      buffers[timeframe] = seeded.slice(0, -1);
      if (!existing || existing.timestamp < promoted.timestamp) {
        // No live candle yet (the common case), or it's older than the seed's bucket —
        // promote the seed snapshot.
        current[timeframe] = promoted;
      } else if (existing.timestamp === promoted.timestamp) {
        // Same in-progress bucket built by ticks during the non-blocking seed: keep the
        // live candle (its close is newest) but fold in the seed's TRUE bucket open
        // (earliest) and extremes. Don't sum volume — seed and live cover overlapping
        // wall-clock, so take the larger rather than double-counting.
        existing.open = promoted.open;
        existing.high = Math.max(existing.high, promoted.high);
        existing.low = Math.min(existing.low, promoted.low);
        existing.volume = Math.max(existing.volume, promoted.volume);
      }
      // else: live already advanced past the seed's bucket — keep it untouched.
    } else {
      buffers[timeframe] = seeded;
      // Seed carries no in-progress bucket; only initialize current if no live candle
      // exists — never wipe one ticks already started.
      if (!existing) current[timeframe] = null;
    }
    // Record the 1m REST boundary volume from THIS seed so later higher-tf seeds can
    // deduct it (comparable REST value, immune to live ticker-volume corruption).
    if (timeframe === '1m') {
      boundary1mSeed = isInProgress ? { timestamp: newest.timestamp, volume: newest.volume } : null;
    }
  };

  return { processTick, getCandles, seedCandles, getCurrentCandle };
};

module.exports = { createCandleAggregator, TIMEFRAMES, TIMEFRAME_KEYS };
