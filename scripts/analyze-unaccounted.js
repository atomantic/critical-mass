#!/usr/bin/env node
/**
 * Analyze unaccounted exchange fills to identify:
 * 1. Manual flips (0.5 or 1 BTC buy/sell pairs) that can be matched
 * 2. Orphaned buys that need body creation + TP
 * 3. Engine-created fills that may need different handling
 */

const { getAdapter } = require('../src/adapters');
const { createFillLedger } = require('../src/fill-ledger');
const { createManualTradeStore } = require('../src/manual-trades');
const { fetchAllCoinbaseFills, normalizeFills } = require('../src/sync-fills');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const START_DATE = '2026-01-01';
const MANUAL_FLIP_SIZES = [0.5, 1.0]; // BTC sizes for manual flips
const SIZE_TOLERANCE = 0.001; // tolerance for matching sizes

const isManualSize = (btc) => {
  return MANUAL_FLIP_SIZES.some(s => Math.abs(btc - s) < SIZE_TOLERANCE);
};

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

  // Load fill ledger to know what's already tracked
  const fillLedger = createFillLedger(EXCHANGE, PAIR, PAIR);
  fillLedger.load();
  console.log(`📒 Fill ledger has ${fillLedger.getFillCount()} tracked fills`);

  // Load manual trade store to know what's dismissed
  const manualTradeStore = createManualTradeStore(EXCHANGE, PAIR);
  manualTradeStore.load();

  // Fetch all exchange fills since start date
  const adapter = getAdapter(EXCHANGE);
  const startTimestampMs = new Date(START_DATE).getTime();

  console.log(`🔄 Fetching fills from ${EXCHANGE} since ${START_DATE}...`);
  const rawFills = await fetchAllCoinbaseFills(adapter, startTimestampMs);
  console.log(`📥 Got ${rawFills.length} raw fills from exchange`);

  const exchangeFills = normalizeFills(EXCHANGE, rawFills);
  console.log(`🔢 ${exchangeFills.size} unique fills after normalization`);

  // Filter to unaccounted fills
  const unaccounted = [];
  for (const [tid, exFill] of exchangeFills) {
    if (fillLedger.hasProcessedTrade(tid)) continue;
    if (manualTradeStore.isFillDismissed(exFill.orderId)) continue;
    unaccounted.push(exFill);
  }
  console.log(`❗ ${unaccounted.length} unaccounted fills\n`);

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
    };
  }).sort((a, b) => a.timestamp - b.timestamp);

  console.log(`📋 ${orders.length} unique unaccounted orders\n`);

  // Classify orders
  const manualBuys = [];
  const manualSells = [];
  const engineBuys = [];
  const engineSells = [];

  for (const order of orders) {
    if (isManualSize(order.totalBtc)) {
      if (order.side === 'buy') manualBuys.push(order);
      else manualSells.push(order);
    } else {
      if (order.side === 'buy') engineBuys.push(order);
      else engineSells.push(order);
    }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CLASSIFICATION SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Manual-size buys  (0.5/1 BTC): ${manualBuys.length}`);
  console.log(`  Manual-size sells (0.5/1 BTC): ${manualSells.length}`);
  console.log(`  Engine-size buys  (other):     ${engineBuys.length}`);
  console.log(`  Engine-size sells (other):     ${engineSells.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // --- Match manual flips ---
  // Try to pair manual buys with manual sells by size and time proximity
  const matchedPairs = [];
  const unmatchedManualBuys = [...manualBuys];
  const unmatchedManualSells = [...manualSells];

  // Sort by time for chronological matching
  unmatchedManualBuys.sort((a, b) => a.timestamp - b.timestamp);
  unmatchedManualSells.sort((a, b) => a.timestamp - b.timestamp);

  // For each sell, find the best matching buy (same size, closest in time, buy before sell preferred)
  for (let si = unmatchedManualSells.length - 1; si >= 0; si--) {
    const sell = unmatchedManualSells[si];
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let bi = 0; bi < unmatchedManualBuys.length; bi++) {
      const buy = unmatchedManualBuys[bi];

      // Size must match within tolerance
      if (Math.abs(buy.totalBtc - sell.totalBtc) > SIZE_TOLERANCE) continue;

      // Score: prefer buy before sell, closer in time
      const hoursDiff = (sell.timestamp - buy.timestamp) / 3600000;
      const timePenalty = Math.abs(hoursDiff);
      const chronoBonus = hoursDiff > 0 ? 10 : 0; // buy before sell is preferred
      const pnl = (sell.avgPrice - buy.avgPrice) * sell.totalBtc;
      const profitBonus = pnl > 0 ? 5 : 0;

      const score = chronoBonus + profitBonus - timePenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = bi;
      }
    }

    if (bestIdx >= 0) {
      const buy = unmatchedManualBuys[bestIdx];
      const pnl = (sell.avgPrice - buy.avgPrice) * sell.totalBtc;
      matchedPairs.push({ buy, sell, pnl });
      unmatchedManualBuys.splice(bestIdx, 1);
      unmatchedManualSells.splice(si, 1);
    }
  }

  // --- Output matched pairs ---
  if (matchedPairs.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  MATCHED MANUAL FLIP PAIRS');
    console.log('═══════════════════════════════════════════════════════════════');
    let totalPnl = 0;
    for (const { buy, sell, pnl } of matchedPairs) {
      totalPnl += pnl;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const pnlColor = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`  ${buy.totalBtc.toFixed(1)} BTC | Buy ${buy.orderId.slice(0, 8)}... @ $${buy.avgPrice.toFixed(2)} (${new Date(buy.timestamp).toLocaleDateString()}) → Sell ${sell.orderId.slice(0, 8)}... @ $${sell.avgPrice.toFixed(2)} (${new Date(sell.timestamp).toLocaleDateString()}) | ${pnlColor}${pnlStr}\x1b[0m`);
    }
    console.log(`  ─────────────────────────────────────────────────────────`);
    const totalPnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
    console.log(`  Total P&L from matched pairs: ${totalPnlStr}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  // --- Output unmatched manual orders ---
  if (unmatchedManualBuys.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  UNMATCHED MANUAL BUYS (need body creation + TP)');
    console.log('═══════════════════════════════════════════════════════════════');
    for (const buy of unmatchedManualBuys) {
      console.log(`  ${buy.totalBtc.toFixed(1)} BTC | ${buy.orderId.slice(0, 8)}... @ $${buy.avgPrice.toFixed(2)} ($${buy.totalUsdc.toFixed(2)}) | ${new Date(buy.timestamp).toLocaleString()}`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  if (unmatchedManualSells.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  UNMATCHED MANUAL SELLS (need recovery buy)');
    console.log('═══════════════════════════════════════════════════════════════');
    for (const sell of unmatchedManualSells) {
      console.log(`  ${sell.totalBtc.toFixed(1)} BTC | ${sell.orderId.slice(0, 8)}... @ $${sell.avgPrice.toFixed(2)} ($${sell.totalUsdc.toFixed(2)}) | ${new Date(sell.timestamp).toLocaleString()}`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  // --- Output engine-size orders ---
  if (engineBuys.length > 0 || engineSells.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ENGINE-SIZE ORDERS (likely from bot, smaller sizes)');
    console.log('═══════════════════════════════════════════════════════════════');
    const allEngine = [...engineBuys, ...engineSells].sort((a, b) => a.timestamp - b.timestamp);
    let engineBuyTotal = 0, engineSellTotal = 0;
    for (const o of allEngine) {
      const sideColor = o.side === 'buy' ? '\x1b[32m' : '\x1b[31m';
      console.log(`  ${sideColor}${o.side.toUpperCase().padEnd(4)}\x1b[0m ${o.totalBtc.toFixed(8)} BTC | ${o.orderId.slice(0, 8)}... @ $${o.avgPrice.toFixed(2)} ($${o.totalUsdc.toFixed(2)}) | ${new Date(o.timestamp).toLocaleString()}`);
      if (o.side === 'buy') engineBuyTotal += o.totalUsdc;
      else engineSellTotal += o.totalUsdc;
    }
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  Engine buys: ${engineBuys.length} orders ($${engineBuyTotal.toFixed(2)})`);
    console.log(`  Engine sells: ${engineSells.length} orders ($${engineSellTotal.toFixed(2)})`);
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  // --- JSON output for programmatic use ---
  const output = {
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
    unmatchedManualBuys: unmatchedManualBuys.map(o => ({
      orderId: o.orderId,
      btc: o.totalBtc,
      avgPrice: o.avgPrice,
      totalUsdc: o.totalUsdc,
      time: o.time,
    })),
    unmatchedManualSells: unmatchedManualSells.map(o => ({
      orderId: o.orderId,
      btc: o.totalBtc,
      avgPrice: o.avgPrice,
      totalUsdc: o.totalUsdc,
      time: o.time,
    })),
    engineOrders: {
      buys: engineBuys.length,
      sells: engineSells.length,
    },
  };

  console.log('\n📄 JSON Summary:');
  console.log(JSON.stringify(output, null, 2));
})();
