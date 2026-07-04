// @ts-check
/**
 * #205 — the backtest engine never debited the buy-side fee from the cash
 * ledger, so headline totalValue/roi assumed fee-free buys and the optimizer
 * was biased toward high-buy-count configs. Regression: with no sells and a
 * flat market, final wealth must equal starting capital minus every net fee.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runBacktest } = require('../src/backtest-engine');

const candle = (date, price) => ({
  date,
  timestamp: new Date(date).getTime(),
  open: price,
  high: price,
  low: price,
  close: price,
  highOfDay: price,
  lowOfDay: price,
});

const day = (n) => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

describe('#205 backtest buy-side fee leakage', () => {
  it('debits the buy fee from the cash ledger — no fee leakage in totalValue', async () => {
    const feePercent = 0.125; // 0.125% per side
    const rebatePercent = 0.031;
    const fundSize = 10_000;
    const buyAmount = 100;
    const price = 50_000;

    // Flat market: sell target (mid * 1.1) is never reached, so no sells fill
    // and the only cash movement is buys plus their fees.
    const prices = [1, 2, 3, 4, 5].map(n => candle(day(n), price));

    const result = await runBacktest({
      intervalBuyAmount: buyAmount,
      sellMarkupPercent: 10,
      holdbackPercent: 5,
      feePercent,
      rebatePercent,
      intervalType: 'daily',
      fundSize,
    }, prices);

    const { totalValue, netFees } = result.metrics;

    const perBuyNetFee = buyAmount * ((feePercent - rebatePercent) / 100);
    assert.ok(netFees > 0, 'net fees should be positive');
    assert.ok(Math.abs(netFees - perBuyNetFee * 5) < 1e-9, 'netFees should equal 5 buy net-fees');

    // Invariant: final wealth = starting capital minus every net fee. Before the
    // fix totalValue == fundSize (fees leaked), so this equality failed.
    assert.ok(
      Math.abs(totalValue - (fundSize - netFees)) < 1e-6,
      `totalValue ${totalValue} should equal fundSize - netFees ${fundSize - netFees}`,
    );
    assert.ok(totalValue < fundSize, 'fees must reduce total value below starting capital');

    // Cash ledger debited full cost (amount + net fee) on each buy.
    const expectedFinalCash = fundSize - 5 * (buyAmount + perBuyNetFee);
    assert.ok(
      Math.abs(result.metrics.finalAvailableFunds - expectedFinalCash) < 1e-6,
      `finalAvailableFunds ${result.metrics.finalAvailableFunds} should be ${expectedFinalCash}`,
    );
  });
});
