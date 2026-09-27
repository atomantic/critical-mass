// @ts-check
//
// Regression coverage for issue #679 follow-up (codex review round 3):
// getOrderFills rejects with `{ incompleteFills: true }` when the matched
// fill total falls short of the order's own filled quantity, after its own
// brief internal retry. For a TERMINAL fill detected via polling,
// order-executor's checkPendingOrderFills already deletes the order from
// pendingOrders BEFORE invoking the fill callback — and exchanges like
// Gemini/Crypto.com have no order-event WebSocket to rediscover it — so the
// next reconcile pass can no longer re-poll that order. Without an
// engine-level retry, a rejection here would strand the fill.
//
// regime-engine.js's liveCallbacks.onFillDetected now schedules a bounded
// engine-level retry (default 5 attempts / 10s apart, overridable via
// _test.setIncompleteFillRetryTiming for tests) of itself when
// handleOrderFill rejects with incompleteFills, instead of only logging
// "will retry on next reconcile" (which is not true for this failure mode).
//
// Disk safety: throwaway pair lives under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-incomplete-fill-retry-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine, buildPartialFillData } = require('../src/regime-engine');

const TEST_PAIR = '__testincompletefillretry__';

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

// Permissive orderExecutor stub covering everything a successful buy-fill
// pass (body creation + TP placement) might call, so the "recovery" test
// below can exercise a real happy-path completion without asserting on
// business-logic side effects it isn't about.
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
  restorePendingOrder: () => {},
  ...over,
});

const makeEngine = (adapter) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor(makeExecutor());
  // Fast, deterministic timing for the test — production keeps 10s/5 attempts.
  eng._test.setIncompleteFillRetryTiming(5, 3);
  engines.push(eng);
  return eng;
};

const incompleteFillsError = () =>
  Object.assign(new Error('fills incomplete: 0.5 of 1.5'), { incompleteFills: true });

const filledBuyStatus = (orderId) => ({
  orderId,
  side: 'BUY',
  status: 'FILLED',
  filledSize: 1.5,
  filledValue: 3000,
  averageFilledPrice: 2000,
  totalFees: 0,
});

describe('terminal fallback identity reconciliation (#807, #835)', () => {
  it('books only excess real quantity and manual import does not grow the body twice', async () => {
    const orderId = 'terminal-identity-buy';
    let available = false;
    const realFill = { tradeId: 'terminal-real-trade', orderId, side: 'buy',
      size: 0.03, price: 2000, netFee: 0, tradeTime: new Date().toISOString() };
    const adapter = {
      getOrderFills: async () => {
        if (!available) throw new Error('trade history unavailable');
        return [realFill];
      },
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    };
    const eng = makeEngine(adapter);
    let tpCount = 0;
    let failCancelOnce = true;
    eng._test.setOrderExecutor(makeExecutor({
      cancelBodyTpOrder: async () => {
        if (failCancelOnce) {
          failCancelOnce = false;
          throw new Error('cancel transiently failed');
        }
        return { cancelled: true };
      },
      placeBodyTpOrder: async () => {
        tpCount++;
        return { success: true, orderId: 'terminal-identity-tp' };
      },
    }));
    await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.02, filledValue: 40, averageFilledPrice: 2000, totalFees: 0 });
    const getBody = () => eng._getPositionState().celestialBodies.find(b => b.sourceOrderIds.includes(orderId));
    assert.ok(getBody());
    assert.equal(getBody().assetQty, 0.02);
    const originalTpCount = tpCount;
    available = true;
    const realStatus = { orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, totalFees: 0 };
    await assert.rejects(eng._test.handleOrderFill(realStatus), /cancel transiently failed/);
    assert.equal(getBody().assetQty, 0.02, 'failed TP cancellation leaves the existing body unchanged');
    await eng._test.handleOrderFill(realStatus);
    assert.equal(getBody().assetQty, 0.03);
    assert.equal(getBody().costBasis, 60);
    assert.equal(tpCount, originalTpCount + 1, 'the new tranche re-sizes the existing body TP once');
    const tpCountAfterGrowth = tpCount;
    await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, totalFees: 0 });
    assert.equal(getBody().assetQty, 0.03);
    assert.equal(tpCount, tpCountAfterGrowth, 'replaying the same real identity is a no-op');

    const { createManualTradeStore } = require('../src/manual-trades');
    const { createManualTradeImporter } = require('../src/manual-trade-import');
    const store = createManualTradeStore('coinbase', TEST_PAIR);
    const importer = createManualTradeImporter({ exchange: 'coinbase', pair: TEST_PAIR,
      adapter, fillLedger: eng.getFillLedger(), store,
      extendBody: eng.extendBody, injectBody: eng.injectBody });
    for (let retry = 0; retry < 2; retry++) {
      const imported = await importer.importBuy({ buyOrderId: orderId });
      assert.equal(imported.success, true);
      assert.equal(getBody().assetQty, 0.03);
      assert.equal(getBody().costBasis, 60);
      assert.equal(tpCount, tpCountAfterGrowth);
      assert.equal(eng.getFillLedger().getRecordedSizeForOrder(orderId), 0.03);
    }
    const rows = eng.getFillLedger().getFillsForOrder(orderId);
    assert.equal(rows.length, 2);
    const synthetic = rows.find(row => row.tradeId.startsWith('synthetic-'));
    const real = rows.find(row => row.tradeId === realFill.tradeId);
    assert.equal(synthetic.size, 0.02);
    assert.deepEqual(synthetic.syntheticCoverage.reconciledTrades.map(row => row.tradeId), [realFill.tradeId]);
    assert.equal(real.size, 0.01);
    assert.equal(real.bodyId, getBody().id);
    assert.deepEqual(real.replacesSyntheticTradeIds, [`synthetic-${orderId}-0.02`]);
  });
});

describe('terminal fallback reconciles cumulative quote (#808)', () => {
  // The ledger stores unrounded quote products; compare USD totals within
  // 1e-8, while body cost uses the engine's normal cent precision.
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
    `expected ${expected}, got ${actual}`);
  const unavailable = {
    getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    getOrderFills: async () => { throw new Error('trade history unavailable'); },
  };
  const realPartial = (orderId, side = 'buy') => ({
    tradeId: `${orderId}-partial`, orderId, side, size: 0.01,
    price: 2000, netFee: 0.02, tradeTime: new Date().toISOString(),
  });

  for (const fixture of [
    { name: 'rising', quote: 60, average: 3000, gapPrice: 4000 },
    { name: 'falling', quote: 30, average: 1500, gapPrice: 1000 },
    { name: 'average-only', quote: undefined, average: 3000, gapPrice: 4000 },
    { name: 'shaped-average-only', quote: undefined, average: 3000, gapPrice: 4000, shaped: true },
    { name: 'authoritative-quote', quote: 60, average: 2500, gapPrice: 4000 },
    { name: 'quote-without-average', quote: 60, average: undefined, gapPrice: 4000 },
  ]) {
    it(`prices the ${fixture.name} gap from remaining quote, including replay after ledger reload`, async () => {
      const orderId = `quote-${fixture.name}`;
      const eng = makeEngine(unavailable);
      await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'PARTIALLY_FILLED',
        filledSize: 0.01, isPartialFill: true, confirmedFills: [realPartial(orderId)] });
      const rawStatus = { orderId, side: 'buy', status: 'FILLED', filledSize: 0.02,
        filledValue: fixture.quote, averageFilledPrice: fixture.average, totalFees: 0.06 };
      const status = fixture.shaped
        ? buildPartialFillData(orderId, 'buy', rawStatus, { isPartialFill: false, totalFees: 0.06 })
        : rawStatus;
      await eng._test.handleOrderFill(status);
      const ledger = eng.getFillLedger();
      const rows = ledger.getFillsForOrder(orderId);
      const synthetic = rows.find(row => row.syntheticCoverage);
      const expectedQuote = fixture.quote ?? 0.02 * fixture.average;
      near(synthetic.price, fixture.gapPrice);
      near(synthetic.quoteAmount, expectedQuote - 20);
      near(synthetic.syntheticCoverage.cumulativeQuote, expectedQuote);
      near(rows.reduce((sum, row) => sum + row.quoteAmount, 0), expectedQuote);
      near(rows.reduce((sum, row) => sum + row.netFee, 0), 0.06);
      // Changing prices may create separate bodies under the existing merge
      // proximity policy; their combined ownership must match the order.
      const ownedTotals = () => eng._getPositionState().celestialBodies
        .filter(b => b.sourceOrderIds.includes(orderId))
        .reduce((sum, body) => ({ qty: sum.qty + body.assetQty, cost: sum.cost + body.costBasis }),
          { qty: 0, cost: 0 });
      near(ownedTotals().qty, 0.02);
      near(ownedTotals().cost, expectedQuote + 0.06);
      ledger.persist();
      ledger.load();
      await eng._test.handleOrderFill(status);
      assert.equal(ledger.getFillsForOrder(orderId).length, 2);
      near(ownedTotals().qty, 0.02);
      near(ownedTotals().cost, expectedQuote + 0.06);
    });
  }

  it('preserves missing quote and explicit invalid quote across status shaping', () => {
    const status = { status: 'FILLED', filledSize: 0.02, averageFilledPrice: 3000 };
    for (const absent of [undefined, null]) {
      assert.equal(buildPartialFillData('quote-boundary', 'buy', {
        ...status, filledValue: absent,
      }).filledValue, undefined);
    }
    assert.equal(buildPartialFillData('quote-boundary', 'buy', {
      ...status, filledValue: 0,
    }).filledValue, 0);
    assert.ok(Number.isNaN(buildPartialFillData('quote-boundary', 'buy', {
      ...status, filledValue: 'bad',
    }).filledValue));
  });

  it('uses the full cumulative value when there are no earlier fills', async () => {
    const eng = makeEngine(unavailable);
    const orderId = 'quote-no-prior';
    await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.02, filledValue: 60, averageFilledPrice: 3000, totalFees: 0 });
    const row = eng.getFillLedger().getFillsForOrder(orderId)[0];
    near(row.price, 3000);
    near(row.quoteAmount, 60);
    const body = eng._getPositionState().celestialBodies.find(b => b.sourceOrderIds.includes(orderId));
    near(body.costBasis, 60);
  });

  for (const [name, value] of [['zero', 0], ['negative', -1], ['non-finite', Infinity],
    ['malformed', 'bad'], ['below-booked', 10], ['equal-booked', 20]]) {
    it(`leaves a ${name} cumulative quote retryable without body mutation`, async () => {
      const orderId = `quote-invalid-${name}`;
      const eng = makeEngine(unavailable);
      await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'PARTIALLY_FILLED',
        filledSize: 0.01, isPartialFill: true, confirmedFills: [realPartial(orderId)] });
      const before = JSON.stringify(eng._getPositionState().celestialBodies);
      await assert.rejects(eng._test.handleOrderFill({ orderId, side: 'buy', status: 'FILLED',
        filledSize: 0.02, filledValue: value, averageFilledPrice: 3000 }),
      error => error.incompleteFills === true);
      assert.equal(eng.getFillLedger().getFillsForOrder(orderId).length, 1);
      assert.equal(JSON.stringify(eng._getPositionState().celestialBodies), before);
      // A corrected status can recover the same pending execution.
      await eng._test.handleOrderFill({ orderId, side: 'buy', status: 'FILLED',
        filledSize: 0.02, filledValue: 60, averageFilledPrice: 3000 });
      near(eng.getFillLedger().getFillsForOrder(orderId).reduce((sum, row) => sum + row.quoteAmount, 0), 60);
    });
  }

  it('books changing-price sell proceeds and fees once across partial and terminal fills', async () => {
    const orderId = 'quote-sell';
    let detailAvailable = true;
    const eng = makeEngine({
      cancelOrder: async () => ({ success: true }),
      getOpenOrders: async () => [],
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0.01,
        filledValue: 20, averageFilledPrice: 2000, totalFees: 0.02 }),
      getOrderFills: async () => {
        if (detailAvailable) return [realPartial(orderId, 'sell')];
        throw new Error('trade history unavailable');
      },
    });
    const pos = eng._getPositionState();
    eng._test.setOrderExecutor(makeExecutor({
      placeBodyTpOrder: async () => ({ success: true, orderId }),
    }));
    pos.celestialBodies = [{ id: 'quote-sell-body', tier: 'satellite', assetQty: 0.02,
      costBasis: 20, avgPrice: 1000, assetOnOrder: 0.02, tpOrderId: orderId,
      sourceOrderIds: [], buyOrders: [] }];
    await eng._test.handleOrderFill({ orderId, side: 'sell', status: 'PARTIALLY_FILLED',
      filledSize: 0.01, isPartialFill: true });
    detailAvailable = false;
    const terminal = { orderId, side: 'sell', status: 'FILLED', filledSize: 0.02,
      filledValue: 60, averageFilledPrice: 3000, totalFees: 0.06 };
    await eng._test.handleOrderFill(terminal);
    const ledger = eng.getFillLedger();
    const rows = ledger.getFillsForOrder(orderId);
    near(rows.reduce((sum, row) => sum + row.quoteAmount - row.netFee, 0), 59.94);
    near(rows[0].bodyPnl, 39.94);
    const bookedPnl = pos.realizedPnL;
    ledger.persist();
    ledger.load();
    await eng._test.handleOrderFill(terminal);
    assert.equal(ledger.getFillsForOrder(orderId).length, 2);
    near(pos.realizedPnL, bookedPnl);
  });
});

describe('synthetic fallback accounts for the GAP, not the stale ledger total (codex convergence review)', () => {
  it('books the remainder when a terminal rescan fails after an earlier partial was already ingested', async () => {
    // 1. A real partial fill ingests 0.01 and creates/owns a body — no
    //    getOrderFills failure yet.
    // 2. A later TERMINAL poll reports 0.03 total filled, but getOrderFills
    //    now fails (both the initial call and its 2s-delayed retry) — the
    //    old fallback reduced to the stale ledger-only total (0.01),
    //    shouldSkipBuyRecommit saw "already owned, nothing new ingested",
    //    and retired the order without ever booking the remaining 0.02.
    const orderId = 'gap-order-1';
    let getOrderFillsCalls = 0;
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => {
        getOrderFillsCalls++;
        if (getOrderFillsCalls === 1) {
          return [{ tradeId: 'gap-t1', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }];
        }
        throw new Error('trade scan unavailable');
      },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000, isPartialFill: true,
    });

    const afterPartial = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.ok(afterPartial, 'the partial fill must create/own a body');
    assert.ok(Math.abs(afterPartial.assetQty - 0.01) < 1e-8, `body should hold the 0.01 partial, got ${afterPartial.assetQty}`);

    // Terminal poll: order status now reports the full 0.03, but every
    // getOrderFills call from here on fails.
    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, isPartialFill: false,
    });

    assert.ok(getOrderFillsCalls >= 3, 'must have attempted the terminal rescan and its 2s retry');
    const afterTerminal = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.ok(afterTerminal, 'the body must still exist after the terminal rescan failure');
    assert.ok(
      Math.abs(afterTerminal.assetQty - 0.03) < 1e-8,
      `the body must reflect the FULL 0.03 (the gap must be booked, not dropped or double-counted) — got ${afterTerminal.assetQty}`,
    );
  });

  it('books the unbooked FEE DELTA on the synthesized gap, not zero, when a prior partial already booked its own fee (codex convergence review, round 5)', async () => {
    // fillData.totalFees is CUMULATIVE for the whole order (Coinbase's
    // getOrder() reports the running total, not a per-poll delta). The
    // prior version zeroed the synthetic gap's fee whenever a prior
    // partial already existed in the ledger ("already carries its own
    // fee"), which silently dropped the NEW tranche's fee to $0 instead
    // of crediting the unbooked delta (cumulative minus what's already
    // booked).
    const orderId = 'gap-fee-1';
    let getOrderFillsCalls = 0;
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => {
        getOrderFillsCalls++;
        if (getOrderFillsCalls === 1) {
          // First tranche: 0.01 @ 2000, fee 0.02 already booked for real.
          return [{ tradeId: 'gap-fee-t1', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0.02 }];
        }
        throw new Error('trade scan unavailable');
      },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000, isPartialFill: true,
    });

    // Terminal poll: order status now reports the full 0.03 filled with a
    // CUMULATIVE totalFees of 0.06 (0.02 already booked + 0.04 for the new
    // 0.02 tranche) — every getOrderFills call from here on fails.
    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, totalFees: 0.06, isPartialFill: false,
    });

    const ledgerFills = eng.getFillLedger().getFillsForOrder(orderId);
    const syntheticFill = ledgerFills.find(f => f.tradeId.startsWith('synthetic-'));
    assert.ok(syntheticFill, 'the synthetic gap fill must have been ingested');
    assert.ok(
      Math.abs(syntheticFill.netFee - 0.04) < 1e-8,
      `the synthetic gap must book the unbooked fee DELTA (0.06 cumulative - 0.02 already booked = 0.04), not zero — got ${syntheticFill.netFee}`,
    );
    const totalNetFee = ledgerFills.reduce((sum, f) => sum + Number(f.netFee || 0), 0);
    assert.ok(Math.abs(totalNetFee - 0.06) < 1e-8, `the ledger's total fee for this order must equal the order's own cumulative 0.06 — got ${totalNetFee}`);
  });

  it('does NOT synthesize a gap fill for a still-live (non-terminal) advancing partial, and stays correct once the real trade arrives (Claude convergence review, round 4)', async () => {
    // A still-open partial has no "final word" the way a terminal fill
    // does — a LATER poll can still bring the real trade with a genuinely
    // different tradeId. Synthesizing a phantom gap fill for it (as an
    // earlier round of this fix did, gating only on the SIZE gap, not on
    // terminal status) creates a row nothing ever retires: once the real
    // trade lands under its own tradeId, the body/ledger over-state by
    // the phantom's size, since ingestFill's tradeId dedup can't know the
    // synthetic row and the real trade represent the same underlying fill.
    const orderId = 'gap-nonterminal-1';
    let getOrderFillsCalls = 0;
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => {
        getOrderFillsCalls++;
        if (getOrderFillsCalls === 1) {
          // Poll 1: first tranche, real trade.
          return [{ tradeId: 'real-t1', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }];
        }
        if (getOrderFillsCalls <= 3) {
          // Poll 2 (still PARTIALLY_FILLED — non-terminal): both attempts fail.
          throw new Error('trade scan unavailable');
        }
        // Poll 3: the real second tranche finally shows up, under its own tradeId.
        return [
          { tradeId: 'real-t1', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 },
          { tradeId: 'real-t2', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 },
        ];
      },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000, isPartialFill: true,
    });
    const bodyId = () => eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.ok(Math.abs(bodyId().assetQty - 0.01) < 1e-8, 'after poll 1 the body holds the real 0.01 tranche');

    // Poll 2: order advanced to 0.02 (STILL PARTIALLY_FILLED — not
    // terminal), but getOrderFills fails both attempts. Must NOT synthesize.
    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.02, filledValue: 40, averageFilledPrice: 2000, isPartialFill: true,
    });
    assert.ok(
      Math.abs(bodyId().assetQty - 0.01) < 1e-8,
      `a non-terminal partial whose rescan failed must stay retryable, not synthesize a phantom gap — got ${bodyId().assetQty}`,
    );

    // Poll 3: still 0.02, getOrderFills now succeeds with the real trades.
    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.02, filledValue: 40, averageFilledPrice: 2000, isPartialFill: false,
    });
    assert.ok(
      Math.abs(bodyId().assetQty - 0.02) < 1e-8,
      `once the real trade arrives the body must reflect the true 0.02, not be over-stated by a phantom gap — got ${bodyId().assetQty}`,
    );
  });

  it('does not credit the body for a gap fill whose ingest reports an already-seen duplicate, and does not commit a zero-value body either (Claude convergence review, round 4; Claude delta review, round 6)', async () => {
    // Defensive coverage for handleOrderFillImpl's own bookkeeping: if
    // fillLedger.ingestFill reports the synthetic gap row as an
    // already-seen duplicate (result.fill === null — e.g. a race with
    // another pass that landed the identical row first), the gap fill
    // must NOT be credited to fillsToAggregate/ingestedFills, since
    // nothing new actually entered the ledger this pass. An earlier round
    // of this fix fell back to the raw, never-ingested syntheticFill
    // object in that case, letting the body absorb size the ledger never
    // recorded. A LATER round found that even after that fix, the resulting
    // empty fillsToAggregate still fell through into committing a
    // ZERO-value body (assetQty/costBasis 0, cycleBuys incremented,
    // lastEntryPrice 0, buy_filled emitted) — this is a TERMINAL fill (no
    // later poll will ever supersede it), so the fix now throws instead of
    // committing nothing, giving the bounded engine-level retry a chance to
    // recover it.
    const orderId = 'gap-dup-1';
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];
    const cycleBuysBefore = pos.cycleBuys;

    const ledger = eng.getFillLedger();
    const originalIngestFill = ledger.ingestFill;
    let syntheticIngestAttempts = 0;
    ledger.ingestFill = (fill, placedAt) => {
      if (typeof fill.tradeId === 'string' && fill.tradeId.startsWith('synthetic-')) {
        syntheticIngestAttempts++;
        return { fill: null, ingested: false };
      }
      return originalIngestFill(fill, placedAt);
    };

    try {
      await assert.rejects(
        eng._test.handleOrderFill({
          orderId, side: 'buy', status: 'FILLED',
          filledSize: 100, filledValue: 200000, averageFilledPrice: 2000, isPartialFill: false,
        }),
        /No fills available to book/,
        'a terminal fill with nothing to book (duplicate gap ingest) must throw, not silently commit a zero-value body',
      );
    } finally {
      ledger.ingestFill = originalIngestFill;
    }

    assert.ok(syntheticIngestAttempts >= 1, 'must have attempted to ingest the synthetic gap fill');
    const body = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(body, undefined, 'must not create a body — zero-value or otherwise — when nothing was actually booked');
    assert.equal(pos.cycleBuys, cycleBuysBefore, 'cycleBuys must not advance for a pass with nothing booked');
  });

  it('does not commit a zero-value body for a genuinely FIRST, still-live partial with no fills discoverable yet, and leaves the order retryable rather than throwing (Claude delta review, round 6)', async () => {
    // A first-ever partial for an orderId with NO prior ledger rows, whose
    // getOrderFills throws on both the initial attempt and
    // handleOrderFillImpl's own 2s retry. Gap synthesis correctly does not
    // apply (status is non-terminal — a later poll can still bring the
    // real trade), so there is nothing at all to book this pass. Before
    // this fix, fillsToAggregate fell through empty and still committed: a
    // body with assetQty/costBasis 0, cycleBuys incremented,
    // lastEntryPrice set to 0, and a buy_filled event emitted for a fill
    // that never actually landed — and findMergeTarget was then free to
    // cancel/re-place a REAL body's TP against that phantom's bogus 0
    // price. Unlike the terminal case, this must NOT throw — the order
    // stays tracked (keepEntryTracked, since isPartialFill is true) and is
    // simply retried on the next poll/reconcile.
    const orderId = 'first-partial-empty-1';
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];
    const cycleBuysBefore = pos.cycleBuys;

    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, isPartialFill: true,
    });

    const body = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(body, undefined, 'must not create a body — zero-value or otherwise — from an empty aggregate');
    assert.equal(pos.cycleBuys, cycleBuysBefore, 'cycleBuys must not advance for a pass with nothing booked');
    assert.equal(eng.getFillLedger().getFillsForOrder(orderId).length, 0, 'no fill row — real or synthetic — was recorded for this orderId');
  });
});

describe('incompleteFills engine-level retry (issue #679 follow-up)', () => {
  it('a persistently-incomplete getOrderFills still succeeds via the order-status fallback, with no engine-level retry needed', async () => {
    // handleOrderFillImpl's own order-status synthetic-fill fallback (a
    // sibling fix to this one) already absorbs a getOrderFills rejection
    // when order status (filledSize + averageFilledPrice, known independent
    // of the failed call) is usable — so the common case never needs to
    // reach this engine-level retry mechanism at all.
    let calls = 0;
    const adapter = { getOrderFills: async () => { calls++; throw incompleteFillsError(); } };
    const eng = makeEngine(adapter);
    const orderId = 'order-fallback-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));

    assert.equal(calls, 2, 'getOrderFills is attempted (and its own internal empty-rawFills retry runs) before falling back');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'no engine-level retry needed — the fallback already succeeded');
  });

  it('a non-getOrderFills failure on a terminal fill still gets a bounded engine-level retry, then gives up cleanly', async () => {
    // Codex + coordinator review: the engine-level retry originally only
    // fired for an err.incompleteFills-flagged error, but a terminal fill
    // (already removed from orderExecutor's pendingOrders before this
    // callback runs) has the identical "next reconcile can't rediscover it"
    // problem for ANY failure, not just a getOrderFills one — e.g. a
    // rethrown order-detail/status lookup failure carries no such flag, and
    // neither does a downstream placement failure. The gate is now
    // isTerminal (FILLED/CANCELLED), not the error type.
    let calls = 0;
    const adapter = {
      getOrderFills: async () => [{ tradeId: 't1', orderId: 'order-exhaust-1', side: 'buy', size: 1.5, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }],
    };
    const eng = makeEngine(adapter);
    // orderExecutor.handleOrderFill (the retirement call at the end of the
    // buy branch) is a reliable throw point that is NOT internally swallowed
    // the way a TP-placement failure is (that path logs and lets the body
    // persist without a TP instead of propagating) — good for isolating the
    // retry mechanism itself from unrelated pipeline resilience.
    eng._test.setOrderExecutor(makeExecutor({
      handleOrderFill: () => { calls++; throw new Error('executor retirement failed'); },
    }));
    const orderId = 'order-exhaust-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // First call + 3 scheduled retries at 5ms apart; wait comfortably past
    // all of them, then a bit more to confirm no further retry fires.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 4, 'must attempt the initial call plus every configured retry, then stop');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared once exhausted, not leaked');
  });

  it('a non-getOrderFills failure on a terminal fill recovers and stops retrying once a later attempt succeeds', async () => {
    let calls = 0;
    const adapter = {
      getOrderFills: async () => [{ tradeId: 't1', orderId: 'order-recover-1', side: 'buy', size: 1.5, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }],
    };
    const eng = makeEngine(adapter);
    eng._test.setOrderExecutor(makeExecutor({
      handleOrderFill: () => {
        calls++;
        if (calls < 3) throw new Error('executor retirement failed');
      },
    }));
    const orderId = 'order-recover-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // 2 failures * 5ms apart, plus slack for the successful pass's own work.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 3, 'must stop retrying as soon as a call succeeds');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared on success');
  });
});
