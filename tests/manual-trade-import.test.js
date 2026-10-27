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
const crypto = require('crypto');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

const fillLedgerPath = require.resolve('../src/fill-ledger');
const { STATUS, recoveryClientOrderId } = require('../src/manual-trades');

const EXCHANGE = 'test-exchange';
const PAIR = 'BTC-USDC';

/** @type {string|null} */
let tmpDir = null;

/** Silent logger — these modules log on every success path. */
const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/**
 * Build a fake exchange adapter.
 * `fillsByOrder` maps orderId -> fill array, or to an Error to make the fetch reject.
 * Real adapters report order/product identity on every fill and order record
 * (issue #1023), so by default missing orderId/productId are stamped onto
 * fills and order records default to a BTC-USDC buy. `stampIdentity: false`
 * returns the data exactly as given, for identity-verification tests.
 */
const createFakeAdapter = ({ fillsByOrder = {}, orders = {}, placeResult, stampIdentity = true } = {}) => {
  const calls = { getOrderFills: [], placeLimitBuy: [], getOrder: [] };
  return {
    calls,
    getOrderFills: async (orderId) => {
      calls.getOrderFills.push(orderId);
      const entry = fillsByOrder[orderId];
      if (entry instanceof Error) throw entry;
      if (!entry) return [];
      return stampIdentity ? entry.map((f) => ({ orderId, productId: PAIR, ...f })) : entry;
    },
    getOrder: async (orderId) => {
      calls.getOrder.push(orderId);
      const order = orders[orderId] || { status: 'OPEN', completionPercentage: 0 };
      return stampIdentity ? { productId: PAIR, side: 'buy', ...order } : order;
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

/** Yield one macrotask so concurrent imports interleave at every await. */
const sleepTick = () => new Promise((resolve) => setImmediate(resolve));

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
  it('refuses a malformed adapter fill without acknowledging the import or touching the ledger (#875)', async () => {
    const adapter = createFakeAdapter({ fillsByOrder: { bad: [
      makeFill({ tradeId: 'good-1' }), makeFill({ tradeId: 'bad-1', price: 'invalid' }),
    ] } });
    const importer = createImporter({ adapter });
    const result = await importer.importBuy({ buyOrderId: 'bad', createBody: false });
    assert.equal(result.success, false);
    assert.match(result.error, /price/);
    assert.equal(fillLedger.getAllFills().length, 0, 'valid sibling not half-ingested');
  });

  it('replaces terminal coverage on manual import and preserves body ownership (#807)', async () => {
    fillLedger.ingestFill({ tradeId: 'synthetic-terminal-0.02', orderId: 'terminal',
      side: 'buy', size: 0.02, price: 2000, netFee: 0 });
    fillLedger.annotateFillsByOrderId('terminal', { bodyId: 'existing-body', isBodyOwned: true });
    fillLedger.persist();
    const adapter = createFakeAdapter({ fillsByOrder: { terminal: [{ tradeId: 'real-terminal',
      orderId: 'terminal', side: 'buy', size: 0.02, price: 2000, netFee: 0,
      tradeTime: new Date().toISOString() }] } });
    const importer = createImporter({ adapter,
      injectBody: async () => { assert.fail('must not create duplicate inventory'); },
      extendBody: async (_bodyId, totals) => {
        assert.equal(totals.assetQty, 0.02);
        return { success: true, bodyId: 'existing-body', alreadyApplied: true };
      } });
    const result = await importer.importBuy({ buyOrderId: 'terminal' });
    assert.equal(result.success, true);
    assert.equal(fillLedger.getRecordedSizeForOrder('terminal'), 0.02);
    assert.equal(fillLedger.getFillsForOrder('terminal').length, 1);
    assert.equal(fillLedger.getFillsForOrder('terminal')[0].bodyId, 'existing-body');
  });

  it('extends an existing body by only the quantity beyond terminal coverage (#835)', async () => {
    fillLedger.ingestFill({ tradeId: 'synthetic-terminal-0.02', orderId: 'terminal',
      side: 'buy', size: 0.02, price: 2000, fee: 0.04, netFee: 0.04,
      syntheticCoverage: { orderId: 'terminal', cumulativeQuantity: 0.02,
        cumulativeQuote: 40, cumulativeFees: 0.04 } });
    fillLedger.annotateFillsByOrderId('terminal', { bodyId: 'existing-body', isBodyOwned: true });
    fillLedger.persist();

    const body = { assetQty: 0.02, costBasis: 40.04 };
    const extendCalls = [];
    const adapter = createFakeAdapter({ fillsByOrder: { terminal: [{
      tradeId: 'real-terminal-0.03', orderId: 'terminal', side: 'buy',
      size: 0.03, price: 2000, commission: 0.06, totalCommission: 0.06,
      netFee: 0.06, tradeTime: new Date().toISOString(),
    }] } });
    const importer = createImporter({ adapter,
      injectBody: async () => { assert.fail('must extend the existing body, not inject another'); },
      extendBody: async (bodyId, totals, buyOrderId) => {
        extendCalls.push({ bodyId, totals, buyOrderId });
        body.assetQty = totals.assetQty;
        body.costBasis = totals.costBasis;
        return { success: true, bodyId, tier: 'test' };
      } });

    const first = await importer.importBuy({ buyOrderId: 'terminal' });
    assert.equal(first.success, true);
    assert.equal(first.extended, true);
    assert.equal(body.assetQty, 0.03);
    assert.ok(Math.abs(body.costBasis - 60.06) < 1e-8);
    assert.equal(extendCalls.length, 1);
    assert.equal(extendCalls[0].totals.assetQty, 0.03);
    assert.ok(Math.abs(extendCalls[0].totals.costBasis - 60.06) < 1e-8);
    assert.equal(fillLedger.getRecordedSizeForOrder('terminal'), 0.03);
    const rows = fillLedger.getFillsForOrder('terminal');
    assert.equal(rows.find(row => row.tradeId.startsWith('synthetic-')).size, 0.02);
    assert.equal(rows.find(row => row.tradeId === 'real-terminal-0.03').size, 0.01);

    const retry = await importer.importBuy({ buyOrderId: 'terminal' });
    assert.equal(retry.success, true);
    assert.equal(body.assetQty, 0.03);
    assert.equal(extendCalls.length, 1, 'a retry must not extend or book the tranche twice');
  });

  it('rejects an invalid later row up front, leaving synthetic coverage intact for a clean retry (#834/#875)', async () => {
    fillLedger.ingestFill({ tradeId: 'synthetic-terminal-0.02', orderId: 'terminal',
      side: 'buy', size: 0.02, price: 2000, netFee: 0 });
    fillLedger.annotateFillsByOrderId('terminal', { bodyId: 'existing-body', isBodyOwned: true });
    fillLedger.persist();
    const adapter = createFakeAdapter({ fillsByOrder: { terminal: [
      { tradeId: 'real-first', side: 'buy', size: 0.01, price: 2000, netFee: 0 },
      { tradeId: 'invalid-real', side: 'buy', size: 0, price: 2100, netFee: 0 },
    ] } });
    const importer = createImporter({ adapter,
      injectBody: async () => { assert.fail('failed import must not create a body'); },
      extendBody: async () => { assert.fail('failed import must not grow a body'); } });
    const refused = await importer.importBuy({ buyOrderId: 'terminal' });
    assert.equal(refused.success, false);
    assert.match(refused.error, /size/);
    // Validation runs before ANY row is ingested, so the first valid row is not
    // half-applied: coverage is untouched, in memory and on disk.
    const { createFillLedger } = require('../src/fill-ledger');
    const restored = createFillLedger(EXCHANGE, 'BTC-USDC', PAIR);
    assert.deepEqual(restored.getAllFills(), fillLedger.getAllFills());
    assert.deepEqual(restored.getFillsForOrder('terminal').map(row => row.tradeId),
      ['synthetic-terminal-0.02']);
    assert.equal(readManualTradesFile(), null);

    // Finish history after restart. The first real ID dedups and the remaining
    // equivalent row completes replacement without a second inventory claim.
    adapter.getOrderFills = async () => [
      { tradeId: 'real-first', side: 'buy', size: 0.01, price: 2000, netFee: 0 },
      { tradeId: 'real-second', side: 'buy', size: 0.01, price: 2000, netFee: 0 },
    ];
    const retried = await createImporter({ adapter, fillLedger: restored,
      injectBody: async () => { assert.fail('retry must preserve existing body'); },
      extendBody: async (_bodyId, totals) => {
        assert.equal(totals.assetQty, 0.02);
        return { success: true, bodyId: 'existing-body', alreadyApplied: true };
      } })
      .importBuy({ buyOrderId: 'terminal' });
    assert.equal(retried.success, true);
    assert.equal(restored.getRecordedSizeForOrder('terminal'), 0.02);
    assert.equal(restored.getFillsForOrder('terminal').length, 2);
  });

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
      // Sent with the deterministic client id of the durable intent (#1058).
      assert.deepEqual(placed.options, { postOnly: false, clientOrderId: recoveryClientOrderId(result.trade.id, 1) });

      const trade = result.trade;
      assert.equal(trade.status, STATUS.BUY_PENDING);
      assert.equal(trade.buyOrderId, 'recovery-1');
      assert.equal(trade.recoveryIntent, null, 'the accepted order replaces its intent in the same write');
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

    describe('concurrent imports of the same sell (#874)', () => {
      const makeGate = () => {
        let release;
        const promise = new Promise((r) => { release = r; });
        return { promise, release };
      };
      const tick = () => new Promise((r) => setImmediate(r));

      it('submits one recovery buy for overlapping requests from separate importers', async () => {
        const gate = makeGate();
        const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
        const basePlace = adapter.placeLimitBuy;
        adapter.placeLimitBuy = async (...args) => { const r = await basePlace(...args); await gate.promise; return r; };
        const payload = { sellOrderId: 'sell-1', recoveryBuyPrice: '95000' };

        const p1 = createImporter({ adapter }).importSell(payload);
        while (adapter.calls.placeLimitBuy.length < 1) await tick();
        const p2 = createImporter({ adapter }).importSell(payload);
        for (let i = 0; i < 5; i++) await tick();
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        gate.release();
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(r1.success, true);
        assert.equal(r2.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        assert.equal(r2.trade.id, r1.trade.id);
        assert.equal(r2.trade.buyOrderId, 'recovery-1');
        const saved = readManualTradesFile();
        const records = Array.isArray(saved.trades) ? saved.trades : Object.values(saved.trades);
        assert.equal(records.length, 1);
        assert.equal(records[0].buyOrderId, 'recovery-1');
      });

      it('rejects an overlapping existing-buy link that conflicts with the committed buy', async () => {
        const gate = makeGate();
        const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
        const basePlace = adapter.placeLimitBuy;
        adapter.placeLimitBuy = async (...args) => { const r = await basePlace(...args); await gate.promise; return r; };

        const p1 = createImporter({ adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
        while (adapter.calls.placeLimitBuy.length < 1) await tick();
        const p2 = createImporter({ adapter }).importSell({ sellOrderId: 'sell-1', existingBuyOrderId: 'other-buy' });
        gate.release();
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(r1.success, true);
        assert.equal(r2.success, false);
        assert.match(r2.error, /already associated with buy order recovery-1/);
        assert.equal(store.getAll()[0].buyOrderId, 'recovery-1');
      });

      it('does not block different sells and releases the lock after a rejection', async () => {
        const gate = makeGate();
        const otherFills = [makeFill({ tradeId: 'o-1', side: 'sell', size: 0.001, price: 100000 })];
        const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills, 'sell-2': otherFills } });
        const basePlace = adapter.placeLimitBuy;
        let first = true;
        adapter.placeLimitBuy = async (...args) => {
          if (first) { first = false; await gate.promise; return { success: false, errorMessage: 'rejected' }; }
          return basePlace(...args);
        };

        const p1 = createImporter({ adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
        while (first) await tick();
        const other = await createImporter({ adapter }).importSell({ sellOrderId: 'sell-2', recoveryBuyPrice: '95000' });
        assert.equal(other.success, true);

        const p3 = createImporter({ adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
        gate.release();
        const r1 = await p1;
        const r3 = await p3;
        assert.equal(r1.success, false);
        assert.equal(r3.success, true);
        assert.ok(r3.trade.buyOrderId);
      });
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
      assert.equal(store.getAll()[0].recoveryIntent, null, 'a clean rejection releases the intent');
    });

    describe('durable recovery-buy intent (#1058)', () => {
      const payload = { sellOrderId: 'sell-1', recoveryBuyPrice: '95000' };

      /**
       * Adapter whose placements land on a fake exchange book keyed by client
       * order id, so findOrderByClientOrderId sees exactly what was accepted.
       */
      const createExchange = (opts = {}) => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills }, ...opts });
        const book = new Map();
        const basePlace = adapter.placeLimitBuy;
        adapter.placeLimitBuy = async (...args) => {
          const result = await basePlace(...args);
          if (result?.success) book.set(args[3].clientOrderId, { orderId: result.orderId, status: 'OPEN', filledSize: 0 });
          return result;
        };
        adapter.lookups = [];
        adapter.findOrderByClientOrderId = async (clientOrderId, productId) => {
          adapter.lookups.push({ clientOrderId, productId });
          return book.get(clientOrderId) || null;
        };
        return { adapter, book };
      };

      /** A fresh store loaded from disk — what the engine sees after a restart. */
      const reloadStore = () => {
        const { createManualTradeStore } = require('../src/manual-trades');
        const reloaded = createManualTradeStore(EXCHANGE, PAIR);
        reloaded.load();
        return reloaded;
      };

      /** Accept the order on the exchange, then die before the store records it. */
      const crashAfterAcceptance = async (adapter) => {
        const recordRecoveryBuy = store.recordRecoveryBuy;
        store.recordRecoveryBuy = () => { throw new Error('simulated crash'); };
        await assert.rejects(() => createImporter({ adapter }).importSell(payload), /simulated crash/);
        store.recordRecoveryBuy = recordRecoveryBuy;
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        store = reloadStore();
        const trade = store.getAll()[0];
        assert.equal(trade.status, STATUS.SELL_RECORDED, 'the restart sees no recorded buy');
        assert.equal(trade.buyOrderId, null);
        assert.equal(trade.recoveryIntent.clientOrderId, recoveryClientOrderId(trade.id, 1));
        assert.equal(trade.recoveryIntent.size, 0.003);
        assert.equal(trade.recoveryIntent.price, 95000);
        return trade;
      };

      it('never re-places after a crash between acceptance and record: a retried import adopts the order', async () => {
        const { adapter } = createExchange();
        const { clientOrderId } = (await crashAfterAcceptance(adapter)).recoveryIntent;

        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1, 'no second live buy');
        assert.deepEqual(adapter.lookups, [{ clientOrderId, productId: 'BTC-USDC' }]);
        assert.equal(retry.trade.buyOrderId, 'recovery-1');
        assert.equal(retry.trade.status, STATUS.BUY_PENDING);
        assert.equal(retry.trade.buySize, 0.003);
        assert.equal(retry.trade.recoveryIntent, null);

        const again = await createImporter({ adapter }).importSell(payload);
        assert.equal(again.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        assert.equal(reloadStore().getAll()[0].buyOrderId, 'recovery-1');
      });

      it('adopts a crashed placement on the restart sweep, before any retry', async () => {
        const { adapter } = createExchange();
        await crashAfterAcceptance(adapter);

        const swept = await createImporter({ adapter }).recoverPendingRecoveryIntents();
        assert.equal(swept.length, 1);
        assert.equal(swept[0].adopted, true);
        assert.equal(swept[0].orderId, 'recovery-1');
        const trade = reloadStore().getAll()[0];
        assert.equal(trade.status, STATUS.BUY_PENDING);
        assert.equal(trade.buyOrderId, 'recovery-1');
        assert.equal(trade.recoveryIntent, null);

        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
      });

      // Join the real REST lookup to the disk-backed importer after a crash.
      // Stub only fetch: no live exchange traffic or replacement POST is allowed.
      const withCoinbaseHistory = async (page, run) => {
        const { privateKey } = crypto.generateKeyPairSync('ec', {
          namedCurve: 'prime256v1',
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const keysPath = path.join(tmpDir, 'coinbase-test-keys.json');
        fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
        const originalFetch = global.fetch;
        const calls = [];
        global.fetch = async (url, options) => {
          const parsed = new URL(url);
          calls.push(parsed);
          assert.equal(options.method, 'GET', 'recovery must not submit a replacement buy');
          assert.equal(parsed.pathname, '/api/v3/brokerage/orders/historical/batch');
          assert.equal(parsed.searchParams.get('product_ids'), PAIR);
          const body = page(parsed, calls);
          return { ok: true, status: 200, json: async () => body };
        };
        try {
          await run(createCoinbaseAdapter(keysPath, { sleep: async () => {} }), calls);
        } finally {
          global.fetch = originalFetch;
        }
      };

      it('cold-recovers an older accepted Coinbase order beyond 100 newer orders without losing ownership (#1731)', async () => {
        const { adapter: placedAdapter } = createExchange();
        const crashed = await crashAfterAcceptance(placedAdapter);
        const intent = crashed.recoveryIntent;
        const cursor = 'older/+?=& orders';
        await withCoinbaseHistory((url) => {
          if (!url.searchParams.has('cursor')) return {
            orders: Array.from({ length: 100 }, (_, i) => ({ client_order_id: `newer-${i}` })),
            has_next: true, cursor,
          };
          assert.equal(url.searchParams.get('cursor'), cursor);
          return { has_next: false, orders: [{
            order_id: 'recovery-1', client_order_id: intent.clientOrderId, product_id: PAIR,
            side: 'BUY', status: 'OPEN', filled_size: '0.001',
            filled_value: '95', average_filled_price: '95000', completion_percentage: '33.33',
          }] };
        }, async (adapter, calls) => {
          const swept = await createImporter({ adapter }).recoverPendingRecoveryIntents();
          assert.deepEqual(swept.map(({ adopted, orderId }) => ({ adopted, orderId })),
            [{ adopted: true, orderId: 'recovery-1' }]);
          store = reloadStore();
          const recovered = store.getById(crashed.id);
          assert.equal(recovered.status, STATUS.BUY_PENDING);
          assert.equal(recovered.buyOrderId, 'recovery-1');
          assert.equal(recovered.buyPrice, intent.price);
          assert.equal(recovered.buySize, intent.size);
          assert.equal(recovered.recoveryIntent, null, 'ownership and intent conversion survive a fresh disk load');
          assert.deepEqual(await createImporter({ adapter }).recoverPendingRecoveryIntents(), []);
          assert.equal(calls.length, 2, 'a second cold sweep does not look up or replace the adopted buy');
          assert.equal(placedAdapter.calls.placeLimitBuy.length, 1);
        });
      });

      const incompleteHistories = [
        ['network failure', () => { throw new Error('socket disconnected'); }],
        ['repeated cursor', () => ({ orders: [], has_next: true, cursor: 'next' })],
        ['missing cursor', () => ({ orders: [], has_next: true })],
        ['malformed page', () => ({ has_next: false })],
        ['64-page exhaustion', (_url, calls) => ({ orders: [], has_next: true, cursor: `next-${calls.length}` })],
      ];
      for (const [name, laterPage] of incompleteHistories) {
        it(`retains a cold recovery intent through Coinbase ${name} (#1731)`, async () => {
          const { adapter: placedAdapter } = createExchange();
          const crashed = await crashAfterAcceptance(placedAdapter);
          const intent = { ...crashed.recoveryIntent };
          await withCoinbaseHistory((url, calls) => !url.searchParams.has('cursor')
            ? { orders: [], has_next: true, cursor: 'next' }
            : laterPage(url, calls), async (adapter) => {
            for (let attempt = 0; attempt < 2; attempt++) {
              const swept = await createImporter({ adapter }).recoverPendingRecoveryIntents();
              assert.equal(swept[0].blocked, true);
              assert.equal(swept[0].released, undefined);
              store = reloadStore();
              const blocked = store.getById(crashed.id);
              assert.equal(blocked.buyOrderId, null);
              assert.deepEqual(blocked.recoveryIntent, intent, 'a partial scan cannot erase durable ownership');
              assert.match(blocked.lastCheck.error, /lookup inconclusive/);
            }
            assert.equal(placedAdapter.calls.placeLimitBuy.length, 1);
          });
        });
      }

      it('adopts a thrown placement whose order actually landed instead of re-placing it', async () => {
        const { adapter, book } = createExchange();
        const basePlace = adapter.placeLimitBuy;
        adapter.placeLimitBuy = async (...args) => {
          await basePlace(...args);
          throw Object.assign(new Error('socket hang up'), { status: 'unknown', unknownOutcome: true, clientOrderId: args[3].clientOrderId });
        };

        const result = await createImporter({ adapter }).importSell(payload);
        assert.equal(result.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        assert.equal(adapter.lookups.length, 1);
        assert.equal(result.trade.buyOrderId, 'recovery-1');
        assert.equal(result.trade.status, STATUS.BUY_PENDING);
        assert.equal(result.trade.recoveryIntent, null);
        assert.ok(book.has(recoveryClientOrderId(result.trade.id, 1)));

        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1, 'no duplicate after adoption');
      });

      it('retries a not-found lookup right after a throw before releasing it', async () => {
        const { adapter } = createExchange();
        const basePlace = adapter.placeLimitBuy;
        adapter.placeLimitBuy = async (...args) => { await basePlace(...args); throw new Error('ETIMEDOUT'); };
        // The exchange indexes the accepted order only after the first lookup.
        const baseFind = adapter.findOrderByClientOrderId;
        adapter.findOrderByClientOrderId = async (...args) => (adapter.lookups.length === 0
          ? (adapter.lookups.push({}), null)
          : baseFind(...args));

        const result = await createImporter({ adapter, recoveryLookupRetryDelaysMs: [0] }).importSell(payload);
        assert.equal(result.success, true);
        assert.equal(adapter.lookups.length, 2);
        assert.equal(result.trade.buyOrderId, 'recovery-1');
      });

      it('keeps the trade blocked with an actionable reason while the client-id lookup fails, then releases on a positive not-found', async () => {
        const { adapter } = createExchange();
        adapter.placeLimitBuy = async (productId, size, price, options) => {
          adapter.calls.placeLimitBuy.push({ productId, size, price, options });
          throw new Error('ECONNRESET');
        };
        adapter.findOrderByClientOrderId = async () => { throw new Error('503 Service Unavailable'); };

        const first = await createImporter({ adapter }).importSell(payload);
        assert.equal(first.success, false);
        assert.match(first.error, /ECONNRESET/);
        assert.match(first.error, /client order id lookup failed \(503 Service Unavailable\)/);
        assert.match(first.error, /No new buy will be placed until the exchange confirms it/);
        const blocked = reloadStore().getAll()[0];
        assert.equal(blocked.status, STATUS.SELL_RECORDED);
        assert.ok(blocked.recoveryIntent, 'the intent survives on disk');
        // The row explains why nothing was placed (shown by the Manual Trades UI).
        assert.match(blocked.lastCheck.error, /503 Service Unavailable/);
        assert.match(blocked.lastCheck.error, new RegExp(blocked.recoveryIntent.clientOrderId));

        // Neither a retried placement nor a link may proceed while unresolved.
        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, false);
        assert.match(retry.error, /may already be on the exchange/);
        const link = await createImporter({ adapter }).importSell({ sellOrderId: 'sell-1', existingBuyOrderId: 'manual-buy' });
        assert.equal(link.success, false);
        assert.equal(store.getAll()[0].buyOrderId, null);
        const sweep = await createImporter({ adapter }).recoverPendingRecoveryIntents();
        assert.equal(sweep[0].blocked, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);

        // A positive not-found releases it; the next placement is a new attempt.
        adapter.findOrderByClientOrderId = async () => null;
        adapter.placeLimitBuy = async (productId, size, price, options) => {
          adapter.calls.placeLimitBuy.push({ productId, size, price, options });
          return { success: true, orderId: 'recovery-2' };
        };
        const released = await createImporter({ adapter }).importSell(payload);
        assert.equal(released.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 2);
        assert.equal(adapter.calls.placeLimitBuy[1].options.clientOrderId, recoveryClientOrderId(released.trade.id, 2));
        assert.notEqual(adapter.calls.placeLimitBuy[1].options.clientOrderId, adapter.calls.placeLimitBuy[0].options.clientOrderId);
        assert.equal(released.trade.buyOrderId, 'recovery-2');
        assert.equal(released.trade.recoveryIntent, null);
      });

      it('releases an intent whose order the exchange holds only as cancelled with no executions', async () => {
        const { adapter, book } = createExchange();
        await crashAfterAcceptance(adapter);
        const [clientOrderId] = book.keys();
        book.set(clientOrderId, { orderId: 'recovery-1', status: 'CANCELLED', filledSize: 0 });

        const swept = await createImporter({ adapter }).recoverPendingRecoveryIntents();
        assert.equal(swept[0].released, true);
        const trade = reloadStore().getAll()[0];
        assert.equal(trade.recoveryIntent, null);
        assert.equal(trade.buyOrderId, null);
      });

      it('adopts a cancelled order that partially executed rather than over-recovering', async () => {
        const { adapter, book } = createExchange();
        await crashAfterAcceptance(adapter);
        const [clientOrderId] = book.keys();
        book.set(clientOrderId, { orderId: 'recovery-1', status: 'CANCELLED', filledSize: 0.001 });

        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, true);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
        assert.equal(retry.trade.buyOrderId, 'recovery-1');
      });

      it('stays blocked when the adapter cannot look up client order ids', async () => {
        const { adapter } = createExchange();
        await crashAfterAcceptance(adapter);
        delete adapter.findOrderByClientOrderId;

        const retry = await createImporter({ adapter }).importSell(payload);
        assert.equal(retry.success, false);
        assert.match(retry.error, /cannot look up orders by client order id/);
        assert.equal(adapter.calls.placeLimitBuy.length, 1);
      });

      it('places nothing when the intent cannot be persisted', async () => {
        const { adapter } = createExchange();
        store.recordRecoveryIntent = () => { throw new Error('ENOSPC'); };

        const result = await createImporter({ adapter }).importSell(payload);
        assert.equal(result.success, false);
        assert.match(result.error, /Failed to record recovery buy intent; nothing was placed: ENOSPC/);
        assert.deepEqual(adapter.calls.placeLimitBuy, []);
      });
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

    // Issue #726: addPairedTrade's (buyOrderId, sellOrderId) dedup matched
    // ANY existing record, including one importSell's sell-first recovery
    // flow left at BUY_PENDING while waiting on the recovery buy to fill. An
    // operator who later imports the same pair directly via importPair (which
    // already fetches and links both legs' fills) got that stale BUY_PENDING
    // record handed back unchanged — permanently stuck pending despite
    // nothing left to do. It must be promoted to completed instead.
    it('promotes an existing BUY_PENDING recovery trade to completed instead of leaving it stuck', async () => {
      const recoveryBuyFills = [makeFill({ tradeId: 'recovery-buy-1', side: 'buy', price: 91000, size: 0.004 })];
      const adapter = createFakeAdapter({
        fillsByOrder: { 'sell-1': sellFills, 'recovery-1': recoveryBuyFills },
      });
      const importer = createImporter({ adapter });

      // Sell-first recovery flow: places a recovery buy, trade sits at BUY_PENDING.
      const sellResult = await importer.importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '91000' });
      assert.equal(sellResult.success, true);
      assert.equal(sellResult.trade.status, STATUS.BUY_PENDING);
      const recoveryBuyOrderId = sellResult.trade.buyOrderId;
      assert.equal(store.getAll().length, 1);

      // Operator later imports the SAME pair directly via importPair (e.g.
      // from the unaccounted-fills view) instead of waiting on checkPendingBuy.
      const pairResult = await importer.importPair({ buyOrderId: recoveryBuyOrderId, sellOrderId: 'sell-1' });

      assert.equal(pairResult.success, true);
      // The SAME record is promoted in place, not a second one created.
      assert.equal(store.getAll().length, 1);
      assert.equal(pairResult.trade.id, sellResult.trade.id);
      assert.equal(pairResult.trade.status, STATUS.COMPLETED);
      assert.equal(pairResult.trade.tradeType, 'paired');
      assert.equal(pairResult.trade.buySize, 0.004);
      assert.equal(pairResult.trade.buyOrderId, recoveryBuyOrderId);
      assert.equal(pairResult.trade.sellOrderId, 'sell-1');
    });

    // Issue #726 codex review follow-up: the promotion above must not
    // resurrect a record the operator explicitly dismissed. Dedup should
    // treat DISMISSED the same as COMPLETED — a terminal state, not a
    // pending one to promote.
    it('does not resurrect a DISMISSED recovery trade back to completed', async () => {
      const recoveryBuyFills = [makeFill({ tradeId: 'recovery-buy-2', side: 'buy', price: 91000, size: 0.004 })];
      const adapter = createFakeAdapter({
        fillsByOrder: { 'sell-1': sellFills, 'recovery-1': recoveryBuyFills },
      });
      const importer = createImporter({ adapter });

      const sellResult = await importer.importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '91000' });
      const recoveryBuyOrderId = sellResult.trade.buyOrderId;
      store.dismiss(sellResult.trade.id);
      assert.equal(store.getById(sellResult.trade.id).status, STATUS.DISMISSED);

      const pairResult = await importer.importPair({ buyOrderId: recoveryBuyOrderId, sellOrderId: 'sell-1' });

      assert.equal(pairResult.success, true);
      assert.equal(store.getAll().length, 1, 'no second record was created');
      assert.equal(pairResult.trade.id, sellResult.trade.id);
      assert.equal(pairResult.trade.status, STATUS.DISMISSED, 'a dismissed trade must stay dismissed, not be promoted to completed');
    });

    // Issue #1802: a paired import claims both whole orders. A changed
    // counterpart used to succeed, re-link the buy's ledger rows to the new
    // sell and add a second completed record sharing an order.
    describe('whole-order ownership (#1802)', () => {
      const legs = {
        'buy-1': [makeFill({ tradeId: 'own-buy-1', side: 'buy', price: 90000, size: 0.004 })],
        'buy-2': [makeFill({ tradeId: 'own-buy-2', side: 'buy', price: 91000, size: 0.004 })],
        'sell-1': [makeFill({ tradeId: 'own-sell-1', side: 'sell', price: 100000, size: 0.004 })],
        'sell-2': [makeFill({ tradeId: 'own-sell-2', side: 'sell', price: 101000, size: 0.004 })],
      };
      const sellOrder = { status: 'FILLED', side: 'sell' };
      const orders = { 'sell-1': sellOrder, 'sell-2': sellOrder };

      /** Durable snapshot: what a restart would read back. */
      const durable = () => ({
        trades: readManualTradesFile()?.trades || [],
        dismissed: readManualTradesFile()?.dismissedFillOrderIds || [],
        ledger: JSON.parse(JSON.stringify(fillLedger.getAllFills())),
      });

      it('rejects reusing a paired buy with a different sell and keeps the original link', async () => {
        const importer = createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) });
        const first = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });
        assert.equal(first.success, true);
        const before = durable();

        const second = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-2' });

        assert.equal(second.success, false);
        assert.match(second.error, /Buy order buy-1 already belongs to manual trade/);
        assert.deepEqual(durable(), before, 'no ledger or store state changed');
        assert.equal(fillLedger.getFillsForOrder('buy-1')[0].sellOrderId, 'sell-1');
        assert.deepEqual(fillLedger.getFillsForOrder('sell-2'), []);
        assert.equal(store.isFillDismissed('sell-2'), false);
      });

      it('rejects reusing a paired sell with a different buy without ingesting it', async () => {
        const importer = createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) });
        assert.equal((await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' })).success, true);
        const before = durable();

        const second = await importer.importPair({ buyOrderId: 'buy-2', sellOrderId: 'sell-1' });

        assert.equal(second.success, false);
        assert.match(second.error, /Sell order sell-1 already belongs to manual trade/);
        assert.deepEqual(durable(), before);
        assert.deepEqual(fillLedger.getFillsForOrder('buy-2'), []);
        assert.equal(store.isFillDismissed('buy-2'), false);
      });

      it('rejects a buy the ledger already links to another sell even with no manual record', async () => {
        fillLedger.ingestFill({ ...legs['buy-1'][0], orderId: 'buy-1', fee_asset: 'USDC' }, null, { cycleId: null });
        fillLedger.annotateFillsByOrderId('buy-1', { sellOrderId: 'engine-tp-1' });
        const adapter = createFakeAdapter({ fillsByOrder: legs, orders });

        const result = await createImporter({ adapter }).importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

        assert.equal(result.success, false);
        assert.match(result.error, /already linked to sell engine-tp-1/);
        assert.equal(fillLedger.getFillsForOrder('buy-1')[0].sellOrderId, 'engine-tp-1');
        assert.deepEqual(adapter.calls.getOrderFills, [], 'a known conflict fails before any exchange read');
        assert.equal(store.getAll().length, 0);
      });

      it('rejects a sell the engine already booked against a body', async () => {
        fillLedger.ingestFill({ ...legs['sell-1'][0], orderId: 'sell-1', fee_asset: 'USDC' }, null, { cycleId: null });
        fillLedger.annotateFillsByOrderId('sell-1', { bodyId: 'body-9', bodyPnl: 12.5 });

        const result = await createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) })
          .importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

        assert.equal(result.success, false);
        assert.match(result.error, /already booked by the engine against body body-9/);
        assert.deepEqual(fillLedger.getFillsForOrder('buy-1'), []);
        assert.equal(store.getAll().length, 0);
      });

      it('rejects a buy owned by a buy-first body import', async () => {
        const importer = createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }), injectBody: null });
        assert.equal((await importer.importBuy({ buyOrderId: 'buy-1', createBody: true })).success, true);
        const before = durable();

        const result = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

        assert.equal(result.success, false);
        assert.match(result.error, /Buy order buy-1 already belongs to manual trade/);
        assert.deepEqual(durable(), before);
        assert.equal(readRegimeStateFile().position.celestialBodies.length, 1);
      });

      it('rejects a buy owned only by a persisted engine body', async () => {
        const { loadFundRegimeState, saveFundRegimeState } = require('../src/state-tracker');
        const saved = loadFundRegimeState(EXCHANGE, PAIR);
        saved.position.celestialBodies = [{ id: 'engine-body', sourceOrderIds: ['buy-1'], buyOrders: [], tpOrderId: null }];
        saveFundRegimeState(EXCHANGE, PAIR, saved);

        const result = await createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) })
          .importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

        assert.equal(result.success, false);
        assert.match(result.error, /Celestial body engine-body already owns buy buy-1/);
        assert.equal(fillLedger.getFillCount(), 0);
        assert.equal(store.getAll().length, 0);
      });

      it('rejects pairing a pending sell-first recovery with another order', async () => {
        const importer = createImporter({
          adapter: createFakeAdapter({ fillsByOrder: { ...legs, 'recovery-1': legs['buy-2'] }, orders }),
        });
        const sold = await importer.importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '91000' });
        assert.equal(sold.trade.status, STATUS.BUY_PENDING);
        const before = durable();

        const otherBuy = await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });
        const otherSell = await importer.importPair({ buyOrderId: 'recovery-1', sellOrderId: 'sell-2' });

        assert.equal(otherBuy.success, false);
        assert.match(otherBuy.error, /Sell order sell-1 already belongs to manual trade/);
        assert.equal(otherSell.success, false);
        assert.match(otherSell.error, /Buy order recovery-1 already belongs to manual trade/);
        assert.deepEqual(durable(), before);
        assert.equal(store.getById(sold.trade.id).status, STATUS.BUY_PENDING);
      });

      it('settles concurrent conflicting pairs with exactly one owner', async () => {
        // Every fetch yields, so the three requests interleave unless locked.
        const base = createFakeAdapter({ fillsByOrder: legs, orders });
        const adapter = {
          ...base,
          getOrderFills: async (orderId) => { await sleepTick(); return base.getOrderFills(orderId); },
          getOrder: async (orderId) => { await sleepTick(); return base.getOrder(orderId); },
        };
        const importer = createImporter({ adapter });

        const results = await Promise.all([
          importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' }),
          importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-2' }),
          importer.importPair({ buyOrderId: 'buy-2', sellOrderId: 'sell-1' }),
        ]);

        assert.deepEqual(results.map((r) => r.success), [true, false, false]);
        assert.equal(store.getAll().length, 1);
        assert.equal(fillLedger.getFillsForOrder('buy-1')[0].sellOrderId, 'sell-1');
        assert.deepEqual(fillLedger.getFillsForOrder('buy-2'), []);
        assert.deepEqual(fillLedger.getFillsForOrder('sell-2'), []);
      });

      it('settles pairs that take the same ids in opposite roles without deadlock', async () => {
        const base = createFakeAdapter({ fillsByOrder: legs, orders });
        const adapter = { ...base, getOrderFills: async (orderId) => { await sleepTick(); return base.getOrderFills(orderId); } };
        const importer = createImporter({ adapter });

        // buy:buy-1 + sell:sell-1 and buy:sell-1 + sell:buy-1 share no lock,
        // and a third pair queues behind the first on both of its keys.
        const results = await Promise.all([
          importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' }),
          importer.importPair({ buyOrderId: 'sell-1', sellOrderId: 'buy-1' }),
          importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' }),
        ]);

        assert.equal(results[0].success, true);
        assert.equal(results[1].success, false, 'swapped roles fail identity checks');
        assert.equal(results[2].success, true, 'the exact retry is idempotent');
        assert.equal(results[2].trade.id, results[0].trade.id);
        assert.equal(store.getAll().length, 1);
      });

      it('retries the exact pair after the store write was lost, without a duplicate', async () => {
        const importer = createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) });
        assert.equal((await importer.importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' })).success, true);

        // Simulate a crash after the ledger persisted but before the store
        // did: the ledger keeps buy-1 -> sell-1, manual-trades.json is gone.
        fs.rmSync(path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'manual-trades.json'));
        const { createManualTradeStore } = require('../src/manual-trades');
        store = createManualTradeStore(EXCHANGE, PAIR);
        store.load();

        const retried = await createImporter({ adapter: createFakeAdapter({ fillsByOrder: legs, orders }) })
          .importPair({ buyOrderId: 'buy-1', sellOrderId: 'sell-1' });

        assert.equal(retried.success, true);
        assert.equal(readManualTradesFile().trades.length, 1);
        assert.equal(fillLedger.getFillsForOrder('buy-1').length, 1);
        assert.equal(fillLedger.getFillsForOrder('buy-1')[0].sellOrderId, 'sell-1');
      });
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

    it('settles a zero-fill cancelled buy as terminal without mutating the ledger (#1034)', async () => {
      const adapter = createFakeAdapter({ fillsByOrder: { 'sell-1': sellFills } });
      const tradeId = await seedPendingTrade(adapter);
      const buyOrderId = store.getById(tradeId).buyOrderId;
      const fillCountBefore = fillLedger.getFillCount();

      const cancelAdapter = createFakeAdapter({
        orders: { [buyOrderId]: { status: 'CANCELLED', completionPercentage: 0, filledSize: 0 } },
      });
      const result = await createImporter({ adapter: cancelAdapter }).checkPendingBuy({ tradeId });

      assert.equal(result.success, true);
      assert.equal(result.cancelled, true);
      assert.equal(result.remainingSize, 0.003);
      assert.equal(fillLedger.getFillCount(), fillCountBefore);
      // Executions are reconciled from the order's own fills before deciding.
      assert.deepEqual(cancelAdapter.calls.getOrderFills, [buyOrderId]);
      const trade = store.getById(tradeId);
      assert.equal(trade.status, STATUS.BUY_CANCELLED);
      assert.equal(trade.buyOrderId, buyOrderId, 'the terminal order id is retained as history');
      assert.equal(trade.recoveryAttempts.length, 1);
      assert.equal(trade.recoveryAttempts[0].outcome, 'cancelled');
      assert.equal(trade.recoveryAttempts[0].exchangeStatus, 'CANCELLED');
      assert.match(trade.lastCheck.message, /no executions/);
      // A terminal order needs no orphan protection any more.
      assert.equal(store.getPendingBuyOrderIds().has(buyOrderId), false);
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
  // Terminal recovery attempts and their continuation (issue #1034)
  // -----------------------------------------------------------------------
  describe('recovery after a terminal buy (#1034)', () => {
    const sellFills = [makeFill({ tradeId: 'rec-sell-1', side: 'sell', price: 100000, size: 0.003 })];
    const tick = () => new Promise((r) => setImmediate(r));

    /** Reload the store from disk, as a gateway/engine restart would. */
    const reloadStore = () => {
      const { createManualTradeStore } = require('../src/manual-trades');
      store = createManualTradeStore(EXCHANGE, PAIR);
      store.load();
      return store;
    };

    /**
     * Fake exchange whose order book is mutable per test: `orders[id]` is what
     * getOrder reports and `fills[id]` what getOrderFills returns.
     */
    const createExchange = () => {
      const orders = {};
      const fills = { 'sell-1': sellFills };
      const adapter = createFakeAdapter({ fillsByOrder: fills, orders });
      return { adapter, orders, fills };
    };

    /** Import the sell, place its recovery buy, and have the exchange cancel it. */
    const seedCancelled = async (ex, { executed = [] } = {}) => {
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      assert.equal(imported.success, true);
      const buyOrderId = imported.trade.buyOrderId;
      const filledSize = executed.reduce((sum, f) => sum + f.size, 0);
      ex.orders[buyOrderId] = { status: 'CANCELLED', completionPercentage: (filledSize / 0.003) * 100, filledSize };
      ex.fills[buyOrderId] = executed;
      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId: imported.trade.id });
      assert.equal(checked.success, true);
      return { tradeId: imported.trade.id, buyOrderId, checked };
    };

    it('keeps a zero-fill cancelled recovery terminal and recoverable across a cold reload', async () => {
      const ex = createExchange();
      const { tradeId, buyOrderId } = await seedCancelled(ex);

      reloadStore();
      const trade = store.getById(tradeId);
      assert.equal(trade.status, STATUS.BUY_CANCELLED);
      assert.equal(trade.recoveryAttempts[0].orderId, buyOrderId);
      assert.equal(trade.recoveryAttempts[0].outcome, 'cancelled');

      // Checking again neither re-polls the dead order nor changes the record.
      const again = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(again.message, 'No pending buy to check');
      assert.equal(store.getById(tradeId).status, STATUS.BUY_CANCELLED);
    });

    it('finishes the same trade through Retry recovery without re-importing the sell', async () => {
      const ex = createExchange();
      const { tradeId, buyOrderId } = await seedCancelled(ex);
      reloadStore();
      const sellRowsBefore = fillLedger.getFillsForOrder('sell-1').length;

      // Replaying the original import still never places a second order...
      const replay = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      assert.equal(replay.success, true);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1);
      // ...and relinking through it points the operator at the row action.
      const relink = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', existingBuyOrderId: 'other' });
      assert.equal(relink.success, false);
      assert.match(relink.error, /Link replacement/);

      const retried = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
      assert.equal(retried.success, true);
      assert.equal(retried.placed, true);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 2);
      assert.equal(ex.adapter.calls.placeLimitBuy[1].size, 0.003);
      assert.equal(ex.adapter.calls.placeLimitBuy[1].price, 94000);
      const newBuy = retried.trade.buyOrderId;
      assert.notEqual(newBuy, buyOrderId);
      assert.equal(retried.trade.status, STATUS.BUY_PENDING);
      assert.deepEqual(retried.trade.recoveryAttempts.map((a) => [a.orderId, a.outcome]), [[buyOrderId, 'cancelled'], [newBuy, null]]);
      assert.equal(store.getPendingBuyOrderIds().has(newBuy), true);

      ex.orders[newBuy] = { status: 'FILLED', completionPercentage: 100, filledSize: 0.003 };
      ex.fills[newBuy] = [makeFill({ tradeId: 'rec-buy-2', price: 94000, size: 0.003 })];
      const done = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(done.success, true);
      assert.equal(done.trade.status, STATUS.COMPLETED);
      assert.equal(done.trade.buySize, 0.003);
      assert.equal(done.trade.buyPrice, 94000);
      assert.equal(store.getAll().length, 1, 'still one trade — the sell was never duplicated');
      assert.equal(fillLedger.getFillsForOrder('sell-1').length, sellRowsBefore);
      assert.equal(fillLedger.getFillsForOrder(newBuy)[0].sellOrderId, 'sell-1');
    });

    describe('durable intent on Retry recovery (#1058)', () => {
      /** Exchange book keyed by client order id, fed by accepted placements. */
      const withClientIdBook = (ex) => {
        const book = new Map();
        const basePlace = ex.adapter.placeLimitBuy;
        ex.adapter.placeLimitBuy = async (...args) => {
          const result = await basePlace(...args);
          if (result?.success) book.set(args[3].clientOrderId, { orderId: result.orderId, status: 'OPEN', filledSize: 0 });
          return result;
        };
        ex.adapter.lookups = [];
        ex.adapter.findOrderByClientOrderId = async (clientOrderId) => {
          ex.adapter.lookups.push(clientOrderId);
          return book.get(clientOrderId) || null;
        };
        return book;
      };

      it('never places a second replacement after a crash between acceptance and record', async () => {
        const ex = createExchange();
        withClientIdBook(ex);
        const { tradeId } = await seedCancelled(ex);

        store.recordRecoveryBuy = () => { throw new Error('simulated crash'); };
        await assert.rejects(() => createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 }), /simulated crash/);
        assert.equal(ex.adapter.calls.placeLimitBuy.length, 2);
        reloadStore();
        const crashed = store.getById(tradeId);
        assert.equal(crashed.status, STATUS.BUY_CANCELLED, 'the restart sees only the cancelled attempt');
        assert.equal(crashed.recoveryIntent.clientOrderId, recoveryClientOrderId(tradeId, 2));
        assert.equal(ex.adapter.calls.placeLimitBuy[1].options.clientOrderId, crashed.recoveryIntent.clientOrderId);

        const retry = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
        assert.equal(retry.success, false);
        assert.match(retry.error, /still active or unconfirmed/);
        assert.equal(ex.adapter.calls.placeLimitBuy.length, 2, 'no second replacement');
        const adopted = store.getById(tradeId);
        assert.equal(adopted.status, STATUS.BUY_PENDING);
        assert.equal(adopted.buyOrderId, 'recovery-2');
        assert.equal(adopted.recoveryIntent, null);
        assert.deepEqual(adopted.recoveryAttempts.map((a) => [a.orderId, a.outcome]), [['recovery-1', 'cancelled'], ['recovery-2', null]]);
      });

      it('adopts a thrown replacement whose order actually landed', async () => {
        const ex = createExchange();
        withClientIdBook(ex);
        const { tradeId } = await seedCancelled(ex);
        const basePlace = ex.adapter.placeLimitBuy;
        ex.adapter.placeLimitBuy = async (...args) => { await basePlace(...args); throw new Error('socket hang up'); };

        const retried = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
        assert.equal(retried.success, true);
        assert.equal(retried.trade.buyOrderId, 'recovery-2');
        assert.equal(retried.trade.status, STATUS.BUY_PENDING);
        assert.equal(ex.adapter.calls.placeLimitBuy.length, 2);
        assert.equal(ex.adapter.calls.placeLimitBuy[1].size, 0.003, 'sized to the uncovered remainder');

        const again = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
        assert.equal(again.success, false);
        assert.equal(ex.adapter.calls.placeLimitBuy.length, 2);
      });

      it('keeps Retry and Link blocked while the lookup fails, and releases on a positive not-found', async () => {
        const ex = createExchange();
        const { tradeId } = await seedCancelled(ex);
        ex.adapter.placeLimitBuy = async (productId, size, price, options) => {
          ex.adapter.calls.placeLimitBuy.push({ productId, size, price, options });
          throw new Error('ECONNRESET');
        };
        ex.adapter.findOrderByClientOrderId = async () => { throw new Error('503 Service Unavailable'); };

        const first = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
        assert.equal(first.success, false);
        assert.match(first.error, /lookup failed \(503 Service Unavailable\)/);
        reloadStore();
        assert.ok(store.getById(tradeId).recoveryIntent);
        assert.match(store.getById(tradeId).lastCheck.error, /No new buy will be placed/);

        const retry = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
        assert.equal(retry.success, false);
        ex.orders['manual-replacement'] = { side: 'BUY', productId: 'BTC-USDC', status: 'OPEN', filledSize: 0, completionPercentage: 0 };
        const link = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'manual-replacement' });
        assert.equal(link.success, false);
        assert.match(link.error, /may already be on the exchange/);
        assert.equal(ex.adapter.calls.placeLimitBuy.length, 2, 'only the original and the ambiguous replacement');
        assert.equal(store.getById(tradeId).status, STATUS.BUY_CANCELLED);

        ex.adapter.findOrderByClientOrderId = async () => null;
        const linked = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'manual-replacement' });
        assert.equal(linked.success, true);
        assert.equal(linked.trade.buyOrderId, 'manual-replacement');
        assert.equal(linked.trade.recoveryIntent, null);
      });
    });

    it('ingests a cancelled partial execution once and replaces only the remainder', async () => {
      const ex = createExchange();
      const partial = [makeFill({ tradeId: 'rec-part-1', price: 95000, size: 0.001 })];
      const { tradeId, buyOrderId, checked } = await seedCancelled(ex, { executed: partial });

      assert.equal(checked.cancelled, true);
      assert.equal(checked.recoveredSize, 0.001);
      assert.equal(checked.remainingSize, 0.002);
      const partialRows = fillLedger.getFillsForOrder(buyOrderId);
      assert.equal(partialRows.length, 1);
      assert.equal(partialRows[0].sellOrderId, 'sell-1', 'partial recovery closes part of the sell');
      assert.equal(store.getById(tradeId).status, STATUS.BUY_CANCELLED);

      // A repeated check and a reload never ingest the partial twice.
      await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      reloadStore();
      assert.equal(fillLedger.getFillsForOrder(buyOrderId).length, 1);

      const retried = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: '96000' });
      assert.equal(retried.success, true);
      assert.equal(ex.adapter.calls.placeLimitBuy[1].size, 0.002);

      const newBuy = retried.trade.buyOrderId;
      ex.orders[newBuy] = { status: 'FILLED', completionPercentage: 100, filledSize: 0.002 };
      ex.fills[newBuy] = [makeFill({ tradeId: 'rec-part-2', price: 96000, size: 0.002 })];
      const done = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(done.trade.status, STATUS.COMPLETED);
      assert.ok(Math.abs(done.trade.buySize - 0.003) < 1e-12);
      assert.ok(Math.abs(done.trade.buyPrice - (95000 * 0.001 + 96000 * 0.002) / 0.003) < 1e-6);
      assert.deepEqual(done.trade.buyFillTradeIds, ['rec-part-1', 'rec-part-2']);
    });

    it('completes the trade when a cancelled order had already recovered the full quantity', async () => {
      const ex = createExchange();
      const { tradeId, checked } = await seedCancelled(ex, { executed: [makeFill({ tradeId: 'rec-full', price: 95000, size: 0.003 })] });
      assert.equal(checked.completed, true);
      assert.equal(store.getById(tradeId).status, STATUS.COMPLETED);
      const retry = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 1 });
      assert.equal(retry.success, false);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1);
    });

    it('keeps a cancellation whose executions are not yet visible pending, and blocks a retry', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const { id: tradeId, buyOrderId } = imported.trade;
      ex.orders[buyOrderId] = { status: 'CANCELLED', completionPercentage: 33, filledSize: 0.001 };
      ex.fills[buyOrderId] = [];

      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(checked.success, false);
      assert.match(checked.error, /only 0 is visible/);
      assert.equal(fillLedger.getFillsForOrder(buyOrderId).length, 0);
      const trade = store.getById(tradeId);
      assert.equal(trade.status, STATUS.BUY_PENDING);
      assert.equal(trade.buyOrderId, buyOrderId);
      assert.match(trade.lastCheck.error, /only 0 is visible/);

      const retry = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 95000 });
      assert.equal(retry.success, false);
      assert.match(retry.error, /still active or unconfirmed/);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1);
    });

    it('keeps a cancellation pending when only its completion percentage reports executions', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const { id: tradeId, buyOrderId } = imported.trade;
      ex.orders[buyOrderId] = { status: 'CANCELLED', completionPercentage: 40 };
      ex.fills[buyOrderId] = [];

      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(checked.success, false);
      assert.match(checked.error, /0.0012 executed, but only 0 is visible/);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);

      // Once the executions surface, the same check settles the true remainder.
      ex.fills[buyOrderId] = [makeFill({ tradeId: 'late-1', price: 95000, size: 0.0012 })];
      const settled = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(settled.cancelled, true);
      assert.equal(settled.remainingSize, 0.0018);
    });

    it('keeps a percentage-only cancellation pending while some of its executions are still hidden', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const { id: tradeId, buyOrderId } = imported.trade;
      // 40% of the 0.003 placed = 0.0012 executed, but only 0.0006 is visible.
      ex.orders[buyOrderId] = { status: 'CANCELLED', completionPercentage: 40 };
      ex.fills[buyOrderId] = [makeFill({ tradeId: 'half-1', price: 95000, size: 0.0006 })];

      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(checked.success, false);
      assert.match(checked.error, /only 0.0006 is visible/);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);
      assert.equal(fillLedger.getFillsForOrder(buyOrderId).length, 0);
    });

    it('preserves the association and surfaces a failed status lookup', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const failing = { ...ex.adapter, getOrder: async () => { throw new Error('503 upstream'); } };

      const checked = await createImporter({ adapter: failing }).checkPendingBuy({ tradeId: imported.trade.id });
      assert.equal(checked.success, false);
      assert.match(checked.error, /503 upstream/);
      reloadStore();
      const trade = store.getById(imported.trade.id);
      assert.equal(trade.status, STATUS.BUY_PENDING);
      assert.equal(trade.buyOrderId, imported.trade.buyOrderId);
      assert.match(trade.lastCheck.error, /503 upstream/);
    });

    it('refuses to replace an attempt that is still open on the exchange', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const retry = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId: imported.trade.id, existingBuyOrderId: 'other-buy' });
      assert.equal(retry.success, false);
      assert.match(retry.error, /still active or unconfirmed/);
      assert.deepEqual(ex.adapter.calls.getOrder, []);
      assert.equal(store.getById(imported.trade.id).buyOrderId, imported.trade.buyOrderId);
    });

    it('places one replacement across concurrent retry requests', async () => {
      const ex = createExchange();
      const { tradeId } = await seedCancelled(ex);
      let release;
      const gate = new Promise((r) => { release = r; });
      const basePlace = ex.adapter.placeLimitBuy;
      ex.adapter.placeLimitBuy = async (...args) => { const r = await basePlace(...args); await gate; return r; };

      const p1 = createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
      while (ex.adapter.calls.placeLimitBuy.length < 2) await tick();
      const p2 = createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
      const p3 = createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'manual-buy' });
      for (let i = 0; i < 5; i++) await tick();
      release();
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      assert.equal(r1.success, true);
      assert.equal(r2.success, false);
      assert.equal(r3.success, false);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 2, 'seed placement + exactly one replacement');
      assert.equal(store.getById(tradeId).recoveryAttempts.length, 2);
    });

    it('links a validated replacement and refuses invalid ones without changing the record', async () => {
      const ex = createExchange();
      const { tradeId, buyOrderId } = await seedCancelled(ex);
      const retry = (existingBuyOrderId) => createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId });

      const reused = await retry(buyOrderId);
      assert.match(reused.error, /already used by this recovery/);

      const buy = (extra) => ({ side: 'BUY', productId: 'BTC-USDC', status: 'OPEN', filledSize: 0, ...extra });
      ex.orders['wrong-side'] = buy({ side: 'SELL' });
      assert.match((await retry('wrong-side')).error, /a SELL order; only a buy/);

      ex.orders['no-side'] = buy({ side: undefined });
      assert.match((await retry('no-side')).error, /not verifiably a buy/);

      ex.orders['other-asset'] = buy({ productId: 'ETH-USDC' });
      assert.match((await retry('other-asset')).error, /for ETH-USDC, not this fund's BTC-USDC/);

      ex.orders['no-product'] = buy({ productId: '' });
      assert.match((await retry('no-product')).error, /an unreported product/);

      ex.orders['dead'] = buy({ status: 'EXPIRED' });
      assert.match((await retry('dead')).error, /already EXPIRED with no executions/);

      ex.orders['too-big'] = buy({ filledSize: 0.004 });
      assert.match((await retry('too-big')).error, /more than the 0.003 still to recover/);

      // 0.001 executed at 25% reveals a 0.004 order — it would over-recover.
      ex.orders['too-big-open'] = buy({ status: 'PARTIALLY_FILLED', filledSize: 0.001, completionPercentage: 25 });
      assert.match((await retry('too-big-open')).error, /is for 0.004, more than the 0.003/);

      const failing = { ...ex.adapter, getOrder: async () => { throw new Error('timeout'); } };
      const unchecked = await createImporter({ adapter: failing }).retryRecovery({ tradeId, existingBuyOrderId: 'any' });
      assert.match(unchecked.error, /Could not validate replacement buy any: timeout/);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_CANCELLED);
      assert.equal(store.getById(tradeId).buyOrderId, buyOrderId);

      // Gemini reports a USDC fund's order on its USD symbol.
      ex.orders['manual-buy'] = buy({ productId: 'btcusd' });
      const linked = await createImporter({ exchange: 'gemini', adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'manual-buy' });
      assert.equal(linked.success, true);
      assert.equal(linked.linked, true);
      assert.equal(linked.trade.status, STATUS.BUY_PENDING);
      assert.equal(linked.trade.buyOrderId, 'manual-buy');
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1, 'linking never places an order');
    });

    it('rejects a Coinbase replacement with a different quote before recording a pending link', async () => {
      const ex = createExchange();
      const { tradeId } = await seedCancelled(ex);
      ex.orders['usd-buy'] = { side: 'BUY', productId: 'BTC-USD', status: 'OPEN', filledSize: 0 };
      const beforeTrade = structuredClone(store.getById(tradeId));
      const beforeDisk = readManualTradesFile();
      const beforeFills = structuredClone(fillLedger.getAllFills());

      const result = await createImporter({ exchange: 'coinbase', adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'usd-buy' });

      assert.equal(result.success, false);
      assert.match(result.error, /for BTC-USD, not this fund's BTC-USDC/);
      assert.deepEqual(store.getById(tradeId), beforeTrade, 'the invalid order never becomes the pending recovery');
      assert.deepEqual(readManualTradesFile(), beforeDisk, 'the rejected link does not write recovery state');
      assert.deepEqual(fillLedger.getAllFills(), beforeFills);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1, 'only the seed recovery was placed');
    });

    it('refuses to link an order another manual trade already owns', async () => {
      const ex = createExchange();
      ex.fills['sell-2'] = [makeFill({ tradeId: 'rec-sell-2', side: 'sell', size: 0.001 })];
      await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-2', existingBuyOrderId: 'owned-buy' });
      ex.orders['owned-buy'] = { side: 'BUY', productId: 'BTC-USDC', status: 'OPEN', filledSize: 0 };
      const { tradeId } = await seedCancelled(ex);
      const result = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'owned-buy' });
      assert.equal(result.success, false);
      assert.match(result.error, /already belongs to manual trade/);
    });

    it('lets only one of two sells racing to link the same replacement claim it', async () => {
      const ex = createExchange();
      ex.fills['sell-2'] = [makeFill({ tradeId: 'rec-sell-2', side: 'sell', size: 0.003 })];
      const { tradeId: first } = await seedCancelled(ex);
      const second = (await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-2', existingBuyOrderId: 'dead-2' })).trade.id;
      ex.orders['dead-2'] = { status: 'CANCELLED', filledSize: 0 };
      ex.fills['dead-2'] = [];
      await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId: second });
      assert.equal(store.getById(second).status, STATUS.BUY_CANCELLED);

      // Both lookups are in flight before either links (different sell locks).
      ex.orders['shared-buy'] = { side: 'BUY', productId: 'BTC-USDC', status: 'OPEN', filledSize: 0 };
      let release;
      const gate = new Promise((r) => { release = r; });
      const baseGetOrder = ex.adapter.getOrder;
      let waiting = 0;
      ex.adapter.getOrder = async (id) => { const o = await baseGetOrder(id); waiting++; await gate; return o; };
      const p1 = createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId: first, existingBuyOrderId: 'shared-buy' });
      const p2 = createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId: second, existingBuyOrderId: 'shared-buy' });
      while (waiting < 2) await tick();
      release();
      const results = await Promise.all([p1, p2]);

      assert.deepEqual(results.map((r) => r.success).sort(), [false, true]);
      assert.match(results.find((r) => !r.success).error, /already belongs to manual trade/);
      assert.equal(store.getAll().filter((t) => t.buyOrderId === 'shared-buy').length, 1);
    });

    it('keeps a filled linked replacement that covers only part of the remainder recoverable', async () => {
      const ex = createExchange();
      const { tradeId } = await seedCancelled(ex);
      ex.orders['small-buy'] = { side: 'BUY', productId: 'BTC-USDC', status: 'OPEN', filledSize: 0 };
      await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, existingBuyOrderId: 'small-buy' });

      ex.orders['small-buy'] = { side: 'BUY', status: 'FILLED', completionPercentage: 100, filledSize: 0.001 };
      ex.fills['small-buy'] = [makeFill({ tradeId: 'small-1', price: 95000, size: 0.001 })];
      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(checked.success, true);
      assert.equal(checked.remainingSize, 0.002);
      const trade = store.getById(tradeId);
      assert.equal(trade.status, STATUS.BUY_CANCELLED);
      assert.equal(trade.recoveryAttempts[1].outcome, 'filled');

      const retried = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId, recoveryBuyPrice: 94000 });
      assert.equal(retried.success, true);
      assert.equal(ex.adapter.calls.placeLimitBuy.at(-1).size, 0.002);
    });

    it('keeps a filled order pending while its executions are not fully visible', async () => {
      const ex = createExchange();
      const imported = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '95000' });
      const { id: tradeId, buyOrderId } = imported.trade;
      ex.orders[buyOrderId] = { status: 'FILLED', completionPercentage: 100, filledSize: 0.003 };
      ex.fills[buyOrderId] = [makeFill({ tradeId: 'vis-1', price: 95000, size: 0.001 })];

      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(checked.success, false);
      assert.match(checked.error, /only 0.001 is visible/);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);
      assert.equal(fillLedger.getFillsForOrder(buyOrderId).length, 0);
    });

    it('validates retry input before touching the store or exchange', async () => {
      const ex = createExchange();
      const { tradeId } = await seedCancelled(ex);
      const importer = createImporter({ adapter: ex.adapter });
      const getOrderCalls = ex.adapter.calls.getOrder.length;
      assert.match((await importer.retryRecovery({ tradeId })).error, /exactly one/);
      assert.match((await importer.retryRecovery({ tradeId, recoveryBuyPrice: 1, existingBuyOrderId: 'x' })).error, /exactly one/);
      assert.equal((await importer.retryRecovery({ tradeId, recoveryBuyPrice: 'abc' })).error, 'Invalid recoveryBuyPrice');
      assert.equal((await importer.retryRecovery({ tradeId, recoveryBuyPrice: -1 })).error, 'Invalid recoveryBuyPrice');
      assert.match((await importer.retryRecovery({ tradeId: 'nope', recoveryBuyPrice: 1 })).error, /not found/);
      assert.equal(ex.adapter.calls.getOrder.length, getOrderCalls);
      assert.equal(ex.adapter.calls.placeLimitBuy.length, 1);
    });

    it('re-linking the same order through importSell does not reopen a settled attempt', async () => {
      const ex = createExchange();
      await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', existingBuyOrderId: 'linked-1' });
      ex.orders['linked-1'] = { status: 'CANCELLED', filledSize: 0 };
      ex.fills['linked-1'] = [];
      const tradeId = store.getAll()[0].id;
      await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId });
      assert.equal(store.getById(tradeId).status, STATUS.BUY_CANCELLED);

      const replay = await createImporter({ adapter: ex.adapter }).importSell({ sellOrderId: 'sell-1', existingBuyOrderId: 'linked-1' });
      assert.equal(replay.success, true);
      assert.equal(replay.trade.status, STATUS.BUY_CANCELLED);
      assert.equal(replay.trade.recoveryAttempts.length, 1);
    });

    it('upgrades a pre-#1034 pending record on load so it can be settled and retried', async () => {
      const dir = migration.resolveFundDataDir(EXCHANGE, PAIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manual-trades.json'), JSON.stringify({
        trades: [{
          id: 'legacy-1', sellOrderId: 'sell-1', sellPrice: 100000, sellSize: 0.003, sellQuoteAmount: 300,
          sellTimestamp: 1, sellFillTradeIds: ['rec-sell-1'], buyOrderId: 'old-buy', buyPrice: 95000, buySize: 0.003,
          buyPlacedAt: 2, buyFilledAt: null, buyFillTradeIds: [], status: 'buy_pending', tradeType: 'sell_first',
          bodyId: null, note: '', createdAt: 1, updatedAt: 2,
        }],
        dismissedFillOrderIds: [],
      }));
      reloadStore();
      assert.deepEqual(store.getById('legacy-1').recoveryAttempts.map((a) => [a.orderId, a.kind, a.outcome]), [['old-buy', 'placed', null]]);

      const ex = createExchange();
      ex.orders['old-buy'] = { status: 'EXPIRED', filledSize: 0 };
      const checked = await createImporter({ adapter: ex.adapter }).checkPendingBuy({ tradeId: 'legacy-1' });
      assert.equal(checked.cancelled, true);
      const retried = await createImporter({ adapter: ex.adapter }).retryRecovery({ tradeId: 'legacy-1', recoveryBuyPrice: 94000 });
      assert.equal(retried.success, true);
      assert.equal(ex.adapter.calls.placeLimitBuy[0].size, 0.003);
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

    // Issue #726: the top-of-function retry guard only checks whether a body
    // already exists for this buyOrderId — it never asks whether MORE of the
    // order has filled since. If the order was still filling when first
    // imported (body sized to the earlier partial fill set), a later retry
    // must extend the existing body with the newly-arrived fills instead of
    // treating them as already handled and dropping them.
    it('extends the existing body with fills that arrived since it was created, instead of dropping them (engine running)', async () => {
      const bodies = [];
      const extendCalls = [];
      const fillsByOrder = { 'buy-1': [buyFills[0]] }; // only the first fill known at first import
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          bodies.push(body);
          return { tpPlaced: true };
        },
        extendBody: (bodyId, totals, buyOrderId) => {
          extendCalls.push({ bodyId, totals, buyOrderId });
          const body = bodies.find((b) => b.id === bodyId);
          if (!body) return { success: false, error: 'Body not found' };
          // Converges the body to the FULL totals passed in — the real
          // extendBody's contract (issue #726, codex round 3): the caller
          // now passes the buy order's complete current totals, not a
          // delta, precisely so a retry can't double-count an
          // already-applied portion.
          body.assetQty = totals.assetQty;
          body.costBasis = totals.costBasis;
          return { success: true, bodyId, tier: body.tier };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].assetQty, buyFills[0].size);

      // More of the order filled since the first import.
      fillsByOrder['buy-1'] = buyFills;

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.alreadyImported, true);
      assert.equal(second.extended, true);
      assert.equal(bodies.length, 1, 'no second body was ever created');
      assert.equal(extendCalls.length, 1, 'extendBody must be called exactly once');
      assert.equal(extendCalls[0].bodyId, first.trade.bodyId);
      // extendBody now receives the FULL current total for buy-1 (both
      // fills), not just the delta — the fix for a round-3 review finding
      // where a delta-only idempotency check could double-count an
      // already-applied portion across a compounding retry.
      assert.ok(
        Math.abs(extendCalls[0].totals.assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9,
        'extendBody must receive the FULL current total, not just the new fill'
      );
      // costBasis must include BOTH fills' fees (0.5 + 0.25), not just
      // notional — a bug caught by review where extraFees read raw-fill
      // field names off already-ingested ledger rows and silently read
      // undefined, dropping the fee from cost basis on every extension.
      const expectedFullCostBasis = (buyFills[0].price * buyFills[0].size + buyFills[0].commission)
        + (buyFills[1].price * buyFills[1].size + buyFills[1].commission);
      assert.ok(
        Math.abs(extendCalls[0].totals.costBasis - expectedFullCostBasis) < 1e-9,
        'the full total cost basis must include both fills\' fees'
      );
      assert.ok(Math.abs(bodies[0].assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9, 'the body grew to include the new fill');
      // Both fill rows — old and new — must be linked to the body, not left
      // dangling (the whole point of this fix: no unmanaged, unlinked asset).
      const rows = fillLedger.getFillsForOrder('buy-1');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.bodyId, second.trade.bodyId);
        assert.equal(row.isBodyOwned, true);
      }
      // The trade record's own buy totals are refreshed to the FULL current
      // fill set, not left stuck at the partial amount known at creation.
      assert.equal(second.trade.buySize, buyFills[0].size + buyFills[1].size);
      assert.deepEqual(second.trade.buyFillTradeIds.slice().sort(), [buyFills[0].tradeId, buyFills[1].tradeId].sort());
    });

    // Issue #726 follow-up (self-review): a Collapse-All merge re-stamps a
    // buy order's ledger rows onto the SURVIVOR body's id
    // (regime-engine.js's mergeBodies path) without ever updating this trade
    // record's bodyId — so trade.bodyId can be stale relative to the
    // ledger's own bodyId after a merge. The extend logic must treat the
    // ledger's own bodyId as authoritative, never re-stamp already-linked
    // rows back onto the stale pre-merge id, and extend the CURRENT
    // (merged) body instead of a defunct one.
    it('uses the ledger\'s current bodyId, not the trade record\'s stale one, after a Collapse-All merge', async () => {
      const bodies = [{ id: 'body-merged', assetQty: 0.05, costBasis: 4500 }];
      const extendCalls = [];
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          bodies.push(body);
          return { tpPlaced: true };
        },
        extendBody: (bodyId, totals, buyOrderId) => {
          extendCalls.push({ bodyId, totals });
          const body = bodies.find((b) => b.id === bodyId);
          if (!body) return { success: false, error: 'Body not found' };
          // Mirrors the real extendBody's shortfall computation (issue #726,
          // codex round 3): only add what THIS buyOrderId isn't already
          // recorded for, so 'body-merged''s pre-existing, unrelated
          // 0.05/4500 from other sources is never touched or double-counted.
          body.buyOrders = body.buyOrders || [];
          const recorded = body.buyOrders.filter((bo) => bo.orderId === buyOrderId)
            .reduce((acc, bo) => ({ qty: acc.qty + bo.assetQty, cost: acc.cost + bo.sizeUsdc }), { qty: 0, cost: 0 });
          const shortfallQty = totals.assetQty - recorded.qty;
          if (shortfallQty <= 0.00000001) return { success: true, bodyId, tier: body.tier, alreadyApplied: true };
          const shortfallCost = totals.costBasis - recorded.cost;
          body.assetQty += shortfallQty;
          body.costBasis += shortfallCost;
          body.buyOrders.push({ orderId: buyOrderId, assetQty: shortfallQty, sizeUsdc: shortfallCost });
          return { success: true, bodyId, tier: body.tier };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const originalBodyId = first.trade.bodyId;
      assert.notEqual(originalBodyId, 'body-merged');

      // Simulate an operator Collapse-All merge absorbing the manually
      // imported body into 'body-merged' — this is exactly what
      // regime-engine's mergeBodies path does to the ledger, independent of
      // the manual-trades store record.
      fillLedger.annotateFillsByOrderId('buy-1', { bodyId: 'body-merged', bodyTier: 'planet' });
      fillLedger.persist();

      // More of the order filled since, and the trade record still points
      // at the pre-merge (now-defunct) body id.
      fillsByOrder['buy-1'] = buyFills;

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.extended, true);
      assert.equal(extendCalls.length, 1);
      assert.equal(extendCalls[0].bodyId, 'body-merged', 'must extend the CURRENT (merged) body, not the stale pre-merge id');

      // The pre-existing, already-linked fill row must still read
      // 'body-merged' — never reverted to the stale trade.bodyId.
      const rows = fillLedger.getFillsForOrder('buy-1');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.bodyId, 'body-merged', 'no row may be re-stamped onto the defunct pre-merge body id');
      }

      // The trade record itself is kept in sync with the merge too.
      assert.equal(second.trade.bodyId, 'body-merged');
      assert.equal(second.trade.buySize, buyFills[0].size + buyFills[1].size);
    });

    // Codex delta review (round 4): a ledger row's bodyId is NOT a durable
    // "already reconciled" signal on its own — placeBodyTp's TP-placement
    // annotation, the startup re-annotator, and Collapse-All's re-stamp
    // (regime-engine.js) all blanket-stamp bodyId onto EVERY row for an
    // orderId once a body exists for it, including a fill that arrived
    // AFTER the body's assetQty was last actually grown (a slow out-of-band
    // ingest, e.g. sync-fills). The OLD "unlinked ledger rows" gate would
    // have taken the fast path here and hidden the gap for good. The gate
    // must instead be trade.buySize (refreshed only on a CONFIRMED
    // reconciliation) vs the ledger's current full fill total.
    it('detects growth even when every ledger row already carries a bodyId from an unrelated process', async () => {
      const bodies = [];
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          bodies.push(body);
          return { tpPlaced: true };
        },
        extendBody: (bodyId, totals) => {
          const body = bodies.find((b) => b.id === bodyId);
          if (!body) return { success: false, error: 'Body not found' };
          body.assetQty = totals.assetQty;
          body.costBasis = totals.costBasis;
          return { success: true, bodyId, tier: body.tier };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const bodyId = first.trade.bodyId;
      assert.equal(bodies[0].assetQty, buyFills[0].size);

      // Simulate the second fill arriving out-of-band (e.g. a sync-fills
      // sweep) — ingested directly into the ledger, NOT through this
      // importer's own ingestAdapterFills.
      fillLedger.ingestFill({
        tradeId: buyFills[1].tradeId,
        orderId: 'buy-1',
        side: 'buy',
        price: buyFills[1].price,
        size: buyFills[1].size,
        totalCommission: buyFills[1].commission,
        commission: buyFills[1].commission,
        rebate: 0,
        tradeTime: buyFills[1].tradeTime,
      }, null, { skipPersist: true, cycleId: null });

      // Simulate an UNRELATED process blanket-stamping bodyId onto EVERY
      // row for this order — including the new one above — without the
      // body ever actually absorbing it.
      fillLedger.annotateFillsByOrderId('buy-1', { bodyId, isBodyOwned: true, isSatellite: true });
      fillLedger.persist();
      assert.equal(bodies[0].assetQty, buyFills[0].size, 'the body has NOT actually absorbed the new fill yet, despite the row now carrying a bodyId');

      fillsByOrder['buy-1'] = buyFills; // this call's own ingest is a no-op (tradeId already present)

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.extended, true, 'the gap must still be detected despite every row already carrying a bodyId');
      assert.ok(Math.abs(bodies[0].assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9);
      assert.equal(second.trade.buySize, buyFills[0].size + buyFills[1].size);
    });

    // Codex delta review (round 4): createNewBody's cost basis used to sum
    // GROSS adapter commission from raw buyFills, while the extend path
    // sums `quoteAmount + netFee` (net of rebate) from ledger rows. A
    // rebated first fill would then make a later shortfall computation
    // (`totals.costBasis - recorded.cost`) absorb that gross/net mismatch —
    // both sides must use the identical, net-of-rebate convention.
    it('uses net-of-rebate fee consistently between body creation and extend', async () => {
      const rebatedFill = makeFill({ tradeId: 'imp-buy-rebate', side: 'buy', price: 90000, size: 0.002, commission: 0.5, totalCommission: 0.5, rebate: 0.1 });
      const secondFill = makeFill({ tradeId: 'imp-buy-second', side: 'buy', price: 92000, size: 0.001, commission: 0.25, totalCommission: 0.25, rebate: 0 });
      const fillsByOrder = { 'buy-1': [rebatedFill] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({ adapter, injectBody: null });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const netFee0 = rebatedFill.commission - rebatedFill.rebate; // 0.4, not the gross 0.5
      const expectedFirstCostBasis = rebatedFill.price * rebatedFill.size + netFee0;
      const firstSaved = readRegimeStateFile();
      assert.ok(
        Math.abs(firstSaved.position.celestialBodies[0].costBasis - expectedFirstCostBasis) < 1e-9,
        'body creation must use NET (rebate-adjusted) fee, not gross commission'
      );

      fillsByOrder['buy-1'] = [rebatedFill, secondFill];
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(second.success, true);
      assert.equal(second.extended, true);

      const expectedSecondCostBasis = expectedFirstCostBasis + (secondFill.price * secondFill.size + secondFill.commission);
      const saved = readRegimeStateFile();
      assert.ok(
        Math.abs(saved.position.celestialBodies[0].costBasis - expectedSecondCostBasis) < 1e-9,
        'the shortfall must not be corrupted by a gross/net fee mismatch between the two fills'
      );
      assert.ok(saved.position.celestialBodies[0].costBasis > 0, 'costBasis must never go negative from the convention mismatch');
    });

    // Codex delta review (round 4): extendPersistedBody has no
    // adapter/executor to safely cancel a resting TP with — a persisted
    // body CAN already carry a real tpOrderId (placed while the engine was
    // running, before it was stopped). It must flag needsTpReprice for the
    // engine's startup reprice pass instead of touching that live order.
    it('flags needsTpReprice instead of touching a persisted body\'s existing tpOrderId (engine not running)', async () => {
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({ adapter, injectBody: null });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const bodyId = first.trade.bodyId;

      // Simulate the engine having been running long enough to place a REAL
      // TP for this body, then getting stopped.
      const preStop = readRegimeStateFile();
      const body = preStop.position.celestialBodies.find((b) => b.id === bodyId);
      body.tpOrderId = 'tp-live-on-exchange';
      body.tpPrice = 95000;
      body.assetOnOrder = buyFills[0].size;
      fs.writeFileSync(path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json'), JSON.stringify(preStop, null, 2));

      fillsByOrder['buy-1'] = buyFills;
      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.extended, true);
      assert.equal(second.needsTpReprice, true);

      const saved = readRegimeStateFile();
      const savedBody = saved.position.celestialBodies.find((b) => b.id === bodyId);
      assert.equal(savedBody.tpOrderId, 'tp-live-on-exchange', 'the real, still-resting exchange order must not be touched or orphaned');
      assert.equal(savedBody.needsTpReprice, true, 'flagged for the engine\'s startup reprice pass to pick up');
      assert.ok(
        Math.abs(savedBody.assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9,
        'the body still grows to include the new fill'
      );
    });

    it('extends the persisted body on regime-state.json with fills that arrived since it was created (engine not running)', async () => {
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({ adapter, injectBody: null });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const firstBodyId = first.trade.bodyId;
      const firstSaved = readRegimeStateFile();
      assert.equal(firstSaved.position.celestialBodies.length, 1);
      assert.equal(firstSaved.position.celestialBodies[0].assetQty, buyFills[0].size);

      fillsByOrder['buy-1'] = buyFills;

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.extended, true);
      assert.equal(second.trade.bodyId, firstBodyId);

      const saved = readRegimeStateFile();
      assert.equal(saved.position.celestialBodies.length, 1, 'no second body may be persisted');
      assert.ok(
        Math.abs(saved.position.celestialBodies[0].assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9,
        'the persisted body grew to include the new fill'
      );
      for (const row of fillLedger.getFillsForOrder('buy-1')) {
        assert.equal(row.bodyId, firstBodyId);
      }
      assert.equal(second.trade.buySize, buyFills[0].size + buyFills[1].size);
    });

    // Codex review: a crash between extendPersistedBody's own
    // saveRegimeState() and this file's ledger-linkage write must not let a
    // retry double-count the same delta. Simulates that exact crash window
    // by hand-editing regime-state.json to already reflect the extension
    // (as extendPersistedBody would have left it) while the ledger still
    // shows the new fill unlinked — the state a process crash right between
    // those two writes would leave behind.
    it('does not double-count a body extension when regime-state.json was already updated but the ledger link never landed (crash window)', async () => {
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      const importer = createImporter({ adapter, injectBody: null });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const bodyId = first.trade.bodyId;

      // Simulate the crash: apply the SAME growth extendPersistedBody would
      // (mergeIntoBody's exact bookkeeping) directly to regime-state.json,
      // but leave the fill-ledger row for buy-fill-2 unlinked — exactly as
      // if the process died right after saveRegimeState() but before
      // fillLedger.persist() ran.
      const preCrash = readRegimeStateFile();
      const body = preCrash.position.celestialBodies.find((b) => b.id === bodyId);
      body.assetQty += buyFills[1].size;
      body.costBasis += buyFills[1].price * buyFills[1].size + buyFills[1].commission;
      body.buyOrders.push({ orderId: 'buy-1', price: buyFills[1].price, assetQty: buyFills[1].size, sizeUsdc: buyFills[1].price * buyFills[1].size + buyFills[1].commission });
      fs.writeFileSync(path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json'), JSON.stringify(preCrash, null, 2));

      fillsByOrder['buy-1'] = buyFills;

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.extended, true);
      const saved = readRegimeStateFile();
      assert.equal(saved.position.celestialBodies.length, 1);
      assert.ok(
        Math.abs(saved.position.celestialBodies[0].assetQty - (buyFills[0].size + buyFills[1].size)) < 1e-9,
        'the second fill must be counted exactly once, not twice'
      );
      // The ledger link that was actually missing before this retry is now
      // present — the whole point of retrying at all.
      for (const row of fillLedger.getFillsForOrder('buy-1')) {
        assert.equal(row.bodyId, bodyId);
      }
    });

    // A retry can find new fills for a body that no longer exists anywhere
    // live — e.g. its TP fully closed between the first import and this
    // retry, splicing it out of the engine's position. There is nothing to
    // extend, so the call must FAIL (not report success) and must NOT link
    // the new rows to the defunct body — codex review: linking them
    // unconditionally would make the next retry find zero "unlinked" rows
    // and skip straight past this whole block, permanently hiding the gap
    // even after whatever made the body disappear is fixed.
    it('fails without linking the new fills when the existing body can no longer be found, and stays retryable', async () => {
      const fillsByOrder = { 'buy-1': [buyFills[0]] };
      const adapter = createFakeAdapter({ fillsByOrder });
      let extendAttempts = 0;
      const bodies = [];
      const importer = createImporter({
        adapter,
        injectBody: async (body) => {
          bodies.push(body);
          return { tpPlaced: true };
        },
        extendBody: (bodyId, totals) => {
          extendAttempts++;
          const body = bodies.find((b) => b.id === bodyId);
          if (!body) return { success: false, error: 'Body not found' };
          // extendBody receives the FULL current total, not a delta.
          body.assetQty = totals.assetQty;
          body.costBasis = totals.costBasis;
          return { success: true, bodyId, tier: body.tier };
        },
      });

      const first = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(first.success, true);
      const bodyId = first.trade.bodyId;

      // The body closed and was spliced out of the live position before the
      // retry — simulated by removing it from the fake engine's bodies.
      bodies.length = 0;

      fillsByOrder['buy-1'] = buyFills;

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, false);
      assert.match(second.error, /Failed to extend body/);
      assert.equal(extendAttempts, 1);
      // The new (second) fill row must stay UNLINKED — not stamped onto the
      // defunct body id — so a future retry still sees it as new.
      const rows = fillLedger.getFillsForOrder('buy-1');
      assert.equal(rows.length, 2);
      const oldRow = rows.find((r) => r.tradeId === buyFills[0].tradeId);
      const newRow = rows.find((r) => r.tradeId === buyFills[1].tradeId);
      assert.equal(oldRow.bodyId, bodyId, 'the original fill stays linked to its original body');
      assert.equal(newRow.bodyId, undefined, 'the new fill must NOT be linked to a body that failed to absorb it');
      // The trade record's totals must NOT have been refreshed on a failed extend.
      const stillStored = store.getById(first.trade.id);
      assert.equal(stillStored.buySize, buyFills[0].size);

      // Self-healing: once a body exists again to extend, a further retry
      // must pick the still-unlinked fill back up and succeed.
      bodies.push({ id: bodyId, assetQty: buyFills[0].size, costBasis: buyFills[0].price * buyFills[0].size });
      const third = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
      assert.equal(third.success, true);
      assert.equal(third.extended, true);
      assert.equal(extendAttempts, 2);
      for (const row of fillLedger.getFillsForOrder('buy-1')) {
        assert.equal(row.bodyId, bodyId);
      }
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
      // Ownership is only stamped once a body is durable. The initial
      // refusal keeps its durable intent so a reloaded page can offer Resume.
      const rowAfterFirst = fillLedger.getFillsForOrder('buy-1')[0];
      assert.ok(!rowAfterFirst.bodyId);
      assert.ok(!rowAfterFirst.isBodyOwned);
      assert.equal(afterFirst[0].bodyIntent.phase, 'pending');
      const intentBodyId = afterFirst[0].bodyIntent.bodyId;
      assert.equal(readManualTradesFile().trades[0].bodyIntent.bodyId, intentBodyId);

      // A retry (e.g. once the engine finishes starting) must actually try
      // again — the top-of-function guard must not silently treat this as
      // already imported.
      const second = await importer.resumeBodyImport({ tradeId: afterFirst[0].id });
      assert.equal(second.success, true);
      assert.equal(calls, 2, 'the retry must call injectBody again, not skip it');
      assert.equal(second.trade.status, STATUS.TP_PENDING);
      assert.ok(second.trade.bodyId);
      assert.equal(second.trade.bodyId, intentBodyId, 'resume keeps the original publication identity');
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
      // retries — exactly what makes the in-memory duplicate check blind. The
      // fill handler books that sale against the body before removing it.
      fillLedger.ingestFill({ tradeId: 'tp-fill-1', orderId: 'tp-order-1', side: 'sell', size: 0.003, price: 95000, netFee: 0 }, null, { skipPersist: true, cycleId: null });
      fillLedger.annotateFillsByOrderId('tp-order-1', { bodyId: 'body-live-1', isBodyOwned: true, bodyPnl: 1 });
      fillLedger.persist();
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

      // The order fills again before the operator retries the crashed import.
      adapter.getOrderFills = async () => [
        ...buyFills,
        makeFill({ tradeId: 'late-buy-fill', size: 0.002, price: 101000 }),
      ];

      const second = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

      assert.equal(second.success, true);
      assert.equal(second.alreadyImported, true);
      assert.equal(second.extended, true);
      const savedAfter = readRegimeStateFile();
      assert.equal(savedAfter.position.celestialBodies.length, 1, 'no second body may be persisted');
      assert.equal(second.trade.bodyId, savedBefore.position.celestialBodies[0].id, 'the retry must link the trade record to the already-persisted body');
      assert.equal(second.trade.status, STATUS.TP_PENDING);
      const fullSize = buyFills.reduce((sum, fill) => sum + fill.size, 0) + 0.002;
      assert.equal(savedAfter.position.celestialBodies[0].assetQty, fullSize);
      assert.equal(second.trade.buySize, fullSize);
      assert.equal(fillLedger.getFillsForOrder('buy-1').length, buyFills.length + 1);
      assert.ok(fillLedger.getFillsForOrder('buy-1').every((row) => row.bodyId === second.trade.bodyId));
    });

    // Issue #1022: the pre-fix importer stamped ledger ownership BEFORE any
    // body was saved, so a crash or a thrown regime-state.json publication in
    // between left a ledger bodyId with no body, and the next replay reported
    // success/TP_PENDING off that stamp alone. Body creation is now a durable
    // intent: published first, linked second, resumed on retry/cold start.
    describe('interrupted body creation (#1022)', () => {
      const singleFill = [makeFill({ tradeId: 'intent-buy-1', size: 0.01, price: 100000, commission: 1, totalCommission: 1 })];

      /** Discard every in-memory handle and reload ledger + store from disk. */
      const coldReload = () => {
        const { createFillLedger } = require('../src/fill-ledger');
        fillLedger = createFillLedger(EXCHANGE, 'BTC-USDC', PAIR);
        fillLedger.load();
        const { createManualTradeStore } = require('../src/manual-trades');
        store = createManualTradeStore(EXCHANGE, PAIR);
        store.load();
      };

      /** Run `fn` with every regime-state.json rename failing ENOSPC. */
      const withRegimeStateEnospc = async (fn) => {
        const realRename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (String(to).endsWith('regime-state.json')) {
            throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
          }
          return realRename(from, to);
        };
        try {
          return await fn();
        } finally {
          fs.renameSync = realRename;
        }
      };

      const savedBodies = () => readRegimeStateFile()?.position?.celestialBodies || [];

      /** Remove every body from regime-state.json, keeping aggregates consistent. */
      const dropSavedBodies = () => {
        const { syncPositionState } = require('../src/celestial-hierarchy');
        const stateFile = path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json');
        const state = readRegimeStateFile();
        state.position.celestialBodies = [];
        syncPositionState(state.position, []);
        fs.writeFileSync(stateFile, JSON.stringify(state));
      };

      /** The ledger trail of a body TP sale: placeBodyTp's link, then the booked sell. */
      const bookBodySale = (buyOrderId, sellOrderId, bodyId) => {
        fillLedger.annotateFillsByOrderId(buyOrderId, { sellOrderId, bodyId });
        fillLedger.ingestFill({ tradeId: `${sellOrderId}-fill`, orderId: sellOrderId, side: 'sell', size: 0.009, price: 110000, netFee: 0 }, null, { skipPersist: true, cycleId: null });
        fillLedger.annotateFillsByOrderId(sellOrderId, { bodyId, isBodyOwned: true, bodyPnl: 5 });
        fillLedger.persist();
      };

      /** Fake running engine that mirrors injectBody's duplicate refusal. */
      const createFakeEngine = () => {
        const bodies = [];
        const injected = [];
        return {
          bodies,
          injected,
          injectBody: async (body) => {
            injected.push(body);
            const duplicate = bodies.find((b) => b.id === body.id || b.sourceOrderIds.includes(body.sourceOrderIds[0]));
            if (duplicate) return { success: false, error: 'duplicate body', bodyId: duplicate.id, tpPlaced: true };
            bodies.push(body);
            return { success: true, bodyId: body.id, tpPlaced: true };
          },
        };
      };

      const leaveInterruptedImport = async (buyOrderId = 'buy-1') => {
        const adapter = createFakeAdapter({ fillsByOrder: { [buyOrderId]: singleFill.map((fill) => ({ ...fill, tradeId: `${buyOrderId}-fill` })) } });
        await assert.rejects(createImporter({
          adapter,
          injectBody: async () => { throw new Error('interrupted publication'); },
        }).importBuy({ buyOrderId, createBody: true }), /interrupted publication/);
        return store.getAll().find((trade) => trade.buyOrderId === buyOrderId);
      };

      it('resumes only the selected import after reload without fetching exchange fills', async () => {
        const pending = await leaveInterruptedImport();
        const other = await leaveInterruptedImport('buy-2');
        const expectedBodyId = pending.bodyIntent.bodyId;
        coldReload();
        const adapter = createFakeAdapter();
        adapter.getOrderFills = async () => assert.fail('resuming must not depend on exchange history');
        const importer = createImporter({ adapter });

        const result = await importer.resumeBodyImport({ tradeId: pending.id });

        assert.equal(result.success, true);
        assert.equal(result.trade.id, pending.id);
        assert.equal(result.trade.status, STATUS.TP_PENDING);
        assert.equal(result.trade.bodyId, expectedBodyId);
        assert.equal(result.trade.bodyIntent.phase, 'committed');
        assert.equal(savedBodies().length, 1);
        assert.equal(savedBodies()[0].id, expectedBodyId);
        assert.equal(store.getById(other.id).bodyIntent.phase, 'pending', 'another import must stay untouched');
        assert.deepEqual(adapter.calls, { getOrderFills: [], placeLimitBuy: [], getOrder: [] });

        const again = await importer.resumeBodyImport({ tradeId: pending.id });
        assert.equal(again.success, true);
        assert.equal(again.alreadyImported, true);
        assert.equal(savedBodies().length, 1);
      });

      it('keeps the durable resume handle after a repeated engine refusal', async () => {
        const pending = await leaveInterruptedImport();
        const bodyId = pending.bodyIntent.bodyId;
        coldReload();
        const refused = await createImporter({
          adapter: {}, injectBody: async () => ({ success: false, error: 'Engine not running' }),
        }).resumeBodyImport({ tradeId: pending.id });

        assert.equal(refused.success, false);
        assert.match(refused.error, /Engine not running/);
        coldReload();
        assert.equal(store.getById(pending.id).bodyIntent.phase, 'pending');
        assert.equal(store.getById(pending.id).bodyIntent.bodyId, bodyId);
        assert.equal(savedBodies().length, 0);
        const recovered = await createImporter({ adapter: {} }).resumeBodyImport({ tradeId: pending.id });
        assert.equal(recovered.success, true);
        assert.equal(recovered.trade.bodyId, bodyId);
      });

      it('keeps the durable resume handle when position state cannot be read', async () => {
        const pending = await leaveInterruptedImport();
        const stateFile = path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json');
        fs.writeFileSync(stateFile, '{invalid json');
        const refused = await createImporter({ adapter: {} }).resumeBodyImport({ tradeId: pending.id });

        assert.equal(refused.success, false);
        assert.match(refused.error, /corrupted or unreadable/);
        coldReload();
        assert.equal(store.getById(pending.id).bodyIntent.phase, 'pending');
        assert.equal(store.getById(pending.id).status, STATUS.BUY_RECORDED);
      });

      it('reports a failed resume write and remains resumable after reload', async () => {
        const pending = await leaveInterruptedImport();
        const refused = await withRegimeStateEnospc(() =>
          createImporter({ adapter: {} }).resumeBodyImport({ tradeId: pending.id }));
        assert.equal(refused.success, false);
        assert.match(refused.error, /ENOSPC/);
        coldReload();
        assert.equal(store.getById(pending.id).bodyIntent.phase, 'pending');
        assert.equal(savedBodies().length, 0);
        assert.equal((await createImporter({ adapter: {} }).resumeBodyImport({ tradeId: pending.id })).success, true);
      });

      it('serializes concurrent resume actions without injecting a second body', async () => {
        const pending = await leaveInterruptedImport();
        const engine = createFakeEngine();
        let release;
        let entered;
        const blocked = new Promise((resolve) => { release = resolve; });
        const started = new Promise((resolve) => { entered = resolve; });
        const injectBody = async (body) => { entered(); await blocked; return engine.injectBody(body); };
        const first = createImporter({ adapter: {}, injectBody }).resumeBodyImport({ tradeId: pending.id });
        await started;
        const second = createImporter({ adapter: {}, injectBody }).resumeBodyImport({ tradeId: pending.id });
        release();
        const [a, b] = await Promise.all([first, second]);

        assert.equal(a.success, true);
        assert.equal(b.success, true);
        assert.equal(b.alreadyImported, true);
        assert.equal(engine.injected.length, 1);
        assert.equal(a.trade.bodyId, b.trade.bodyId);
      });

      it('resumes a retired body by linking its record and never republishes sold inventory', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        store.markTpPlaced = () => { throw new Error('interrupted linkage'); };
        await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }));
        const [savedBody] = savedBodies();
        coldReload();
        const [pending] = store.getAll();
        bookBodySale('buy-1', 'tp-1', savedBody.id);
        dropSavedBodies();
        const importer = createImporter({ adapter: {}, injectBody: async () => assert.fail('sold body must not be recreated') });

        const result = await importer.resumeBodyImport({ tradeId: pending.id });
        assert.equal(result.success, true);
        assert.equal(result.trade.bodyId, savedBody.id);
        assert.equal(result.trade.bodyIntent.phase, 'committed');
        assert.equal(savedBodies().length, 0);
        coldReload();
        const again = await createImporter({ adapter: {}, injectBody: async () => assert.fail('committed retry must be a no-op') })
          .resumeBodyImport({ tradeId: pending.id });
        assert.equal(again.success, true);
        assert.equal(again.alreadyImported, true);
        assert.equal(savedBodies().length, 0);
      });

      it('rejects invalid ids, wrong trade types and ledger-only imports without publishing', async () => {
        const importer = createImporter({ adapter: {}, injectBody: async () => assert.fail('invalid resume must not publish') });
        for (const tradeId of [undefined, null, '', ' ', 1, {}, []]) {
          const result = await importer.resumeBodyImport({ tradeId });
          assert.equal(result.success, false);
          assert.match(result.error, /non-blank string/);
        }
        assert.match((await importer.resumeBodyImport({ tradeId: 'unknown' })).error, /not found/);
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        const recorded = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: false });
        assert.match((await importer.resumeBodyImport({ tradeId: recorded.trade.id })).error, /no interrupted body import/);
        recorded.trade.tradeType = 'sell_first';
        assert.match((await importer.resumeBodyImport({ tradeId: recorded.trade.id })).error, /not a buy import/);
        assert.equal(savedBodies().length, 0);
      });

      it('cold retry after an ENOSPC publishing regime-state.json saves exactly one body (engine stopped)', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });

        await withRegimeStateEnospc(() => assert.rejects(
          createImporter({ adapter, injectBody: null }).importBuy({ buyOrderId: 'buy-1', createBody: true }),
          /ENOSPC/,
        ));

        // Nothing claims ownership of inventory no body holds.
        assert.equal(savedBodies().length, 0);
        const rows = fillLedger.getFillsForOrder('buy-1');
        assert.equal(rows.length, 1);
        assert.ok(!rows[0].bodyId, 'no ledger ownership before a body is saved');
        assert.ok(!rows[0].isBodyOwned);
        const [pending] = store.getAll();
        assert.equal(pending.status, STATUS.BUY_RECORDED);
        assert.equal(pending.bodyIntent.phase, 'pending');
        const intentBodyId = pending.bodyIntent.bodyId;

        // Cold reload, then replay the unchanged order.
        coldReload();
        const retried = await createImporter({ adapter, injectBody: null }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        const bodies = savedBodies();
        assert.equal(bodies.length, 1, 'exactly one saved body for the buy');
        assert.equal(bodies[0].id, intentBodyId, 'the resumed body keeps the intent\'s identity');
        assert.equal(bodies[0].assetQty, 0.01);
        assert.equal(retried.trade.status, STATUS.TP_PENDING);
        assert.equal(retried.trade.bodyId, intentBodyId);
        assert.equal(retried.trade.bodyIntent.phase, 'committed');
        assert.equal(fillLedger.getFillsForOrder('buy-1').length, 1);
        assert.equal(fillLedger.getFillsForOrder('buy-1')[0].bodyId, intentBodyId);

        // A further replay is a plain idempotent no-op.
        const again = await createImporter({ adapter, injectBody: null }).importBuy({ buyOrderId: 'buy-1', createBody: true });
        assert.equal(again.success, true);
        assert.equal(again.alreadyImported, true);
        assert.equal(savedBodies().length, 1);
      });

      it('never turns a repeated thrown publication into success or TP_PENDING', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });

        await withRegimeStateEnospc(async () => {
          await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }), /ENOSPC/);
          coldReload();
          await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }), /ENOSPC/);
        });

        assert.equal(savedBodies().length, 0);
        const [trade] = store.getAll();
        assert.equal(trade.status, STATUS.BUY_RECORDED);
        assert.equal(trade.bodyId, null);
        assert.equal(trade.bodyIntent.phase, 'pending');
        assert.ok(!fillLedger.getFillsForOrder('buy-1')[0].bodyId);
      });

      it('recovers a pending intent on cold start without the operator replaying that buy', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        await withRegimeStateEnospc(() => assert.rejects(
          createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }),
        ));

        coldReload();
        const results = await createImporter({ adapter }).recoverPendingBodyIntents();

        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.equal(results[0].buyOrderId, 'buy-1');
        assert.equal(adapter.calls.getOrderFills.length, 1, 'recovery needs no exchange fetch');
        assert.equal(savedBodies().length, 1);
        const [trade] = store.getAll();
        assert.equal(trade.status, STATUS.TP_PENDING);
        assert.equal(trade.bodyId, savedBodies()[0].id);
        assert.equal(store.getPendingBodyIntents().length, 0);
        assert.deepEqual(await createImporter({ adapter }).recoverPendingBodyIntents(), []);
      });

      it('links an already-saved body after a crash before store linkage, without a duplicate (engine stopped)', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        store.markTpPlaced = () => { throw new Error('process crashed (simulated)'); };
        await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }), /crashed/);
        assert.equal(savedBodies().length, 1, 'the body was saved before the crash');

        coldReload();
        const retried = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        assert.equal(savedBodies().length, 1, 'no duplicate body');
        assert.equal(retried.trade.bodyId, savedBodies()[0].id);
        assert.equal(retried.trade.status, STATUS.TP_PENDING);
      });

      it('links the live body after a crash before store linkage, without a second injection (engine running)', async () => {
        const engine = createFakeEngine();
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        store.markTpPlaced = () => { throw new Error('process crashed (simulated)'); };
        await assert.rejects(createImporter({ adapter, injectBody: engine.injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true }));
        assert.equal(engine.bodies.length, 1);

        coldReload();
        const retried = await createImporter({ adapter, injectBody: engine.injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        assert.equal(engine.bodies.length, 1, 'no second body was ever accepted');
        assert.equal(retried.trade.bodyId, engine.bodies[0].id);
        assert.equal(retried.trade.status, STATUS.TP_PENDING);
      });

      it('re-injects the same body identity when the engine refused it by throwing (engine running)', async () => {
        const engine = createFakeEngine();
        let attempts = 0;
        // regime-engine's injectBody takes the body back out when its first
        // save throws, so a thrown call leaves nothing live.
        const injectBody = async (body) => {
          attempts++;
          if (attempts === 1) { engine.injected.push(body); throw new Error('ENOSPC: saveLiveState'); }
          return engine.injectBody(body);
        };
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        await assert.rejects(createImporter({ adapter, injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true }), /ENOSPC/);
        assert.equal(store.getAll()[0].status, STATUS.BUY_RECORDED);

        coldReload();
        const retried = await createImporter({ adapter, injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        assert.equal(engine.bodies.length, 1);
        assert.equal(engine.injected[0].id, engine.injected[1].id, 'the retry publishes the intent\'s body, not a new one');
        assert.equal(retried.trade.bodyId, engine.injected[0].id);
      });

      it('resumes one stable operation for concurrent same-buy imports from separate importers', async () => {
        const engine = createFakeEngine();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const injectBody = async (body) => { await gate; return engine.injectBody(body); };
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });

        const first = createImporter({ adapter, injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true });
        let bodiesWhenSecondSettled = null;
        const second = createImporter({ adapter, injectBody }).importBuy({ buyOrderId: 'buy-1', createBody: true })
          .then((result) => { bodiesWhenSecondSettled = engine.bodies.length; return result; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(bodiesWhenSecondSettled, null, 'the second import must not report success while the first body is unpublished');
        release();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(bodiesWhenSecondSettled, 1);

        assert.equal(a.success, true);
        assert.equal(b.success, true);
        assert.equal(engine.injected.length, 1, 'the second import waits for, then reuses, the first');
        assert.equal(b.alreadyImported, true);
        assert.equal(a.trade.bodyId, b.trade.bodyId);
        assert.equal(store.getAll().length, 1);
      });

      it('does not recreate a body that was saved, sold and retired before the interrupted intent resumed', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        store.markTpPlaced = () => { throw new Error('process crashed (simulated)'); };
        await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }));
        const [savedBody] = savedBodies();

        // The engine starts, places the body's TP (placeBodyTp stamps
        // sellOrderId + bodyId), the TP fills, and the body is retired.
        coldReload();
        bookBodySale('buy-1', 'tp-1', savedBody.id);
        dropSavedBodies();

        const retried = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        assert.equal(retried.alreadyImported, true);
        assert.equal(savedBodies().length, 0, 'sold inventory must never be resurrected');
        assert.equal(retried.trade.bodyId, savedBody.id);
        assert.equal(retried.trade.status, STATUS.TP_PENDING);
      });

      it('does not mistake a cycle-heuristic sellOrderId beside an optimistic bodyId for a retired body', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        const importer = createImporter({ adapter });
        await importer.importBuy({ buyOrderId: 'buy-1', createBody: false });
        // Pre-#1022 optimistic stamp, plus recalculateCycles linking an
        // unrelated, non-body sell (with fills) onto the same buy.
        fillLedger.annotateFillsByOrderId('buy-1', { bodyId: 'body-never-saved', isBodyOwned: true, sellOrderId: 'cycle-sell' });
        fillLedger.ingestFill({ tradeId: 'cycle-sell-fill', orderId: 'cycle-sell', side: 'sell', size: 0.02, price: 105000, netFee: 0 }, null, { skipPersist: true, cycleId: null });
        fillLedger.persist();

        const replay = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(replay.success, false, 'unsold inventory must not be reported as managed');
        assert.equal(store.getAll()[0].status, STATUS.BUY_RECORDED);
      });

      it('does not treat another body\'s sale, linked by the cycle heuristic, as this buy\'s retirement', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        store.markTpPlaced = () => { throw new Error('process crashed (simulated)'); };
        await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }));
        const [savedBody] = savedBodies();

        // The body is lost from regime-state.json, and recalculateCycles links
        // a sale booked by an UNRELATED body onto this still-unsold buy.
        coldReload();
        dropSavedBodies();
        fillLedger.annotateFillsByOrderId('buy-1', { sellOrderId: 'other-tp' });
        fillLedger.ingestFill({ tradeId: 'other-tp-fill', orderId: 'other-tp', side: 'sell', size: 0.02, price: 110000, netFee: 0 }, null, { skipPersist: true, cycleId: null });
        fillLedger.annotateFillsByOrderId('other-tp', { bodyId: 'body-unrelated', isBodyOwned: true, bodyPnl: 3 });
        fillLedger.persist();

        const retried = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(retried.success, true);
        assert.equal(savedBodies().length, 1, 'the unsold buy gets its body back');
        assert.equal(savedBodies()[0].id, savedBody.id);
        assert.equal(retried.trade.bodyId, savedBody.id);
      });

      it('rolls back an intent whose store write failed, so same-process recovery cannot publish it', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        const realRename = fs.renameSync;
        let failNextStoreWrite = false;
        fs.renameSync = (from, to) => {
          if (failNextStoreWrite && String(to).endsWith('manual-trades.json')) {
            failNextStoreWrite = false;
            throw Object.assign(new Error('ENOSPC: manual-trades.json'), { code: 'ENOSPC' });
          }
          return realRename(from, to);
        };
        const realRecord = store.recordBodyIntent;
        store.recordBodyIntent = (...args) => { failNextStoreWrite = true; return realRecord(...args); };
        try {
          await assert.rejects(createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true }), /ENOSPC/);
        } finally {
          fs.renameSync = realRename;
          store.recordBodyIntent = realRecord;
        }

        assert.equal(store.getAll()[0].bodyIntent, null, 'no in-memory intent without a durable one');
        assert.equal(savedBodies().length, 0, 'nothing was published');
        assert.deepEqual(await createImporter({ adapter }).recoverPendingBodyIntents(), []);

        const retried = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });
        assert.equal(retried.success, true);
        assert.equal(savedBodies().length, 1);
      });

      it('links an unconfirmed pre-#1022 import to the live merge survivor, not its stale body id', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        const first = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });
        const staleId = first.trade.bodyId;
        // The body was absorbed into a survivor, and the trade predates intents.
        const stateFile = path.join(migration.resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json');
        const state = readRegimeStateFile();
        state.position.celestialBodies[0].id = 'body-survivor';
        fs.writeFileSync(stateFile, JSON.stringify(state));
        store.getAll()[0].bodyIntent = null;
        store.persist();

        const replay = await createImporter({ adapter }).importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(replay.success, true);
        assert.notEqual(staleId, 'body-survivor');
        assert.equal(replay.trade.bodyId, 'body-survivor');
        assert.equal(savedBodies().length, 1);
      });

      it('refuses success for pre-#1022 ownership that no saved body or sale backs', async () => {
        const adapter = createFakeAdapter({ fillsByOrder: { 'buy-1': singleFill } });
        const importer = createImporter({ adapter, injectBody: async () => assert.fail('must not guess a body') });
        await importer.importBuy({ buyOrderId: 'buy-1', createBody: false });
        // The old importer's optimistic stamp, left behind by a crash.
        fillLedger.annotateFillsByOrderId('buy-1', { bodyId: 'body-never-saved', isBodyOwned: true, isSatellite: true });
        fillLedger.persist();

        const replay = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });

        assert.equal(replay.success, false);
        assert.match(replay.error, /no saved body or closed-body evidence/);
        assert.equal(store.getAll()[0].status, STATUS.BUY_RECORDED, 'never TP_PENDING against a missing body');
        assert.equal(savedBodies().length, 0);

        // The old cold retry's output (TP_PENDING off the stamp) is not trusted either.
        store.markTpPlaced(store.getAll()[0].id, 'body-never-saved');
        const trade = store.getAll()[0];
        trade.bodyIntent = null;
        store.persist();
        const legacy = await importer.importBuy({ buyOrderId: 'buy-1', createBody: true });
        assert.equal(legacy.success, false);
      });
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

  // -----------------------------------------------------------------------
  // Order identity: side, product and order id (issue #1023)
  // -----------------------------------------------------------------------
  describe('order identity validation (#1023)', () => {
    const idFill = (overrides = {}) => makeFill({ orderId: 'o', productId: 'BTC-USDC', ...overrides });
    const raw = (fillsByOrder, orders) => createFakeAdapter({ fillsByOrder, orders, stampIdentity: false });
    const assertUntouched = (adapter) => {
      assert.equal(fillLedger.getFillCount(), 0);
      assert.equal(readManualTradesFile(), null);
      assert.equal(readRegimeStateFile(), null);
      assert.deepEqual(adapter.calls.placeLimitBuy, []);
    };

    it('importBuy rejects an order whose fills are sells', async () => {
      const adapter = raw({ b: [idFill({ orderId: 'b', side: 'sell', size: 0.01, price: 2000 })] });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assert.match(result.error, /is a sell order, not a buy/);
      assertUntouched(adapter);
    });

    it('importBuy rejects another product on the same exchange', async () => {
      const adapter = raw({ b: [idFill({ orderId: 'b', productId: 'ETH-USDC' })] });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assert.match(result.error, /product ETH-USDC/);
      assertUntouched(adapter);
    });

    it('rejects a different quote currency (USD vs USDC)', async () => {
      const adapter = raw({ b: [idFill({ orderId: 'b', productId: 'BTC-USD' })] });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assertUntouched(adapter);
    });

    it('rejects a fill that belongs to a different order id', async () => {
      const adapter = raw({ b: [idFill({ orderId: 'other' })] });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assert.match(result.error, /belongs to order other/);
      assertUntouched(adapter);
    });

    it('importSell rejects buy fills before ledger, store or recovery buy', async () => {
      const adapter = raw({ s: [idFill({ orderId: 's', side: 'buy' })] });
      const result = await createImporter({ adapter }).importSell({ sellOrderId: 's', recoveryBuyPrice: '99000' });
      assert.equal(result.success, false);
      assert.match(result.error, /is a buy order, not a sell/);
      assertUntouched(adapter);
    });

    it('importSell rejects a linked existing buy that is a sell or another product', async () => {
      for (const orders of [
        { eb: { status: 'OPEN', side: 'SELL', productId: 'BTC-USDC' } },
        { eb: { status: 'OPEN', side: 'BUY', productId: 'ETH-USDC' } },
      ]) {
        const adapter = raw({ s: [idFill({ orderId: 's', side: 'sell' })] }, orders);
        const result = await createImporter({ adapter }).importSell({ sellOrderId: 's', existingBuyOrderId: 'eb' });
        assert.equal(result.success, false);
        assertUntouched(adapter);
      }
    });

    it('importPair with an invalid second leg leaves everything untouched', async () => {
      const adapter = raw({
        b: [idFill({ orderId: 'b', side: 'buy' })],
        s: [idFill({ orderId: 's', side: 'sell', productId: 'ETH-USDC' })],
      });
      const result = await createImporter({ adapter }).importPair({ buyOrderId: 'b', sellOrderId: 's' });
      assert.equal(result.success, false);
      assertUntouched(adapter);
    });

    it('importPair rejects swapped legs', async () => {
      const adapter = raw({
        b: [idFill({ orderId: 'b', side: 'sell' })],
        s: [idFill({ orderId: 's', side: 'buy' })],
      });
      const result = await createImporter({ adapter }).importPair({ buyOrderId: 'b', sellOrderId: 's' });
      assert.equal(result.success, false);
      assertUntouched(adapter);
    });

    it('a mixed batch with one wrong-identity fill ingests none', async () => {
      const adapter = raw({ b: [idFill({ orderId: 'b' }), idFill({ orderId: 'b', productId: 'ETH-USDC' })] });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assertUntouched(adapter);
    });

    it('fills missing identity are verified against order metadata', async () => {
      const bare = [makeFill({ tradeId: 'bare-1' })];
      const adapter = raw({ b: bare }, { b: { orderId: 'b', side: 'BUY', productId: 'BTC-USDC' } });
      const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b', createBody: false });
      assert.equal(result.success, true);
      assert.deepEqual(adapter.calls.getOrder, ['b']);
    });

    it('fills missing identity are rejected when metadata shows the wrong side or product', async () => {
      for (const meta of [
        { orderId: 'b', side: 'SELL', productId: 'BTC-USDC' },
        { orderId: 'b', side: 'BUY', productId: 'ETH-USDC' },
      ]) {
        const adapter = raw({ b: [makeFill({ tradeId: 'bare-1' })] }, { b: meta });
        const result = await createImporter({ adapter }).importBuy({ buyOrderId: 'b' });
        assert.equal(result.success, false);
        assertUntouched(adapter);
      }
    });

    it('fails closed when identity cannot be established', async () => {
      const bare = [makeFill({ tradeId: 'bare-1' })];
      const noMeta = raw({ b: bare }, { b: { status: 'FILLED' } });
      let result = await createImporter({ adapter: noMeta }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assert.match(result.error, /Cannot verify/);
      assertUntouched(noMeta);

      const throwing = raw({ b: bare });
      throwing.getOrder = async () => { throw new Error('boom'); };
      result = await createImporter({ adapter: throwing }).importBuy({ buyOrderId: 'b' });
      assert.equal(result.success, false);
      assert.match(result.error, /boom/);
      assertUntouched(throwing);
    });

    it('checkPendingBuy rejects filled fills of the wrong product without touching the ledger', async () => {
      const sellAdapter = createFakeAdapter({ fillsByOrder: { 'sell-1': [makeFill({ tradeId: 's1', side: 'sell', size: 0.002 })] } });
      const imported = await createImporter({ adapter: sellAdapter }).importSell({ sellOrderId: 'sell-1', recoveryBuyPrice: '99000' });
      assert.equal(imported.success, true);
      const tradeId = imported.trade.id;
      const before = fillLedger.getFillCount();

      const adapter = raw(
        { 'recovery-1': [idFill({ orderId: 'recovery-1', productId: 'ETH-USDC' })] },
        { 'recovery-1': { status: 'FILLED', completionPercentage: 100 } },
      );
      const result = await createImporter({ adapter }).checkPendingBuy({ tradeId });
      assert.equal(result.success, false);
      assert.equal(fillLedger.getFillCount(), before);
      assert.equal(store.getById(tradeId).status, STATUS.BUY_PENDING);
    });

    describe('product aliases per exchange', () => {
      const cases = [
        ['coinbase', 'BTC-USDC', ['BTC-USDC', 'btc-usdc', 'BTC_USDC'], ['BTC-USD', 'ETH-USDC']],
        ['cryptocom', 'BTC-USDC', ['BTC_USDC', 'btc_usdc'], ['BTC_USD', 'BTC_USDT']],
        ['gemini', 'BTC-USDC', ['btcusd', 'BTCUSD'], ['btceur', 'ethusd']],
      ];
      for (const [exchange, fundProduct, accepted, rejected] of cases) {
        it(`${exchange}: accepts ${accepted.join(', ')} and rejects ${rejected.join(', ')}`, async () => {
          for (const productId of [...accepted, ...rejected]) {
            const adapter = raw({ b: [idFill({ orderId: 'b', productId })] });
            const importer = createImporter({ exchange, adapter, fundConfig: { productId: fundProduct } });
            const outcome = await importer.importPair({ buyOrderId: 'b', sellOrderId: 'b' });
            // Pair fetches the buy leg first; identity failure surfaces as a product error,
            // acceptance proceeds to the sell leg (side mismatch) instead.
            const productRejected = /product /.test(outcome.error || '');
            assert.equal(productRejected, rejected.includes(productId), `${exchange} ${productId}`);
          }
        });
      }
    });
  });
});
