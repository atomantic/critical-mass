// @ts-check
/**
 * 1-second BTC bars built from individual trades. Pure: no I/O, no timers.
 *
 * Only seconds that traded are stored. Quiet seconds are derived on read as flat
 * bars between two trades at most `maxFlatGapMs` apart on one connection, so a
 * stalled feed leaves a gap instead of invented prices, and a late trade simply
 * changes what is derived. Nothing is retracted.
 */

const SECOND_MS = 1000;

/**
 * @typedef {{t: number, open: number, high: number, low: number, close: number, buyVolume: number, sellVolume: number, trades: number}} Bar
 * @typedef {{timestamp: number, id: number, seq: number}} TradeKey
 * @typedef {{bar: Bar, epoch: number, first: TradeKey, last: TradeKey}} Entry
 */

const floorSecond = (ms) => Math.floor(ms / SECOND_MS) * SECOND_MS;
const positive = (n) => Number.isFinite(n) && n > 0;

/**
 * Exchange time, then numeric trade id, then arrival.
 * @param {TradeKey} a @param {TradeKey} b
 */
const compareKeys = (a, b) => (a.timestamp - b.timestamp)
  || (Number.isFinite(a.id) && Number.isFinite(b.id) ? a.id - b.id : 0)
  || (a.seq - b.seq);

/**
 * @param {{now?: () => number, retentionSeconds?: number, maxTradeAgeMs?: number, maxFutureMs?: number, maxFlatGapMs?: number}} [options]
 */
const createSecondBars = ({ now = Date.now, retentionSeconds = 3600, maxTradeAgeMs = 10_000, maxFutureMs = 5_000, maxFlatGapMs = 5_000 } = {}) => {
  /** @type {Entry[]} ascending by bar.t */
  let entries = [];
  /** @type {Map<string, number>} trade id -> exchange time, for ids young enough to be repeated */
  const seen = new Map();
  let epoch = 0;
  let seq = 0;
  let connected = false;
  let acceptFrom = Infinity;
  /** @type {number | null} */
  let lastAcceptedAt = null;
  /** @type {{from: number, to: number} | null} */
  let dirty = null;

  const markConnected = () => {
    connected = true;
    epoch++;
    // The exchange replays recent trades on subscribe, and the second in progress
    // is partial, so bars start at the next whole second.
    acceptFrom = floorSecond(now()) + SECOND_MS;
  };
  const markDisconnected = () => { connected = false; };

  const evict = (at) => {
    const cutoff = at - retentionSeconds * SECOND_MS;
    let drop = 0;
    while (drop < entries.length && entries[drop].bar.t <= cutoff) drop++;
    if (drop) entries = entries.slice(drop);
    for (const [id, timestamp] of seen) {
      if (at - timestamp > maxTradeAgeMs) seen.delete(id);
    }
  };

  /** Index of the first entry at or after `t`; trades mostly land at the end. */
  const indexFrom = (t) => {
    let i = entries.length;
    while (i > 0 && entries[i - 1].bar.t >= t) i--;
    return i;
  };

  /**
   * @param {{tradeId: string, price: number, size: number, side: 'buy' | 'sell', timestamp: number}} trade - `side` is the taker side
   * @returns {'accepted' | 'duplicate' | 'late' | 'pre-connect' | 'invalid'}
   */
  const addTrade = ({ tradeId, price, size, side, timestamp }) => {
    const at = now();
    if (!tradeId || !positive(price) || !positive(size) || (side !== 'buy' && side !== 'sell')
      || !Number.isFinite(timestamp) || timestamp - at > maxFutureMs) return 'invalid';
    if (!connected || timestamp < acceptFrom) return 'pre-connect';
    if (at - timestamp > maxTradeAgeMs) return 'late';
    if (seen.has(tradeId)) return 'duplicate';
    evict(at);
    seen.set(tradeId, timestamp);
    lastAcceptedAt = at;

    const t = floorSecond(timestamp);
    const key = { timestamp, id: Number(tradeId), seq: seq++ };
    const i = indexFrom(t);
    const entry = entries[i]?.bar.t === t ? entries[i] : null;
    if (entry) {
      const { bar } = entry;
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      if (compareKeys(key, entry.first) < 0) { entry.first = key; bar.open = price; }
      if (compareKeys(key, entry.last) > 0) { entry.last = key; bar.close = price; }
    } else {
      entries.splice(i, 0, {
        bar: { t, open: price, high: price, low: price, close: price, buyVolume: 0, sellVolume: 0, trades: 0 },
        epoch, first: key, last: key,
      });
    }
    const { bar } = entries[i];
    if (side === 'buy') bar.buyVolume += size;
    else bar.sellVolume += size;
    bar.trades++;

    const from = entries[i - 1]?.bar.t ?? t;
    const to = entries[i + 1]?.bar.t ?? t;
    dirty = dirty ? { from: Math.min(dirty.from, from), to: Math.max(dirty.to, to) } : { from, to };
    return 'accepted';
  };

  /** Traded bars plus derived flat bars with from <= t <= to. */
  const read = (from, to) => {
    /** @type {Bar[]} */
    const out = [];
    const push = (bar) => { if (bar.t >= from && bar.t <= to) out.push({ ...bar }); };
    // Start one entry early: flat bars inside the range may follow an earlier trade.
    for (let i = Math.max(0, indexFrom(from) - 1); i < entries.length && entries[i].bar.t <= to; i++) {
      const { bar, epoch: e, last } = entries[i];
      push(bar);
      const next = entries[i + 1];
      if (!next || next.epoch !== e || next.first.timestamp - last.timestamp > maxFlatGapMs) continue;
      for (let t = bar.t + SECOND_MS; t < next.bar.t; t += SECOND_MS) {
        push({ t, open: bar.close, high: bar.close, low: bar.close, close: bar.close, buyVolume: 0, sellVolume: 0, trades: 0 });
      }
    }
    return out;
  };

  /** @param {number} seconds @returns {Bar[]} */
  const getBars = (seconds) => {
    const at = now();
    evict(at);
    return read(floorSecond(at) - (seconds - 1) * SECOND_MS, Infinity);
  };

  /** @returns {Bar[]} bars that may have changed since the last call */
  const drainChanged = () => {
    if (!dirty) return [];
    const { from, to } = dirty;
    dirty = null;
    return read(from, to);
  };

  return { markConnected, markDisconnected, addTrade, getBars, drainChanged, getLastAcceptedAt: () => lastAcceptedAt, getLastPrice: () => entries[entries.length - 1]?.bar.close };
};

module.exports = { createSecondBars };
