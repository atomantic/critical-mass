// @ts-check
//
// Controlled clock for fixtures that reach regime-engine's order-fill
// fallbacks (fetchRawFillsWithRetry waits 2,000ms before its one re-read when
// getOrderFills is empty or throws). Those waits are deterministic stub
// outcomes, not remote latency, so a fixture must advance them virtually
// instead of sleeping.
//
// Only setTimeout is mocked. setImmediate stays real so drainPromises() can
// flush promise continuations without moving any deadline, and setInterval /
// Date stay real so startup timers keep their production behaviour and are
// stopped by the fixture's own cleanup. Never use mock.timers.runAll(): it
// would also expire the 60s/5min deduplication TTLs and the engine-level retry
// timers, weakening replay/idempotence assertions.
//
// Usage:
//   const clock = installFallbackClock({ cleanup: () => { ...stop engines... } });
//   await clock.run(() => eng.start(), { waits: [2000] });
const { beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/** The engine's production fallback delay in fetchRawFillsWithRetry. */
const FILL_FALLBACK_MS = 2000;

// setImmediate stays real: it drains pending promise continuations without
// advancing fallback, engine retry, or deduplication TTL deadlines.
const drainPromises = () => new Promise(resolve => setImmediate(resolve));

const advanceClock = async (ms) => {
  mock.timers.tick(ms);
  await drainPromises();
};

// A few rounds so a stub that needs more than one macrotask hop to reach its
// next timer (or to finish after one) is not mistaken for a pending wait.
const SETTLE_ROUNDS = 5;

/**
 * Install per-test setTimeout mocking and guaranteed teardown. Call at file or
 * describe scope so beforeEach/afterEach attach to that scope.
 *
 * @param {{ cleanup?: () => (void | Promise<void>) }} [options] cleanup runs
 *   after every test (including failed ones) while the mocked clock is still
 *   installed; call `clock.restore()` inside it first if it needs real timers.
 * @returns {{
 *   run: <T>(operation: () => Promise<T>, options?: RunOptions) => Promise<T>,
 *   advance: (ms: number) => Promise<void>,
 *   drain: () => Promise<void>,
 *   restore: () => void,
 * }}
 */
const installFallbackClock = ({ cleanup = () => {} } = {}) => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(async () => {
    try {
      await drainPromises();
    } finally {
      try {
        await cleanup();
      } finally {
        mock.timers.reset();
      }
    }
  });

  /**
   * @typedef {Object} RunOptions
   * @property {number[]} [waits] Fallback waits the operation must block on,
   *   in order (default one 2,000ms fallback). Each is advanced to exactly
   *   wait-1 (asserting the operation is still pending), then the final 1ms.
   * @property {boolean} [optional] The operation may settle before a wait is
   *   reached (used when only some inputs reach the fallback).
   * @property {() => number} [observe] A monotonically increasing counter of
   *   the re-read the fallback performs (e.g. getOrderFills calls). Asserted
   *   unchanged before each virtual deadline and increased after it.
   * @property {() => void} [beforeAdvance] Runs before each advance (for
   *   fixtures that re-arm stubs between the first read and the retry).
   */
  const run = async (operation, { waits = [FILL_FALLBACK_MS], optional = false, observe, beforeAdvance = () => {} } = {}) => {
    let settled = false;
    // Attach rejection handling immediately; assertions may run before the
    // caller's assert.rejects gets the eventual rejection.
    const result = operation().then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    for (let i = 0; i < SETTLE_ROUNDS && !settled; i++) await drainPromises();
    for (const wait of waits) {
      if (settled) {
        assert.ok(optional, `the operation settled before its ${wait}ms fallback deadline`);
        break;
      }
      const callsBefore = observe?.();
      beforeAdvance();
      await advanceClock(wait - 1);
      assert.equal(settled, false, `the operation must still be pending before ${wait}ms`);
      if (observe) assert.equal(observe(), callsBefore, `no fallback fetch may happen before ${wait}ms`);
      beforeAdvance();
      await advanceClock(1);
      for (let i = 0; i < SETTLE_ROUNDS && !settled; i++) await drainPromises();
      if (observe) assert.ok(observe() > callsBefore, `the fallback fetch must happen at ${wait}ms`);
    }
    assert.equal(settled, true, 'the operation must finish at its final fallback deadline');
    const outcome = await result;
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };

  return { run, advance: advanceClock, drain: drainPromises, restore: () => mock.timers.reset() };
};

module.exports = { installFallbackClock, drainPromises, FILL_FALLBACK_MS };
