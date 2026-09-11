// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const originalUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const { createRegimeEngine } = require('../src/regime-engine');
configUtils.updateRegimeConfig = originalUpdate;
const state = require('../src/state-tracker');
const { createOrderExecutor } = require('../src/order-executor');
const PAIR = 'BTC-USDC';
let root;
let engine;
let executor;
let adapter;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-adoption-'));
  mock.method(migration, 'getExchangeDataDir', () => path.join(root, 'coinbase'));
  engine = createRegimeEngine('coinbase', PAIR, { dryRun: false, productId: PAIR }, {});
  adapter = { findOrderByClientOrderId: async () => ({ orderId: 'adopted', status: 'OPEN' }) };
  executor = createOrderExecutor('coinbase', {}, adapter, PAIR, {}, PAIR);
  engine._test.setAdapter(adapter);
  engine._test.setOrderExecutor(executor);
});
afterEach(() => {
  engine._test.clearTimers();
  executor.clearTimers();
  mock.restoreAll();
  fs.rmSync(root, { recursive: true, force: true });
});
const makeIntent = (action, extra = {}) => {
  const intent = state.recordPlacementIntent({ exchange: 'coinbase', pair: PAIR, action, price: 120, size: 0.9, sizeUsdc: 108, ...extra });
  state.markPlacementIntentUnresolved('coinbase', PAIR, intent.id, { clientOrderId: 'client-1' });
  return intent.id;
};
const diskPosition = () => JSON.parse(fs.readFileSync(path.join(root, 'coinbase', PAIR, 'regime-state.json'), 'utf8')).position;
const seedBody = () => {
  const body = { id: 'body-1', tier: 'satellite', assetQty: 1, costBasis: 100, avgPrice: 100, tpOrderId: null, tpPrice: 0, assetOnOrder: 0, sourceOrderIds: ['buy-1'], buyOrders: [] };
  engine._getPositionState().celestialBodies = [body];
  engine.getFillLedger().ingestFill({ tradeId: 'buy-fill', orderId: 'buy-1', side: 'buy', price: 100, size: 1, tradeTime: new Date().toISOString() });
  return body;
};

describe('regime operator placement adoption', () => {
  it('persists an entry once when two operator lookups overlap', async () => {
    const id = makeIntent('entry_bid');
    const results = await Promise.all([
      engine.reconcilePlacementIntent(id, 'adopt'),
      engine.reconcilePlacementIntent(id, 'adopt'),
    ]);
    assert.equal(results.filter(r => r.success).length, 1);
    assert.equal(diskPosition().pendingEntryOrders.length, 1);
    assert.equal(diskPosition().pendingEntryOrders[0].orderId, 'adopted');
    assert.equal(executor.getPendingCounts().total, 1);
  });
  it('persists body ownership and buy-to-sell linkage before releasing the intent', async () => {
    const body = seedBody();
    const id = makeIntent('body_tp', { bodyId: body.id });
    assert.equal((await engine.reconcilePlacementIntent(id, 'adopt')).success, true);
    assert.equal(body.tpOrderId, 'adopted');
    assert.equal(body.assetOnOrder, 0.9);
    assert.equal(diskPosition().celestialBodies[0].tpOrderId, 'adopted');
    assert.equal(diskPosition().assetOnOrder, 0.9);
    assert.equal(engine.getFillLedger().getFillsForOrder('buy-1')[0].sellOrderId, 'adopted');
    assert.equal(executor.getBodyByTpOrderId('adopted').bodyId, 'body-1');
    assert.equal(state.loadPlacementIntents('coinbase', PAIR).length, 0);
    assert.equal((await engine.reconcilePlacementIntent(id, 'adopt')).success, false);
  });
  it('persists an adopted ladder rung for restart and post-poll fill classification', async () => {
    const id = makeIntent('ladder_entry', { ladderIndex: 3 });
    await engine.reconcilePlacementIntent(id, 'adopt');
    assert.equal(diskPosition().ladderActive, true);
    assert.deepEqual(diskPosition().pendingLadderOrders.map(o => [o.orderId, o.ladderIndex, o.assetQty]), [['adopted', 3, 0.9]]);
    assert.equal(diskPosition().pendingLadderOrders[0].ladderIndex, executor.getPendingLadderOrders()[0].ladderIndex);
    assert.equal(executor.isLadderOrder('adopted'), true);
  });
  it('persists legacy TP identity and links its current-cycle buys', async () => {
    engine.getFillLedger().startNewCycle();
    engine.getFillLedger().ingestFill({ tradeId: 'legacy-fill', orderId: 'legacy-buy', side: 'buy', price: 100, size: 1, tradeTime: new Date().toISOString() });
    await engine.reconcilePlacementIntent(makeIntent('take_profit'), 'adopt');
    assert.equal(diskPosition().activeTpOrderId, 'adopted');
    assert.equal(diskPosition().lastTpPrice, 120);
    assert.equal(engine.getFillLedger().getFillsForOrder('legacy-buy')[0].sellOrderId, 'adopted');
  });
  it('keeps an intent blocked when its body has disappeared or owns another TP', async () => {
    const id = makeIntent('body_tp', { bodyId: 'body-1' });
    assert.equal((await engine.reconcilePlacementIntent(id, 'adopt')).success, false);
    const body = seedBody();
    body.tpOrderId = 'different-live-order';
    assert.equal((await engine.reconcilePlacementIntent(id, 'adopt')).success, false);
    assert.equal(state.getBlockingPlacementIntents('coinbase', PAIR).length, 1);
    assert.equal(executor.getPendingCounts().total, 0);
  });
  it('retains the intent after persistence failure and permits an idempotent retry', async () => {
    seedBody();
    const id = makeIntent('body_tp', { bodyId: 'body-1' });
    const originalRename = fs.renameSync;
    mock.method(fs, 'renameSync', (from, to) => {
      if (String(to).endsWith('regime-state.json')) throw new Error('disk failure');
      return originalRename(from, to);
    });
    await assert.rejects(engine.reconcilePlacementIntent(id, 'adopt'), /disk failure/);
    assert.equal(state.getBlockingPlacementIntents('coinbase', PAIR).length, 1);
    fs.renameSync.mock.restore();
    assert.equal((await engine.reconcilePlacementIntent(id, 'adopt')).success, true);
    assert.equal(diskPosition().celestialBodies[0].tpOrderId, 'adopted');
    assert.equal(executor.getPendingCounts().total, 1);
    assert.equal(state.loadPlacementIntents('coinbase', PAIR).length, 0);
  });
});
