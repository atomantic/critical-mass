// @ts-check
/**
 * Issue #532 — a persistence failure must degrade a live trading engine, never
 * terminate it.
 *
 * Two callbacks used to invoke throwing persistence code from contexts where a
 * synchronous throw is an `uncaughtException`, and no process registered a
 * handler for one:
 *   - the SIGUSR1 state-reload handler (the operator's documented "apply a
 *     manual state fix without restarting" workflow — the same workflow that
 *     produces malformed JSON), and
 *   - the 5-minute `setInterval(saveLiveState, ...)` state saver (ENOSPC /
 *     EACCES / EROFS out of `atomicWriteSync`).
 *
 * Either one killed the process, PM2 restarted it into the same fault, and the
 * restart budget was gone in under a minute — with resting buy and take-profit
 * orders left on the exchange and no notification to the operator.
 *
 * Covers:
 *  - src/health-monitor.js: consecutive save failures escalate to SAFE mode and
 *    hold it, while a pure persistence fault is distinguishable from a market
 *    one so resting orders are not cancelled.
 *  - src/regime-engine.js: the guarded background save, the guarded SIGUSR1
 *    reload (including a REAL signal delivery), and a boot against a corrupt
 *    state file returning a structured failure instead of throwing.
 *  - src/state-tracker.js: loadRegimeStateSafe surfaces the repair message.
 *  - src/process-guard.js: last-resort reporters log, notify, flush, exit(1).
 *
 * No PM2 and no live data files: the engine uses a throwaway pair whose data
 * dir is deleted afterwards, and the adapter / order executor are stubs.
 */
const { describe, it, before, beforeEach, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-persistence-test');

const {
  createHealthMonitor,
  createInitialHealthState,
  isPersistenceOnlySafeReason,
  MAX_CONSECUTIVE_PERSISTENCE_FAILURES,
  PERSISTENCE_FAILED_PREFIX,
} = require('../src/health-monitor');
const { loadRegimeStateSafe } = require('../src/state-tracker');
const { createFaultReporter, registerProcessGuards } = require('../src/process-guard');
const { tradeEvents } = require('../src/trade-events');

const TEST_PAIR = '__test532__';
const FUND_DIR = isolatedData.fundDir('coinbase', TEST_PAIR);
const STATE_FILE = path.join(FUND_DIR, 'regime-state.json');
const CORRUPT_JSON = '{ "position": { "realizedPnL": 42, ';

after(() => isolatedData.cleanup());

/** @param {Object} [overrides] - Config overrides @returns {Object} Minimal health config */
const createTestConfig = (overrides = {}) => ({
  staleDataMs: 30000,
  staleOrdersMs: 60000,
  maxRestErrors: 5,
  maxRateLimits: 3,
  maxLatencyMs: 5000,
  safeRecoveryMs: 0,
  ...overrides,
});

/**
 * Collect every trade event emitted while `run` executes.
 * @param {Function} run - Body to execute
 * @returns {Promise<Object[]>} Emitted events
 */
const captureTradeEvents = async (run) => {
  const events = [];
  const listener = (event) => events.push(event);
  tradeEvents.on('trade', listener);
  try {
    await run();
  } finally {
    tradeEvents.removeListener('trade', listener);
  }
  return events;
};

// ============================================================================
// Health monitor — persistence failure escalation
// ============================================================================
describe('health monitor treats unpersistable state as a health condition', () => {
  it('starts with a zeroed persistence failure counter', () => {
    assert.equal(createInitialHealthState().healthChecks.persistenceFailureCount, 0);
  });

  it('trips SAFE mode only after the failures are sustained, then blocks new entries', () => {
    const safeReasons = [];
    const monitor = createHealthMonitor('coinbase', createTestConfig(), {
      onSafeMode: (reason) => safeReasons.push(reason),
    });

    for (let i = 1; i < MAX_CONSECUTIVE_PERSISTENCE_FAILURES; i++) {
      assert.equal(monitor.recordPersistenceFailure('ENOSPC: no space left on device'), i);
      assert.equal(monitor.getState().mode, 'ACTIVE', `still ACTIVE after ${i} failure(s)`);
      assert.equal(monitor.canPlaceEntry().allowed, true);
    }

    assert.equal(
      monitor.recordPersistenceFailure('ENOSPC: no space left on device'),
      MAX_CONSECUTIVE_PERSISTENCE_FAILURES
    );
    assert.equal(monitor.getState().mode, 'SAFE');
    assert.equal(monitor.getState().healthChecks.persistenceFailureCount, MAX_CONSECUTIVE_PERSISTENCE_FAILURES);
    assert.equal(monitor.canPlaceEntry().allowed, false, 'no new entries while state cannot be persisted');
    assert.equal(safeReasons.length, 1);
    assert.match(safeReasons[0], /^persistence_failed:3 \(ENOSPC/);
    assert.match(monitor.getSummary(), /savefailures=3/);
  });

  it('holds SAFE mode while saves keep failing, instead of self-healing on the recovery timer', () => {
    const monitor = createHealthMonitor('coinbase', createTestConfig({ safeRecoveryMs: 0 }), {});
    monitor.recordWsStatus(true);
    for (let i = 0; i < MAX_CONSECUTIVE_PERSISTENCE_FAILURES; i++) monitor.recordPersistenceFailure();
    assert.equal(monitor.getState().mode, 'SAFE');

    // Everything else is healthy and safeRecoveryMs is 0 — without the
    // persistence issue in checkHealth() this would immediately go ACTIVE
    // again and start placing entries it still could not persist.
    monitor.checkHealth({ openOrderCount: 0 });
    assert.equal(monitor.getState().mode, 'SAFE');
    assert.match(monitor.getState().reason, new RegExp(`^${PERSISTENCE_FAILED_PREFIX}`));

    monitor.recordPersistenceSuccess();
    assert.equal(monitor.getState().healthChecks.persistenceFailureCount, 0);
    monitor.checkHealth({ openOrderCount: 0 });
    assert.equal(monitor.getState().mode, 'ACTIVE', 'recovers once the disk accepts writes again');
  });

  it('distinguishes a pure persistence fault from a market/connectivity fault', () => {
    assert.equal(isPersistenceOnlySafeReason('persistence_failed:3 (ENOSPC)'), true);
    assert.equal(isPersistenceOnlySafeReason('persistence_failed:3, persistence_failed:4'), true);
    assert.equal(isPersistenceOnlySafeReason('ws_disconnected, persistence_failed:3'), false);
    assert.equal(isPersistenceOnlySafeReason('rest_errors:9'), false);
    assert.equal(isPersistenceOnlySafeReason(''), false);
    assert.equal(isPersistenceOnlySafeReason(null), false);
  });
});

// ============================================================================
// state-tracker — non-throwing load for reporting / supervision paths
// ============================================================================
describe('loadRegimeStateSafe surfaces the repair message instead of throwing', () => {
  before(() => fs.mkdirSync(FUND_DIR, { recursive: true }));
  after(() => fs.rmSync(FUND_DIR, { recursive: true, force: true }));

  it('returns the descriptive error for a corrupt file', () => {
    fs.writeFileSync(STATE_FILE, CORRUPT_JSON);
    const { state, error } = loadRegimeStateSafe('coinbase', TEST_PAIR);
    assert.equal(state, null);
    assert.match(error, /is corrupted or unreadable/);
    assert.match(error, /Repair or move the file aside/);
  });

  it('returns the parsed state with no error for a readable file', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ position: { realizedPnL: 7 }, regime: {} }));
    const { state, error } = loadRegimeStateSafe('coinbase', TEST_PAIR);
    assert.equal(error, null);
    assert.equal(state.position.realizedPnL, 7);
  });
});

// ============================================================================
// regime engine — background persistence + SIGUSR1 + boot
// ============================================================================
describe('regime engine survives persistence failures', () => {
  const { createRegimeEngine } = require('../src/regime-engine');

  /** @type {any} */
  let engine;
  /** @type {string[]} */
  let executorCalls;
  const realWriteFileSync = fs.writeFileSync;

  /** Make every write under the test fund's dir fail like a full disk. */
  const breakDisk = () => {
    mock.method(fs, 'writeFileSync', (file, ...rest) => {
      if (String(file).includes(TEST_PAIR)) {
        const err = new Error(`ENOSPC: no space left on device, write '${file}'`);
        // @ts-ignore — mirror the shape fs throws with
        err.code = 'ENOSPC';
        throw err;
      }
      return realWriteFileSync(file, ...rest);
    });
  };

  beforeEach(() => {
    fs.rmSync(FUND_DIR, { recursive: true, force: true });
    fs.mkdirSync(FUND_DIR, { recursive: true });
    executorCalls = [];
    engine = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: 'BTC-USDC' }, {});
    engine._test.setAdapter({ getProductDetails: async () => null });
    engine._test.setOrderExecutor({
      setPriceIncrement: () => executorCalls.push('setPriceIncrement'),
      clearTimers: () => executorCalls.push('clearTimers'),
      getPendingCounts: () => ({ total: 0 }),
      cancelAllEntries: async () => executorCalls.push('cancelAllEntries'),
      exportState: () => ({}),
    });
  });

  afterEach(() => {
    mock.restoreAll();
    engine?._test.clearTimers();
  });

  after(() => fs.rmSync(FUND_DIR, { recursive: true, force: true }));

  it('keeps running when a background state save throws, and notifies the operator', async () => {
    breakDisk();

    const events = await captureTradeEvents(() => {
      assert.equal(engine._test.saveLiveStateGuarded('state-save-timer'), false);
    });

    const saveError = events.find((e) => e.data?.action === 'save-live-state');
    assert.ok(saveError, 'a failed save must reach the operator, not die silently');
    assert.equal(saveError.type, 'error', "'error' bypasses Telegram quiet hours");
    assert.match(saveError.message, /ENOSPC/);
    assert.equal(saveError.data.consecutiveFailures, 1);
    assert.equal(engine._test.getHealth().mode, 'ACTIVE', 'one transient failure is not an emergency');
  });

  it('enters SAFE mode after sustained failures without cancelling resting orders', async () => {
    breakDisk();

    for (let i = 0; i < MAX_CONSECUTIVE_PERSISTENCE_FAILURES; i++) {
      assert.equal(engine._test.saveLiveStateGuarded('state-save-timer'), false);
    }
    // onSafeMode is async — let its microtasks settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    const health = engine._test.getHealth();
    assert.equal(health.mode, 'SAFE');
    assert.match(health.reason, new RegExp(`^${PERSISTENCE_FAILED_PREFIX}${MAX_CONSECUTIVE_PERSISTENCE_FAILURES}`));
    assert.deepEqual(
      executorCalls.filter((c) => c === 'cancelAllEntries'),
      [],
      'a broken disk is not a reason to abandon orders already resting on the exchange'
    );
  });

  it('clears the failure run once the disk accepts writes again', () => {
    breakDisk();
    engine._test.saveLiveStateGuarded('state-save-timer');
    assert.equal(engine._test.getHealth().healthChecks.persistenceFailureCount, 1);

    mock.restoreAll();
    assert.equal(engine._test.saveLiveStateGuarded('state-save-timer'), true);
    assert.equal(engine._test.getHealth().healthChecks.persistenceFailureCount, 0);
  });

  it('survives a REAL SIGUSR1 against a corrupt state file, with in-memory state unchanged', async () => {
    // A good file first: the reload must genuinely apply it, otherwise the
    // "unchanged after the corrupt reload" assertion below proves nothing.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      position: { celestialState: { operatorMarker: 'repaired-by-hand' } },
      regime: {},
    }));
    assert.equal(engine._test.reloadStateFromDisk(), true);
    assert.equal(engine._test.getPositionState().celestialState.operatorMarker, 'repaired-by-hand');

    // A second hand-edit, this time with a JSON typo — the exact workflow
    // SIGUSR1 exists for, and the one that used to kill the process.
    fs.writeFileSync(STATE_FILE, `{ "position": { "celestialState": { "operatorMarker": "typo" } },`);

    // Deliver the signal for real: before the fix, a throw inside a
    // process.on('SIGUSR1') listener was an uncaughtException that took the
    // whole trading process (and this test run) down.
    const events = await captureTradeEvents(async () => {
      process.on('SIGUSR1', engine._test.reloadStateFromDisk);
      try {
        process.kill(process.pid, 'SIGUSR1');
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.removeListener('SIGUSR1', engine._test.reloadStateFromDisk);
      }
    });

    const reloadError = events.find((e) => e.data?.action === 'sigusr1-reload');
    assert.ok(reloadError, 'a failed reload must notify the operator');
    assert.equal(reloadError.type, 'error');
    assert.match(reloadError.message, /is corrupted or unreadable/);
    assert.equal(
      engine._test.getPositionState().celestialState.operatorMarker,
      'repaired-by-hand',
      'reload is all-or-nothing: a failed one leaves pre-signal state exactly as it was'
    );
  });

  it('refuses to boot on a corrupt state file without crash-looping the process', async () => {
    fs.writeFileSync(STATE_FILE, CORRUPT_JSON);

    const result = await engine.start();

    assert.equal(result.success, false, 'never boot on top of a zeroed position (issue #108)');
    assert.equal(result.needsOperator, true);
    assert.match(result.error, /is corrupted or unreadable/);
    assert.match(result.error, /Repair or move the file aside/);
    assert.equal(engine._test.getFlags().isRunning, false);
  });
});

// ============================================================================
// process guards — reporter of last resort
// ============================================================================
describe('process guards report a fatal fault before exiting', () => {
  /**
   * Build a reporter with everything injected, so nothing real exits or sends.
   * @param {Object} [opts] - Overrides (e.g. a rejecting flush)
   * @returns {{recorded: Object, reporter: Object}}
   */
  const setup = (opts = {}) => {
    const recorded = { logs: [], events: [], exits: [], flushes: 0 };
    const reporter = createFaultReporter({
      logger: { error: (msg, meta) => recorded.logs.push({ msg, meta }) },
      source: 'coinbase-engine',
      flush: opts.flush || (() => { recorded.flushes++; }),
      drainMs: 20,
      exit: (code) => recorded.exits.push(code),
      emitter: { emitTradeEvent: (type, exchange, message, data) => recorded.events.push({ type, exchange, message, data }) },
    });
    return { recorded, reporter };
  };

  it('registers both listeners on the real process and removes them again', () => {
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      unhandled: process.listenerCount('unhandledRejection'),
    };
    const unregister = registerProcessGuards({ logger: { error: () => {} }, source: 'gateway', exit: () => {} });

    assert.equal(process.listenerCount('uncaughtException'), before.uncaught + 1);
    assert.equal(process.listenerCount('unhandledRejection'), before.unhandled + 1);

    unregister();
    assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
    assert.equal(process.listenerCount('unhandledRejection'), before.unhandled);
  });

  it('logs, notifies and exits non-zero on an uncaughtException', async () => {
    const { recorded, reporter } = setup();

    reporter.onUncaughtException(new Error('ENOSPC: no space left on device'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.match(recorded.logs[0].msg, /Fatal uncaughtException: ENOSPC/);
    assert.equal(recorded.logs[0].meta.source, 'coinbase-engine');
    assert.ok(recorded.logs[0].meta.stack, 'the stack is the whole point of a last-resort reporter');
    assert.equal(recorded.events.length, 1);
    assert.equal(recorded.events[0].type, 'sentinel_critical', 'bypasses Telegram quiet hours');
    assert.equal(recorded.flushes, 1, 'the queued notification must leave the box before the exit');
    assert.deepEqual(recorded.exits, [1], 'reporter of last resort, not a swallow');
  });

  it('handles an unhandledRejection whose reason is not an Error', async () => {
    const { recorded, reporter } = setup();

    reporter.onUnhandledRejection('socket hang up');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.match(recorded.logs[0].msg, /Fatal unhandledRejection: socket hang up/);
    assert.deepEqual(recorded.exits, [1]);
  });

  it('still exits when the notifier flush rejects', async () => {
    const { recorded, reporter } = setup({ flush: () => Promise.reject(new Error('telegram unreachable')) });

    reporter.onUncaughtException(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(recorded.logs.some((l) => /Notifier flush failed/.test(l.msg)));
    assert.deepEqual(recorded.exits, [1]);
  });

  it('exits exactly once even when the flush hangs past the drain window', async () => {
    const { recorded, reporter } = setup({ flush: () => new Promise(() => {}) });

    reporter.onUncaughtException(new Error('wedged'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.deepEqual(recorded.exits, [1], 'the drain watchdog fires once, never twice');
    assert.ok(recorded.logs.some((l) => /Exiting \(1\) via drain-timeout/.test(l.msg)));
  });
});
