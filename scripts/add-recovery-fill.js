#!/usr/bin/env node
/**
 * Re-add the ec8b7bcb recovery buy fill that was lost when the engine
 * overwrote the ledger. Fetches fill from Coinbase API, adds to ledger,
 * and updates realizedPnL + maxUsdcDeployed for the round-trip profit.
 *
 * Usage: node scripts/add-recovery-fill.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { roundBTC, roundUSDC } = require('../src/volatility-utils');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { updateRegimeConfig } = require('../src/config-utils');

const { DATA_DIR } = require('../src/paths');
const COINBASE_DIR = path.join(DATA_DIR, 'coinbase');
const LEDGER_PATH = path.join(COINBASE_DIR, 'fill-ledger.json');
const STATE_PATH = path.join(COINBASE_DIR, 'regime-state.json');
const DRY_RUN = process.argv.includes('--dry-run');
const API_URL = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-USDC';

const RECOVERY_ORDER_ID = 'ba399979-6972-4fcb-a715-d2bf21e4d641';
const EC8B_SELL_ORDER_ID = 'ec8b7bcb-325a-4bad-a38e-3f76762e3494';
const EC8B_BODY_ID = 'body-mli0qebf';

const keysRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'coinbase-keys.json'), 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const makeRequest = async (method, apiPath) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(`${API_URL}${apiPath}`, {
      method,
      headers: getAuthHeaders(keys.apiKey, keys.apiSecret, method, apiPath),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Coinbase API ${resp.status}: ${resp.statusText}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
};

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ADD RECOVERY FILL — Re-add lost ec8b7bcb buy');
  console.log('═══════════════════════════════════════════════════\n');
  if (DRY_RUN) console.log('  *** DRY RUN ***\n');

  // 1. Fetch fill from exchange
  console.log(`📡 Fetching fills for order ${RECOVERY_ORDER_ID.slice(0, 8)}...`);
  const apiPath = `/api/v3/brokerage/orders/historical/fills?order_id=${RECOVERY_ORDER_ID}&product_id=${PRODUCT_ID}`;
  const data = await makeRequest('GET', apiPath);
  const fills = data.fills || [];

  if (fills.length === 0) {
    console.error('❌ No fills found for recovery order');
    process.exit(1);
  }

  console.log(`   Found ${fills.length} fill(s)`);

  // 2. Load ledger and state
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const pos = state.position;

  // Check if already in ledger
  const existing = ledger.find(f => f.orderId === RECOVERY_ORDER_ID);
  if (existing) {
    console.log('✅ Recovery fill already in ledger, skipping add');
  }

  // 3. Add fills to ledger
  let totalBuyBtc = 0;
  let totalBuyCost = 0;
  let totalBuyFees = 0;

  for (const f of fills) {
    const price = parseFloat(f.price);
    const size = parseFloat(f.size);
    const commissionDetail = f.commission_detail_total || {};
    const fee = parseFloat(commissionDetail.total_commission || f.commission || 0);
    const rebate = parseFloat(commissionDetail.rebate || 0);
    const netFee = roundUSDC(fee - rebate);
    totalBuyBtc += size;
    totalBuyCost += price * size;
    totalBuyFees += netFee;

    if (!existing) {
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
        rebate,
        netFee,
        liquidityIndicator: f.liquidity_indicator || 'TAKER',
        timestamp: fillTimestamp,
        ingestedAt: Date.now(),
        cycleId: 'cycle-11',
        sellOrderId: EC8B_SELL_ORDER_ID,
        isRecoveryBuy: true,
        bodyId: EC8B_BODY_ID,
        isBodyOwned: true,
      };
      if (!DRY_RUN) ledger.push(newFill);
      console.log(`   ✅ Buy fill: ${f.trade_id.slice(0, 12)} — ${size} BTC @ $${price.toFixed(2)} (fee $${fee.toFixed(4)}, rebate $${rebate.toFixed(4)}, net $${netFee.toFixed(4)})`);
    }
  }

  const avgBuyPrice = totalBuyBtc > 0 ? totalBuyCost / totalBuyBtc : 0;
  console.log(`\n📊 Recovery buy: ${roundBTC(totalBuyBtc)} BTC @ $${roundUSDC(avgBuyPrice)}, cost $${roundUSDC(totalBuyCost)}, net fees $${roundUSDC(totalBuyFees)}`);

  // 4. Calculate round-trip P&L
  // ec8b7bcb sell: proceeds minus fees
  const ec8bSell = ledger.find(f => f.orderId === EC8B_SELL_ORDER_ID && f.side === 'sell');
  if (!ec8bSell) {
    console.error('❌ ec8b7bcb sell fill not found in ledger');
    process.exit(1);
  }

  const sellProceeds = ec8bSell.quoteAmount - (ec8bSell.netFee || ec8bSell.fee || 0);
  const buyCost = totalBuyCost + totalBuyFees;
  const roundTripPnl = roundUSDC(sellProceeds - buyCost);

  console.log(`\n📊 Round-trip P&L:`);
  console.log(`   Sell proceeds: $${roundUSDC(sellProceeds)} (${ec8bSell.size} BTC @ $${ec8bSell.price} - $${roundUSDC(ec8bSell.netFee)} fee)`);
  console.log(`   Buy cost:      $${roundUSDC(buyCost)} (${roundBTC(totalBuyBtc)} BTC @ $${roundUSDC(avgBuyPrice)} + $${roundUSDC(totalBuyFees)} fee)`);
  console.log(`   P&L:           $${roundTripPnl} ${roundTripPnl >= 0 ? '✅' : '⚠️'}`);

  // 4b. Annotate ec8b7bcb sell with cost basis for dashboard P&L
  if (!DRY_RUN) {
    ec8bSell.bodyCostBasis = roundUSDC(buyCost);
    ec8bSell.bodyPnl = roundTripPnl;
  }
  console.log(`   bodyCostBasis: $${roundUSDC(buyCost)}`);

  // 5. Update state
  const oldPnl = pos.realizedPnL;
  const newPnl = roundUSDC(oldPnl + roundTripPnl);

  console.log(`\n🔧 State updates:`);
  console.log(`   realizedPnL: $${oldPnl} → $${newPnl}`);

  // Also update maxUsdcDeployed
  const configPath = path.join(__dirname, '../data/config.json');
  const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const oldMaxUsdc = userConfig.exchanges.coinbase.regime.maxUsdcDeployed;
  const newMaxUsdc = roundUSDC(oldMaxUsdc + roundTripPnl);
  console.log(`   maxUsdcDeployed: $${oldMaxUsdc} → $${newMaxUsdc}`);

  if (!DRY_RUN) {
    pos.realizedPnL = newPnl;

    // Save ledger
    ledger.sort((a, b) => a.timestamp - b.timestamp);
    const backupLedger = LEDGER_PATH + '.backup-addfill-' + Date.now();
    fs.copyFileSync(LEDGER_PATH, backupLedger);
    console.log(`\n💾 Backup: ${path.basename(backupLedger)}`);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    console.log('✅ fill-ledger.json saved');

    // Save state
    const backupState = STATE_PATH + '.backup-addfill-' + Date.now();
    fs.copyFileSync(STATE_PATH, backupState);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log('✅ regime-state.json saved');

    // Update config
    updateRegimeConfig('coinbase', { maxUsdcDeployed: newMaxUsdc });
    console.log('✅ config.json updated');
  }

  // 6. Verify
  console.log('\n🔍 Verification:');
  const recoveryFill = DRY_RUN ? null : ledger.find(f => f.orderId === RECOVERY_ORDER_ID);
  console.log(`   Recovery fill in ledger: ${recoveryFill ? '✅' : (DRY_RUN ? '(dry-run)' : '❌')}`);
  console.log(`   Recovery fill linked to ec8b7bcb: ${recoveryFill?.sellOrderId === EC8B_SELL_ORDER_ID ? '✅' : (DRY_RUN ? '(dry-run)' : '❌')}`);
  const ec8bBuys = ledger.filter(f => f.sellOrderId === EC8B_SELL_ORDER_ID && f.side === 'buy');
  console.log(`   ec8b7bcb linked buys: ${ec8bBuys.length} ${ec8bBuys.length === 1 ? '✅' : '❌'}`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
