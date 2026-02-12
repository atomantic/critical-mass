#!/usr/bin/env node
/**
 * Recovery Buy: Market buy to cover BTC oversold by duplicate TP orders
 *
 * Three duplicate TP sells placed BTC we didn't have:
 *   3b5737ff: 0.00514358 BTC @ $69,586.47 (dup of da726af9, body-ba245864)
 *   9e935edf: 0.00268593 BTC @ $78,352.67 (orphan dup, pre-celestial)
 *   f6369787: 0.00044283 BTC @ $67,872.32 (dup of 31159418, body-27354c01)
 *   Total: 0.00827234 BTC sold @ avg $72,341
 *
 * This script buys back the BTC at current market price, which should be
 * lower than the sell prices, locking in the spread as profit.
 *
 * The purchased BTC is distributed to the existing active bodies
 * (added as reserves since the position was already squared off by the
 * original TP sells).
 *
 * Usage: node scripts/recover-duplicate-tp-btc.js [--dry-run]
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC } = require('../src/volatility-utils');

const DATA_DIR = path.join(__dirname, '../data/coinbase');
const LEDGER_PATH = path.join(DATA_DIR, 'fill-ledger.json');
const KEYS_PATH = path.join(__dirname, '../data/coinbase-keys.json');

const DRY_RUN = process.argv.includes('--dry-run');
const API_URL = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-USDC';

// The 3 duplicate sells and total BTC to recover
const DUPLICATE_SELLS = [
  { orderId: '3b5737ff-54af-4291-93b8-7fa200f73c61', btc: 0.00514358, price: 69586.47, bodyId: 'body-ba245864-mlf4r8dr' },
  { orderId: '9e935edf-1893-4ed1-941b-673b7cb6c469', btc: 0.00268593, price: 78352.67, bodyId: null },
  { orderId: 'f6369787-d794-4f25-8bd9-984afde5ce91', btc: 0.00044283, price: 67872.32, bodyId: 'body-27354c01-mlij69f5' },
];
const RECOVERY_BTC = DUPLICATE_SELLS.reduce((s, d) => s + d.btc, 0); // 0.00827234

// Auth helpers (mirror adapter)
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

const fetchFillsForOrder = async (orderId) => {
  const apiPath = `/api/v3/brokerage/orders/historical/fills?order_id=${orderId}&product_id=${PRODUCT_ID}`;
  const data = await makeRequest('GET', apiPath);
  return data.fills || [];
};

const fetchSpotPrice = async () => {
  const apiPath = `/api/v3/brokerage/best_bid_ask?product_ids=${PRODUCT_ID}`;
  const data = await makeRequest('GET', apiPath);
  const pricebook = data.pricebooks?.[0];
  return pricebook ? parseFloat(pricebook.bids?.[0]?.price || 0) : 0;
};

async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RECOVER BTC — Cover duplicate TP oversell');
  console.log('═══════════════════════════════════════════════════════\n');
  if (DRY_RUN) console.log('  *** DRY RUN — no orders will be placed ***\n');

  const totalSellUsdc = DUPLICATE_SELLS.reduce((s, d) => s + d.btc * d.price, 0);
  const avgSellPrice = totalSellUsdc / RECOVERY_BTC;
  console.log(`📋 Duplicate sells to cover:`);
  for (const d of DUPLICATE_SELLS) {
    console.log(`   ${d.orderId.slice(0, 8)}: ${d.btc} BTC @ $${d.price}`);
  }
  console.log(`   Total: ${roundBTC(RECOVERY_BTC)} BTC (avg sell $${roundUSDC(avgSellPrice)})`);

  // Get current price
  const currentBid = await fetchSpotPrice();
  console.log(`\n📊 Current bid: $${currentBid.toLocaleString()}`);

  const estCost = RECOVERY_BTC * currentBid;
  const estFee = estCost * 0.006;
  const estProfit = totalSellUsdc - estCost - estFee;
  console.log(`   Est cost: $${roundUSDC(estCost)} + $${roundUSDC(estFee)} fee = $${roundUSDC(estCost + estFee)}`);
  console.log(`   Est profit: $${roundUSDC(estProfit)} (${(estProfit / (estCost + estFee) * 100).toFixed(1)}%)`);

  if (estProfit < 0) {
    console.log(`\n⚠️  Recovery would be at a LOSS ($${roundUSDC(estProfit)}). Aborting.`);
    process.exit(1);
  }

  // Place market buy
  const clientOrderId = `recovery-duptp-${Date.now()}`;
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

  if (DRY_RUN) {
    console.log('\n📝 [DRY RUN] Would place market buy:');
    console.log(`   ${JSON.stringify(orderData.order_configuration, null, 2)}`);
    console.log('\n  Exiting dry run.\n');
    return;
  }

  console.log('\n📝 Placing market buy order...');
  const orderResult = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

  if (!orderResult.success) {
    console.error(`❌ Order failed: ${orderResult.failure_reason || 'Unknown'}`);
    console.error(JSON.stringify(orderResult, null, 2));
    process.exit(1);
  }

  const orderId = orderResult.success_response?.order_id || orderResult.order_id;
  console.log(`✅ Order placed: ${orderId}`);

  // Wait for fill
  console.log('⏳ Waiting for fill...');
  await new Promise(r => setTimeout(r, 3000));

  let fills = await fetchFillsForOrder(orderId);
  if (fills.length === 0) {
    console.log('⚠️  No fills yet, retrying in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    fills = await fetchFillsForOrder(orderId);
  }

  if (fills.length === 0) {
    console.error('❌ No fills found after order. Check manually: ' + orderId);
    process.exit(1);
  }

  let totalBtcBought = 0;
  let totalUsdcSpent = 0;
  let totalFees = 0;

  for (const f of fills) {
    const price = parseFloat(f.price);
    const size = parseFloat(f.size);
    const fee = parseFloat(f.commission || 0);
    totalBtcBought += size;
    totalUsdcSpent += price * size;
    totalFees += fee;
    console.log(`  Fill: ${size} BTC @ $${price.toFixed(2)} (fee: $${fee.toFixed(4)})`);
  }

  const avgBuyPrice = totalBtcBought > 0 ? totalUsdcSpent / totalBtcBought : 0;
  const actualProfit = totalSellUsdc - totalUsdcSpent - totalFees;
  console.log(`\n📊 Total: ${roundBTC(totalBtcBought)} BTC @ avg $${roundUSDC(avgBuyPrice)}`);
  console.log(`   Cost: $${roundUSDC(totalUsdcSpent)} + $${roundUSDC(totalFees)} fees`);
  console.log(`   Profit: $${roundUSDC(actualProfit)}`);

  // Annotate fill-ledger
  console.log('\n📝 Updating fill-ledger...');
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

  // Determine current cycle from ledger
  const cycleIds = ledger.filter(f => f.cycleId).map(f => f.cycleId);
  const maxCycleNum = cycleIds.reduce((max, id) => {
    const num = parseInt(id.replace('cycle-', ''), 10);
    return num > max ? num : max;
  }, 0);
  const currentCycleId = `cycle-${maxCycleNum}`;

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
      cycleId: currentCycleId,
      isRecoveryBuy: true,
      recoveryNote: `Covers ${DUPLICATE_SELLS.length} duplicate TP sells (${roundBTC(RECOVERY_BTC)} BTC total)`,
    };

    ledger.push(newFill);
    console.log(`  ✅ Buy fill added: ${f.trade_id.slice(0, 12)}`);
  }

  // Backup and save
  const backupPath = LEDGER_PATH + '.backup-recovery-duptp-' + Date.now();
  fs.copyFileSync(LEDGER_PATH, backupPath);
  console.log(`💾 Backup: ${path.basename(backupPath)}`);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log('✅ fill-ledger.json updated');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RECOVERY COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Order ID:      ${orderId}`);
  console.log(`  BTC bought:    ${roundBTC(totalBtcBought)}`);
  console.log(`  Avg buy price: $${roundUSDC(avgBuyPrice)}`);
  console.log(`  Total cost:    $${roundUSDC(totalUsdcSpent + totalFees)}`);
  console.log(`  Sold for:      $${roundUSDC(totalSellUsdc)}`);
  console.log(`  Net profit:    $${roundUSDC(actualProfit)}`);
  console.log('');
  console.log('  Next: restart engine with pm2 restart ecosystem.config.js');
  console.log('  The recovery buy will be ingested as a new celestial body on startup.');
  console.log('');
}

main().catch(err => {
  console.error('❌ Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
