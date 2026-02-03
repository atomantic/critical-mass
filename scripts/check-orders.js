#!/usr/bin/env node
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.coinbase.com';
const productId = 'BTC-USDC';

const keysPath = path.join(__dirname, '../data/coinbase-keys.json');
const keysRaw = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const preparePrivateKey = (rawKey) => {
  if (!rawKey.includes('-----BEGIN')) return rawKey;
  const pemMatch = rawKey.match(/(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)/s);
  if (!pemMatch) return rawKey;
  const [, header, content, footer] = pemMatch;
  const cleanContent = content.replace(/[\s\n\r]/g, '');
  const lines = [];
  for (let i = 0; i < cleanContent.length; i += 64) lines.push(cleanContent.substring(i, i + 64));
  return header + '\n' + lines.join('\n') + '\n' + footer + '\n';
};

const generateJWT = (apiKey, apiSecret, method, apiPath) => {
  const pemKey = preparePrivateKey(apiSecret);
  const pathWithoutQuery = apiPath.split('?')[0];
  const uri = method + ' api.coinbase.com' + pathWithoutQuery;
  return jwt.sign({ iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri }, pemKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });
};

async function main() {
  const apiPath = '/api/v3/brokerage/orders/historical/batch?product_ids=' + productId + '&order_status=OPEN';
  const token = generateJWT(keys.apiKey, keys.apiSecret, 'GET', apiPath);
  const response = await axios.get(API_URL + apiPath, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  console.log('Open orders:');
  for (const order of response.data.orders || []) {
    console.log('  ' + order.side + ' ' + order.filled_size + '/' + (order.order_configuration?.limit_limit_gtc?.base_size || '?') + ' @ $' + (order.order_configuration?.limit_limit_gtc?.limit_price || order.average_filled_price || '?') + ' - ' + order.order_id);
  }
}

main().catch(console.error);
