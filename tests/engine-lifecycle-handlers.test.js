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
 * callbacks) are faked, so the exclusive fill-ledger handover (issue #1008)
 * — engine drained and flushed before the standalone consumer starts, and
 * the standalone consumer fenced and joined before an engine is built — is
 * exercised directly instead of only through HTTP-proxy tests (which stub
 * IPC entirely) or isolated market-data-service tests (which never invoke
 * these handlers). The final suite joins consumers that own real fill
 * ledgers over disposable storage.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
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
const createHarness = (overrides = {}) => {
  const regimeEngines = new Map();
  const runningFlags = new Map(); // fundKey -> boolean
  const lifecycleByKey = new Map(); // fundKey -> lifecycle string
  const invalidKeysExchanges = new Set(); // exchanges whose adapter reports no valid keys
  const calls = []; // ordered log of side-effecting dependency calls
  const marketDataQueues = new Map(); // fundKey -> array of results, shifted per call
  const fenceQueues = new Map(); // fundKey -> array of fence results, shifted per call
  const engineFactories = new Map(); // fundKey -> () => fake engine

  const resolvePair = (exchange, pair) => {
    if (pair === INVALID_PAIR) throw new Error(`Unknown configured fund for ${exchange}: ${pair}`);
    return pair;
  };

  const getFundConfig = (exchange, pair) => ({ exchange, pair, marker: 'fund-config' });

  const getAdapter = (exchange) => ({
    hasValidKeys: () => !invalidKeysExchanges.has(exchange),
  });

  const loadFundRegimeState = (exchange, pair) => ({
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
    // Record whether the engine still held the fund when the consumer started.
    calls.push({ op: 'startMarketDataService', exchange, pair, engineRegistered: regimeEngines.has(fundKey(exchange, pair)) });
    const queue = marketDataQueues.get(fundKey(exchange, pair)) || [];
    const next = queue.length ? queue.shift() : { success: true };
    if (next instanceof Error) throw next;
    return next;
  };

  const fenceMarketDataService = async (exchange, pair) => {
    calls.push({ op: 'fenceMarketDataService', exchange, pair });
    const queue = fenceQueues.get(fundKey(exchange, pair)) || [];
    return queue.length ? queue.shift() : { drained: true };
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
    loadFundRegimeState,
    LIFECYCLE,
    createRegimeEngine,
    createEngineCallbacks,
    startMarketDataService,
    fenceMarketDataService,
    wireMarketDataCallbacks,
    invalidateStandaloneLedger,
    saveRegimeRunningFlag,
  };

  const registry = createFakeRegistry();
  const lifecycle = registerEngineLifecycleHandlers(registry, { ...deps, ...overrides });

  return {
    ...lifecycle,
    start: registry.handlers.get('regime:start'),
    stop: registry.handlers.get('regime:stop'),
    regimeEngines,
    runningFlags,
    lifecycleByKey,
    invalidKeysExchanges,
    calls,
    marketDataQueues,
    fenceQueues,
    engineFactories,
  };
};

/** Index of the first call matching `op` (and optional `pair`), or -1. */
const firstIndex = (calls, op, pair) =>
  calls.findIndex((c) => c.op === op && (pair === undefined || c.pair === pair));

const callsFor = (calls, pair) => calls.filter((c) => c.pair === pair);

const countOf = (calls, op, pair) => calls.filter((c) => c.op === op && c.pair === pair).length;

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

      assert.deepEqual(result, { success: false, error: 'Fund is closed — call regime:reopen before starting', needsOperator: true });
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1);
    });

    // issue #860 — a fund with an interrupted DCA import must never trade on
    // the mixed generation: recovery runs first and an unsafe one blocks.
    it('runs DCA import recovery before starting and refuses when it cannot complete', async () => {
      const recoveries = [];
      const h = createHarness({
        recoverPendingImport: (exchange, pair) => {
          recoveries.push(pair);
          throw new Error('fill-ledger.json changed outside the DCA import');
        },
      });

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(recoveries, [PAIR_A]);
      assert.equal(result.success, false);
      assert.equal(result.needsOperator, true);
      assert.match(result.error, /interrupted DCA import/);
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1);
    });

    it('refuses to start without valid API keys', async () => {
      const h = createHarness();
      h.invalidKeysExchanges.add(EXCHANGE);

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'API keys not configured for this exchange', needsOperator: true });
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
      // Passive monitoring is restored only after the failed engine released the ledger.
      const restoreIdx = firstIndex(h.calls, 'startMarketDataService', PAIR_A);
      assert.ok(restoreIdx > firstIndex(h.calls, 'engine.stop', PAIR_A), 'standalone consumer restored after engine teardown');
      assert.equal(h.calls[restoreIdx].engineRegistered, false);
      assert.ok(firstIndex(h.calls, 'wireMarketDataCallbacks', PAIR_A) > restoreIdx);
    });

    it('does not strand a registered engine when engine.start() throws instead of resolving (issue #679 follow-up)', async () => {
      // engine.start() is expected to resolve { success: false, error } on a
      // handled failure (the sibling test above), but an unguarded async call
      // deep in startup recovery (e.g. issue #679 hardened getOrderFills to
      // reject rather than silently return a partial fill set) can still
      // escape it as a genuine rejection. The engine was already registered
      // in regimeEngines before start() was awaited (so regime:stop can find
      // it mid-start) — the handler must still unregister it on a throw, or
      // it is stranded as "already running" forever with no orders watched.
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({
        start: async () => { throw new Error('getOrderFills: fills incomplete for order-1: 0.5 of 1.5'); },
        stop: async () => ({}),
        getStatus: () => ({ mode: 'RUNNING' }),
        getFillLedger: () => ({ marker: 'fill-ledger', exchange: EXCHANGE, pair: PAIR_A }),
      }));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.match(result.error, /Engine startup failed for coinbase\/BTC-USD/);
      assert.doesNotMatch(result.error, /fills incomplete/); // internals stay out of the IPC response
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false, 'a thrown start() must not leave the engine registered');
      assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag'), -1);
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 1, 'passive monitoring restored once');

      // A second start attempt must be able to proceed — it must NOT see
      // "already running" from the stranded registration.
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () =>
        createFakeEngine(h.calls, EXCHANGE, PAIR_A, { startResult: { success: true } }));
      const retryResult = await h.start({}, EXCHANGE, PAIR_A);
      assert.equal(retryResult.success, true);
    });

    it('does not claim a running fund when the start auto-closes a drained fund', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () =>
        createFakeEngine(h.calls, EXCHANGE, PAIR_A, { startResult: { success: true, autoClosed: true } }));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, autoClosed: true });
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0, 'a closed fund gets no passive consumer');
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
      const fenceIdx = firstIndex(h.calls, 'fenceMarketDataService', PAIR_A);
      const createIdx = firstIndex(h.calls, 'createRegimeEngine', PAIR_A);
      assert.ok(fenceIdx > -1 && fenceIdx < createIdx, 'standalone consumer fenced and joined before the engine loads the ledger');
      assert.ok(firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A) > fenceIdx);
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0, 'no standalone consumer while the engine owns the fund');
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), true);
    });

    it('builds no engine and starts no writer when the standalone consumer cannot confirm its drain', async () => {
      const h = createHarness();
      h.fenceQueues.set(fundKey(EXCHANGE, PAIR_A), [{ drained: false }]);
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.equal(result.retryable, true);
      assert.match(result.error, /still draining/);
      assert.equal(firstIndex(h.calls, 'createRegimeEngine'), -1, 'the old writer may still persist — no engine may load the ledger');
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0, 'no replacement consumer either');
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag'), -1);
    });

    it('restores passive monitoring when the engine factory throws after the fence', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => { throw new Error('corrupted ledger'); });

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.equal(result.needsOperator, true);
      assert.ok(firstIndex(h.calls, 'startMarketDataService', PAIR_A) > firstIndex(h.calls, 'fenceMarketDataService', PAIR_A));
    });

    it('keeps the failed engine as sole owner and starts no consumer when its cleanup fails', async () => {
      const h = createHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () =>
        createFakeEngine(h.calls, EXCHANGE, PAIR_A, { startResult: { success: false, error: 'boom' }, stopThrows: new Error('still owns socket') }));

      const result = await h.start({}, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.equal(result.needsOperator, true);
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true, 'ownership retained');
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0, 'no second writer');
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

    it('drains and flushes the engine before the standalone consumer loads the ledger, then releases ownership', async () => {
      const drains = [];
      const h = createHarness({ drainFundWrites: async (exchange, pair) => { drains.push(pair); return { drained: true }; } });
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, stopped: true });
      assert.deepEqual(drains, [PAIR_A]);

      const stopIdx = firstIndex(h.calls, 'engine.stop', PAIR_A);
      const startIdx = firstIndex(h.calls, 'startMarketDataService', PAIR_A);
      const wireIdx = firstIndex(h.calls, 'wireMarketDataCallbacks', PAIR_A);
      const flagIdx = firstIndex(h.calls, 'saveRegimeRunningFlag', PAIR_A);

      assert.ok(stopIdx > -1 && startIdx > -1 && wireIdx > -1 && flagIdx > -1);
      assert.ok(stopIdx < startIdx, 'the consumer must not load the ledger until the engine has flushed it');
      assert.ok(startIdx < wireIdx && wireIdx < flagIdx);
      assert.equal(h.calls[startIdx].engineRegistered, true, 'the engine keeps the fund until the transfer completes');
      assert.ok(firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A) > startIdx);

      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 1);
    });

    for (const [label, makeStopBehavior] of [
      ['engine.stop() rejects', () => ({ stopThrows: new Error('flush failed') })],
      ['engine.stop() resolves with {error}', () => ({ stopResult: { error: 'flush failed' } })],
    ]) {
      it(`on ${label}: returns failure, retains ownership, starts no second writer, and does not persist false`, async () => {
        const h = createHarness();
        h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A, makeStopBehavior()));

        const result = await h.stop({}, EXCHANGE, PAIR_A);

        assert.deepEqual(result, { success: false, error: 'flush failed' });
        assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true, 'entry must be retained after a failed stop');
        assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0, 'no standalone writer while the engine still owns the ledger');
        assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag', PAIR_A), -1, 'a failed stop must not persist running=false');
        assert.equal(firstIndex(h.calls, 'invalidateStandaloneLedger', PAIR_A), -1);
      });
    }

    it('retains ownership and starts no consumer when accepted fund writes cannot be confirmed drained', async () => {
      const h = createHarness({ drainFundWrites: async () => ({ drained: false }) });
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

      const result = await h.stop({}, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'Fund writers are still draining' });
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), true);
      assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 0);
      assert.equal(firstIndex(h.calls, 'saveRegimeRunningFlag', PAIR_A), -1);
    });

    for (const [label, outcome] of [
      ['reports failure (corrupt ledger the flush could not repair)', { success: false, error: 'ledger corrupt' }],
      ['rejects', new Error('candles unavailable')],
    ]) {
      it(`still completes the stop when the post-stop consumer ${label}`, async () => {
        const h = createHarness();
        h.marketDataQueues.set(fundKey(EXCHANGE, PAIR_A), [outcome]);
        h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), createFakeEngine(h.calls, EXCHANGE, PAIR_A));

        const result = await h.stop({}, EXCHANGE, PAIR_A);

        // The operator's stop intent wins: a missing passive consumer is
        // reported via warning logs, not surfaced as a failed stop.
        assert.deepEqual(result, { success: true, exchange: EXCHANGE, pair: PAIR_A, stopped: true });
        assert.equal(countOf(h.calls, 'startMarketDataService', PAIR_A), 1, 'one attempt, after the flush');
        assert.equal(countOf(h.calls, 'wireMarketDataCallbacks', PAIR_A), 0);
        assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), false);
        assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
      });
    }

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

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const retryHarness = (overrides = {}) => {
  const timers = new Map();
  let timerId = 0;
  const h = createHarness({ setTimer: (run, delay) => { const id = ++timerId; timers.set(id, { run, delay }); return id; }, clearTimer: id => timers.delete(id), isPaused: () => false, ...overrides });
  h.timers = timers;
  h.fire = async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.run(); await settle(); };
  return h;
};

describe('automatic fund startup supervision', () => {
  it('isolates a transient failure, cleans it before retry, and recovers once', async () => {
    const h = retryHarness();
    const cleanup = deferred();
    let attempts = 0;
    h.runningFlags.set(fundKey(EXCHANGE, PAIR_A), true);
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => {
      attempts++;
      return attempts === 1 ? {
        start: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); },
        stop: () => cleanup.promise,
      } : createFakeEngine(h.calls, EXCHANGE, PAIR_A);
    });
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_B), () => createFakeEngine(h.calls, EXCHANGE, PAIR_B));
    const failed = h.autoResumeFund(EXCHANGE, PAIR_A);
    await settle();
    assert.equal(h.timers.size, 0, 'no retry before failed ownership is released');
    assert.equal((await h.start({}, EXCHANGE, PAIR_A)).success, false);
    assert.equal((await h.autoResumeFund(EXCHANGE, PAIR_B)).success, true);
    cleanup.resolve();
    assert.equal((await failed).success, false);
    assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), true);
    assert.equal(h.getStartStatus(EXCHANGE, PAIR_A).state, 'retrying');
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 5000);
    await h.fire();
    assert.equal(attempts, 2);
    assert.equal(h.getStartStatus(EXCHANGE, PAIR_A).state, 'running');
    assert.equal(h.timers.size, 0);
  });

  for (const mode of ['stop', 'shutdown']) {
    it(`${mode} fences a late successful start and prevents replacement until cleanup`, async () => {
      const h = retryHarness();
      const ready = deferred();
      const cleaned = deferred();
      let stops = 0;
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: () => ready.promise, stop: () => { stops++; return cleaned.promise; } }));
      const started = h.autoResumeFund(EXCHANGE, PAIR_A);
      await settle();
      const stopped = mode === 'stop' ? h.stop({}, EXCHANGE, PAIR_A) : h.cancelStarts({ shutdown: true });
      ready.resolve({ success: true });
      await settle();
      assert.equal(stops, 1);
      assert.equal((await h.start({}, EXCHANGE, PAIR_A)).success, false);
      cleaned.resolve();
      await Promise.all([started, stopped]);
      assert.equal(h.regimeEngines.size, 0);
      assert.equal(h.timers.size, 0);
      assert.equal(h.calls.some(c => c.op === 'saveRegimeRunningFlag' && c.isRunning), false);
    });
  }

  it('cancels a retry on explicit stop and lets a manual start replace a pending retry', async () => {
    const h = retryHarness();
    let attempts = 0;
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: async () => { attempts++; throw new Error('fetch failed'); }, stop: async () => {} }));
    await h.autoResumeFund(EXCHANGE, PAIR_A);
    assert.equal(h.timers.size, 1);
    const staleCallback = [...h.timers.values()][0].run;
    assert.equal((await h.stop({}, EXCHANGE, PAIR_A)).success, true);
    staleCallback();
    await settle();
    assert.equal(attempts, 1);
    assert.equal(h.runningFlags.get(fundKey(EXCHANGE, PAIR_A)), false);
    await h.autoResumeFund(EXCHANGE, PAIR_A);
    await h.start({}, EXCHANGE, PAIR_A);
    assert.equal(h.timers.size, 0);
    assert.equal(attempts, 3);
  });

  it('caps exponential retry delays and keeps one timer', async () => {
    const h = retryHarness();
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: async () => { throw new Error('fetch failed'); }, stop: async () => {} }));
    await h.autoResumeFund(EXCHANGE, PAIR_A);
    for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
      assert.equal(h.timers.size, 1);
      assert.equal([...h.timers.values()][0].delay, delay);
      await h.fire();
    }
    await h.cancelStarts({ shutdown: true });
  });

  for (const failure of ['corrupt', 'auth', 'cleanup']) {
    it(`blocks ${failure} failures without releasing unsafe ownership or retrying`, async () => {
      const h = retryHarness();
      h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => {
        if (failure === 'corrupt') throw new Error('corrupted ledger');
        return { start: async () => { throw Object.assign(new Error(failure === 'auth' ? 'unauthorized' : 'fetch failed'), { status: failure === 'auth' ? 401 : 503 }); }, stop: async () => { if (failure === 'cleanup') throw new Error('still owns socket'); } };
      });
      await h.autoResumeFund(EXCHANGE, PAIR_A);
      assert.equal(h.getStartStatus(EXCHANGE, PAIR_A).state, 'blocked');
      assert.equal(h.timers.size, 0);
      assert.equal(h.regimeEngines.has(fundKey(EXCHANGE, PAIR_A)), failure === 'cleanup');
    });
  }
});


it('holds retry ownership while accepted fund callbacks drain', async () => {
  const drain = deferred();
  const h = retryHarness({ drainFundWrites: () => drain.promise });
  h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: async () => { throw new Error('fetch failed'); }, stop: async () => {} }));
  const started = h.autoResumeFund(EXCHANGE, PAIR_A);
  await settle();
  assert.equal(h.regimeEngines.size, 1);
  assert.equal(h.timers.size, 0);
  assert.equal((await h.start({}, EXCHANGE, PAIR_A)).success, false);
  drain.resolve({ drained: true });
  await started;
  assert.equal(h.regimeEngines.size, 0);
  assert.equal(h.timers.size, 1);
});

it('defers retries during maintenance and backup pause even after the maintenance TTL ends', async () => {
  const { setEngineMaintenance, setEngineBackupPaused } = require('../src/engine-maintenance');
  const h = retryHarness({ isPaused: undefined });
  let attempts = 0;
  h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: async () => { attempts++; throw new Error('fetch failed'); }, stop: async () => {} }));
  try {
    await h.autoResumeFund(EXCHANGE, PAIR_A);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    await h.fire();
    assert.equal(attempts, 1);
    setEngineBackupPaused(true);
    setEngineMaintenance({ active: false });
    await h.fire();
    assert.equal(attempts, 1);
    setEngineBackupPaused(false);
    await h.fire();
    assert.equal(attempts, 2);
  } finally {
    setEngineMaintenance({ active: false });
    setEngineBackupPaused(false);
    await h.cancelStarts({ shutdown: true });
  }
});

// Issue #1008: each consumer holds its own in-memory fill ledger and every
// persist replaces the whole file, so an overlapping handover erases the
// other owner's fills. These join consumers that own REAL ledgers over a
// disposable data dir and assert that nothing either owner persisted is lost
// on the replacement's next write.
describe('exclusive fill-ledger handover over real ledgers (issue #1008)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const migration = require('../src/migration');
  const { createFillLedger } = require('../src/fill-ledger');
  const originalDir = migration.getExchangeDataDir;
  const LEDGER_EXCHANGE = 'test-1008';
  let root;

  const openLedger = () => createFillLedger(LEDGER_EXCHANGE, PAIR_A, PAIR_A, { quiet: true });
  const fill = (tradeId, orderId, side = 'buy') => ({ tradeId, orderId, side, price: 100, size: 1, totalCommission: 0.1, timestamp: Date.now() });
  const onDisk = () => new Map(openLedger().getAllFills().map((f) => [f.tradeId, f]));

  /**
   * Standalone consumer modelled on market-data-service: it loads its own
   * ledger on start, its order work re-checks the stop fence after every
   * await, and its fence joins that work before resolving.
   */
  const createStandaloneConsumer = () => {
    const consumer = { ledger: null, stopped: true, inflight: new Set(), persisted: [] };
    consumer.start = async () => {
      consumer.ledger = openLedger();
      consumer.stopped = false;
      return { success: true };
    };
    consumer.fence = async () => {
      consumer.stopped = true;
      await Promise.allSettled([...consumer.inflight]);
      return { drained: true };
    };
    /** Deliver an order fill; `gate` stands in for the REST fill fetch. */
    consumer.deliver = (f, gate = Promise.resolve()) => {
      if (consumer.stopped) return Promise.resolve(false);
      const work = gate.then(() => {
        if (consumer.stopped) return false;
        consumer.ledger.ingestFill(f);
        consumer.persisted.push(f.tradeId);
        return true;
      }).finally(() => consumer.inflight.delete(work));
      consumer.inflight.add(work);
      return work;
    };
    return consumer;
  };

  /** Lifecycle harness whose market-data deps drive one standalone consumer. */
  const ledgerHarness = (consumer, overrides = {}) => createHarness({
    startMarketDataService: async () => consumer.start(),
    fenceMarketDataService: async () => consumer.fence(),
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-1008-'));
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(root, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    openLedger().ingestFill(fill('A', 'buy-a'));
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stop: the engine\'s final admitted fill and booking survive the standalone consumer\'s next write', async () => {
    const consumer = createStandaloneConsumer();
    const h = ledgerHarness(consumer);
    const engineLedger = openLedger();
    h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), {
      ...createFakeEngine(h.calls, EXCHANGE, PAIR_A),
      // A fill handler already past the gate books B and its TP while stopping.
      stop: async () => {
        engineLedger.ingestFill(fill('B', 'buy-b'));
        engineLedger.annotateFillsByOrderId('buy-b', { sellOrderId: 'tp-b' });
        engineLedger.persist({ force: true });
        return {};
      },
    });

    const result = await h.stop({}, EXCHANGE, PAIR_A);
    assert.equal(result.success, true);

    // The consumer's next fill rewrites the file from its own snapshot.
    assert.equal(await consumer.deliver(fill('C', 'buy-c')), true);

    const disk = onDisk();
    assert.deepEqual([...disk.keys()].sort(), ['A', 'B', 'C']);
    assert.equal(disk.get('B').sellOrderId, 'tp-b', 'booking annotation survives too');
  });

  it('start: the engine loads only after the consumer\'s accepted work lands, and nothing the consumer persisted is lost', async () => {
    const consumer = createStandaloneConsumer();
    await consumer.start();
    assert.equal(await consumer.deliver(fill('D', 'buy-d')), true);
    const fetching = deferred();
    const accepted = consumer.deliver(fill('E', 'buy-e'), fetching.promise);

    const engineReady = deferred();
    let engineLedger = null;
    const h = ledgerHarness(consumer);
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => {
      engineLedger = openLedger();
      return { ...createFakeEngine(h.calls, EXCHANGE, PAIR_A), start: () => engineReady.promise };
    });

    const started = h.start({}, EXCHANGE, PAIR_A);
    await settle();
    assert.equal(engineLedger, null, 'no engine ledger while the consumer still has work in flight');

    fetching.resolve();
    await accepted;
    await settle();
    assert.ok(engineLedger, 'engine built once the consumer was joined');

    // The feed keeps delivering while engine startup awaits — fenced now.
    assert.equal(await consumer.deliver(fill('F', 'buy-f')), false);
    engineReady.resolve({ success: true });
    assert.equal((await started).success, true);

    engineLedger.ingestFill(fill('G', 'buy-g'));

    const disk = onDisk();
    for (const tradeId of ['A', 'D', ...consumer.persisted, 'G']) {
      assert.ok(disk.has(tradeId), `${tradeId} must survive the engine's next persist`);
    }
    assert.equal(disk.has('F'), false, 'a fenced consumer writes nothing; the engine reconciles that fill');
  });

  it('start failure hands the fund back to a consumer that loads the released engine\'s final ledger', async () => {
    const consumer = createStandaloneConsumer();
    await consumer.start();
    const h = ledgerHarness(consumer);
    h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => {
      const engineLedger = openLedger();
      return {
        ...createFakeEngine(h.calls, EXCHANGE, PAIR_A),
        start: async () => {
          engineLedger.ingestFill(fill('R', 'buy-r')); // startup recovery booked a fill
          return { success: false, error: 'exchange unreachable' };
        },
      };
    });

    assert.equal((await h.start({}, EXCHANGE, PAIR_A)).success, false);
    assert.equal(consumer.stopped, false, 'passive monitoring restored');
    assert.equal(await consumer.deliver(fill('S', 'buy-s')), true);

    assert.deepEqual([...onDisk().keys()].sort(), ['A', 'R', 'S']);
  });
});

it('admits the internal backup-resume start while paused but defers its retries (#1025)', async () => {
  let paused = true;
  const h = retryHarness({ isPaused: () => paused });
  let attempts = 0;
  h.engineFactories.set(fundKey(EXCHANGE, PAIR_A), () => ({ start: async () => { attempts++; throw new Error('fetch failed'); }, stop: async () => {} }));
  assert.equal((await h.autoResumeFund(EXCHANGE, PAIR_A)).success, false);
  assert.equal(attempts, 0, 'public automatic starts stay gated');
  await h.resumeAfterBackup(EXCHANGE, PAIR_A);
  assert.equal(attempts, 1);
  assert.equal(h.getStartStatus(EXCHANGE, PAIR_A).state, 'retrying');
  await h.fire();
  assert.equal(attempts, 1, 'retry waits for the pause to end');
  assert.equal(h.timers.size, 1);
  paused = false;
  await h.fire();
  assert.equal(attempts, 2);
  assert.equal(h.timers.size, 1, 'still one timer per fund');
  await h.cancelStarts({ shutdown: true });
  assert.equal(h.timers.size, 0);
});
