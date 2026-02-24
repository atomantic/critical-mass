#!/usr/bin/env node
/**
 * One-time repair script for orphan buy in body mm0nf5pn.
 *
 * Sell order 0a513b0e was placed with stale quantity due to a TP race condition:
 * the TP was submitted before buy 3 (80673b38) was merged into the body.
 * Buy 3's BTC went entirely to holdback instead of being sold.
 *
 * This script:
 *   1. Unlinks buy 3 from the old sell
 *   2. Fixes the sell fill annotations to only reflect buys 1+2
 *   3. Corrects realizedPnL, realizedAssetPnL, and maxUsdcDeployed
 *   4. Creates a new satellite body for buy 3's BTC
 *   5. Annotates buy 3 fill with the new body
 *
 * PREREQUISITE: pm2 stop critical-mass-coinbase
 * After running: pm2 restart critical-mass-coinbase (engine will auto-place TP for new body)
 */

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data/coinbase/fill-ledger.json');
const STATE_PATH = path.join(__dirname, '..', 'data/coinbase/regime-state.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ── Known IDs ──
const BUY3_ORDER_ID = '80673b38-c430-410a-8ab4-5c792b9ba7a8';
const BUY3_TRADE_ID = 'f9a5d3b7-6057-4d74-8fb1-7c0607b4561a';
const SELL_ORDER_ID = '0a513b0e-9bc2-414f-b30e-49e6c8168356';
const SELL_TRADE_ID = 'eeb5d1b0-aba5-47a1-a618-fa936be55c18';
const OLD_BODY_ID = 'body-c656b673-mm0nf5pn';

// Buy 1 (two partial fills from the same order)
const BUY1_ORDER_ID = '4829e980-c795-4730-b58c-5259c656b673';
// Buy 2
const BUY2_ORDER_ID = '65f071ac-b9a2-4b52-8803-8c4f47dd1e41';

const roundAsset = (v) => Math.round(v * 1e8) / 1e8;
const roundUSDC = (v) => Math.round(v * 100) / 100;

function backup(filepath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = filepath + `.backup-${ts}`;
  fs.copyFileSync(filepath, backupPath);
  console.log(`  backed up → ${path.basename(backupPath)}`);
}

function generateBodyId(orderId) {
  const suffix = orderId.slice(-8);
  return `body-${suffix}-${Date.now().toString(36)}`;
}

function main() {
  console.log('=== Repair: orphan buy in body mm0nf5pn ===\n');

  // ── Load data ──
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // ── Locate fills ──
  const buy3Fill = ledger.find(f => f.tradeId === BUY3_TRADE_ID);
  const sellFill = ledger.find(f => f.tradeId === SELL_TRADE_ID);

  if (!buy3Fill) { console.error('Buy 3 fill not found'); process.exit(1); }
  if (!sellFill) { console.error('Sell fill not found'); process.exit(1); }

  // Find all buy fills for buys 1+2 (may be multiple partial fills)
  const buy12Fills = ledger.filter(
    f => f.side === 'buy'
      && (f.orderId === BUY1_ORDER_ID || f.orderId === BUY2_ORDER_ID)
      && f.bodyId === OLD_BODY_ID
  );

  if (buy12Fills.length === 0) { console.error('Buy 1+2 fills not found'); process.exit(1); }

  console.log(`Found ${buy12Fills.length} fills for buys 1+2, 1 fill for buy 3, 1 sell fill\n`);

  // ── Compute correct values for buys 1+2 only ──
  const buy12TotalSize = roundAsset(buy12Fills.reduce((s, f) => s + f.size, 0));
  const buy12TotalQuote = buy12Fills.reduce((s, f) => s + f.quoteAmount, 0);
  const buy12TotalFee = buy12Fills.reduce((s, f) => s + f.netFee, 0);
  const buy12CostBasis = buy12TotalQuote + buy12TotalFee;
  const buy12AvgPrice = buy12CostBasis / buy12TotalSize;

  const sellProceeds = sellFill.quoteAmount - sellFill.netFee;
  const sellSize = sellFill.size;

  const newHoldback = roundAsset(buy12TotalSize - sellSize);
  const newPnl = sellProceeds - buy12CostBasis;

  // Old incorrect values from the sell fill annotation
  const oldPnl = sellFill.bodyPnl;
  const oldHoldback = sellFill.bodyHoldbackAsset;

  const pnlDelta = newPnl - oldPnl;
  const holdbackDelta = newHoldback - oldHoldback;

  console.log('Computed corrections:');
  console.log(`  buys 1+2 totalSize: ${buy12TotalSize}`);
  console.log(`  buys 1+2 costBasis: $${buy12CostBasis.toFixed(6)}`);
  console.log(`  buys 1+2 avgPrice:  $${buy12AvgPrice.toFixed(2)}`);
  console.log(`  sell proceeds:      $${sellProceeds.toFixed(6)}`);
  console.log(`  new holdback:       ${newHoldback} BTC`);
  console.log(`  new PnL:            $${newPnl.toFixed(6)}`);
  console.log(`  old PnL:            $${oldPnl}`);
  console.log(`  PnL delta:          $${pnlDelta.toFixed(6)}`);
  console.log(`  old holdback:       ${oldHoldback} BTC`);
  console.log(`  holdback delta:     ${holdbackDelta} BTC`);
  console.log();

  // ── Buy 3 values ──
  const buy3CostBasis = buy3Fill.quoteAmount + buy3Fill.netFee;
  const buy3Size = buy3Fill.size;
  const buy3Price = buy3Fill.price;

  console.log('Buy 3 values:');
  console.log(`  size:      ${buy3Size} BTC`);
  console.log(`  costBasis: $${buy3CostBasis.toFixed(6)}`);
  console.log(`  price:     $${buy3Price}`);
  console.log();

  // ── Backup files ──
  console.log('Backing up files...');
  backup(LEDGER_PATH);
  backup(STATE_PATH);
  backup(CONFIG_PATH);
  console.log();

  // ── Step 1: Fix fill-ledger ──
  console.log('Step 1: Fix fill-ledger.json');

  // Unlink buy 3 from old sell/body
  buy3Fill.sellOrderId = null;
  buy3Fill.bodyId = null;
  buy3Fill.isBodyOwned = false;
  console.log('  Unlinked buy 3 from sell and body');

  // Fix sell fill annotations
  sellFill.bodyCostBasis = roundUSDC(buy12CostBasis);
  sellFill.bodyAvgPrice = buy12AvgPrice;
  sellFill.bodyBtcQty = buy12TotalSize;
  sellFill.bodyHoldbackAsset = newHoldback;
  sellFill.bodyPnl = roundUSDC(newPnl);
  console.log(`  Updated sell annotations: costBasis=$${sellFill.bodyCostBasis}, PnL=$${sellFill.bodyPnl}, holdback=${newHoldback}`);
  console.log();

  // ── Step 2: Fix regime-state.json ──
  console.log('Step 2: Fix regime-state.json');
  const pos = state.position;

  const oldRealized = pos.realizedPnL;
  pos.realizedPnL = roundUSDC(pos.realizedPnL + pnlDelta);
  console.log(`  realizedPnL: ${oldRealized} → ${pos.realizedPnL} (delta ${pnlDelta.toFixed(6)})`);

  const oldAssetPnl = pos.realizedAssetPnL;
  pos.realizedAssetPnL = roundAsset(pos.realizedAssetPnL + holdbackDelta);
  console.log(`  realizedAssetPnL: ${oldAssetPnl} → ${pos.realizedAssetPnL} (delta ${holdbackDelta})`);

  const cs = pos.celestialState;
  if (cs) {
    const oldCsBodiesPnl = cs.bodiesRealizedPnL;
    cs.bodiesRealizedPnL = roundUSDC(cs.bodiesRealizedPnL + pnlDelta);
    console.log(`  celestialState.bodiesRealizedPnL: ${oldCsBodiesPnl} → ${cs.bodiesRealizedPnL}`);

    const oldCsAssetPnl = cs.bodiesRealizedAssetPnL;
    cs.bodiesRealizedAssetPnL = roundAsset(cs.bodiesRealizedAssetPnL + holdbackDelta);
    console.log(`  celestialState.bodiesRealizedAssetPnL: ${oldCsAssetPnl} → ${cs.bodiesRealizedAssetPnL}`);
  }
  console.log();

  // ── Step 3: Fix config.json maxUsdcDeployed ──
  console.log('Step 3: Fix config.json maxUsdcDeployed');
  const coinbaseRegime = config.exchanges?.coinbase?.regime;
  if (!coinbaseRegime) { console.error('coinbase regime config not found'); process.exit(1); }

  const oldMaxUsdc = coinbaseRegime.maxUsdcDeployed;
  coinbaseRegime.maxUsdcDeployed = roundUSDC(coinbaseRegime.maxUsdcDeployed + pnlDelta);
  console.log(`  maxUsdcDeployed: ${oldMaxUsdc} → ${coinbaseRegime.maxUsdcDeployed} (delta ${roundUSDC(pnlDelta)})`);
  console.log();

  // ── Step 4: Create new satellite body for buy 3 ──
  console.log('Step 4: Create new satellite body for buy 3');
  const newBodyId = generateBodyId(BUY3_ORDER_ID);
  const newBody = {
    id: newBodyId,
    tier: 'satellite',
    assetQty: buy3Size,
    costBasis: roundUSDC(buy3CostBasis),
    avgPrice: buy3Price,
    tpOrderId: null,  // engine will place TP on restart
    tpPrice: 0,
    assetOnOrder: 0,
    createdAt: Date.now(),
    lastMergedAt: Date.now(),
    sourceOrderIds: [BUY3_ORDER_ID],
    buyOrders: [{
      orderId: BUY3_ORDER_ID,
      price: buy3Price,
      assetQty: buy3Size,
      sizeUsdc: roundUSDC(buy3CostBasis),
      filledAt: buy3Fill.timestamp,
    }],
    mergeCount: 0,
  };

  pos.celestialBodies = pos.celestialBodies || [];
  pos.celestialBodies.push(newBody);
  console.log(`  Created body ${newBodyId} (satellite, ${buy3Size} BTC, $${roundUSDC(buy3CostBasis)})`);
  console.log();

  // ── Step 5: Annotate buy 3 fill with new body ──
  console.log('Step 5: Annotate buy 3 fill with new body');
  buy3Fill.bodyId = newBodyId;
  buy3Fill.bodyTier = 'satellite';
  buy3Fill.isBodyOwned = true;
  console.log(`  buy 3 → bodyId=${newBodyId}, tier=satellite`);
  console.log();

  // ── Step 6: Save ──
  console.log('Step 6: Save files');
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log(`  wrote ${path.basename(LEDGER_PATH)}`);

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`  wrote ${path.basename(STATE_PATH)}`);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`  wrote ${path.basename(CONFIG_PATH)}`);

  console.log('\n=== Repair complete ===');
  console.log('Next steps:');
  console.log('  1. pm2 restart critical-mass-coinbase');
  console.log('  2. Check logs for TP placement on new body');
  console.log('  3. node scripts/audit-fills.js (verify no orphans)');
}

main();
