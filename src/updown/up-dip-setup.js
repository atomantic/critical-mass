// @ts-check
'use strict';

/**
 * Up-only dip setup for Crypto.com UpDown contracts — PAPER recommendations only.
 *
 * Models the operator's manual method on the ~$70–$400 intraday moves the
 * flush-reversal setup (flush-setup.js, 1–3% flushes) is too coarse for:
 *   - ENTER on the turn after a dip: down at least minDropPct from the
 *     60-minute high, not above the 15m EMA20 by more than maxVs15mPct, and the
 *     1m bar turning up back to within turnBandPct of the 1m EMA20 (labels of
 *     the operator's 51 entries: median 0.4% off the high, at the 1m EMA, RSI
 *     ~49, mostly on a green bar — a turn, not a deep oversold print). Buy the
 *     widest ($2000) range with the lowest floor listed (floor ≈ price − floorOffset).
 *   - ADD on a further dip of addStepPct below the last fill on a green 1m bar,
 *     up to maxContracts.
 *   - EXIT on the 1m chart once price has recovered above the 1m EMA20 and the
 *     cycle is up at least minGainPct of cost after fees, or (risk) when the
 *     cycle is down maxLossPct of cost (Infinity = the operator's no-stop style).
 *   - STAND_ASIDE late in the week (fewer than minDaysToEnter days to expiry) or
 *     when the higher-timeframe trend is breaking down (price below the 1h EMA
 *     by more than maxBelow1hPct).
 * BTC Up only: a bearish read never recommends a Down contract — it means exit
 * (if in profit), add (if within limits) or stand aside.
 *
 * Defaults: minDropPct/minGainPct/maxContracts/maxLossPct were selected on
 * Feb 15–Apr 30 2026 only (scripts/backtest-up-dip.js --grid); minDaysToEnter 3
 * is the operator's stated rule (train selected 1). Out of sample (May–Nov 2026)
 * the edge is NOT robust — see docs/updown-up-dip-setup.md before trusting it.
 *
 * `computeUpDipFeatures` works on per-timeframe candle arrays (the live
 * candle-cache shape); the backtest feeds it the same arrays built from 1m data.
 * `decideUpDip` is pure. Nothing here places orders.
 */

const { FEE_PER_CONTRACT, maxPayoutForRange, expiryMs } = require('./app-order-history');
const { requireHalfSpread, entryCost, exitProceeds, effectiveHalfSpread } = require('./app-pricing');
const { calculateRSI: rsi } = require('./indicators');

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const UP_DIP_PARAMS = Object.freeze({
  emaPeriod: 20,
  rsiPeriod: 14,
  dropWindowMin: 60,
  /** Minimum drop from the dropWindowMin high, % of price. */
  minDropPct: 0.6,
  /** Don't chase: price at most this far above the 15m EMA20, %. */
  maxVs15mPct: 0.25,
  /** Turn: 1m close at least −turnBandPct from the 1m EMA20, on a green bar. */
  turnBandPct: 0.05,
  maxRsi1m: 65,
  /** Risk exit when the cycle is down this % of cost; Infinity disables. */
  maxLossPct: Infinity,
  /** Stand aside when price is this far below the 1h EMA20 (trend breaking down), %. */
  maxBelow1hPct: 2.5,
  minDaysToEnter: 3,
  minDaysToAdd: 1,
  addStepPct: 0.3,
  /** Train-selected 1; the operator scales to 5 — raise it to see ADD recommendations. */
  maxContracts: 1,
  /** Exit when the cycle is up this much of cost after fees and price is back above the 1m EMA20. */
  minGainPct: 4,
  /** Planned distance from price to the contract floor ($2000 ranges). */
  floorOffset: 1500,
  range: 2000,
  /** Minutes between a cycle's exit and the next entry. */
  cooldownMin: 30,
});

/** Next expiry (Saturday 04:00 New York) strictly after `now`. */
const nextExpiryMs = (now) => {
  const d = new Date(now);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i));
    if (day.getUTCDay() !== 6) continue;
    const ms = expiryMs(day.toISOString().slice(0, 10));
    if (ms > now) return ms;
  }
  throw new Error('no expiry within 8 days');
};

/** Contract to buy at `price`: the widest range with the lowest listed floor. */
const pickContract = (price, now, params = UP_DIP_PARAMS) => {
  const floor = Math.floor((price - params.floorOffset) / 100) * 100;
  const ceiling = floor + params.range;
  const expiry = nextExpiryMs(now);
  return { floor, ceiling, range: params.range, maxPayout: maxPayoutForRange(params.range), expiry, expiryDate: new Date(expiry).toISOString().slice(0, 10) };
};

const ema = (values, period) => {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
};

const pctFrom = (price, ref) => (ref ? ((price - ref) / ref) * 100 : null);

/**
 * Features at the close of the latest completed 1m candle.
 * @param {{'1m': any[], '5m'?: any[], '15m'?: any[], '1h'?: any[], '1d'?: any[]}} tf completed candles, oldest first
 * @param {typeof UP_DIP_PARAMS} [params]
 */
const computeUpDipFeatures = (tf, params = UP_DIP_PARAMS) => {
  const m1 = tf['1m'] || [];
  if (m1.length < Math.max(params.dropWindowMin, params.emaPeriod + 1)) return null;
  const last = m1[m1.length - 1];
  const price = last.close;
  const closes = (arr) => (arr || []).map(c => c.close);
  const e = (key) => ema(closes(tf[key]), params.emaPeriod);
  const windowHigh = Math.max(...m1.slice(-params.dropWindowMin).map(c => c.high));
  return {
    timestamp: last.timestamp,
    price,
    green1m: last.close > last.open,
    rsi1m: rsi(closes(m1).slice(-120), params.rsiPeriod),
    dropPct: ((windowHigh - price) / windowHigh) * 100,
    vs1m: pctFrom(price, e('1m')),
    vs5m: pctFrom(price, e('5m')),
    vs15m: pctFrom(price, e('15m')),
    vs1h: pctFrom(price, e('1h')),
    vs1d: pctFrom(price, e('1d')),
  };
};

/**
 * Mark a position at `price`: what closing now would pay after the spread and fees.
 * @param {{contract: {floor: number, ceiling: number, maxPayout?: number}, contracts: number, cost: number, halfSpread?: number}} pos
 * @param {number} price
 * @param {number} halfSpread BTC dollars a side
 */
const markPosition = (pos, price, halfSpread) => {
  const proceeds = exitProceeds(price, pos.contract, effectiveHalfSpread(pos, halfSpread), pos.contracts);
  return { proceeds, pnl: proceeds - pos.cost, pnlPct: ((proceeds - pos.cost) / pos.cost) * 100 };
};

/**
 * @typedef {{contract: ReturnType<typeof pickContract>, contracts: number, cost: number,
 *   lastFillPrice: number, openedAt: number, halfSpread?: number}} UpDipPosition
 * @typedef {{action: 'ENTER'|'ADD'|'EXIT'|'HOLD'|'STAND_ASIDE', reasons: string[],
 *   contract?: ReturnType<typeof pickContract>, size?: number,
 *   expected?: {costUsd: number, targetPnlUsd: number, targetBtc: number, floorLossUsd: number, pnlNowUsd?: number}}} UpDipDecision
 */

/**
 * @param {{features: ReturnType<typeof computeUpDipFeatures>, position: UpDipPosition|null,
 *   now: number, halfSpread: number, lastExitAt?: number|null, params?: typeof UP_DIP_PARAMS,
 *   pick?: (price: number, now: number, params: typeof UP_DIP_PARAMS) => ReturnType<typeof pickContract>|null}} input
 *   `halfSpread` is the app's spread a side in BTC dollars; `pick` chooses a listed contract (null: none known)
 * @returns {UpDipDecision}
 */
const decideUpDip = ({ features: f, position, now, halfSpread, lastExitAt = null, params = UP_DIP_PARAMS, pick = pickContract }) => {
  requireHalfSpread(halfSpread);
  if (!f) return { action: position ? 'HOLD' : 'STAND_ASIDE', reasons: ['not enough candle history'] };
  const fmt = (n) => n == null ? 'n/a' : n.toFixed(2);
  const dipReasons = [];
  const dipBlocks = [];
  (f.dropPct >= params.minDropPct ? dipReasons : dipBlocks).push(`down ${fmt(f.dropPct)}% from ${params.dropWindowMin}m high (need ${params.minDropPct}%)`);
  (f.vs15m != null && f.vs15m <= params.maxVs15mPct ? dipReasons : dipBlocks).push(`vs 15m EMA ${fmt(f.vs15m)}% (max +${params.maxVs15mPct}%)`);
  (f.rsi1m != null && f.rsi1m <= params.maxRsi1m ? dipReasons : dipBlocks).push(`1m RSI ${fmt(f.rsi1m)}`);
  const turned = f.green1m && f.vs1m != null && f.vs1m >= -params.turnBandPct;
  (turned ? dipReasons : dipBlocks).push(turned ? `1m turned up to the EMA (${fmt(f.vs1m)}%)` : `no 1m turn yet (${fmt(f.vs1m)}% vs 1m EMA${f.green1m ? '' : ', red bar'})`);
  const isDip = dipBlocks.length === 0;
  const trendBlock = !Number.isFinite(f.vs1h) ? '1h trend unavailable'
    : f.vs1h < -params.maxBelow1hPct ? `1h trend breaking down (${fmt(f.vs1h)}% vs 1h EMA)` : null;

  if (position) {
    const m = markPosition(position, f.price, halfSpread);
    const daysLeft = (position.contract.expiry - now) / DAY_MS;
    const recovered = f.vs1m != null && f.vs1m > 0;
    const pnlNowUsd = Math.round(m.pnl * 100) / 100;
    if (m.pnlPct >= params.minGainPct && recovered) {
      return { action: 'EXIT', reasons: [`up ${fmt(m.pnlPct)}% of cost after fees (≥ ${params.minGainPct}%)`, `price back above 1m EMA (${fmt(f.vs1m)}%)`], expected: { costUsd: position.cost, targetPnlUsd: pnlNowUsd, targetBtc: f.price, floorLossUsd: -position.cost, pnlNowUsd } };
    }
    if (m.pnlPct <= -params.maxLossPct) {
      return { action: 'EXIT', reasons: [`risk exit: down ${fmt(-m.pnlPct)}% of cost (limit ${params.maxLossPct}%)`], expected: { costUsd: position.cost, targetPnlUsd: pnlNowUsd, targetBtc: f.price, floorLossUsd: -position.cost, pnlNowUsd } };
    }
    const addGap = ((position.lastFillPrice - f.price) / position.lastFillPrice) * 100;
    if (position.contracts < params.maxContracts && daysLeft >= params.minDaysToAdd && !trendBlock && f.green1m && addGap >= params.addStepPct) {
      const contract = position.contract;
      const add = entryCost(f.price, contract, halfSpread);
      return { action: 'ADD', size: 1, contract, reasons: [`${fmt(addGap)}% below last fill`, '1m bar turned up'],
        expected: { costUsd: Math.round(add * 100) / 100, ...targetFor({ ...position, contracts: position.contracts + 1, cost: position.cost + add }, params, halfSpread), pnlNowUsd } };
    }
    const why = [`P&L ${pnlNowUsd >= 0 ? '+' : ''}${pnlNowUsd} (${fmt(m.pnlPct)}%)`, `${daysLeft.toFixed(1)} days to expiry`];
    if (m.pnlPct >= params.minGainPct && !recovered) why.push('at target but price still below 1m EMA');
    if (trendBlock) why.push(`${trendBlock} — no adds`);
    return { action: 'HOLD', reasons: why, expected: { costUsd: position.cost, ...targetFor(position, params, halfSpread), pnlNowUsd } };
  }

  const daysLeft = (nextExpiryMs(now) - now) / DAY_MS;
  if (daysLeft < params.minDaysToEnter) {
    return { action: 'STAND_ASIDE', reasons: [`${daysLeft.toFixed(1)} days to expiry (< ${params.minDaysToEnter}) — too late in the week`] };
  }
  if (trendBlock) return { action: 'STAND_ASIDE', reasons: [trendBlock] };
  if (lastExitAt != null && now - lastExitAt < params.cooldownMin * MINUTE_MS) {
    return { action: 'STAND_ASIDE', reasons: [`cooling down after exit (${params.cooldownMin} min)`] };
  }
  if (!isDip) return { action: 'STAND_ASIDE', reasons: ['no dip setup', ...dipBlocks] };
  const contract = pick(f.price, now, params);
  if (!contract) return { action: 'STAND_ASIDE', reasons: ['no listed contract seen this week'] };
  const cost = entryCost(f.price, contract, halfSpread);
  return { action: 'ENTER', size: 1, contract, reasons: dipReasons,
    expected: { costUsd: Math.round(cost * 100) / 100, ...targetFor({ contract, contracts: 1, cost }, params, halfSpread) } };
};

/** BTC price and P&L at which the exit target is met, plus the floor knock-out loss. */
const targetFor = (pos, params, halfSpread) => {
  const c = pos.contract;
  const maxPayout = c.maxPayout ?? maxPayoutForRange(c.ceiling - c.floor);
  const slope = maxPayout / (c.ceiling - c.floor);
  const h = effectiveHalfSpread(pos, halfSpread);
  // contracts × (slope × (btc − h − floor) − fee) = cost × (1 + gain)
  const needed = pos.cost * (1 + params.minGainPct / 100);
  const targetBtc = Math.min(c.ceiling, c.floor + h + (needed / pos.contracts + FEE_PER_CONTRACT) / slope);
  // Reaching the ceiling settles at the full payout: no spread.
  const atTarget = targetBtc >= c.ceiling
    ? pos.contracts * (maxPayout - FEE_PER_CONTRACT) - pos.cost
    : markPosition(pos, targetBtc, halfSpread).pnl;
  return { targetBtc: Math.round(targetBtc), targetPnlUsd: Math.round(atTarget * 100) / 100, floorLossUsd: -Math.round(pos.cost * 100) / 100 };
};

module.exports = {
  UP_DIP_PARAMS, nextExpiryMs, pickContract, computeUpDipFeatures, decideUpDip, markPosition, ema, rsi,
};
