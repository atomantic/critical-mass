#!/usr/bin/env node
/**
 * Recovery Buy: Place market buy for 0.017023 BTC
 *
 * Covers the ec8b7bcb double-sell short position caused by the body TP
 * cancel-and-replace race condition. After fill:
 *   - Annotates the buy fill in ledger with sellOrderId → ec8b7bcb
 *   - Annotates ec8b7bcb sell fill with correct body metadata
 *
 * Usage: node scripts/recover-btc.js [--dry-run]
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC } = require('../src/volatility-utils');

// ── Paths ──────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../data/coinbase');
const LEDGER_PATH = path.join(DATA_DIR, 'fill-ledger.json');
const STATE_PATH = path.join(DATA_DIR, 'regime-state.json');
const KEYS_PATH = path.join(__dirname, '../data/coinbase-keys.json');

const DRY_RUN = process.argv.includes('--dry-run');
const API_URL = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-USDC';

const RECOVERY_BTC = 0.017023;
const EC8B_SELL_ORDER_ID = 'ec8b7bcb-325a-4bad-a38e-3f76762e3494';
// The body that the ec8b7bcb sell should have been associated with
const EC8B_BODY_ID = 'body-mli0qebf';

// ── Auth helpers (mirror adapter) ──────────────────────────────
const keysRaw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

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
    { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
  );
};

const makeRequest = async (method, apiPath, data = null) => {
  const token = generateJWT(keys.apiKey, keys.apiSecret, method, apiPath);
  const config = {
    method,
    url: `${API_URL}${apiPath}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  };
  if (data) config.data = data;
  const resp = await axios(config);
  return resp.data;
};

// ── Fetch fills for a specific order ───────────────────────────
const fetchFillsForOrder = async (orderId) => {
  const apiPath = `/api/v3/brokerage/orders/historical/fills?order_id=${orderId}&product_id=${PRODUCT_ID}`;
  const data = await makeRequest('GET', apiPath);
  return data.fills || [];
};

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RECOVER BTC — Market buy to cover ec8b7bcb short');
  console.log('═══════════════════════════════════════════════════\n');
  if (DRY_RUN) console.log('  *** DRY RUN — no orders will be placed ***\n');

  console.log(`📋 Recovery buy: ${RECOVERY_BTC} BTC (market order)`);
  console.log(`📋 Will link to sell order: ${EC8B_SELL_ORDER_ID.slice(0, 8)}\n`);

  // 1. Place market buy order
  const clientOrderId = `recovery-ec8b-${Date.now()}`;
  const orderData = {
    client_order_id: clientOrderId,
    product_id: PRODUCT_ID,
    side: 'BUY',
    order_configuration: {
      market_market_ioc: {
        base_size: RECOVERY_BTC.toFixed(8),
      },
    },
  };

  let orderId;
  if (DRY_RUN) {
    console.log('  [DRY RUN] Would place market buy order:');
    console.log(`  ${JSON.stringify(orderData, null, 2)}`);
    console.log('\n  Exiting dry run.\n');
    return;
  }

  console.log('📝 Placing market buy order...');
  const orderResult = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

  if (!orderResult.success) {
    console.error(`❌ Order failed: ${orderResult.failure_reason || 'Unknown'}`);
    console.error(JSON.stringify(orderResult, null, 2));
    process.exit(1);
  }

  orderId = orderResult.success_response?.order_id || orderResult.order_id;
  console.log(`✅ Order placed: ${orderId}`);

  // 2. Wait for fill and fetch fill details
  console.log('⏳ Waiting for fill...');
  await new Promise(r => setTimeout(r, 3000));

  const fills = await fetchFillsForOrder(orderId);
  if (fills.length === 0) {
    console.log('⚠️  No fills yet, retrying in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    const retryFills = await fetchFillsForOrder(orderId);
    fills.push(...retryFills);
  }

  if (fills.length === 0) {
    console.error('❌ No fills found after order. Check manually.');
    process.exit(1);
  }

  let totalBtc = 0;
  let totalUsdc = 0;
  let totalFees = 0;

  for (const f of fills) {
    const price = parseFloat(f.price);
    const size = parseFloat(f.size);
    const fee = parseFloat(f.commission || 0);
    totalBtc += size;
    totalUsdc += price * size;
    totalFees += fee;
    console.log(`  Fill: ${size} BTC @ $${price.toFixed(2)} (fee: $${fee.toFixed(4)})`);
  }

  const avgPrice = totalBtc > 0 ? totalUsdc / totalBtc : 0;
  console.log(`\n📊 Total: ${roundBTC(totalBtc)} BTC @ avg $${roundUSDC(avgPrice)}, cost $${roundUSDC(totalUsdc)}, fees $${roundUSDC(totalFees)}`);

  // 3. Annotate fill-ledger
  console.log('\n📝 Updating fill-ledger...');
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

  // Add buy fill(s) to ledger with ec8b7bcb link
  for (const f of fills) {
    const price = parseFloat(f.price);
    const size = parseFloat(f.size);
    const fee = parseFloat(f.commission || 0);
    const fillTimestamp = new Date(f.trade_time).getTime();

    const newFill = {
      tradeId: f.trade_id,
      orderId: f.order_id,
      side: 'buy',
      price,
      size,
      quoteAmount: price * size,
      fee,
      feeAsset: 'USDC',
      rebate: 0,
      netFee: fee,
      liquidityIndicator: f.liquidity_indicator || 'TAKER',
      timestamp: fillTimestamp,
      ingestedAt: Date.now(),
      cycleId: 'cycle-11',
      sellOrderId: EC8B_SELL_ORDER_ID,
      isRecoveryBuy: true,
      bodyId: EC8B_BODY_ID,
    };

    ledger.push(newFill);
    console.log(`  ✅ Buy fill added: ${f.trade_id.slice(0, 12)} (linked to ${EC8B_SELL_ORDER_ID.slice(0, 8)})`);
  }

  // Annotate the ec8b7bcb sell fill with correct body metadata
  const ec8bSellFills = ledger.filter(f => f.orderId === EC8B_SELL_ORDER_ID && f.side === 'sell');
  for (const sf of ec8bSellFills) {
    sf.bodyId = EC8B_BODY_ID;
    sf.isRecoverySell = true;
    console.log(`  ✅ Sell fill annotated: ${sf.tradeId.slice(0, 12)} (bodyId: ${EC8B_BODY_ID})`);
  }

  // Sort and save
  ledger.sort((a, b) => a.timestamp - b.timestamp);
  const backupPath = LEDGER_PATH + '.backup-recovery-' + Date.now();
  fs.copyFileSync(LEDGER_PATH, backupPath);
  console.log(`💾 Backup: ${path.basename(backupPath)}`);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log('✅ fill-ledger.json updated');

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RECOVERY COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Order ID:      ${orderId}`);
  console.log(`  BTC bought:    ${roundBTC(totalBtc)}`);
  console.log(`  Avg price:     $${roundUSDC(avgPrice)}`);
  console.log(`  Total cost:    $${roundUSDC(totalUsdc + totalFees)}`);
  console.log(`  Linked to:     ${EC8B_SELL_ORDER_ID.slice(0, 8)}`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
