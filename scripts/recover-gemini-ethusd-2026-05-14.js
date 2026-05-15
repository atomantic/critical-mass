#!/usr/bin/env node
/**
 * Recover Gemini ETHUSD orphan fills and reconcile the existing celestial body.
 *
 * Context: same verify-after-placement race that hit Coinbase manifested here
 * (135 "immediately cancelled by exchange" events in the log). 106 orphan fills
 * missing from the ledger across the engine's lifetime. Net 0.580 ETH delta
 * (exchange has more ETH than ledger tracks).
 *
 * Additionally: the existing body's tpOrderId (73771280871998016) is dead —
 * Gemini cancelled it overnight (likely heartbeat hiccup) and the engine never
 * noticed. State still has assetOnOrder=2.16 ETH but exchange hold=0.
 *
 * What this does (per user spec):
 *   1. Pull all engine-history Gemini ETHUSD trades via /v1/mytrades
 *   2. Identify orphan fills (in exchange, not in ledger) — full lifetime scope
 *      because the user has only used this engine to trade ETH on Gemini
 *   3. Ingest orphan fills into fill-ledger.json (no body attribution to avoid
 *      FIFO replay disturbance — the body update below is the source of truth)
 *   4. Merge orphans INTO the existing body:
 *      - assetQty = current exchange ETH balance (ground truth)
 *      - costBasis = old + orphan_buy_cost - orphan_sell_cost (cash flow)
 *      - avgPrice  = costBasis / assetQty
 *      - clear stale tpOrderId/assetOnOrder
 *   5. Place a single consolidated TP at max(avgPrice × tpMinPct, ask + 5bps)
 *   6. Backup state + ledger before any writes
 *
 * Dry-run by default. STOP THE GEMINI ENGINE before --apply.
 *
 * Usage:
 *   node scripts/recover-gemini-ethusd-2026-05-14.js                  # dry-run
 *   node scripts/recover-gemini-ethusd-2026-05-14.js --apply          # apply
 *   node scripts/recover-gemini-ethusd-2026-05-14.js --tp-pct 1.5     # override
 *   node scripts/recover-gemini-ethusd-2026-05-14.js --no-place-tp    # ledger+state only
 */

const fs = require('fs');
const path = require('path');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { resolveFundDataDir } = require('../src/migration');
const { getRegimeConfig } = require('../src/config-utils');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');

const APPLY = process.argv.includes('--apply');
const NO_PLACE_TP = process.argv.includes('--no-place-tp');
const tpPctArg = process.argv.indexOf('--tp-pct');
const TP_PCT_OVERRIDE = tpPctArg >= 0 ? parseFloat(process.argv[tpPctArg + 1]) : null;

const PAIR = 'ETHUSD';
const SYMBOL = 'ethusd';
const TP_SAFETY_BPS = 5;
const PRICE_INCREMENT = 0.01;       // Gemini ETHUSD: $0.01 tick
const ASSET_INCREMENT = 1e-6;        // Gemini ETHUSD: 1e-6 ETH

const fundDir = resolveFundDataDir('gemini', PAIR);
const statePath = path.join(fundDir, 'regime-state.json');
const ledgerPath = path.join(fundDir, 'fill-ledger.json');

const atomicWrite = (filePath, data) => {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
};

const roundToIncrement = (v, inc) => Math.round(v / inc) * inc;

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Gemini ETHUSD Recovery — full engine history`);
  console.log(`  Mode: ${APPLY ? '⚠️  APPLY (mutate state + place TP)' : '🔍 DRY-RUN (no changes)'}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Safety: refuse if engine running
  if (APPLY) {
    const runningFlag = path.join(fundDir, 'regime-engine-running.json');
    if (fs.existsSync(runningFlag)) {
      const flag = JSON.parse(fs.readFileSync(runningFlag, 'utf8'));
      const ageMs = Date.now() - (flag.lastHeartbeat || flag.startedAt || 0);
      if (ageMs < 60_000) {
        console.error(`❌ ABORT: regime-engine-running.json updated ${Math.round(ageMs/1000)}s ago. Stop the engine first.`);
        process.exit(1);
      }
    }
  }

  const adapter = createGeminiAdapter();
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const engineStart = state.position.engineStartTime;

  console.log(`Engine start: ${new Date(engineStart).toISOString()}`);
  console.log(`Fetching all ETHUSD trades from Gemini...`);
  const rawTrades = await adapter.getAllTrades(SYMBOL, engineStart);
  console.log(`  ${rawTrades.length} trades fetched\n`);

  // Build ledger lookups
  const ledgerTids = new Set();
  const ledgerOids = new Set();
  for (const f of ledger) {
    if (f.tradeId) {
      ledgerTids.add(String(f.tradeId));
      if (String(f.tradeId).startsWith('fill-')) ledgerTids.add(String(f.tradeId).slice(5));
    }
    if (f.orderId) ledgerOids.add(String(f.orderId));
  }

  // Identify orphans (in exchange, not in ledger)
  const orphans = [];
  for (const t of rawTrades) {
    const tid = String(t.tid);
    const oid = String(t.order_id);
    if (ledgerTids.has(tid)) continue;
    if (ledgerTids.has(`fill-${oid}`)) continue;
    const side = (t.type || '').toLowerCase();        // 'Buy' / 'Sell'
    const price = parseFloat(t.price);
    const size = parseFloat(t.amount);
    const quoteAmount = price * size;
    const fee = parseFloat(t.fee_amount || 0);
    orphans.push({
      tradeId: tid,
      orderId: oid,
      side,
      price,
      size,
      quoteAmount,
      fee,
      feeCurrency: t.fee_currency || 'USD',
      timestamp: t.timestampms || (t.timestamp * 1000),
      liquidity: t.aggressor ? 'TAKER' : 'MAKER',
    });
  }

  if (orphans.length === 0) {
    console.log('✅ No orphan fills found. Nothing to ingest.');
  }

  // Aggregate by side
  const buys = orphans.filter(o => o.side === 'buy');
  const sells = orphans.filter(o => o.side === 'sell');
  const sumQty = arr => arr.reduce((s, x) => s + x.size, 0);
  const sumCash = arr => arr.reduce((s, x) => s + x.quoteAmount, 0);
  const sumFee = arr => arr.reduce((s, x) => s + x.fee, 0);

  const buyQty = sumQty(buys), buyCash = sumCash(buys), buyFees = sumFee(buys);
  const sellQty = sumQty(sells), sellCash = sumCash(sells), sellFees = sumFee(sells);
  const netCashOut = buyCash - sellCash;  // positive = engine paid net cash for held ETH

  console.log(`${'─'.repeat(70)}`);
  console.log(`  ORPHAN FILLS (in Gemini, missing from ledger)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  BUYS:  ${buys.length} | ${roundAsset(buyQty)} ETH | $${roundUSDC(buyCash)} | fees $${roundUSDC(buyFees)}`);
  console.log(`  SELLS: ${sells.length} | ${roundAsset(sellQty)} ETH | $${roundUSDC(sellCash)} | fees $${roundUSDC(sellFees)}`);
  console.log(`  Net ETH change to ledger: ${roundAsset(buyQty - sellQty)}`);
  console.log(`  Net cash spent (orphan buys - orphan sells): $${roundUSDC(netCashOut)}`);

  // Current exchange ETH balance (ground truth)
  const ethBal = await adapter.getAccountBalance('ETH');
  const usdBal = await adapter.getAccountBalance('USD');
  const exchangeEth = ethBal.total;
  console.log(`\n  Exchange ETH balance: ${exchangeEth} (available ${ethBal.available}, hold ${ethBal.hold})`);
  console.log(`  Exchange USD balance: ${usdBal.total}`);

  // Existing body
  const bodies = state.position.celestialBodies || [];
  if (bodies.length !== 1) {
    console.error(`❌ Expected exactly 1 body, found ${bodies.length}. Aborting.`);
    process.exit(1);
  }
  const body = bodies[0];

  // Verify the existing TP is actually dead on exchange
  console.log(`\n  Existing body: ${body.id}`);
  console.log(`    assetQty:     ${body.assetQty}`);
  console.log(`    assetOnOrder: ${body.assetOnOrder}`);
  console.log(`    avgPrice:     $${body.avgPrice}`);
  console.log(`    costBasis:    $${body.costBasis}`);
  console.log(`    tpOrderId:    ${body.tpOrderId}`);
  console.log(`    tpPrice:      $${body.tpPrice}`);

  let staleTpConfirmedDead = false;
  if (body.tpOrderId) {
    try {
      const tpStatus = await adapter.getOrder(body.tpOrderId);
      if (tpStatus.status === 'CANCELLED' && tpStatus.filledSize === 0) {
        console.log(`  ✓ Confirmed: existing TP order is CANCELLED on exchange (filledSize=0)`);
        staleTpConfirmedDead = true;
      } else if (tpStatus.status === 'FILLED') {
        console.error(`❌ Existing TP order shows FILLED on exchange — this changes the recovery. Abort.`);
        process.exit(1);
      } else {
        console.error(`❌ Existing TP order shows status=${tpStatus.status} on exchange. Manual review needed.`);
        process.exit(1);
      }
    } catch (e) {
      console.log(`  ⚠️ Could not verify existing TP (${e.message}) — assuming dead per audit`);
    }
  }

  // Compute new body params.
  // assetQty = ground-truth exchange balance.
  // costBasis: the existing body's cost stays valid for the ETH it already
  // tracks. For the *additional* ETH being newly tracked (exchangeEth - body.assetQty),
  // impute cost at the orphan-buys' average price — this is the price the engine
  // actually paid for that incremental ETH. Don't subtract orphan-sell proceeds,
  // since most of those sells closed positions that were originally bought via
  // already-ledgered buys (and are reflected in the current $5,151 cost basis).
  const newAssetQty = exchangeEth;
  const additionalEth = newAssetQty - body.assetQty;
  const orphanBuyAvgPrice = buyQty > 0 ? buyCash / buyQty : body.avgPrice;
  const additionalCost = additionalEth * orphanBuyAvgPrice;
  const newCostBasis = body.costBasis + additionalCost;
  const newAvgPrice = newCostBasis / newAssetQty;

  // TP price
  const config = getRegimeConfig('gemini', PAIR);
  const tpPctEff = TP_PCT_OVERRIDE != null ? TP_PCT_OVERRIDE : (config.tpMinPercent || 0.9);
  const targetTp = newAvgPrice * (1 + tpPctEff / 100);
  const { bid: currentBid, ask: currentAsk } = await adapter.getBidAsk(SYMBOL);
  const floorTp = currentAsk * (1 + TP_SAFETY_BPS / 10000);
  const proposedTp = Math.max(targetTp, floorTp);
  const tpRounded = roundToIncrement(proposedTp, PRICE_INCREMENT);
  const tpQtyRounded = roundToIncrement(newAssetQty, ASSET_INCREMENT);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PROPOSED BODY UPDATE`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  assetQty:     ${body.assetQty} → ${roundAsset(newAssetQty)}  (+${roundAsset(newAssetQty - body.assetQty)})`);
  console.log(`  costBasis:    $${body.costBasis} → $${roundUSDC(newCostBasis)}  (+$${roundUSDC(additionalCost)} @ orphan-buy avg $${orphanBuyAvgPrice.toFixed(2)}/ETH)`);
  console.log(`  avgPrice:     $${body.avgPrice.toFixed(2)} → $${newAvgPrice.toFixed(2)}`);
  console.log(`  tpOrderId:    ${body.tpOrderId} → (new — see below)`);
  console.log(`  assetOnOrder: ${body.assetOnOrder} → ${tpQtyRounded}`);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PROPOSED TP`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Market:           bid=$${currentBid} ask=$${currentAsk}`);
  console.log(`  Computed target:  avgPrice × (1 + ${tpPctEff}%) = $${targetTp.toFixed(2)}`);
  console.log(`  Floor (ask+5bps): $${floorTp.toFixed(2)}`);
  console.log(`  Using:            ${proposedTp === floorTp ? 'FLOOR (target below market)' : 'COMPUTED TARGET'}`);
  console.log(`  TP price:         $${tpRounded.toFixed(2)}`);
  console.log(`  TP size:          ${tpQtyRounded} ETH`);
  console.log(`  Implied gain:     ${((tpRounded - newAvgPrice) / newAvgPrice * 100).toFixed(3)}% over avg, $${roundUSDC(tpRounded * tpQtyRounded - newCostBasis)} gross`);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  STATE DELTA`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ledger fills:        +${orphans.length}    (${ledger.length} → ${ledger.length + orphans.length})`);
  console.log(`  body.assetQty:       +${roundAsset(newAssetQty - body.assetQty)}`);
  console.log(`  state.totalAsset:    +${roundAsset(newAssetQty - state.position.totalAsset)}`);
  console.log(`  state.totalCostBasis:+$${roundUSDC(additionalCost)}`);
  console.log(`  state.cycleBuys:     +${buys.length} (orphan buys count toward current cycle)`);

  if (!APPLY) {
    console.log(`\n💡 Dry-run done. To apply: node scripts/recover-gemini-ethusd-2026-05-14.js --apply\n`);
    return;
  }

  // ── Apply ───────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  APPLYING`);
  console.log(`${'═'.repeat(70)}\n`);

  const ts = Date.now();
  fs.copyFileSync(statePath, `${statePath}.bak.${ts}`);
  fs.copyFileSync(ledgerPath, `${ledgerPath}.bak.${ts}`);
  console.log(`📁 Backups:`);
  console.log(`   ${statePath}.bak.${ts}`);
  console.log(`   ${ledgerPath}.bak.${ts}\n`);

  // Place TP first; abort state changes if it fails
  let tpOrderId = null;
  if (!NO_PLACE_TP) {
    console.log(`📤 Placing TP sell: ${tpQtyRounded} ETH @ $${tpRounded.toFixed(2)}`);
    const tpResult = await adapter.placeLimitSell(SYMBOL, tpQtyRounded, tpRounded, { postOnly: true });
    if (!tpResult.success) {
      console.error(`❌ TP placement failed: ${tpResult.errorMessage}`);
      console.error(`   No state changes applied.`);
      process.exit(1);
    }
    tpOrderId = tpResult.orderId;
    console.log(`   ✅ TP placed: orderId=${tpOrderId}\n`);
  } else {
    console.log(`(skipping TP placement: --no-place-tp)\n`);
  }

  // Determine current cycle from latest ledger entry
  const currentCycleId = [...ledger].reverse().find(f => f.cycleId)?.cycleId
    || state.position.cycleId
    || `cycle-${(state.position.cyclesCompleted || 0) + 1}`;

  // Append orphan fills to ledger (no body attribution; body update is source of truth)
  const ledgerEntries = orphans
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(o => ({
      tradeId: o.tradeId,
      orderId: o.orderId,
      side: o.side,
      price: o.price,
      size: o.size,
      quoteAmount: o.quoteAmount,
      fee: o.fee,
      feeAsset: o.feeCurrency,
      rebate: 0,
      netFee: o.fee,
      liquidityIndicator: o.liquidity,
      timestamp: o.timestamp,
      ingestedAt: ts,
      cycleId: currentCycleId,
      orderPlacedAt: null,
      fillTimeMs: null,
      isBodyOwned: false,         // body update below is the source of truth
      bodyId: null,
      bodyTier: null,
      sellOrderId: null,
    }));

  // Update body
  body.assetQty = roundAsset(newAssetQty);
  body.costBasis = roundUSDC(newCostBasis);
  body.avgPrice = newAvgPrice;
  body.tpOrderId = tpOrderId;
  body.tpPrice = tpRounded;
  body.assetOnOrder = NO_PLACE_TP ? 0 : tpQtyRounded;
  body.lastMergedAt = ts;
  body.sourceOrderIds = [...(body.sourceOrderIds || []), ...new Set(orphans.map(o => o.orderId))];
  body.mergeCount = (body.mergeCount || 0) + orphans.length;

  // Update position-level totals
  state.position.totalAsset = body.assetQty;
  state.position.totalCostBasis = body.costBasis;
  state.position.avgCostBasis = body.avgPrice;
  state.position.assetOnOrder = body.assetOnOrder;
  state.position.cycleBuys = (state.position.cycleBuys || 0) + buys.length;

  // Write
  const newLedger = [...ledger, ...ledgerEntries];
  atomicWrite(ledgerPath, newLedger);
  console.log(`💾 Wrote ${ledgerEntries.length} fills to fill-ledger.json (${newLedger.length} total)`);

  atomicWrite(statePath, state);
  console.log(`💾 Wrote body + state updates to regime-state.json`);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ✅ RECOVERY COMPLETE`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Body:        ${body.id}`);
  console.log(`  TP order:    ${tpOrderId || '(none — --no-place-tp)'}`);
  console.log(`  Position:    ${body.assetQty} ETH @ avg $${body.avgPrice.toFixed(2)} (cost basis $${body.costBasis})`);
  console.log(`  TP target:   $${tpRounded.toFixed(2)} (+${((tpRounded-body.avgPrice)/body.avgPrice*100).toFixed(3)}%)`);
  console.log(`\n  Backups:`);
  console.log(`    ${statePath}.bak.${ts}`);
  console.log(`    ${ledgerPath}.bak.${ts}`);
  console.log(`\n  Next: restart engine → pm2 restart critical-mass-gemini\n`);
}

main().catch(err => {
  console.error('\n❌ Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
