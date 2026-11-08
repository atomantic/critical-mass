// @ts-check
//
// In-place backup quiescence through a REAL regime engine (issue #1945).
//
// The backup window holds each live engine's backup fence instead of stopping
// it. These tests drive real fills (WebSocket order events and polled fills)
// into an active hold and prove that:
//   - a fill that arrives while the pause is quiescing parks at the fence and
//     does not stall the process-wide drain (the #1909 regression: the drain
//     waited 30 s on the parked booking, then refused the backup);
//   - nothing under the fund's data directory changes between the pause
//     confirming quiescence and the resume, checked by content hash + mtime;
//   - every parked writer (fill, dust consolidation, deferred state save) runs
//     once after the resume.
//
// Disk safety: every fund file lives under a disposable temp root.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-backup-hold-engine');

// The size optimizer persists through config.json; keep the fixture out of it.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { drainPendingWrites } = require('../src/pending-writes');
const { setEngineMaintenance, setEngineBackupPaused } = require('../src/engine-maintenance');

const engines = [];
after(() => {
  for (const eng of engines) { eng._test.setRunning(false); eng._test.clearTimers(); }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});
afterEach(() => { setEngineMaintenance({ active: false }); setEngineBackupPaused(false); });

const logger = { info() {}, warn() {}, error() {} };
const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = () => r(undefined); });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const fillRow = (orderId) => ({ tradeId: `${orderId}-t1`, orderId, side: 'buy', size: 0.01, price: 2000,
  netFee: 0.02, tradeTime: '2026-01-01T00:00:01.000Z' });
const fillEvent = (orderId) => ({ orderId, side: 'buy', status: 'FILLED',
  filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000, totalFees: 0.02 });

let tpCounter = 0;
const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: `tp-${++tpCounter}` }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  handleOrderCancel: () => {},
  getPendingCounts: () => ({ total: 0, entries: 0 }),
  getOrderPlacedAt: () => null,
  isLadderOrder: () => false,
  restorePendingOrder: () => {},
  ...over,
});

/** A running live engine with mock exchange deps, registered with a real backup window. */
const setup = (pair, { executor = {}, adapter = {} } = {}) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  const getOrderCalls = [];
  eng._test.setAdapter({
    getOrder: async (id) => { getOrderCalls.push(id); return { filledSize: 0, status: 'OPEN' }; },
    getOrderFills: async (id) => [fillRow(id)],
    getPositions: async () => [],
    ...adapter,
  });
  eng._test.setOrderExecutor(makeExecutor(executor));
  engines.push(eng);
  // Publish a baseline generation so every fund file exists before the hold.
  eng.flushForBackup();

  const handlers = new Map();
  registerEngineBackupHandlers({ onRequest: (name, handler) => handlers.set(name, handler) }, {
    regimeEngines: new Map([[`coinbase::${pair}`, eng]]),
    getMarketFunds: () => [], stopMarketServices: () => {}, drainMarketStarts: async () => {},
    startMarketService: async () => ({ success: true }),
    drainPendingWrites, logger,
  });
  const fundDir = isolatedData.fundDir('coinbase', pair);
  return {
    eng, getOrderCalls, fundDir,
    pause: () => handlers.get('engine:backup-pause')(),
    resume: () => handlers.get('engine:backup-resume')(),
    bodyFor: (orderId) => eng._getPositionState().celestialBodies.find((b) => b.sourceOrderIds?.includes(orderId)),
  };
};

/** Content hash and mtime of every file under a fund directory. */
const fingerprint = (dir) => {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.statSync(full);
      out[path.relative(dir, full)] = `${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}@${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};

describe('in-place backup hold with a real regime engine (#1945)', () => {
  for (const [route, deliver] of [
    ['WebSocket', (eng, orderId) => eng._test.handleWsOrderUpdate(fillEvent(orderId))],
    ['poll', (eng, orderId) => eng._test.handlePolledFill(orderId, fillEvent(orderId))],
  ]) {
    it(`a ${route} fill that arrives mid-pause parks, the pause confirms without waiting out the drain, and books once after resume`, async () => {
      const firstTp = deferred();
      const first = `${route}-inflight`;
      const late = `${route}-late`;
      let placements = 0;
      const h = setup(`__testbackuphold${route}__`, { executor: {
        placeBodyTpOrder: async () => {
          // The first fill is mid-booking (past the fence) when the hold begins.
          if (++placements === 1) await firstTp.promise;
          return { success: true, orderId: `tp-${++tpCounter}` };
        },
      } });
      deliver(h.eng, first);
      await settle();
      assert.equal(h.eng._test.getFlags().fencedWriters, 1, 'the first fill is in flight past the fence');

      setEngineMaintenance({ active: true, reason: 'backup test' });
      const startedAt = Date.now();
      const pausing = h.pause();
      await settle();
      assert.equal(h.eng.isBackupHeld(), true, 'the hold closed the fence');
      // A fill arriving now queues behind the fence. Under #1909 its tracked
      // booking stalled the drain for its full 30 s bound.
      deliver(h.eng, late);
      await settle();
      firstTp.resolve();
      const paused = await pausing;
      assert.deepEqual(paused, { success: true, quiesced: true });
      assert.ok(Date.now() - startedAt < 5_000, `pause confirmed in ${Date.now() - startedAt}ms, not after the 30 s drain bound`);
      assert.ok(h.bodyFor(first), 'the fill already past the fence finished before the flush');
      assert.equal(h.bodyFor(late), undefined, 'the late fill waits at the fence');

      const before = fingerprint(h.fundDir);
      assert.ok(Object.keys(before).includes('fill-ledger.json') && Object.keys(before).includes('regime-state.json'));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(fingerprint(h.fundDir), before, 'no fund file changes while the backup holds the fence');

      assert.equal((await h.resume()).success, true);
      await settle();
      await drainPendingWrites(5_000);
      assert.equal(h.eng.isBackupHeld(), false);
      assert.ok(h.bodyFor(late), 'the parked fill books after resume');
      const held = h.eng._getPositionState().celestialBodies.reduce((sum, b) => sum + b.assetQty, 0);
      assert.ok(Math.abs(held - 0.02) < 1e-12, `both fills booked exactly once (held ${held})`);
      assert.equal(h.eng.getFillLedger().getFillsForOrder(late).length, 1);
      assert.notDeepEqual(fingerprint(h.fundDir), before, 'the booking is persisted after resume');
    });
  }

  it('an entry tick, a dust consolidation and a save-timer tick during the hold write nothing until resume', async () => {
    const h = setup('__testbackupholdwriters__');
    const pos = h.eng._getPositionState();
    const body = (id, avgPrice, qty, tpOrderId = null) => ({ id, tier: 'ASTEROID', assetQty: qty, costBasis: qty * avgPrice,
      avgPrice, tpPrice: tpOrderId ? avgPrice * 1.01 : 0, tpOrderId, assetOnOrder: 0, buyOrders: [{ orderId: `buy-${id}` }], sourceOrderIds: [] });
    pos.celestialBodies = [body('dust', 50000, 0.00005), body('near', 50100, 0.01, 'tp-near')];
    pos.totalAsset = 0.01005;
    h.eng.flushForBackup();

    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.deepEqual(await h.pause(), { success: true, quiesced: true });
    const before = fingerprint(h.fundDir);

    // Ticker-driven entry evaluation is skipped while fenced.
    h.eng._test.handleTicker({ price: 50000, bid: 49999, ask: 50001 });
    // Dust consolidation parks at the merge lock's fence.
    let merged = false;
    const merging = h.eng._test.consolidateDustBodies().then(() => { merged = true; });
    // A save-timer tick is deferred, not written.
    assert.equal(h.eng._test.saveLiveStateGuarded('state-save-timer'), true);
    await settle();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(merged, false, 'the consolidation waits for the fence');
    assert.deepEqual(h.getOrderCalls, [], 'the merge never reached the exchange');
    assert.equal(pos.celestialBodies.length, 2);
    assert.deepEqual(fingerprint(h.fundDir), before, 'no fund file changes while the backup holds the fence');

    assert.equal((await h.resume()).success, true);
    await merging;
    await drainPendingWrites(5_000);
    assert.equal(pos.celestialBodies.length, 1, 'the dust body merged after resume');
    const saved = JSON.parse(fs.readFileSync(path.join(h.fundDir, 'regime-state.json'), 'utf8'));
    assert.equal(saved.position.celestialBodies.length, 1, 'the deferred and merge saves land after resume');
    assert.notDeepEqual(fingerprint(h.fundDir), before);
  });

  it('a stop during the hold reopens the fence so parked fills meet the stopping engine', async () => {
    const h = setup('__testbackupholdstop__');
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.deepEqual(await h.pause(), { success: true, quiesced: true });
    const parked = h.eng._test.handleOrderFill(fillEvent('stop-parked'));
    await settle();
    await h.eng.stop();
    assert.equal(h.eng.isBackupHeld(), false);
    await assert.rejects(parked, (err) => err.code === 'FILL_GATE_CLOSED', 'the parked fill is refused and recovered on the next start');
    assert.equal((await h.resume()).success, true);
  });
});
