// @ts-check
/**
 * Flush-Reversal Setup ("1m vs daily" dip buy)
 *
 * Captures the operator's manual UP-option entry: on a red day, the 1-minute
 * chart flushes to a fresh 24h low and then turns back up. Buy the turn, take
 * the bounce. The composite indicator score reads that same moment as bearish
 * (every short timeframe is oversold AND falling), so it never published BUY
 * at the operator's winning entries — this detector is a separate, explicit
 * rule rather than another weight in the composite.
 *
 * Rule, evaluated once per completed 1m candle:
 *   ARM when the candle
 *     - prints a fresh 24h low (low <= every low of the prior 24h),
 *     - is >= minDropPct below the highest high of the last dropWindowMin,
 *     - is >= minBelowDailyPct below the prior daily close (the day is red),
 *     - closes with 1m RSI <= maxRsi.
 *   ENTER (publish BUY) when, within armWindowMin of the last flush candle, a
 *     1m close bounces >= confirmBouncePct off the flush low (the low keeps
 *     trailing down while armed), and cooldownMin has passed since the last entry.
 *   EXIT at +takeProfitPct / -stopLossPct from entry or after maxHoldMin.
 *
 * Calibration (2026-09-26, Coinbase BTC-USD 1m, 107 days across Feb-Apr, Jul
 * and Aug-Sep 2026): 61 entries, 35 target / 20 stop / 6 timeout, +0.27% BTC
 * per entry vs -0.05% for unconditional entries under the same exits, and not
 * negative in any period. Breakout-style entries are not modeled. Reproduce
 * with scripts/backtest-flush-setup.js.
 *
 * `stepFlushSetup` is pure; `createFlushSetupTracker` adapts the live candle
 * buffers to it. The backtest script feeds the same step function.
 */

const { calculateRSI } = require('./indicators');

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FIFTEEN_MIN_MS = 15 * MINUTE_MS;

const FLUSH_SETUP_PARAMS = Object.freeze({
  dropWindowMin: 120,
  minDropPct: 1.3,
  lowLookbackMin: 1440,
  minBelowDailyPct: 0.3,
  maxRsi: 35,
  rsiPeriod: 14,
  /** Closes fed to RSI — matches the live 1m buffer (180) so replay == live. */
  rsiWindow: 180,
  confirmBouncePct: 0.15,
  armWindowMin: 60,
  cooldownMin: 240,
  takeProfitPct: 1.0,
  stopLossPct: 1.0,
  maxHoldMin: 720,
});

/**
 * @typedef {{
 *   phase: 'idle'|'armed'|'active',
 *   lastBarTs: number,
 *   flushLow: number|null,
 *   armedAt: number|null,
 *   armedMetrics: {dropPct: number, belowDailyPct: number, rsi: number}|null,
 *   entryPrice: number|null,
 *   enteredAt: number|null,
 *   targetPrice: number|null,
 *   stopPrice: number|null,
 *   lastEntryAt: number|null,
 *   lastExit: {reason: 'target'|'stop'|'timeout', price: number, at: number, entryPrice: number, pnlPct: number}|null,
 * }} FlushSetupState
 */

/** @returns {FlushSetupState} */
const createFlushSetupState = () => ({
  phase: 'idle',
  lastBarTs: 0,
  flushLow: null,
  armedAt: null,
  armedMetrics: null,
  entryPrice: null,
  enteredAt: null,
  targetPrice: null,
  stopPrice: null,
  lastEntryAt: null,
  lastExit: null,
});

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Advance the setup by one completed 1m bar.
 * @param {FlushSetupState} state
 * @param {{
 *   timestamp: number, high: number, low: number, close: number,
 *   priorLow: number|null,     // lowest low of the lowLookbackMin before this bar
 *   windowHigh: number|null,   // highest high of the dropWindowMin ending with this bar
 *   dailyRefClose: number|null,// prior UTC day's close
 *   rsi: number|null,          // 1m RSI at this bar's close
 * }} bar
 * @param {typeof FLUSH_SETUP_PARAMS} [params]
 * @returns {{state: FlushSetupState, event: null|'armed'|'entered'|'exited'}}
 */
const stepFlushSetup = (state, bar, params = FLUSH_SETUP_PARAMS) => {
  const s = { ...state, lastBarTs: bar.timestamp };
  const closeTs = bar.timestamp + MINUTE_MS;

  if (s.phase === 'active') {
    let reason = null;
    let price = null;
    // Stop first: inside one 1m bar we cannot know which side printed first,
    // so assume the adverse one.
    if (bar.low <= s.stopPrice) { reason = 'stop'; price = s.stopPrice; }
    else if (bar.high >= s.targetPrice) { reason = 'target'; price = s.targetPrice; }
    else if (closeTs - s.enteredAt >= params.maxHoldMin * MINUTE_MS) { reason = 'timeout'; price = bar.close; }
    if (!reason) return { state: s, event: null };
    const entryPrice = /** @type {number} */ (s.entryPrice);
    return {
      state: {
        ...s,
        phase: 'idle',
        flushLow: null,
        armedAt: null,
        armedMetrics: null,
        entryPrice: null,
        enteredAt: null,
        targetPrice: null,
        stopPrice: null,
        lastExit: { reason, price, at: closeTs, entryPrice, pnlPct: round2((price / entryPrice - 1) * 100) },
      },
      event: 'exited',
    };
  }

  const ready = Number.isFinite(bar.priorLow) && Number.isFinite(bar.windowHigh) &&
    Number.isFinite(bar.dailyRefClose) && Number.isFinite(bar.rsi) &&
    bar.windowHigh > 0 && bar.dailyRefClose > 0;
  if (ready) {
    const dropPct = (1 - bar.low / bar.windowHigh) * 100;
    const belowDailyPct = (1 - bar.low / bar.dailyRefClose) * 100;
    const isFlush = bar.low <= bar.priorLow &&
      dropPct >= params.minDropPct &&
      belowDailyPct >= params.minBelowDailyPct &&
      bar.rsi <= params.maxRsi;
    if (isFlush) {
      return {
        state: {
          ...s,
          phase: 'armed',
          flushLow: s.phase === 'armed' && s.flushLow != null ? Math.min(s.flushLow, bar.low) : bar.low,
          armedAt: bar.timestamp,
          armedMetrics: { dropPct: round2(dropPct), belowDailyPct: round2(belowDailyPct), rsi: round2(bar.rsi) },
        },
        event: 'armed',
      };
    }
  }

  if (s.phase !== 'armed') return { state: s, event: null };

  const flushLow = Math.min(/** @type {number} */ (s.flushLow), bar.low);
  if (bar.timestamp - /** @type {number} */ (s.armedAt) > params.armWindowMin * MINUTE_MS) {
    return { state: { ...s, phase: 'idle', flushLow: null, armedAt: null, armedMetrics: null }, event: null };
  }
  const bounced = bar.close >= flushLow * (1 + params.confirmBouncePct / 100);
  const cooled = s.lastEntryAt == null || closeTs - s.lastEntryAt > params.cooldownMin * MINUTE_MS;
  if (!bounced || !cooled) return { state: { ...s, flushLow }, event: null };

  const entryPrice = bar.close;
  return {
    state: {
      ...s,
      phase: 'active',
      flushLow,
      entryPrice,
      enteredAt: closeTs,
      lastEntryAt: closeTs,
      targetPrice: round2(entryPrice * (1 + params.takeProfitPct / 100)),
      stopPrice: round2(entryPrice * (1 - params.stopLossPct / 100)),
    },
    event: 'entered',
  };
};

/**
 * Derive the per-bar features for 1m candle `idx` from the live buffers.
 * @param {Array<{timestamp: number, high: number, low: number, close: number}>} c1m
 * @param {number} idx
 * @param {Array<{timestamp: number, low: number}>} c15m
 * @param {Array<{timestamp: number, close: number}>} c1d
 * @param {typeof FLUSH_SETUP_PARAMS} params
 */
const liveBarFeatures = (c1m, idx, c15m, c1d, params) => {
  const bar = c1m[idx];
  const ts = bar.timestamp;
  const lookbackStart = ts - params.lowLookbackMin * MINUTE_MS;

  // The 1m buffer holds ~3h, so the 24h low comes from completed 15m candles
  // plus the 1m candles since the newest one. Coverage must reach back the full
  // lookback or the "fresh low" test is meaningless — fail closed until it does.
  let priorLow = Infinity;
  let earliest = Infinity;
  for (const c of c15m) {
    if (c.timestamp + FIFTEEN_MIN_MS > ts || c.timestamp + FIFTEEN_MIN_MS <= lookbackStart) continue;
    if (c.low < priorLow) priorLow = c.low;
    if (c.timestamp < earliest) earliest = c.timestamp;
  }
  for (let i = 0; i < idx; i++) {
    const c = c1m[i];
    if (c.timestamp < lookbackStart) continue;
    if (c.low < priorLow) priorLow = c.low;
    if (c.timestamp < earliest) earliest = c.timestamp;
  }
  const covered = earliest <= lookbackStart + FIFTEEN_MIN_MS;

  const windowStart = ts - (params.dropWindowMin - 1) * MINUTE_MS;
  let windowHigh = -Infinity;
  let windowFirst = Infinity;
  for (let i = idx; i >= 0 && c1m[i].timestamp >= windowStart; i--) {
    if (c1m[i].high > windowHigh) windowHigh = c1m[i].high;
    windowFirst = c1m[i].timestamp;
  }
  const windowCovered = windowFirst <= windowStart;

  // Prior UTC day's close; only trust it when it is actually yesterday's candle.
  const dayStart = Math.floor(ts / DAY_MS) * DAY_MS;
  const prevDay = c1d.length > 0 ? c1d[c1d.length - 1] : null;
  const dailyRefClose = prevDay && prevDay.timestamp === dayStart - DAY_MS ? prevDay.close : null;

  const closes = c1m.slice(Math.max(0, idx + 1 - params.rsiWindow), idx + 1).map(c => c.close);

  return {
    timestamp: ts,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    priorLow: covered && Number.isFinite(priorLow) ? priorLow : null,
    windowHigh: windowCovered && Number.isFinite(windowHigh) ? windowHigh : null,
    dailyRefClose,
    rsi: calculateRSI(closes, params.rsiPeriod),
  };
};

/**
 * Stateful adapter over the live candle aggregator.
 * @param {typeof FLUSH_SETUP_PARAMS} [params]
 */
const createFlushSetupTracker = (params = FLUSH_SETUP_PARAMS) => {
  let state = createFlushSetupState();

  /**
   * Process every completed 1m candle newer than the last one seen.
   * @param {{getCandles: (tf: string) => Array}} candleAggregator
   * @returns {{state: FlushSetupState, events: Array<'armed'|'entered'|'exited'>}}
   */
  const update = (candleAggregator) => {
    const c1m = candleAggregator.getCandles('1m') || [];
    const events = [];
    if (c1m.length === 0) return { state, events };
    const c15m = candleAggregator.getCandles('15m') || [];
    const c1d = candleAggregator.getCandles('1d') || [];
    for (let i = 0; i < c1m.length; i++) {
      if (c1m[i].timestamp <= state.lastBarTs) continue;
      const step = stepFlushSetup(state, liveBarFeatures(c1m, i, c15m, c1d, params), params);
      state = step.state;
      if (step.event) events.push(step.event);
    }
    return { state, events };
  };

  const getState = () => ({ ...state });
  /** @param {Partial<FlushSetupState>|null|undefined} next */
  const setState = (next) => {
    if (!next || typeof next !== 'object') return;
    state = { ...createFlushSetupState(), ...next };
  };

  return { update, getState, setState };
};

/**
 * Offline replay over contiguous-or-gapped 1m history (oldest first). Windows
 * are by timestamp, so exchange gaps (minutes with no trades) are tolerated;
 * unordered or duplicate rows are rejected. Returns every completed entry with
 * its exit — the same state machine the live engine runs.
 * @param {Array<{timestamp: number, open: number, high: number, low: number, close: number}>} candles
 * @param {typeof FLUSH_SETUP_PARAMS} [params]
 * @returns {{entries: Array<{enteredAt: number, entryPrice: number, flushLow: number|null, armedMetrics: object|null, exit: object|null}>, summary: {entries: number, target: number, stop: number, timeout: number, open: number, avgPnlPct: number|null}}}
 */
const replayFlushSetup = (candles, params = FLUSH_SETUP_PARAMS) => {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !Number.isSafeInteger(c.timestamp) || c.timestamp % MINUTE_MS !== 0 ||
      !['high', 'low', 'close'].every(k => Number.isFinite(c[k]) && c[k] > 0) ||
      (i > 0 && c.timestamp <= candles[i - 1].timestamp)) {
      throw new Error(`Invalid, duplicate or unordered 1m candle at index ${i}`);
    }
  }
  const lowLookbackMs = params.lowLookbackMin * MINUTE_MS;
  const dropWindowMs = params.dropWindowMin * MINUTE_MS;
  /** @type {number[]} */ const lowQ = []; // indices, increasing lows
  /** @type {number[]} */ const highQ = []; // indices, decreasing highs
  let lowHead = 0;
  let highHead = 0;
  const dailyClose = new Map();
  let state = createFlushSetupState();
  const entries = [];
  let current = null;
  const first = candles.length > 0 ? candles[0].timestamp : 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ts = c.timestamp;
    // Prior 24h low, excluding this bar.
    while (lowHead < lowQ.length && candles[lowQ[lowHead]].timestamp < ts - lowLookbackMs) lowHead++;
    const priorLow = ts - first >= lowLookbackMs && lowHead < lowQ.length ? candles[lowQ[lowHead]].low : null;
    // Highest high of the drop window, including this bar.
    while (highQ.length > highHead && candles[highQ[highQ.length - 1]].high <= c.high) highQ.pop();
    highQ.push(i);
    while (candles[highQ[highHead]].timestamp <= ts - dropWindowMs) highHead++;
    const windowHigh = ts - first >= dropWindowMs ? candles[highQ[highHead]].high : null;

    const dayStart = Math.floor(ts / DAY_MS) * DAY_MS;
    const closes = [];
    for (let j = Math.max(0, i + 1 - params.rsiWindow); j <= i; j++) closes.push(candles[j].close);

    const step = stepFlushSetup(state, {
      timestamp: ts, high: c.high, low: c.low, close: c.close,
      priorLow, windowHigh,
      dailyRefClose: dailyClose.get(dayStart - DAY_MS) ?? null,
      rsi: calculateRSI(closes, params.rsiPeriod),
    }, params);
    state = step.state;
    if (step.event === 'entered') {
      current = { enteredAt: state.enteredAt, entryPrice: state.entryPrice, flushLow: state.flushLow, armedMetrics: state.armedMetrics, exit: null };
      entries.push(current);
    } else if (step.event === 'exited' && current) {
      current.exit = state.lastExit;
      current = null;
    }

    while (lowQ.length > lowHead && candles[lowQ[lowQ.length - 1]].low >= c.low) lowQ.pop();
    lowQ.push(i);
    dailyClose.set(dayStart, c.close);
  }

  const closed = entries.filter(e => e.exit);
  const count = (reason) => closed.filter(e => e.exit.reason === reason).length;
  return {
    entries,
    summary: {
      entries: entries.length,
      target: count('target'),
      stop: count('stop'),
      timeout: count('timeout'),
      open: entries.length - closed.length,
      avgPnlPct: closed.length ? round2(closed.reduce((a, e) => a + e.exit.pnlPct, 0) / closed.length) : null,
    },
  };
};

module.exports = {
  FLUSH_SETUP_PARAMS,
  createFlushSetupState,
  stepFlushSetup,
  createFlushSetupTracker,
  replayFlushSetup,
};
