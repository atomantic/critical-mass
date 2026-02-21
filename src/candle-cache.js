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
  { tf: '1m',  hours: 2,   coinbaseGranularity: 60,   cryptocomTf: '1m'  },
  { tf: '5m',  hours: 6,   coinbaseGranularity: 300,  cryptocomTf: '5m'  },
  { tf: '15m', hours: 24,  coinbaseGranularity: 900,  cryptocomTf: '15m' },
  { tf: '1h',  hours: 168, coinbaseGranularity: 3600, cryptocomTf: '1h'  },
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
  const end = new Date().toISOString();
  const start = new Date(Date.now() - hours * 3_600_000).toISOString();
  const url = `${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles?granularity=${granularity}&start=${start}&end=${end}`;
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    log('WARN', `🕯️ candle-cache: coinbase ${tf} fetch failed status=${res?.status}`);
    return [];
  }
  const raw = await res.json().catch(() => null);
  if (!Array.isArray(raw) || !raw.length) return [];

  // Coinbase: [timestamp, low, high, open, close, volume] newest-first
  return raw
    .map(c => ({ timestamp: c[0] * 1000, open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] }))
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
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    log('WARN', `🕯️ candle-cache: cryptocom ${tf} fetch failed status=${res?.status}`);
    return [];
  }
  const json = await res.json().catch(() => null);
  const data = json?.result?.data;
  if (!Array.isArray(data) || !data.length) return [];

  // Crypto.com: {t, o, h, l, c, v}
  return data
    .map(c => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) }))
    .sort((a, b) => a.timestamp - b.timestamp);
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
        agg.seedCandles(tf, candles);
        totalSeeded += candles.length;
        log('INFO', `🕯️ candle-cache: seeded ${candles.length} ${tf} candles for ${exchange}`);
      }
    }

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
   * Get all candles for all 4 standard timeframes
   * @param {string} exchange
   * @returns {Record<string, Array>}
   */
  const getAllCandles = (exchange) => ({
    '1m': getCandles(exchange, '1m'),
    '5m': getCandles(exchange, '5m'),
    '15m': getCandles(exchange, '15m'),
    '1h': getCandles(exchange, '1h'),
  });

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
