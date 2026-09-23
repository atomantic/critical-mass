// @ts-check
/**
 * Manual trade import — behavioral coverage for the operator-facing paths that
 * write the live fill ledger and place real exchange orders (issue #423).
 *
 * Every test runs against a real fill ledger and a real manual-trade store
 * rooted in a fresh tmpdir (migration.getExchangeDataDir is patched, exactly as
 * tests/fill-ledger.test.js does) and a fake adapter. Nothing here touches an
 * exchange or a real data file.
 *
 * Accounting post-conditions follow CLAUDE.md's P&L model: cycles are atomic
 * buy(n)->sell(1), imported reconciliation fills carry cycleId null so
 * recalculateCycles can place them, and a buy whose `sellOrderId` is absent is
 * an OPEN position. That last rule is why the failure paths assert the ledger
 * is untouched rather than merely that the call reported failure.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

const fillLedgerPath = require.resolve('../src/fill-ledger');
const { STATUS } = require('../src/manual-trades');

const EXCHANGE = 'test-exchange';
const PAIR = 'BTC-USDC';

/** @type {string|null} */
let tmpDir = null;

/** Silent logger — these modules log on every success path. */
const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/**
 * Build a fake exchange adapter.
 * `fillsByOrder` maps orderId -> fill array, or to an Error to make the fetch reject.
 */
const createFakeAdapter = ({ fillsByOrder = {}, orders = {}, placeResult } = {}) => {
  const calls = { getOrderFills: [], placeLimitBuy: [], getOrder: [] };
  return {
    calls,
    getOrderFills: async (orderId) => {
      calls.getOrderFills.push(orderId);
      const entry = fillsByOrder[orderId];
      if (entry instanceof Error) throw entry;
      return entry || [];
    },
    getOrder: async (orderId) => {
      calls.getOrder.push(orderId);
      return orders[orderId] || { status: 'OPEN', completionPercentage: 0 };
    },
    placeLimitBuy: async (productId, size, price, options) => {
      calls.placeLimitBuy.push({ productId, size, price, options });
      if (placeResult instanceof Error) throw placeResult;
      return placeResult || { success: true, orderId: `recovery-${calls.placeLimitBuy.length}` };
    },
  };
};

const makeFill = (overrides = {}) => ({
  tradeId: `trade-${Math.random().toString(36).slice(2)}`,
  side: 'buy',
  price: 100000,
  size: 0.001,
  commission: 0.1,
  totalCommission: 0.1,
  rebate: 0,
  liquidityIndicator: 'TAKER',
  tradeTime: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

const readManualTradesFile = () => {
  const file = path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'manual-trades.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

const readRegimeStateFile = () => {
  const file = path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

describe('Manual Trade Import', () => {
  /** @type {Object} */ let fillLedger;
  /** @type {Object} */ let store;

  /** Build an importer over the shared tmpdir-backed ledger + store. */
  const createImporter = (overrides = {}) => {
    const { createManualTradeImporter } = require('../src/manual-trade-import');
    return createManualTradeImporter({
      exchange: EXCHANGE,
      pair: PAIR,
      fillLedger,
      store,
      fundConfig: { productId: 'BTC-USDC' },
      logger: silentLogger(),
      ...overrides,
    });
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-trade-import-test-'));
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(String(tmpDir), exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    delete require.cache[fillLedgerPath];
    const { createFillLedger } = require('../src/fill-ledger');
    fillLedger = createFillLedger(EXCHANGE, 'BTC-USDC', PAIR);
    fillLedger.load();
    // Open a live cycle so the `cycleId === null` assertions below actually
    // bite: imported reconciliation fills can be days old and must never be
    // stamped with the live cycle (issue #108).
    fillLedger.startNewCycle();

    const { createManualTradeStore } = require('../src/manual-trades');
    store = createManualTradeStore(EXCHANGE, PAIR);
    store.load();
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete require.cache[fillLedgerPath];
  });

  // -----------------------------------------------------------------------
  // importSell — validation happens before any mutation
  // -----------------------------------------------------------------------
  describe('importSell', () => {
    const sellFills = [
      makeFill({ tradeId: 'sell-fill-1', side: 'sell', price: 100000, size: 0.002 }),
      makeFill({ tradeId: 'sell-fill-2', side: 'sell', price: 101000, size: 0.001 }),
    ];

    it('rejects a non-numeric recoveryBuyPrice without touching the ledger or the store', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: 'abc',
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'Invalid recoveryBuyPrice');
      // The pre-extraction bug: fills were ingested and persisted before the
      // price was parsed, so a rejected request still mutated live state.
      assert.equal(fillLedger.getFillCount(), 0);
      assert.equal(readManualTradesFile(), null);
      assert.deepEqual(adapter.calls.placeLimitBuy, []);
      // Nothing was fetched either — validation short-circuits first.
      assert.deepEqual(adapter.calls.getOrderFills, []);
    });

    it('rejects a non-positive recoveryBuyPrice without touching the ledger', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: '-5',
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'Invalid recoveryBuyPrice');
      assert.equal(fillLedger.getFillCount(), 0);
      assert.equal(readManualTradesFile(), null);
    });

    it('requires a sellOrderId', async () => {
      const adapter = createFakeAdapter();
      const result = await createImporter({ adapter }).importSell({});
      assert.deepEqual(result, { success: false, error: 'sellOrderId is required' });
      assert.equal(fillLedger.getFillCount(), 0);
    });

    it('ingests sell fills and places a recovery buy sized to the total sold', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: '95000',
        note: 'rebalance',
      });

      assert.equal(result.success, true);
      assert.equal(fillLedger.getFillCount(), 2);
      // Reconciliation fills must not be stamped with the live cycle (#108).
      for (const fill of fillLedger.getAllFills()) {
        assert.equal(fill.cycleId, null);
        assert.equal(fill.orderId, 'sell-1');
        assert.equal(fill.side, 'sell');
      }

      assert.equal(adapter.calls.placeLimitBuy.length, 1);
      const placed = adapter.calls.placeLimitBuy[0];
      assert.equal(placed.productId, 'BTC-USDC');
      assert.equal(placed.size, 0.003); // 0.002 + 0.001 — recover exactly what was sold
      assert.equal(placed.price, 95000);
      assert.deepEqual(placed.options, { postOnly: false });

      const trade = result.trade;
      assert.equal(trade.status, STATUS.BUY_PENDING);
      assert.equal(trade.buyOrderId, 'recovery-1');
      assert.equal(trade.sellSize, 0.003);
      assert.equal(trade.note, 'rebalance');
      // Volume-weighted, not a plain mean of 100000/101000.
      assert.ok(Math.abs(trade.sellPrice - (100000 * 0.002 + 101000 * 0.001) / 0.003) < 1e-9);
    });

    it('links an existing buy order instead of placing one', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: '95000',
        existingBuyOrderId: 'already-placed-9',
      });

      assert.equal(result.success, true);
      assert.deepEqual(adapter.calls.placeLimitBuy, []);
      assert.equal(result.trade.status, STATUS.BUY_PENDING);
      assert.equal(result.trade.buyOrderId, 'already-placed-9');
    });

    it('places exactly one recovery buy across a duplicate retry of the same sell', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const importer = createImporter({ adapter });
      const payload = { sellOrderId: 'sell-1', recoveryBuyPrice: '95000' };

      const first = await importer.importSell(payload);
      const second = await importer.importSell(payload);

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      // Store idempotency alone does not stop the second placement — the
      // importer must see the existing buyOrderId and skip the order.
      assert.equal(adapter.calls.placeLimitBuy.length, 1);
      assert.equal(store.getAll().length, 1);
      assert.equal(second.trade.id, first.trade.id);
      assert.equal(second.trade.buyOrderId, first.trade.buyOrderId);
      // Fill ledger is idempotent by tradeId, so the retry adds no rows.
      assert.equal(fillLedger.getFillCount(), 2);
    });

    it('reports a rejected recovery buy without inventing an order id', async () => {
      const adapter = createFakeAdapter({
        fillsByOrder: { 'sell-1': sellFills },
        placeResult: { success: false, errorMessage: 'INSUFFICIENT_FUNDS' },
      });
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: '95000',
      });

      assert.equal(result.success, false);
      assert.match(result.error, /INSUFFICIENT_FUNDS/);
      assert.equal(store.getAll()[0].buyOrderId, null);
      assert.equal(store.getAll()[0].status, STATUS.SELL_RECORDED);
    });

    it('surfaces a fill-fetch failure', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': new Error('429 rate limited') } });
      const result = await createImporter({ adapter }).importSell({ sellOrderId: 'sell-1' });

      assert.equal(result.success, false);
      assert.match(result.error, /Failed to fetch sell order fills: 429 rate limited/);
      assert.equal(fillLedger.getFillCount(), 0);
    });

    it('surfaces an empty fill set', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': [] } });
      const result = await createImporter({ adapter }).importSell({ sellOrderId: 'sell-1' });

      assert.equal(result.success, false);
      assert.match(result.error, /No fills found for sell order sell-1/);
      assert.equal(fillLedger.getFillCount(), 0);
    });
  });

  // -----------------------------------------------------------------------
  // importPair — fetch both legs before ingesting either
  // -----------------------------------------------------------------------
  describe('importPair', () => {
    const buyFills = [makeFill({ tradeId: 'pair-buy-1', side: 'buy', price: 90000, size: 0.004 })];
    const sellFills = [makeFill({ tradeId: 'pair-sell-1', side: 'sell', price: 100000, size: 0.004 })];

    it('leaves zero buy rows in the ledger when the sell fetch fails', async () => {
      const adapter = createFakeAdapter({
        fillsByOrder: { 'buy-1': buyFills, 'sell-1': new Error('gateway timeout') },
      });
      const result = await createImporter({ adapter }).importPair({
        buyOrderId: 'buy-1',
        sellOrderId: 'sell-1',
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Failed to fetch sell order fills: gateway timeout/);
      // The original ordering ingested buys first, leaving rows with no
      // sellOrderId — CLAUDE.md counts those toward heldOpenBuyCostBasis,
      // permanently inflating the dashboard's open-position figure.
      assert.equal(fillLedger.getFillCount(), 0);
      assert.deepEqual(fillLedger.getFillsForOrder('buy-1'), []);
      assert.equal(store.getAll().length, 0);
    });

    it('leaves zero buy rows in the ledger when the sell order has no fills', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills, 'sell-1': [] } });
      const result = await createImporter({ adapter }).importPair({
        buyOrderId: 'buy-1',
        sellOrderId: 'sell-1',
      });

      assert.equal(result.success, false);
      assert.match(result.error, /No fills found for sell order sell-1/);
      assert.equal(fillLedger.getFillCount(), 0);
    });

    it('pairs every buy row to the sell order and dismisses both orders', async () => {
      const adapter = createFakeAdapter({
        fillsByOrder: {
          'buy-1': [
            makeFill({ tradeId: 'pair-buy-a', side: 'buy', price: 90000, size: 0.002 }),
            makeFill({ tradeId: 'pair-buy-b', side: 'buy', price: 91000, size: 0.002 }),
          ],
          'sell-1': sellFills,
        },
      });
      const result = await createImporter({ adapter }).importPair({
        buyOrderId: 'buy-1',
        sellOrderId: 'sell-1',
        note: 'closed by hand',
      });

      assert.equal(result.success, true);
      assert.equal(fillLedger.getFillCount(), 3);

      const buyRows = fillLedger.getFillsForOrder('buy-1');
      assert.equal(buyRows.length, 2);
      // No buy row may remain unpaired — an absent sellOrderId reads as an
      // open position in heldOpenBuyCostBasis.
      for (const row of buyRows) {
        assert.equal(row.sellOrderId, 'sell-1');
        assert.equal(row.cycleId, null);
      }
      // The sell leg itself is never annotated with a sellOrderId.
      assert.equal(fillLedger.getFillsForOrder('sell-1')[0].sellOrderId, undefined);

      const trade = result.trade;
      assert.equal(trade.status, STATUS.COMPLETED);
      assert.equal(trade.tradeType, 'paired');
      assert.equal(trade.buySize, 0.004);
      assert.equal(trade.sellSize, 0.004);
      assert.equal(trade.note, 'closed by hand');

      assert.ok(store.isFillDismissed('buy-1'));
      assert.ok(store.isFillDismissed('sell-1'));
      assert.deepEqual(
        readManualTradesFile().dismissedFillOrderIds.sort(),
        ['buy-1', 'sell-1'],
      );
    });

    it('requires both order ids', async () => {
      const adapter = createFakeAdapter();
      const result = await createImporter({ adapter }).importPair({ buyOrderId: 'buy-1' });
      assert.deepEqual(result, { success: false, error: 'Both buyOrderId and sellOrderId are required' });
      assert.deepEqual(adapter.calls.getOrderFills, []);
    });

    // Issue #691: store.addPairedTrade had no idempotency check, so a retried
    // importPair (e.g. operator double-clicks after a slow IPC response)
    // created a second paired-trade record for the same (buyOrderId,
    // sellOrderId) fills.
    it('is idempotent on a retried import of the same buy/sell pair', async () => {
      const adapter = createFakeAdapter({
        fillsByOrder: { 'buy-1': buyFills, 'sell-1': sellFills },
      });
      const importer = createImporter({ adapter });

      const first = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });
      const second = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      assert.equal(second.trade.id, first.trade.id);
      assert.equal(store.getAll().length, 1, 'only one paired trade must exist across the retry');
    });
  });

  // -----------------------------------------------------------------------
  // checkPendingBuy
  // -----------------------------------------------------------------------
  describe('checkPendingBuy', () => {
    const sellFills = [makeFill({ tradeId: 'chk-sell-1', side: 'sell', price: 100000, size: 0.003 })];
    const buyFills = [makeFill({ tradeId: 'chk-buy-1', side: 'buy', price: 95000, size: 0.003 })];

    /** Import a sell with a pending recovery buy and return its trade id. */
    const seedPendingTrade = async (adapter) => {
      const result = await createImporter({ adapter }).importSell({
        sellOrderId: 'sell-1',
        recoveryBuyPrice: '95000',
      });
      assert.equal(result.success, true);
      return result.trade.id;
    };

    it('completes the trade and pairs the buy fills when the order is FILLED', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const tradeId = await seedPendingTrade(adapter);
      const buyOrderId = store.getById(tradeId).buyOrderId;

      const checker = createImporter({
        adapter: createFakeAdapter({
          fillsByOrder: { [buyOrderId]: buyFills },
          orders: { [buyOrderId]: { status: 'FILLED', completionPercentage: 100 } },
        }),
      });
      const result = await checker.checkPendingBuy({ tradeId });

      assert.equal(result.success, true);
      assert.equal(result.filled, true);
      assert.equal(result.trade.status, STATUS.COMPLETED);
      assert.equal(result.trade.buySize, 0.003);
      assert.equal(result.trade.buyPrice, 95000);

      const buyRows = fillLedger.getFillsForOrder(buyOrderId);
      assert.equal(buyRows.length, 1);
      // The recovery buy closes the manual sell — pair it so it is not
      // counted as an open position.
      assert.equal(buyRows[0].sellOrderId, 'sell-1');
      assert.equal(buyRows[0].cycleId, null);
    });

    it('reports a cancelled buy without mutating the ledger', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const tradeId = await seedPendingTrade(adapter);
      const buyOrderId = store.getById(tradeId).buyOrderId;
      const fillCountBefore = fillLedger.getFillCount();

      const cancelAdapter = createFakeAdapter({
        fillsByOrder: { [buyOrderId]: buyFills },
        orders: { [buyOrderId]: { status: 'CANCELLED', completionPercentage: 0 } },
      });
      const result = await createImporter({ adapter: cancelAdapter }).checkPendingBuy({ tradeId });

      assert.equal(result.success, true);
      assert.equal(result.cancelled, true);
      assert.equal(fillLedger.getFillCount(), fillCountBefore);
      assert.deepEqual(cancelAdapter.calls.getOrderFills, []);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);
    });

    it('reports an open order without mutating the ledger', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const tradeId = await seedPendingTrade(adapter);
      const buyOrderId = store.getById(tradeId).buyOrderId;
      const fillCountBefore = fillLedger.getFillCount();

      const openAdapter = createFakeAdapter({
        orders: { [buyOrderId]: { status: 'OPEN', completionPercentage: 40 } },
      });
      const result = await createImporter({ adapter: openAdapter }).checkPendingBuy({ tradeId });

      assert.equal(result.success, true);
      assert.equal(result.orderStatus, 'OPEN');
      assert.equal(result.filledPercent, 40);
      assert.equal(fillLedger.getFillCount(), fillCountBefore);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);
    });

    it('rejects an unknown trade id', async () => {
      const result = await createImporter({ adapter: createFakeAdapter() })
        .checkPendingBuy({ tradeId: 'nope' });
      assert.deepEqual(result, { success: false, error: 'Manual trade nope not found' });
    });

    it('is a no-op for a trade with no pending buy', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const imported = await createImporter({ adapter }).importSell({ sellOrderId: 'sell-1' });
      const result = await createImporter({ adapter }).checkPendingBuy({ tradeId: imported.trade.id });

      assert.equal(result.success, true);
      assert.equal(result.message, 'No pending buy to check');
      assert.deepEqual(adapter.calls.getOrder, []);
    });
  });

  // -----------------------------------------------------------------------
  // importBuy
  // -----------------------------------------------------------------------
  describe('importBuy', () => {
    const buyFills = [
      makeFill({ tradeId: 'imp-buy-1', side: 'buy', price: 90000, size: 0.002, commission: 0.5, totalCommission: 0.5 }),
      makeFill({ tradeId: 'imp-buy-2', side: 'buy', price: 92000, size: 0.001, commission: 0.25, totalCommission: 0.25 }),
    ];

    it('persists the new body to regime-state.json when no engine is running', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const result = await createImporter({ adapter, injectBody: null }).importBuy({
        buyOrderId: 'buy-1',
        createBody: true,
      });

      assert.equal(result.success, true);

      const saved = readRegimeStateFile();
      assert.ok(saved, 'regime-state.json was written');
      const bodies = saved.position.celestialBodies;
      assert.equal(bodies.length, 1);
      const body = bodies[0];
      assert.equal(body.assetQty, 0.003);
      // Cost basis includes fees: 90000*0.002 + 92000*0.001 + 0.75
      assert.ok(Math.abs(body.costBasis - (180 + 92 + 0.75)) < 1e-9);
      assert.equal(body.sourceOrderIds[0], 'buy-1');
      // A freshly imported body has no take-profit yet — the engine places it.
      assert.equal(body.tpOrderId, null);
      assert.equal(body.assetOnOrder, 0);

      // The store links the trade to the body it will be closed by.
      assert.equal(result.trade.status, STATUS.TP_PENDING);
      assert.equal(result.trade.bodyId, body.id);

      // Buy rows are stamped as body-owned so the engine's TP accounting
      // can attribute them, and remain unpaired (this position is OPEN).
      const rows = fillLedger.getFillsForOrder('buy-1');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.bodyId, body.id);
        assert.equal(row.isBodyOwned, true);
        assert.equal(row.bodyTier, body.tier);
        assert.equal(row.sellOrderId, undefined);
      }
    });

    it('injects the body into a running engine instead of writing state to disk', async () => {
      const injected = [];
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const result = await createImporter({
        adapter,
        injectBody: async (body) => {
          injected.push(body);
          return { tpPlaced: true };
        },
      }).importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(result.success, true);
      assert.equal(injected.length, 1);
      assert.equal(injected[0].assetQty, 0.003);
      assert.equal(readRegimeStateFile(), null);
      assert.equal(result.trade.bodyId, injected[0].id);
    });

    it('skips body creation when createBody is false', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const result = await createImporter({ adapter }).importBuy({
        buyOrderId: 'buy-1',
        createBody: false,
      });

      assert.equal(result.success, true);
      assert.equal(result.trade.status, STATUS.BUY_RECORDED);
      assert.equal(result.trade.bodyId, null);
      assert.equal(readRegimeStateFile(), null);
      assert.equal(fillLedger.getFillsForOrder('buy-1')[0].bodyId, undefined);
    });

    it('is idempotent on a duplicate import of the same buy order', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({ adapter });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: false });
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: false });

      assert.equal(second.trade.id, first.trade.id);
      assert.equal(store.getAll().length, 1);
      assert.equal(fillLedger.getFillCount(), 2);
    });

    // Issue #691: addManualBuy is idempotent at the STORE layer, but a retry
    // (IPC timeout, or injectBody throwing after the ledger/store writes) that
    // reached body creation would create a SECOND body for the same fill and
    // place a second live TP sell against it. A retried createBody:true import
    // must create/inject exactly one body.
    it('creates and injects exactly one body across a retried import (createBody:true, engine running)', async () => {
      const injected = [];
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          injected.push(body);
          return { tpPlaced: true };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      assert.equal(injected.length, 1, 'injectBody must be called exactly once across the retry');
      assert.equal(second.trade.bodyId, first.trade.bodyId);
      assert.equal(second.trade.bodyId, injected[0].id);
      assert.equal(second.alreadyImported, true);
      assert.equal(store.getAll().length, 1);
    });

    // Issue #691 review follow-up: the top-of-function retry guard (trade.bodyId
    // / STATUS.TP_PENDING) only fires once a PRIOR call reached store.markTpPlaced.
    // If an earlier call's injectBody actually pushed the real body and placed its
    // TP, but the call then rejected before markTpPlaced ran (e.g. saveLiveState()
    // throwing), the trade store never learns about that body — so a retry falls
    // through the guard, creates a second phantom body, and calls injectBody again.
    // regime-engine's own injectBody refuses that as a duplicate of the real body;
    // importBuy must honor the refusal and re-link the trade/ledger to the real
    // body, never to the phantom it just (correctly) failed to inject.
    it('re-links the trade to the existing body when injectBody refuses a retried duplicate', async () => {
      const engineBodies = [];
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          const duplicate = engineBodies.find((b) => b.sourceOrderIds[0] === body.sourceOrderIds[0]);
          if (duplicate) {
            return { success: false, error: 'duplicate body', bodyId: duplicate.id, tpPlaced: true };
          }
          // Real regime-engine behavior: push + place TP happen BEFORE the
          // final saveLiveState() call, so a throw there still leaves the
          // body live in the engine.
          engineBodies.push(body);
          throw new Error('saveLiveState failed (simulated)');
        },
      });

      await assert.rejects(
        importer.importBuy({ buyOrderId: 'buy-1', createBody: true }),
        /saveLiveState failed/,
      );
      assert.equal(engineBodies.length, 1, 'the real body was pushed into the engine despite the later throw');
      const realBodyId = engineBodies[0].id;

      const beforeRetry = store.getAll();
      assert.equal(beforeRetry.length, 1);
      assert.equal(beforeRetry[0].bodyId, null, 'the trade store never learned about the real body');

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.alreadyImported, true);
      assert.equal(engineBodies.length, 1, 'no second body was ever pushed into the engine');
      assert.equal(second.trade.bodyId, realBodyId, 'the trade must link to the real, live body — not the refused phantom');

      const rows = fillLedger.getFillsForOrder('buy-1');
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.bodyId, realBodyId, 'fill-ledger rows must point at the real body, not the phantom');
      }
    });

    it('persists exactly one body to regime-state.json across a retried import (createBody:true, engine not running)', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({ adapter, injectBody: null });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(first.success, true);
      assert.equal(second.success, true);
      assert.equal(second.trade.bodyId, first.trade.bodyId);
      assert.equal(second.alreadyImported, true);

      const saved = readRegimeStateFile();
      assert.ok(saved, 'regime-state.json was written');
      assert.equal(saved.position.celestialBodies.length, 1, 'only one body must be persisted across the retry');
    });

    // Issue #691 review follow-up (codex): injectBody can fail for a reason
    // OTHER than a confirmed duplicate — e.g. {success:false, error:'Engine
    // not running'} from a race with regime:start/stop. Before this fix,
    // importBuy unconditionally called store.markTpPlaced regardless of the
    // injection outcome, marking the trade TP_PENDING against a body that
    // was never actually pushed into the engine. Combined with the new
    // top-of-function retry guard, that permanently short-circuited every
    // future retry on the same buyOrderId, orphaning the fill for good.
    it('leaves the trade retryable when injectBody fails without a confirmed duplicate', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      let calls = 0;
      const importer = createImporter({
        adapter,
        injectBody: async () => {
          calls++;
          if (calls === 1) return { success: false, error: 'Engine not running' };
          return { success: true, tpPlaced: true };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, false);
      assert.match(first.error, /Engine not running/);

      const afterFirst = store.getAll();
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0].bodyId, null, 'a failed injection must never be linked to the trade');
      assert.notEqual(afterFirst[0].status, STATUS.TP_PENDING, 'the trade must stay retryable, not TP_PENDING');
      // The optimistic ledger annotation from before the (failed) injection
      // attempt must be rolled back too.
      const rowAfterFirst = fillLedger.getFillsForOrder('buy-1')[0];
      assert.equal(rowAfterFirst.bodyId, null);
      assert.equal(rowAfterFirst.isBodyOwned, false);

      // A retry (e.g. once the engine finishes starting) must actually try
      // again — the top-of-function guard must not silently treat this as
      // already imported.
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(second.success, true);
      assert.equal(calls, 2, 'the retry must call injectBody again, not skip it');
      assert.equal(second.trade.status, STATUS.TP_PENDING);
      assert.ok(second.trade.bodyId);
      assert.equal(fillLedger.getFillsForOrder('buy-1')[0].bodyId, second.trade.bodyId);
    });

    // Issue #691 review follow-up (codex, rounds 3-4): a body that fully
    // closes (its TP completely fills) is spliced out of
    // positionState.celestialBodies, so injectBody's in-memory duplicate
    // check can't see it on a later retry. The fill ledger still can:
    // placeBodyTp stamps BOTH `bodyId` and `sellOrderId` onto a body's buy
    // fills the moment its TP is PLACED (crash-resilient linkage, CLAUDE.md),
    // before the sell ever fills, and that stamp survives the body's later
    // removal. A retry must consult `bodyId` specifically (round 4: a bare
    // `sellOrderId` alone is NOT safe — recalculateCycles' generic
    // cycle-completion auto-link stamps that onto every buy in a >=50%-sold
    // cycle for display, without a bodyId) and refuse to create a second
    // body — otherwise it would fabricate a live position (and place a real
    // second TP sell) for an asset that was already sold.
    it('refuses to create a second body once the buy fills are already linked to a body in the ledger', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      let calls = 0;
      const importer = createImporter({
        adapter,
        injectBody: async () => {
          calls++;
          // Mimic placeBodyTp's real side effect: stamp bodyId + sellOrderId
          // onto the buy fills at TP PLACEMENT time, then fail before
          // returning — the crash-resilient ledger linkage survives the
          // failure even though the trade store update never runs.
          fillLedger.annotateFillsByOrderId('buy-1', { bodyId: 'body-live-1', sellOrderId: 'tp-order-1' });
          fillLedger.persist();
          throw new Error('saveLiveState failed (simulated)');
        },
      });

      await assert.rejects(importer.importBuy({ buyOrderId: 'buy-1', createBody: true }));
      assert.equal(calls, 1);

      // Simulates the window in which that TP goes on to fully fill and its
      // body is removed from the engine's live position before the operator
      // retries — exactly what makes the in-memory duplicate check blind.
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.alreadyImported, true);
      assert.equal(calls, 1, 'injectBody must never be called again once the buy is already linked to a body');
      assert.equal(store.getAll().length, 1);
      // The trade record must be linked to the REAL body the ledger already
      // knows about — not left orphaned, and never a fresh id of its own.
      assert.equal(store.getAll()[0].bodyId, 'body-live-1');
      assert.equal(store.getAll()[0].status, STATUS.TP_PENDING);
    });

    it('does not skip body creation merely because a cycle-completion sellOrderId is present without a bodyId', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({ adapter, injectBody: null });

      // Ledger-only import first (createBody:false) — the fills exist in the
      // ledger but no body/TP has ever been created for them.
      await importer.importBuy({ buyOrderId: 'buy-1', createBody: false });

      // Simulate recalculateCycles' "auto-link buys to sells within
      // completed cycles" step (fill-ledger.js) blanket-stamping sellOrderId
      // onto this buy purely because its cycle crossed the 50%-sold
      // heuristic — NOT proof this specific buy's own quantity was sold, and
      // critically WITHOUT a bodyId (that field is only ever set by an
      // actual body-creation flow).
      fillLedger.annotateFillsByOrderId('buy-1', { sellOrderId: 'unrelated-cycle-sell' });
      fillLedger.persist();

      const result = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(result.success, true);
      assert.notEqual(result.alreadyImported, true, 'a bare cycle-linkage sellOrderId must not be treated as already-imported');
      assert.ok(result.trade.bodyId, 'a body must still be created for this genuinely-unmanaged buy');
      const saved = readRegimeStateFile();
      assert.equal(saved.position.celestialBodies.length, 1);
    });

    it('detects an engine-stopped body already persisted to disk even if markTpPlaced never completes (crash window)', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const importer = createImporter({ adapter, injectBody: null });

      // Simulate a process crash between persistBodyToDisk succeeding and
      // store.markTpPlaced ever completing — the fill-ledger bodyId
      // annotation (stamped and persisted BEFORE persistBodyToDisk even
      // runs) must survive this window even though the trade store's
      // bodyId/status update does not.
      const realMarkTpPlaced = store.markTpPlaced;
      let markCalls = 0;
      store.markTpPlaced = (...args) => {
        markCalls++;
        if (markCalls === 1) throw new Error('process crashed (simulated)');
        return realMarkTpPlaced.apply(store, args);
      };
      try {
        await assert.rejects(importer.importBuy({ buyOrderId: 'buy-1', createBody: true }));
      } finally {
        store.markTpPlaced = realMarkTpPlaced;
      }

      const beforeRetry = store.getAll();
      assert.equal(beforeRetry.length, 1);
      assert.equal(beforeRetry[0].bodyId, null, 'the trade store never learned about the persisted body');
      const savedBefore = readRegimeStateFile();
      assert.ok(savedBefore, 'the body was persisted to regime-state.json despite the later crash');
      assert.equal(savedBefore.position.celestialBodies.length, 1);

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.alreadyImported, true);
      const savedAfter = readRegimeStateFile();
      assert.equal(savedAfter.position.celestialBodies.length, 1, 'no second body may be persisted');
      assert.equal(second.trade.bodyId, savedBefore.position.celestialBodies[0].id, 'the retry must link the trade record to the already-persisted body');
      assert.equal(second.trade.status, STATUS.TP_PENDING);
    });

    it('requires a buyOrderId', async () => {
      const result = await createImporter({ adapter: createFakeAdapter() }).importBuy({});
      assert.deepEqual(result, { success: false, error: 'buyOrderId is required' });
    });

    // Issue #454: createBody selects ledger-only import vs. injecting/persisting
    // a body that may place a live TP order — a non-boolean must never reach
    // that branch, and rejection must leave no trace on disk (same ordering
    // contract importSell already follows for recoveryBuyPrice).
    for (const createBody of ['false', 'true', 0, 1, [], {}, null]) {
      it(`rejects a non-boolean createBody (${JSON.stringify(createBody)}) without touching the ledger or the store`, async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
        const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody });

        assert.equal(result.success, false);
        assert.equal(result.error, 'createBody must be a boolean');
        assert.equal(fillLedger.getFillCount(), 0);
        assert.equal(readManualTradesFile(), null);
        assert.equal(readRegimeStateFile(), null);
        // Validation short-circuits before the first fill fetch.
        assert.deepEqual(adapter.calls.getOrderFills, []);
      });
    }

    it('defaults omitted createBody to true (creates a body)', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': buyFills } });
      const result = await createImporter({ adapter, injectBody: null }).importBuy({ buyOrderId: 'buy-1' });

      assert.equal(result.success, true);
      assert.equal(result.trade.status, STATUS.TP_PENDING);
      assert.ok(readRegimeStateFile(), 'a body was persisted');
    });
  });
});
