// @ts-check
'use strict';

/**
 * Quotes the operator confirms from the Crypto.com app: the source of the bid-ask
 * spread and of which contracts are listed. Nothing is recorded automatically, so a
 * misread screenshot cannot change prices on its own. Only the numbers are kept.
 *
 * The file is re-read on every call, so a backup restore needs no reload hook.
 */

const { expiryMs, maxPayoutForRange } = require('./app-order-history');
const { nextExpiryMs } = require('./up-dip-setup');
const { parseFiniteNumber } = require('./vision-client');
const { quarantineIfUnreadable } = require('../state-file-quarantine');
const { round2 } = require('../value-guards');

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_QUOTES = 500;
const RANGES = [2000, 500];
/** BTC dollars a side when no quote is fresh: the median of past fills. */
const DEFAULT_HALF_SPREAD = { 2000: 35, 500: 0 };
const QUOTE_FRESH_MS = DAY_MS;
const MAX_HALF_SPREAD = 200;
/** Every $2000 floor traded sits on one $400 grid per expiry week. */
const FLOOR_GRID = 400;
const MIN_FLOOR_DISTANCE = 300;
const MAX_FLOOR_DISTANCE = 1900;
const SOURCE_FRESH_MS = 5_000;
/** A capture older than this is not compared with live prices. */
const LIVE_CAPTURE_MS = 60_000;
const MAX_SHOWN_DRIFT = 0.003;
const MIN_COMPARED = 10;

/** Saturday settlement nearest `ms`, or null when none is within 12 hours. */
const snapExpiry = (ms) => {
  for (let offset = -1; offset <= 1; offset++) {
    const day = new Date(ms + offset * DAY_MS);
    if (day.getUTCDay() !== 6) continue;
    const settle = expiryMs(day.toISOString().slice(0, 10));
    if (Math.abs(settle - ms) <= 12 * HOUR_MS) return settle;
  }
  return null;
};

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** How far the app's shown price sat from a source: typical signed gap and 90th percentile size. */
const compare = (quotes, source) => {
  const gaps = quotes.filter((q) => Number.isFinite(q[source])).map((q) => q.shown - q[source]);
  if (gaps.length < MIN_COMPARED) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const sizes = gaps.map(Math.abs).sort((a, b) => a - b);
  return { median: round2(quantile(sorted, 0.5)), p90: round2(quantile(sizes, 0.9)) };
};

/**
 * The contract on the week's grid (through `seenFloor`) nearest the planned distance
 * below `price`, or null when none is within the listed distances.
 */
const pickOnGrid = (price, seenFloor, expiry, params) => {
  const planned = price - params.floorOffset;
  let best = null;
  const first = seenFloor + Math.ceil((price - MAX_FLOOR_DISTANCE - seenFloor) / FLOOR_GRID) * FLOOR_GRID;
  for (let floor = first; floor <= price - MIN_FLOOR_DISTANCE; floor += FLOOR_GRID) {
    if (best === null || Math.abs(floor - planned) < Math.abs(best - planned)) best = floor;
  }
  if (best === null) return null;
  return { floor: best, ceiling: best + params.range, range: params.range, maxPayout: maxPayoutForRange(params.range), expiry, expiryDate: new Date(expiry).toISOString().slice(0, 10) };
};

/**
 * @typedef {{capturedAt: number, recordedAt: number, source: 'screenshot'|'manual', range: number, shown: number,
 *   up: number, down: number, floor: number, ceiling: number, expiry: number, halfSpread: number,
 *   coinbase: number|null, index: number|null}} AppQuote
 * @typedef {{value: number, at: number} | null} Latest
 */

/**
 * @param {{statePath: string, readJSON: (p: string, d: any) => any, writeJSON: (p: string, d: any) => void,
 *   getLatest: () => {coinbase: Latest, index: Latest}, clock?: () => number, logger: {warn: Function, error: Function}}} deps
 */
const createAppQuotes = ({ statePath, readJSON, writeJSON, getLatest, clock = Date.now, logger }) => {
  /** @returns {AppQuote[]} */
  const read = () => {
    quarantineIfUnreadable(statePath, logger);
    const stored = readJSON(statePath, null)?.quotes;
    return Array.isArray(stored) ? stored : [];
  };

  const fresh = (latest, now) => (latest && now - latest.at <= SOURCE_FRESH_MS ? latest.value : null);

  /**
   * @param {any} input
   * @param {AppQuote[]} quotes
   * @param {number} now
   * @returns {{error: string} | {quote: AppQuote}}
   */
  const validate = (input, quotes, now) => {
    const range = parseFiniteNumber(input?.range);
    if (!RANGES.includes(range)) return { error: `range must be ${RANGES.join(' or ')}` };
    const [shown, up, down, floor] = ['shown', 'up', 'down', 'floor'].map((key) => parseFiniteNumber(input[key]));
    if (![shown, up, down, floor].every((n) => n > 0)) return { error: 'shown, up, down and floor must be positive numbers' };
    const fromScreenshot = input.source === 'screenshot';
    if (fromScreenshot && input.direction !== 'Up') return { error: 'select Up in the app and take the screenshot again' };
    const ceiling = input.ceiling == null ? floor + range : parseFiniteNumber(input.ceiling);
    if (ceiling - floor !== range) return { error: `target minus stop must equal the ${range} range` };
    if (floor % 100 !== 0) return { error: 'floor must be a multiple of 100' };
    if (!(down <= shown && shown <= up)) return { error: 'the shown price must be between Down and Up' };
    const halfSpread = round2((up - down) / 2);
    if (halfSpread > MAX_HALF_SPREAD) return { error: `a spread of ${halfSpread} a side is implausible: check Up and Down` };
    if (!(floor < down && up < ceiling)) return { error: 'Up and Down are outside the contract' };
    const gap = up - down;
    const share = (up - shown) / gap;
    if (gap >= 10 && !(share >= 0.35 && share <= 0.65)) return { error: 'Up and Down are not centered on the shown price: check all three' };
    if (fromScreenshot) {
      const maxLoss = Math.abs(parseFiniteNumber(String(input.maxLoss ?? '').replace(/[^0-9.]/g, '')));
      const expected = maxPayoutForRange(range) * (up - floor) / range;
      if (!(Math.abs(maxLoss - expected) <= 1)) return { error: `Max Loss should be about ${round2(expected)} for these prices: check Up and Stop` };
    }

    const capturedAt = input.capturedAt == null ? now : parseFiniteNumber(input.capturedAt);
    if (!(capturedAt > 0)) return { error: 'captured time must be a valid time' };
    if (capturedAt - now > LIVE_CAPTURE_MS) return { error: 'captured time is in the future' };
    const live = now - capturedAt <= LIVE_CAPTURE_MS;
    const latest = getLatest();
    const coinbase = fresh(latest.coinbase, now);
    if (live) {
      if (coinbase === null) return { error: 'Coinbase is not live to check this against: give the time it was captured' };
      if (Math.abs(shown - coinbase) / coinbase > MAX_SHOWN_DRIFT) return { error: `the shown price is far from Coinbase (${coinbase}): if this is an older screenshot, give the time it was captured` };
    }
    const expiry = input.expiry == null ? nextExpiryMs(capturedAt) : snapExpiry(parseFiniteNumber(input.expiry));
    if (!expiry) return { error: 'expiry must be within 12 hours of a Saturday 04:00 New York settlement' };
    if (expiry <= capturedAt) return { error: 'this contract had already expired when captured' };
    if (range === 2000) {
      const other = quotes.find((q) => q.range === 2000 && q.expiry === expiry && (q.floor - floor) % FLOOR_GRID !== 0);
      if (other) return { error: `floor ${floor} is off this week's $${FLOOR_GRID} grid (${other.floor} was recorded): check Stop` };
    }
    return { quote: {
      capturedAt, recordedAt: now, source: fromScreenshot ? 'screenshot' : 'manual', range, shown, up, down, floor, ceiling, expiry, halfSpread,
      coinbase: live ? coinbase : null, index: live ? fresh(latest.index, now) : null,
    } };
  };

  /** Validate without saving. */
  const check = (input) => validate(input, read(), clock());

  /** Validate and save. An identical quote from the same minute is returned, not added. */
  const record = (input) => {
    const quotes = read();
    const result = validate(input, quotes, clock());
    if ('error' in result) return result;
    const { quote } = result;
    const minute = (ms) => Math.floor(ms / 60_000);
    const same = quotes.find((q) => minute(q.capturedAt) === minute(quote.capturedAt)
      && q.range === quote.range && q.floor === quote.floor && q.up === quote.up && q.down === quote.down);
    if (same) return { quote: same };
    writeJSON(statePath, { quotes: [...quotes, quote].slice(-MAX_QUOTES) });
    return result;
  };

  const newest = (quotes) => quotes.reduce((best, q) => (!best || q.capturedAt >= best.capturedAt ? q : best), /** @type {AppQuote|null} */ (null));

  const spreadFrom = (quotes, range, now) => {
    const quote = newest(quotes.filter((q) => q.range === range));
    const ageMs = quote ? now - quote.capturedAt : Infinity;
    if (quote && ageMs < QUOTE_FRESH_MS) return { value: quote.halfSpread, source: /** @type {const} */ ('quote'), capturedAt: quote.capturedAt, ageMs };
    return { value: DEFAULT_HALF_SPREAD[range], source: /** @type {const} */ ('default'), capturedAt: null, ageMs: null };
  };

  /** BTC dollars a side for a range: the newest quote under 24 hours old, else the default. */
  const halfSpread = (range) => spreadFrom(read(), range, clock());

  const listing = (quotes, expiry) => newest(quotes.filter((q) => q.range === 2000 && q.expiry === expiry));

  /**
   * A $2000 contract the app lists, nearest the planned distance below `price`.
   * Null when no quote has been recorded for the current expiry.
   */
  const pick = (price, now, params) => {
    const expiry = nextExpiryMs(now);
    const seen = listing(read(), expiry);
    return seen ? pickOnGrid(price, seen.floor, expiry, params) : null;
  };

  const getStatus = () => {
    const quotes = read();
    const now = clock();
    return {
      spread: { 2000: spreadFrom(quotes, 2000, now), 500: spreadFrom(quotes, 500, now) },
      listingSeen: listing(quotes, nextExpiryMs(now)) !== null,
      comparison: { n: quotes.length, coinbase: compare(quotes, 'coinbase'), index: compare(quotes, 'index') },
      last: newest(quotes),
    };
  };

  return { check, record, halfSpread, pick, getStatus };
};

module.exports = { createAppQuotes, pickOnGrid, DEFAULT_HALF_SPREAD };
