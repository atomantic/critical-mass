// @ts-check
//
// Issue #1613 (seam 1): synthetic coverage reconciliation — matching a real
// exchange execution against the terminal order-status fallback row that
// stood in for it — lives in src/fill-ledger-synthetic-coverage.js. The
// planners are pure over the ledger's fills; the mutators take the ledger's
// maps and sets explicitly. createFillLedger keeps the same ingestFill
// behavior and the same `_test.reconcileSyntheticCoverage` hook.
//
// The transcript digest below was produced by the pre-extraction ledger (main
// before this change) over the same scenarios, so the extraction is held to
// byte-identical results, rows, indexes, correction journals and handler
// calls. The scenarios cover: replace with a residual, replace with a buy
// correction that re-costs a linked body sell, preserve with an excess
// tranche, preserve across rows with differing annotations (identity-only
// journaling onto the coverage row), sell replace with a P&L correction, sell
// preserve over mixed booking states, the legacy synthetic tradeId shapes, a
// reload between executions, and a failed publication rolling memory back.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migration = require('../src/migration');
const coverage = require('../src/fill-ledger-synthetic-coverage');

const EXPECTED_TRANSCRIPT_DIGEST = '483bc45f022b9dfd9be0ef1ccf34edb1e8bbac8e835d80f331aaa8f5b6bc208a';

const originalGetExchangeDataDir = migration.getExchangeDataDir;
/** @type {string} */
let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-ledger-synthetic-coverage-test-'));
  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tmpDir, exchange);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
});
after(() => {
  migration.getExchangeDataDir = originalGetExchangeDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TRADE_TIME = '2026-10-17T00:00:00.000Z';
const NOW = 1792195200000;

const exec = (tradeId, orderId, side, size, price, extra = {}) => ({
  tradeId, orderId, side, size, price, fee: size * 2, netFee: size * 2, tradeTime: TRADE_TIME, ...extra,
});
const synthetic = (tradeId, orderId, side, size, price, extra = {}) =>
  exec(tradeId, orderId, side, size, price, { syntheticCoverage: { orderId }, ...extra });

/**
 * Run every scenario against a fresh ledger module and record everything the
 * coverage seam can influence.
 */
const runTranscript = () => {
  const transcript = [];
  const { createFillLedger, getFillLedgerPath } = require('../src/fill-ledger');
  const open = (name) => {
    const ledger = createFillLedger(name);
    const handled = [];
    ledger.setBuyCorrectionHandler(correction => handled.push({ buy: structuredClone(correction) }));
    ledger.setSellCorrectionHandler(correction => handled.push({ sell: structuredClone(correction) }));
    return { ledger, handled };
  };
  const snapshot = (name, ledger, handled, orderIds, tradeIds) => {
    for (const orderId of new Set([...orderIds, ...ledger.getAllFills().map(fill => fill.orderId)])) {
      assert.deepEqual(ledger.getFillsForOrder(orderId),
        ledger.getAllFills().filter(fill => fill.orderId === orderId).sort((a, b) => a.timestamp - b.timestamp),
        `${name}: order index must match canonical rows for ${orderId}`);
    }
    return {
      name,
      fills: ledger.getAllFills(),
      sizes: orderIds.map(id => ledger.getRecordedSizeForOrder(id)),
      processed: tradeIds.map(id => ledger.hasProcessedTrade(id)),
      currentCycle: ledger.getCurrentCycleFills().map(f => f.tradeId),
      handled,
      derived: ledger.computeRealizedFromCyclePairs(),
    };
  };
  const step = (ledger, data, options) => {
    const reported = { ...data, quoteAmount: data.size * data.price, rebate: 0 };
    let plan = null;
    try {
      plan = JSON.parse(JSON.stringify(ledger._test.reconcileSyntheticCoverage(reported)));
    } catch (err) {
      plan = { error: err.message };
    }
    let result;
    try {
      result = JSON.parse(JSON.stringify(ledger.ingestFill(data, null, options)));
    } catch (err) {
      result = { error: err.message };
    }
    transcript.push({ plan, result });
  };

  // 1. Buy replace: partial (leaves a residual), then a re-priced remainder
  // whose buy correction re-costs the linked body sell.
  {
    const { ledger, handled } = open('buy-replace');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-b1', 'b1', 'buy', 0.02, 2000));
    ledger.annotateFillsByOrderId('b1', { bodyId: 'body-1', isBodyOwned: true,
      consumedBy: { 'sell-x': 0.01 }, sellOrderId: 'sell-x' });
    ledger.ingestFill(exec('sell-x-1', 'sell-x', 'sell', 0.01, 2200));
    ledger.commitSellBooking('sell-x', { bodyPnl: 1.5, bodyCostBasis: 20.02,
      bodyBtcQty: 0.01, bodyHoldbackAsset: 0, bodyId: 'body-1' }, { soldSize: 0.01 });
    step(ledger, exec('real-b1-a', 'b1', 'buy', 0.01, 2000), { cycleId: null });
    step(ledger, exec('real-b1-b', 'b1', 'buy', 0.01, 2100), { cycleId: null });
    transcript.push(snapshot('buy-replace', ledger, handled, ['b1', 'sell-x'],
      ['synthetic-b1', 'real-b1-a', 'real-b1-b']));
  }

  // 2. Buy preserve: a re-priced execution crossing total coverage books
  // only the excess as a new tranche.
  {
    const { ledger, handled } = open('buy-preserve');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-b2', 'b2', 'buy', 0.02, 2000, {
      syntheticCoverage: { orderId: 'b2', cumulativeQuantity: 0.02, cumulativeQuote: 40, cumulativeFees: 0.04 },
    }));
    step(ledger, exec('real-b2', 'b2', 'buy', 0.03, 2050));
    transcript.push(snapshot('buy-preserve', ledger, handled, ['b2'], ['synthetic-b2', 'real-b2']));
  }

  // 3. Buy preserve across two coverage rows with differing annotations:
  // identity-only (journal lands on the coverage row), then a remainder,
  // then an excess after coverage is exhausted.
  {
    const { ledger, handled } = open('buy-mixed');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-b3-0.01', 'b3', 'buy', 0.01, 2000));
    ledger.ingestFill(synthetic('synthetic-b3-0.02', 'b3', 'buy', 0.01, 2000));
    ledger.updateFillCycleId('synthetic-b3-0.01', 'cycle-9');
    step(ledger, exec('real-b3-a', 'b3', 'buy', 0.015, 2010));
    step(ledger, exec('real-b3-b', 'b3', 'buy', 0.005, 2000));
    step(ledger, exec('real-b3-c', 'b3', 'buy', 0.004, 1990));
    transcript.push(snapshot('buy-mixed', ledger, handled, ['b3'],
      ['real-b3-a', 'real-b3-b', 'real-b3-c']));
  }

  // 4. Sell replace with changed economics: the booked P&L annotations move
  // by the correction's delta.
  {
    const { ledger, handled } = open('sell-replace');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-s4', 's4', 'sell', 0.02, 2000));
    ledger.commitSellBooking('s4', { bodyPnl: 5, bodyCostBasis: 34.96, bodyBtcQty: 0.02,
      bodyHoldbackAsset: 0.001, bodyId: 'sold-body' }, { soldSize: 0.02 });
    ledger.claimCapitalCredit('s4', 0.02);
    step(ledger, exec('real-s4-a', 's4', 'sell', 0.01, 2100));
    step(ledger, exec('real-s4-b', 's4', 'sell', 0.01, 2000, { fee: 0.03, netFee: 0.03 }));
    transcript.push(snapshot('sell-replace', ledger, handled, ['s4'], ['real-s4-a', 'real-s4-b']));
  }

  // 5. Sell preserve over one booked and one unbooked coverage row.
  {
    const { ledger, handled } = open('sell-mixed');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-s5-0.01', 's5', 'sell', 0.01, 2000));
    ledger.ingestFill(synthetic('synthetic-s5-0.02', 's5', 'sell', 0.01, 2000));
    ledger.annotateFillsByOrderIds(['s5'], { bodyPnl: 1, bodyCostBasis: 19, bodyBtcQty: 0.01,
      bodyBooked: true, bodyBookedSize: 0.01 }, { include: f => f.tradeId === 'synthetic-s5-0.01' });
    step(ledger, exec('real-s5', 's5', 'sell', 0.025, 2000));
    transcript.push(snapshot('sell-mixed', ledger, handled, ['s5'], ['real-s5']));
  }

  // 6. Legacy synthetic tradeId shapes (no syntheticCoverage field), then a
  // reload between executions.
  {
    let { ledger, handled } = open('legacy');
    ledger.startNewCycle();
    ledger.ingestFill(exec('synthetic-l6', 'l6', 'buy', 0.01, 2000));
    ledger.ingestFill(exec('synthetic-l7-3', 'l7', 'buy', 0.01, 2000));
    ledger.ingestFill(exec('synthetic-l8-abc', 'l8', 'buy', 0.01, 2000));
    step(ledger, exec('real-l6', 'l6', 'buy', 0.01, 2000));
    ({ ledger, handled } = open('legacy'));
    step(ledger, exec('real-l6', 'l6', 'buy', 0.01, 2000));
    step(ledger, exec('real-l7', 'l7', 'buy', 0.004, 2000));
    ({ ledger, handled } = open('legacy'));
    step(ledger, exec('real-l7-b', 'l7', 'buy', 0.006, 2005));
    step(ledger, exec('real-l8', 'l8', 'buy', 0.01, 2000));
    transcript.push(snapshot('legacy', ledger, handled, ['l6', 'l7', 'l8'],
      ['synthetic-l6', 'real-l6', 'real-l7', 'real-l7-b', 'real-l8']));
  }

  // 7. A failed publication rolls memory, indexes and the dirty flag back so
  // the retry is not mistaken for a durable duplicate.
  {
    const { ledger, handled } = open('rollback');
    ledger.startNewCycle();
    ledger.ingestFill(synthetic('synthetic-r9', 'r9', 'buy', 0.02, 2000));
    const dir = path.dirname(getFillLedgerPath('rollback'));
    let error = null;
    fs.chmodSync(dir, 0o500);
    try {
      ledger.ingestFill(exec('real-r9', 'r9', 'buy', 0.01, 2100), null, { skipPersist: true });
    } catch (err) {
      error = err.code || 'thrown';
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    transcript.push({ rollbackError: error, dirty: ledger.isDirty(),
      ...snapshot('rollback-failed', ledger, handled, ['r9'], ['real-r9']) });
    step(ledger, exec('real-r9', 'r9', 'buy', 0.01, 2100));
    transcript.push(snapshot('rollback-retried', ledger, handled, ['r9'], ['real-r9']));
  }
  return transcript;
};

describe('fill-ledger synthetic coverage (issue #1613)', () => {
  it('ingest results, rows, indexes and journals match the pre-extraction ledger', (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('root ignores the read-only directory used to fail publication');
      return;
    }
    const originalNow = Date.now;
    Date.now = () => NOW;
    try {
      const transcript = runTranscript();
      const digest = crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex');
      if (process.env.PRINT_COVERAGE_TRANSCRIPT) {
        process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n${digest}\n`);
      }
      // Spot checks so a digest mismatch has a readable first failure.
      const rollback = transcript.find(entry => entry.name === 'rollback-failed');
      assert.ok(rollback.rollbackError, 'publication failure must throw');
      assert.deepEqual(rollback.processed, [false], 'rolled-back execution is not a duplicate');
      assert.deepEqual(rollback.sizes, [0.02]);
      const retried = transcript.find(entry => entry.name === 'rollback-retried');
      assert.deepEqual(retried.processed, [true]);
      assert.equal(digest, EXPECTED_TRANSCRIPT_DIGEST);
    } finally {
      Date.now = originalNow;
    }
  });

  describe('pure helpers', () => {
    it('recognizes coverage by field and by the legacy synthetic tradeId shapes', () => {
      const row = (tradeId, extra = {}) => ({ tradeId, orderId: 'o', ...extra });
      assert.equal(coverage.isSyntheticCoverage(row('x', { syntheticCoverage: {} })), true);
      assert.equal(coverage.isSyntheticCoverage(row('synthetic-o')), true);
      assert.equal(coverage.isSyntheticCoverage(row('synthetic-o-0.02')), true);
      assert.equal(coverage.isSyntheticCoverage(row('synthetic-o-abc')), false);
      assert.equal(coverage.isSyntheticCoverage(row('real')), false);
    });

    it('measures unresolved coverage net of reconciled trades', () => {
      const row = { tradeId: 't', orderId: 'o', size: 0.02,
        syntheticCoverage: { reconciledTrades: [{ size: 0.005 }, { size: 0.015 }] } };
      assert.equal(coverage.unresolvedSyntheticSize(row), 0);
      assert.equal(coverage.isUnresolvedSyntheticCoverage(row), false);
      row.syntheticCoverage.reconciledTrades.pop();
      assert.equal(coverage.unresolvedSyntheticSize(row), 0.015);
      assert.equal(coverage.isUnresolvedSyntheticCoverage(row), true);
    });

    it('plans without mutating the ledger state it reads', () => {
      const seed = { tradeId: 'synthetic-o', orderId: 'o', side: 'buy', size: 0.02, price: 2000,
        quoteAmount: 40, fee: 0.04, netFee: 0.04, rebate: 0, timestamp: 1, cycleId: null,
        syntheticCoverage: { orderId: 'o' } };
      const fills = new Map([[seed.tradeId, seed]]);
      const syntheticOrders = new Set(['o']);
      const before = JSON.stringify([...fills]);
      const reported = Object.freeze({ tradeId: 'real', orderId: 'o', side: 'buy', size: 0.01,
        price: 2000, quoteAmount: 20, fee: 0.02, netFee: 0.02, rebate: 0, timestamp: 2, cycleId: null });
      const plan = coverage.reconcileSyntheticCoverage(reported, { fills, syntheticOrders });
      assert.equal(plan.mode, 'replace');
      assert.equal(plan.replacements[0].residual.size, 0.01);
      assert.equal(JSON.stringify([...fills]), before);
      assert.equal(coverage.reconcileSyntheticCoverage(reported, { fills, syntheticOrders: new Set() }), null);
      assert.equal(coverage.reconcileSyntheticCoverage(seed, { fills, syntheticOrders }), null,
        'a coverage row never reconciles against coverage');
    });

    it('lists bookable fills per reconciliation mode', () => {
      const fill = { tradeId: 'real', side: 'sell', size: 0.01 };
      assert.deepEqual(coverage.getBookableReconciliationFills(fill, null), [fill]);
      assert.deepEqual(coverage.getBookableReconciliationFills(fill, { mode: 'replace' }), []);
      const booked = { tradeId: 'a', side: 'sell', size: 0.01, bodyBooked: true };
      const unbooked = { tradeId: 'b', side: 'sell', size: 0.01, price: 1 };
      const allocation = (row) => ({ row, size: 0.005, quoteAmount: 10, fee: 0, netFee: 0, rebate: 0 });
      assert.deepEqual(coverage.getBookableReconciliationFills(fill, { mode: 'preserve',
        allocations: [allocation(booked), allocation(unbooked)] }), [
        { ...unbooked, size: 0.005, quoteAmount: 10, fee: 0, netFee: 0, rebate: 0, price: 2000,
          syntheticCoverageAllocation: true },
        fill,
      ]);
    });
  });
});
