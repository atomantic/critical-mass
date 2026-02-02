// @ts-check
/**
 * Optimal TP Analysis Script
 *
 * Pulls 1 week of 1-minute data from Coinbase and simulates
 * the regime engine to find optimal TP settings.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getAdapter } = require('../src/adapters');
const { getRegimeConfig } = require('../src/config-utils');

const exchange = 'coinbase';
const productId = 'BTC-USDC';

async function fetchWeeklyData() {
  const adapter = getAdapter(exchange);
  const now = Math.floor(Date.now() / 1000);
  const oneWeekAgo = now - (7 * 24 * 60 * 60);

  console.log('📊 Fetching 1 week of 1-minute candles...');

  // Coinbase limits to 300 candles per request, so we need to batch
  const allCandles = [];
  const batchSize = 300; // 300 minutes = 5 hours
  const totalMinutes = 7 * 24 * 60; // 10080 minutes

  for (let i = 0; i < totalMinutes; i += batchSize) {
    const start = oneWeekAgo + (i * 60);
    const end = Math.min(start + (batchSize * 60), now);

    try {
      const candles = await adapter.getCandles(productId, start, end, 'ONE_MINUTE');
      if (candles && candles.length > 0) {
        allCandles.push(...candles);
      }
      // Rate limit protection
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.log('  Warning: Failed batch at ' + new Date(start * 1000).toISOString() + ': ' + err.message);
    }

    if (i % 1500 === 0) {
      console.log('  Progress: ' + Math.min(i + batchSize, totalMinutes) + '/' + totalMinutes + ' minutes (' + allCandles.length + ' candles)');
    }
  }

  // Sort by time and deduplicate
  const seen = new Set();
  const uniqueCandles = allCandles
    .filter(c => {
      const key = c.timestamp;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  console.log('✅ Fetched ' + uniqueCandles.length + ' unique candles\n');
  return uniqueCandles;
}

function simulateRegimeEngine(candles, config, tpPercent) {
  const results = {
    tpPercent,
    entries: 0,
    exits: 0,
    totalProfit: 0,
    avgHoldTime: 0,
    maxDrawdown: 0,
    winRate: 0,
    cycles: []
  };

  let position = null;
  let lastEntryTime = 0;
  let anchorPrice = 0;

  // Calculate ATR from recent candles
  const getATR = (idx, period) => {
    period = period || 14;
    if (idx < period) return candles[idx].high - candles[idx].low;

    let atrSum = 0;
    for (let i = idx - period; i < idx; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = i > 0 ? candles[i-1].close : candles[i].open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      atrSum += tr;
    }
    return atrSum / period;
  };

  const minIntervalMs = config.minIntervalMs || 60000;
  const maxIntervalMs = config.maxIntervalMs || 3600000;
  const kFactor = config.kFactor || 0.6;
  const baseSizeUsdc = config.baseSizeUsdc || 10;

  for (let i = 20; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const time = candle.timestamp;
    const atr = getATR(i);

    // Check for TP fill if we have a position
    if (position) {
      const tpPrice = position.entryPrice * (1 + tpPercent / 100);

      // Check if high touched TP price
      if (candle.high >= tpPrice) {
        const profit = (tpPrice - position.entryPrice) * position.btcQty;
        const holdTime = time - position.entryTime;

        results.exits++;
        results.totalProfit += profit;
        results.cycles.push({
          entryPrice: position.entryPrice,
          exitPrice: tpPrice,
          profit: profit,
          holdTime: holdTime,
          maxPrice: position.maxPrice,
          optimalTpPct: ((position.maxPrice - position.entryPrice) / position.entryPrice) * 100
        });

        position = null;
        anchorPrice = 0;
        continue;
      }

      // Track max price for optimal TP calculation
      if (candle.high > position.maxPrice) {
        position.maxPrice = candle.high;
      }
    }

    // Check for entry trigger (simplified regime logic)
    const timeSinceEntry = time - lastEntryTime;

    if (timeSinceEntry < minIntervalMs) continue;

    const priceMove = anchorPrice > 0 ? Math.abs(price - anchorPrice) : Infinity;
    const volTrigger = atr > 0 && priceMove >= kFactor * atr;
    const timeTrigger = timeSinceEntry >= maxIntervalMs;

    if (volTrigger || timeTrigger) {
      const btcQty = baseSizeUsdc / price;

      if (!position) {
        position = {
          entryPrice: price,
          entryTime: time,
          btcQty: btcQty,
          maxPrice: price
        };
        results.entries++;
      } else {
        // Add to position (DCA down)
        const newTotal = position.btcQty + btcQty;
        const newCost = (position.entryPrice * position.btcQty + price * btcQty);
        position.entryPrice = newCost / newTotal;
        position.btcQty = newTotal;
        results.entries++;
      }

      lastEntryTime = time;
      anchorPrice = price;
    }
  }

  // Calculate stats
  if (results.cycles.length > 0) {
    results.avgHoldTime = results.cycles.reduce(function(s, c) { return s + c.holdTime; }, 0) / results.cycles.length;
    results.winRate = results.cycles.filter(function(c) { return c.profit > 0; }).length / results.cycles.length * 100;

    // Calculate average optimal TP
    results.avgOptimalTp = results.cycles.reduce(function(s, c) { return s + c.optimalTpPct; }, 0) / results.cycles.length;
    const sortedOptimal = results.cycles.map(function(c) { return c.optimalTpPct; }).sort(function(a, b) { return a - b; });
    results.medianOptimalTp = sortedOptimal[Math.floor(sortedOptimal.length / 2)];
    results.p25OptimalTp = sortedOptimal[Math.floor(sortedOptimal.length * 0.25)];
    results.p75OptimalTp = sortedOptimal[Math.floor(sortedOptimal.length * 0.75)];
  }

  return results;
}

async function main() {
  console.log('🔍 Optimal TP Analysis for Regime Engine\n');
  console.log('═'.repeat(70) + '\n');

  const candles = await fetchWeeklyData();

  if (candles.length < 100) {
    console.log('❌ Not enough data fetched');
    return;
  }

  const config = getRegimeConfig(exchange);
  console.log('📋 Current Config:');
  console.log('   TP Range: ' + config.tpMinPercent + '% - ' + config.tpMaxPercent + '%');
  console.log('   k Factor: ' + config.kFactor);
  console.log('   Min Interval: ' + (config.minIntervalMs / 1000) + 's');
  console.log('   Max Interval: ' + (config.maxIntervalMs / 60000) + 'm');
  console.log('   Base Size: $' + config.baseSizeUsdc);

  // Test various TP percentages
  const tpTestValues = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];

  console.log('\n🧪 Testing ' + tpTestValues.length + ' TP percentages...\n');

  const results = [];

  for (const tp of tpTestValues) {
    const result = simulateRegimeEngine(candles, config, tp);
    results.push(result);
  }

  // Sort by total profit
  results.sort(function(a, b) { return b.totalProfit - a.totalProfit; });

  console.log('═'.repeat(90));
  console.log('  TP%    | Entries | Cycles | Profit ($) | Avg Hold  | Win Rate | Avg Opt | Med Opt');
  console.log('═'.repeat(90));

  for (const r of results) {
    const avgHoldMins = Math.round(r.avgHoldTime / 60000);
    console.log(
      '  ' + r.tpPercent.toFixed(2).padStart(5) + '% | ' +
      String(r.entries).padStart(7) + ' | ' +
      String(r.exits).padStart(6) + ' | ' +
      r.totalProfit.toFixed(2).padStart(10) + ' | ' +
      String(avgHoldMins).padStart(5) + 'm    | ' +
      r.winRate.toFixed(0).padStart(6) + '%  | ' +
      (r.avgOptimalTp || 0).toFixed(2).padStart(5) + '% | ' +
      (r.medianOptimalTp || 0).toFixed(2) + '%'
    );
  }

  console.log('═'.repeat(90) + '\n');

  // Find insights
  const bestProfit = results[0];
  const mostCycles = results.reduce(function(a, b) { return b.exits > a.exits ? b : a; });
  const bestProfitPerCycle = results
    .filter(function(r) { return r.exits > 0; })
    .reduce(function(a, b) { return (b.totalProfit / b.exits) > (a.totalProfit / a.exits) ? b : a; });

  console.log('📊 ANALYSIS SUMMARY');
  console.log('─'.repeat(50));
  console.log('   Best Total Profit:    ' + bestProfit.tpPercent + '% TP → $' + bestProfit.totalProfit.toFixed(2) + ' (' + bestProfit.exits + ' cycles)');
  console.log('   Most Cycles:          ' + mostCycles.tpPercent + '% TP → ' + mostCycles.exits + ' cycles ($' + mostCycles.totalProfit.toFixed(2) + ')');
  console.log('   Best Profit/Cycle:    ' + bestProfitPerCycle.tpPercent + '% TP → $' + (bestProfitPerCycle.totalProfit / bestProfitPerCycle.exits).toFixed(4) + '/cycle');

  // Aggregate optimal TP stats across all tests
  const allOptimalTps = [];
  for (const r of results) {
    for (const c of r.cycles) {
      allOptimalTps.push(c.optimalTpPct);
    }
  }

  if (allOptimalTps.length > 0) {
    allOptimalTps.sort(function(a, b) { return a - b; });
    const avgOptimal = allOptimalTps.reduce(function(a, b) { return a + b; }, 0) / allOptimalTps.length;
    const medianOptimal = allOptimalTps[Math.floor(allOptimalTps.length / 2)];
    const p10 = allOptimalTps[Math.floor(allOptimalTps.length * 0.1)];
    const p25 = allOptimalTps[Math.floor(allOptimalTps.length * 0.25)];
    const p75 = allOptimalTps[Math.floor(allOptimalTps.length * 0.75)];
    const p90 = allOptimalTps[Math.floor(allOptimalTps.length * 0.9)];

    console.log('\n📈 OPTIMAL TP DISTRIBUTION (what price actually reached)');
    console.log('─'.repeat(50));
    console.log('   Sample size:     ' + allOptimalTps.length + ' completed cycles');
    console.log('   Average:         ' + avgOptimal.toFixed(3) + '%');
    console.log('   Median:          ' + medianOptimal.toFixed(3) + '%');
    console.log('   10th percentile: ' + p10.toFixed(3) + '%');
    console.log('   25th percentile: ' + p25.toFixed(3) + '%');
    console.log('   75th percentile: ' + p75.toFixed(3) + '%');
    console.log('   90th percentile: ' + p90.toFixed(3) + '%');

    console.log('\n💡 RECOMMENDATION');
    console.log('─'.repeat(50));
    console.log('   Based on this week\'s data:');
    console.log('   • Conservative (more cycles): ' + p25.toFixed(2) + '% - ' + medianOptimal.toFixed(2) + '%');
    console.log('   • Balanced:                   ' + medianOptimal.toFixed(2) + '% - ' + p75.toFixed(2) + '%');
    console.log('   • Aggressive (fewer cycles):  ' + p75.toFixed(2) + '% - ' + p90.toFixed(2) + '%');
  }

  // Price stats
  const prices = candles.map(function(c) { return c.close; });
  const minPrice = Math.min.apply(null, prices);
  const maxPrice = Math.max.apply(null, prices);
  const avgPrice = prices.reduce(function(a, b) { return a + b; }, 0) / prices.length;
  const priceRange = ((maxPrice - minPrice) / avgPrice) * 100;

  console.log('\n📉 PRICE DATA SUMMARY');
  console.log('─'.repeat(50));
  console.log('   Period: ' + new Date(candles[0].timestamp).toLocaleDateString() + ' - ' + new Date(candles[candles.length-1].timestamp).toLocaleDateString());
  console.log('   Range:  $' + minPrice.toFixed(2) + ' - $' + maxPrice.toFixed(2) + ' (' + priceRange.toFixed(2) + '% spread)');
  console.log('   Avg:    $' + avgPrice.toFixed(2));
  console.log('   Data:   ' + candles.length + ' 1-minute candles');
  console.log('\n' + '═'.repeat(70));
}

main().catch(console.error);
