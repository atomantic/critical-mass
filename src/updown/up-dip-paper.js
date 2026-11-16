// @ts-check
'use strict';

/**
 * PAPER tracker for the Up-only dip setup. Once per completed 1m candle it
 * evaluates decideUpDip on the gateway's Coinbase candle buffers and keeps a
 * simulated book: a recommendation made at one bar's close "fills" at the next
 * bar's open, contracts are priced with the app formula plus fees, and floor /
 * ceiling knock-outs and Saturday expiry settle the paper position — the same
 * rules as scripts/backtest-up-dip.js. It never places, modifies or cancels an
 * order; there is no exchange or app client here.
 *
 * State lives in its own file (default data/updown/up-dip-paper.json). An
 * optional `entryFilter` post-processes each decision (the shadow book's
 * daily-trend filter in up-dip-trend-filter.js); without it the book is the
 * plain rule.
 */

const fs = require('fs');
const { UP_DIP_PARAMS, computeUpDipFeatures, decideUpDip, markPosition } = require('./up-dip-setup');
const { contractValue, FEE_PER_CONTRACT } = require('./app-order-history');

const MINUTE_MS = 60_000;
const MAX_CYCLES = 500;
const MAX_EVENTS = 200;
const TFS = ['1m', '5m', '15m', '1h', '1d'];

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{getCandles: (tf: string) => any[], statePath: string,
 *   writeJSON: (p: string, d: any) => void, backtestPath?: string,
 *   params?: typeof UP_DIP_PARAMS, logger?: {warn: Function}, onChange?: () => void,
 *   entryFilter?: (input: {tf: Record<string, any[]>, features: any, decision: any}) => {decision: any, filter: any},
 *   label?: string}} deps
 */
const createUpDipPaper = ({ getCandles, statePath, writeJSON, backtestPath, params = UP_DIP_PARAMS, logger, onChange, entryFilter, label = 'up-dip paper' }) => {
  const empty = () => ({ position: null, pending: null, lastExitAt: null, lastBarTs: 0, cycles: [], events: [], latest: null, startedAt: null });
  let state = empty();
  try {
    if (fs.existsSync(statePath)) state = { ...empty(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch (err) {
    logger?.warn?.(`⚠️ 📊 ${label} state unreadable, starting fresh err=${err.message}`, { action: 'up-dip-load', error: err.message });
  }

  const save = () => writeJSON(statePath, state);
  const event = (e) => {
    state.events.push(e);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };
  const closePosition = (at, proceeds, reason, btc) => {
    const p = state.position;
    const cycle = { openedAt: p.openedAt, closedAt: at, contracts: p.contracts, cost: r2(p.cost), proceeds: r2(proceeds),
      pnl: r2(proceeds - p.cost), reason, entryBtc: p.entryPrice, exitBtc: btc, contract: p.contract };
    state.cycles.push(cycle);
    if (state.cycles.length > MAX_CYCLES) state.cycles.splice(0, state.cycles.length - MAX_CYCLES);
    event({ at, action: 'CLOSED', reason, pnl: cycle.pnl, btc });
    state.position = null;
    state.lastExitAt = at;
  };

  /** Process every completed 1m bar since the last step. Returns true when state changed. */
  const step = () => {
    const tf = Object.fromEntries(TFS.map(t => [t, getCandles(t) || []]));
    const m1 = tf['1m'];
    if (!m1.length) return false;
    const last = m1[m1.length - 1];
    if (last.timestamp <= state.lastBarTs) return false;
    state.startedAt ??= last.timestamp;
    // Replay only the bars since the last step (normally one) so a fill uses that bar's open.
    const fresh = m1.filter(c => c.timestamp > state.lastBarTs);
    for (const bar of fresh.slice(-5)) {
      const pending = state.pending;
      if (pending) {
        const px = bar.open;
        const p = state.position;
        if (pending.action === 'EXIT' && p) closePosition(bar.timestamp, p.contracts * (contractValue(px, p.contract) - FEE_PER_CONTRACT), 'exit', px);
        else if (pending.action === 'ENTER' && !p && px > pending.contract.floor && px < pending.contract.ceiling) {
          state.position = { contract: pending.contract, contracts: 1, cost: contractValue(px, pending.contract) + FEE_PER_CONTRACT, lastFillPrice: px, entryPrice: px, openedAt: bar.timestamp };
          event({ at: bar.timestamp, action: 'FILLED_ENTER', btc: px, cost: r2(state.position.cost) });
        } else if (pending.action === 'ADD' && p && px > p.contract.floor) {
          const add = contractValue(px, p.contract) + FEE_PER_CONTRACT;
          p.cost += add; p.contracts++; p.lastFillPrice = px;
          event({ at: bar.timestamp, action: 'FILLED_ADD', btc: px, cost: r2(add) });
        }
        state.pending = null;
      }
      const now = bar.timestamp + MINUTE_MS;
      const p = state.position;
      if (p) {
        if (bar.low <= p.contract.floor) closePosition(now, 0, 'knock_out_floor', p.contract.floor);
        else if (bar.high >= p.contract.ceiling) closePosition(now, p.contracts * (p.contract.maxPayout - FEE_PER_CONTRACT), 'knock_out_ceiling', p.contract.ceiling);
        else if (now >= p.contract.expiry) closePosition(now, p.contracts * (contractValue(bar.close, p.contract) - FEE_PER_CONTRACT), 'expiry', bar.close);
      }
      state.lastBarTs = bar.timestamp;
    }
    // Decide on the newest bar with the full buffers.
    const now = last.timestamp + MINUTE_MS;
    const features = computeUpDipFeatures(tf, params);
    const raw = decideUpDip({ features, position: state.position, now, lastExitAt: state.lastExitAt, params });
    const { decision, filter = null } = entryFilter ? entryFilter({ tf, features, decision: raw }) : { decision: raw };
    const prev = state.latest?.decision?.action;
    state.latest = { at: now, decision, features, ...(entryFilter ? { filter } : {}) };
    if (['ENTER', 'ADD', 'EXIT'].includes(decision.action)) {
      state.pending = decision;
      event({ at: now, action: decision.action, btc: features?.price ?? null, reasons: decision.reasons, expected: decision.expected ?? null });
    } else if (decision.action !== prev) {
      event({ at: now, action: decision.action, btc: features?.price ?? null, reasons: decision.reasons.slice(0, 2) });
    }
    save();
    onChange?.();
    return true;
  };

  const readBacktest = () => {
    if (!backtestPath || !fs.existsSync(backtestPath)) return null;
    try {
      const r = JSON.parse(fs.readFileSync(backtestPath, 'utf8'));
      const pick = (s) => s && ({ cycles: s.cycles, winRate: s.winRate, pnl: s.pnl, worst: s.worst, maxDrawdown: s.maxDrawdown,
        adamEntries: s.adamEntries, adamEntriesWithSignal: s.adamEntriesWithSignal });
      return { from: r.from, split: r.split, to: r.to, train: pick(r.defaults?.train), test: pick(r.defaults?.test) };
    } catch { return null; }
  };

  const getStatus = () => {
    const price = state.latest?.features?.price;
    const cycles = state.cycles;
    const pnls = cycles.map(c => c.pnl);
    return {
      paperOnly: true,
      params,
      ...(entryFilter ? { filter: state.latest?.filter ?? null } : {}),
      startedAt: state.startedAt,
      latest: state.latest,
      pending: state.pending ? { action: state.pending.action } : null,
      position: state.position ? { ...state.position, cost: r2(state.position.cost),
        ...(price ? { markBtc: price, pnl: r2(markPosition(state.position, price).pnl) } : {}) } : null,
      summary: { cycles: cycles.length, wins: pnls.filter(p => p > 0).length, losses: pnls.filter(p => p <= 0).length,
        pnl: r2(pnls.reduce((a, b) => a + b, 0)), worst: pnls.length ? Math.min(...pnls) : null },
      cycles: cycles.slice(-50).reverse(),
      events: state.events.slice(-30).reverse(),
      backtest: readBacktest(),
    };
  };

  /** Poll for newly completed 1m bars every intervalMs; returns a stop function. */
  const start = (intervalMs = 15_000) => {
    const run = () => {
      try { step(); } catch (err) { logger?.warn?.(`⚠️ 📊 ${label} step failed err=${err.message}`, { action: 'up-dip-step', error: err.message }); }
    };
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
    return () => clearInterval(timer);
  };

  return { step, getStatus, start };
};

module.exports = { createUpDipPaper };
