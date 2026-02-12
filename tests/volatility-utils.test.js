// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateTrueRange,
  calculateATR,
  calculateRealizedVol,
  calculateVWAP,
  calculateSwingRange,
  updateEMABaseline,
  calculateMomentum,
  calculateAllMetrics,
  calculateVolExpansion,
  calculateVWAPDistance,
  calculateEMA,
  clamp,
  roundBTC,
  roundUSDC,
  roundPrice,
} = require('../src/volatility-utils');

// ============================================================================
// Helper: create a candle object
// ============================================================================
const mkCandle = (open, high, low, close, volume = 100, timestamp = Date.now()) => ({
  open, high, low, close, volume, timestamp,
});

// ============================================================================
// roundBTC
// ============================================================================
describe('roundBTC', () => {
  it('rounds to 8 decimal places', () => {
    assert.equal(roundBTC(0.123456789), 0.12345679);
  });

  it('returns 0 for 0', () => {
    assert.equal(roundBTC(0), 0);
  });

  it('handles negative values', () => {
    // -0.000000005 * 1e8 = -0.5, Math.round(-0.5) = -0 in JS
    assert.equal(roundBTC(-0.000000005), -0);
  });

  it('handles very small amounts below satoshi threshold', () => {
    assert.equal(roundBTC(0.000000001), 0);
  });

  it('handles whole numbers', () => {
    assert.equal(roundBTC(1), 1);
  });

  it('handles large BTC amounts', () => {
    assert.equal(roundBTC(21000000.123456789), 21000000.12345679);
  });
});

// ============================================================================
// roundUSDC
// ============================================================================
describe('roundUSDC', () => {
  it('rounds to 2 decimal places', () => {
    assert.equal(roundUSDC(1.999), 2);
  });

  it('returns 0 for 0', () => {
    assert.equal(roundUSDC(0), 0);
  });

  it('handles negative values', () => {
    // -5.555 * 100 = -555.5, Math.round(-555.5) = -555 in JS (rounds toward +Infinity)
    assert.equal(roundUSDC(-5.555), -5.55);
  });

  it('rounds standard fractional values', () => {
    // 1.005 * 100 = 100.49999... due to IEEE 754, rounds to 100 => 1.00
    assert.equal(roundUSDC(1.005), 1);
  });

  it('handles large values', () => {
    assert.equal(roundUSDC(1000000.456), 1000000.46);
  });
});

// ============================================================================
// roundPrice
// ============================================================================
describe('roundPrice', () => {
  it('rounds to default increment of 0.01', () => {
    const result = roundPrice(100.456);
    assert.ok(Math.abs(result - 100.46) < 1e-10);
  });

  it('rounds to custom increment of 0.05', () => {
    const result = roundPrice(100.47, 0.05);
    assert.ok(Math.abs(result - 100.45) < 1e-10);
  });

  it('rounds to whole number increment', () => {
    const result = roundPrice(1234.56, 1);
    assert.equal(result, 1235);
  });

  it('handles zero price', () => {
    assert.equal(roundPrice(0), 0);
  });

  it('handles large price increments', () => {
    const result = roundPrice(97500, 500);
    assert.equal(result, 97500);
  });

  it('rounds to 10-dollar increment', () => {
    const result = roundPrice(97543, 10);
    assert.equal(result, 97540);
  });
});

// ============================================================================
// clamp
// ============================================================================
describe('clamp', () => {
  it('returns value when within range', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it('clamps to min when below', () => {
    assert.equal(clamp(-1, 0, 10), 0);
  });

  it('clamps to max when above', () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  it('handles min equal to max', () => {
    assert.equal(clamp(5, 3, 3), 3);
  });

  it('handles negative range', () => {
    assert.equal(clamp(0, -10, -1), -1);
  });
});

// ============================================================================
// calculateTrueRange
// ============================================================================
describe('calculateTrueRange', () => {
  it('returns high - low when no previous close', () => {
    const candle = mkCandle(100, 110, 90, 105);
    assert.equal(calculateTrueRange(candle), 20);
  });

  it('uses high-low when it is the max component', () => {
    // high-low = 20, |high-prevClose| = 10, |low-prevClose| = 10
    const candle = mkCandle(100, 110, 90, 105);
    assert.equal(calculateTrueRange(candle, 100), 20);
  });

  it('uses |high - prevClose| when it is the max component', () => {
    // Gap up: prevClose was 80, high 110, low 100
    // high-low = 10, |high-prevClose| = 30, |low-prevClose| = 20
    const candle = mkCandle(100, 110, 100, 105);
    assert.equal(calculateTrueRange(candle, 80), 30);
  });

  it('uses |low - prevClose| when it is the max component', () => {
    // Gap down: prevClose was 120, high 105, low 90
    // high-low = 15, |high-prevClose| = 15, |low-prevClose| = 30
    const candle = mkCandle(95, 105, 90, 95);
    assert.equal(calculateTrueRange(candle, 120), 30);
  });

  it('handles zero-range candle (doji)', () => {
    const candle = mkCandle(100, 100, 100, 100);
    assert.equal(calculateTrueRange(candle, 100), 0);
  });
});

// ============================================================================
// calculateATR
// ============================================================================
describe('calculateATR', () => {
  it('returns 0 for null input', () => {
    assert.equal(calculateATR(null), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(calculateATR([]), 0);
  });

  it('returns 0 for single candle', () => {
    assert.equal(calculateATR([mkCandle(100, 110, 90, 105)]), 0);
  });

  it('calculates simple average when candles < period', () => {
    const candles = [
      mkCandle(100, 110, 90, 105),
      mkCandle(105, 115, 95, 110),
    ];
    const atr = calculateATR(candles, 14);
    // TR[0] = 110-90 = 20 (no prevClose), TR[1] = max(20, |115-105|, |95-105|) = 20
    // Average = (20+20)/2 = 20
    assert.equal(atr, 20);
  });

  it('applies Wilder smoothing when candles >= period', () => {
    // Create 16 candles with uniform TR of 10
    const candles = [];
    for (let i = 0; i < 16; i++) {
      candles.push(mkCandle(100 + i, 105 + i, 95 + i, 100 + i));
    }
    const atr = calculateATR(candles, 14);
    // All TRs are 10, so ATR should be ~10 after smoothing
    assert.ok(Math.abs(atr - 10) < 0.5);
  });

  it('respects custom period parameter', () => {
    const candles = [
      mkCandle(100, 110, 90, 100),
      mkCandle(100, 115, 85, 100),
      mkCandle(100, 120, 80, 100),
    ];
    // period=2: initial ATR = avg of first 2 TRs, then smooth with 3rd
    const atr = calculateATR(candles, 2);
    assert.ok(atr > 0);
  });
});

// ============================================================================
// calculateRealizedVol
// ============================================================================
describe('calculateRealizedVol', () => {
  it('returns 0 for null input', () => {
    assert.equal(calculateRealizedVol(null), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(calculateRealizedVol([]), 0);
  });

  it('returns 0 for single candle', () => {
    assert.equal(calculateRealizedVol([mkCandle(100, 100, 100, 100)]), 0);
  });

  it('returns 0 for two candles with same close (zero variance)', () => {
    const candles = [
      mkCandle(100, 100, 100, 100),
      mkCandle(100, 100, 100, 100),
    ];
    // Only 1 return, need at least 2 for stddev denominator (n-1)
    assert.equal(calculateRealizedVol(candles), 0);
  });

  it('calculates non-zero volatility for varying closes', () => {
    const candles = [
      mkCandle(100, 105, 95, 100),
      mkCandle(100, 110, 90, 110),
      mkCandle(110, 115, 105, 105),
      mkCandle(105, 112, 98, 108),
    ];
    const vol = calculateRealizedVol(candles, 30);
    assert.ok(vol > 0, `Volatility should be > 0, got ${vol}`);
  });

  it('uses only last window returns', () => {
    // 10 candles, window=3 means only last 3 log returns used
    const candles = [];
    for (let i = 0; i < 10; i++) {
      candles.push(mkCandle(100 + i, 105 + i, 95 + i, 100 + i));
    }
    const volSmallWindow = calculateRealizedVol(candles, 3);
    const volLargeWindow = calculateRealizedVol(candles, 30);
    // Both should be > 0 but potentially different values
    assert.ok(volSmallWindow > 0);
    assert.ok(volLargeWindow > 0);
  });

  it('returns percentage (multiplied by 100)', () => {
    // Two candles with 10% move: log(110/100) ~ 0.0953
    // Std dev of single return is 0, but with 3 candles we get a real stddev
    const candles = [
      mkCandle(100, 100, 100, 100),
      mkCandle(100, 110, 100, 110),
      mkCandle(110, 115, 105, 105),
    ];
    const vol = calculateRealizedVol(candles, 30);
    // Should be expressed as percentage
    assert.ok(vol > 0.1, `Volatility should be > 0.1%, got ${vol}`);
  });
});

// ============================================================================
// calculateVWAP
// ============================================================================
describe('calculateVWAP', () => {
  it('returns 0 for null input', () => {
    assert.equal(calculateVWAP(null), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(calculateVWAP([]), 0);
  });

  it('falls back to last close when no candles within period', () => {
    const oldTimestamp = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    const candles = [
      mkCandle(100, 110, 90, 105, 100, oldTimestamp),
    ];
    const vwap = calculateVWAP(candles, 4);
    assert.equal(vwap, 105); // last candle close
  });

  it('calculates correct VWAP for recent candles', () => {
    const now = Date.now();
    const candles = [
      mkCandle(100, 110, 90, 100, 200, now - 1000),
      mkCandle(100, 120, 80, 110, 300, now - 500),
    ];
    // TP1 = (110+90+100)/3 = 100, volume=200, PV=20000
    // TP2 = (120+80+110)/3 = 103.333, volume=300, PV=31000
    // VWAP = (20000+31000)/(200+300) = 51000/500 = 102
    const vwap = calculateVWAP(candles, 4);
    assert.ok(Math.abs(vwap - 102) < 0.01, `VWAP should be ~102, got ${vwap}`);
  });

  it('defaults volume to 1 when volume is 0', () => {
    const now = Date.now();
    const candles = [
      mkCandle(100, 110, 90, 100, 0, now - 1000),
    ];
    const vwap = calculateVWAP(candles, 4);
    // TP = (110+90+100)/3 = 100, volume=1 (default)
    assert.ok(Math.abs(vwap - 100) < 0.01);
  });
});

// ============================================================================
// calculateSwingRange
// ============================================================================
describe('calculateSwingRange', () => {
  it('returns 0 for null input', () => {
    assert.equal(calculateSwingRange(null), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(calculateSwingRange([]), 0);
  });

  it('returns high - low for single candle', () => {
    const candles = [mkCandle(100, 120, 80, 110)];
    assert.equal(calculateSwingRange(candles, 3), 40);
  });

  it('calculates range across multiple candles', () => {
    const candles = [
      mkCandle(100, 110, 90, 100),
      mkCandle(100, 120, 95, 115),
      mkCandle(115, 130, 85, 125),
    ];
    // High=130, Low=85, Range=45
    assert.equal(calculateSwingRange(candles, 3), 45);
  });

  it('only uses last N candles', () => {
    const candles = [
      mkCandle(100, 200, 10, 100), // Should be excluded with periods=2
      mkCandle(100, 110, 90, 100),
      mkCandle(100, 120, 80, 110),
    ];
    // Only last 2: high=120, low=80, range=40
    assert.equal(calculateSwingRange(candles, 2), 40);
  });

  it('handles zero-range candles', () => {
    const candles = [
      mkCandle(100, 100, 100, 100),
      mkCandle(100, 100, 100, 100),
    ];
    assert.equal(calculateSwingRange(candles, 3), 0);
  });
});

// ============================================================================
// updateEMABaseline
// ============================================================================
describe('updateEMABaseline', () => {
  it('returns currentVol when baseline is 0', () => {
    assert.equal(updateEMABaseline(5, 0), 5);
  });

  it('returns currentVol when baseline is undefined', () => {
    assert.equal(updateEMABaseline(5, undefined), 5);
  });

  it('applies EMA smoothing with default alpha 0.1', () => {
    // EMA = 0.1 * 10 + 0.9 * 5 = 1 + 4.5 = 5.5
    assert.equal(updateEMABaseline(10, 5), 5.5);
  });

  it('applies EMA smoothing with custom alpha', () => {
    // EMA = 0.5 * 10 + 0.5 * 5 = 5 + 2.5 = 7.5
    assert.equal(updateEMABaseline(10, 5, 0.5), 7.5);
  });

  it('converges toward currentVol with alpha=1', () => {
    // EMA = 1 * 10 + 0 * 5 = 10
    assert.equal(updateEMABaseline(10, 5, 1), 10);
  });

  it('stays at baseline with alpha=0', () => {
    // EMA = 0 * 10 + 1 * 5 = 5
    assert.equal(updateEMABaseline(10, 5, 0), 5);
  });
});

// ============================================================================
// calculateMomentum
// ============================================================================
describe('calculateMomentum', () => {
  it('returns neutral for null input', () => {
    const result = calculateMomentum(null);
    assert.equal(result.magnitude, 0);
    assert.equal(result.direction, 'neutral');
  });

  it('returns neutral for empty array', () => {
    const result = calculateMomentum([]);
    assert.equal(result.magnitude, 0);
    assert.equal(result.direction, 'neutral');
  });

  it('returns neutral when insufficient candles for longPeriod', () => {
    const candles = [
      mkCandle(100, 100, 100, 100),
      mkCandle(100, 100, 100, 105),
    ];
    // Default longPeriod=5, need at least 6 candles
    const result = calculateMomentum(candles);
    assert.equal(result.magnitude, 0);
    assert.equal(result.direction, 'neutral');
  });

  it('detects upward momentum when both periods align up', () => {
    const candles = [
      mkCandle(100, 100, 100, 100), // longAgo
      mkCandle(100, 100, 100, 102),
      mkCandle(100, 100, 100, 104),
      mkCandle(100, 100, 100, 106),
      mkCandle(100, 100, 100, 108), // shortAgo
      mkCandle(100, 100, 100, 110), // current
    ];
    const result = calculateMomentum(candles);
    assert.equal(result.direction, 'up');
    assert.ok(result.magnitude > 0);
  });

  it('detects downward momentum when both periods align down', () => {
    const candles = [
      mkCandle(100, 100, 100, 110), // longAgo
      mkCandle(100, 100, 100, 108),
      mkCandle(100, 100, 100, 106),
      mkCandle(100, 100, 100, 104),
      mkCandle(100, 100, 100, 102), // shortAgo
      mkCandle(100, 100, 100, 100), // current
    ];
    const result = calculateMomentum(candles);
    assert.equal(result.direction, 'down');
    assert.ok(result.magnitude > 0);
  });

  it('returns neutral on mixed signals (short up, long down)', () => {
    const candles = [
      mkCandle(100, 100, 100, 110), // longAgo (higher)
      mkCandle(100, 100, 100, 105),
      mkCandle(100, 100, 100, 100),
      mkCandle(100, 100, 100, 98),
      mkCandle(100, 100, 100, 99),  // shortAgo (lower than current)
      mkCandle(100, 100, 100, 105), // current (above shortAgo, below longAgo)
    ];
    const result = calculateMomentum(candles);
    assert.equal(result.direction, 'neutral');
    assert.equal(result.magnitude, 0);
  });
});

// ============================================================================
// calculateVolExpansion
// ============================================================================
describe('calculateVolExpansion', () => {
  it('returns 1 when baseline is 0', () => {
    assert.equal(calculateVolExpansion(5, 0), 1);
  });

  it('returns 1 when baseline is negative', () => {
    assert.equal(calculateVolExpansion(5, -1), 1);
  });

  it('returns ratio > 1 for expanding volatility', () => {
    assert.equal(calculateVolExpansion(10, 5), 2);
  });

  it('returns ratio < 1 for contracting volatility', () => {
    assert.equal(calculateVolExpansion(3, 6), 0.5);
  });

  it('returns 1 when vol equals baseline', () => {
    assert.equal(calculateVolExpansion(5, 5), 1);
  });

  it('handles zero realized vol', () => {
    assert.equal(calculateVolExpansion(0, 5), 0);
  });
});

// ============================================================================
// calculateVWAPDistance
// ============================================================================
describe('calculateVWAPDistance', () => {
  it('returns 0 when ATR is 0', () => {
    assert.equal(calculateVWAPDistance(100, 95, 0), 0);
  });

  it('returns 0 when ATR is negative', () => {
    assert.equal(calculateVWAPDistance(100, 95, -1), 0);
  });

  it('returns positive distance when price above VWAP', () => {
    // (100 - 90) / 5 = 2
    assert.equal(calculateVWAPDistance(100, 90, 5), 2);
  });

  it('returns negative distance when price below VWAP', () => {
    // (90 - 100) / 5 = -2
    assert.equal(calculateVWAPDistance(90, 100, 5), -2);
  });

  it('returns 0 when price equals VWAP', () => {
    assert.equal(calculateVWAPDistance(100, 100, 5), 0);
  });

  it('handles large ATR values correctly', () => {
    const dist = calculateVWAPDistance(100000, 99000, 5000);
    assert.ok(Math.abs(dist - 0.2) < 1e-10);
  });
});

// ============================================================================
// calculateEMA
// ============================================================================
describe('calculateEMA', () => {
  it('returns 0 for null input', () => {
    assert.equal(calculateEMA(null, 10), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(calculateEMA([], 10), 0);
  });

  it('returns 0 when candles < period', () => {
    const candles = [mkCandle(100, 100, 100, 100)];
    assert.equal(calculateEMA(candles, 10), 0);
  });

  it('returns SMA when candles length equals period', () => {
    const candles = [
      mkCandle(100, 100, 100, 10),
      mkCandle(100, 100, 100, 20),
      mkCandle(100, 100, 100, 30),
    ];
    // SMA of closes: (10+20+30)/3 = 20, no extra candles for EMA step
    assert.equal(calculateEMA(candles, 3), 20);
  });

  it('applies EMA formula for candles beyond period', () => {
    const candles = [
      mkCandle(100, 100, 100, 10),
      mkCandle(100, 100, 100, 20),
      mkCandle(100, 100, 100, 30),
      mkCandle(100, 100, 100, 40),
    ];
    // period=3, multiplier = 2/(3+1) = 0.5
    // SMA seed = (10+20+30)/3 = 20
    // EMA step: (40 - 20) * 0.5 + 20 = 30
    assert.equal(calculateEMA(candles, 3), 30);
  });

  it('handles constant prices (EMA equals price)', () => {
    const candles = Array.from({ length: 20 }, () => mkCandle(50, 50, 50, 50));
    assert.equal(calculateEMA(candles, 10), 50);
  });

  it('tracks trending prices correctly', () => {
    // Linearly increasing prices
    const candles = Array.from({ length: 20 }, (_, i) => mkCandle(i, i, i, i + 1));
    const ema = calculateEMA(candles, 10);
    // EMA should lag behind the latest close (21) but be above the midpoint
    assert.ok(ema > 10, `EMA should be above midpoint, got ${ema}`);
    assert.ok(ema < 21, `EMA should lag behind latest close, got ${ema}`);
  });
});

// ============================================================================
// calculateAllMetrics (integration)
// ============================================================================
describe('calculateAllMetrics', () => {
  const makeRecentCandles = (count, basePrice = 100) => {
    const now = Date.now();
    return Array.from({ length: count }, (_, i) => {
      const price = basePrice + (i % 3) * 2 - 2; // oscillate around basePrice
      return mkCandle(
        price - 1, price + 3, price - 3, price,
        100 + i * 10,
        now - (count - i) * 60000 // 1-minute intervals
      );
    });
  };

  it('returns all expected metric keys', () => {
    const candles1m = makeRecentCandles(30);
    const candles5m = makeRecentCandles(15);
    const metrics = calculateAllMetrics(candles1m, candles5m, 0);

    assert.ok('atr1m' in metrics);
    assert.ok('atr5m' in metrics);
    assert.ok('realizedVol' in metrics);
    assert.ok('volBaseline' in metrics);
    assert.ok('vwap' in metrics);
    assert.ok('recentSwing' in metrics);
    assert.ok('momentum' in metrics);
  });

  it('returns numeric values for all scalar metrics', () => {
    const candles1m = makeRecentCandles(30);
    const candles5m = makeRecentCandles(15);
    const metrics = calculateAllMetrics(candles1m, candles5m, 2.5);

    assert.equal(typeof metrics.atr1m, 'number');
    assert.equal(typeof metrics.atr5m, 'number');
    assert.equal(typeof metrics.realizedVol, 'number');
    assert.equal(typeof metrics.volBaseline, 'number');
    assert.equal(typeof metrics.vwap, 'number');
    assert.equal(typeof metrics.recentSwing, 'number');
  });

  it('returns valid momentum object', () => {
    const candles1m = makeRecentCandles(30);
    const candles5m = makeRecentCandles(15);
    const metrics = calculateAllMetrics(candles1m, candles5m, 0);

    assert.equal(typeof metrics.momentum.magnitude, 'number');
    assert.ok(['up', 'down', 'neutral'].includes(metrics.momentum.direction));
  });

  it('handles empty candle arrays gracefully', () => {
    const metrics = calculateAllMetrics([], [], 0);
    assert.equal(metrics.atr1m, 0);
    assert.equal(metrics.atr5m, 0);
    assert.equal(metrics.realizedVol, 0);
    assert.equal(metrics.vwap, 0);
    assert.equal(metrics.recentSwing, 0);
  });

  it('accepts custom config parameters', () => {
    const candles1m = makeRecentCandles(30);
    const candles5m = makeRecentCandles(15);
    const metrics = calculateAllMetrics(candles1m, candles5m, 1.0, {
      atrPeriod: 7,
      vwapPeriodHours: 1,
    });
    assert.ok(metrics.atr1m >= 0);
    assert.ok(metrics.vwap >= 0);
  });
});
