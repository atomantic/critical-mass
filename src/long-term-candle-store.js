// @ts-check
/**
 * Long-Term Candle Store
 *
 * Maintains a multi-year history of daily candles per (exchange, productId)
 * to back the long-term depression score (Phase 1 of auto-aggressiveness).
 *
 * Design notes:
 * - Disk-cached so PM2 restarts don't refetch the full history
 * - Incremental refresh: only fetches the gap between cache tail and now
 * - Adapter-agnostic via the standard `getCandles` interface, with per-adapter
 *   pagination quirks handled inline (Coinbase 350-candle limit, Gemini ~500
 *   candle hard cap, Crypto.com large-window OK)
 * - Failures are non-fatal: stale cache is preferred over no signal
 *
 * @typedef {import('./types').Candle} Candle
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { log } = require('./logger');

const SECONDS_PER_DAY = 86400;
const COINBASE_PAGE_DAYS = 300; // Stay under Coinbase's 350-candle hard limit

/**
 * Get the on-disk cache path for a (exchange, productId).
 * @param {string} exchange
 * @param {string} productId
 * @returns {string}
 */
const cachePath = (exchange, productId) => {
  // Normalize productId for filesystem (BTC-USDC → btc-usdc)
  const safeId = productId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(DATA_DIR, exchange, `long-term-candles-${safeId}.json`);
};

/**
 * Load cached candles from disk. Returns empty array if missing/corrupt.
 * @param {string} exchange
 * @param {string} productId
 * @returns {Candle[]}
 */
const loadCache = (exchange, productId) => {
  const file = cachePath(exchange, productId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw?.candles)) return [];
    return raw.candles;
  } catch (err) {
    log('WARN', `🗓️ [${exchange}] long-term cache load failed for ${productId}: ${err.message}`);
    return [];
  }
};

/**
 * Save candles to disk atomically (write tmp + rename).
 * @param {string} exchange
 * @param {string} productId
 * @param {Candle[]} candles
 */
const saveCache = (exchange, productId, candles) => {
  const file = cachePath(exchange, productId);
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      productId,
      lastUpdate: Date.now(),
      count: candles.length,
      candles,
    });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (err) {
    log('WARN', `🗓️ [${exchange}] long-term cache save failed for ${productId}: ${err.message}`);
  }
};

/**
 * Deduplicate candles by timestamp and sort oldest-first.
 * @param {Candle[]} candles
 * @returns {Candle[]}
 */
const dedupeAndSort = (candles) => {
  const seen = new Map();
  for (const c of candles) {
    if (c && c.timestamp && !seen.has(c.timestamp)) seen.set(c.timestamp, c);
  }
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Fetch a daily-candle window from the adapter, paginating as needed.
 * Each adapter has different limits, so we page in 300-day chunks
 * (safe for Coinbase, fine for the others which return more per call).
 * @param {Object} adapter - Exchange adapter with getCandles method
 * @param {string} productId
 * @param {number} startSec - Start timestamp in seconds
 * @param {number} endSec - End timestamp in seconds
 * @returns {Promise<Candle[]>}
 */
const fetchDailyWindow = async (adapter, productId, startSec, endSec) => {
  const out = [];
  let cursor = startSec;
  while (cursor < endSec) {
    const pageEnd = Math.min(cursor + COINBASE_PAGE_DAYS * SECONDS_PER_DAY, endSec);
    try {
      const page = await adapter.getCandles(productId, cursor, pageEnd, 'ONE_DAY');
      if (Array.isArray(page) && page.length) {
        out.push(...page);
      }
    } catch (err) {
      log('WARN', `🗓️ long-term page fetch failed (${cursor}→${pageEnd}): ${err.message}`);
      // Bail on this window — return whatever we have so far
      break;
    }
    cursor = pageEnd;
  }
  return out;
};

/**
 * Create a long-term candle store for a single (exchange, productId) pair.
 *
 * Lifecycle:
 *   1. `loadFromDisk()` — pull cached candles if any (called automatically on first refresh)
 *   2. `refresh()` — fetch the missing window from adapter, dedupe, persist
 *   3. `getCandles()` — synchronous accessor used by depression-score code
 *   4. `start()` / `stop()` — kick off periodic refresh on a slow cadence (default 1h)
 *
 * @param {string} exchange
 * @param {Object} adapter - Exchange adapter
 * @param {string} productId
 * @param {Object} [options]
 * @param {number} [options.lookbackDays=365] - Target history depth
 * @param {number} [options.refreshIntervalMs=3600000] - Background refresh cadence
 * @returns {Object}
 */
const createLongTermCandleStore = (exchange, adapter, productId, options = {}) => {
  const lookbackDays = Math.max(60, options.lookbackDays || 365);
  const refreshIntervalMs = Math.max(60_000, options.refreshIntervalMs || 3_600_000);

  /** @type {Candle[]} */
  let candles = [];
  let lastRefresh = 0;
  /** @type {Promise<{added: number, total: number}>|null} */
  let refreshInFlight = null;
  let refreshTimer = null;
  let loaded = false;

  /**
   * Load cache from disk (idempotent).
   */
  const loadFromDisk = () => {
    if (loaded) return;
    candles = dedupeAndSort(loadCache(exchange, productId));
    loaded = true;
    if (candles.length) {
      log('INFO', `🗓️ [${exchange}] long-term candles loaded from disk: ${candles.length} candles for ${productId}`);
    }
  };

  /**
   * Trim cache to the configured lookback window so it doesn't grow unbounded.
   */
  const trim = () => {
    if (!candles.length) return;
    const cutoffMs = Date.now() - lookbackDays * SECONDS_PER_DAY * 1000;
    candles = candles.filter(c => c.timestamp >= cutoffMs);
  };

  /**
   * Internal refresh implementation. Always returns a settled promise.
   * @returns {Promise<{added: number, total: number}>}
   */
  const doRefresh = async () => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const fullStartSec = nowSec - lookbackDays * SECONDS_PER_DAY;

      // Detect an "underfilled" cache: we expect at least 80% of the
      // lookback window to be populated. If we have far fewer (e.g. a
      // previous fetch silently truncated due to an adapter bug), force a
      // full re-fetch instead of just topping up the latest day. This
      // recovers gracefully from prior partial caches.
      const expectedMin = Math.floor(lookbackDays * 0.8);
      const isUnderfilled = candles.length < expectedMin;

      // Determine the start of the fetch window:
      // - If cache is underfilled, refetch the full window
      // - Else if cache has data, fetch from the day before the most recent
      //   candle (re-fetching the latest day handles partial-day candles)
      // - Otherwise, fetch the full lookback window
      let fetchStartSec = fullStartSec;
      if (candles.length && !isUnderfilled) {
        const lastTsSec = Math.floor(candles[candles.length - 1].timestamp / 1000);
        fetchStartSec = Math.max(fullStartSec, lastTsSec - SECONDS_PER_DAY);
      } else if (isUnderfilled && candles.length) {
        log('INFO', `🗓️ [${exchange}] long-term cache underfilled (${candles.length}/${expectedMin}+ for ${productId}) — forcing full re-fetch`);
      }

      if (fetchStartSec >= nowSec - SECONDS_PER_DAY / 2 && candles.length && !isUnderfilled) {
        // Cache is fresh and complete — nothing to do
        lastRefresh = Date.now();
        return { added: 0, total: candles.length };
      }

      const fetched = await fetchDailyWindow(adapter, productId, fetchStartSec, nowSec);
      if (!fetched.length) {
        log('WARN', `🗓️ [${exchange}] long-term refresh returned 0 candles for ${productId} (cache=${candles.length})`);
        lastRefresh = Date.now();
        return { added: 0, total: candles.length };
      }

      const beforeCount = candles.length;
      candles = dedupeAndSort([...candles, ...fetched]);
      trim();
      saveCache(exchange, productId, candles);
      const added = candles.length - beforeCount;
      lastRefresh = Date.now();
      log('INFO', `🗓️ [${exchange}] long-term refresh ${productId}: +${added} candles (total=${candles.length}, ${lookbackDays}d window)`);
      return { added, total: candles.length };
    } catch (err) {
      log('WARN', `🗓️ [${exchange}] long-term refresh failed for ${productId}: ${err.message}`);
      return { added: 0, total: candles.length };
    }
  };

  /**
   * Refresh the cache: fetch the gap between last cached candle and now.
   * If a refresh is already in flight, returns the same promise so callers
   * can `await` until it actually settles (instead of getting back a stale
   * "0 added" result while the real fetch is still running).
   * @returns {Promise<{added: number, total: number}>}
   */
  const refresh = () => {
    loadFromDisk();
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  };

  /**
   * Start periodic refresh (slow cadence — daily candles change once a day).
   */
  const start = () => {
    if (refreshTimer) return;
    // Kick off an initial refresh immediately, then on the interval
    refresh().catch(() => {});
    refreshTimer = setInterval(() => { refresh().catch(() => {}); }, refreshIntervalMs);
  };

  /**
   * Stop periodic refresh.
   */
  const stop = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  /**
   * Get current candles (synchronous, returns reference — do not mutate).
   * @returns {Candle[]}
   */
  const getCandles = () => candles;

  /**
   * Get cache stats for diagnostics.
   * `health` reflects whether the cache is at expected fullness:
   *   - 'full': ≥80% of lookback window populated
   *   - 'partial': 30%–80% (usable but suboptimal)
   *   - 'sparse': <30% (signal may be unreliable)
   *   - 'empty': 0 candles
   * @returns {{count: number, lastRefresh: number, lookbackDays: number, oldest: number|null, newest: number|null, expectedMin: number, health: string, coveragePct: number}}
   */
  const getStats = () => {
    const expectedMin = Math.floor(lookbackDays * 0.8);
    const coveragePct = lookbackDays > 0 ? (candles.length / lookbackDays) * 100 : 0;
    let health = 'full';
    if (candles.length === 0) health = 'empty';
    else if (candles.length < lookbackDays * 0.3) health = 'sparse';
    else if (candles.length < expectedMin) health = 'partial';
    return {
      count: candles.length,
      lastRefresh,
      lookbackDays,
      oldest: candles[0]?.timestamp || null,
      newest: candles[candles.length - 1]?.timestamp || null,
      expectedMin,
      health,
      coveragePct,
    };
  };

  return {
    loadFromDisk,
    refresh,
    start,
    stop,
    getCandles,
    getStats,
  };
};

module.exports = {
  createLongTermCandleStore,
  // Exported for testing
  dedupeAndSort,
  cachePath,
};
