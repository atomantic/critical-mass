'use strict';

/**
 * A small Map-like store whose entries expire after a fixed interval.
 * Re-adding a key replaces its value and restarts its expiry window.
 *
 * @param {number} ttlMs
 */
function createTtlStore(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('ttlMs must be a non-negative finite number');
  }

  const entries = new Map();
  const timers = new Map();

  const deleteEntry = (key) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    return entries.delete(key);
  };

  return {
    add(key, value = true) {
      deleteEntry(key);
      entries.set(key, value);
      const timer = setTimeout(() => {
        if (timers.get(key) !== timer) return;
        timers.delete(key);
        entries.delete(key);
      }, ttlMs);
      if (typeof timer.unref === 'function') timer.unref();
      timers.set(key, timer);
      return this;
    },
    has(key) {
      return entries.has(key);
    },
    get(key) {
      return entries.get(key);
    },
    delete: deleteEntry,
    clear() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      entries.clear();
    },
    cancelTimers() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    get size() {
      return entries.size;
    },
    get pendingTimerCount() {
      return timers.size;
    },
    [Symbol.iterator]() {
      return entries[Symbol.iterator]();
    },
  };
}

module.exports = { createTtlStore };
