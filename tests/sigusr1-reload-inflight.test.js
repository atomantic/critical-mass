// @ts-check
//
// Issue #1407: a SIGUSR1 state reload must not discard an unsaved sale booking.
//
// Fill handlers book a sale in memory (commitSellBooking / recordBuyConsumption
// mark the ledger dirty) and persist only after awaiting exchange work — the
// partial body-TP path awaits placeBodyTp before its save. A reload landing in
// that window used to run fillLedger.load(), whose resetCaches() wiped the
// booking AND the dirty flag, so the handler's later persist() was a no-op and
// the sale's bodyPnl / consumedBy were lost for good. The reload now refuses
// while the fund is mutating, and reports the refusal to the operator.
//
// Disk safety: throwaway pairs '__test1407<x>__' under a disposable temp root.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-sigusr1-reload-inflight-test');

// The size optimizer persists per-pair into the SHARED data/config.json.
// Neutralize BEFORE regime-engine is required (it destructures at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const adapters = require('../src/adapters');
const originalGetAdapter = adapters.getAdapter;
adapters.getAdapter = () => ({ getReconciliationFills: async () => [] });

const { createRegimeEngine } = require('../src/regime-engine');
const celestialHierarchy = require('../src/celestial-hierarchy');
const { getFillLedgerPath } = require('../src/fill-ledger');
const { tradeEvents } = require('../src/trade-events');

let pairSeq = 0;
const nextPair = () => `__test1407${String.fromCharCode(97 + pairSeq++)}__`;

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  adapters.getAdapter = originalGetAdapter;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const rawFill = (side, orderId, tradeId, size, price) => ({
  tradeId,
  orderId,
  side,
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  liquidityIndicator: side === 'buy' ? 'TAKER' : 'MAKER',
  tradeTime: new Date().toISOString(),
});

const makeEngine = (adapter, executor = {}) => {
  const pair = nextPair();
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter({ getOrder: async () => ({ filledSize: 0, status: 'OPEN' }), ...adapter });
  eng._test.setOrderExecutor({
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-replaced' }),
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    exportState: () => ({}),
    ...executor,
  });
  engines.push(eng);
  return { eng, pair };
};

const makeBody = (id, orderId, qty, price, tpOrderId) => ({
  ...celestialHierarchy.createNewBody({ assetQty: qty, costBasis: qty * price, avgPrice: price }, orderId),
  id,
  tier: 'satellite',
  tpOrderId,
  tpPrice: price * 1.04,
  assetOnOrder: qty,
});

/** @param {string} pair @returns {any[]} The fill ledger as it is on disk */
const readDiskLedger = (pair) => JSON.parse(fs.readFileSync(getFillLedgerPath('coinbase', pair), 'utf8'));

/** Collect the sigusr1-reload trade events emitted while `run` executes. */
const captureReloadEvents = async (run) => {
  const events = [];
  const listener = (event) => { if (event.data?.action === 'sigusr1-reload') events.push(event); };
  tradeEvents.on('trade', listener);
  try {
    await run();
  } finally {
    tradeEvents.removeListener('trade', listener);
  }
  return events;
};

/** Seed a 0.86 body for buy order 'buy-a' with a resting 0.8 TP 'tp-a', all persisted. */
const seedBody = (eng) => {
  const pos = eng._getPositionState();
  const ledger = eng.getFillLedger();
  ledger.startNewCycle();
  ledger.ingestFill(rawFill('buy', 'buy-a', 'buy-a-t1', 0.86, 2500));
  ledger.annotateFillsByOrderId('buy-a', { sellOrderId: 'tp-a' });
  ledger.persist();
  const body = makeBody('body-aaaaaaaa', 'buy-a', 0.86, 2500, 'tp-a');
  body.assetOnOrder = 0.8;
  pos.celestialBodies = [body];
  return { pos, ledger, body };
};

describe('SIGUSR1 reload during an in-flight fill booking (issue #1407)', () => {
  it('defers while a partial body-TP fill awaits its re-place, and the booking is persisted when the handler completes', async () => {
    /** @type {(v: any) => void} */
    let releasePlacement = () => {};
    let placementStarted = /** @type {(v?: any) => void} */ (() => {});
    const placementReached = new Promise((resolve) => { placementStarted = resolve; });
    const { eng, pair } = makeEngine(
      { getOrderFills: async (orderId) => (orderId === 'tp-a' ? [rawFill('sell', 'tp-a', 'tp-a-t1', 0.3, 2600)] : []) },
      {
        placeBodyTpOrder: () => {
          placementStarted();
          return new Promise((resolve) => { releasePlacement = resolve; });
        },
      }
    );
    const { ledger } = seedBody(eng);

    // A partial: 0.3 of the 0.8 on order sold. The handler books the sale in
    // memory, then awaits the re-place of the remaining 0.56.
    const fillDone = eng._test.handleOrderFill({
      orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.3, averageFilledPrice: 2600, isPartialFill: false,
    });
    await placementReached;

    const booked = ledger.getFillsForOrder('tp-a');
    assert.ok(booked.length > 0 && booked.every((f) => Number.isFinite(f.bodyPnl)), 'sale booked in memory before the await');

    const events = await captureReloadEvents(() => {
      assert.equal(eng._test.reloadStateFromDisk(), false, 'reload refused mid-booking');
    });
    assert.equal(events.length, 1, 'a deferred reload is reported, not silently dropped');
    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /deferred/i);
    assert.match(events[0].message, /retry/i);

    assert.ok(ledger.getFillsForOrder('tp-a').every((f) => Number.isFinite(f.bodyPnl)), 'the in-memory booking survived the signal');

    releasePlacement({ success: true, orderId: 'tp-replaced' });
    await fillDone;

    const diskSells = readDiskLedger(pair).filter((f) => f.orderId === 'tp-a');
    assert.ok(diskSells.length > 0, 'the sale row is on disk');
    assert.ok(diskSells.every((f) => Number.isFinite(f.bodyPnl)), 'the sale booking (bodyPnl) is persisted');
    const diskBuy = readDiskLedger(pair).find((f) => f.orderId === 'buy-a');
    assert.ok(diskBuy.consumedBy && diskBuy.consumedBy['tp-a'] > 0, 'the buy consumption record is persisted');
    assert.ok(eng._getPositionState().realizedPnL > 0, 'realized P&L includes the sale');
  });

  it('applies an on-disk edit when nothing is in flight', async () => {
    const { eng, pair } = makeEngine({});
    seedBody(eng);

    // Operator hand-edits: a regime-state marker and an extra ledger row.
    const stateFile = path.join(isolatedData.fundDir('coinbase', pair), 'regime-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      position: { celestialState: { operatorMarker: 'repaired-by-hand' } },
      regime: {},
    }));
    const diskLedger = readDiskLedger(pair);
    diskLedger.push({ ...diskLedger[0], tradeId: 'buy-z-t1', orderId: 'buy-z', size: 0.01, sellOrderId: undefined });
    fs.writeFileSync(getFillLedgerPath('coinbase', pair), JSON.stringify(diskLedger, null, 2));

    const events = await captureReloadEvents(() => {
      assert.equal(eng._test.reloadStateFromDisk(), true);
    });
    assert.equal(events.length, 0, 'a clean reload emits no error');
    assert.equal(eng._getPositionState().celestialState.operatorMarker, 'repaired-by-hand');
    assert.equal(eng.getFillLedger().getFillsForOrder('buy-z').length, 1, 'the hand-added ledger row is loaded');
  });

  it('defers while the ledger holds unsaved changes, keeping them in memory', async () => {
    const { eng } = makeEngine({});
    const { ledger } = seedBody(eng);
    ledger.ingestFill(rawFill('buy', 'buy-b', 'buy-b-t1', 0.1, 2400), null, { skipPersist: true }); // batched, not yet persisted
    assert.equal(ledger.isDirty(), true);

    const events = await captureReloadEvents(() => {
      assert.equal(eng._test.reloadStateFromDisk(), false);
    });
    assert.equal(events.length, 1);
    assert.match(events[0].message, /unsaved/i);
    assert.equal(ledger.getFillsForOrder('buy-b').length, 1, 'the unsaved fill was not wiped by a reload');
    assert.equal(ledger.isDirty(), true, 'the dirty flag still forces the next persist to write');
  });

  for (const [label, setBusy] of [
    ['a merge or reconcile', (eng) => eng._test.setMergeInProgress(true)],
    ['an in-flight fill', (eng) => eng._test.setFillInProgress(1)],
  ]) {
    it(`defers while ${label} holds the position`, async () => {
      const { eng } = makeEngine({});
      seedBody(eng);
      setBusy(eng);
      const events = await captureReloadEvents(() => {
        assert.equal(eng._test.reloadStateFromDisk(), false);
      });
      assert.equal(events.length, 1);
      assert.match(events[0].message, /deferred/i);
    });
  }
});
