#!/usr/bin/env node
/**
 * v2: Better matching (profit-first) + investigate engine-size orders against ledger
 */

const { getAdapter } = require('../src/adapters');
const { createFillLedger } = require('../src/fill-ledger');
const { createManualTradeStore } = require('../src/manual-trades');
const { fetchAllCoinbaseFills, normalizeFills } = require('../src/sync-fills');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const START_DATE = '2026-01-01';
const MANUAL_FLIP_SIZES = [0.5, 1.0];
const SIZE_TOLERANCE = 0.001;

const isManualSize = (btc) => MANUAL_FLIP_SIZES.some(s => Math.abs(btc - s) < SIZE_TOLERANCE);

const groupFillsByOrder = (fills) => {
  const map = new Map();
  for (const f of fills) {
    if (!map.has(f.orderId)) map.set(f.orderId, []);
    map.get(f.orderId).push(f);
  }
  return map;
};

(async () => {
  console.log(`\n📊 Analyzing unaccounted fills since ${START_DATE} for ${EXCHANGE}/${PAIR}\n`);

  const fillLedger = createFillLedger(EXCHANGE, PAIR, PAIR);
  fillLedger.load();
  const ledgerFillCount = fillLedger.getFillCount();
  const allLedgerFills = fillLedger.getAllFills();
  console.log(`📒 Fill ledger has ${ledgerFillCount} tracked fills`);

  // Build a set of all order IDs in the ledger
  const ledgerOrderIds = new Set();
  const ledgerTradeIds = new Set();
  for (const f of allLedgerFills) {
    ledgerOrderIds.add(f.orderId);
    ledgerTradeIds.add(f.tradeId);
  }
  console.log(`📒 Ledger covers ${ledgerOrderIds.size} unique order IDs`);

  const manualTradeStore = createManualTradeStore(EXCHANGE, PAIR);
  manualTradeStore.load();

  const adapter = getAdapter(EXCHANGE);
  const startTimestampMs = new Date(START_DATE).getTime();

  console.log(`🔄 Fetching fills from ${EXCHANGE} since ${START_DATE}...`);
  const rawFills = await fetchAllCoinbaseFills(adapter, startTimestampMs);
  console.log(`📥 Got ${rawFills.length} raw fills from exchange\n`);

  const exchangeFills = normalizeFills(EXCHANGE, rawFills);

  // Filter to unaccounted fills
  const unaccounted = [];
  for (const [tid, exFill] of exchangeFills) {
    if (fillLedger.hasProcessedTrade(tid)) continue;
    if (manualTradeStore.isFillDismissed(exFill.orderId)) continue;
    unaccounted.push(exFill);
  }

  // Group by orderId
  const byOrderId = groupFillsByOrder(unaccounted);
  const orders = [...byOrderId.entries()].map(([orderId, fills]) => {
    const totalBtc = fills.reduce((s, f) => s + f.size, 0);
    const totalUsdc = fills.reduce((s, f) => s + f.quoteAmount, 0);
    return {
      orderId,
      side: fills[0].side,
      totalBtc,
      totalUsdc,
      avgPrice: totalBtc > 0 ? totalUsdc / totalBtc : 0,
      fillCount: fills.length,
      time: new Date(Math.min(...fills.map(f => f.timestamp))).toISOString(),
      timestamp: Math.min(...fills.map(f => f.timestamp)),
      fills,
    };
  }).sort((a, b) => a.timestamp - b.timestamp);

  // ═══════════════════════════════════════════════════════════
  // PART 1: INVESTIGATE ENGINE-SIZE ORDERS
  // ═══════════════════════════════════════════════════════════

  const engineOrders = orders.filter(o => !isManualSize(o.totalBtc));
  const manualOrders = orders.filter(o => isManualSize(o.totalBtc));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ENGINE-SIZE ORDER INVESTIGATION');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Check if any of these unaccounted orders have SOME fills in the ledger
  // (partial tracking — some fills tracked, others not)
  let partiallyTracked = 0;
  let fullyUntracked = 0;
  const partialOrders = [];
  const untrackedOrders = [];

  for (const order of engineOrders) {
    const allFillsForOrder = [];
    for (const [tid, exFill] of exchangeFills) {
      if (exFill.orderId === order.orderId) allFillsForOrder.push(exFill);
    }
    const trackedCount = allFillsForOrder.filter(f => ledgerTradeIds.has(f.tradeId)).length;
    const untrackedCount = allFillsForOrder.length - trackedCount;

    if (trackedCount > 0 && untrackedCount > 0) {
      partiallyTracked++;
      partialOrders.push({ ...order, trackedCount, untrackedCount, totalFills: allFillsForOrder.length });
    } else {
      fullyUntracked++;
      untrackedOrders.push(order);
    }
  }

  console.log(`  Partially tracked (some fills in ledger): ${partiallyTracked}`);
  console.log(`  Fully untracked (no fills in ledger):     ${fullyUntracked}`);
  console.log(`  Total engine-size orders:                 ${engineOrders.length}\n`);

  // Group untracked engine orders by date range to understand the pattern
  const byMonth = {};
  for (const o of untrackedOrders) {
    const d = new Date(o.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { buys: 0, sells: 0, buyUsdc: 0, sellUsdc: 0, orders: [] };
    byMonth[key].orders.push(o);
    if (o.side === 'buy') { byMonth[key].buys++; byMonth[key].buyUsdc += o.totalUsdc; }
    else { byMonth[key].sells++; byMonth[key].sellUsdc += o.totalUsdc; }
  }

  console.log('  Fully untracked engine orders by month:');
  console.log('  ─────────────────────────────────────────────────────────');
  for (const [month, data] of Object.entries(byMonth).sort()) {
    console.log(`  ${month}: ${data.buys} buys ($${data.buyUsdc.toFixed(0)}), ${data.sells} sells ($${data.sellUsdc.toFixed(0)})`);
  }

  // Show size distribution of untracked engine orders
  console.log('\n  Size distribution of fully untracked engine buys:');
  console.log('  ─────────────────────────────────────────────────────────');
  const sizeBuckets = { '$25': 0, '$35': 0, '$50': 0, '$75-120': 0, '$120-200': 0, '$200-500': 0, '$500+': 0 };
  for (const o of untrackedOrders.filter(o => o.side === 'buy')) {
    const usd = o.totalUsdc;
    if (usd < 30) sizeBuckets['$25']++;
    else if (usd < 45) sizeBuckets['$35']++;
    else if (usd < 60) sizeBuckets['$50']++;
    else if (usd < 125) sizeBuckets['$75-120']++;
    else if (usd < 205) sizeBuckets['$120-200']++;
    else if (usd < 505) sizeBuckets['$200-500']++;
    else sizeBuckets['$500+']++;
  }
  for (const [bucket, count] of Object.entries(sizeBuckets)) {
    if (count > 0) console.log(`    ${bucket.padEnd(10)}: ${count} orders`);
  }

  // Check: are any of these engine orders from BEFORE the ledger's earliest fill?
  const ledgerFillTimes = allLedgerFills.map(f => f.timestamp || new Date(f.tradeTime).getTime()).filter(Boolean);
  const earliestLedgerFill = Math.min(...ledgerFillTimes);
  const preLedgerOrders = untrackedOrders.filter(o => o.timestamp < earliestLedgerFill);
  const postLedgerOrders = untrackedOrders.filter(o => o.timestamp >= earliestLedgerFill);

  console.log(`\n  Earliest ledger fill: ${new Date(earliestLedgerFill).toISOString()}`);
  console.log(`  Engine orders BEFORE ledger start: ${preLedgerOrders.length}`);
  console.log(`  Engine orders AFTER ledger start:  ${postLedgerOrders.length}`);

  // For post-ledger orders, check if there's a gap pattern (e.g., a date range where the bug caused missed fills)
  if (postLedgerOrders.length > 0) {
    const sorted = postLedgerOrders.sort((a, b) => a.timestamp - b.timestamp);
    const firstMissing = new Date(sorted[0].timestamp);
    const lastMissing = new Date(sorted[sorted.length - 1].timestamp);
    console.log(`  Missing fills date range: ${firstMissing.toLocaleDateString()} — ${lastMissing.toLocaleDateString()}`);

    // Check if there's a contiguous gap or scattered
    const daySet = new Set();
    for (const o of sorted) {
      daySet.add(new Date(o.timestamp).toLocaleDateString());
    }
    console.log(`  Spread across ${daySet.size} distinct days`);
  }

  // Show the 5 engine sells specifically (they're unusual)
  const engineSells = engineOrders.filter(o => o.side === 'sell');
  if (engineSells.length > 0) {
    console.log('\n  Engine-size SELLS (unusual — investigate):');
    console.log('  ─────────────────────────────────────────────────────────');
    for (const s of engineSells) {
      console.log(`  ${s.totalBtc.toFixed(8)} BTC | ${s.orderId.slice(0, 12)}... @ $${s.avgPrice.toFixed(2)} ($${s.totalUsdc.toFixed(2)}) | ${new Date(s.timestamp).toLocaleString()}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PART 2: PROFIT-FIRST MATCHING FOR MANUAL FLIPS
  // ═══════════════════════════════════════════════════════════

  const manualBuys = manualOrders.filter(o => o.side === 'buy').sort((a, b) => a.timestamp - b.timestamp);
  const manualSells = manualOrders.filter(o => o.side === 'sell').sort((a, b) => a.timestamp - b.timestamp);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  MANUAL FLIP MATCHING (profit-first)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${manualBuys.length} buys, ${manualSells.length} sells to match\n`);

  // List all manual buys and sells for reference
  console.log('  All manual buys:');
  for (const b of manualBuys) {
    console.log(`    ${b.totalBtc.toFixed(1)} BTC | ${b.orderId.slice(0, 8)}... @ $${b.avgPrice.toFixed(2)} | ${new Date(b.timestamp).toLocaleString()}`);
  }
  console.log('\n  All manual sells:');
  for (const s of manualSells) {
    console.log(`    ${s.totalBtc.toFixed(1)} BTC | ${s.orderId.slice(0, 8)}... @ $${s.avgPrice.toFixed(2)} | ${new Date(s.timestamp).toLocaleString()}`);
  }

  // Profit-first matching: for each buy, find the cheapest profitable sell of matching size
  // Use a greedy approach: sort buys by price ascending, match with lowest-price profitable sell
  const matchedPairs = [];
  const remainingBuys = [...manualBuys];
  const remainingSells = [...manualSells];

  // Strategy: for each buy (cheapest first), find the best profitable sell
  remainingBuys.sort((a, b) => a.avgPrice - b.avgPrice);

  for (let bi = 0; bi < remainingBuys.length; bi++) {
    const buy = remainingBuys[bi];
    let bestSellIdx = -1;
    let bestPnl = -Infinity;
    let bestTimeDist = Infinity;

    for (let si = 0; si < remainingSells.length; si++) {
      const sell = remainingSells[si];
      // Size must match
      if (Math.abs(buy.totalBtc - sell.totalBtc) > SIZE_TOLERANCE) continue;

      const pnl = (sell.avgPrice - buy.avgPrice) * buy.totalBtc;

      // Must be profitable
      if (pnl <= 0) continue;

      // Among profitable matches, prefer closer in time
      const timeDist = Math.abs(sell.timestamp - buy.timestamp);

      if (pnl > 0 && (bestSellIdx === -1 || timeDist < bestTimeDist)) {
        bestSellIdx = si;
        bestPnl = pnl;
        bestTimeDist = timeDist;
      }
    }

    if (bestSellIdx >= 0) {
      const sell = remainingSells[bestSellIdx];
      matchedPairs.push({ buy, sell, pnl: bestPnl });
      remainingSells.splice(bestSellIdx, 1);
      remainingBuys.splice(bi, 1);
      bi--; // adjust index
    }
  }

  // Second pass: match remaining (may be unprofitable)
  for (let bi = remainingBuys.length - 1; bi >= 0; bi--) {
    const buy = remainingBuys[bi];
    let bestSellIdx = -1;
    let bestLoss = -Infinity;

    for (let si = 0; si < remainingSells.length; si++) {
      const sell = remainingSells[si];
      if (Math.abs(buy.totalBtc - sell.totalBtc) > SIZE_TOLERANCE) continue;
      const pnl = (sell.avgPrice - buy.avgPrice) * buy.totalBtc;
      // Pick the least-negative P&L
      if (pnl > bestLoss) {
        bestLoss = pnl;
        bestSellIdx = si;
      }
    }

    if (bestSellIdx >= 0) {
      const sell = remainingSells[bestSellIdx];
      matchedPairs.push({ buy, sell, pnl: bestLoss });
      remainingSells.splice(bestSellIdx, 1);
      remainingBuys.splice(bi, 1);
    }
  }

  // Sort matched pairs chronologically by buy time
  matchedPairs.sort((a, b) => a.buy.timestamp - b.buy.timestamp);

  console.log('\n  Matched pairs (profit-first):');
  console.log('  ─────────────────────────────────────────────────────────');
  let totalPnl = 0;
  let profitCount = 0;
  let lossCount = 0;
  for (const { buy, sell, pnl } of matchedPairs) {
    totalPnl += pnl;
    if (pnl >= 0) profitCount++; else lossCount++;
    const pnlStr = pnl >= 0 ? `\x1b[32m+$${pnl.toFixed(2)}\x1b[0m` : `\x1b[31m-$${Math.abs(pnl).toFixed(2)}\x1b[0m`;
    console.log(`  ${buy.totalBtc.toFixed(1)} BTC | Buy ${buy.orderId.slice(0, 8)}... @ $${buy.avgPrice.toFixed(2)} (${new Date(buy.timestamp).toLocaleDateString()}) → Sell ${sell.orderId.slice(0, 8)}... @ $${sell.avgPrice.toFixed(2)} (${new Date(sell.timestamp).toLocaleDateString()}) | ${pnlStr}`);
  }
  console.log(`  ─────────────────────────────────────────────────────────`);
  console.log(`  ${profitCount} profitable, ${lossCount} losses`);
  console.log(`  Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);

  if (remainingBuys.length > 0) {
    console.log(`\n  ⚠️ Unmatched buys (${remainingBuys.length}):`);
    for (const b of remainingBuys) {
      console.log(`    ${b.totalBtc.toFixed(1)} BTC | ${b.orderId.slice(0, 8)}... @ $${b.avgPrice.toFixed(2)} | ${new Date(b.timestamp).toLocaleString()}`);
    }
  }
  if (remainingSells.length > 0) {
    console.log(`\n  ⚠️ Unmatched sells (${remainingSells.length}):`);
    for (const s of remainingSells) {
      console.log(`    ${s.totalBtc.toFixed(1)} BTC | ${s.orderId.slice(0, 8)}... @ $${s.avgPrice.toFixed(2)} | ${new Date(s.timestamp).toLocaleString()}`);
    }
  }

  // JSON output
  console.log('\n\n📄 JSON Summary:');
  console.log(JSON.stringify({
    matchedPairs: matchedPairs.map(({ buy, sell, pnl }) => ({
      buyOrderId: buy.orderId,
      sellOrderId: sell.orderId,
      btc: buy.totalBtc,
      buyPrice: buy.avgPrice,
      sellPrice: sell.avgPrice,
      buyTime: buy.time,
      sellTime: sell.time,
      pnl,
    })),
    unmatchedBuys: remainingBuys.map(o => ({ orderId: o.orderId, btc: o.totalBtc, avgPrice: o.avgPrice, time: o.time })),
    unmatchedSells: remainingSells.map(o => ({ orderId: o.orderId, btc: o.totalBtc, avgPrice: o.avgPrice, time: o.time })),
    engineOrderSummary: {
      total: engineOrders.length,
      partiallyTracked,
      fullyUntracked,
      byMonth,
      sells: engineSells.map(o => ({ orderId: o.orderId, btc: o.totalBtc, avgPrice: o.avgPrice, totalUsdc: o.totalUsdc, time: o.time })),
    },
  }, null, 2));
})();
