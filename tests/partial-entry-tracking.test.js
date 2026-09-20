// @ts-check
//
// A PARTIAL buy fill must not retire the entry order from tracking.
//
// Gemini has no order-events WebSocket (src/adapters/gemini/websocket.js
// subscribes to l2 only), so an entry order completing is detected solely by
// order-executor's checkPendingOrderFills polling its in-memory pendingOrders
// map. positionState.pendingEntryOrders is the only persisted mirror of that
// map — it is what restore-on-start replays. Dropping a still-live,
// partially-filled entry from it meant a restart lost the order entirely and
// its remaining tranche was never ingested. That leaked 1.204 ETH across 61
// buy fills on gemini/ETHUSD before an exchange reconciliation caught it.
//
// Disk safety: throwaway pair '__testpartial__' → data/coinbase/__testpartial__/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// sync-fills destructures getAdapter at load; stub before anything requires it.
const adapters = require('../src/adapters');
const originalGetAdapter = adapters.getAdapter;
let stubbedExchangeFills = [];
adapters.getAdapter = () => ({ getReconciliationFills: async () => stubbedExchangeFills });


const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__testpartial__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  adapters.getAdapter = originalGetAdapter;
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const buyFill = (orderId, tradeId, size, price) => ({
  tradeId,
  orderId,
  side: 'buy',
  price: String(price),
  size: String(size),
  totalCommission: '0.05',
  rebate: '0',
  liquidityIndicator: 'TAKER',
  tradeTime: new Date().toISOString(),
});

const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  getOrderPlacedAt: () => null,
  isLadderOrder: () => false,
  ...over,
});

const makeEngine = (adapter, executor) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor(makeExecutor(executor));
  engines.push(eng);
  return eng;
};

describe('partially-filled entry orders stay tracked', () => {
  it('keeps a partially-filled entry in pendingEntryOrders, and drops it only when terminal', async () => {
    // The order is placed for 0.079186 and fills 0.049987 first. This is the
    // exact shape of gemini order 73771291391430116, whose remaining 0.029199
    // filled 26 minutes later and was never recorded.
    let fills = [buyFill('entry-1', 'tid-a', 0.049987, 2512.43)];
    const eng = makeEngine({
      getOrderFills: async () => fills,
      // Merge pre-check on the second (terminal) pass: the body created by the
      // first tranche is a clean merge target.
      getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: 'entry-1', price: 2512.43, assetQty: 0.079186, sizeUsdc: 199 }];

    await eng._test.handleOrderFill({
      orderId: 'entry-1',
      side: 'buy',
      status: 'PARTIALLY_FILLED',
      filledSize: 0.049987,
      averageFilledPrice: 2512.43,
      isPartialFill: true,
    });

    assert.deepEqual(
      pos.pendingEntryOrders.map(e => e.orderId),
      ['entry-1'],
      'a partial fill leaves the order resting on the book — it must stay tracked',
    );

    // Remaining tranche arrives; the order is now terminal.
    fills = [...fills, buyFill('entry-1', 'tid-b', 0.029199, 2512.43)];
    await eng._test.handleOrderFill({
      orderId: 'entry-1',
      side: 'buy',
      status: 'FILLED',
      filledSize: 0.079186,
      averageFilledPrice: 2512.43,
      isPartialFill: false,
    });

    assert.deepEqual(pos.pendingEntryOrders, [], 'a terminal fill retires the entry');

    const owned = (pos.celestialBodies || []).flatMap(b => b.buyOrders || []).filter(o => o.orderId === 'entry-1');
    assert.ok(owned.length > 0, 'a body owns the entry order');
    const qty = (pos.celestialBodies || []).reduce((sum, b) => sum + b.assetQty, 0);
    assert.ok(Math.abs(qty - 0.079186) < 1e-8, `both tranches are held, got ${qty}`);
  });

  it('keeps a partially-filled ladder rung tracked too', async () => {
    const eng = makeEngine(
      { getOrderFills: async () => [buyFill('rung-1', 'tid-r', 0.004, 2500)] },
      { isLadderOrder: () => true },
    );
    const pos = eng._getPositionState();
    pos.pendingLadderOrders = [{ orderId: 'rung-1', price: 2500, assetQty: 0.01 }];

    await eng._test.handleOrderFill({
      orderId: 'rung-1',
      side: 'buy',
      status: 'PARTIALLY_FILLED',
      filledSize: 0.004,
      averageFilledPrice: 2500,
      isPartialFill: true,
    });

    assert.deepEqual(
      pos.pendingLadderOrders.map(o => o.orderId),
      ['rung-1'],
      'a partially-filled ladder rung is still resting on the book',
    );
  });
});

describe('ledger drift sweep', () => {
  it('reports exchange fills the ledger never recorded, and stays silent when clean', async () => {
    const eng = makeEngine({ getOrderFills: async () => [] });
    eng._getPositionState().engineStartTime = Date.now() - 86_400_000;

    stubbedExchangeFills = [];
    await eng._test.sweepLedgerDrift();
    assert.equal(eng._test.getFillDrift().fills, 0, 'a clean ledger reports no drift');

    stubbedExchangeFills = [
      { tradeId: 'missing-1', orderId: 'order-x', side: 'buy', price: 2500, size: 0.02, quoteAmount: 50, fee: 0.05, timestamp: Date.now() },
      { tradeId: 'missing-2', orderId: 'order-x', side: 'buy', price: 2500, size: 0.01, quoteAmount: 25, fee: 0.02, timestamp: Date.now() },
    ];
    await eng._test.sweepLedgerDrift();

    const drift = eng._test.getFillDrift();
    assert.equal(drift.fills, 2, 'both unrecorded fills are counted');
    assert.equal(drift.orders, 1, 'grouped by order');
    assert.ok(Math.abs(drift.netAsset - 0.03) < 1e-8, `net asset drift, got ${drift.netAsset}`);
    assert.deepEqual(drift.orderIds, ['order-x']);
    assert.equal(eng.getState().fillDrift.fills, 2, 'drift is surfaced on engine state');
  });
});

describe('position coverage check', () => {
  // The ledger can be complete while the position model still fails to account
  // for asset the account holds — a buy order only partly sold counts as fully
  // closed, so its unsold remainder sits in no body and gets no TP.
  const coverageEngine = (balanceTotal, bodies) => {
    const eng = makeEngine({
      getOrderFills: async () => [],
      getAccountBalance: async () => ({ total: balanceTotal, available: balanceTotal, hold: 0 }),
    });
    eng._getPositionState().engineStartTime = Date.now() - 86_400_000;
    eng._getPositionState().celestialBodies = bodies;
    eng._getPositionState().realizedAssetPnL = 0.5;
    return eng;
  };

  it('flags base currency the exchange holds that no body or reserve accounts for', async () => {
    stubbedExchangeFills = [];
    const eng = coverageEngine(1.9, [{ id: 'b1', tier: 'satellite', assetQty: 0.25, costBasis: 600, avgPrice: 2400 }]);

    await eng._test.sweepLedgerDrift();

    const cov = eng._test.getPositionCoverage();
    assert.equal(cov.onExchange, 1.9);
    assert.equal(cov.inBodies, 0.25);
    assert.equal(cov.reserves, 0.5);
    assert.ok(Math.abs(cov.unmodelled - 1.15) < 1e-8, `untracked asset, got ${cov.unmodelled}`);
    assert.equal(eng.getState().positionCoverage.unmodelled, cov.unmodelled, 'surfaced on engine state');
  });

  it('reports no gap when bodies plus reserves cover the balance', async () => {
    stubbedExchangeFills = [];
    const eng = coverageEngine(0.75, [{ id: 'b1', tier: 'satellite', assetQty: 0.25, costBasis: 600, avgPrice: 2400 }]);

    await eng._test.sweepLedgerDrift();

    assert.equal(eng._test.getPositionCoverage().unmodelled, 0);
  });
});
