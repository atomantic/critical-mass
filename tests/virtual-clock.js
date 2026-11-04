'use strict';

/**
 * Controlled clock for tests that exercise production retry, poll and throttle
 * delays. It mocks `setTimeout` and `Date` through the test context (`t.mock`),
 * so the Node test runner restores both when the test ends, even if it fails.
 * `setImmediate` stays real and is used to let promise chains settle between
 * ticks, so time only moves when a test asks it to.
 */

const DEFAULT_NOW = 1_700_000_000_000;
const DEFAULT_STEP_MS = 50;
const DEFAULT_MAX_MS = 120_000;

/** Let every promise continuation that is already runnable finish. */
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Mock `setTimeout` and `Date` for the running test.
 * @param {import('node:test').TestContext} t
 * @param {{ now?: number, stepMs?: number, maxMs?: number }} [options]
 *   stepMs: tick granularity while waiting; timers firing inside one step run together,
 *   so keep it smaller than the shortest interval a test needs to observe in order.
 */
const useVirtualClock = (t, { now = DEFAULT_NOW, stepMs = DEFAULT_STEP_MS, maxMs = DEFAULT_MAX_MS } = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });

  /** Move virtual time forward by `ms`, letting promise chains settle after each step. */
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= stepMs) {
      t.mock.timers.tick(Math.min(stepMs, left));
      await settle();
    }
  };

  /** Resolve `promise`, advancing virtual time only while it is still pending. */
  const run = async (promise) => {
    let outcome = null;
    Promise.resolve(promise).then(
      (value) => { outcome = { value }; },
      (error) => { outcome = { error }; },
    );
    await settle();
    for (let elapsed = 0; !outcome; elapsed += stepMs) {
      if (elapsed >= maxMs) throw new Error(`virtual clock: promise still pending after ${maxMs} virtual ms`);
      t.mock.timers.tick(stepMs);
      await settle();
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };

  return { advance, run, now: () => Date.now() };
};

module.exports = { useVirtualClock, settle };
