// @ts-check
'use strict';

/**
 * The operator's own Up contract, entered by hand from the app, with the Up dip
 * exit rule applied to it. The paper book (up-dip-paper.js) only follows its own
 * simulated entry, so it cannot say when to close a real one.
 *
 * Advice only: there is no exchange or app client here. P&L is what closing now would
 * pay after the app's spread; the entered cost is the operator's real one. Which price
 * the app knocks out on is not established, so a floor or ceiling touch on either
 * Coinbase or the Crypto.com index is reported as "check the app", not a settlement.
 * ADD is never recommended (docs/updown-up-dip-setup.md: repeat entries lost money
 * on held-out data).
 *
 * The file is re-read on every call, so a backup restore needs no reload hook.
 */

const { UP_DIP_PARAMS, decideUpDip, markPosition, nextExpiryMs } = require('./up-dip-setup');
const { FEE_PER_CONTRACT, maxPayoutForRange } = require('./app-order-history');
const { parseFiniteNumber } = require('./vision-client');
const { round2 } = require('../value-guards');
const { TIMEFRAMES } = require('../candle-aggregator');

const MINUTE_MS = 60_000;
/** The paper book evaluates every completed 1m bar; older features mean the feed stalled. */
const STALE_MS = 3 * MINUTE_MS;
/** Only these ranges' payouts were verified against app fills. */
const RANGES = [500, 2000];
const COINBASE_TOUCH_TFS = ['1m', '15m', '1h'];
const BOUNDS = /** @type {const} */ (['floor', 'ceiling']);
/** No ADD advice, whatever the paper book's maxContracts is. */
const PARAMS = /** @type {any} */ (Object.freeze({ ...UP_DIP_PARAMS, maxContracts: 0 }));

/**
 * @param {any} body
 * @param {number} now
 * @returns {{error: string} | {held: any}}
 */
const parseHeld = (body, now) => {
  const floor = parseFiniteNumber(body?.floor);
  const ceiling = parseFiniteNumber(body?.ceiling);
  const contracts = parseFiniteNumber(body?.contracts);
  const cost = parseFiniteNumber(body?.cost);
  if (!(floor > 0)) return { error: 'floor must be a positive number' };
  const range = ceiling - floor;
  if (!RANGES.includes(range)) return { error: `ceiling must be ${RANGES.join(' or ')} above the floor` };
  if (!(Number.isInteger(contracts) && contracts >= 1)) return { error: 'contracts must be a whole number of at least 1' };
  if (!(cost > 0)) return { error: 'cost must be a positive number' };
  const expiry = nextExpiryMs(now); // every imported app trade used the next Saturday expiry
  const maxPayout = maxPayoutForRange(range);
  // The BTC price this cost implies: catches a per-contract cost entered as a total, or a wrong floor.
  const entryPrice = floor + (cost / contracts - FEE_PER_CONTRACT) * range / maxPayout;
  if (entryPrice <= floor || entryPrice >= ceiling) {
    return { error: `total cost ${cost} for ${contracts} contract(s) implies BTC at ${Math.round(entryPrice)}, outside ${floor}–${ceiling}` };
  }
  return { held: {
    contract: { floor, ceiling, range, maxPayout, expiry, expiryDate: new Date(expiry).toISOString().slice(0, 10) },
    contracts, cost, entryPrice: round2(entryPrice), lastFillPrice: entryPrice, openedAt: now,
  } };
};

/**
 * @param {{statePath: string, readJSON: (p: string, d: any) => any, writeJSON: (p: string, d: any) => void,
 *   getCandles: (tf: string) => any[], getCoinbaseCandles?: (tf: string) => any[], getHalfSpread: (range: number) => number,
 *   clock?: () => number, onChange?: () => void}} deps  `getCandles` is the Crypto.com index source
 */
const createUpDipHeld = ({ statePath, readJSON, writeJSON, getCandles, getCoinbaseCandles = () => [], getHalfSpread, clock = Date.now, onChange }) => {
  if (typeof getHalfSpread !== 'function') throw new TypeError('the operator contract needs getHalfSpread');
  const read = () => readJSON(statePath, null)?.held ?? null;
  const write = (held) => { writeJSON(statePath, { held }); onChange?.(); };

  /** The first bound these bars touched since the fill, floor before ceiling. */
  const touchedBy = (held, bars, tf) => {
    // The OHLC cannot order an opening-bar touch relative to the fill. Surface
    // it as a possible touch for the operator to verify in the app.
    const since = bars.filter(c => c.timestamp + TIMEFRAMES[tf].intervalMs > held.openedAt);
    return BOUNDS.find(bound => since.some(c => (bound === 'floor' ? c.low <= held.contract.floor : c.high >= held.contract.ceiling))) ?? null;
  };
  // Higher index timeframes and substitutes are built from BTC_USD trades, whose wicks
  // the index never saw, so only its own 1m bars count.
  const indexTouch = (held) => held.indexTouched ?? touchedBy(held, (getCandles('1m') || []).filter(c => !c.substitute), '1m');

  /** Which bound was touched, and by whom. */
  const touched = (held) => {
    const coinbase = BOUNDS.find(bound => COINBASE_TOUCH_TFS.some(tf =>
      touchedBy(held, getCoinbaseCandles(tf) || [], tf) === bound));
    const index = indexTouch(held);
    const bound = BOUNDS.find(b => b === coinbase || b === index);
    if (!bound) return null;
    const both = coinbase === bound && index === bound;
    return { bound, source: both ? 'Both' : coinbase === bound ? 'Coinbase' : 'Crypto.com index' };
  };

  /** Remember an index touch: its 1m buffer holds only three hours. */
  const observe = () => {
    const held = read();
    if (!held || held.indexTouched || clock() >= held.contract.expiry) return;
    const bound = indexTouch(held);
    if (bound) write({ ...held, indexTouched: bound });
  };

  const decide = (held, latest, now) => {
    if (now >= held.contract.expiry) return { action: 'EXPIRED', reasons: ['contract has expired: clear it'] };
    const touch = touched(held);
    if (touch) return { action: 'CHECK_APP', reasons: [`${touch.source} touched the ${touch.bound} since this fill: the app may have knocked it out`] };
    if (!latest?.features || now - latest.at > STALE_MS) return { action: 'STALE', reasons: ['no fresh candles: no exit advice'] };
    return decideUpDip({ features: latest.features, position: held, now, halfSpread: getHalfSpread(held.contract.range), params: PARAMS });
  };

  /** @param {any} latest the paper book's latest evaluation ({at, features}) */
  const getStatus = (latest) => {
    const held = read();
    if (!held) return null;
    const decision = decide(held, latest, clock());
    const live = decision.action === 'HOLD' || decision.action === 'EXIT';
    const halfSpread = getHalfSpread(held.contract.range);
    const pnl = (h) => (live ? round2(markPosition(held, latest.features.price, h).pnl) : null);
    return { ...held, decision, halfSpread, pnl: pnl(halfSpread), pnlBeforeSpread: pnl(0) };
  };

  /** @returns {{error?: string}} */
  const set = (body) => {
    const parsed = parseHeld(body, clock());
    if ('error' in parsed) return parsed;
    write(parsed.held);
    return {};
  };

  return { getStatus, set, observe, clear: () => write(null) };
};

module.exports = { createUpDipHeld };
