// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const closedTradesPath = require.resolve('../src/closed-trades');
const migration = require('../src/migration');
const originalGetExchangeDataDir = migration.getExchangeDataDir;

/** @type {string|null} */
let tmpDir = null;

const freshModule = () => {
  delete require.cache[closedTradesPath];
  return require('../src/closed-trades');
};

describe('Closed Trades dedup key (issue #108)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-trades-test-'));
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    delete require.cache[closedTradesPath];
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
