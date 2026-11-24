// @ts-check
'use strict';

/**
 * The operator's own Up contract, entered by hand from the app, with the Up dip
 * exit rule applied to it. The paper book (up-dip-paper.js) only follows its own
 * simulated entry, so it cannot say when to close a real one.
 *
 * Advice only: there is no exchange or app client here. P&L uses the verified app
 * formula on Coinbase candles; the app prices off Crypto.com's index, so a floor or
 * ceiling touch on Coinbase is reported as "check the app", not as a settlement.
 * ADD is never recommended (docs/updown-up-dip-setup.md: repeat entries lost money
 * on held-out data).
 *
 * The file is re-read on every call, so a backup restore needs no reload hook.
 */

const { UP_DIP_PARAMS, decideUpDip, markPosition, nextExpiryMs } = require('./up-dip-setup');
const { FEE_PER_CONTRACT, maxPayoutForRange } = require('./app-order-history');
const { parseFiniteNumber } = require('./vision-client');
const { round2 } = require('../value-guards');

const MINUTE_MS = 60_000;
/** The paper book evaluates every completed 1m bar; older features mean the feed stalled. */
const STALE_MS = 3 * MINUTE_MS;
/** Only these ranges' payouts were verified against app fills. */
const RANGES = [500, 2000];
const TOUCH_TFS = ['1m', '15m', '1h'];
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
 *   getCandles: (tf: string) => any[], clock?: () => number, onChange?: () => void}} deps
 */
const createUpDipHeld = ({ statePath, readJSON, writeJSON, getCandles, clock = Date.now, onChange }) => {
  const read = () => readJSON(statePath, null)?.held ?? null;
  const write = (held) => { writeJSON(statePath, { held }); onChange?.(); };

  const touched = (held) => {
    const bars = TOUCH_TFS.flatMap(tf => getCandles(tf) || []).filter(c => c.timestamp >= held.openedAt);
    if (bars.some(c => c.low <= held.contract.floor)) return 'floor';
    if (bars.some(c => c.high >= held.contract.ceiling)) return 'ceiling';
    return null;
  };

  const decide = (held, latest, now) => {
    if (now >= held.contract.expiry) return { action: 'EXPIRED', reasons: ['contract has expired: clear it'] };
    const bound = touched(held);
    if (bound) return { action: 'CHECK_APP', reasons: [`Coinbase touched the ${bound} since this fill: the app may have knocked it out`] };
    if (!latest?.features || now - latest.at > STALE_MS) return { action: 'STALE', reasons: ['no fresh candles: no exit advice'] };
    return decideUpDip({ features: latest.features, position: held, now, halfSpread: 0, params: PARAMS });
  };

  /** @param {any} latest the paper book's latest evaluation ({at, features}) */
  const getStatus = (latest) => {
    const held = read();
    if (!held) return null;
    const decision = decide(held, latest, clock());
    const live = decision.action === 'HOLD' || decision.action === 'EXIT';
    return { ...held, decision, pnl: live ? round2(markPosition(held, latest.features.price, 0).pnl) : null };
  };

  /** @returns {{error?: string}} */
  const set = (body) => {
    const parsed = parseHeld(body, clock());
    if ('error' in parsed) return parsed;
    write(parsed.held);
    return {};
  };

  return { getStatus, set, clear: () => write(null) };
};

module.exports = { createUpDipHeld };
