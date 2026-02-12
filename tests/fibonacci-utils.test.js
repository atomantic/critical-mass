// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  FIBONACCI,
  getFibonacciMultiplier,
  getFibonacciBuyAmount,
  getAverageCostBasis,
  getFibonacciSellPrice,
  getFibonacciSellQuantity,
  createInitialFibState,
  resetFibState,
  getFibonacciPreview,
  getFibonacciCumulativeSpend,
} = require('../src/fibonacci-utils');

// ============================================================================
// FIBONACCI constant
// ============================================================================
describe('FIBONACCI constant', () => {
  it('has 20 pre-computed entries', () => {
    assert.equal(FIBONACCI.length, 20);
  });

  it('starts with [1, 1] per standard Fibonacci', () => {
    assert.equal(FIBONACCI[0], 1);
    assert.equal(FIBONACCI[1], 1);
  });

  it('each entry equals the sum of the two preceding entries', () => {
    for (let i = 2; i < FIBONACCI.length; i++) {
      assert.equal(FIBONACCI[i], FIBONACCI[i - 1] + FIBONACCI[i - 2],
        `FIBONACCI[${i}] should be ${FIBONACCI[i - 1] + FIBONACCI[i - 2]} but got ${FIBONACCI[i]}`);
    }
  });

  it('ends with 6765 at index 19', () => {
    assert.equal(FIBONACCI[19], 6765);
  });
});

// ============================================================================
// getFibonacciMultiplier
// ============================================================================
describe('getFibonacciMultiplier', () => {
  it('returns 1 for position 0', () => {
    assert.equal(getFibonacciMultiplier(0), 1);
  });

  it('returns 1 for position 1', () => {
    assert.equal(getFibonacciMultiplier(1), 1);
  });

  it('returns correct values for mid-range positions', () => {
    assert.equal(getFibonacciMultiplier(5), 8);
    assert.equal(getFibonacciMultiplier(10), 89);
  });

  it('returns 1 for negative positions', () => {
    assert.equal(getFibonacciMultiplier(-1), 1);
    assert.equal(getFibonacciMultiplier(-100), 1);
  });

  it('returns the last pre-computed value at position 19', () => {
    assert.equal(getFibonacciMultiplier(19), 6765);
  });

  it('computes on-the-fly for positions beyond pre-computed range', () => {
    // Position 20 should be FIBONACCI[18] + FIBONACCI[19] = 4181 + 6765 = 10946
    assert.equal(getFibonacciMultiplier(20), 10946);
  });

  it('computes correctly for a large position beyond pre-computed range', () => {
    // Position 21 = 6765 + 10946 = 17711
    assert.equal(getFibonacciMultiplier(21), 17711);
    // Position 22 = 10946 + 17711 = 28657
    assert.equal(getFibonacciMultiplier(22), 28657);
  });
});

// ============================================================================
// getFibonacciBuyAmount
// ============================================================================
describe('getFibonacciBuyAmount', () => {
  it('returns baseAmount at position 0 (multiplier is 1)', () => {
    assert.equal(getFibonacciBuyAmount(0, 100), 100);
  });

  it('scales correctly at position 5 (multiplier is 8)', () => {
    assert.equal(getFibonacciBuyAmount(5, 50), 400);
  });

  it('returns 0 when baseAmount is 0', () => {
    assert.equal(getFibonacciBuyAmount(10, 0), 0);
  });

  it('handles fractional baseAmount', () => {
    const result = getFibonacciBuyAmount(2, 0.5);
    assert.equal(result, 1); // multiplier 2 * 0.5 = 1
  });

  it('returns baseAmount for negative positions (multiplier defaults to 1)', () => {
    assert.equal(getFibonacciBuyAmount(-5, 25), 25);
  });
});

// ============================================================================
// getAverageCostBasis
// ============================================================================
describe('getAverageCostBasis', () => {
  it('returns 0 when cumulativeBTC is 0', () => {
    assert.equal(getAverageCostBasis(1000, 0), 0);
  });

  it('returns 0 when cumulativeBTC is negative', () => {
    assert.equal(getAverageCostBasis(1000, -0.5), 0);
  });

  it('calculates correct average cost basis', () => {
    // $10,000 spent for 0.1 BTC = $100,000 per BTC
    assert.equal(getAverageCostBasis(10000, 0.1), 100000);
  });

  it('handles zero cost with positive BTC', () => {
    assert.equal(getAverageCostBasis(0, 0.5), 0);
  });
});

// ============================================================================
// getFibonacciSellPrice
// ============================================================================
describe('getFibonacciSellPrice', () => {
  it('applies markup correctly', () => {
    // $100,000 cost basis with 5% markup = $105,000
    assert.equal(getFibonacciSellPrice(100000, 5), 105000);
  });

  it('returns cost basis when markup is 0%', () => {
    assert.equal(getFibonacciSellPrice(50000, 0), 50000);
  });

  it('handles 100% markup', () => {
    assert.equal(getFibonacciSellPrice(50000, 100), 100000);
  });

  it('handles negative markup (selling below cost)', () => {
    // $100,000 with -10% markup = $90,000
    assert.equal(getFibonacciSellPrice(100000, -10), 90000);
  });
});

// ============================================================================
// getFibonacciSellQuantity
// ============================================================================
describe('getFibonacciSellQuantity', () => {
  it('holds back the correct percentage', () => {
    // 1 BTC with 10% holdback = sell 0.9 BTC
    assert.equal(getFibonacciSellQuantity(1, 10), 0.9);
  });

  it('sells everything when holdback is 0%', () => {
    assert.equal(getFibonacciSellQuantity(0.5, 0), 0.5);
  });

  it('sells nothing when holdback is 100%', () => {
    assert.equal(getFibonacciSellQuantity(0.5, 100), 0);
  });

  it('returns 0 when cumulativeBTC is 0', () => {
    assert.equal(getFibonacciSellQuantity(0, 25), 0);
  });
});

// ============================================================================
// createInitialFibState
// ============================================================================
describe('createInitialFibState', () => {
  it('returns an object with all expected fields', () => {
    const state = createInitialFibState();
    assert.equal(state.fibPosition, 0);
    assert.equal(state.fibCycleStartTime, null);
    assert.equal(state.fibCumulativeCost, 0);
    assert.equal(state.fibCumulativeBTC, 0);
    assert.equal(state.fibActiveSellOrderId, null);
    assert.equal(state.fibPendingHoldback, 0);
  });

  it('returns a new object on each call (no shared references)', () => {
    const state1 = createInitialFibState();
    const state2 = createInitialFibState();
    assert.notEqual(state1, state2);
    assert.deepStrictEqual(state1, state2);
  });
});

// ============================================================================
// resetFibState
// ============================================================================
describe('resetFibState', () => {
  it('returns the same shape as createInitialFibState', () => {
    const initial = createInitialFibState();
    const reset = resetFibState();
    assert.deepStrictEqual(reset, initial);
  });

  it('returns a fresh object on each call', () => {
    const reset1 = resetFibState();
    const reset2 = resetFibState();
    assert.notEqual(reset1, reset2);
  });
});

// ============================================================================
// getFibonacciPreview
// ============================================================================
describe('getFibonacciPreview', () => {
  it('returns default 8 entries when count is omitted', () => {
    const preview = getFibonacciPreview(10);
    assert.equal(preview.length, 8);
  });

  it('returns the correct buy amounts for baseAmount=10', () => {
    const preview = getFibonacciPreview(10, 5);
    // Multipliers for pos 0..4: 1, 1, 2, 3, 5
    assert.deepStrictEqual(preview, [10, 10, 20, 30, 50]);
  });

  it('returns an empty array when count is 0', () => {
    const preview = getFibonacciPreview(100, 0);
    assert.deepStrictEqual(preview, []);
  });

  it('handles count of 1', () => {
    const preview = getFibonacciPreview(25, 1);
    assert.deepStrictEqual(preview, [25]);
  });
});

// ============================================================================
// getFibonacciCumulativeSpend
// ============================================================================
describe('getFibonacciCumulativeSpend', () => {
  it('returns baseAmount for position 0 (single buy)', () => {
    assert.equal(getFibonacciCumulativeSpend(0, 100), 100);
  });

  it('sums first two positions correctly (both multiplier 1)', () => {
    // position 0: 1*100=100, position 1: 1*100=100, total=200
    assert.equal(getFibonacciCumulativeSpend(1, 100), 200);
  });

  it('sums through position 4 correctly', () => {
    // Multipliers: 1+1+2+3+5 = 12, at baseAmount 10 = 120
    assert.equal(getFibonacciCumulativeSpend(4, 10), 120);
  });

  it('returns 0 when baseAmount is 0', () => {
    assert.equal(getFibonacciCumulativeSpend(10, 0), 0);
  });
});
