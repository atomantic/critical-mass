// @ts-check
'use strict';

/**
 * PAPER tracker for the Up-only dip setup. Once per completed 1m candle it
 * evaluates decideUpDip and keeps a simulated book: a recommendation made at one
 * bar's close "fills" at the next bar's open, priced with the app formula, its
 * bid-ask spread (app-pricing.js) and fees. Floor / ceiling knock-outs and Saturday
 * expiry settle without a spread. It never places, modifies or cancels an order;
 * there is no exchange or app client here.
 *
 * Candles come from up-dip-candles.js. A bar flagged `substitute` is not built from
 * the index: it feeds the indicators and can fill a pending EXIT, but opens nothing
 * and knocks out only when Coinbase touched the same bound. If Coinbase stayed
 * unknown, a floor touch is taken as the loss and a ceiling touch is not taken as the
 * gain. A missing minute is a gap: it drops a pending ENTER or ADD and keeps a pending
 * EXIT, unless the contract expired inside it.
 *
 * State lives in its own file (default data/updown/up-dip-paper.json), stamped with
 * how it was priced. A book that traded under other pricing, or that cannot be read,
 * is frozen: it evaluates the market but writes and trades nothing until it is reset
 * (scripts/reset-up-dip-paper.js), so two kinds of P&L are never added together. An
 * optional `entryFilter` post-processes each decision (the shadow book's
 * daily-trend filter in up-dip-trend-filter.js); without it the book is the
 * plain rule.
 *
 * Two outputs, never conflated: `latest.decision` is what the PAPER BOOK does given
 * its own position and cooldown; `latest.signal` is what the rule says about the
 * market right now for someone who is flat. A held paper position turns the former
 * into HOLD for hours, so it must not stand in for the latter. The signal never
 * trades — only `decision` fills.
 */

const fs = require('fs');
const path = require('path');
const { UP_DIP_PARAMS, computeUpDipFeatures, decideUpDip, markPosition, pickContract } = require('./up-dip-setup');
const { settlementProceeds } = require('./app-order-history');
const { entryCost, exitProceeds, effectiveHalfSpread } = require('./app-pricing');

const MINUTE_MS = 60_000;
const MAX_CYCLES = 500;
const MAX_EVENTS = 200;
const TFS = ['1m', '5m', '15m', '1h', '1d'];
/** Minutes the indicator hour may be missing before its old bars would read as recent. */
const MAX_MISSING_MINUTES = 5;
/** How this build prices a book. A book stamped otherwise is not continued. */
const PRICING = Object.freeze({ spread: true, source: 'cryptocom-index' });

const r2 = (n) => Math.round(n * 100) / 100;

const emptyState = () => ({ pricing: { ...PRICING }, position: null, pending: null, lastExitAt: null, lastBarTs: 0, lastClose: null, cycles: [], events: [], latest: null, lastEntrySignal: null, startedAt: null, totals: null, gaps: 0 });

/** Whether anything in this book was priced. */
const hasTraded = (state) => Boolean(state.cycles?.length || state.position || state.pending || state.totals?.cycles);
const isStamped = (state) => state.pricing?.spread === PRICING.spread && state.pricing?.source === PRICING.source;

/** Summary of the newest archive of this book, or null. */
const readArchived = (archiveDir, statePath) => {
  const name = path.basename(statePath, '.json');
  try {
    const files = fs.readdirSync(archiveDir).filter(f => f.startsWith(`${name}-`) && /^\d.*\.json$/.test(f.slice(name.length + 1))).sort();
    return files.length ? JSON.parse(fs.readFileSync(path.join(archiveDir, files[files.length - 1]), 'utf8')).summary ?? null : null;
  } catch {
    return null;
  }
};

/**
 * @param {{getCandles: (tf: string) => any[], statePath: string,
 *   getHalfSpread: (range: number) => number, pick?: typeof pickContract | ((price: number, now: number, params: any) => any),
 *   archiveDir?: string,
 *   writeJSON: (p: string, d: any) => void, backtestPath?: string,
 *   params?: typeof UP_DIP_PARAMS, logger?: {warn: Function}, onChange?: () => void,
 *   entryFilter?: (input: {tf: Record<string, any[]>, features: any, decision: any}) => {decision: any, filter: any},
 *   label?: string}} deps
 */
const createUpDipPaper = ({ getCandles, statePath, getHalfSpread, pick = pickContract, archiveDir, writeJSON, backtestPath, params = UP_DIP_PARAMS, logger, onChange, entryFilter, label = 'up-dip paper' }) => {
  if (typeof getHalfSpread !== 'function') throw new TypeError(`${label} needs getHalfSpread`);
  /** @type {any} */
  let state = emptyState();
  let needsReset = false;
  let archived = null;
  /** What a frozen book last evaluated; never saved. */
  let frozen = { lastBarTs: 0, latest: null, lastEntrySignal: null };
  const load = () => {
    state = emptyState();
    needsReset = false;
    frozen = { lastBarTs: 0, latest: null, lastEntrySignal: null };
    archived = archiveDir ? readArchived(archiveDir, statePath) : null;
    try {
      if (fs.existsSync(statePath)) {
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a JSON object');
        state = { ...emptyState(), pricing: null, ...saved };
        if (!isStamped(state)) {
          if (hasTraded(state)) needsReset = true;
          else state.pricing = { ...PRICING };
        }
      }
    } catch (err) {
      state = emptyState();
      // Left in place: writing an empty book here would destroy the record.
      needsReset = true;
      logger?.warn?.(`⚠️ 📊 ${label} state unreadable, frozen until reset err=${err.message}`, { action: 'up-dip-load', error: err.message });
    }
    // State saved before running aggregates existed: seed them from the retained cycles.
    if (!state.totals) {
      const pnls = state.cycles.map(c => c.pnl);
      state.totals = { cycles: pnls.length, wins: pnls.filter(x => x > 0).length, losses: pnls.filter(x => x <= 0).length,
        pnl: r2(pnls.reduce((a, b) => a + b, 0)), worst: pnls.length ? Math.min(...pnls) : null };
    }
  };
  load();

  const save = () => writeJSON(statePath, state);
  const event = (e) => {
    state.events.push(e);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };
  const closePosition = (at, proceeds, reason, btc, extra = {}) => {
    const p = state.position;
    const cycle = { openedAt: p.openedAt, closedAt: at, contracts: p.contracts, cost: r2(p.cost), proceeds: r2(proceeds),
      pnl: r2(proceeds - p.cost), reason, entryBtc: p.entryPrice, exitBtc: btc, contract: p.contract, ...extra };
    state.cycles.push(cycle);
    // Running aggregates survive the MAX_CYCLES trim below, so book totals never drop history.
    const t = state.totals;
    t.cycles++;
    if (cycle.pnl > 0) t.wins++; else t.losses++;
    t.pnl = r2(t.pnl + cycle.pnl);
    t.worst = t.worst === null ? cycle.pnl : Math.min(t.worst, cycle.pnl);
    if (state.cycles.length > MAX_CYCLES) state.cycles.splice(0, state.cycles.length - MAX_CYCLES);
    event({ at, action: 'CLOSED', reason, pnl: cycle.pnl, btc });
    state.position = null;
    state.lastExitAt = at;
  };

  /** A hole before `bar`: its knock-outs and fills cannot be replayed, so mark it visibly. */
  const recordGap = (bar, previous) => {
    const missing = Math.round((bar.timestamp - previous) / MINUTE_MS) - 1;
    const pending = state.pending?.action ?? null;
    const kept = pending === 'EXIT';
    state.gaps = (state.gaps || 0) + 1;
    event({ at: bar.timestamp, action: 'GAP', missingBars: missing, from: previous + MINUTE_MS, to: bar.timestamp - MINUTE_MS,
      droppedPending: kept ? null : pending, keptPending: kept ? pending : null, openPosition: !!state.position });
    logger?.warn?.(`⚠️ 📊 ${label} candle gap: ${missing} bars missing`, { action: 'up-dip-gap', missingBars: missing });
    // An entry decided before the hole is stale; leaving a position open because of one is worse.
    if (!kept) state.pending = null;
  };

  const fillPending = (bar, halfSpread) => {
    const pending = state.pending;
    if (!pending) return;
    state.pending = null;
    const px = bar.open;
    const p = state.position;
    if (pending.action === 'EXIT') {
      if (p) closePosition(bar.timestamp, exitProceeds(px, p.contract, effectiveHalfSpread(p, halfSpread), p.contracts), 'exit', px);
      return;
    }
    if (bar.substitute) {
      event({ at: bar.timestamp, action: 'DROPPED', pending: pending.action, reason: 'no index data to price the fill' });
      return;
    }
    if (pending.action === 'ENTER' && !p && px > pending.contract.floor && px + halfSpread < pending.contract.ceiling) {
      state.position = { contract: pending.contract, contracts: 1, cost: entryCost(px, pending.contract, halfSpread), lastFillPrice: px, entryPrice: px, openedAt: bar.timestamp, halfSpread };
      event({ at: bar.timestamp, action: 'FILLED_ENTER', btc: px, cost: r2(state.position.cost), halfSpread });
    } else if (pending.action === 'ADD' && p && px > p.contract.floor && px + halfSpread < p.contract.ceiling) {
      const add = entryCost(px, p.contract, halfSpread);
      p.cost += add; p.contracts++; p.lastFillPrice = px;
      p.halfSpread = effectiveHalfSpread(p, halfSpread);
      event({ at: bar.timestamp, action: 'FILLED_ADD', btc: px, cost: r2(add), halfSpread });
    }
  };

  /** A contract that expired inside a gap settles there: later prices cannot fill or knock it out. */
  const settleExpiredInGap = (bar, previous) => {
    const p = state.position;
    if (!p || bar.timestamp < p.contract.expiry) return;
    const { expiry } = p.contract;
    // The price at expiry was missed, so use the nearer side of the gap.
    const before = state.lastClose !== null && expiry - (previous + MINUTE_MS) <= bar.timestamp - expiry;
    const btc = before ? state.lastClose : bar.open;
    closePosition(expiry, settlementProceeds(btc, p.contract, p.contracts), 'expiry', btc, { uncertain: true });
    if (state.pending?.action !== 'ENTER') state.pending = null;
  };

  /** Knock-outs and expiry for the open position on one bar. */
  const settle = (bar) => {
    const p = state.position;
    if (!p) return;
    const now = bar.timestamp + MINUTE_MS;
    const { coinbase } = bar;
    const touched = (b, bound) => (bound === 'floor' ? b.low <= p.contract.floor : b.high >= p.contract.ceiling);
    // Floor first: when a bar spans both, assume the loss.
    for (const bound of /** @type {const} */ (['floor', 'ceiling'])) {
      const own = touched(bar, bound);
      // Part of a Coinbase minute can prove a touch but not rule one out.
      const seen = coinbase ? touched(coinbase, bound) : null;
      const other = seen === false && !coinbase.complete ? null : seen;
      if (own !== (other ?? false)) {
        const source = own ? (bar.substitute ? 'BTC_USD' : 'Crypto.com index') : 'Coinbase';
        const key = `${bound}:${source}`;
        p.mismatches ??= [];
        // With Coinbase unknown nothing disagrees, unless this bar itself cannot be trusted.
        if ((other !== null || bar.substitute) && !p.mismatches.includes(key)) {
          p.mismatches.push(key);
          event({ at: now, action: 'TOUCH_MISMATCH', bound, touched: source, coinbaseKnown: other !== null });
        }
      }
      const assumed = bar.substitute && other === null && bound === 'floor';
      if (!own || (bar.substitute && other !== true && !assumed)) continue;
      if (bound === 'floor') closePosition(now, 0, 'knock_out_floor', p.contract.floor, { coinbaseTouched: other, ...(assumed ? { uncertain: true } : {}) });
      else closePosition(now, settlementProceeds(p.contract.ceiling, p.contract, p.contracts), 'knock_out_ceiling', p.contract.ceiling, { coinbaseTouched: other });
      return;
    }
    if (now >= p.contract.expiry) closePosition(now, settlementProceeds(bar.close, p.contract, p.contracts), 'expiry', bar.close);
  };

  /** Evaluate the rule on the newest bar: the book's own decision and the flat-market signal. */
  const evaluate = (tf, last) => {
    const now = last.timestamp + MINUTE_MS;
    // The rule's windows count bars, so across a large hole old prices would read as the last hour.
    const hour = tf['1m'].slice(-params.dropWindowMin);
    const missing = (last.timestamp - hour[0].timestamp) / MINUTE_MS + 1 - hour.length;
    const features = missing > MAX_MISSING_MINUTES ? null : computeUpDipFeatures(tf, params);
    const halfSpread = getHalfSpread(params.range);
    const gate = (raw) => {
      const opens = raw.action === 'ENTER' || raw.action === 'ADD';
      const decision = last.substitute && opens ? { action: raw.action === 'ADD' ? 'HOLD' : 'STAND_ASIDE', reasons: ['waiting for index data'] } : raw;
      return entryFilter ? entryFilter({ tf, features, decision }) : { decision, filter: null };
    };
    const book = needsReset
      ? gate({ action: 'STAND_ASIDE', reasons: ['needs reset: this book was priced differently'] })
      : gate(decideUpDip({ features, position: state.position, now, halfSpread, lastExitAt: state.lastExitAt, params, pick }));
    const { decision: signal } = gate(decideUpDip({ features, position: null, now, halfSpread, params, pick }));
    return { now, features, decision: book.decision, signal, filter: book.filter,
      latest: { at: now, decision: book.decision, signal, features, ...(entryFilter ? { filter: book.filter } : {}) } };
  };
  // ENTER is usually a one-bar window; keep the last one so it can still be seen afterwards.
  const entrySignal = ({ now, features, signal }) => (signal.action === 'ENTER' ? { at: now, btc: features.price, contract: signal.contract, bookHeld: !needsReset && !!state.position } : null);

  /** Process every completed 1m bar since the last step. Returns true when there was one. */
  const step = () => {
    const tf = Object.fromEntries(TFS.map(t => [t, getCandles(t) || []]));
    const m1 = tf['1m'];
    if (!m1.length) return false;
    const last = m1[m1.length - 1];
    if (last.timestamp <= (needsReset ? frozen.lastBarTs : state.lastBarTs)) return false;

    if (needsReset) {
      const result = evaluate(tf, last);
      frozen = { lastBarTs: last.timestamp, latest: result.latest, lastEntrySignal: entrySignal(result) ?? frozen.lastEntrySignal };
      onChange?.();
      return true;
    }

    state.startedAt ??= last.timestamp;
    // Replay every bar still in the buffer since the last step (normally one), in order, so
    // fills, knock-outs and expiry in a restart gap are priced on their own bars.
    const halfSpread = getHalfSpread(params.range);
    for (const bar of m1.filter(c => c.timestamp > state.lastBarTs)) {
      if (state.lastBarTs > 0 && bar.timestamp - state.lastBarTs > MINUTE_MS) {
        settleExpiredInGap(bar, state.lastBarTs);
        recordGap(bar, state.lastBarTs);
      }
      fillPending(bar, halfSpread);
      settle(bar);
      state.lastBarTs = bar.timestamp;
      state.lastClose = bar.close;
    }
    // Decide on the newest bar with the full buffers.
    const result = evaluate(tf, last);
    const { now, features, decision } = result;
    const prev = state.latest?.decision?.action;
    state.latest = result.latest;
    state.lastEntrySignal = entrySignal(result) ?? state.lastEntrySignal;
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
      return { from: r.from, split: r.split, to: r.to, spread: r.spread ?? null, listing: r.listing ?? null, train: pick(r.defaults?.train), test: pick(r.defaults?.test) };
    } catch { return null; }
  };

  const getStatus = () => {
    const { latest, lastEntrySignal } = needsReset ? frozen : state;
    // A frozen book settles nothing, so a live mark could show a contract recovering from a knock-out.
    const price = (needsReset ? state.latest : latest)?.features?.price;
    const cycles = state.cycles;
    const t = state.totals;
    // A frozen book keeps the pricing it was recorded with, which had no spread.
    const markSpread = () => (needsReset ? 0 : getHalfSpread(params.range));
    return {
      paperOnly: true,
      params,
      needsReset,
      frozenAt: needsReset && state.lastBarTs ? state.lastBarTs + MINUTE_MS : null,
      pricing: state.pricing,
      archived,
      ...(entryFilter ? { filter: latest?.filter ?? null } : {}),
      startedAt: state.startedAt,
      latest,
      lastEntrySignal,
      pending: state.pending ? { action: state.pending.action } : null,
      position: state.position ? { ...state.position, cost: r2(state.position.cost),
        ...(price ? { markBtc: price, pnl: r2(markPosition(state.position, price, markSpread()).pnl) } : {}) } : null,
      summary: { cycles: t.cycles, wins: t.wins, losses: t.losses, pnl: t.pnl, worst: t.worst, gaps: state.gaps || 0 },
      cycles: cycles.slice(-50).reverse(),
      events: state.events.slice(-30).reverse(),
      backtest: readBacktest(),
    };
  };

  /** Poll for newly completed 1m bars every intervalMs; returns a stop function. */
  let timer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = (intervalMs = 15_000) => {
    stop();
    const run = () => {
      try { step(); } catch (err) { logger?.warn?.(`⚠️ 📊 ${label} step failed err=${err.message}`, { action: 'up-dip-step', error: err.message }); }
    };
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
    return stop;
  };

  /** Re-read the state file (after a restore) so in-memory state never overwrites it. */
  const reload = () => { load(); };

  return { step, getStatus, start, stop, reload };
};

module.exports = { createUpDipPaper, emptyState, hasTraded, isStamped };
