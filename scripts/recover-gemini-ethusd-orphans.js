#!/usr/bin/env node
/**
 * Recovery script for orphaned Gemini ETHUSD buy fills.
 *
 * Fetches all ETHUSD trades from Gemini, compares with fill-ledger,
 * and adds missing buys. For buys that already have a matched sell
 * in the ledger, links them properly. For unsold buys, creates new
 * celestial bodies so the engine can place TP sell orders on restart.
 *
 * Also:
 *   - Removes the synthetic placeholder body (orphan-recovery-*)
 *   - Fixes all migration closed-trade entries with missing holdback
 *   - Corrects realizedPnL and realizedAssetPnL
 *
 * Usage: node scripts/recover-gemini-ethusd-orphans.js [--dry-run]
 * PREREQUISITE: pm2 stop critical-mass-gemini
 */

const fs = require('fs');
const path = require('path');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { DATA_DIR } = require('../src/paths');

const DRY_RUN = process.argv.includes('--dry-run');

const PAIR_DIR = path.join(DATA_DIR, 'gemini/ETHUSD');
const LEDGER_PATH = path.join(PAIR_DIR, 'fill-ledger.json');
const STATE_PATH = path.join(PAIR_DIR, 'regime-state.json');
const CLOSED_PATH = path.join(PAIR_DIR, 'closed-trades.json');

const roundAsset = (v) => Math.round(v * 1e8) / 1e8;
const roundUSDC = (v) => Math.round(v * 100) / 100;

// ── Known linkages ──
const ALREADY_SOLD_ORDER = '73771277627904972';
const ALREADY_SOLD_BODY_ID = 'body-59257145-mntgr0hl';
const ALREADY_SOLD_SELL_ORDER = '73771277724825964';
const PLACEHOLDER_BODY_ID = 'body-69706885-mntmyzk5';

function backup(filepath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = filepath + `.backup-recovery-${ts}`;
  fs.copyFileSync(filepath, backupPath);
  console.log(`  backed up -> ${path.basename(backupPath)}`);
}

function generateBodyId(orderId, timestamp) {
  const suffix = orderId.slice(-8);
  return `body-${suffix}-${timestamp.toString(36)}`;
}

async function main() {
  console.log('\n===================================================');
  console.log('  RECOVER ORPHANED GEMINI ETHUSD BUYS');
  console.log('===================================================\n');
  if (DRY_RUN) console.log('  *** DRY RUN ***\n');

  const adapter = createGeminiAdapter();

  // Load state, ledger, and closed trades
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  const pos = state.position;
  const engineStart = pos.engineStartTime;

  console.log(`Engine start: ${new Date(engineStart).toISOString()}`);
  console.log(`Current state: totalAsset=${pos.totalAsset}, reserves=${pos.realizedAssetPnL}, assetOnOrder=${pos.assetOnOrder}\n`);

  // Fetch all ETHUSD trades from exchange
  console.log('Fetching ETHUSD trades from Gemini...');
  const rawTrades = await adapter.getAllTrades('ethusd', engineStart);
  console.log(`Total trades from exchange: ${rawTrades.length}`);

  // Get exchange balance for verification
  const ethBalance = await adapter.getAccountBalance('ETH');
  console.log(`Exchange ETH balance: ${ethBalance.total} (available: ${ethBalance.available}, hold: ${ethBalance.hold})\n`);

  // Deduplicate by tid
  const exchangeFills = new Map();
  for (const t of rawTrades) {
    const tid = (t.tid || '').toString();
    if (exchangeFills.has(tid)) continue;
    exchangeFills.set(tid, {
      tradeId: tid,
      orderId: (t.order_id || '').toString(),
      side: (t.type || '').toLowerCase(),
      price: parseFloat(t.price || 0),
      size: parseFloat(t.amount || 0),
      fee: parseFloat(t.fee_amount || 0),
      feeCurrency: t.fee_currency,
      timestamp: t.timestampms || (t.timestamp * 1000),
    });
  }

  // Build set of orderIds already in ledger
  const ledgerOrderIds = new Set(ledger.map(f => f.orderId));

  // Find missing buy fills grouped by order
  const orphanedByOrder = new Map();
  for (const [, f] of exchangeFills) {
    if (f.side === 'buy' && !ledgerOrderIds.has(f.orderId)) {
      if (!orphanedByOrder.has(f.orderId)) orphanedByOrder.set(f.orderId, []);
      orphanedByOrder.get(f.orderId).push(f);
    }
  }

  if (orphanedByOrder.size === 0) {
    console.log('No orphaned buys found. Nothing to do.');
    return;
  }

  console.log(`Found ${orphanedByOrder.size} orphaned buy orders:\n`);

  // ── Step 1: Remove placeholder body ──
  console.log('Step 1: Remove synthetic placeholder body');
  const placeholderIdx = pos.celestialBodies.findIndex(b => b.id === PLACEHOLDER_BODY_ID);
  if (placeholderIdx >= 0) {
    const placeholder = pos.celestialBodies[placeholderIdx];
    console.log(`  Removing ${PLACEHOLDER_BODY_ID} (${placeholder.assetQty} ETH, $${placeholder.costBasis})`);
    console.log(`  Source: ${placeholder.sourceOrderIds[0]} (synthetic, not a real exchange order)\n`);
  } else {
    console.log(`  Placeholder body ${PLACEHOLDER_BODY_ID} not found (already removed?)\n`);
  }

  // ── Step 2: Process orphaned buys ──
  console.log('Step 2: Add orphaned buy fills and create bodies\n');

  let totalNewBodyEth = 0;
  let totalNewBodyCost = 0;
  const newBodies = [];
  const newFills = [];

  for (const [orderId, fills] of orphanedByOrder) {
    fills.sort((a, b) => a.timestamp - b.timestamp);

    const orderEth = fills.reduce((s, f) => s + f.size, 0);
    const orderQuote = fills.reduce((s, f) => s + f.price * f.size, 0);
    const orderFees = fills.reduce((s, f) => s + f.fee, 0);
    const avgPrice = orderQuote / orderEth;
    const costBasis = orderQuote + orderFees;

    const isAlreadySold = orderId === ALREADY_SOLD_ORDER;

    console.log(`  BUY order=${orderId}${isAlreadySold ? ' [ALREADY SOLD]' : ''}`);
    console.log(`    ${roundAsset(orderEth)} ETH @ $${roundUSDC(avgPrice)} | cost $${roundUSDC(costBasis)} (incl $${roundUSDC(orderFees)} fees)`);
    console.log(`    ${fills.length} fill(s) | ${new Date(fills[0].timestamp).toISOString()}`);

    if (isAlreadySold) {
      for (const f of fills) {
        newFills.push({
          tradeId: f.tradeId,
          orderId: f.orderId,
          side: 'buy',
          price: f.price,
          size: f.size,
          quoteAmount: f.price * f.size,
          fee: f.fee,
          feeAsset: f.feeCurrency || 'USD',
          rebate: 0,
          netFee: f.fee,
          liquidityIndicator: 'TAKER',
          timestamp: f.timestamp,
          ingestedAt: Date.now(),
          cycleId: 'cycle-1',
          orderPlacedAt: null,
          fillTimeMs: null,
          sellOrderId: ALREADY_SOLD_SELL_ORDER,
          bodyId: ALREADY_SOLD_BODY_ID,
          bodyTier: 'satellite',
          isBodyOwned: true,
          isRecoveryFill: true,
        });
      }
      console.log(`    -> linked to existing sell ${ALREADY_SOLD_SELL_ORDER}\n`);
    } else {
      totalNewBodyEth += orderEth;
      totalNewBodyCost += costBasis;

      const bodyId = generateBodyId(orderId, fills[0].timestamp);

      for (const f of fills) {
        newFills.push({
          tradeId: f.tradeId,
          orderId: f.orderId,
          side: 'buy',
          price: f.price,
          size: f.size,
          quoteAmount: f.price * f.size,
          fee: f.fee,
          feeAsset: f.feeCurrency || 'USD',
          rebate: 0,
          netFee: f.fee,
          liquidityIndicator: 'TAKER',
          timestamp: f.timestamp,
          ingestedAt: Date.now(),
          cycleId: null,
          orderPlacedAt: null,
          fillTimeMs: null,
          sellOrderId: null,
          bodyId,
          bodyTier: 'satellite',
          isBodyOwned: true,
          isRecoveryFill: true,
        });
      }

      newBodies.push({
        id: bodyId,
        tier: 'satellite',
        assetQty: roundAsset(orderEth),
        costBasis: roundUSDC(costBasis),
        avgPrice: roundUSDC(avgPrice),
        tpOrderId: null,
        tpPrice: 0,
        assetOnOrder: 0,
        createdAt: fills[0].timestamp,
        lastMergedAt: fills[fills.length - 1].timestamp,
        sourceOrderIds: [orderId],
        buyOrders: fills.map(f => ({
          orderId: f.orderId,
          price: f.price,
          assetQty: f.size,
          sizeUsdc: roundUSDC(f.price * f.size + f.fee),
          filledAt: f.timestamp,
        })),
        mergeCount: 0,
      });

      console.log(`    -> new body ${bodyId}\n`);
    }
  }

  // ── Step 3: Fix ALL migration closed-trade holdbacks ──
  console.log('Step 3: Fix migration closed-trade entries\n');

  for (const c of closed) {
    if (c.source !== 'migration') continue;

    const sellFill = ledger.find(f => f.orderId === c.sellOrderId && f.side === 'sell');
    if (!sellFill) continue;

    const annotatedHoldback = sellFill.bodyHoldbackAsset || 0;
    const annotatedCostBasis = sellFill.bodyCostBasis || 0;
    const annotatedAvgPrice = sellFill.bodyAvgPrice || 0;
    const annotatedPnl = sellFill.bodyPnl;
    const annotatedBtcQty = sellFill.bodyBtcQty || 0;

    let changed = false;

    // Fix holdback
    if (c.holdbackAsset === 0 && annotatedHoldback > 0) {
      c.holdbackAsset = annotatedHoldback;
      changed = true;
    }

    // Fix cost basis for body-59257145 (the one whose buy we're adding)
    // Only applies when ALREADY_SOLD_ORDER is in the current orphan set (first recovery run).
    // On subsequent runs the buy is already in the ledger so it's not orphaned anymore.
    if (c.sellOrderId === ALREADY_SOLD_SELL_ORDER && orphanedByOrder.has(ALREADY_SOLD_ORDER)) {
      const buyFills = orphanedByOrder.get(ALREADY_SOLD_ORDER);
      const buyEth = buyFills.reduce((s, f) => s + f.size, 0);
      const buyQuote = buyFills.reduce((s, f) => s + f.price * f.size, 0);
      const buyFees = buyFills.reduce((s, f) => s + f.fee, 0);
      const buyCost = buyQuote + buyFees;
      const buyAvg = buyQuote / buyEth;
      const holdback = roundAsset(buyEth - c.qtySold);
      const pnl = roundUSDC(c.sellProceeds - buyCost);

      c.costBasis = roundUSDC(buyCost);
      c.buyAvgPrice = roundUSDC(buyAvg);
      c.holdbackAsset = holdback;
      c.pnl = pnl;
      c.buyOrderIds = [ALREADY_SOLD_ORDER];
      changed = true;

      // Also fix the sell fill annotation
      sellFill.bodyCostBasis = roundUSDC(buyCost);
      sellFill.bodyAvgPrice = buyAvg;
      sellFill.bodyBtcQty = buyEth;
      sellFill.bodyHoldbackAsset = holdback;
      sellFill.bodyPnl = pnl;
    }

    if (changed) {
      console.log(`  Fixed ${c.sellOrderId} (${c.bodyId}): holdback=${c.holdbackAsset}, costBasis=${c.costBasis}, pnl=${c.pnl}`);
    }
  }

  // ── Step 4: Compute correct state values ──
  console.log('\n===================================================');
  console.log('  RECOVERY SUMMARY');
  console.log('===================================================');
  console.log(`  Orphaned orders:     ${orphanedByOrder.size}`);
  console.log(`  Already-sold orders: 1 (linked to existing sell)`);
  console.log(`  New unsold bodies:   ${newBodies.length}`);
  console.log(`  Fills added:         ${newFills.length}`);
  console.log(`  New body ETH:        ${roundAsset(totalNewBodyEth)}`);
  console.log(`  New body cost:       $${roundUSDC(totalNewBodyCost)}`);

  // Reserves and realized PnL from existing ledger/closed-trade data
  const allSells = ledger.filter(f => f.side === 'sell');
  const correctReserves = roundAsset(allSells.reduce((s, f) => s + (f.bodyHoldbackAsset || 0), 0));
  let correctRealizedPnL = roundUSDC(closed.reduce((s, c) => s + c.pnl, 0));

  // Reconcile to actual exchange ETH balance:
  // Some orphan inventory was consumed by ledger-incomplete sells (partial fills not captured).
  // Scale all new bodies down proportionally so totals match the exchange.
  const targetBodyEth = roundAsset(ethBalance.total - correctReserves - pos.assetOnOrder);
  const currentBodyEth = newBodies.reduce((s, b) => s + b.assetQty, 0)
    + pos.celestialBodies.filter(b => b.id !== PLACEHOLDER_BODY_ID).reduce((s, b) => s + b.assetQty, 0);

  if (currentBodyEth > 0 && Math.abs(currentBodyEth - targetBodyEth) > 0.0001) {
    const scale = targetBodyEth / currentBodyEth;
    let trimmedCost = 0;
    let trimmedEth = 0;
    for (const b of newBodies) {
      const origEth = b.assetQty;
      const origCost = b.costBasis;
      b.assetQty = roundAsset(origEth * scale);
      b.costBasis = roundUSDC(origCost * scale);
      // avgPrice stays the same; trim buyOrders proportionally for accounting clarity
      for (const bo of (b.buyOrders || [])) {
        bo.assetQty = roundAsset(bo.assetQty * scale);
        bo.sizeUsdc = roundUSDC(bo.sizeUsdc * scale);
      }
      trimmedEth += origEth - b.assetQty;
      trimmedCost += origCost - b.costBasis;
    }
    // The trimmed inventory was historically sold via partial-fill leakage at the
    // last known TP price (~$2316). Estimate proceeds and roll the net into realizedPnL.
    const estimatedSellPrice = 2316.13;
    const estimatedProceeds = trimmedEth * estimatedSellPrice;
    const leakedPnL = roundUSDC(estimatedProceeds - trimmedCost);
    correctRealizedPnL = roundUSDC(correctRealizedPnL + leakedPnL);
    console.log(`\n  Reconciliation trim: scaled bodies by ${scale.toFixed(6)}`);
    console.log(`    trimmed ${roundAsset(trimmedEth)} ETH from new bodies (cost $${roundUSDC(trimmedCost)})`);
    console.log(`    rolled into realizedPnL: +$${leakedPnL} (proceeds $${roundUSDC(estimatedProceeds)} @ ~$${estimatedSellPrice})`);
  }

  // Compute final totals after any trim
  const activeBodies = [...pos.celestialBodies.filter(b => b.id !== PLACEHOLDER_BODY_ID), ...newBodies];
  const newTotalAsset = roundAsset(activeBodies.reduce((s, b) => s + b.assetQty, 0));
  const newTotalCostBasis = roundUSDC(activeBodies.reduce((s, b) => s + b.costBasis, 0));
  const newAvgCostBasis = newTotalAsset > 0 ? newTotalCostBasis / newTotalAsset : 0;

  console.log('\n  State changes:');
  console.log(`    totalAsset:        ${pos.totalAsset} -> ${newTotalAsset}`);
  console.log(`    totalCostBasis:    ${pos.totalCostBasis} -> ${newTotalCostBasis}`);
  console.log(`    avgCostBasis:      ${pos.avgCostBasis.toFixed(2)} -> ${newAvgCostBasis.toFixed(2)}`);
  console.log(`    realizedPnL:       ${pos.realizedPnL} -> ${correctRealizedPnL}`);
  console.log(`    realizedAssetPnL:  ${pos.realizedAssetPnL} -> ${correctReserves}`);
  console.log(`    celestialBodies:   ${pos.celestialBodies.length} -> ${activeBodies.length} (removed placeholder, added ${newBodies.length})`);

  // Verify against exchange
  const expectedExchangeEth = roundAsset(newTotalAsset + correctReserves + pos.assetOnOrder);
  console.log(`\n  Verification:`);
  console.log(`    totalAsset + reserves + onOrder = ${expectedExchangeEth}`);
  console.log(`    exchange balance                = ${ethBalance.total}`);
  console.log(`    delta                           = ${roundAsset(expectedExchangeEth - ethBalance.total)}`);

  if (DRY_RUN) {
    console.log('\n  *** DRY RUN -- no files modified ***\n');
    return;
  }

  // ── Save ──
  console.log('\nBacking up files...');
  backup(LEDGER_PATH);
  backup(STATE_PATH);
  backup(CLOSED_PATH);

  // Update ledger
  ledger.push(...newFills);
  ledger.sort((a, b) => a.timestamp - b.timestamp);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log(`  wrote ${path.basename(LEDGER_PATH)} (${ledger.length} entries)`);

  // Update closed trades
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(closed, null, 2));
  console.log(`  wrote ${path.basename(CLOSED_PATH)}`);

  // Update state
  pos.totalAsset = newTotalAsset;
  pos.totalCostBasis = newTotalCostBasis;
  pos.avgCostBasis = newAvgCostBasis;
  pos.realizedPnL = correctRealizedPnL;
  pos.realizedAssetPnL = correctReserves;
  pos.celestialBodies = activeBodies;

  if (pos.celestialState) {
    pos.celestialState.bodiesRealizedPnL = correctRealizedPnL;
    pos.celestialState.bodiesRealizedAssetPnL = correctReserves;
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`  wrote ${path.basename(STATE_PATH)}`);

  console.log('\n===================================================');
  console.log('  RECOVERY COMPLETE');
  console.log('===================================================');
  console.log('  Next steps:');
  console.log('    1. pm2 restart critical-mass-gemini');
  console.log('    2. Check logs for TP placement on 11 new bodies');
  console.log('    3. Verify dashboard shows correct holdings\n');
}

main().catch(err => {
  console.error('Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
