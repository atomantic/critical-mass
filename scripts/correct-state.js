#!/usr/bin/env node
/**
 * Correct regime engine state and place TP order
 * Usage: node scripts/correct-state.js
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC, roundPrice } = require('../src/volatility-utils');

const API_URL = 'https://api.coinbase.com';
const productId = 'BTC-USDC';

// Load config
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const regimeConfig = config.exchanges.coinbase.regime;

// Load API keys
const keysPath = path.join(__dirname, '../data/coinbase-keys.json');
const keysRaw = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const keys = {
  apiKey: keysRaw.name,
  apiSecret: keysRaw.privateKey,
};

const preparePrivateKey = (rawKey) => {
  if (!rawKey.includes('-----BEGIN')) return rawKey;
  const pemMatch = rawKey.match(/(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)/s);
  if (!pemMatch) return rawKey;
  const [, header, content, footer] = pemMatch;
  const cleanContent = content.replace(/[\s\n\r]/g, '');
  const lines = [];
  for (let i = 0; i < cleanContent.length; i += 64) {
    lines.push(cleanContent.substring(i, i + 64));
  }
  return `${header}\n${lines.join('\n')}\n${footer}\n`;
};

const generateJWT = (apiKey, apiSecret, method, apiPath) => {
  const pemKey = preparePrivateKey(apiSecret);
  const pathWithoutQuery = apiPath.split('?')[0];
  const uri = `${method} api.coinbase.com${pathWithoutQuery}`;
  return jwt.sign(
    {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey,
      uri,
    },
    pemKey,
    {
      algorithm: 'ES256',
      header: {
        kid: apiKey,
        nonce: crypto.randomBytes(16).toString('hex'),
      },
    }
  );
};

const makeRequest = async (method, apiPath, data = null) => {
  const token = generateJWT(keys.apiKey, keys.apiSecret, method, apiPath);
  const config = {
    method,
    url: `${API_URL}${apiPath}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
};

async function main() {
  console.log('🔧 Correcting regime engine state...\n');

  // 1. Query filled orders to get correct position
  const response = await makeRequest(
    'GET',
    `/api/v3/brokerage/orders/historical/batch?product_ids=${productId}&order_status=FILLED&limit=100`
  );

  const orders = response.orders || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalBTC = 0;
  let totalCostBasis = 0;
  const buyOrders = [];

  for (const order of orders) {
    const orderDate = new Date(order.created_time);
    const isBuy = order.side === 'BUY';
    const filledSize = parseFloat(order.filled_size || 0);
    const filledValue = parseFloat(order.filled_value || 0);
    const fees = parseFloat(order.total_fees || 0);

    if (orderDate >= today && isBuy && filledSize > 0) {
      buyOrders.push(order);
      totalBTC += filledSize;
      totalCostBasis += filledValue + fees;
    }
  }

  const avgCostBasis = totalBTC > 0 ? totalCostBasis / totalBTC : 0;
  console.log(`Position: ${roundBTC(totalBTC)} BTC @ avg $${roundUSDC(avgCostBasis)}`);
  console.log(`Ladder step: ${buyOrders.length}`);

  // 2. Calculate TP price using config
  const tpMinPercent = regimeConfig.tpMinPercent || 0.3;
  // Round to 2 decimal places for Coinbase
  const tpPrice = Math.round(avgCostBasis * (1 + tpMinPercent / 100) * 100) / 100;
  console.log(`\nTP Price: $${tpPrice} (${tpMinPercent}% above cost basis)`);

  // 3. Calculate holdback
  const holdbackRatio = regimeConfig.holdbackRatio || 0.5;
  const profit = tpPrice * totalBTC - totalCostBasis;
  const profitBtc = profit / tpPrice;
  const holdbackBtc = roundBTC(profitBtc * holdbackRatio);
  const sellBtc = roundBTC(totalBTC - holdbackBtc);

  console.log(`\nHoldback calculation (ratio=${holdbackRatio}):`);
  console.log(`  Expected profit at TP: $${roundUSDC(profit)}`);
  console.log(`  Holdback BTC: ${holdbackBtc} BTC`);
  console.log(`  Sell BTC: ${sellBtc} BTC`);

  // 4. Update state file
  const statePath = path.join(__dirname, '../data/coinbase/regime-state.json');
  let state = {};
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }

  state.position = {
    ...state.position,
    totalBTC: roundBTC(totalBTC),
    totalCostBasis: roundUSDC(totalCostBasis),
    avgCostBasis: roundUSDC(avgCostBasis),
    ladderStep: buyOrders.length,
    lastEntryPrice: avgCostBasis,
    lastEntryTime: Date.now(),
    anchorPrice: avgCostBasis,
    activeTpOrderId: null,
    lastTpPrice: 0,
    btcOnOrder: 0,
  };

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`\n✅ Updated state file: ${statePath}`);

  // 5. Place TP order
  console.log(`\n📝 Placing TP sell order: ${sellBtc} BTC @ $${tpPrice}...`);

  const orderData = {
    client_order_id: `TP-${Date.now()}`,
    product_id: productId,
    side: 'SELL',
    order_configuration: {
      limit_limit_gtc: {
        base_size: sellBtc.toFixed(8),
        limit_price: tpPrice.toFixed(2),
        post_only: false,
      },
    },
  };

  const orderResult = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

  if (orderResult.success) {
    const orderId = orderResult.success_response?.order_id || orderResult.order_id;
    console.log(`✅ TP order placed: ${orderId}`);

    // Update state with TP order
    state.position.activeTpOrderId = orderId;
    state.position.lastTpPrice = tpPrice;
    state.position.btcOnOrder = sellBtc;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log('✅ State updated with TP order');
  } else {
    console.log(`❌ TP order failed: ${orderResult.failure_reason || 'Unknown'}`);
    console.log(JSON.stringify(orderResult, null, 2));
  }

  console.log('\n⚠️  Remember to restart the regime engine to load the corrected state!');
}

main().catch(console.error);
