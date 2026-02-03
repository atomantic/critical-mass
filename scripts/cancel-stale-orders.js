#!/usr/bin/env node
/**
 * Cancel stale TP orders that don't match current position
 */

const { getAdapter } = require('../src/adapters');
const { loadRegimeState } = require('../src/state-tracker');

const exchange = process.argv[2] || 'coinbase';
const dryRun = process.argv[3] !== '--apply';

async function main() {
  const adapter = getAdapter(exchange);
  const state = loadRegimeState(exchange);
  const position = state.position || {};

  console.log(`\n📊 Current position:`);
  console.log(`   totalBTC: ${position.totalBTC}`);
  console.log(`   activeTpOrderId: ${position.activeTpOrderId}`);
  console.log(`   lastTpPrice: ${position.lastTpPrice}`);

  const orders = await adapter.getOpenOrders('BTC-USDC');
  const sellOrders = orders.filter(o => o.side === 'SELL');

  console.log(`\n📋 Open sell orders on ${exchange}:`);

  const staleOrders = [];

  for (const order of sellOrders) {
    const details = await adapter.getOrder(order.orderId);
    const size = parseFloat(details.filledSize) > 0
      ? details.totalSize - details.filledSize
      : details.totalSize || details.size;
    const price = details.averageFilledPrice || details.price;

    const isActive = order.orderId === position.activeTpOrderId;
    const status = isActive ? '✓ ACTIVE' : '⚠️ STALE';

    console.log(`\n   ${status}: ${order.orderId}`);
    console.log(`      Size: ${size} BTC`);
    console.log(`      Price: $${price}`);
    console.log(`      Created: ${order.createdTime}`);

    if (!isActive) {
      staleOrders.push({ orderId: order.orderId, size, price });
    }
  }

  if (staleOrders.length === 0) {
    console.log('\n✅ No stale orders found');
    return;
  }

  console.log(`\n⚠️ Found ${staleOrders.length} stale order(s) to cancel`);

  if (dryRun) {
    console.log('\n🔍 DRY RUN - add --apply to actually cancel orders');
    return;
  }

  console.log('\n🚫 Cancelling stale orders...');

  for (const order of staleOrders) {
    console.log(`   Cancelling ${order.orderId}...`);
    const result = await adapter.cancelOrder(order.orderId);
    if (result.success) {
      console.log(`   ✅ Cancelled`);
    } else {
      console.log(`   ❌ Failed: ${result.errorMessage}`);
    }
  }

  console.log('\n✅ Done');
}

main().catch(console.error);
