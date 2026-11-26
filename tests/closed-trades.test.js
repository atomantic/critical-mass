// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const closedTradesPath = require.resolve('../src/closed-trades');
const fillLedgerPath = require.resolve('../src/fill-ledger');
const fundPaths = require('../src/fund-paths');
const originalGetExchangeDataDir = fundPaths.getExchangeDataDir;

/** @type {string|null} */
let tmpDir = null;

const freshModule = () => {
  delete require.cache[closedTradesPath];
  return require('../src/closed-trades');
};

const freshFillLedgerModule = () => {
  delete require.cache[fillLedgerPath];
  return require('../src/fill-ledger');
};

describe('Closed Trades dedup and aggregation', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-trades-test-'));
    fundPaths.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    fundPaths.getExchangeDataDir = originalGetExchangeDataDir;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete require.cache[closedTradesPath];
    delete require.cache[fillLedgerPath];
  });

  const baseTrade = (overrides = {}) => ({
    sellOrderId: 'sell-1',
    timestamp: 1000,
    recordedAt: 1000,
    qtySold: 0.001,
    sellProceeds: 105,
    sellFees: 0.1,
    costBasis: 100,
    buyAvgPrice: 100000,
    pnl: 5,
    holdbackAsset: 0,
    isPartial: false,
    bodyId: null,
    bodyTier: null,
    cycleId: 'cycle-1',
    buyOrderIds: [],
    source: 'live',
    ...overrides,
  });

  it('rebuilds linked holdback, clamped oversells and later-partial annotations once per order', () => {
    const ct = freshModule().createClosedTrades('coinbase', 'BTC-USD');
    const fills = [
      { side: 'buy', orderId: 'b1', sellOrderId: 's1', size: 2, quoteAmount: 100 },
      { side: 'buy', orderId: 'b2', bodyId: 'old-body', size: 1, quoteAmount: 50 },
      { side: 'sell', orderId: 's1', size: 1.5, quoteAmount: 120 },
      { side: 'sell', orderId: 's2', bodyId: 'old-body', size: 2, quoteAmount: 120 },
      { side: 'sell', orderId: 's3', size: 1, quoteAmount: 80 },
      { side: 'sell', orderId: 's3', size: 1, quoteAmount: 80, bodyPnl: 10, bodyHoldbackAsset: 0.1, bodyReservesSoldAsset: 0.2 },
    ];
    const ledger = { getAllFills: () => fills };
    ct.migrateFromFills(ledger);
    ct.migrateFromFills(ledger);
    const rows = ct.getAll().map(t => [t.sellOrderId, t.costBasis, t.pnl, t.holdbackAsset, t.reservesSoldAsset]).sort();
    assert.deepEqual(rows, [['s1', 75, 45, 0.5, 0], ['s2', 50, 70, 0, 0], ['s3', 150, 10, 0.1, 0.2]]);
  });

  it('records a sell once even if qtySold differs between live and migration paths', () => {
    const { createClosedTrades } = freshModule();
    const ct = createClosedTrades('test-exchange');

    // Live path records with qtySold over newly-ingested fills
    assert.equal(ct.record(baseTrade({ qtySold: 0.0009 })), true);
    // Migration path recomputes qtySold over ALL rows for the same sellOrderId
    // → different qty, but the SAME sell. Must be deduped, not double-recorded.
    assert.equal(ct.record(baseTrade({ qtySold: 0.001, source: 'migration' })), false);

    assert.equal(ct.getCount(), 1);
    assert.equal(ct.getTotalPnL(), 5, 'totalPnl must not double-count the same sell');
  });

  it('accumulates two bookings into one row and matches ledger-derived totals (issue #786)', () => {
    const { createClosedTrades } = freshModule();
    const { createFillLedger } = freshFillLedgerModule();
    const ct = createClosedTrades('test-exchange');
    const ledger = createFillLedger('test-exchange', 'BTC-USDC', 'BTC-USDC', { quiet: true });
    ledger.startNewCycle();

    ledger.ingestFill({
      tradeId: 'buy-1', orderId: 'buy-1', side: 'buy', price: '100000', size: '0.003',
      totalCommission: '0', rebate: '0', liquidityIndicator: 'TAKER', tradeTime: new Date(1000).toISOString(),
    });
    ledger.ingestFill({
      tradeId: 'sell-1', orderId: 'sell-1', side: 'sell', price: '50500', size: '0.002',
      totalCommission: '0.02', rebate: '0', liquidityIndicator: 'MAKER', tradeTime: new Date(2000).toISOString(),
    });
    ledger.ingestFill({
      tradeId: 'sell-2', orderId: 'sell-1', side: 'sell', price: '50500', size: '0.001',
      totalCommission: '0.02', rebate: '0', liquidityIndicator: 'MAKER', tradeTime: new Date(3000).toISOString(),
    });
    ledger.annotateFillsByOrderId('buy-1', { sellOrderId: 'sell-1', bodyId: 'body-1', isBodyOwned: true });
    ledger.annotateFillsByOrderId('sell-1', {
      bodyId: 'body-1',
      bodyPnl: 1.46,
      bodyHoldbackAsset: 0.0005,
      bodyReservesSoldAsset: 0.0001,
    });
    const ledgerDerived = ledger.getDerivedRealizedPnL();

    const first = baseTrade({
      qtySold: 0.002,
      sellProceeds: 100.98,
      sellFees: 0.02,
      costBasis: 100,
      pnl: 0.98,
      holdbackAsset: 0.0002,
      timestamp: 2000,
    });
    const second = baseTrade({
      qtySold: 0.001,
      sellProceeds: 50.48,
      sellFees: 0.02,
      costBasis: 50,
      pnl: 0.48,
      holdbackAsset: 0.0003,
      reservesSoldAsset: 0.0001,
      timestamp: 3000,
      buyOrderIds: ['buy-1', 'buy-2'],
    });

    assert.equal(ct.record(first), true);
    assert.equal(ct.record(second, { additive: true }), true);
    assert.equal(ct.getCount(), 1, 'one sell order keeps one aggregate row');
    assert.equal(ct.getTotalPnL(), ledgerDerived.realizedPnL, 'audit P&L matches the ledger');
    assert.equal(ct.getTotalHoldback(), ledgerDerived.realizedAssetPnL, 'audit reserves match the ledger');
    assert.equal(ct.getAll()[0].qtySold, 0.003, 'both tranches are represented');
    assert.deepEqual(ct.getAll()[0].buyOrderIds, ['buy-1', 'buy-2']);

    assert.equal(ct.record(second), false, 'a replay does not add the second tranche again');
    assert.equal(ct.getTotalPnL(), ledgerDerived.realizedPnL);
  });

  it('nets a stale-TP reserves drawdown out of the total holdback (#770)', () => {
    const { createClosedTrades } = freshModule();
    const ct = createClosedTrades('test-exchange');
    ct.record(baseTrade({ sellOrderId: 'sell-1', holdbackAsset: 0.0003 }));
    ct.record(baseTrade({ sellOrderId: 'sell-2', holdbackAsset: 0, reservesSoldAsset: 0.0001 }));
    assert.equal(ct.getTotalHoldback(), 0.0002);
  });

  it('still records two genuinely different sells', () => {
    const { createClosedTrades } = freshModule();
    const ct = createClosedTrades('test-exchange');
    assert.equal(ct.record(baseTrade({ sellOrderId: 'sell-1', pnl: 5 })), true);
    assert.equal(ct.record(baseTrade({ sellOrderId: 'sell-2', pnl: 7 })), true);
    assert.equal(ct.getCount(), 2);
    assert.equal(ct.getTotalPnL(), 12);
  });

  it('does not collapse distinct no-sellOrderId legacy trades into one', () => {
    const { createClosedTrades } = freshModule();
    const ct = createClosedTrades('test-exchange');
    // Two distinct unlinked trades — keyed by qty:timestamp fallback
    assert.equal(ct.record(baseTrade({ sellOrderId: null, qtySold: 0.001, timestamp: 1000, pnl: 5 })), true);
    assert.equal(ct.record(baseTrade({ sellOrderId: null, qtySold: 0.001, timestamp: 2000, pnl: 6 })), true);
    assert.equal(ct.getCount(), 2);
  });

  it('dedups across a load() + record() reload cycle', () => {
    const { createClosedTrades } = freshModule();
    const ct1 = createClosedTrades('test-exchange');
    ct1.record(baseTrade({ qtySold: 0.0009 }));

    // New instance loads the persisted trade, then a migration re-records it
    const ct2 = createClosedTrades('test-exchange');
    ct2.load();
    assert.equal(ct2.record(baseTrade({ qtySold: 0.001, source: 'migration' })), false,
      'a reloaded sell must remain deduped against a re-derived migration qty');
    assert.equal(ct2.getCount(), 1);
  });
});

describe('Closed Trades unreadable file', () => {
  it('quarantines a truncated closed-trades.json with its original bytes before any persist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-trades-corrupt-'));
    fundPaths.getExchangeDataDir = (exchange) => {
      const d = path.join(dir, exchange);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    try {
      const { createClosedTrades } = freshModule();
      const ct = createClosedTrades('coinbase', 'BTC-USDC');
      const filePath = path.join(fundPaths.getExchangeDataDir('coinbase'), 'BTC-USDC', 'closed-trades.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '[{"sellOrderId":"a",');

      assert.equal(ct.load(), false);
      assert.equal(fs.existsSync(filePath), false);
      const q = fs.readdirSync(path.dirname(filePath)).filter(f => f.startsWith('closed-trades.json.corrupt-'));
      assert.equal(q.length, 1);
      assert.equal(fs.readFileSync(path.join(path.dirname(filePath), q[0]), 'utf8'), '[{"sellOrderId":"a",');
    } finally {
      fundPaths.getExchangeDataDir = originalGetExchangeDataDir;
      delete require.cache[closedTradesPath];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Closed Trades transient read error', () => {
  it('does not quarantine a valid closed-trades.json when readFileSync throws EIO', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-trades-eio-'));
    fundPaths.getExchangeDataDir = (exchange) => {
      const d = path.join(dir, exchange);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    try {
      const { createClosedTrades } = freshModule();
      const ct = createClosedTrades('coinbase', 'BTC-USDC');
      const filePath = path.join(fundPaths.getExchangeDataDir('coinbase'), 'BTC-USDC', 'closed-trades.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '[]');
      const realRead = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', (p, ...rest) => {
        if (p === filePath) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realRead(p, ...rest);
      });
      assert.throws(() => ct.load(), /EIO/);
      assert.equal(fs.existsSync(filePath), true);
      assert.equal(fs.readdirSync(path.dirname(filePath)).some(f => f.includes('.corrupt-')), false);
    } finally {
      fundPaths.getExchangeDataDir = originalGetExchangeDataDir;
      delete require.cache[closedTradesPath];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
