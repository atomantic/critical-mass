#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { DATA_DIR } = require('../src/paths');

const API_URL = 'https://api.coinbase.com';
const productId = 'BTC-USDC';

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
  const apiPath = '/api/v3/brokerage/orders/historical/batch?product_ids=' + productId + '&order_status=OPEN';
  const response = await makeRequest('GET', apiPath);
  console.log('Open orders:');
  for (const order of response.orders || []) {
    console.log('  ' + order.side + ' ' + order.filled_size + '/' + (order.order_configuration?.limit_limit_gtc?.base_size || '?') + ' @ $' + (order.order_configuration?.limit_limit_gtc?.limit_price || order.average_filled_price || '?') + ' - ' + order.order_id);
  }
}

main().catch(console.error);
