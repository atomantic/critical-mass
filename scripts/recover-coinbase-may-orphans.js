#!/usr/bin/env node
/**
 * Recover Coinbase BTC-USDC May 2026 orphan buys into a new celestial body
 * and place a single consolidated take-profit sell.
 *
 * Context: a verify-after-placement race in order-executor.js was treating
 * freshly-placed orders as "immediately cancelled" when Coinbase's getOrder
 * lagged propagation. Those orders later filled but were never tracked in the
 * fill-ledger. The 2026-05-08 13:46–13:47 UTC window has 1,929 such fills.
 *
 * Scope:
 *   - May 2026 only (per user — earlier discrepancies are pre-engine manual)
 *   - BUYs with BTC ≤ 0.5 (excludes manual 1 BTC trades)
 *   - Fills not present in fill-ledger.json (matched by tradeId / orderId)
 *
 * What it does:
 *   1. Pulls all 2026-05 fills from Coinbase historical API
 *   2. Diffs against ./data/coinbase/BTC-USDC/fill-ledger.json
 *   3. Builds proposed body { assetQty, costBasis, avgPrice }
 *   4. Computes TP = max(avgPrice × (1 + tpMinPercent), currentBid × (1 + safetyBps))
 *   5. With --apply: appends fills to ledger, adds body to state, places TP sell
 *
 * Default mode is dry-run. STOP THE COINBASE ENGINE before running with --apply.
 *
 * Usage:
 *   node scripts/recover-coinbase-may-orphans.js                 # dry-run
 *   node scripts/recover-coinbase-may-orphans.js --apply         # mutate + place TP
 *   node scripts/recover-coinbase-may-orphans.js --tp-pct 1.5    # override TP % (default: tpMinPercent)
 *   node scripts/recover-coinbase-may-orphans.js --no-place-tp   # ledger+state only, no TP order
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { resolveFundDataDir } = require('../src/migration');
const { getRegimeConfig } = require('../src/config-utils');
const { DATA_DIR } = require('../src/paths');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');

const APPLY = process.argv.includes('--apply');
const NO_PLACE_TP = process.argv.includes('--no-place-tp');
const tpPctArg = process.argv.indexOf('--tp-pct');
const TP_PCT_OVERRIDE = tpPctArg >= 0 ? parseFloat(process.argv[tpPctArg + 1]) : null;

const PAIR = 'BTC-USDC';
const MAX_BTC = 0.5;                  // exclude manual trades
const SINCE_ISO = '2026-05-01T00:00:00Z';
const UNTIL_ISO = '2026-06-01T00:00:00Z';
const TP_SAFETY_BPS = 5;              // place TP 5 bps above current bid as minimum

const API_URL = 'https://api.coinbase.com';
const fundDir = resolveFundDataDir('coinbase', PAIR);
const statePath = path.join(fundDir, 'regime-state.json');
const ledgerPath = path.join(fundDir, 'fill-ledger.json');

// ── Auth ────────────────────────────────────────────────────────

const keysPath = path.join(DATA_DIR, 'coinbase-keys.json');
const keysRaw = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
const keys = { apiKey: keysRaw.name, apiSecret: keysRaw.privateKey };

const makeRequest = async (method, apiPath) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(`${API_URL}${apiPath}`, {
      method,
      headers: getAuthHeaders(keys.apiKey, keys.apiSecret, method, apiPath),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Coinbase API ${resp.status}: ${resp.statusText}`);
    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
};

const fetchFills = async () => {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    page++;
    let apiPath = `/api/v3/brokerage/orders/historical/fills?product_id=${PAIR}&start_sequence_timestamp=${SINCE_ISO}&end_sequence_timestamp=${UNTIL_ISO}&limit=500`;
    if (cursor) apiPath += `&cursor=${cursor}`;
    process.stdout.write(`📡 Fetching fills page ${page}${cursor ? ' (cursor)' : ''}...`);
    const data = await makeRequest('GET', apiPath);
    const fills = data.fills || [];
    all.push(...fills);
    cursor = data.cursor || null;
    console.log(` ${fills.length} fills`);
  } while (cursor);
  return all;
};

// ── Atomic write ────────────────────────────────────────────────

const atomicWrite = (filePath, data) => {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
};

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Coinbase BTC-USDC May 2026 Orphan Recovery`);
  console.log(`  Mode: ${APPLY ? '⚠️  APPLY (will mutate state & place TP)' : '🔍 DRY-RUN (no changes)'}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Safety: refuse to apply if engine is running
  if (APPLY) {
    const runningFlag = path.join(fundDir, 'regime-engine-running.json');
    if (fs.existsSync(runningFlag)) {
      const flag = JSON.parse(fs.readFileSync(runningFlag, 'utf8'));
      const ageMs = Date.now() - (flag.lastHeartbeat || flag.startedAt || 0);
      if (ageMs < 60_000) {
        console.error(`❌ ABORT: regime-engine-running.json was updated ${Math.round(ageMs/1000)}s ago.`);
        console.error(`   Stop the coinbase engine first: pm2 stop critical-mass-coinbase`);
        process.exit(1);
      }
    }
  }

  // Load state + ledger
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

  // Fetch May fills
  const rawFills = await fetchFills();
  console.log(`\n📊 Fetched ${rawFills.length} fills from Coinbase for ${SINCE_ISO.slice(0,7)}\n`);

  // Build ledger lookup
  const ledgerTradeIds = new Set();
  const ledgerOrderIds = new Set();
  for (const f of ledger) {
    ledgerTradeIds.add(f.tradeId);
    if (f.tradeId && f.tradeId.startsWith('fill-')) {
      ledgerTradeIds.add(f.tradeId.slice(5));
    }
    ledgerOrderIds.add(f.orderId);
  }

  // Find orphan buys (engine-scope only)
  const orphanFills = [];
  for (const f of rawFills) {
    if (f.side.toLowerCase() !== 'buy') continue;
    const price = parseFloat(f.price);
    const rawSize = parseFloat(f.size);
    const sizeInQuote = f.size_in_quote === true;
    const baseSize = sizeInQuote && price > 0 ? rawSize / price : rawSize;
    if (baseSize > MAX_BTC) continue; // manual trade
    if (ledgerTradeIds.has(f.trade_id)) continue;
    if (ledgerTradeIds.has(`fill-${f.order_id}`)) continue;
    const quoteAmount = sizeInQuote ? rawSize : price * rawSize;
    orphanFills.push({
      tradeId: f.trade_id,
      orderId: f.order_id,
      price,
      size: baseSize,
      quoteAmount,
      fee: parseFloat(f.commission || 0),
      liquidityIndicator: f.liquidity_indicator || 'UNKNOWN',
      tradeTime: f.trade_time,
      timestamp: new Date(f.trade_time).getTime(),
    });
  }

  if (orphanFills.length === 0) {
    console.log('✅ No May orphan buys found. Nothing to recover.');
    return;
  }

  // Aggregate proposed body
  const totalAsset = orphanFills.reduce((s, f) => s + f.size, 0);
  const totalCost = orphanFills.reduce((s, f) => s + f.quoteAmount, 0);
  const totalFees = orphanFills.reduce((s, f) => s + f.fee, 0);
  const avgPrice = totalCost / totalAsset;
  const costBasisIncFees = totalCost + totalFees;
  const orderIds = [...new Set(orphanFills.map(f => f.orderId))];
  const firstTradeTime = Math.min(...orphanFills.map(f => f.timestamp));
  const lastTradeTime = Math.max(...orphanFills.map(f => f.timestamp));

  // Compute TP
  const config = getRegimeConfig('coinbase', PAIR);
  const tpPctEff = TP_PCT_OVERRIDE != null ? TP_PCT_OVERRIDE : config.tpMinPercent;
  const targetTp = avgPrice * (1 + tpPctEff / 100);

  // Get current market for "just-over-current" floor
  const adapter = createCoinbaseAdapter();
  const { bid: currentBid, ask: currentAsk } = await adapter.getBidAsk(PAIR);
  const floorTp = currentAsk * (1 + TP_SAFETY_BPS / 10000); // just above ask so it's a maker
  const proposedTp = Math.max(targetTp, floorTp);
  const tpRounded = Math.round(proposedTp * 100) / 100; // Coinbase BTC-USDC price increment = $0.01

  const newBodyId = `body-recovery-may-${new Date().toISOString().slice(0,10)}-${crypto.randomBytes(3).toString('hex')}`;
  const currentCycleId = state.position.cycleId || `cycle-${state.position.cyclesCompleted + 1}`;

  // ── Report ──────────────────────────────────────────────────

  console.log(`${'─'.repeat(70)}`);
  console.log(`  ORPHAN FILLS FOUND`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Window:           ${new Date(firstTradeTime).toISOString()}  →  ${new Date(lastTradeTime).toISOString()}`);
  console.log(`  Total fills:      ${orphanFills.length}`);
  console.log(`  Distinct orders:  ${orderIds.length}`);
  console.log(`  Total BTC:        ${roundAsset(totalAsset)}`);
  console.log(`  Total quote:      $${roundUSDC(totalCost)}`);
  console.log(`  Total fees:       $${roundUSDC(totalFees)}`);
  console.log(`  Avg price:        $${roundUSDC(avgPrice)}`);
  console.log(`  Cost basis +fees: $${roundUSDC(costBasisIncFees)}`);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PROPOSED NEW BODY`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  id:           ${newBodyId}`);
  console.log(`  tier:         satellite  (recovery body, no merging)`);
  console.log(`  assetQty:     ${roundAsset(totalAsset)} BTC`);
  console.log(`  costBasis:    $${roundUSDC(costBasisIncFees)}`);
  console.log(`  avgPrice:     $${roundUSDC(avgPrice)}`);
  console.log(`  sourceOrderIds: ${orderIds.length} ids (oldest → newest)`);
  console.log(`  cycleId:      ${currentCycleId}  (current cycle, per spec)`);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PROPOSED TP SELL`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Market:           bid=$${roundUSDC(currentBid)} ask=$${roundUSDC(currentAsk)}`);
  console.log(`  Computed target:  avgPrice × (1 + ${tpPctEff.toFixed(4)}%) = $${roundUSDC(targetTp)}`);
  console.log(`  Floor (current):  ask × (1 + ${TP_SAFETY_BPS}bps)              = $${roundUSDC(floorTp)}`);
  console.log(`  Using:            ${proposedTp === floorTp ? 'FLOOR (target was below market)' : 'COMPUTED TARGET'}`);
  console.log(`  TP price:         $${roundUSDC(tpRounded)}`);
  console.log(`  TP size:          ${roundAsset(totalAsset)} BTC`);
  console.log(`  Implied gain:     ${((tpRounded - avgPrice) / avgPrice * 100).toFixed(3)}% over avg, $${roundUSDC(tpRounded * totalAsset - costBasisIncFees)} gross of fees`);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  STATE DELTA (will be applied with --apply)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ledger fills:        +${orphanFills.length}     (${ledger.length} → ${ledger.length + orphanFills.length})`);
  console.log(`  celestialBodies:     +1         (${(state.position.celestialBodies||[]).length} → ${(state.position.celestialBodies||[]).length + 1})`);
  console.log(`  totalAsset:          +${roundAsset(totalAsset)}  (${state.position.totalAsset} → ${roundAsset(state.position.totalAsset + totalAsset)})`);
  console.log(`  totalCostBasis:      +$${roundUSDC(costBasisIncFees)}  (${state.position.totalCostBasis} → ${roundUSDC(state.position.totalCostBasis + costBasisIncFees)})`);
  console.log(`  cycleBuys:           +${orphanFills.length}     (${state.position.cycleBuys} → ${state.position.cycleBuys + orphanFills.length})`);

  if (!APPLY) {
    console.log(`\n💡 Dry-run complete. Review above. To apply:`);
    console.log(`    pm2 stop critical-mass-coinbase  # if running`);
    console.log(`    node scripts/recover-coinbase-may-orphans.js --apply\n`);
    return;
  }

  // ── Apply ───────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  APPLYING CHANGES`);
  console.log(`${'═'.repeat(70)}\n`);

  // Backup
  const ts = Date.now();
  fs.copyFileSync(statePath, `${statePath}.bak.${ts}`);
  fs.copyFileSync(ledgerPath, `${ledgerPath}.bak.${ts}`);
  console.log(`📁 Backups written:`);
  console.log(`   ${statePath}.bak.${ts}`);
  console.log(`   ${ledgerPath}.bak.${ts}\n`);

  // Build new body
  const newBody = {
    id: newBodyId,
    tier: 'satellite',
    assetQty: roundAsset(totalAsset),
    costBasis: roundUSDC(costBasisIncFees),
    avgPrice: roundUSDC(avgPrice),
    tpOrderId: null,
    tpPrice: tpRounded,
    assetOnOrder: 0,
    createdAt: ts,
    lastMergedAt: ts,
    sourceOrderIds: orderIds,
    buyOrders: orphanFills.map(f => ({
      orderId: f.orderId,
      tradeId: f.tradeId,
      price: f.price,
      size: f.size,
      quoteAmount: f.quoteAmount,
      fee: f.fee,
      timestamp: f.timestamp,
    })),
    mergeCount: orphanFills.length,
    manualTpPct: null,
  };

  // Build ledger entries
  const ledgerEntries = orphanFills
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(f => ({
      tradeId: f.tradeId,
      orderId: f.orderId,
      side: 'buy',
      price: f.price,
      size: f.size,
      quoteAmount: f.quoteAmount,
      fee: f.fee,
      feeAsset: 'USDC',
      rebate: 0,
      netFee: f.fee,
      liquidityIndicator: f.liquidityIndicator,
      timestamp: f.timestamp,
      ingestedAt: ts,
      cycleId: currentCycleId,
      orderPlacedAt: null,
      fillTimeMs: null,
      isBodyOwned: true,
      bodyId: newBodyId,
      bodyTier: 'satellite',
      sellOrderId: null, // set after TP placement
    }));

  // Place TP sell first — if this fails, abort before mutating state
  let tpOrderId = null;
  if (!NO_PLACE_TP) {
    console.log(`📤 Placing TP sell: ${roundAsset(totalAsset)} BTC @ $${roundUSDC(tpRounded)}`);
    const tpResult = await adapter.placeLimitSell(PAIR, roundAsset(totalAsset), tpRounded, { postOnly: true });
    if (!tpResult.success) {
      console.error(`❌ TP placement failed: ${tpResult.errorMessage}`);
      console.error(`   No state changes were applied. Investigate and re-run.`);
      process.exit(1);
    }
    tpOrderId = tpResult.orderId;
    newBody.tpOrderId = tpOrderId;
    newBody.assetOnOrder = newBody.assetQty;
    for (const e of ledgerEntries) e.sellOrderId = tpOrderId;
    console.log(`   ✅ TP placed: orderId=${tpOrderId}\n`);
  } else {
    console.log(`(skipping TP placement: --no-place-tp)\n`);
  }

  // Update state
  state.position.celestialBodies = [...(state.position.celestialBodies || []), newBody];
  state.position.totalAsset = roundAsset(state.position.totalAsset + totalAsset);
  state.position.totalCostBasis = roundUSDC(state.position.totalCostBasis + costBasisIncFees);
  state.position.cycleBuys = (state.position.cycleBuys || 0) + orphanFills.length;
  state.position.avgCostBasis = state.position.totalAsset > 0
    ? state.position.totalCostBasis / state.position.totalAsset
    : 0;

  // Write ledger first (append), then state
  const newLedger = [...ledger, ...ledgerEntries];
  atomicWrite(ledgerPath, newLedger);
  console.log(`💾 Wrote ${ledgerEntries.length} fills to fill-ledger.json (${newLedger.length} total)`);

  atomicWrite(statePath, state);
  console.log(`💾 Wrote new body + state updates to regime-state.json`);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ✅ RECOVERY COMPLETE`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Body:        ${newBodyId}`);
  console.log(`  TP order:    ${tpOrderId || '(none — --no-place-tp)'}`);
  console.log(`  Restored:    ${roundAsset(totalAsset)} BTC @ avg $${roundUSDC(avgPrice)}`);
  console.log(`  TP target:   $${roundUSDC(tpRounded)} (+${((tpRounded-avgPrice)/avgPrice*100).toFixed(3)}%)`);
  console.log(`\n  Backups:`);
  console.log(`    ${statePath}.bak.${ts}`);
  console.log(`    ${ledgerPath}.bak.${ts}`);
  console.log(`\n  Next steps:`);
  console.log(`    1. Verify TP order is visible on Coinbase`);
  console.log(`    2. Re-run audit-fills.js to confirm orphan count dropped`);
  console.log(`    3. Restart engine: pm2 start critical-mass-coinbase\n`);
}

main().catch(err => {
  console.error('\n❌ Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
