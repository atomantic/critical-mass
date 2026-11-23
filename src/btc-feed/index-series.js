// @ts-check
/** Index values by second (the latest value in each second). Pure: no I/O, no timers. */

const SECOND_MS = 1000;
const floorSecond = (ms) => Math.floor(ms / SECOND_MS) * SECOND_MS;

/**
 * @param {{now?: () => number, retentionSeconds?: number, maxAgeMs?: number, maxFutureMs?: number}} [options]
 */
const createIndexSeries = ({ now = Date.now, retentionSeconds = 3600, maxAgeMs = 10_000, maxFutureMs = 5_000 } = {}) => {
  /** @type {Map<number, number>} second -> latest value */
  const bySecond = new Map();
  const changed = new Set();
  /** @type {number | null} */
  let lastAcceptedAt = null;
  let newest = -Infinity;

  const evict = (at) => {
    const cutoff = at - retentionSeconds * SECOND_MS;
    for (const t of bySecond.keys()) {
      if (t <= cutoff) bySecond.delete(t);
    }
  };

  /** @param {{value: number, timestamp: number}} sample @returns {boolean} whether it was accepted */
  const add = ({ value, timestamp }) => {
    const at = now();
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(timestamp)) return false;
    if (at - timestamp > maxAgeMs || timestamp - at > maxFutureMs) return false;
    // A repeated or older value is not news: it must not keep a stalled index looking live.
    if (timestamp <= newest) return false;
    newest = timestamp;
    lastAcceptedAt = at;
    const t = floorSecond(timestamp);
    evict(at);
    bySecond.set(t, value);
    changed.add(t);
    return true;
  };

  const read = (keep) => [...bySecond]
    .filter(([t]) => keep(t))
    .sort(([a], [b]) => a - b)
    .map(([t, value]) => ({ t, value }));

  /** @param {number} seconds */
  const getValues = (seconds) => {
    const at = now();
    evict(at);
    const from = floorSecond(at) - (seconds - 1) * SECOND_MS;
    return read((t) => t >= from);
  };

  const drainChanged = () => {
    if (!changed.size) return [];
    const out = read((t) => changed.has(t));
    changed.clear();
    return out;
  };

  return { add, getValues, drainChanged, getLastAcceptedAt: () => lastAcceptedAt };
};

module.exports = { createIndexSeries };
