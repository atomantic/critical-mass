// @ts-check
'use strict';

/**
 * Daily-trend stand-aside filter for the SHADOW Up dip paper book.
 *
 * Blocks new ENTER / ADD recommendations while BTC is more than maxBelowSmaPct
 * below the simple average of the last smaPeriod completed daily closes. Exits
 * and holds pass through unchanged. With fewer than smaPeriod daily candles it
 * reports "insufficient daily history" and blocks entries rather than guessing.
 *
 * This filter was chosen after the held-out results of
 * scripts/research-up-selection.js were visible (docs/updown-up-dip-setup.md),
 * so it runs only as a second, clearly labelled paper book under live test.
 * Paper only; nothing here places orders.
 */

const DAILY_TREND_PARAMS = Object.freeze({
  smaPeriod: 50,
  /** Stand aside when price is more than this % below the daily SMA. */
  maxBelowSmaPct: 4,
});

/**
 * @param {Array<{close: number}>} daily completed daily candles, oldest first
 * @param {number|null|undefined} price
 * @param {typeof DAILY_TREND_PARAMS} [params]
 */
const computeDailyTrend = (daily, price, params = DAILY_TREND_PARAMS) => {
  const candles = (daily || []).length;
  const base = { smaPeriod: params.smaPeriod, maxBelowSmaPct: params.maxBelowSmaPct, dailyCandles: candles };
  if (candles < params.smaPeriod || !Number.isFinite(price)) {
    return { ...base, sufficient: false, sma: null, distancePct: null, blocking: true,
      reason: candles < params.smaPeriod ? `insufficient daily history (${candles}/${params.smaPeriod} daily candles)` : 'no price yet' };
  }
  const closes = daily.slice(-params.smaPeriod).map(c => c.close);
  const sma = closes.reduce((a, b) => a + b, 0) / params.smaPeriod;
  const distancePct = ((/** @type {number} */ (price) - sma) / sma) * 100;
  const blocking = distancePct < -params.maxBelowSmaPct;
  return { ...base, sufficient: true, sma: Math.round(sma * 100) / 100, distancePct: Math.round(distancePct * 100) / 100, blocking,
    reason: `${distancePct.toFixed(2)}% vs ${params.smaPeriod}-day average (stand aside below −${params.maxBelowSmaPct}%)` };
};

/**
 * Gate ENTER / ADD with the daily trend; every other action passes through.
 * @param {import('./up-dip-setup').UpDipDecision} decision
 * @param {ReturnType<typeof computeDailyTrend>} trend
 */
const applyDailyTrendFilter = (decision, trend) => {
  if (!trend.blocking || !['ENTER', 'ADD'].includes(decision.action)) return decision;
  const why = `daily-trend filter: ${trend.reason}`;
  return decision.action === 'ENTER'
    ? { action: 'STAND_ASIDE', reasons: [why], filtered: 'ENTER' }
    : { action: 'HOLD', reasons: [why, ...decision.reasons], filtered: 'ADD' };
};

/** Entry filter for createUpDipPaper: reads the daily candles and gates the decision. */
const createDailyTrendEntryFilter = (params = DAILY_TREND_PARAMS) => ({ tf, features, decision }) => {
  const trend = computeDailyTrend(tf['1d'], features?.price, params);
  return { decision: applyDailyTrendFilter(decision, trend), filter: trend };
};

module.exports = { DAILY_TREND_PARAMS, computeDailyTrend, applyDailyTrendFilter, createDailyTrendEntryFilter };
