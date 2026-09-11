// @ts-check
/**
 * Tests for src/engine-recalculate-handler.js (issue #505): the extracted
 * `regime:recalculate` IPC handler.
 *
 * These invoke the real, unmodified `registerEngineRecalculateHandler`
 * production code through a fake IPC registrar (mirroring
 * src/ipc/ipc-server.js's `onRequest(channel, handler)` surface, same as
 * tests/engine-lifecycle-handlers.test.js) — no handler source is copied or
 * re-evaluated here. Only the handler's *dependencies* (engine registry,
 * standalone-ledger accessor, regime-state adapter) are faked, so the
 * preview-vs-apply / live-vs-stopped selection this handler enforces is
 * exercised directly against the real production callback instead of only
 * through the read-only fill-ledger helper tests (tests/fill-ledger.test.js,
 * which never invoke this handler) or the HTTP-route tests
 * (tests/regime-routes-control.test.js, which mock IPC entirely).
 *
 * `readBooleanFlag` and `fundKey` are the real, pure helpers from
 * src/shared-utils.js (same as the lifecycle-handler tests) — no side
 * effects, so using the real implementation increases fidelity without
 * touching disk or exchanges.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerEngineRecalculateHandler } = require('../src/engine-recalculate-handler');
const { fundKey, readBooleanFlag } = require('../src/shared-utils');

const EXCHANGE = 'coinbase';
const PAIR_A = 'BTC-USD';
const PAIR_B = 'ETH-USD';
const DEFAULT_PAIR = 'BTC-USD';
const INVALID_PAIR = 'NOPE-USD';

/**
 * Fake IPC registrar. Captures the exact handler function
 * registerEngineRecalculateHandler registers, so tests can invoke the real
 * production callback directly.
 */
const createFakeRegistry = () => {
  const handlers = new Map();
  return { onRequest: (channel, handler) => handlers.set(channel, handler), handlers };
};

/** A realistic stopped/live position fixture carrying non-derived fields the
 * handler must never clobber: activeTpOrderId, lifecycle, celestialBodies,
 * ladder fields. */
const makeStaleFixture = (overrides = {}) => ({
  activeTpOrderId: 'tp-live-999',
  lifecycle: 'ACTIVE',
  cycleBuys: 3,
  celestialBodies: [{ id: 'body-1', tpOrderId: 'tp-body-1', assetQty: 0.01 }],
  cyclesCompleted: 2,
  realizedPnL: 10,
  realizedAssetPnL: 0.0001,
  heldAssetCostBasis: 500,
  ...overrides,
});

/**
 * Fake standalone fill ledger. Records every call it receives into the
 * shared `calls` log so tests can assert which methods were (or were not)
 * invoked — the crux of the preview/apply and live/stopped distinctions
 * this handler enforces.
 */
const createFakeLedger = (calls, pair, fixture = {}) => {
  const {
    recalc = { cyclesCompleted: 5, cycleDetails: [{ id: 'cycle-5' }], orphansFixed: 1, activeCycleId: 'cycle-6' },
    preview = { cyclesCompleted: 5, cycleDetails: [{ id: 'preview-cycle-5' }], orphansFixed: 1, activeCycleId: 'cycle-6' },
    derived = { realizedPnL: 42, realizedAssetPnL: 0.002, heldOpenBuyCostBasis: 777 },
    currentCycleFillsLength = 3,
  } = fixture;
  return {
    pair,
    recalculateCycles: () => { calls.push({ op: 'recalculateCycles', pair }); return recalc; },
    previewRecalculateCycles: () => { calls.push({ op: 'previewRecalculateCycles', pair }); return preview; },
    getDerivedRealizedPnL: () => { calls.push({ op: 'getDerivedRealizedPnL', pair }); return derived; },
    getCurrentCycleFills: () => { calls.push({ op: 'getCurrentCycleFills', pair }); return { length: currentCycleFillsLength }; },
    persist: () => { calls.push({ op: 'persist', pair }); },
  };
};

/** Fake running regime engine. `recalculateAndRefresh` presence is what the
 * handler uses to decide the live-vs-stopped branch. */
const createFakeEngine = (calls, pair, { ledgerFixture = {}, recalculateResult } = {}) => {
  const ledger = createFakeLedger(calls, pair, ledgerFixture);
  return {
    getFillLedger: () => ledger,
    recalculateAndRefresh: () => {
      calls.push({ op: 'engine.recalculateAndRefresh', pair });
      return recalculateResult || {
        cyclesCompleted: 9,
        realizedPnL: 99,
        realizedAssetPnL: 0.009,
        cycleDetails: [{ id: 'live-cycle-9' }],
        orphansFixed: 0,
        activeCycleId: 'cycle-9',
      };
    },
  };
};

/**
 * Build a fresh harness: injected deps plus a shared ordered `calls` log,
 * so each test can assert exactly which side effects the real
 * regime:recalculate handler triggered, without touching real disk,
 * exchanges, or PM2.
 */
const createHarness = () => {
  const regimeEngines = new Map();
  const calls = []; // ordered log of side-effecting dependency calls
  const regimeStateByFund = new Map(); // fundKey -> {position, regime, tpOptimizer, sizeOptimizer}
  const standaloneLedgersByFund = new Map(); // fundKey -> fake ledger
  const standaloneLedgerErrors = new Map(); // fundKey -> Error to throw from getStandaloneLedger

  const resolvePair = (exchange, pair) => {
    if (pair === INVALID_PAIR) throw new Error(`Unknown configured fund for ${exchange}: ${pair}`);
    return pair || DEFAULT_PAIR;
  };

  const loadRegimeState = (exchange, pair) => {
    calls.push({ op: 'loadRegimeState', pair });
    const key = fundKey(exchange, pair);
    return regimeStateByFund.get(key) || { position: {}, regime: { mode: 'HARVEST' }, tpOptimizer: null, sizeOptimizer: null };
  };

  const saveRegimeState = (position, regime, exchange, tpOptimizer, sizeOptimizer, pair) => {
    calls.push({ op: 'saveRegimeState', pair, position, regime, tpOptimizer, sizeOptimizer });
    const key = fundKey(exchange, pair);
    const prior = regimeStateByFund.get(key) || {};
    regimeStateByFund.set(key, { ...prior, position });
  };

  const invalidateStandaloneLedger = (exchange, pair) => {
    calls.push({ op: 'invalidateStandaloneLedger', pair });
  };

  const getStandaloneLedger = (exchange, pair) => {
    calls.push({ op: 'getStandaloneLedger', pair });
    const key = fundKey(exchange, pair);
    if (standaloneLedgerErrors.has(key)) throw standaloneLedgerErrors.get(key);
    if (!standaloneLedgersByFund.has(key)) {
      standaloneLedgersByFund.set(key, createFakeLedger(calls, pair));
    }
    return standaloneLedgersByFund.get(key);
  };

  const deps = {
    regimeEngines,
    resolvePair,
    fundKey,
    readBooleanFlag,
    loadRegimeState,
    saveRegimeState,
    invalidateStandaloneLedger,
    getStandaloneLedger,
  };

  const registry = createFakeRegistry();
  registerEngineRecalculateHandler(registry, deps);

  return {
    recalculate: registry.handlers.get('regime:recalculate'),
    regimeEngines,
    calls,
    regimeStateByFund,
    standaloneLedgersByFund,
    standaloneLedgerErrors,
  };
};

const firstIndex = (calls, op, pair) =>
  calls.findIndex((c) => c.op === op && (pair === undefined || c.pair === pair));

const callsFor = (calls, pair) => calls.filter((c) => c.pair === pair);

describe('engine-recalculate-handler', () => {
  describe('running engine — preview (issue #96 / #132)', () => {
    it('returns full cycle/orphan detail via read-only accessors and never mutates or persists', async () => {
      const h = createHarness();
      const engine = createFakeEngine(h.calls, PAIR_A);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), engine);

      const result = await h.recalculate({}, EXCHANGE, PAIR_A); // apply omitted -> preview

      assert.equal(result.success, true);
      assert.equal(result.applied, false);
      assert.deepEqual(result.cycleDetails, [{ id: 'preview-cycle-5' }]);
      assert.equal(result.orphansFixed, 1);
      assert.equal(result.activeCycleId, 'cycle-6');
      assert.equal(result.currentCycleFills, 3);
      assert.equal(result.changes.realizedPnL.after, 42);

      const mine = callsFor(h.calls, PAIR_A);
      assert.ok(mine.some((c) => c.op === 'previewRecalculateCycles'), 'must call the read-only preview accessor');
      assert.ok(mine.some((c) => c.op === 'getDerivedRealizedPnL'), 'must derive P&L read-only');
      assert.equal(firstIndex(mine, 'recalculateCycles'), -1, 'must NEVER call the mutating recalculation on a running preview');
      assert.equal(firstIndex(mine, 'engine.recalculateAndRefresh'), -1, 'must never call live apply during a preview');
      assert.equal(firstIndex(mine, 'persist'), -1, 'must never persist during a preview');
      assert.equal(firstIndex(h.calls, 'getStandaloneLedger'), -1, 'must never create a standalone ledger while the engine is running');
      assert.equal(firstIndex(h.calls, 'saveRegimeState'), -1, 'must never persist regime state during a preview');
    });

    it('explicit apply:false behaves identically to omitted apply', async () => {
      const h = createHarness();
      const engine = createFakeEngine(h.calls, PAIR_A);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), engine);

      const result = await h.recalculate({ apply: false }, EXCHANGE, PAIR_A);

      assert.equal(result.applied, false);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'recalculateCycles'), -1);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'engine.recalculateAndRefresh'), -1);
    });
  });

  describe('running engine — apply (issue #96)', () => {
    it('delegates to recalculateAndRefresh and never opens/saves a standalone position, preserving live TP/body tracking on a stale disk fixture', async () => {
      const h = createHarness();
      // Seed a "stale disk fixture" carrying live order/body tracking fields
      // that a rebuild-from-scratch would drop.
      const staleFixture = makeStaleFixture();
      h.regimeStateByFund.set(fundKey(EXCHANGE, PAIR_A), { position: staleFixture, regime: { mode: 'HARVEST' } });
      const engine = createFakeEngine(h.calls, PAIR_A);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), engine);

      const result = await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      assert.equal(result.success, true);
      assert.equal(result.applied, true);
      assert.equal(result.changes.realizedPnL.after, 99);
      assert.equal(result.currentCycleFills, 3);

      const mine = callsFor(h.calls, PAIR_A);
      assert.ok(mine.some((c) => c.op === 'engine.recalculateAndRefresh'), 'must delegate to the running engine\'s own recalculateAndRefresh');
      assert.equal(firstIndex(h.calls, 'getStandaloneLedger'), -1, 'live apply must never open a second ledger writer on the same file');
      assert.equal(firstIndex(h.calls, 'saveRegimeState'), -1, 'live apply must never save a standalone position — recalculateAndRefresh owns persistence on the live engine');

      // The stale disk fixture (live TP/body tracking) is untouched — proves
      // a live apply cannot overwrite it via this handler.
      const stillOnDisk = h.regimeStateByFund.get(fundKey(EXCHANGE, PAIR_A)).position;
      assert.deepEqual(stillOnDisk, staleFixture, 'live apply must not mutate the disk-fixture position at all');
    });
  });

  describe('stopped fund — preview (issue #132)', () => {
    it('never persists (no saveRegimeState, no ledger persist)', async () => {
      const h = createHarness();
      const staleFixture = makeStaleFixture();
      h.regimeStateByFund.set(fundKey(EXCHANGE, PAIR_A), { position: staleFixture, regime: { mode: 'HARVEST' } });

      const result = await h.recalculate({ apply: false }, EXCHANGE, PAIR_A);

      assert.equal(result.applied, false);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'saveRegimeState'), -1, 'stopped preview must never persist regime state');
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'persist'), -1, 'stopped preview must never persist the ledger');
    });
  });

  describe('stopped fund — apply', () => {
    it('writes cycle-derived values and held cost while retaining activeTpOrderId, lifecycle, celestialBodies, and ladder fields', async () => {
      const h = createHarness();
      const staleFixture = makeStaleFixture({ cycleBuys: 4, someLadderField: 'untouched-ladder-value' });
      h.regimeStateByFund.set(fundKey(EXCHANGE, PAIR_A), { position: staleFixture, regime: { mode: 'HARVEST' }, tpOptimizer: { marker: 'tp-opt' }, sizeOptimizer: { marker: 'size-opt' } });

      const result = await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      assert.equal(result.applied, true);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'recalculateCycles') >= 0, true);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'persist') >= 0, true, 'stopped apply must persist the ledger');

      const saveCall = h.calls.find((c) => c.op === 'saveRegimeState' && c.pair === PAIR_A);
      assert.ok(saveCall, 'stopped apply must persist regime state');
      const saved = saveCall.position;

      // Derived fields replaced with the recalculated values.
      assert.equal(saved.cyclesCompleted, 5);
      assert.equal(saved.realizedPnL, 42);
      assert.equal(saved.realizedAssetPnL, 0.002);
      assert.equal(saved.heldAssetCostBasis, 777);

      // Non-derived order/lifecycle/body/ladder fields preserved verbatim.
      assert.equal(saved.activeTpOrderId, 'tp-live-999');
      assert.equal(saved.lifecycle, 'ACTIVE');
      assert.deepEqual(saved.celestialBodies, staleFixture.celestialBodies);
      assert.equal(saved.cycleBuys, 4);
      assert.equal(saved.someLadderField, 'untouched-ladder-value');

      // Regime/optimizer state forwarded from the loaded state, unmodified.
      assert.deepEqual(saveCall.regime, { mode: 'HARVEST' });
      assert.deepEqual(saveCall.tpOptimizer, { marker: 'tp-opt' });
      assert.deepEqual(saveCall.sizeOptimizer, { marker: 'size-opt' });
    });

    it('updates celestialState.bodiesRealizedPnL/AssetPnL in place, preserving other celestialState fields', async () => {
      const h = createHarness();
      const staleFixture = makeStaleFixture({
        celestialState: { bodiesCompleted: 7, bodiesRealizedPnL: 1, bodiesRealizedAssetPnL: 0.00001, stateVersion: 3 },
      });
      h.regimeStateByFund.set(fundKey(EXCHANGE, PAIR_A), { position: staleFixture, regime: {} });

      await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      const saveCall = h.calls.find((c) => c.op === 'saveRegimeState' && c.pair === PAIR_A);
      assert.equal(saveCall.position.celestialState.bodiesRealizedPnL, 42);
      assert.equal(saveCall.position.celestialState.bodiesRealizedAssetPnL, 0.002);
      assert.equal(saveCall.position.celestialState.bodiesCompleted, 7, 'unrelated celestialState fields preserved');
      assert.equal(saveCall.position.celestialState.stateVersion, 3, 'unrelated celestialState fields preserved');
    });

    it('does not fabricate celestialState for legacy state that has none', async () => {
      const h = createHarness();
      const staleFixture = makeStaleFixture();
      delete staleFixture.celestialState; // legacy state predates celestialState
      assert.equal('celestialState' in staleFixture, false);
      h.regimeStateByFund.set(fundKey(EXCHANGE, PAIR_A), { position: staleFixture, regime: {} });

      await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      const saveCall = h.calls.find((c) => c.op === 'saveRegimeState' && c.pair === PAIR_A);
      assert.equal(saveCall.position.celestialState, undefined, 'legacy state without celestialState must not have one synthesized');
    });
  });

  describe('validation and cold-start failures', () => {
    it('rejects a non-boolean apply before any state or ledger access', async () => {
      const h = createHarness();

      const result = await h.recalculate({ apply: 'false' }, EXCHANGE, PAIR_A);

      assert.deepEqual(result, { success: false, error: 'apply must be a boolean' });
      assert.equal(h.calls.length, 0, 'malformed apply must reject before touching loadRegimeState/ledger/resolvePair-dependent state');
    });

    for (const badApply of ['true', 0, 1, [], {}, null]) {
      it(`rejects non-boolean apply value ${JSON.stringify(badApply)}`, async () => {
        const h = createHarness();
        const result = await h.recalculate({ apply: badApply }, EXCHANGE, PAIR_A);
        assert.equal(result.success, false);
        assert.match(result.error, /apply must be a boolean/);
        assert.equal(h.calls.length, 0);
      });
    }

    it('returns the existing structured failure on cold-start ledger corruption, with no save', async () => {
      const h = createHarness();
      h.standaloneLedgerErrors.set(fundKey(EXCHANGE, PAIR_A), new Error('Fill ledger init failed for coinbase/BTC-USD — see engine logs for details'));

      const result = await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      assert.equal(result.success, false);
      assert.equal(result.error, 'Fill ledger init failed for coinbase/BTC-USD — see engine logs for details');
      assert.equal(firstIndex(h.calls, 'saveRegimeState'), -1, 'cold-start failure must not save');
      assert.equal(firstIndex(h.calls, 'persist'), -1, 'cold-start failure must not persist the ledger');
    });

    it('propagates an invalid pair error from resolvePair before touching state', async () => {
      const h = createHarness();
      await assert.rejects(() => h.recalculate({}, EXCHANGE, INVALID_PAIR), /Unknown configured fund/);
      assert.equal(h.calls.length, 0);
    });
  });

  describe('pair selection and default-pair compatibility', () => {
    it('selects the correct fund by pair; the other fund is unaffected', async () => {
      const h = createHarness();
      const engineA = createFakeEngine(h.calls, PAIR_A, { recalculateResult: { cyclesCompleted: 1, realizedPnL: 1, realizedAssetPnL: 0.1, cycleDetails: [], orphansFixed: 0, activeCycleId: 'a' } });
      const engineB = createFakeEngine(h.calls, PAIR_B, { recalculateResult: { cyclesCompleted: 2, realizedPnL: 2, realizedAssetPnL: 0.2, cycleDetails: [], orphansFixed: 0, activeCycleId: 'b' } });
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_A), engineA);
      h.regimeEngines.set(fundKey(EXCHANGE, PAIR_B), engineB);

      const resultA = await h.recalculate({ apply: true }, EXCHANGE, PAIR_A);

      assert.equal(resultA.pair, PAIR_A);
      assert.equal(resultA.changes.realizedPnL.after, 1);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_A), 'engine.recalculateAndRefresh') >= 0, true);
      assert.equal(firstIndex(callsFor(h.calls, PAIR_B), 'engine.recalculateAndRefresh'), -1, 'the other fund must remain untouched');
    });

    it('resolves an omitted pair to the default configured pair', async () => {
      const h = createHarness();
      const engine = createFakeEngine(h.calls, DEFAULT_PAIR);
      h.regimeEngines.set(fundKey(EXCHANGE, DEFAULT_PAIR), engine);

      const result = await h.recalculate({}, EXCHANGE, undefined);

      assert.equal(result.pair, DEFAULT_PAIR);
      assert.equal(result.success, true);
    });
  });
});
