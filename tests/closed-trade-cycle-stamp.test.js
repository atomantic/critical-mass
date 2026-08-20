// @ts-check
//
// Regression tests for the closed-trade cycle/timestamp misstamping bug.
//
// A body TP fill removes the last body, which triggers resetCycle() — and
// resetCycle() calls fillLedger.startNewCycle(). closedTrades.record() runs
// AFTER that, so reading fillLedger.getCurrentCycleId() / Date.now() there
// filed the trade under a LATER cycle and dated it to record time rather
// than fill time.
//
// Live incident (coinbase BTC-USDC, 2026-08-19): sell 612c14ce filled
// 3.87578721 BTC whose fills are all cycle-18, but the closed trade was
// written as cycle-21 because three cycles had rolled by record time.
//
// Exercises the REAL handleOrderFill closure via the engine's _test hooks
// with mock exchange deps, then reads the closed-trades.json the engine
// actually wrote.
//
// Disk safety: throwaway pair '__testcyclestamp__' under
// data/coinbase/, deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__testcyclestamp__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];

after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const TP_ORDER_ID = 'tp-sell-cycle-stamp';
// Two fills for the same sell order, minutes apart, so "last fill time" is
// unambiguous and clearly distinct from Date.now().
const SELL_FILL_TIME_A = new Date('2026-08-19T15:27:30.000Z').getTime();
const SELL_FILL_TIME_B = new Date('2026-08-19T15:27:35.000Z').getTime();

const makeAdapter = (over = {}) => ({
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  getPositions: async () => [],
  ...over,
});

const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-new-1' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  cancelAllLadderOrders: async () => ({ cancelled: 0 }),
  getPendingLadderOrders: () => [],
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  handleOrderCancel: () => {},
  getPendingCounts: () => ({ total: 0 }),
  isLadderOrder: () => false,
  getOrderPlacedAt: () => null,
  ...over,
});

/** The single body whose TP fill closes the cycle. */
const makeBody = () => ({
  id: 'body-cycle-stamp',
  tier: 'ASTEROID',
  assetQty: 0.05,
  costBasis: 0.05 * 50000,
  avgPrice: 50000,
  tpPrice: 51000,
  tpOrderId: TP_ORDER_ID,
  // Healthy fill = totalSize === assetOnOrder; the 0.002 remainder is the
  // DESIGNED holdback (asset-side profit), not a partial fill.
  assetOnOrder: 0.048,
  buyOrders: [{ orderId: 'buy-cycle-stamp' }],
  sourceOrderIds: [],
});

/**
 * Engine with one body holding a resting TP, positioned so that filling the
 * TP empties celestialBodies and therefore triggers resetCycle().
 */
const makeEngine = () => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(makeAdapter({
    // The exchange reports the TP's fills; the engine ingests them into the
    // ledger under whatever cycle is current at ingest time.
    getOrderFills: async (orderId) => (orderId !== TP_ORDER_ID ? [] : [
      {
        tradeId: 'sell-trade-a',
        orderId: TP_ORDER_ID,
        side: 'sell',
        price: '51000',
        size: '0.02',
        totalCommission: '0.10',
        rebate: '0',
        tradeTime: new Date(SELL_FILL_TIME_A).toISOString(),
      },
      {
        tradeId: 'sell-trade-b',
        orderId: TP_ORDER_ID,
        side: 'sell',
        price: '51000',
        size: '0.028',
        totalCommission: '0.10',
        rebate: '0',
        tradeTime: new Date(SELL_FILL_TIME_B).toISOString(),
      },
    ]),
  }));
  eng._test.setOrderExecutor(makeExecutor());

  const ledger = eng.getFillLedger();
  ledger.startNewCycle(); // cycle-1 — the cycle this sell belongs to

  const pos = eng._getPositionState();
  pos.celestialBodies = [makeBody()];
  pos.totalAsset = 0.05;

  engines.push(eng);
  return eng;
};

/** Read the closed-trades.json the engine actually persisted. */
const readClosedTrades = () => {
  const file = path.join(JUNK_DIR, 'closed-trades.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const fillTheTp = async (eng) => {
  await eng._test.handleOrderFill({
    orderId: TP_ORDER_ID,
    side: 'sell',
    status: 'FILLED',
    filledSize: 0.048,
    averageFilledPrice: 51000,
  });
};

describe('closed trade is stamped from the sell it closes, not from live engine state', () => {
  it('files the trade under the cycle its sell fills belong to, even though resetCycle already advanced the cycle', async () => {
    const eng = makeEngine();
    const ledger = eng.getFillLedger();
    assert.equal(ledger.getCurrentCycleId(), 'cycle-1');

    await fillTheTp(eng);

    // The body TP emptied celestialBodies → resetCycle() → new cycle.
    assert.equal(ledger.getCurrentCycleId(), 'cycle-2', 'precondition: cycle must advance before the trade is recorded');

    const trade = readClosedTrades().find(t => t.sellOrderId === TP_ORDER_ID);
    assert.ok(trade, 'the closed trade must be recorded');
    assert.equal(trade.cycleId, 'cycle-1');
  });

  it('dates the trade by its last exchange fill, not by when it was recorded', async () => {
    const eng = makeEngine();

    await fillTheTp(eng);

    const trade = readClosedTrades().find(t => t.sellOrderId === TP_ORDER_ID);
    assert.ok(trade, 'the closed trade must be recorded');
    assert.equal(trade.timestamp, SELL_FILL_TIME_B);
    // recordedAt keeps its own meaning: when the engine booked it.
    assert.ok(trade.recordedAt >= trade.timestamp, 'recordedAt is the booking time, distinct from fill time');
  });
});
