#!/usr/bin/env node
/**
 * Adopt base currency the account holds but the position model has lost track
 * of, into a celestial body so the engine manages it again.
 *
 * A complete fill ledger does not imply a complete position model. Before
 * issue #607, `heldOpenBuyCostBasis` decided a buy was closed on a boolean —
 * `sellOrderId` set and that sell has fills — with no quantity check, and
 * `sellOrderId` is re-stamped across merges and TP replacements. So a buy
 * order that was only partly sold counted as fully closed, and its unsold
 * remainder left the model: in no body, no take-profit, absent from the UI.
 * Sells now record per-buy consumption (`consumedBy`), but history booked
 * before that still closes on the boolean, and a quantity-aware reading of
 * `sellOrderId` cannot recover it, because the linkage is a crash-resilience
 * breadcrumb, not a consumption record.
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
const { checkEngineStopped } = require('../src/engine-liveness');
const { createFillLedger } = require('../src/fill-ledger');
const { createNewBody, syncPositionState } = require('../src/celestial-hierarchy');
const { loadRegimeState, saveRegimeState } = require('../src/state-tracker');
const { resolveFundDataDir } = require('../src/migration');
const { getBaseCurrency, getConfiguredFunds } = require('../src/config-utils');
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
/**
 * Refuse to write under a live engine — it holds these files in memory and its
 * next periodic save would discard the repair. See src/engine-liveness.js for
 * why the running flag's mtime is NOT a heartbeat.
 * @returns {Promise<void>}
 */
const assertEngineStopped = async () => {
  const { safe, reason } = await checkEngineStopped(EXCHANGE, PAIR);
  if (safe) {
    console.log(`  engine check: ${reason}`);
    return;
  }
  console.error(
    `\n❌ REFUSING to write ${EXCHANGE}/${PAIR}: ${reason}.`
    + '\n   Stop it first (pm2 stop <process>), then re-run with --apply.'
  );
  process.exit(1);
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
      lots.push({
        qty: fill.size,
        unit: (fill.size * fill.price + (fill.netFee || 0)) / fill.size,
        cycleId: fill.cycleId || '(none)',
      });
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
  // Which cycles the surviving lots belong to. FIFO consumes sells GLOBALLY,
  // while this engine's accounting unit is the atomic cycle (CLAUDE.md), so a
  // basis drawn from several cycles is a cross-cycle average — fine as a
  // diagnostic, a judgement call as a real body's cost. Surface it rather than
  // hide it; the operator decides.
  const byCycle = new Map();
  for (const l of lots) {
    const prev = byCycle.get(l.cycleId) || { qty: 0, cost: 0 };
    byCycle.set(l.cycleId, { qty: prev.qty + l.qty, cost: prev.cost + l.qty * l.unit });
  }
  return { qty, cost, unit: qty > 0 ? cost / qty : 0, byCycle };
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

  // getAccountBalance reports the ACCOUNT's base-currency balance, not this
  // fund's. With two funds on one exchange sharing a base currency, the other
  // fund's coin reads as this fund's coverage gap — and --apply would fold it
  // into a body whose take-profit then sells it. Refuse rather than guess.
  const sharingBase = getConfiguredFunds()
    .filter(f => f.exchange === EXCHANGE && getBaseCurrency(f.pair) === BASE);
  if (sharingBase.length > 1) {
    console.error(
      `\n❌ ${sharingBase.length} funds on ${EXCHANGE} share ${BASE} (${sharingBase.map(f => f.pair).join(', ')}).`
      + `\n   The exchange reports one account-wide ${BASE} balance, so the untracked amount cannot be`
      + `\n   attributed to ${PAIR} alone. Adopt manually after deciding the split.`
    );
    process.exit(1);
  }

  const ledgerNet = fills.reduce((sum, f) => sum + (f.side === 'buy' ? f.size : -f.size), 0);
  const bodies = saved.position.celestialBodies || [];
  const inBodies = bodies.reduce((sum, b) => sum + (b.assetQty || 0), 0);
  const reserves = saved.position.realizedAssetPnL || 0;
  const untracked = roundAsset(onExchange - inBodies - reserves);

  const fifo = fifoRemaining(fills);
  // Dust below what the exchange can trade is not a real open position.
  const product = await adapter.getProductDetails(PAIR).catch(() => null);
  const tolerance = Number(product?.baseMinSize) || 0;
  const costBasis = roundUSDC(untracked * fifo.unit);

  console.log(`  exchange balance : ${roundAsset(onExchange)} ${BASE}`);
  console.log(`  ledger net       : ${roundAsset(ledgerNet)} ${BASE}`);
  console.log(`  in ${String(bodies.length).padStart(2)} bodies     : ${roundAsset(inBodies)} ${BASE}`);
  console.log(`  reserves         : ${roundAsset(reserves)} ${BASE} (zero-cost)`);
  console.log(`  UNTRACKED        : ${untracked} ${BASE}\n`);

  if (untracked < 0) {
    console.error(
      `\n❌ the model claims ${roundAsset(-untracked)} ${BASE} MORE than the account holds.`
      + '\n   That is asset the engine believes it owns and does not — investigate before adopting.'
    );
    process.exit(1);
  }
  if (untracked <= tolerance) {
    console.log(untracked === 0
      ? '✅ Nothing to adopt — the model already covers the balance.'
      : `✅ Nothing to adopt — the ${roundAsset(untracked)} ${BASE} gap is at or below the exchange minimum (${tolerance}), so no placeable TP could be sized for it.`);
    return;
  }

  // The cost basis is a FIFO replay of the ledger, so a ledger that disagrees
  // with the exchange makes it meaningless — and dangerously so: too few
  // remaining lots drives the per-unit cost toward zero, which prices the new
  // body's TP at ~0 and dumps the whole position at market. Refuse rather than
  // warn.
  if (Math.abs(ledgerNet - onExchange) > 1e-6) {
    console.error(
      `\n❌ the ledger (${roundAsset(ledgerNet)}) and the exchange (${roundAsset(onExchange)}) disagree by `
      + `${roundAsset(Math.abs(ledgerNet - onExchange))} ${BASE} — the FIFO cost basis would be wrong.`
      + '\n   Run scripts/backfill-missing-fills.js first.'
    );
    process.exit(1);
  }
  if (!(fifo.unit > 0)) {
    console.error('\n❌ FIFO replay left no priced inventory — refusing to adopt at a zero cost basis.');
    process.exit(1);
  }

  console.log(`  FIFO remaining   : ${roundAsset(fifo.qty)} ${BASE} cost $${roundUSDC(fifo.cost)} → $${roundUSDC(fifo.unit)}/${BASE}`);
  const cycles = [...fifo.byCycle.entries()].sort((a, b) => b[1].qty - a[1].qty);
  console.log(`  basis drawn from : ${cycles.length} cycle(s) — ${cycles.slice(0, 5)
    .map(([id, v]) => `${id} ${roundAsset(v.qty)} @ $${roundUSDC(v.qty > 0 ? v.cost / v.qty : 0)}`).join(', ')}`);
  if (cycles.length > 1) {
    console.log('  ⚠️  FIFO consumes sells globally, so this basis is a CROSS-CYCLE average.');
    console.log('      This engine\'s accounting unit is the atomic cycle — review the spread above');
    console.log('      before adopting; the value becomes a real body\'s cost and drives its TP.');
  }

  // A buy the ledger still shows as open has its cost in heldOpenBuyCostBasis
  // already. Adopting that same quantity into a body with no order links would
  // count the cost twice once the body's TP books its annotated P&L. Those buys
  // belong in a body via the engine's own recovery, not via this script.
  // Buys a body already owns are accounted for — their cost is in that body's
  // costBasis, not double-counted. Only an open buy that NO body claims is the
  // hazard, and counting the body-owned ones would fire this guard on every
  // fund holding an open position, i.e. the normal case.
  const bodyOrderIds = new Set(bodies
    .flatMap(b => [...(b.sourceOrderIds || []), ...(b.buyOrders || []).map(o => o.orderId)])
    .map(String));
  // Same closure rule as computeRealizedFromCyclePairs: an order a sell has
  // recorded consumption against (issue #607) holds `size − Σ consumedBy`
  // open — the unsold remainder of a partly-sold order included; older orders
  // close on the sellOrderId boolean.
  const sellOrderIdsWithFills = new Set(fills.filter(f => f.side === 'sell').map(f => String(f.orderId)));
  const unclaimedBuys = new Map();
  for (const f of fills) {
    if (f.side !== 'buy' || bodyOrderIds.has(String(f.orderId))) continue;
    const key = f.orderId ? String(f.orderId) : `__noorder__:${f.tradeId}`;
    const agg = unclaimedBuys.get(key) || { size: 0, consumedBy: null, legacyOpen: 0 };
    agg.size += f.size;
    if (f.consumedBy && typeof f.consumedBy === 'object') agg.consumedBy = { ...(agg.consumedBy || {}), ...f.consumedBy };
    if (!f.sellOrderId || !sellOrderIdsWithFills.has(String(f.sellOrderId))) agg.legacyOpen += f.size;
    unclaimedBuys.set(key, agg);
  }
  const heldOpenQty = [...unclaimedBuys.values()].reduce((sum, agg) => sum + (agg.consumedBy
    ? Math.max(0, agg.size - Object.values(agg.consumedBy).reduce((s, q) => s + (q > 0 ? q : 0), 0))
    : agg.legacyOpen), 0);
  if (heldOpenQty > tolerance) {
    console.error(
      `\n❌ the ledger still shows ${roundAsset(heldOpenQty)} ${BASE} of buys as OPEN (no sell behind their sellOrderId).`
      + `\n   Their cost is already in heldOpenBuyCostBasis, so folding the same quantity into a new body`
      + `\n   would count it twice when that body's TP books its P&L. Reconcile those buys into bodies first.`
    );
    process.exit(1);
  }
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

  await assertEngineStopped();

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
