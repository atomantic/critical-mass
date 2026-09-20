#!/usr/bin/env node
/**
 * Adopt base currency the account holds but the position model has lost track
 * of, into a celestial body so the engine manages it again.
 *
 * A complete fill ledger does not imply a complete position model.
 * `heldOpenBuyCostBasis` decides a buy is closed on a boolean — `sellOrderId`
 * is set and that sell has fills — with no quantity check, and `sellOrderId` is
 * re-stamped across merges and TP replacements. So a buy order that was only
 * partly sold counts as fully closed, and its unsold remainder leaves the
 * model: in no body, no take-profit, absent from the UI. A quantity-aware
 * version of that rule does not recover it either, because the linkage is a
 * crash-resilience breadcrumb, not a consumption record.
 *
 * The one identity that cannot lie is
 *
 *     exchange balance == Σ body.assetQty + realizedAssetPnL (reserves)
 *
 * so the untracked amount is read straight off that, and its cost basis comes
 * from a FIFO replay of the whole ledger: the asset still on hand cost
 * `remainingCost`, spread pro rata over every unit held. The new body's TP is
 * `avgPrice × (1 + tp%)`; if that lands below the market the TP is placed
 * `postOnly: false` (order-executor.js:1241) and crosses, filling at the best
 * bid rather than resting. Check the printed TP against spot before --apply —
 * this sells real asset.
 *
 * STOP THE ENGINE FIRST. A running engine rewrites regime-state.json on its own
 * timer and will clobber the new body. The script refuses to --apply while the
 * fund's regime-engine-running.json heartbeat is fresh.
 *
 * Usage:
 *   node scripts/adopt-untracked-asset.js gemini ETHUSD           # dry run
 *   node scripts/adopt-untracked-asset.js gemini ETHUSD --apply
 */

const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../src/adapters');
const { createFillLedger } = require('../src/fill-ledger');
const { createNewBody, syncPositionState } = require('../src/celestial-hierarchy');
const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
const { resolveFundDataDir } = require('../src/migration');
const { getBaseCurrency } = require('../src/config-utils');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');

const [, , EXCHANGE_ARG, PAIR_ARG] = process.argv;
const APPLY = process.argv.includes('--apply');

if (!EXCHANGE_ARG || !PAIR_ARG || EXCHANGE_ARG.startsWith('--')) {
  console.error('Usage: node scripts/adopt-untracked-asset.js <exchange> <PAIR> [--apply]');
  process.exit(1);
}

const EXCHANGE = EXCHANGE_ARG.toLowerCase();
const PAIR = PAIR_ARG.toUpperCase();
const BASE = getBaseCurrency(PAIR);
const HEARTBEAT_PATH = path.join(resolveFundDataDir(EXCHANGE, PAIR), 'regime-engine-running.json');
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

const assertEngineStopped = () => {
  if (!fs.existsSync(HEARTBEAT_PATH)) return;
  const ageMs = Date.now() - fs.statSync(HEARTBEAT_PATH).mtimeMs;
  if (ageMs < HEARTBEAT_STALE_MS) {
    console.error(
      `\n❌ ${EXCHANGE}/${PAIR} engine looks alive — heartbeat touched ${Math.round(ageMs / 1000)}s ago.`
      + '\n   Stop it first (pm2 stop <process>), then re-run with --apply.'
    );
    process.exit(1);
  }
};

/**
 * FIFO replay over every fill: what the base currency still on hand cost.
 * Buys open cost lots, sells consume them oldest-first.
 * @param {Array} fills
 * @returns {{qty: number, cost: number, unit: number}}
 */
const fifoRemaining = (fills) => {
  const lots = [];
  for (const fill of [...fills].sort((a, b) => a.timestamp - b.timestamp)) {
    if (fill.side === 'buy') {
      lots.push({ qty: fill.size, unit: (fill.size * fill.price + (fill.netFee || 0)) / fill.size });
      continue;
    }
    let remaining = fill.size;
    while (remaining > 1e-12 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.qty);
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) lots.shift();
    }
  }
  const qty = lots.reduce((sum, l) => sum + l.qty, 0);
  const cost = lots.reduce((sum, l) => sum + l.qty * l.unit, 0);
  return { qty, cost, unit: qty > 0 ? cost / qty : 0 };
};

async function main() {
  console.log(`\nAdopting untracked ${BASE} on ${EXCHANGE}/${PAIR}\n`);

  const adapter = getAdapter(EXCHANGE);
  if (typeof adapter.getAccountBalance !== 'function') {
    console.error(`❌ ${EXCHANGE} adapter cannot report account balances.`);
    process.exit(1);
  }

  const saved = loadRegimeState(EXCHANGE, PAIR);
  if (!saved.position) {
    console.error('❌ No position in regime-state.json.');
    process.exit(1);
  }

  const ledger = createFillLedger(EXCHANGE, PAIR, PAIR, { quiet: true });
  const fills = ledger.getAllFills();
  const balance = await adapter.getAccountBalance(BASE);
  const onExchange = Number(balance?.total);
  if (!Number.isFinite(onExchange)) {
    console.error('❌ Exchange did not report a usable balance.');
    process.exit(1);
  }

  const ledgerNet = fills.reduce((sum, f) => sum + (f.side === 'buy' ? f.size : -f.size), 0);
  const bodies = saved.position.celestialBodies || [];
  const inBodies = bodies.reduce((sum, b) => sum + (b.assetQty || 0), 0);
  const reserves = saved.position.realizedAssetPnL || 0;
  const untracked = roundAsset(onExchange - inBodies - reserves);

  const fifo = fifoRemaining(fills);
  const costBasis = roundUSDC(untracked * fifo.unit);

  console.log(`  exchange balance : ${roundAsset(onExchange)} ${BASE}`);
  console.log(`  ledger net       : ${roundAsset(ledgerNet)} ${BASE}${Math.abs(ledgerNet - onExchange) > 1e-6 ? '   ⚠️  ledger does not match the exchange — run backfill-missing-fills.js first' : ''}`);
  console.log(`  in ${String(bodies.length).padStart(2)} bodies     : ${roundAsset(inBodies)} ${BASE}`);
  console.log(`  reserves         : ${roundAsset(reserves)} ${BASE} (zero-cost)`);
  console.log(`  UNTRACKED        : ${untracked} ${BASE}\n`);

  if (untracked <= 0) {
    console.log('✅ Nothing to adopt — the model already covers the balance.');
    return;
  }

  console.log(`  FIFO remaining   : ${roundAsset(fifo.qty)} ${BASE} cost $${roundUSDC(fifo.cost)} → $${roundUSDC(fifo.unit)}/${BASE}`);
  console.log(`  new body         : ${untracked} ${BASE} @ $${roundUSDC(fifo.unit)} = $${costBasis}`);

  const spot = await adapter.getCurrentPrice(PAIR).catch(() => null);
  if (spot) {
    const pct = ((spot / fifo.unit - 1) * 100);
    console.log(`  spot             : $${roundUSDC(spot)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs the adopted basis)`);
    console.log(`  → a TP priced below spot is placed postOnly:false and will CROSS, selling ~${untracked} ${BASE} at about $${roundUSDC(untracked * spot)}`);
  }

  const body = createNewBody({ assetQty: untracked, costBasis, avgPrice: fifo.unit }, `adopted-${Date.now()}`);
  body.buyOrders = [];
  body.sourceOrderIds = [];
  body.adoptedFrom = 'position-coverage-gap';

  const after = [...bodies, body];
  const covered = roundAsset(after.reduce((sum, b) => sum + b.assetQty, 0) + reserves);
  console.log(`\n  coverage after   : ${covered} ${BASE} vs ${roundAsset(onExchange)} on the exchange`);
  if (Math.abs(covered - onExchange) > 1e-6) {
    console.error('\n❌ adoption would not close the gap — aborting');
    process.exit(1);
  }
  console.log('\n✅ The model would account for every unit the account holds.');

  if (!APPLY) {
    console.log('\n(Dry run — re-run with --apply to write.)');
    return;
  }

  assertEngineStopped();

  const statePath = path.join(resolveFundDataDir(EXCHANGE, PAIR), 'regime-state.json');
  const backupPath = `${statePath}.backup-adopt-${Date.now()}`;
  fs.copyFileSync(statePath, backupPath);
  console.log(`\nBackup: ${backupPath}`);

  saved.position.celestialBodies = after;
  syncPositionState(saved.position, saved.position.celestialBodies);
  saveRegimeState(saved.position, saved.regime, EXCHANGE, saved.tpOptimizer, saved.sizeOptimizer, PAIR);
  console.log(`Wrote body ${body.id}: ${untracked} ${BASE} @ $${roundUSDC(fifo.unit)}`);
  console.log('\nRestart the engine — it will place this body\'s take-profit on start.');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
