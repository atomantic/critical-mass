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
