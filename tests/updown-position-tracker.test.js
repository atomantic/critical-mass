const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('UpDown position tracker pricing', async () => {
  const {
    PRICE_STALE_MS,
    PERP_CONTRACT_SIZE_BTC,
    isFreshTick,
    calculateManualPositionPnl,
  } = await import('../admin/src/components/updown/position-tracker-math.js');
  const now = Date.UTC(2026, 0, 1);

  it('accepts fresh ticks through the service freshness boundary', () => {
    assert.equal(isFreshTick({ price: 100_000, timestamp: now }, now), true);
    assert.equal(isFreshTick({ price: 100_000, timestamp: now - PRICE_STALE_MS }, now), true);
  });

  it('rejects stale, absent, future-dated, and invalid ticks', () => {
    assert.equal(isFreshTick({ price: 100_000, timestamp: now - PRICE_STALE_MS - 1 }, now), false);
    assert.equal(isFreshTick(null, now), false);
    assert.equal(isFreshTick({ price: 100_000, timestamp: now + 1 }, now), false);
    assert.equal(isFreshTick({ price: Number.NaN, timestamp: now }, now), false);
    assert.equal(isFreshTick({ price: 0, timestamp: now }, now), false);
    assert.equal(isFreshTick({ price: 100_000, timestamp: 'invalid' }, now), false);
  });

  it('retains the 0.01-BTC-per-contract manual P&L calculation', () => {
    assert.equal(PERP_CONTRACT_SIZE_BTC, 0.01);
    assert.deepEqual(calculateManualPositionPnl({
      currentPrice: 101_000,
      entryPrice: 100_000,
      contracts: 2,
      direction: 'Up',
    }), { pnl: 20, pnlPct: 1 });
  });

  it('does not calculate P&L without a valid qualified mark', () => {
    assert.equal(calculateManualPositionPnl({
      currentPrice: null,
      entryPrice: 100_000,
      contracts: 2,
      direction: 'Up',
    }), null);
  });
});
