#!/usr/bin/env node
/**
 * Import the remaining 8 manual flip pairs that failed in the first run.
 * Uses bulk fills and profit-first matching.
 */

const { getAdapter } = require('../src/adapters');
const { createFillLedger } = require('../src/fill-ledger');
const { createManualTradeStore } = require('../src/manual-trades');
const { fetchAllCoinbaseFills, normalizeFills } = require('../src/sync-fills');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const SIZE_TOLERANCE = 0.001;
const isManualSize = (btc) => [0.5, 1.0].some(s => Math.abs(btc - s) < SIZE_TOLERANCE);

(async () => {
  const adapter = getAdapter(EXCHANGE);
  console.log('🔄 Fetching bulk fills...');
  const rawFills = await fetchAllCoinbaseFills(adapter, new Date('2026-01-01').getTime());
  const fills = normalizeFills(EXCHANGE, rawFills);

  const fillLedger = createFillLedger(EXCHANGE, PAIR, PAIR);
  fillLedger.load();
  const store = createManualTradeStore(EXCHANGE, PAIR);
  store.load();

  // Build remaining unmatched manual-size orders
  const byOrderId = new Map();
  for (const [tid, fill] of fills) {
    if (fillLedger.hasProcessedTrade(tid)) continue;
    if (store.isFillDismissed(fill.orderId)) continue;
    if (!byOrderId.has(fill.orderId)) byOrderId.set(fill.orderId, []);
    byOrderId.get(fill.orderId).push(fill);
  }

  const orders = [];
  for (const [orderId, orderFills] of byOrderId) {
    const totalBtc = orderFills.reduce((s, f) => s + f.size, 0);
    if (!isManualSize(totalBtc)) continue;
    const totalUsdc = orderFills.reduce((s, f) => s + f.quoteAmount, 0);
    orders.push({
      orderId, side: orderFills[0].side, totalBtc, totalUsdc,
      avgPrice: totalBtc > 0 ? totalUsdc / totalBtc : 0,
      timestamp: orderFills[0].timestamp,
      fills: orderFills,
    });
  }

  const buys = orders.filter(o => o.side === 'buy').sort((a, b) => a.avgPrice - b.avgPrice);
  const sells = orders.filter(o => o.side === 'sell').sort((a, b) => a.avgPrice - b.avgPrice);

  console.log(`\n📊 ${buys.length} manual buys, ${sells.length} manual sells remaining\n`);

  // Profit-first matching
  const pairs = [];
  const remainingBuys = [...buys];
  const remainingSells = [...sells];

  for (let bi = 0; bi < remainingBuys.length; bi++) {
    const buy = remainingBuys[bi];
    let bestSellIdx = -1;
    let bestTimeDist = Infinity;

    for (let si = 0; si < remainingSells.length; si++) {
      const sell = remainingSells[si];
      if (Math.abs(buy.totalBtc - sell.totalBtc) > SIZE_TOLERANCE) continue;
      if (sell.avgPrice <= buy.avgPrice) continue; // must be profitable
      const timeDist = Math.abs(sell.timestamp - buy.timestamp);
      if (timeDist < bestTimeDist) {
        bestTimeDist = timeDist;
        bestSellIdx = si;
      }
    }

    if (bestSellIdx >= 0) {
      const sell = remainingSells[bestSellIdx];
      const pnl = (sell.avgPrice - buy.avgPrice) * buy.totalBtc;
      pairs.push({ buy, sell, pnl });
      remainingSells.splice(bestSellIdx, 1);
      remainingBuys.splice(bi, 1);
      bi--;
    }
  }

  console.log(`✅ Matched ${pairs.length} profitable pairs\n`);

  // Import
  let totalPnl = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { buy, sell, pnl } = pairs[i];
    totalPnl += pnl;

    console.log(`[${i + 1}/${pairs.length}] ${buy.totalBtc.toFixed(1)} BTC | Buy ${buy.orderId.slice(0, 8)}... @ $${buy.avgPrice.toFixed(2)} → Sell ${sell.orderId.slice(0, 8)}... @ $${sell.avgPrice.toFixed(2)} | +$${pnl.toFixed(2)}`);

    // Ingest buy fills
    const buyTradeIds = [];
    for (const fill of buy.fills) {
      buyTradeIds.push(fill.tradeId);
      fillLedger.ingestFill({
        tradeId: fill.tradeId, orderId: buy.orderId, side: 'buy',
        price: fill.price, size: fill.size,
        totalCommission: fill.fee || 0, commission: fill.fee || 0,
        rebate: 0, netFee: fill.fee || 0,
        liquidityIndicator: fill.liquidityIndicator || 'TAKER',
        tradeTime: new Date(fill.timestamp).toISOString(), fee_asset: 'USDC',
      }, null, { skipPersist: true });
    }

    // Ingest sell fills
    const sellTradeIds = [];
    for (const fill of sell.fills) {
      sellTradeIds.push(fill.tradeId);
      fillLedger.ingestFill({
        tradeId: fill.tradeId, orderId: sell.orderId, side: 'sell',
        price: fill.price, size: fill.size,
        totalCommission: fill.fee || 0, commission: fill.fee || 0,
        rebate: 0, netFee: fill.fee || 0,
        liquidityIndicator: fill.liquidityIndicator || 'TAKER',
        tradeTime: new Date(fill.timestamp).toISOString(), fee_asset: 'USDC',
      }, null, { skipPersist: true });
    }

    // Annotate
    fillLedger.annotateFillsByOrderId(buy.orderId, { sellOrderId: sell.orderId });

    // Manual trade record
    store.addPairedTrade(
      {
        buyOrderId: buy.orderId, buyPrice: buy.avgPrice, buySize: buy.totalBtc,
        buyQuoteAmount: buy.totalUsdc, buyTimestamp: buy.timestamp, buyFillTradeIds: buyTradeIds,
      },
      {
        sellOrderId: sell.orderId, sellPrice: sell.avgPrice, sellSize: sell.totalBtc,
        sellQuoteAmount: sell.totalUsdc, sellTimestamp: sell.timestamp, sellFillTradeIds: sellTradeIds,
      },
      `Manual flip ${buy.totalBtc.toFixed(1)} BTC`,
    );
    store.dismissFills([buy.orderId, sell.orderId]);
  }

  fillLedger.persist();

  if (remainingBuys.length > 0) {
    console.log(`\n⚠️  Unmatched buys (${remainingBuys.length}):`);
    for (const b of remainingBuys) console.log(`  ${b.totalBtc.toFixed(1)} BTC @ $${b.avgPrice.toFixed(2)} | ${b.orderId.slice(0,8)}...`);
  }
  if (remainingSells.length > 0) {
    console.log(`\n⚠️  Unmatched sells (${remainingSells.length}):`);
    for (const s of remainingSells) console.log(`  ${s.totalBtc.toFixed(1)} BTC @ $${s.avgPrice.toFixed(2)} | ${s.orderId.slice(0,8)}...`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Imported: ${pairs.length} pairs | Total P&L: +$${totalPnl.toFixed(2)}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
})();
