#!/usr/bin/env node
/**
 * DEPRECATED — One-off script for a specific corrective buy (order 2cb8f4c2).
 * Kept for audit trail only. Use scripts/place-corrective-buys.js for future corrections.
 *
 * Place corrective limit buy for remaining uncovered portion of orphan sell 2cb8f4c2.
 *
 * Original sell: 0.00596282 BTC @ $67,237.60
 * Already covered: 0.00268593 BTC (split-2 recovery buy)
 * Remaining: 0.00327689 BTC
 *
 * Usage: node scripts/place-corrective-buy-2cb8f4c2.js
 */

const fs = require('fs');
const path = require('path');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

const PRODUCT_ID = 'BTC-USDC';
const FEE_RATE = 0.0005;
const PENDING_FILE = path.join(__dirname, '..', 'data', 'coinbase', 'pending-corrective-buys.json');

const SELL_ORDER_ID = '2cb8f4c2-b766-4795-9634-e6412c5d3961';
const REMAINING_SIZE = 0.00327689;
const ORIGINAL_AVG_BUY_PRICE = 66947.08;
const MAX_BUY_PRICE = Math.floor((ORIGINAL_AVG_BUY_PRICE / (1 + FEE_RATE)) * 100) / 100;

async function main() {
  const adapter = createCoinbaseAdapter();

  const price = await adapter.getCurrentPrice(PRODUCT_ID);
  console.log(`📊 Current BTC price: $${price}`);
  console.log(`📋 Orphan sell ${SELL_ORDER_ID.slice(0, 8)}:`);
  console.log(`   Remaining uncovered: ${REMAINING_SIZE} BTC`);
  console.log(`   Max buy price: $${MAX_BUY_PRICE} (original avg: $${ORIGINAL_AVG_BUY_PRICE})`);

  const result = await adapter.placeLimitBuy(PRODUCT_ID, REMAINING_SIZE, MAX_BUY_PRICE, { postOnly: true });

  if (!result.success) {
    console.log(`   ❌ FAILED: ${result.errorMessage}`);
    process.exit(1);
  }

  console.log(`   ✅ Placed: ${result.orderId} — ${result.baseSize} BTC @ $${result.limitPrice}`);

  // Update pending-corrective-buys.json
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));

  // Mark old entry as replaced
  const oldEntry = pending.find(p => p.sellOrderId === SELL_ORDER_ID);
  if (oldEntry) {
    oldEntry.replaced = true;
    oldEntry.replacedNote = `Replaced with smaller order for remaining ${REMAINING_SIZE} BTC (split-2 covers 0.00268593)`;
  }

  pending.push({
    buyOrderId: result.orderId,
    clientOrderId: result.clientOrderId,
    sellOrderId: SELL_ORDER_ID,
    size: result.baseSize,
    limitPrice: result.limitPrice,
    placedAt: new Date().toISOString(),
    filled: false,
    annotated: false,
    note: `Remaining uncovered portion after split-2 reassignment (0.00268593 BTC already covered)`,
  });

  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  console.log(`\n💾 Saved to pending-corrective-buys.json`);
  console.log(`   GTC limit buy sitting on the book at $${MAX_BUY_PRICE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
