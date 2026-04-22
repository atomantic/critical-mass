#!/usr/bin/env node
/**
 * Fix Gemini state after sync-fills ingested 28 missing buy fills.
 *
 * Associates the new fills with the galaxy body, updates body aggregates,
 * and recalculates position totals.
 *
 * Usage: node scripts/fix-gemini-state.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');

const DRY_RUN = process.argv.includes('--dry-run');

const { DATA_DIR } = require('../src/paths');
const GEMINI_DIR = path.join(DATA_DIR, 'gemini');
const LEDGER_PATH = path.join(GEMINI_DIR, 'fill-ledger.json');
const STATE_PATH = path.join(GEMINI_DIR, 'regime-state.json');

const GALAXY_BODY_ID = 'body-15708528-mln0kjy7';
const GALAXY_SELL_ORDER_ID = '73771275944240402';

function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Fix Gemini State — Associate missing fills with galaxy body');
  console.log(`${'='.repeat(60)}`);
  if (DRY_RUN) console.log('  *** DRY RUN ***\n');

  // Load data
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const body = state.position.celestialBodies.find(b => b.id === GALAXY_BODY_ID);
  if (!body) {
    console.error('Galaxy body not found!');
    process.exit(1);
  }

  // Find fills NOT yet associated with the body
  const existingSourceOrders = new Set(body.sourceOrderIds || []);
  const unassociatedBuyFills = ledger.filter(f =>
    f.side === 'buy' &&
    !f.isBodyOwned
  );

  console.log(`\nFound ${unassociatedBuyFills.length} unassociated buy fills in cycle-1`);

  if (unassociatedBuyFills.length === 0) {
    console.log('Nothing to fix!');
    return;
  }

  // Group by orderId for body.buyOrders
  const orderGroups = new Map();
  for (const fill of unassociatedBuyFills) {
    if (!orderGroups.has(fill.orderId)) orderGroups.set(fill.orderId, []);
    orderGroups.get(fill.orderId).push(fill);
  }

  let addedBtc = 0;
  let addedUsdc = 0;

  console.log('\nAssociating fills:');
  for (const [orderId, fills] of orderGroups) {
    const totalBtc = fills.reduce((s, f) => s + f.size, 0);
    const totalUsdc = fills.reduce((s, f) => s + f.quoteAmount, 0);
    const totalFee = fills.reduce((s, f) => s + (f.netFee || f.fee || 0), 0);
    const avgPrice = totalBtc > 0 ? totalUsdc / totalBtc : 0;
    const firstTimestamp = Math.min(...fills.map(f => f.timestamp));

    console.log(`  BUY ${orderId}: ${roundAsset(totalBtc)} BTC @ $${roundUSDC(avgPrice)} ($${roundUSDC(totalUsdc)}) [${fills.length} fill(s)]`);

    // Annotate each fill
    for (const fill of fills) {
      fill.isBodyOwned = true;
      fill.bodyId = GALAXY_BODY_ID;
      fill.bodyTier = 'galaxy';
      fill.sellOrderId = GALAXY_SELL_ORDER_ID;
    }

    // Add to body.sourceOrderIds
    if (!existingSourceOrders.has(orderId)) {
      body.sourceOrderIds.push(orderId);
      existingSourceOrders.add(orderId);
    }

    // Add to body.buyOrders
    const existingBuyOrder = (body.buyOrders || []).find(bo => bo.orderId === orderId);
    if (!existingBuyOrder) {
      body.buyOrders = body.buyOrders || [];
      body.buyOrders.push({
        orderId,
        price: roundUSDC(avgPrice),
        assetQty: totalBtc,
        sizeUsdc: roundUSDC(totalUsdc + totalFee),
        filledAt: firstTimestamp,
      });
    }

    addedBtc += totalBtc;
    addedUsdc += totalUsdc + totalFee;
  }

  // Update body aggregates
  const oldAssetQty = body.assetQty;
  const oldCostBasis = body.costBasis;
  body.assetQty = roundAsset(oldAssetQty + addedBtc);
  body.costBasis = roundUSDC(oldCostBasis + addedUsdc);
  body.avgPrice = body.assetQty > 0 ? body.costBasis / body.assetQty : 0;
  body.lastMergedAt = Date.now();
  body.mergeCount = (body.mergeCount || 0) + orderGroups.size;

  console.log(`\nBody updates:`);
  console.log(`  assetQty:  ${oldAssetQty} -> ${body.assetQty} (+${roundAsset(addedBtc)})`);
  console.log(`  costBasis: $${oldCostBasis} -> $${body.costBasis} (+$${roundUSDC(addedUsdc)})`);
  console.log(`  avgPrice:  $${roundUSDC(body.avgPrice)}`);

  // Update position totals
  const pos = state.position;
  const oldTotalAsset = pos.totalAsset;
  const oldTotalCostBasis = pos.totalCostBasis;
  pos.totalAsset = roundAsset(oldTotalAsset + addedBtc);
  pos.totalCostBasis = roundUSDC(oldTotalCostBasis + addedUsdc);
  pos.avgCostBasis = pos.totalAsset > 0 ? pos.totalCostBasis / pos.totalAsset : 0;

  console.log(`\nPosition updates:`);
  console.log(`  totalAsset:    ${oldTotalAsset} -> ${pos.totalAsset}`);
  console.log(`  totalCostBasis: $${oldTotalCostBasis} -> $${pos.totalCostBasis}`);
  console.log(`  avgCostBasis:  $${roundUSDC(pos.avgCostBasis)}`);

  // Sort body.buyOrders by filledAt
  body.buyOrders.sort((a, b) => a.filledAt - b.filledAt);

  // Sort ledger by timestamp
  ledger.sort((a, b) => a.timestamp - b.timestamp);

  // Persist
  if (DRY_RUN) {
    console.log('\n[DRY RUN] No files modified');
  } else {
    // Backup
    const ts = Date.now();
    fs.copyFileSync(LEDGER_PATH, `${LEDGER_PATH}.backup-${ts}`);
    fs.copyFileSync(STATE_PATH, `${STATE_PATH}.backup-${ts}`);
    console.log(`\nBackups created`);

    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log('Files updated');
  }

  console.log('\nDone!\n');
}

main();
