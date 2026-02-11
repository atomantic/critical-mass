#!/usr/bin/env node
/**
 * Split single recovery buy fill into 3 fills, one per duplicate TP sell order.
 * Each sub-fill gets the same buy price, proportional fees, and is linked
 * to its corresponding sell via sellOrderId + bodyId.
 *
 * Usage: node scripts/split-recovery-buy.js [--apply]
 */

const fs = require('fs');
const path = require('path');

const { roundBTC, roundUSDC } = require('../src/volatility-utils');

const dryRun = !process.argv.includes('--apply');
const ledgerPath = path.join(__dirname, '..', 'data', 'coinbase', 'fill-ledger.json');

const RECOVERY_ORDER_ID = '2c887acf-5fea-45cb-9cc7-451de65be2c5';

const DUPLICATE_SELLS = [
  { orderId: '3b5737ff-54af-4291-93b8-7fa200f73c61', btc: 0.00514358, bodyId: 'body-ba245864-mlf4r8dr' },
  { orderId: '9e935edf-1893-4ed1-941b-673b7cb6c469', btc: 0.00268593, bodyId: null },
  { orderId: 'f6369787-d794-4f25-8bd9-984afde5ce91', btc: 0.00044283, bodyId: 'body-27354c01-mlij69f5' },
];

const TOTAL_BTC = DUPLICATE_SELLS.reduce((s, d) => s + d.btc, 0);

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

// Find the recovery buy fill
const recoveryIdx = ledger.findIndex(f => f.orderId === RECOVERY_ORDER_ID && f.isRecoveryBuy);
if (recoveryIdx === -1) {
  console.error(`❌ Recovery buy fill not found (orderId: ${RECOVERY_ORDER_ID})`);
  process.exit(1);
}

const original = ledger[recoveryIdx];
console.log(`\n📋 Original recovery buy fill:`);
console.log(`   tradeId:  ${original.tradeId}`);
console.log(`   size:     ${original.size} BTC @ $${original.price}`);
console.log(`   quote:    $${roundUSDC(original.quoteAmount)}`);
console.log(`   fee:      $${original.fee}`);

console.log(`\n📋 Splitting into ${DUPLICATE_SELLS.length} fills:\n`);

const newFills = DUPLICATE_SELLS.map((sell, i) => {
  const ratio = sell.btc / TOTAL_BTC;
  const size = sell.btc;
  const quoteAmount = size * original.price;
  const fee = original.fee * ratio;

  console.log(`   ${i + 1}. ${sell.orderId.slice(0, 8)}: ${roundBTC(size)} BTC @ $${original.price} = $${roundUSDC(quoteAmount)} (fee $${fee.toFixed(4)}, ratio ${(ratio * 100).toFixed(1)}%)`);

  return {
    tradeId: `${original.tradeId}-split-${i + 1}`,
    orderId: original.orderId,
    side: 'buy',
    price: original.price,
    size,
    quoteAmount,
    fee,
    feeAsset: original.feeAsset,
    rebate: 0,
    netFee: fee,
    liquidityIndicator: original.liquidityIndicator,
    timestamp: original.timestamp,
    ingestedAt: original.ingestedAt,
    cycleId: original.cycleId,
    isRecoveryBuy: true,
    sellOrderId: sell.orderId,
    bodyId: sell.bodyId,
    recoveryNote: `Recovery buy split ${i + 1}/${DUPLICATE_SELLS.length}: covers duplicate TP sell ${sell.orderId.slice(0, 8)}`,
  };
});

// Verify totals
const totalSize = newFills.reduce((s, f) => s + f.size, 0);
const totalQuote = newFills.reduce((s, f) => s + f.quoteAmount, 0);
const totalFee = newFills.reduce((s, f) => s + f.fee, 0);
console.log(`\n   Totals: ${roundBTC(totalSize)} BTC, $${roundUSDC(totalQuote)} quote, $${totalFee.toFixed(4)} fees`);
console.log(`   Original: ${original.size} BTC, $${roundUSDC(original.quoteAmount)} quote, $${original.fee} fees`);

if (dryRun) {
  console.log(`\n${DUPLICATE_SELLS.length} fills would replace 1. Run with --apply to persist.`);
  process.exit(0);
}

// Backup
const backupPath = `${ledgerPath}.backup-split-recovery-${Date.now()}`;
fs.copyFileSync(ledgerPath, backupPath);
console.log(`\n💾 Backup: ${path.basename(backupPath)}`);

// Replace original with splits
ledger.splice(recoveryIdx, 1, ...newFills);
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
console.log(`✅ Replaced 1 fill with ${newFills.length} split fills in fill-ledger.json`);
