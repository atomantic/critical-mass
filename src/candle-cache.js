// @ts-check
/**
 * Candle Cache
 *
 * Shared per-exchange candle cache. Manages one CandleAggregator per exchange,
 * seeds from public APIs (no auth), and feeds live IPC ticks.
 */

const { createCandleAggregator } = require('./candle-aggregator');
const { createContextLogger } = require('./logger');

/**
 * Context logger for the shared candle cache. `exchange` is supplied per call
 * because one cache instance serves every configured exchange; `pair` is
 * omitted because the seed feeds are BTC-only public endpoints whose pair is
 * baked into the URL (JSON.stringify drops undefined keys).
 * @param {string} [exchange] - Exchange the cache operation belongs to
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const cacheLogger = (exchange) => createContextLogger({ module: 'candle-cache', exchange });

const SEED_MAX_RETRIES = 5;
const SEED_RETRY_INTERVAL_MS = 5_000;
// After the fast boot attempts are exhausted, keep retrying the timeframes that are still
// empty on an unref'd timer, doubling the delay up to a 15 minute cap (issue #1381).
const SEED_BACKGROUND_INITIAL_MS = 30_000;
const SEED_BACKGROUND_MAX_MS = 15 * 60_000;

/**
 * Seed configs: timeframe → { hours of history, API granularity }
 */
const SEED_TIMEFRAMES = [
  { tf: '1m',  hours: 3,   coinbaseGranularity: 60,   cryptocomTf: '1m',  geminiTf: '1m' },
  { tf: '5m',  hours: 15,  coinbaseGranularity: 300,  cryptocomTf: '5m',  geminiTf: '5m' },
  { tf: '15m', hours: 45,  coinbaseGranularity: 900,  cryptocomTf: '15m', geminiTf: '15m' },
  { tf: '1h',  hours: 220, coinbaseGranularity: 3600, cryptocomTf: '1h',  geminiTf: '1hr' },
  { tf: '1d',  hours: 8760, coinbaseGranularity: 86400, cryptocomTf: '1D', geminiTf: '1day' },
];

const COINBASE_EXCHANGE_URL = 'https://api.exchange.coinbase.com';
const CRYPTOCOM_API_URL = 'https://api.crypto.com/exchange/v1/public';
const GEMINI_API_URL = 'https://api.gemini.com/v2';

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
      cacheLogger('coinbase').warn(`⚠️ 🕯️ candle-cache: coinbase ${tf} fetch failed status=${res?.status}`, {
        action: 'seed-fetch',
        timeframe: tf,
        status: res?.status,
      });
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
    cacheLogger('cryptocom').warn(`⚠️ 🕯️ candle-cache: cryptocom ${tf} fetch failed status=${res?.status}`, {
      action: 'seed-fetch',
      timeframe: tf,
      status: res?.status,
    });
    return [];
  }
  const data = json?.result?.data;
  if (!Array.isArray(data) || !data.length) return [];

  // Crypto.com: {t, o, h, l, c, v}
  return data
    .map(c => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) }))
    .sort((a, b) => a.timestamp - b.timestamp);
};

/** Fetch Gemini v2 public candles and normalize them oldest-first. */
const fetchGeminiCandles = async (tf, hours, geminiTf) => {
  const url = `${GEMINI_API_URL}/candles/btcusd/${geminiTf}`;
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
    cacheLogger('gemini').warn(`⚠️ 🕯️ candle-cache: gemini ${tf} fetch failed status=${res?.status}`, {
      action: 'seed-fetch',
      timeframe: tf,
      status: res?.status,
    });
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const cutoff = Date.now() - hours * 3_600_000;
  // Gemini: [timestampMs, open, high, low, close, volume], newest-first.
  return raw
    .map(c => ({
      timestamp: Number(c?.[0]), open: Number(c?.[1]), high: Number(c?.[2]),
      low: Number(c?.[3]), close: Number(c?.[4]), volume: Number(c?.[5]),
    }))
    .filter(c => c.timestamp >= cutoff && Object.values(c).every(Number.isFinite))
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
 * @param {number} [now=Date.now()] - Reference time; all derivations happen at one instant
 *   after the fetches, so a single sample is correct (unlike the per-fetch direct seeds).
 * @returns {number} total derived candles
 */
const seedDerivedTimeframes = (agg, now = Date.now()) => {
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
    // Include the source's in-progress (current) bucket ONLY for sources coarser than
    // 1m: their open bucket holds pre-start sub-bucket data that live 1m roll-up can't
    // reconstruct, so without it the derived in-progress candle is short on volume/high/
    // low. A 1m source's in-progress bucket is the base bucket — aggregateUp rolls it
    // into the target live anyway, so folding it here would double-count (and live 1m
    // carries 24h ticker volume per server.js, making the spike large). Those coarser
    // source currents were already boundary-deducted when directly seeded, so the derived
    // bucket stays boundary-exclusive and live roll-up adds the boundary once — no
    // boundaryInclusive deduction needed here (issue #145).
    const sourceCandles = agg.getCandles(source);
    const sourceCurrent = source === '1m' ? null : agg.getCurrentCandle(source);
    const all = sourceCurrent ? [...sourceCandles, sourceCurrent] : sourceCandles;
    const targetCandles = aggregateCandles(all, intervalMs);
    if (targetCandles.length) {
      agg.seedCandles(target, targetCandles, now);
      derived += targetCandles.length;
      cacheLogger().info(`ℹ️ 🕯️ candle-cache: derived ${targetCandles.length} ${target} candles from ${source}`, {
        action: 'seed-derive',
        timeframe: target,
        sourceTimeframe: source,
        candles: targetCandles.length,
      });
    }
  }
  return derived;
};

/**
 * Create the shared candle cache
 * @param {{maxRetries?: number, retryIntervalMs?: number, backgroundInitialMs?: number, backgroundMaxMs?: number}} [options] - Retry tuning (tests inject small values)
 * @returns {{
 *   seedFromPublicAPI: (exchange: string, timeframes?: Set<string>) => Promise<number>,
 *   processTick: (exchange: string, price: number, timestamp: number, volume?: number) => void,
 *   getCandles: (exchange: string, tf: string) => Array,
 *   getAllCandles: (exchange: string) => Record<string, Array>,
 *   getAggregator: (exchange: string) => ReturnType<typeof createCandleAggregator>,
 *   isSeeded: (exchange: string) => boolean,
 *   seedAll: () => Promise<void>,
 *   invalidate: (options?: {reseed?: boolean}) => Promise<void>,
 *   stop: () => void,
 * }}
 */
const createCandleCache = ({
  maxRetries = SEED_MAX_RETRIES,
  retryIntervalMs = SEED_RETRY_INTERVAL_MS,
  backgroundInitialMs = SEED_BACKGROUND_INITIAL_MS,
  backgroundMaxMs = SEED_BACKGROUND_MAX_MS,
} = {}) => {
  /** @type {Map<string, ReturnType<typeof createCandleAggregator>>} */
  const aggregators = new Map();

  // Per-exchange rolling-24h-volume baseline. Exchange ticker volume (`volume24h`)
  // is the rolling 24-hour total, NOT the volume traded since the last tick, so we
  // feed the aggregator the delta since the previous tick — clamped to >= 0 to absorb
  // the rolling window shedding older trades (day rollover) or a stale baseline after a
  // feed gap. The first tick after start or reseed has no baseline and contributes 0
  // incremental volume. A non-positive reading (e.g. Gemini L2 sends volume24h: 0, or a
  // transient parse glitch) contributes 0 and never overwrites a good baseline. (issue #161)
  /** @type {Map<string, number>} */
  const lastVolume24h = new Map();

  // Per-exchange set of directly-fetched timeframes that came back with candles, so a retry
  // only re-fetches the ones still empty (issue #1381).
  /** @type {Map<string, Set<string>>} */
  const seededTimeframes = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const backgroundTimers = new Map();
  // Bumped by invalidate()/stop() so in-flight retry loops from an older generation bail out.
  let generation = 0;

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
   * @param {Set<string>} [onlyTimeframes] - Restrict the fetch to these timeframes (retry of the empty ones)
   * @returns {Promise<number>} total candles seeded
   */
  const seedFromPublicAPI = async (exchange, onlyTimeframes) => {
    const agg = getOrCreate(exchange);
    const gen = generation;
    // Reseed is a fresh start for live volume — drop any stale 24h baseline so the first
    // live tick after seeding contributes 0 increment instead of a huge bogus delta (issue #161).
    // A partial retry leaves the baseline alone: live ticks have been running since the boot.
    if (!onlyTimeframes) lastVolume24h.delete(exchange);
    let totalSeeded = 0;

    // Fetch every timeframe FIRST, then seed them all against a single post-fetch `now`.
    // One shared reference keeps the promoted in-progress buckets consistent across
    // timeframes — a per-fetch `now` could promote current['5m'] to a later bucket than
    // current['1m'], which aggregateUp then rewinds, producing out-of-order/duplicate
    // candles. Capturing it AFTER the fetches (not once up front) also keeps it fresh, so
    // a slow fetch can't misclassify the in-progress bucket as completed (issue #145).
    const fetched = [];
    for (const { tf, hours, coinbaseGranularity, cryptocomTf, geminiTf } of SEED_TIMEFRAMES) {
      if (onlyTimeframes && !onlyTimeframes.has(tf)) continue;
      let candles;
      if (exchange === 'coinbase') {
        candles = await fetchCoinbaseCandles(tf, hours, coinbaseGranularity);
      } else if (exchange === 'cryptocom') {
        candles = await fetchCryptocomCandles(tf, hours, cryptocomTf);
      } else if (exchange === 'gemini') {
        candles = await fetchGeminiCandles(tf, hours, geminiTf);
      } else {
        continue;
      }
      if (candles.length > 0) fetched.push({ tf, candles });
    }

    const now = Date.now();
    for (const { tf, candles } of fetched) {
      // Directly-fetched seeds include the in-progress 1m bucket's partial volume, so mark
      // them boundaryInclusive to net out the later 1m roll-up (issue #145).
      agg.seedCandles(tf, candles, now, { boundaryInclusive: true });
      totalSeeded += candles.length;
      // An invalidate() mid-fetch orphaned this aggregator; don't credit the new generation.
      if (gen === generation) {
        let done = seededTimeframes.get(exchange);
        if (!done) seededTimeframes.set(exchange, done = new Set());
        done.add(tf);
      }
      cacheLogger(exchange).info(`ℹ️ 🕯️ candle-cache: seeded ${candles.length} ${tf} candles for ${exchange}`, {
        action: 'seed',
        timeframe: tf,
        candles: candles.length,
      });
    }

    // Derive intermediate timeframes (10m, 30m, 2h, 4h) from seeded data, same `now`.
    if (fetched.length > 0 || !onlyTimeframes) totalSeeded += seedDerivedTimeframes(agg, now);

    return totalSeeded;
  };

  /**
   * Seed with retries. Runs `maxRetries` fast attempts (the returned promise settles after
   * them, so boot is never blocked), then hands off to an unref'd exponential-backoff timer
   * that keeps going until every timeframe has candles. Each attempt re-fetches only the
   * timeframes that are still empty (issue #1381).
   * @param {string} exchange
   * @returns {Promise<void>}
   */
  const seedWithRetry = async (exchange) => {
    const logger = cacheLogger(exchange);
    const gen = generation;
    const pending = () => {
      const done = seededTimeframes.get(exchange);
      return new Set(SEED_TIMEFRAMES.map(t => t.tf).filter(tf => !done?.has(tf)));
    };
    /** @returns {Promise<{seeded: number, missing: Set<string>}>} */
    const runAttempt = async () => {
      const missing = pending();
      const seeded = await seedFromPublicAPI(exchange, missing.size === SEED_TIMEFRAMES.length ? undefined : missing)
        .catch(() => 0);
      return { seeded, missing: pending() };
    };

    let retries = 0;
    while (true) {
      const { seeded, missing } = await runAttempt();
      if (gen !== generation) return;
      if (seeded > 0) {
        logger.info(`ℹ️ 🕯️ candle-cache: ${exchange} seeded ${seeded} candles total`, {
          action: 'seed-complete',
          candles: seeded,
        });
      }
      if (missing.size === 0) return;
      retries++;
      if (retries >= maxRetries) break;
      logger.warn(`⚠️ 🕯️ candle-cache: ${exchange} seed attempt ${retries}/${maxRetries} left ${[...missing].join(',')} empty, retrying in ${retryIntervalMs}ms`, {
        action: 'seed-retry',
        attempt: retries,
        maxAttempts: maxRetries,
        retryInMs: retryIntervalMs,
        missing: [...missing],
      });
      await new Promise(r => setTimeout(r, retryIntervalMs).unref());
      if (gen !== generation) return;
    }

    const stillMissing = [...pending()];
    logger.warn(`⚠️ 🕯️ candle-cache: ${exchange} seed incomplete after ${maxRetries} attempts (${stillMissing.join(',')} empty), retrying in the background with backoff`, {
      action: 'seed-failed',
      attempts: maxRetries,
      missing: stillMissing,
    });
    scheduleBackground(exchange, gen, backgroundInitialMs);
  };

  /**
   * Schedule one background retry for an exchange's still-empty timeframes. The timer is
   * unref'd so it never keeps the process alive, and is dropped by invalidate()/stop().
   * Each failed attempt logs once, then the delay doubles up to the cap.
   * @param {string} exchange
   * @param {number} gen - generation the retry chain belongs to
   * @param {number} delayMs
   */
  const scheduleBackground = (exchange, gen, delayMs) => {
    const timer = setTimeout(async () => {
      backgroundTimers.delete(exchange);
      if (gen !== generation) return;
      const done = seededTimeframes.get(exchange);
      const missing = new Set(SEED_TIMEFRAMES.map(t => t.tf).filter(tf => !done?.has(tf)));
      if (missing.size === 0) return;
      const seeded = await seedFromPublicAPI(exchange, missing).catch(() => 0);
      if (gen !== generation) return;
      const stillMissing = SEED_TIMEFRAMES.map(t => t.tf).filter(tf => !seededTimeframes.get(exchange)?.has(tf));
      if (seeded > 0) {
        cacheLogger(exchange).info(`ℹ️ 🕯️ candle-cache: ${exchange} background retry seeded ${seeded} candles`, {
          action: 'seed-background-complete',
          candles: seeded,
          missing: stillMissing,
        });
      }
      if (stillMissing.length === 0) return;
      const nextMs = Math.min(delayMs * 2, backgroundMaxMs);
      cacheLogger(exchange).warn(`⚠️ 🕯️ candle-cache: ${exchange} background seed retry left ${stillMissing.join(',')} empty, next retry in ${nextMs}ms`, {
        action: 'seed-background-retry',
        missing: stillMissing,
        retryInMs: nextMs,
      });
      scheduleBackground(exchange, gen, nextMs);
    }, delayMs);
    timer.unref();
    backgroundTimers.set(exchange, timer);
  };

  /**
   * Cancel every pending background retry and abandon in-flight retry loops.
   * Call on shutdown; invalidate() does this itself.
   */
  const stop = () => {
    generation++;
    for (const timer of backgroundTimers.values()) clearTimeout(timer);
    backgroundTimers.clear();
  };

  /**
   * Process a live price tick for an exchange.
   * `volume24h` is the exchange's rolling 24-hour volume; the aggregator is fed the
   * incremental delta since the previous tick, not the raw 24h total (issue #161).
   * @param {string} exchange
   * @param {number} price
   * @param {number} timestamp
   * @param {number} [volume24h=0] rolling 24-hour volume from the ticker
   */
  const processTick = (exchange, price, timestamp, volume24h = 0) => {
    const agg = getOrCreate(exchange);
    const prev = lastVolume24h.get(exchange);
    // A non-positive reading means "no usable ticker volume this tick" — a parse glitch,
    // or an exchange like Gemini L2 that never reports it. Never let it overwrite a good
    // baseline: doing so would make the NEXT real reading a full-24h spike (the #161 bug).
    if (volume24h > 0) lastVolume24h.set(exchange, volume24h);
    // 0 increment when there's no baseline yet (first tick / post-reseed), no usable reading
    // this tick, or the rolling window shrank (day rollover / reconnect).
    const incremental = (prev === undefined || !(volume24h > 0)) ? 0 : Math.max(0, volume24h - prev);
    agg.processTick(price, timestamp, incremental);
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
   * Whether every directly-fetched timeframe has been seeded for an exchange.
   * Live ticks alone cannot rebuild long history (the 1h trend filter needs
   * ~200 candles), so consumers that act on signals must wait for this.
   * @param {string} exchange
   * @returns {boolean}
   */
  const isSeeded = (exchange) => {
    const done = seededTimeframes.get(exchange);
    return SEED_TIMEFRAMES.every(({ tf }) => done?.has(tf));
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
      seedWithRetry('gemini'),
    ]);
  };

  /**
   * Drop every cached aggregator and volume baseline, then reseed from the
   * public APIs.
   *
   * A backup restore replaces the data files the gateway serves from, but this
   * cache lives only in memory: without an explicit invalidation the dashboard
   * keeps being served candles accumulated BEFORE the restore, and the reseed
   * would never happen because the engines that feed it are deliberately left
   * stopped (issue #429).
   *
   * Reseeding is network work, so it is deliberately not awaited by the caller
   * holding the maintenance lock — the cache is empty (honest) the moment this
   * returns, and refills in the background. `reseed: false` drops the cache
   * without touching the network, which is what tests want.
   *
   * @param {{reseed?: boolean}} [options] - Whether to refill from the public APIs
   * @returns {Promise<void>} Resolves when the reseed settles
   */
  const invalidate = ({ reseed = true } = {}) => {
    const cleared = aggregators.size;
    stop();
    aggregators.clear();
    lastVolume24h.clear();
    seededTimeframes.clear();
    cacheLogger('all').info(`ℹ️ Candle cache invalidated: dropped ${cleared} aggregator(s), reseeding`, {
      action: 'invalidate',
      aggregators: cleared,
    });
    return reseed ? seedAll() : Promise.resolve();
  };

  return { seedFromPublicAPI, processTick, getCandles, getAllCandles, getAggregator, isSeeded, seedAll, invalidate, stop };
};

module.exports = { createCandleCache, seedDerivedTimeframes, aggregateCandles };
