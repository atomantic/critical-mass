#!/usr/bin/env node
/**
 * Restore regime engine state from Coinbase fills (most recent 15 orders only)
 */

const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC } = require('../src/volatility-utils');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { DATA_DIR } = require('../src/paths');

const API_URL = 'https://api.coinbase.com';
const productId = 'BTC-USDC';

const keysRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'coinbase-keys.json'), 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const makeRequest = async (method, apiPath, data = null) => {
  const fetchOptions = {
    method,
    headers: getAuthHeaders(keys.apiKey, keys.apiSecret, method, apiPath),
  };
  if (data) fetchOptions.body = JSON.stringify(data);
  const resp = await fetch(`${API_URL}${apiPath}`, fetchOptions);
  if (!resp.ok) throw new Error(`Coinbase API ${resp.status}: ${resp.statusText}`);
  return resp.json();
};

async function main() {
  console.log('🔧 Restoring regime engine state from today\'s orders...\n');

  // Query filled orders
  const response = await makeRequest('GET', '/api/v3/brokerage/orders/historical/batch?product_ids=' + productId + '&order_status=FILLED&limit=100');
  const orders = response.orders || [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Filter to today's BUY orders and sort by time
  const todayBuys = orders
    .filter(o => {
      const orderDate = new Date(o.created_time);
      return orderDate >= today && o.side === 'BUY' && parseFloat(o.filled_size || 0) > 0;
    })
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));

  // Use all of today's buy orders
  const recentOrders = todayBuys;

  console.log('Found ' + todayBuys.length + ' total buy orders today');
  console.log('Using all orders:\n');

  let totalBTC = 0;
  let totalCostBasis = 0;
  const fills = [];

  for (const order of recentOrders) {
    const filledSize = parseFloat(order.filled_size || 0);
    const filledValue = parseFloat(order.filled_value || 0);
    const avgPrice = parseFloat(order.average_filled_price || 0);
    const fees = parseFloat(order.total_fees || 0);

    totalBTC += filledSize;
    totalCostBasis += filledValue + fees;

    console.log('  ' + order.created_time + ': ' + filledSize.toFixed(8) + ' BTC @ $' + avgPrice.toFixed(2));

    fills.push({
      tradeId: 'fill-' + order.order_id,
      orderId: order.order_id,
      side: 'buy',
      price: avgPrice,
      size: filledSize,
      quoteAmount: filledValue,
      fee: fees,
      feeAsset: 'USDC',
      rebate: 0,
      netFee: fees,
      liquidityIndicator: 'MAKER',
      timestamp: new Date(order.created_time).getTime(),
      ingestedAt: Date.now(),
      cycleId: null,
    });
  }

  const avgCostBasis = totalBTC > 0 ? totalCostBasis / totalBTC : 0;
  console.log('\n=== POSITION ===');
  console.log('Total BTC:      ' + roundBTC(totalBTC) + ' BTC');
  console.log('Total Cost:     $' + roundUSDC(totalCostBasis));
  console.log('Avg Cost Basis: $' + roundUSDC(avgCostBasis));
  console.log('Orders:         ' + fills.length);

  // Calculate TP with holdback
  const configPath = path.join(__dirname, '../config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const regimeConfig = config.exchanges.coinbase.regime;
  const tpMinPercent = regimeConfig.tpMinPercent || 0.1;
  const holdbackRatio = regimeConfig.holdbackRatio || 0.5;

  const tpPrice = Math.round(avgCostBasis * (1 + tpMinPercent / 100) * 100) / 100;
  const profit = tpPrice * totalBTC - totalCostBasis;
  const profitBtc = profit / tpPrice;
  const holdbackBtc = roundBTC(profitBtc * holdbackRatio);
  const sellBtc = roundBTC(totalBTC - holdbackBtc);

  console.log('\nTP @ $' + tpPrice + ' (' + tpMinPercent + '% above cost)');
  console.log('Sell: ' + sellBtc + ' BTC, Holdback: ' + holdbackBtc + ' BTC');

  // Update state file
  const statePath = path.join(DATA_DIR, 'coinbase/regime-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  state.position = {
    totalBTC: roundBTC(totalBTC),
    totalCostBasis: roundUSDC(totalCostBasis),
    avgCostBasis: roundUSDC(avgCostBasis),
    ladderStep: fills.length,
    lastEntryPrice: avgCostBasis,
    lastEntryTime: Date.now(),
    anchorPrice: avgCostBasis,
    activeTpOrderId: null,
    lastTpPrice: 0,
    cyclesCompleted: 0,
    unrealizedPnL: 0,
    realizedPnL: 0,
    realizedBtcPnL: 0,
    btcOnOrder: 0,
    maxDrawdownSeen: 0,
    scalingDisabled: false,
    scalingDisabledReason: null,
    engineStartTime: Date.now(),
    initialCapital: regimeConfig.maxUsdcDeployed || 10000,
  };

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log('\n✅ State file updated');

  // Update fill ledger
  const fillLedgerPath = path.join(DATA_DIR, 'coinbase/fill-ledger.json');
  fs.writeFileSync(fillLedgerPath, JSON.stringify(fills, null, 2));
  console.log('✅ Fill ledger updated with ' + fills.length + ' fills');

  console.log('\n✅ Done! Restart the engine now.');
}

main().catch(console.error);
