// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { calculateApyMetrics, initializeApyTracking } = require('../src/apy-calculator');

// Helpers
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const basePositionState = () => ({
  engineStartTime: null,
  realizedPnL: 0,
  realizedBtcPnL: 0,
  totalCostBasis: 0,
  initialCapital: 0,
  depositedCapital: 0,
  originalCapital: 0,
  cyclesCompleted: 0,
});

const baseConfig = () => ({
  maxUsdcDeployed: 10000,
  depositedCapital: 0,
});

const baseMarketState = () => ({
  lastPrice: 100000,
});

// ============================================================================
// calculateApyMetrics
// ============================================================================
describe('calculateApyMetrics', () => {

  // --------------------------------------------------------------------------
  // Zero-return scenarios
  // --------------------------------------------------------------------------
  it('returns zero metrics when no engineStartTime', () => {
    const pos = basePositionState();
    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.equal(result.engineStartTime, null);
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.elapsedDays, 0);
    assert.equal(result.totalUsdcReturn, 0);
    assert.equal(result.totalBtcReturn, 0);
    assert.equal(result.totalLiquidValue, 0);
    assert.equal(result.estimatedApy, 0);
    assert.equal(result.dailyReturnPercent, 0);
    assert.equal(result.cyclesPerDay, 0);
    assert.equal(result.avgPnlPerCycle, 0);
  });

  it('returns zero metrics when engineStartTime set but no PnL', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 2 * MS_PER_DAY;
    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.equal(result.engineStartTime, pos.engineStartTime);
    assert.ok(result.elapsedMs > 0, 'elapsedMs should be non-zero since start time exists');
    assert.equal(result.elapsedDays, 0);
    assert.equal(result.totalUsdcReturn, 0);
    assert.equal(result.estimatedApy, 0);
  });

  it('returns zero metrics when only BTC PnL is zero and USDC PnL is zero', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 0;
    pos.realizedBtcPnL = 0;
    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.equal(result.totalLiquidValue, 0);
    assert.equal(result.estimatedApy, 0);
  });

  // --------------------------------------------------------------------------
  // Basic APY calculation with known elapsed time and returns
  // --------------------------------------------------------------------------
  it('calculates basic APY with USDC returns over known elapsed time', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 10 * MS_PER_DAY;
    pos.realizedPnL = 100; // $100 profit
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 20;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.ok(result.elapsedDays >= 9.9 && result.elapsedDays <= 10.1, `elapsedDays ~10: ${result.elapsedDays}`);
    assert.equal(result.totalUsdcReturn, 100);
    assert.ok(result.totalUsdcReturnPercent > 0, 'USDC return percent should be positive');
    assert.ok(result.estimatedApy > 0, 'APY should be positive');
    assert.ok(result.estimatedAnnualReturn > 0, 'Annual return should be positive');
    assert.ok(result.dailyReturnPercent > 0, 'Daily return percent should be positive');
  });

  // --------------------------------------------------------------------------
  // Both USDC and BTC returns combined into total liquid value
  // --------------------------------------------------------------------------
  it('combines USDC and BTC returns into totalLiquidValue', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 5 * MS_PER_DAY;
    pos.realizedPnL = 50;        // $50 USDC
    pos.realizedBtcPnL = 0.001;  // 0.001 BTC
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 10;

    const market = baseMarketState();
    market.lastPrice = 100000;    // BTC @ $100k

    const result = calculateApyMetrics(pos, baseConfig(), market);

    // BTC value in USD: 0.001 * 100000 = $100
    assert.equal(result.btcValueUsd, 100);
    // Total liquid: $50 + $100 = $150
    assert.equal(result.totalLiquidValue, 150);
    assert.equal(result.totalReturn, 150);
    // Percent of initial capital
    assert.equal(result.totalLiquidValuePercent, 1.5); // 150/10000 * 100 = 1.5%
    assert.equal(result.totalReturnPercent, 1.5);
  });

  it('handles BTC returns with zero USDC returns', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 3 * MS_PER_DAY;
    pos.realizedPnL = 0;
    pos.realizedBtcPnL = 0.0005;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 5;

    const market = baseMarketState();
    market.lastPrice = 100000;

    const result = calculateApyMetrics(pos, baseConfig(), market);

    // BTC value: 0.0005 * 100000 = $50
    assert.equal(result.btcValueUsd, 50);
    assert.equal(result.totalLiquidValue, 50);
    assert.equal(result.totalUsdcReturn, 0);
    assert.ok(result.estimatedApy > 0, 'APY should be positive from BTC returns');
  });

  // --------------------------------------------------------------------------
  // Deposited capital fallback chain
  // --------------------------------------------------------------------------
  it('uses config.depositedCapital when > 0', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 10;
    pos.initialCapital = 10000;

    const config = baseConfig();
    config.depositedCapital = 8000;

    const result = calculateApyMetrics(pos, config, baseMarketState());
    assert.equal(result.depositedCapital, 8000);
    assert.equal(result.originalCapital, 8000);
  });

  it('falls back to positionState.depositedCapital when config.depositedCapital is 0', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 10;
    pos.initialCapital = 10000;
    pos.depositedCapital = 7500;

    const config = baseConfig();
    config.depositedCapital = 0;

    const result = calculateApyMetrics(pos, config, baseMarketState());
    assert.equal(result.depositedCapital, 7500);
  });

  it('falls back to positionState.originalCapital when depositedCapital is 0', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 10;
    pos.initialCapital = 10000;
    pos.depositedCapital = 0;
    pos.originalCapital = 9000;

    const config = baseConfig();
    config.depositedCapital = 0;

    const result = calculateApyMetrics(pos, config, baseMarketState());
    assert.equal(result.depositedCapital, 9000);
  });

  it('derives depositedCapital from maxUsdcDeployed - realizedPnL when all fallbacks are 0', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 200;
    pos.initialCapital = 10000;
    pos.depositedCapital = 0;
    pos.originalCapital = 0;

    const config = baseConfig();
    config.depositedCapital = 0;
    config.maxUsdcDeployed = 10000;

    const result = calculateApyMetrics(pos, config, baseMarketState());
    // autoDerived = max(0, round(10000 - 200)) = 9800
    assert.equal(result.depositedCapital, 9800);
  });

  // --------------------------------------------------------------------------
  // Elapsed days calculation
  // --------------------------------------------------------------------------
  it('calculates elapsedDays correctly for multi-day period', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 7 * MS_PER_DAY;
    pos.realizedPnL = 50;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 14;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());
    assert.ok(result.elapsedDays >= 6.99 && result.elapsedDays <= 7.01, `elapsedDays ~7: ${result.elapsedDays}`);
  });

  // --------------------------------------------------------------------------
  // Minimum hours for projection (1 hour threshold)
  // --------------------------------------------------------------------------
  it('returns zero projections when elapsed time < 1 hour', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 30 * 60 * 1000; // 30 minutes ago
    pos.realizedPnL = 5;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 2;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.ok(result.elapsedMs > 0, 'elapsedMs should be positive');
    assert.equal(result.dailyReturnPercent, 0, 'Daily return should be 0 under 1 hour');
    assert.equal(result.estimatedApy, 0, 'APY should be 0 under 1 hour');
    assert.equal(result.estimatedAnnualReturn, 0, 'Annual return should be 0 under 1 hour');
    assert.equal(result.estimatedDailyUsdc, 0, 'Daily USDC should be 0 under 1 hour');
    assert.equal(result.cyclesPerDay, 0, 'Cycles per day should be 0 under 1 hour');
  });

  it('calculates projections when elapsed time >= 1 hour', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 2 * MS_PER_HOUR; // 2 hours ago
    pos.realizedPnL = 5;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 4;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.ok(result.dailyReturnPercent > 0, 'Daily return should be positive after 1 hour');
    assert.ok(result.estimatedApy > 0, 'APY should be positive after 1 hour');
    assert.ok(result.estimatedDailyUsdc > 0, 'Daily USDC should be positive after 1 hour');
    assert.ok(result.cyclesPerDay > 0, 'Cycles per day should be positive after 1 hour');
  });

  // --------------------------------------------------------------------------
  // Compound APY calculation
  // --------------------------------------------------------------------------
  it('calculates compound APY correctly for known daily return', () => {
    // 1% daily return over 10 days on $10000 capital
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 10 * MS_PER_DAY;
    pos.realizedPnL = 1000; // 10% total = 1% per day
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 100;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    // dailyReturn ~1%, compound APY = (1.01^365 - 1) * 100 = ~3678%
    assert.ok(result.estimatedApy > 3000, `APY should be > 3000%: ${result.estimatedApy}`);
    assert.ok(result.estimatedApy < 4000, `APY should be < 4000%: ${result.estimatedApy}`);
  });

  it('caps daily return decimal at 10% to prevent extreme APY', () => {
    // 50% daily return (extreme) - dailyReturnDecimal is capped at 0.1
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 1 * MS_PER_DAY;
    pos.realizedPnL = 5000; // 50% return in 1 day
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 10;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    // dailyReturnDecimal capped at 0.1, APY = (1.1^365 - 1) * 100, also capped at 99999
    assert.ok(result.estimatedApy <= 99999, `APY should be capped at 99999: ${result.estimatedApy}`);
  });

  // --------------------------------------------------------------------------
  // Cycles per day and avg PnL per cycle
  // --------------------------------------------------------------------------
  it('calculates cyclesPerDay and avgPnlPerCycle', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 5 * MS_PER_DAY;
    pos.realizedPnL = 250;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 50;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    // cyclesPerDay = 50 / 5 = 10
    assert.ok(result.cyclesPerDay >= 9.9 && result.cyclesPerDay <= 10.1, `cyclesPerDay ~10: ${result.cyclesPerDay}`);
    // avgPnlPerCycle = 250 / 50 = 5
    assert.equal(result.avgPnlPerCycle, 5);
  });

  it('returns avgPnlPerCycle as 0 when no cycles completed', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 2 * MS_PER_DAY;
    pos.realizedPnL = 0;
    pos.realizedBtcPnL = 0.001; // non-zero BTC to avoid zero-return short-circuit
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 0;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.equal(result.avgPnlPerCycle, 0);
  });

  // --------------------------------------------------------------------------
  // Capital and position fields
  // --------------------------------------------------------------------------
  it('calculates availableCapital from maxUsdcDeployed minus totalCostBasis', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 3 * MS_PER_DAY;
    pos.realizedPnL = 30;
    pos.initialCapital = 10000;
    pos.totalCostBasis = 3000;
    pos.cyclesCompleted = 6;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const result = calculateApyMetrics(pos, config, baseMarketState());

    assert.equal(result.maxUsdcDeployed, 10000);
    assert.equal(result.deployedInPosition, 3000);
    assert.equal(result.availableCapital, 7000);
    assert.equal(result.currentCapital, 10000);
    assert.equal(result.deployedCapital, 3000);
  });

  it('defaults maxUsdcDeployed to 10000 when not in config', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 5;
    pos.initialCapital = 10000;

    const config = {};
    const result = calculateApyMetrics(pos, config, baseMarketState());

    assert.equal(result.maxUsdcDeployed, 10000);
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------
  it('handles very large returns without overflow', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 365 * MS_PER_DAY;
    pos.realizedPnL = 500000;
    pos.realizedBtcPnL = 5.0;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 10000;

    const market = baseMarketState();
    market.lastPrice = 100000;

    const result = calculateApyMetrics(pos, baseConfig(), market);

    assert.ok(Number.isFinite(result.estimatedApy), 'APY should be finite');
    assert.ok(Number.isFinite(result.totalLiquidValue), 'Total liquid value should be finite');
    // totalLiquidValue = 500000 + 5.0 * 100000 = 1000000
    assert.equal(result.totalLiquidValue, 1000000);
    assert.ok(result.estimatedApy <= 99999, 'APY should be capped at 99999');
  });

  it('handles very short elapsed time just above 1 hour', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - (MS_PER_HOUR + 1000); // 1 hour + 1 second
    pos.realizedPnL = 1;
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 1;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.ok(result.dailyReturnPercent > 0, 'Should have daily return just above 1h threshold');
    assert.ok(result.estimatedApy > 0, 'Should have APY just above 1h threshold');
  });

  it('handles negative USDC PnL with positive BTC PnL', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 5 * MS_PER_DAY;
    pos.realizedPnL = -50;       // lost $50 USDC
    pos.realizedBtcPnL = 0.002;  // gained BTC
    pos.initialCapital = 10000;
    pos.cyclesCompleted = 10;

    const market = baseMarketState();
    market.lastPrice = 100000;

    const result = calculateApyMetrics(pos, baseConfig(), market);

    // totalLiquid = -50 + 0.002 * 100000 = -50 + 200 = 150
    assert.equal(result.totalLiquidValue, 150);
    assert.equal(result.totalUsdcReturn, -50);
    assert.equal(result.btcValueUsd, 200);
  });

  it('clamps availableCapital to zero when totalCostBasis exceeds maxUsdcDeployed', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - MS_PER_DAY;
    pos.realizedPnL = 5;
    pos.initialCapital = 10000;
    pos.totalCostBasis = 15000; // over-deployed
    pos.cyclesCompleted = 2;

    const result = calculateApyMetrics(pos, baseConfig(), baseMarketState());

    assert.equal(result.availableCapital, 0, 'availableCapital should clamp to 0');
  });
});

// ============================================================================
// initializeApyTracking
// ============================================================================
describe('initializeApyTracking', () => {

  it('starts fresh tracking when no filled orders and no existing start time', () => {
    const pos = basePositionState();
    const config = baseConfig();
    config.maxUsdcDeployed = 5000;

    const before = Date.now();
    initializeApyTracking(pos, config, 'test-exchange', () => []);
    const after = Date.now();

    assert.ok(pos.engineStartTime >= before && pos.engineStartTime <= after, 'engineStartTime should be ~now');
    assert.equal(pos.initialCapital, 5000);
    assert.equal(pos.originalCapital, 5000);
    assert.equal(pos.depositedCapital, 5000);
  });

  it('backfills start time from filled orders when earlier than current', () => {
    const pos = basePositionState();
    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const orderTime = Date.now() - 10 * MS_PER_DAY;
    const filledOrders = [
      { placedAt: orderTime, filledAt: orderTime + 1000 },
      { placedAt: orderTime + MS_PER_DAY, filledAt: orderTime + MS_PER_DAY + 500 },
    ];

    initializeApyTracking(pos, config, 'test-exchange', () => filledOrders);

    assert.equal(pos.engineStartTime, orderTime, 'Should use earliest placedAt');
    assert.equal(pos.initialCapital, 10000);
    assert.equal(pos.originalCapital, 10000);
    assert.equal(pos.depositedCapital, 10000);
  });

  it('uses filledAt when placedAt is not available', () => {
    const pos = basePositionState();
    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const fillTime = Date.now() - 5 * MS_PER_DAY;
    const filledOrders = [
      { filledAt: fillTime },
      { filledAt: fillTime + MS_PER_HOUR },
    ];

    initializeApyTracking(pos, config, 'test-exchange', () => filledOrders);

    assert.equal(pos.engineStartTime, fillTime, 'Should use earliest filledAt');
  });

  it('does not overwrite engineStartTime when it is already older than filled orders', () => {
    const pos = basePositionState();
    const existingStart = Date.now() - 20 * MS_PER_DAY;
    pos.engineStartTime = existingStart;
    pos.initialCapital = 10000;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const orderTime = Date.now() - 5 * MS_PER_DAY;
    const filledOrders = [{ placedAt: orderTime }];

    initializeApyTracking(pos, config, 'test-exchange', () => filledOrders);

    assert.equal(pos.engineStartTime, existingStart, 'Should keep older existing start time');
  });

  it('overwrites engineStartTime when filled orders are earlier', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 2 * MS_PER_DAY;
    pos.initialCapital = 10000;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const orderTime = Date.now() - 15 * MS_PER_DAY;
    const filledOrders = [{ placedAt: orderTime }];

    initializeApyTracking(pos, config, 'test-exchange', () => filledOrders);

    assert.equal(pos.engineStartTime, orderTime, 'Should backfill to earlier order time');
  });

  it('restores tracking when engineStartTime already set and no filled orders', () => {
    const pos = basePositionState();
    const existingStart = Date.now() - 7 * MS_PER_DAY;
    pos.engineStartTime = existingStart;
    pos.initialCapital = 10000;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    initializeApyTracking(pos, config, 'test-exchange', () => []);

    assert.equal(pos.engineStartTime, existingStart, 'Should preserve existing start time');
    assert.equal(pos.originalCapital, 10000);
  });

  it('sets originalCapital from initialCapital when not already set (restore path)', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 3 * MS_PER_DAY;
    pos.initialCapital = 8000;
    pos.originalCapital = 0;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    initializeApyTracking(pos, config, 'test-exchange', () => []);

    assert.equal(pos.originalCapital, 8000, 'Should set originalCapital from initialCapital');
  });

  it('derives depositedCapital from maxUsdcDeployed - profits when not set', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 3 * MS_PER_DAY;
    pos.initialCapital = 10000;
    pos.originalCapital = 0;
    pos.depositedCapital = 0;
    pos.realizedPnL = 500;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    initializeApyTracking(pos, config, 'test-exchange', () => []);

    // ensureDepositedCapital: originalCapital is 0, so derived = round(max(0, 10000 - 500)) = 9500
    // But first originalCapital gets set to initialCapital (10000) since it was 0/falsy
    // Then ensureDepositedCapital sees originalCapital > 0 (10000), uses that
    assert.equal(pos.depositedCapital, 10000);
  });

  it('handles getFilledOrders being undefined', () => {
    const pos = basePositionState();
    const config = baseConfig();
    config.maxUsdcDeployed = 5000;

    const before = Date.now();
    initializeApyTracking(pos, config, 'test-exchange');
    const after = Date.now();

    assert.ok(pos.engineStartTime >= before && pos.engineStartTime <= after, 'Should start fresh when no getter');
    assert.equal(pos.initialCapital, 5000);
  });

  it('preserves existing depositedCapital when already set', () => {
    const pos = basePositionState();
    pos.engineStartTime = Date.now() - 5 * MS_PER_DAY;
    pos.initialCapital = 10000;
    pos.originalCapital = 10000;
    pos.depositedCapital = 7777;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    initializeApyTracking(pos, config, 'test-exchange', () => []);

    assert.equal(pos.depositedCapital, 7777, 'Should not overwrite existing depositedCapital');
  });

  it('defaults maxUsdcDeployed to 10000 when not in config (fresh start)', () => {
    const pos = basePositionState();
    const config = {};

    initializeApyTracking(pos, config, 'test-exchange', () => []);

    assert.equal(pos.initialCapital, 10000);
    assert.equal(pos.originalCapital, 10000);
    assert.equal(pos.depositedCapital, 10000);
  });

  it('sets originalCapital on backfill when not already set', () => {
    const pos = basePositionState();
    pos.originalCapital = 0;

    const config = baseConfig();
    config.maxUsdcDeployed = 12000;

    const orderTime = Date.now() - 10 * MS_PER_DAY;
    initializeApyTracking(pos, config, 'test-exchange', () => [{ placedAt: orderTime }]);

    assert.equal(pos.originalCapital, 12000, 'Should set originalCapital to initialCapital on backfill');
    assert.equal(pos.initialCapital, 12000);
  });

  it('preserves originalCapital on backfill when already set', () => {
    const pos = basePositionState();
    pos.originalCapital = 9500;

    const config = baseConfig();
    config.maxUsdcDeployed = 10000;

    const orderTime = Date.now() - 10 * MS_PER_DAY;
    initializeApyTracking(pos, config, 'test-exchange', () => [{ placedAt: orderTime }]);

    assert.equal(pos.originalCapital, 9500, 'Should preserve existing originalCapital on backfill');
  });
});
