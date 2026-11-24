// @ts-check
'use strict';

/**
 * Candles for the Up dip books, built from the Crypto.com BTC index the gateway
 * already streams and seeded from Crypto.com BTC_USD candles.
 *
 * Minutes finalize in order. One with at least 30 index values becomes a bar;
 * otherwise its BTC_USD candle stands in, flagged `substitute` so the books can
 * refuse to act on it; if neither arrives it is left out, a visible gap. Later
 * minutes wait, because the books never revisit a bar.
 */

const fs = require('fs');
const path = require('path');
const { CANDLE_FETCH_TIMEOUT_MS } = require('../timing-constants');

const MINUTE_MS = 60_000;
/** timeframe -> [bucket ms, bars kept, Crypto.com name] */
const TIMEFRAMES = /** @type {const} */ ({
  '1m': [MINUTE_MS, 180, '1m'],
  '5m': [5 * MINUTE_MS, 180, '5m'],
  '15m': [15 * MINUTE_MS, 180, '15m'],
  '1h': [60 * MINUTE_MS, 220, '1h'],
  '1d': [1440 * MINUTE_MS, 365, '1D'],
});
const TFS = /** @type {Array<keyof typeof TIMEFRAMES>} */ (Object.keys(TIMEFRAMES));
const MIN_VALUES = 30;
/** Values can arrive a moment after their second. */
const FINALIZE_DELAY_MS = 2_000;
const FETCH_INTERVAL_MS = 20_000;
const SEED_RETRY_MS = 30_000;
const GIVE_UP_MS = 120_000;
const POLL_MS = 1_000;
const MAX_FETCH = 300;
const CANDLE_URL = 'https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=BTC_USD';

/**
 * @typedef {{timestamp: number, open: number, high: number, low: number, close: number, volume: number, substitute?: boolean}} Candle
 */

/** Crypto.com BTC_USD candles, oldest first; empty on any failure. */
const fetchBtcUsd = async (tf, count) => {
  const res = await fetch(`${CANDLE_URL}&timeframe=${TIMEFRAMES[tf][2]}&count=${Math.min(count, MAX_FETCH)}`, { signal: AbortSignal.timeout(CANDLE_FETCH_TIMEOUT_MS) });
  const data = res.ok ? (await res.json())?.result?.data : null;
  if (!Array.isArray(data)) return [];
  return data
    .map((c) => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) }))
    .filter((c) => [c.timestamp, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
};

/** Recorded 1m index bars since `from` (see src/btc-feed/index-history.js). */
const readRecorded = (dir, from, to) => {
  const bars = [];
  for (let day = Math.floor(from / 86_400_000) * 86_400_000; day <= to; day += 86_400_000) {
    const file = path.join(dir, `index-${new Date(day).toISOString().slice(0, 10)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const bar = JSON.parse(line);
        if (bar.t >= from) bars.push(bar);
      } catch { /* blank or torn line */ }
    }
  }
  return bars;
};

/**
 * @param {{subscribeIndex: (fn: (s: {value: number, timestamp: number}) => void) => () => void, DATA_DIR?: string,
 *   readIndexMinutes?: (from: number) => Array<{t: number, open: number, high: number, low: number, close: number, samples: number}>,
 *   fetchCandles?: (tf: string, count: number) => Promise<Candle[]>, clock?: () => number, logger: {info: Function, warn: Function}}} deps
 */
const createUpDipCandles = ({ subscribeIndex, DATA_DIR = '', fetchCandles = fetchBtcUsd, clock = Date.now, logger,
  readIndexMinutes = (from) => readRecorded(path.join(DATA_DIR, 'btc-feed'), from, clock()) }) => {
  /** @type {Record<string, Candle[]>} completed bars, oldest first */
  let bars = {};
  /** @type {Record<string, Candle | null>} higher-timeframe buckets in progress */
  let open = {};
  /** @type {Record<string, {candles: Candle[], at: number}>} seeds fetched so far and when each was asked for */
  let seeds = {};
  /** @type {Map<number, {open: number, high: number, low: number, close: number, n: number}>} */
  const live = new Map();
  let ready = false;
  let running = false;
  let generation = 0;
  /** Next minute to finalize. */
  let next = 0;
  let lastSeedAt = -Infinity;
  let lastFetchAt = -Infinity;
  /** When the current run of unanswered fetches began. */
  let stalledSince = /** @type {number | null} */ (null);
  let substitutes = 0;
  let gaps = 0;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let unsubscribe = () => {};
  /** @type {Promise<void> | null} */
  let polling = null;

  const onIndex = ({ value, timestamp }) => {
    const t = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
    if (ready && t < next) return;
    const m = live.get(t);
    if (!m) live.set(t, { open: value, high: value, low: value, close: value, n: 1 });
    else {
      m.high = Math.max(m.high, value);
      m.low = Math.min(m.low, value);
      m.close = value;
      m.n++;
    }
  };

  const keep = (tf, bar) => {
    bars[tf].push(bar);
    const max = TIMEFRAMES[tf][1];
    if (bars[tf].length > max) bars[tf].splice(0, bars[tf].length - max);
  };

  /** Fold a finalized 1m bar into the higher timeframes. */
  const rollUp = (bar) => {
    for (const tf of TFS) {
      if (tf === '1m') continue;
      const span = TIMEFRAMES[tf][0];
      const start = Math.floor(bar.timestamp / span) * span;
      // A seed fetched after this minute may already hold its completed bucket.
      const kept = bars[tf];
      if (kept.length && kept[kept.length - 1].timestamp >= start) continue;
      const bucket = open[tf];
      if (bucket && bucket.timestamp !== start) {
        keep(tf, bucket);
        open[tf] = null;
      }
      const current = open[tf];
      if (current) {
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
      } else {
        open[tf] = { timestamp: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0 };
      }
      if (bar.timestamp + MINUTE_MS === start + span) {
        keep(tf, /** @type {Candle} */ (open[tf]));
        open[tf] = null;
      }
    }
  };

  const finalize = (bar) => {
    keep('1m', bar);
    rollUp(bar);
    live.delete(bar.timestamp);
    next = bar.timestamp + MINUTE_MS;
    stalledSince = null;
  };

  /** Seed every timeframe, then switch to live minutes. */
  const seed = async (mine) => {
    if (clock() - lastSeedAt < SEED_RETRY_MS) return;
    lastSeedAt = clock();
    for (const tf of TFS) {
      if (seeds[tf]) continue;
      const at = clock();
      const fetched = await fetchCandles(tf, TIMEFRAMES[tf][1]).catch((err) => {
        logger.warn(`⚠️ 🕯️ Up dip ${tf} candles could not be fetched: ${err.message}`, { action: 'up-dip-seed', timeframe: tf, error: err.message });
        return [];
      });
      if (mine !== generation) return;
      if (fetched.length) seeds[tf] = { candles: fetched, at };
    }
    if (!TFS.every((tf) => seeds[tf])) return;

    bars = {};
    open = {};
    for (const tf of TFS) {
      const [span, max] = TIMEFRAMES[tf];
      const { candles, at } = seeds[tf];
      const done = candles.filter((c) => c.timestamp + span <= at);
      bars[tf] = done.slice(-max).map((c) => (tf === '1m' ? { ...c, substitute: true } : { ...c }));
      const partial = candles.find((c) => c.timestamp <= at && c.timestamp + span > at);
      if (tf !== '1m') open[tf] = partial ? { ...partial } : null;
    }
    const minutes = bars['1m'];
    if (!minutes.length) return;
    let recorded = [];
    try {
      recorded = readIndexMinutes(minutes[0].timestamp);
    } catch (err) {
      logger.warn(`⚠️ 🕯️ Recorded index minutes could not be read: ${err.message}`, { action: 'up-dip-seed', error: err.message });
    }
    const byTime = new Map(recorded.filter((m) => m.samples >= MIN_VALUES).map((m) => /** @type {[number, any]} */ ([m.t, m])));
    bars['1m'] = minutes.map((c) => {
      const m = byTime.get(c.timestamp);
      return m ? { timestamp: c.timestamp, open: m.open, high: m.high, low: m.low, close: m.close, volume: 0 } : c;
    });
    next = minutes[minutes.length - 1].timestamp + MINUTE_MS;
    for (const t of live.keys()) if (t < next) live.delete(t);
    seeds = {};
    ready = true;
    logger.info(`ℹ️ 🕯️ Up dip candles ready from ${new Date(next).toISOString()}`, { action: 'up-dip-seed', next });
  };

  /** Finalize every minute the index covers. Returns whether one is still missing. */
  const finalizeIndexMinutes = () => {
    while (clock() >= next + MINUTE_MS + FINALIZE_DELAY_MS) {
      const m = live.get(next);
      if (!m || m.n < MIN_VALUES) return true;
      finalize({ timestamp: next, open: m.open, high: m.high, low: m.low, close: m.close, volume: 0 });
    }
    return false;
  };

  const fillFromExchange = async (mine) => {
    const now = clock();
    stalledSince ??= now;
    if (now - lastFetchAt >= FETCH_INTERVAL_MS) {
      lastFetchAt = now;
      const behind = Math.ceil((now - next) / MINUTE_MS);
      const fetched = await fetchCandles('1m', behind + 2).catch(() => []);
      if (mine !== generation) return;
      // A candle fetched before its minute ended is unfinished, however long the fetch took.
      const byTime = new Map(fetched
        .filter((c) => c.timestamp + MINUTE_MS + FINALIZE_DELAY_MS <= now)
        .map((c) => /** @type {[number, Candle]} */ ([c.timestamp, c])));
      // Index minutes and stand-ins interleave, so settle them together, in order.
      while (finalizeIndexMinutes()) {
        const c = byTime.get(next);
        if (!c) break;
        substitutes++;
        finalize({ ...c, substitute: true });
      }
    }
    // Still missing: give up on a minute once it is old enough and has been asked for long enough.
    while (finalizeIndexMinutes()) {
      const at = clock();
      stalledSince ??= at;
      if (at - (next + MINUTE_MS + FINALIZE_DELAY_MS) < GIVE_UP_MS || at - stalledSince < GIVE_UP_MS) return;
      gaps++;
      logger.warn(`⚠️ 🕯️ Up dip minute ${new Date(next).toISOString()} has no index or BTC_USD data: left out`, { action: 'up-dip-gap', minute: next });
      live.delete(next);
      next += MINUTE_MS;
    }
  };

  const run = async () => {
    const mine = generation;
    if (!ready) await seed(mine);
    if (mine !== generation || !ready) return;
    if (finalizeIndexMinutes()) await fillFromExchange(mine);
  };

  /** Advance once; calls made while one is running share it. */
  const poll = () => {
    if (!running) return Promise.resolve();
    polling ??= run().finally(() => { polling = null; });
    return polling;
  };

  /** @param {{timer?: boolean}} [options] */
  const start = ({ timer: useTimer = true } = {}) => {
    if (running) return;
    running = true;
    unsubscribe = subscribeIndex(onIndex);
    if (!useTimer) return;
    const tick = () => poll().catch((err) => logger.warn(`⚠️ 🕯️ Up dip candles failed: ${err.message}`, { action: 'up-dip-candles', error: err.message }));
    timer = setInterval(tick, POLL_MS);
    timer.unref?.();
    tick();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
    unsubscribe();
    ready = false;
    live.clear();
    bars = {};
    seeds = {};
    stalledSince = null;
    lastSeedAt = -Infinity;
    lastFetchAt = -Infinity;
  };

  return {
    start, stop, poll,
    isReady: () => ready,
    /** @param {string} tf @returns {Candle[]} completed bars, oldest first */
    getCandles: (tf) => (ready ? [...(bars[tf] || [])] : []),
    getStatus: () => ({
      ready,
      waitingFor: ready && clock() >= next + MINUTE_MS + FINALIZE_DELAY_MS ? next : null,
      substitutes, gaps,
    }),
  };
};

module.exports = { createUpDipCandles, fetchBtcUsd };
