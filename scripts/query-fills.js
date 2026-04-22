#!/usr/bin/env node
/**
 * Query filled orders from Coinbase and calculate position state
 * Usage: node scripts/query-fills.js
 */

const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC } = require('../src/volatility-utils');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { DATA_DIR } = require('../src/paths');

const API_URL = 'https://api.coinbase.com';
const productId = 'BTC-USDC';

// Load API keys
const keysRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'coinbase-keys.json'), 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const makeRequest = async (method, apiPath) => {
  const resp = await fetch(`${API_URL}${apiPath}`, {
    method,
    headers: getAuthHeaders(keys.apiKey, keys.apiSecret, method, apiPath),
  });
  if (!resp.ok) throw new Error(`Coinbase API ${resp.status}: ${resp.statusText}`);
  return resp.json();
};

async function main() {
  console.log('🔍 Querying filled orders from Coinbase...\n');

  // Get recent filled orders
  const response = await makeRequest(
    'GET',
    `/api/v3/brokerage/orders/historical/batch?product_ids=${productId}&order_status=FILLED&limit=100`
  );

  const orders = response.orders || [];
  console.log(`Found ${orders.length} filled orders\n`);

  // Filter to today's orders
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalBTC = 0;
  let totalCostBasis = 0;
  let totalFees = 0;
  const buyOrders = [];

  for (const order of orders) {
    const orderDate = new Date(order.created_time);
    const isBuy = order.side === 'BUY';
    const filledSize = parseFloat(order.filled_size || 0);
    const filledValue = parseFloat(order.filled_value || 0);
    const avgPrice = parseFloat(order.average_filled_price || 0);
    const fees = parseFloat(order.total_fees || 0);

    // Only process today's buy orders
    if (orderDate >= today && isBuy && filledSize > 0) {
      buyOrders.push({
        orderId: order.order_id,
        time: order.created_time,
        size: filledSize,
        value: filledValue,
        avgPrice,
        fees,
      });

      totalBTC += filledSize;
      totalCostBasis += filledValue + fees;
      totalFees += fees;
    }
  }

  console.log('=== TODAY\'S FILLED BUY ORDERS ===\n');
  for (const order of buyOrders.sort((a, b) => new Date(a.time) - new Date(b.time))) {
    console.log(`${order.time}: ${order.size.toFixed(8)} BTC @ $${order.avgPrice.toFixed(2)} = $${order.value.toFixed(2)} (fees: $${order.fees.toFixed(4)})`);
  }

  console.log('\n=== POSITION SUMMARY ===\n');
  console.log(`Total BTC:        ${roundBTC(totalBTC)} BTC`);
  console.log(`Total Cost Basis: $${roundUSDC(totalCostBasis)}`);
  console.log(`Total Fees:       $${roundUSDC(totalFees)}`);
  console.log(`Avg Cost Basis:   $${totalBTC > 0 ? roundUSDC(totalCostBasis / totalBTC) : 0}`);
  console.log(`Orders Count:     ${buyOrders.length}`);

  // Get current price
  const tickerResp = await makeRequest('GET', `/api/v3/brokerage/products/${productId}`);
  const currentPrice = parseFloat(tickerResp.price);
  console.log(`\nCurrent Price:    $${currentPrice.toFixed(2)}`);

  // Suggest TP price (0.3% above avg cost)
  const avgCost = totalBTC > 0 ? totalCostBasis / totalBTC : 0;
  const suggestedTp = avgCost * 1.003;
  console.log(`Suggested TP:     $${roundUSDC(suggestedTp)} (0.3% above avg cost)`);

  // Output JSON for state correction
  console.log('\n=== JSON FOR STATE CORRECTION ===\n');
  console.log(JSON.stringify({
    totalBTC: roundBTC(totalBTC),
    totalCostBasis: roundUSDC(totalCostBasis),
    avgCostBasis: totalBTC > 0 ? roundUSDC(totalCostBasis / totalBTC) : 0,
    ladderStep: buyOrders.length,
    orderIds: buyOrders.map(o => o.orderId),
  }, null, 2));
}

main().catch(console.error);
