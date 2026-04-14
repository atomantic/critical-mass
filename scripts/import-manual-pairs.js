#!/usr/bin/env node
/**
 * Import matched manual flip pairs using bulk-fetched fills (not per-order API).
 * This handles old orders that the per-order fill API no longer returns.
 * Engine must be STOPPED before running.
 */

const { getAdapter } = require('../src/adapters');
const { createFillLedger } = require('../src/fill-ledger');
const { createManualTradeStore } = require('../src/manual-trades');
const { fetchAllCoinbaseFills, normalizeFills } = require('../src/sync-fills');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const START_DATE = '2026-01-01';

const matchedPairs = [
  { buyOrderId: "518d0ca9-1262-442c-a28a-f1c037440c93", sellOrderId: "25f13261-3bec-490e-83be-34a7967435c8", note: "Manual flip 0.5 BTC Jan" },
  { buyOrderId: "796eea49-0d67-49a1-a422-2e06f388ca56", sellOrderId: "14e7f0b1-2c63-4e60-b70c-d16465adcce7", note: "Manual flip 0.5 BTC Jan" },
  { buyOrderId: "ccbca736-d7fc-4437-ae84-f1db33b62f12", sellOrderId: "1d90f021-774a-42bd-bafd-37564fde7984", note: "Manual flip 1 BTC Feb" },
  { buyOrderId: "d2147728-ec1d-49d6-a904-a87b938b2747", sellOrderId: "6ef9ffed-57c4-4a05-ad11-b7e21f3830b2", note: "Manual flip 1 BTC Feb→Apr" },
  { buyOrderId: "c01cd924-6bda-46a4-8d67-296c6979921e", sellOrderId: "268e53b4-0e5e-453b-8225-ed367748c0d3", note: "Manual flip 1 BTC Feb" },
  { buyOrderId: "c91e1270-c824-42a4-8ed9-70712afdde5d", sellOrderId: "61cb06fc-f182-493d-b36a-edff42f9402d", note: "Manual flip 1 BTC Feb" },
  { buyOrderId: "a5e6b114-edba-4077-bf6b-03e0e5651329", sellOrderId: "232ef7ab-e3dd-476a-be41-38ad63f8a3e9", note: "Manual flip 1 BTC Feb→Mar" },
  { buyOrderId: "e3e89832-4f00-42cd-acdc-4c8742ddbd64", sellOrderId: "bfc05fd2-e9a6-48bc-9c8b-859594e03f97", note: "Manual flip 1 BTC Feb" },
  { buyOrderId: "2d010f0f-3411-4aed-87ea-64ba7e9d14e4", sellOrderId: "7a3c8ef8-b303-404b-99f0-45f8ed9edeeb", note: "Manual flip 1 BTC Mar" },
  { buyOrderId: "9b4323be-c515-4b51-80ca-f3a02fda3f91", sellOrderId: "a2e5bf91-b338-4c0e-97b2-4c1055a5fc10", note: "Manual flip 1 BTC Mar" },
  { buyOrderId: "7b4e811f-b3a8-4370-b11b-d7dfc93e5ea7", sellOrderId: "ef8ad8de-a3e2-4ad0-a2e3-dd2b35e4ba2f", note: "Manual flip 1 BTC Mar" },
  { buyOrderId: "b5c3ea24-f70e-4fb9-a90e-4e0b5df0e76b", sellOrderId: "6e969ef3-4e59-4fc4-b810-bc8d09a33b60", note: "Manual flip 1 BTC Mar→Apr" },
  { buyOrderId: "4ddf6c30-e5b4-4bd2-98e7-aafcca3ea2f1", sellOrderId: "9a1849a9-a1f3-4e37-afc1-67e7d12a6b7a", note: "Manual flip 0.5 BTC Apr" },
  { buyOrderId: "e64b3391-3484-4e1e-ae03-bb40e6f69e6f", sellOrderId: "c85bd257-8810-4506-a831-ea8bf1c75c25", note: "Manual flip 1 BTC Apr" },
  { buyOrderId: "d075f968-5805-4be3-96e5-70de8372667f", sellOrderId: "c7811356-0f09-4ab7-92b2-68fa3018825e", note: "Manual flip 0.5 BTC" },
];

(async () => {
  console.log(`\n📦 Importing ${matchedPairs.length} manual flip pairs (using bulk fills)\n`);

  // Fetch all fills in one batch
  const adapter = getAdapter(EXCHANGE);
  console.log(`🔄 Fetching all fills since ${START_DATE}...`);
  const rawFills = await fetchAllCoinbaseFills(adapter, new Date(START_DATE).getTime());
  const exchangeFills = normalizeFills(EXCHANGE, rawFills);
  console.log(`📥 ${exchangeFills.size} fills fetched\n`);

  // Index fills by orderId
  const fillsByOrderId = new Map();
  for (const [, fill] of exchangeFills) {
    if (!fillsByOrderId.has(fill.orderId)) fillsByOrderId.set(fill.orderId, []);
    fillsByOrderId.get(fill.orderId).push(fill);
  }

  // Load local stores
  const fillLedger = createFillLedger(EXCHANGE, PAIR, PAIR);
  fillLedger.load();
  const manualTradeStore = createManualTradeStore(EXCHANGE, PAIR);
  manualTradeStore.load();

  const startFillCount = fillLedger.getFillCount();
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let totalPnl = 0;

  for (let i = 0; i < matchedPairs.length; i++) {
    const pair = matchedPairs[i];
    console.log(`[${i + 1}/${matchedPairs.length}] Buy: ${pair.buyOrderId.slice(0, 8)}... → Sell: ${pair.sellOrderId.slice(0, 8)}...`);

    const buyFills = fillsByOrderId.get(pair.buyOrderId);
    const sellFills = fillsByOrderId.get(pair.sellOrderId);

    if (!buyFills || buyFills.length === 0) {
      console.log(`  ❌ No buy fills found for ${pair.buyOrderId}\n`);
      failed++;
      continue;
    }
    if (!sellFills || sellFills.length === 0) {
      console.log(`  ❌ No sell fills found for ${pair.sellOrderId}\n`);
      failed++;
      continue;
    }

    // Check if already imported (idempotent)
    const alreadyTracked = buyFills.every(f => fillLedger.hasProcessedTrade(f.tradeId))
      && sellFills.every(f => fillLedger.hasProcessedTrade(f.tradeId));
    if (alreadyTracked) {
      const totalBuySize = buyFills.reduce((s, f) => s + f.size, 0);
      const totalBuyQuote = buyFills.reduce((s, f) => s + f.quoteAmount, 0);
      const totalSellSize = sellFills.reduce((s, f) => s + f.size, 0);
      const totalSellQuote = sellFills.reduce((s, f) => s + f.quoteAmount, 0);
      const avgBuyPrice = totalBuySize > 0 ? totalBuyQuote / totalBuySize : 0;
      const avgSellPrice = totalSellSize > 0 ? totalSellQuote / totalSellSize : 0;
      const pnl = (avgSellPrice - avgBuyPrice) * Math.min(totalBuySize, totalSellSize);

      // Still need to annotate and create manual trade record if not yet done
      fillLedger.annotateFillsByOrderId(pair.buyOrderId, { sellOrderId: pair.sellOrderId });

      manualTradeStore.addPairedTrade(
        {
          buyOrderId: pair.buyOrderId,
          buyPrice: avgBuyPrice,
          buySize: totalBuySize,
          buyQuoteAmount: totalBuyQuote,
          buyTimestamp: buyFills[0].timestamp,
          buyFillTradeIds: buyFills.map(f => f.tradeId),
        },
        {
          sellOrderId: pair.sellOrderId,
          sellPrice: avgSellPrice,
          sellSize: totalSellSize,
          sellQuoteAmount: totalSellQuote,
          sellTimestamp: sellFills[0].timestamp,
          sellFillTradeIds: sellFills.map(f => f.tradeId),
        },
        pair.note,
      );
      manualTradeStore.dismissFills([pair.buyOrderId, pair.sellOrderId]);
      totalPnl += pnl;
      console.log(`  ⏩ Already in ledger — added manual trade record + annotations | P&L: +$${pnl.toFixed(2)}\n`);
      skipped++;
      continue;
    }

    // Ingest buy fills
    let totalBuySize = 0;
    let totalBuyQuote = 0;
    let totalBuyFees = 0;
    const buyTradeIds = [];
    for (const fill of buyFills) {
      buyTradeIds.push(fill.tradeId);
      totalBuySize += fill.size;
      totalBuyQuote += fill.quoteAmount;
      totalBuyFees += fill.fee || 0;
      fillLedger.ingestFill({
        tradeId: fill.tradeId,
        orderId: pair.buyOrderId,
        side: 'buy',
        price: fill.price,
        size: fill.size,
        totalCommission: fill.fee || 0,
        commission: fill.fee || 0,
        rebate: 0,
        netFee: fill.fee || 0,
        liquidityIndicator: fill.liquidityIndicator || 'TAKER',
        tradeTime: new Date(fill.timestamp).toISOString(),
        fee_asset: 'USDC',
      }, null, { skipPersist: true });
    }

    // Ingest sell fills
    let totalSellSize = 0;
    let totalSellQuote = 0;
    const sellTradeIds = [];
    for (const fill of sellFills) {
      sellTradeIds.push(fill.tradeId);
      totalSellSize += fill.size;
      totalSellQuote += fill.quoteAmount;
      fillLedger.ingestFill({
        tradeId: fill.tradeId,
        orderId: pair.sellOrderId,
        side: 'sell',
        price: fill.price,
        size: fill.size,
        totalCommission: fill.fee || 0,
        commission: fill.fee || 0,
        rebate: 0,
        netFee: fill.fee || 0,
        liquidityIndicator: fill.liquidityIndicator || 'TAKER',
        tradeTime: new Date(fill.timestamp).toISOString(),
        fee_asset: 'USDC',
      }, null, { skipPersist: true });
    }

    // Annotate buy fills with sellOrderId for P&L linkage
    fillLedger.annotateFillsByOrderId(pair.buyOrderId, { sellOrderId: pair.sellOrderId });

    const avgBuyPrice = totalBuySize > 0 ? totalBuyQuote / totalBuySize : 0;
    const avgSellPrice = totalSellSize > 0 ? totalSellQuote / totalSellSize : 0;
    const pnl = (avgSellPrice - avgBuyPrice) * Math.min(totalBuySize, totalSellSize);
    totalPnl += pnl;

    // Record in manual trade store
    manualTradeStore.addPairedTrade(
      {
        buyOrderId: pair.buyOrderId,
        buyPrice: avgBuyPrice,
        buySize: totalBuySize,
        buyQuoteAmount: totalBuyQuote,
        buyTimestamp: buyFills[0].timestamp,
        buyFillTradeIds: buyTradeIds,
      },
      {
        sellOrderId: pair.sellOrderId,
        sellPrice: avgSellPrice,
        sellSize: totalSellSize,
        sellQuoteAmount: totalSellQuote,
        sellTimestamp: sellFills[0].timestamp,
        sellFillTradeIds: sellTradeIds,
      },
      pair.note,
    );

    // Dismiss both from unaccounted view
    manualTradeStore.dismissFills([pair.buyOrderId, pair.sellOrderId]);

    console.log(`  ✅ ${totalBuySize.toFixed(2)} BTC | Buy @ $${avgBuyPrice.toFixed(2)} → Sell @ $${avgSellPrice.toFixed(2)} | P&L: +$${pnl.toFixed(2)}`);
    console.log(`     (${buyFills.length} buy fills, ${sellFills.length} sell fills)\n`);
    imported++;
  }

  // Persist fill ledger once
  fillLedger.persist();

  const endFillCount = fillLedger.getFillCount();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Done: ${imported} imported, ${skipped} already in ledger, ${failed} failed`);
  console.log(`  Fill ledger: ${startFillCount} → ${endFillCount} fills (+${endFillCount - startFillCount})`);
  console.log(`  Total P&L from imported pairs: +$${totalPnl.toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
})();
