#!/usr/bin/env node
// @ts-check
/**
 * Place corrective limit buy orders for orphan sells and annotate fills.
 *
 * Each buy is placed at the max price that preserves the original P&L.
 * After fills arrive, annotates them in the fill ledger with the
 * corresponding orphan sell order ID.
 *
 * Usage:
 *   node scripts/place-corrective-buys.js                # place orders (safe while engine runs)
 *   node scripts/place-corrective-buys.js --status        # check order status on exchange
 *   node scripts/place-corrective-buys.js --annotate      # ingest fills + annotate ledger
 *                                                          (stop engine first: pm2 stop critical-mass)
 */

const fs = require('fs');
const path = require('path');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createFillLedger } = require('../src/fill-ledger');

const PRODUCT_ID = 'BTC-USDC';
const EXCHANGE = 'coinbase';
const FEE_RATE = 0.0005; // 0.05% maker fee
const PENDING_FILE = path.join(__dirname, '..', 'data', 'coinbase', 'pending-corrective-buys.json');

// Orphan sell orders and their corrective buy parameters
const CORRECTIONS = [
  {
    sellOrderId: '9e935edf-1893-4ed1-941b-673b7cb6c469',
    size: 0.00268593,
    originalAvgBuyPrice: 67254.74,
    sellPrice: 78352.67,
    note: 'Feb 3 orphan — buy linked via sellOrderId',
  },
  {
    sellOrderId: '2206cc87-bd36-47f3-a724-a6a46d8cddfa',
    size: 0.00391803,
    originalAvgBuyPrice: 66169.14,
    sellPrice: 66495.21,
    note: 'bodyCostBasis annotated orphan',
  },
  {
    sellOrderId: '79fa2ed7-d702-423d-9678-cd14bdf69054',
    size: 0.00285687,
    originalAvgBuyPrice: 67069.06,
    sellPrice: 67344.32,
    note: 'sibling body avgPrice=67069.06',
  },
  {
    sellOrderId: '2cb8f4c2-b766-4795-9634-e6412c5d3961',
    size: 0.00596282,
    originalAvgBuyPrice: 66947.08,
    sellPrice: 67237.60,
    note: 'combined 2 fills, sibling body avgPrice=66947.08',
  },
  {
    sellOrderId: '950d21e9-92a7-442c-b8f1-0e67a85253d4',
    size: 0.001476,
    originalAvgBuyPrice: 67609.19,
    sellPrice: 67893.14,
    note: 'sibling body avgPrice=67609.19',
  },
  {
    sellOrderId: 'c2fffbec-5a88-4f72-8f01-c92e6a64483c',
    size: 0.00146278,
    originalAvgBuyPrice: 66940.61,
    sellPrice: 68506.19,
    note: 'dashboard P&L +$2.24 → derived avgBuy=66940.61',
  },
  {
    sellOrderId: 'd86b9229-9b01-4fc5-a47e-b30e7e896484',
    size: 0.01879128,
    originalAvgBuyPrice: 69042.66,
    sellPrice: 69319.89,
    note: 'race condition duplicate TP — body mll3fd2y',
  },
];

function calcMaxBuyPrice(originalAvgBuyPrice) {
  const raw = originalAvgBuyPrice / (1 + FEE_RATE);
  return Math.floor(raw * 100) / 100;
}

function loadPending() {
  if (fs.existsSync(PENDING_FILE)) {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  }
  return [];
}

function savePending(pending) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
}

// ── Place orders (safe while engine is running) ──────────────────────
async function placeOrders(adapter) {
  const pending = loadPending();
  const alreadyPlacedSells = new Set(pending.map(p => p.sellOrderId));

  const balance = await adapter.getAccountBalance('USDC');
  console.log(`💰 USDC available: $${balance.available}`);

  const price = await adapter.getCurrentPrice(PRODUCT_ID);
  console.log(`📊 Current BTC price: $${price}\n`);

  let placed = 0;
  for (const correction of CORRECTIONS) {
    if (alreadyPlacedSells.has(correction.sellOrderId)) {
      console.log(`⏭️  Already placed for sell ${correction.sellOrderId.slice(0, 8)} — skipping`);
      continue;
    }

    const maxPrice = calcMaxBuyPrice(correction.originalAvgBuyPrice);
    console.log(`\n📋 Orphan sell ${correction.sellOrderId.slice(0, 8)}:`);
    console.log(`   Size: ${correction.size} BTC @ max $${maxPrice.toFixed(2)}`);
    console.log(`   (original avg buy: $${correction.originalAvgBuyPrice}, sold: $${correction.sellPrice})`);

    const result = await adapter.placeLimitBuy(PRODUCT_ID, correction.size, maxPrice, { postOnly: true });

    if (!result.success) {
      console.log(`   ❌ FAILED: ${result.errorMessage}`);
      continue;
    }

    console.log(`   ✅ Placed: ${result.orderId} — ${result.baseSize} BTC @ $${result.limitPrice}`);
    placed++;

    pending.push({
      buyOrderId: result.orderId,
      clientOrderId: result.clientOrderId,
      sellOrderId: correction.sellOrderId,
      size: result.baseSize,
      limitPrice: result.limitPrice,
      placedAt: new Date().toISOString(),
      filled: false,
      annotated: false,
      note: correction.note,
    });
    savePending(pending);
  }

  console.log(`\n📊 ${placed} order(s) placed. Mapping saved to ${PENDING_FILE}`);
  console.log('   Orders sit on the book as GTC limit buys.');
  console.log('   Run --status to check fill progress.');
  console.log('   Run --annotate after fills complete (with engine stopped).');
}

// ── Check status (safe while engine is running) ──────────────────────
async function checkStatus(adapter) {
  const pending = loadPending();
  if (pending.length === 0) {
    console.log('No pending corrective buys. Run without flags to place orders first.');
    return;
  }

  console.log(`📊 Checking ${pending.length} corrective buy order(s)...\n`);

  let filledCount = 0;
  let openCount = 0;

  for (const order of pending) {
    if (order.filled) {
      console.log(`   ✅ ${order.buyOrderId.slice(0, 8)} → FILLED (sell: ${order.sellOrderId.slice(0, 8)}) ${order.annotated ? '[annotated]' : '[needs --annotate]'}`);
      filledCount++;
      continue;
    }

    const status = await adapter.getOrder(order.buyOrderId).catch(() => null);
    if (!status) {
      console.log(`   ⚠️  ${order.buyOrderId.slice(0, 8)} → could not fetch`);
      continue;
    }

    if (status.status === 'FILLED' || status.completionPercentage >= 100) {
      console.log(`   🎯 ${order.buyOrderId.slice(0, 8)} → FILLED! (sell: ${order.sellOrderId.slice(0, 8)}) [needs --annotate]`);
      order.filled = true;
      order.filledAt = new Date().toISOString();
      savePending(pending);
      filledCount++;
    } else if (status.status === 'CANCELLED') {
      console.log(`   ❌ ${order.buyOrderId.slice(0, 8)} → CANCELLED`);
      order.filled = true;
      order.cancelled = true;
      order.cancelledAt = new Date().toISOString();
      savePending(pending);
    } else {
      console.log(`   ⏳ ${order.buyOrderId.slice(0, 8)} → ${status.status} @ $${order.limitPrice} (sell: ${order.sellOrderId.slice(0, 8)})`);
      openCount++;
    }
  }

  console.log(`\nSummary: ${filledCount} filled, ${openCount} open`);
  if (filledCount > 0 && pending.some(p => p.filled && !p.annotated && !p.cancelled)) {
    console.log('\n⚡ Some fills need annotation. Run:');
    console.log('   pm2 stop critical-mass');
    console.log('   node scripts/place-corrective-buys.js --annotate');
    console.log('   pm2 start critical-mass');
  }
}

// ── Annotate fills (requires engine stopped) ─────────────────────────
async function annotateFills(adapter) {
  const pending = loadPending();
  const needsAnnotation = pending.filter(p => p.filled && !p.annotated && !p.cancelled);

  if (needsAnnotation.length === 0) {
    console.log('No fills need annotation. Run --status to check order progress.');
    return;
  }

  // Safety check: warn if engine might be running
  console.log('⚠️  Make sure critical-mass engine is stopped before annotating!');
  console.log('   (pm2 stop critical-mass)\n');

  const fillLedger = createFillLedger(EXCHANGE);

  for (const order of needsAnnotation) {
    console.log(`\n🔗 Processing buy ${order.buyOrderId.slice(0, 8)} → sell ${order.sellOrderId.slice(0, 8)}:`);

    // Fetch fill data from exchange
    const fills = await adapter.getOrderFills(order.buyOrderId).catch(() => []);
    if (fills.length === 0) {
      console.log('   ⚠️  No fills found on exchange — skipping');
      continue;
    }

    // Ingest each fill into the ledger
    for (const fill of fills) {
      const result = fillLedger.ingestFill({
        tradeId: fill.tradeId,
        orderId: order.buyOrderId,
        side: 'buy',
        price: fill.price,
        size: fill.size,
        totalCommission: fill.totalCommission,
        rebate: fill.rebate,
        liquidityIndicator: fill.liquidityIndicator,
        tradeTime: fill.tradeTime,
      });
      if (result.ingested) {
        console.log(`   📝 Ingested: ${fill.size} BTC @ $${fill.price} (fee: $${fill.netFee?.toFixed(4)})`);
      } else {
        console.log(`   ⏭️  Already in ledger: tradeId=${fill.tradeId}`);
      }
    }

    // Annotate with the orphan sell order ID
    fillLedger.annotateFillsByOrderId(order.buyOrderId, {
      sellOrderId: order.sellOrderId,
      correctiveBuy: true,
    });
    console.log(`   ✅ Annotated: sellOrderId=${order.sellOrderId.slice(0, 8)}`);

    order.annotated = true;
    order.annotatedAt = new Date().toISOString();
    savePending(pending);
  }

  console.log('\n🎉 Annotation complete! Restart the engine:');
  console.log('   pm2 start critical-mass');
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv.includes('--annotate') ? 'annotate'
    : process.argv.includes('--status') ? 'status'
    : 'place';

  console.log('🔧 Corrective Buy Manager for Orphan Sells');
  console.log('===========================================\n');

  const adapter = createCoinbaseAdapter();

  if (mode === 'place') await placeOrders(adapter);
  else if (mode === 'status') await checkStatus(adapter);
  else if (mode === 'annotate') await annotateFills(adapter);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
