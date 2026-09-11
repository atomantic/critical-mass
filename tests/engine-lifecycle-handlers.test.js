// @ts-check
/**
 * Tests for src/engine-lifecycle-handlers.js (issue #504): the extracted
 * `regime:start` / `regime:stop` IPC handlers.
 *
 * These invoke the real, unmodified `registerEngineLifecycleHandlers`
 * production code through a fake IPC registrar (mirroring
 * src/ipc/ipc-server.js's `onRequest(channel, handler)` surface) — no
 * handler source is copied or re-evaluated here. Only the handlers'
 * *dependencies* (engine factory, market-data functions, persistence,
 * callbacks) are faked, so the ownership ordering around engine stop —
 * standalone fill-consumer handover before stop, failure teardown, and the
 * post-stop retry — is exercised directly instead of only through HTTP-proxy
 * tests (which stub IPC entirely) or isolated market-data-service tests
 * (which never invoke these handlers).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
const { fundKey, fundLabel } = require('../src/shared-utils');
const { LIFECYCLE } = require('../src/state-tracker');

const EXCHANGE = 'coinbase';
const PAIR_A = 'BTC-USD';
const PAIR_B = 'ETH-USD';
const INVALID_PAIR = 'NOPE-USD';

const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/**
 * Fake IPC registrar. Captures the exact handler functions
 * registerEngineLifecycleHandlers registers, keyed by channel, so tests can
 * invoke the real production callbacks directly.
 */
const createFakeRegistry = () => {
  const handlers = new Map();
  return { onRequest: (channel, handler) => handlers.set(channel, handler), handlers };
};

/**
 * Fake regime engine whose start()/stop() outcomes a test controls. Pushes
 * its own start/stop calls into the shared `calls` log (tagged with the
 * fund they belong to) so tests can assert ordering against the
 * market-data-service calls the handlers also make.
 */
const createFakeEngine = (calls, exchange, pair, { startResult = { success: true }, stopResult = {}, stopThrows = null, status = { mode: 'RUNNING' } } = {}) => ({
  start: async () => {
    calls.push({ op: 'engine.start', exchange, pair });
    return startResult;
  },
  stop: async () => {
    calls.push({ op: 'engine.stop', exchange, pair });
    if (stopThrows) throw stopThrows;
    return stopResult;
  },
  getStatus: () => status,
  getFillLedger: () => ({ marker: 'fill-ledger', exchange, pair }),
});

/**
 * Build a fresh set of injected dependencies plus a shared ordered `calls`
 * log, so each test can assert exactly which side effects the real
 * regime:start/regime:stop handlers triggered, in what order, without
 * touching real exchanges, disk, or PM2.
 */
const createHarness = () => {
  const regimeEngines = new Map();
  const runningFlags = new Map(); // fundKey -> boolean
  const lifecycleByKey = new Map(); // fundKey -> lifecycle string
  const invalidKeysExchanges = new Set(); // exchanges whose adapter reports no valid keys
  const calls = []; // ordered log of side-effecting dependency calls
  const marketDataQueues = new Map(); // fundKey -> array of results, shifted per call
  const engineFactories = new Map(); // fundKey -> () => fake engine

  const resolvePair = (exchange, pair) => {
    if (pair === INVALID_PAIR) throw new Error(`Unknown configured fund for ${exchange}: ${pair}`);
    return pair;
  };

  const getFundConfig = (exchange, pair) => ({ exchange, pair, marker: 'fund-config' });

  const getAdapter = (exchange) => ({
    hasValidKeys: () => !invalidKeysExchanges.has(exchange),
  });

  const loadRegimeState = (exchange, pair) => ({
    position: { lifecycle: lifecycleByKey.get(fundKey(exchange, pair)) || LIFECYCLE.ACTIVE },
  });

  const createRegimeEngine = (exchange, pair, fundConfig, callbacks) => {
    calls.push({ op: 'createRegimeEngine', exchange, pair, fundConfig, callbacks });
    const factory = engineFactories.get(fundKey(exchange, pair));
    assert.ok(factory, `test harness: no engine factory configured for ${fundKey(exchange, pair)}`);
    return factory();
  };

  const createEngineCallbacks = (exchange, pair) => ({ marker: 'callbacks', exchange, pair });

  const startMarketDataService = async (exchange, pair) => {
    calls.push({ op: 'startMarketDataService', exchange, pair });
    const queue = marketDataQueues.get(fundKey(exchange, pair)) || [];
    return queue.length ? queue.shift() : { success: true };
  };

  const stopMarketDataService = (exchange, pair) => {
    calls.push({ op: 'stopMarketDataService', exchange, pair });
  };

  const wireMarketDataCallbacks = (exchange, pair) => {
    calls.push({ op: 'wireMarketDataCallbacks', exchange, pair });
  };

  const invalidateStandaloneLedger = (exchange, pair) => {
    calls.push({ op: 'invalidateStandaloneLedger', exchange, pair });
  };

  const saveRegimeRunningFlag = (exchange, pair, isRunning) => {
    calls.push({ op: 'saveRegimeRunningFlag', exchange, pair, isRunning });
    runningFlags.set(fundKey(exchange, pair), isRunning);
  };

  const deps = {
    regimeEngines,
    resolvePair,
    fundKey,
    fundLabel,
    logger: silentLogger,
    getFundConfig,
    getAdapter,
    loadRegimeState,
    LIFECYCLE,
    createRegimeEngine,
    createEngineCallbacks,
    startMarketDataService,
    stopMarketDataService,
    wireMarketDataCallbacks,
    invalidateStandaloneLedger,
    saveRegimeRunningFlag,
  };

  const registry = createFakeRegistry();
  registerEngineLifecycleHandlers(registry, deps);

  return {
    start: registry.handlers.get('regime:start'),
    stop: registry.handlers.get('regime:stop'),
    regimeEngines,
    runningFlags,
    lifecycleByKey,
    invalidKeysExchanges,
    calls,
    marketDataQueues,
    engineFactories,
  };
};

/** Index of the first call matching `op` (and optional `pair`), or -1. */
const firstIndex = (calls, op, pair) =>
  calls.findIndex((c) => c.op === op && (pair === undefined || c.pair === pair));

const callsFor = (calls, pair) => calls.filter((c) => c.pair === pair);

describe('engine-lifecycle-handlers', () => {
  describe('regime:start', () => {
    it('refuses to start a fund that already has a registered engine', async () => {
      const h = createHarness();
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'Regime engine already running for this fund' });
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1);
    });

    it('refuses to start a closed fund', async () => {
      const h = createHarness();
      h.lifecycleByKey.set(fundKey(EXCHANGE, PAIR_A), LIFECYCLE.CLOSED);

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'Fund is closed — call regime:reopen before starting' });
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1);
    });

    it('refuses to start without valid API keys', async () => {
      const h = createHarness();
      h.invalidKeysExchanges.add(EXCHANGE);

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'API keys not configured for this exchange' });
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1);
    });

    it('returns a sanitized error and registers nothing when the engine factory throws (corrupt ledger)', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => {
        throw new Error('regime-state file is corrupted or unreadable: unexpected token');
      });

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.match(result.error, /Fill ledger init failed for coinbase\/BTC-USD/);
      assert.doesNotMatch(result.error, /unexpected token/); // internals stay out of the IPC response
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
    });

    it('does not claim a running fund when engine.start() rejects the start', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () =>
        createFakeEngine(h.calls, EXCHANGE, PAIR_A, { startResult: { success: false, error: 'exchange unreachable' } }));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'exchange unreachable' });
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag'), -1);
      assert.equal(firstIndex(h.calls, 'stopMarketDataService'), -1);
    });

    it('does not claim a running fund when the start auto-closes a drained fund', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () =>
        createFakeEngine(h.calls, EXCHANGE, PAIR_A, { startResult: { success: true, autoClosed: true } }));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, autoClosed: true });
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag'), -1);
    });

    it('on success, transfers the fund from the standalone service to the engine and persists the running flag', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, true);
      assert.equal(result.exchange, EXCHANGE);
      assert.equal(result.pair, PAIR_A);
      assert.deepEqual(result.status, { mode: 'RUNNING' });
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true);
      assert.equal(firstIndex(h.calls, 'stopMarketDataService', PAIR_A) > -1, true); // standalone consumer handed over
      assert.equal(firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A) > -1, true);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), true);
    });

    it('rejects with no side effects when the pair does not resolve to a configured fund', async () => {
      const h = createHarness();

      await assert.rejects(h.start({}, EXCHANGE, INVALID_PAIR));

      assert.equal(h.regimeEngines.size, 0);
      assert.equal(h.calls.length, 0);
    });

    it('leaves an unrelated fund untouched when starting a different pair', async () => {
      const h = createHarness();
      const engineB = createFakeEngine(h.calls, EXCHANGE, PAIR_B);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_B), engineB);
      h.runningFlags.set(fundKey(EXCHANGE, PAIR_B), true);
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(h.regimeEngines.get(fundKey(EXCHANGE, PAIR_B)), engineB);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_B)), true);
      assert.equal(callsFor(h.calls, PAIR_B).length, 0);
    });
  });

  describe('regime:stop', () => {
    it('returns failure when no engine is registered for the fund', async () => {
      const h = createHarness();

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'Regime engine not running for this fund' });
      assert.equal(h.calls.length, 0);
    });

    it('starts and wires the handover before stopping, then removes only that engine/cache and persists false', async () => {
      const h = createHarness();
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, stopped: true });

      const startIdx = firstIndex(h.calls, 'startMarketDataService', PAIR_A);
      const wireIdx = firstIndex(h.calls, 'wireMarketDataCallbacks', PAIR_A);
      const stopIdx = firstIndex(h.calls, 'engine.stop', PAIR_A);
      const invalidateIdx = firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A);
      const flagIdx = firstIndex(h.calls, 'saveRegimeRunningFlag', PAIR_A);

      assert.ok(startIdx > -1 && wireIdx > -1 && stopIdx > -1 && invalidateIdx > -1 && flagIdx > -1);
      assert.ok(startIdx < stopIdx, 'handover must start before the engine stops');
      assert.ok(wireIdx < stopIdx, 'handover must be wired before the engine stops');
      assert.ok(stopIdx < invalidateIdx && stopIdx < flagIdx, 'cache/flag cleanup happens after stop');

      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
      // No standalone consumer teardown or retry on the happy path — the one that started stays.
      assert.equal(firstIndex(h.calls, 'stopMarketDataService', PAIR_A), -1);
      assert.equal(h.calls.filter((c) => c.op === 'startMarketDataService' && c.pair === PAIR_A).length, 1);
    });

    for (const [label, makeStopBehavior] of [
      ['engine.stop() rejects', () => ({ stopThrows: new Error('flush failed') })],
      ['engine.stop() resolves with {error}', () => ({ stopResult: { error: 'flush failed' } })],
    ]) {
      it(`on ${label}: returns failure, retains the registry entry, tears down the started standalone consumer, and does not persist false`, async () => {
        const h = createHarness();
        h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A, makeStopBehavior()));

        const result = await h.stop({}, EXCHANGE, PAIR_A);

        assert.deepEqual(result, { success: false, error: 'flush failed' });
        assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true, 'entry must be retained after a failed stop');
        assert.ok(firstIndex(h.calls, 'stopMarketDataService', PAIR_A) > -1, 'the standalone consumer that started must be torn down');
        assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag', PAIR_A), -1, 'a failed stop must not persist running=false');
        assert.equal(firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A), -1);
      });
    }

    it('skips standalone-consumer teardown on a failed stop when the handover never started', async () => {
      const h = createHarness();
      h.marketDataQueues.set(fundKey(EXCHANGE, PAIR_A), [{ success: false, error: 'ledger corrupt' }]);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A, { stopThrows: new Error('boom') }));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'boom' });
      assert.equal(firstIndex(h.calls, 'stopMarketDataService', PAIR_A), -1, 'nothing to tear down — the handover never started');
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true);
    });

    it('still calls stop when the initial handover fails, then retries and wires only a successful retry', async () => {
      const h = createHarness();
      h.marketDataQueues.set(fundKey(EXCHANGE, PAIR_A), [
        { success: false, error: 'ledger corrupt' }, // initial handover attempt
        { success: true }, // retry after stop
      ]);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, stopped: true });
      assert.equal(h.calls.filter((c) => c.op === 'startMarketDataService' && c.pair === PAIR_A).length, 2, 'initial attempt + retry');
      assert.equal(h.calls.filter((c) => c.op === 'wireMarketDataCallbacks' && c.pair === PAIR_A).length, 1, 'wired only for the successful retry');
      const stopIdx = firstIndex(h.calls, 'engine.stop', PAIR_A);
      assert.ok(stopIdx > -1, 'stop must still run even though the initial handover failed');
      const secondStartIdx = h.calls
        .map((c, i) => ({ ...c, i }))
        .filter((c) => c.op === 'startMarketDataService' && c.pair === PAIR_A)[1].i;
      assert.ok(secondStartIdx > stopIdx, 'the retry happens after stop');
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
    });

    it('preserves the success/warning contract when both the initial handover and the retry fail', async () => {
      const h = createHarness();
      h.marketDataQueues.set(fundKey(EXCHANGE, PAIR_A), [
        { success: false, error: 'ledger corrupt' },
        { success: false, error: 'still corrupt' },
      ]);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      // Stop itself still succeeded — a stopped-engine WS handover failure is
      // reported via warning logs only, not surfaced as an overall failure.
      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, stopped: true });
      assert.equal(h.calls.filter((c) => c.op === 'wireMarketDataCallbacks' && c.pair === PAIR_A).length, 0);
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
    });

    it('rejects with no side effects when the pair does not resolve to a configured fund', async () => {
      const h = createHarness();
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      await assert.rejects(h.stop({}, EXCHANGE, INVALID_PAIR));

      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true);
      assert.equal(h.calls.length, 0);
    });

    it('leaves an unrelated fund untouched when stopping a different pair', async () => {
      const h = createHarness();
      const engineA = createFakeEngine(h.calls, EXCHANGE, PAIR_A);
      const engineB = createFakeEngine(h.calls, EXCHANGE, PAIR_B);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), engineA);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_B), engineB);
      h.runningFlags.set(fundKey(EXCHANGE, PAIR_B), true);

      await h.stop({}, EXCHANGE, PAIR_A);

      assert.equal(h.regimeEngines.get(fundKey(EXCHANGE, PAIR_B)), engineB);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_B)), true);
      assert.equal(callsFor(h.calls, PAIR_B).length, 0);
    });
  });
});
