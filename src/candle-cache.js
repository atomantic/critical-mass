// @ts-check
/**
 * Candle Cache
 *
 * Shared per-exchange candle cache. Manages one CandleAggregator per exchange,
 * seeds from public APIs (no auth), and feeds live IPC ticks.
 */

const { createCandleAggregator } = require('./candle-aggregator');
const { log } = require('./logger');

const SEED_MAX_RETRIES = 5;
const SEED_RETRY_INTERVAL_MS = 5_000;

/**
 * Seed configs: timeframe → { hours of history, API granularity }
 */
const SEED_TIMEFRAMES = [
  { tf: '1m',  hours: 3,   coinbaseGranularity: 60,   cryptocomTf: '1m'  },
  { tf: '5m',  hours: 15,  coinbaseGranularity: 300,  cryptocomTf: '5m'  },
  { tf: '15m', hours: 45,  coinbaseGranularity: 900,  cryptocomTf: '15m' },
  { tf: '1h',  hours: 200, coinbaseGranularity: 3600, cryptocomTf: '1h'  },
  { tf: '1d',  hours: 8760, coinbaseGranularity: 86400, cryptocomTf: '1D' },
];

const COINBASE_EXCHANGE_URL = 'https://api.exchange.coinbase.com';
const CRYPTOCOM_API_URL = 'https://api.crypto.com/exchange/v1/public';

/**
 * Fetch historical candles from Coinbase public Exchange API.
 * Returns candles oldest-first.
 * @param {string} tf - aggregator timeframe key
 * @param {number} hours - hours of history
 * @param {number} granularity - seconds per candle
 * @returns {Promise<Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>>}
 */
const fetchCoinbaseCandles = async (tf, hours, granularity) => {
  const totalCandles = Math.ceil((hours * 3600) / granularity);
  const COINBASE_MAX = 300;

  // Paginate if request exceeds Coinbase's 300-candle limit
  const pages = Math.ceil(totalCandles / COINBASE_MAX);
  const allCandles = [];

  for (let page = 0; page < pages; page++) {
    const pageEndMs = Date.now() - page * COINBASE_MAX * granularity * 1000;
    const pageStartMs = Math.max(
      pageEndMs - COINBASE_MAX * granularity * 1000,
      Date.now() - hours * 3_600_000,
    );
    const url = `${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles?granularity=${granularity}&start=${new Date(pageStartMs).toISOString()}&end=${new Date(pageEndMs).toISOString()}`;
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 15000);
    let res, raw;
    try {
      res = await fetch(url, { signal: controller.signal });
      raw = await res.json().catch(() => null);
    } catch {
      res = null;
      raw = null;
    } finally {
      clearTimeout(fetchTimeout);
    }
    if (!res?.ok) {
      log('WARN', `🕯️ candle-cache: coinbase ${tf} fetch failed status=${res?.status}`);
      continue;
    }
    if (!Array.isArray(raw) || !raw.length) continue;

    // Coinbase: [timestamp, low, high, open, close, volume] newest-first
    for (const c of raw) {
      allCandles.push({ timestamp: c[0] * 1000, open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] });
    }
  }

  // Deduplicate by timestamp and sort oldest-first
  const seen = new Set();
  return allCandles
    .filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
    .sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Fetch historical candles from Crypto.com public Exchange API.
 * Returns candles oldest-first.
 * @param {string} tf - aggregator timeframe key
 * @param {number} hours - hours of history
 * @param {string} cryptocomTf - Crypto.com timeframe string (1m, 5m, 15m, 1h)
 * @returns {Promise<Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>>}
 */
const fetchCryptocomCandles = async (tf, hours, cryptocomTf) => {
  const endTs = Date.now();
  const startTs = endTs - hours * 3_600_000;
  const url = `${CRYPTOCOM_API_URL}/get-candlestick?instrument_name=BTC_USDT&timeframe=${cryptocomTf}&start_ts=${startTs}&end_ts=${endTs}`;
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 15000);
  let res, json;
  try {
    res = await fetch(url, { signal: controller.signal });
    json = await res.json().catch(() => null);
  } catch {
    res = null;
    json = null;
  } finally {
    clearTimeout(fetchTimeout);
  }
  if (!res?.ok) {
    log('WARN', `🕯️ candle-cache: cryptocom ${tf} fetch failed status=${res?.status}`);
    return [];
  }
  const data = json?.result?.data;
  if (!Array.isArray(data) || !data.length) return [];

  // Crypto.com: {t, o, h, l, c, v}
  return data
    .map(c => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) }))
    .sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Aggregate source candles into larger timeframe buckets by floor-aligning timestamps.
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} sourceCandles
 * @param {number} targetIntervalMs
 * @returns {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>}
 */
const aggregateCandles = (sourceCandles, targetIntervalMs) => {
  if (!sourceCandles?.length) return [];
  const buckets = new Map();
  for (const c of sourceCandles) {
    const key = Math.floor(c.timestamp / targetIntervalMs) * targetIntervalMs;
    const existing = buckets.get(key);
    if (existing) {
      if (c.high > existing.high) existing.high = c.high;
      if (c.low < existing.low) existing.low = c.low;
      existing.close = c.close;
      existing.volume += c.volume;
    } else {
      buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: key });
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Derive intermediate timeframes from seeded candle data.
 * @param {ReturnType<typeof createCandleAggregator>} agg
 * @returns {number} total derived candles
 */
const seedDerivedTimeframes = (agg) => {
  const derivations = [
    { source: '1m',  target: '3m',  intervalMs: 180_000 },
    { source: '1m',  target: '10m', intervalMs: 600_000 },
    { source: '5m',  target: '30m', intervalMs: 1_800_000 },
    { source: '1h',  target: '2h',  intervalMs: 7_200_000 },
    { source: '1h',  target: '4h',  intervalMs: 14_400_000 },
    { source: '1d',  target: '1w',  intervalMs: 604_800_000 },
  ];
  let derived = 0;
  for (const { source, target, intervalMs } of derivations) {
    const sourceCandles = agg.getCandles(source);
    const targetCandles = aggregateCandles(sourceCandles, intervalMs);
    if (targetCandles.length) {
      // Derived from already-completed candles, so the in-progress bucket does NOT
      // include the 1m boundary partial — leave boundaryInclusive false (issue #145).
      agg.seedCandles(target, targetCandles, Date.now());
      derived += targetCandles.length;
      log('INFO', `🕯️ candle-cache: derived ${targetCandles.length} ${target} candles from ${source}`);
    }
  }
  return derived;
};

/**
 * Create the shared candle cache
 * @returns {{
 *   seedFromPublicAPI: (exchange: string) => Promise<number>,
 *   processTick: (exchange: string, price: number, timestamp: number, volume?: number) => void,
 *   getCandles: (exchange: string, tf: string) => Array,
 *   getAllCandles: (exchange: string) => Record<string, Array>,
 *   getAggregator: (exchange: string) => ReturnType<typeof createCandleAggregator>,
 *   seedAll: () => Promise<void>,
 * }}
 */
const createCandleCache = () => {
  /** @type {Map<string, ReturnType<typeof createCandleAggregator>>} */
  const aggregators = new Map();

  /**
   * Get or create an aggregator for an exchange
   * @param {string} exchange
   * @returns {ReturnType<typeof createCandleAggregator>}
   */
  const getOrCreate = (exchange) => {
    let agg = aggregators.get(exchange);
    if (!agg) {
      agg = createCandleAggregator();
      aggregators.set(exchange, agg);
    }
    return agg;
  };

  /**
   * Seed an exchange's aggregator from its public API
   * @param {string} exchange
   * @returns {Promise<number>} total candles seeded
   */
  const seedFromPublicAPI = async (exchange) => {
    const agg = getOrCreate(exchange);
    let totalSeeded = 0;

    for (const { tf, hours, coinbaseGranularity, cryptocomTf } of SEED_TIMEFRAMES) {
      let candles;
      if (exchange === 'coinbase') {
        candles = await fetchCoinbaseCandles(tf, hours, coinbaseGranularity);
      } else if (exchange === 'cryptocom') {
        candles = await fetchCryptocomCandles(tf, hours, cryptocomTf);
      } else {
        continue;
      }

      if (candles.length > 0) {
        // Sample `now` right after the fetch (not once up front) so a fetch that
        // crosses a candle boundary doesn't misclassify the in-progress bucket as
        // completed. Directly-fetched seeds include the in-progress 1m bucket's
        // partial volume, so mark them boundaryInclusive to net out the later 1m
        // roll-up (issue #145).
        agg.seedCandles(tf, candles, Date.now(), { boundaryInclusive: true });
        totalSeeded += candles.length;
        log('INFO', `🕯️ candle-cache: seeded ${candles.length} ${tf} candles for ${exchange}`);
      }
    }

    // Derive intermediate timeframes (10m, 30m, 2h, 4h) from seeded data
    totalSeeded += seedDerivedTimeframes(agg);

    return totalSeeded;
  };

  /**
   * Seed with retries
   * @param {string} exchange
   */
  const seedWithRetry = async (exchange) => {
    let retries = 0;
    const attempt = async () => {
      const seeded = await seedFromPublicAPI(exchange).catch(() => 0);
      if (seeded > 0) {
        log('INFO', `🕯️ candle-cache: ${exchange} seeded ${seeded} candles total`);
        return;
      }
      retries++;
      if (retries < SEED_MAX_RETRIES) {
        log('WARN', `🕯️ candle-cache: ${exchange} seed attempt ${retries}/${SEED_MAX_RETRIES} got 0 candles, retrying in ${SEED_RETRY_INTERVAL_MS}ms`);
        await new Promise(r => setTimeout(r, SEED_RETRY_INTERVAL_MS));
        return attempt();
      }
      log('WARN', `🕯️ candle-cache: ${exchange} seed failed after ${SEED_MAX_RETRIES} attempts, running with live data only`);
    };
    await attempt();
  };

  /**
   * Process a live price tick for an exchange
   * @param {string} exchange
   * @param {number} price
   * @param {number} timestamp
   * @param {number} [volume=0]
   */
  const processTick = (exchange, price, timestamp, volume = 0) => {
    const agg = getOrCreate(exchange);
    agg.processTick(price, timestamp, volume);
  };

  /**
   * Get candles for a specific timeframe
   * @param {string} exchange
   * @param {string} tf
   * @returns {Array}
   */
  const getCandles = (exchange, tf) => {
    const agg = aggregators.get(exchange);
    return agg ? agg.getCandles(tf) : [];
  };

  /**
   * Get all candles for all 10 timeframes
   * @param {string} exchange
   * @returns {Record<string, Array>}
   */
  const getAllCandles = (exchange) => {
    const agg = aggregators.get(exchange);
    if (!agg) return {};
    const result = {};
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']) {
      result[tf] = agg.getCandles(tf);
    }
    return result;
  };

  /**
   * Get the raw aggregator for an exchange (for signal engine direct access)
   * @param {string} exchange
   * @returns {ReturnType<typeof createCandleAggregator>}
   */
  const getAggregator = (exchange) => getOrCreate(exchange);

  /**
   * Seed all supported exchanges
   */
  const seedAll = async () => {
    await Promise.all([
      seedWithRetry('cryptocom'),
      seedWithRetry('coinbase'),
    ]);
  };

  return { seedFromPublicAPI, processTick, getCandles, getAllCandles, getAggregator, seedAll };
};

module.exports = { createCandleCache };
