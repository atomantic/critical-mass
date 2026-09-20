#!/usr/bin/env node
/**
 * Repair a fill-ledger that drifted from the exchange.
 *
 * Two defects, both found on gemini/ETHUSD in September 2026:
 *
 *  1. MISSING FILLS. A limit order fills in tranches. The engine records the
 *     first tranche and, on Gemini (no order-events WebSocket), only ever
 *     notices the rest if the order is still in order-executor's in-memory
 *     pendingOrders map when the next poll runs. Lose that entry and the
 *     remaining tranche is never recorded — the ledger claims less asset than
 *     the account actually holds. 61 buy fills / 1.204 ETH leaked this way.
 *
 *  2. PSEUDO-FILL TWINS. handleOrderFill's fallback writes a row keyed
 *     `synthetic-<orderId>` when getOrderFills comes back empty, and cycle
 *     consolidation writes `consolidated-sell-<ts>`. If the real exchange fill
 *     lands later by another path, both rows survive (ledger dedup keys on
 *     tradeId) and that order's size is counted twice. The per-sell P&L
 *     annotations (bodyPnl, bodyHoldbackAsset, ...) live only on the pseudo
 *     row, so it cannot simply be deleted — they move to the real row first.
 *
 * Cycle assignment is deliberately conservative: a recovered fill inherits the
 * cycleId of the other fills on its own order (an order cannot straddle a
 * cycle), and an order with no recorded fill at all inherits from its nearest
 * neighbour in time. recalculateCycles() is NOT run — it re-derives cycle
 * boundaries for every orphan and would renumber settled history.
 *
 * Recovered buys carry no sellOrderId, so they correctly surface as held/open
 * positions: that asset is still sitting on the exchange, unsold.
 *
 * STOP THE ENGINE FIRST. A running engine periodically rewrites the ledger and
 * will clobber these changes. The script refuses to --apply while the fund's
 * regime-engine-running.json heartbeat is fresh.
 *
 * Usage:
 *   node scripts/backfill-missing-fills.js gemini ETHUSD           # dry run
 *   node scripts/backfill-missing-fills.js gemini ETHUSD --apply
 */

const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../src/adapters');
const { checkEngineStopped } = require('../src/engine-liveness');
const { resolveFundDataDir } = require('../src/migration');
const { getBaseCurrency, getQuoteCurrency } = require('../src/config-utils');

const [, , EXCHANGE_ARG, PAIR_ARG] = process.argv;
const APPLY = process.argv.includes('--apply');

if (!EXCHANGE_ARG || !PAIR_ARG || EXCHANGE_ARG.startsWith('--')) {
  console.error('Usage: node scripts/backfill-missing-fills.js <exchange> <PAIR> [--apply]');
  process.exit(1);
}

const EXCHANGE = EXCHANGE_ARG.toLowerCase();
const PAIR = PAIR_ARG.toUpperCase();
const BASE = getBaseCurrency(PAIR);
const QUOTE = getQuoteCurrency(PAIR);

const fundDir = resolveFundDataDir(EXCHANGE, PAIR);
const LEDGER_PATH = path.join(fundDir, 'fill-ledger.json');
const STATE_PATH = path.join(fundDir, 'regime-state.json');

// Annotations that live only on a pseudo row and must survive its removal.
const ANNOTATION_KEYS = [
  'bodyPnl', 'bodyHoldbackAsset', 'bodyCostBasis', 'bodyAvgPrice', 'bodyBtcQty',
  'bodyTier', 'bodyId', 'satellitePnl', 'satelliteHoldbackAsset', 'satelliteCostBasis',
  'satelliteAvgPrice', 'satelliteBtcQty', 'isBodyOwned', 'isSatellite', 'sellOrderId',
  'consumedCostFraction',
];

// Rows the ENGINE writes as a stand-in for a real exchange fill it could not
// fetch. Only these are replaceable by the real fill. Everything else with a
// non-exchange tradeId is real history with no exchange counterpart —
// `dca-convert-buy-<orderId>` (which carries the REAL exchange orderId, so
// exchange-absence alone would misclassify it) and `fill-<uuid>` recovery rows —
// and must survive untouched. coinbase/BTC-USDC alone holds 20 such rows.
const PSEUDO_TRADE_ID = /^(synthetic-|consolidated-sell-)/;

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

/** Sum an annotation once per orderId — never across an order's partial rows. */
const sumOncePerOrder = (rows, key) => {
  const seen = new Map();
  for (const f of rows) {
    if (f.side !== 'sell' || f[key] == null) continue;
    if (!seen.has(f.orderId)) seen.set(f.orderId, f[key]);
  }
  let total = 0;
  for (const v of seen.values()) total += v;
  return { total, count: seen.size };
};

const netAsset = (rows) =>
  rows.reduce((sum, f) => sum + (f.side === 'buy' ? f.size : -f.size), 0);

const fmt = (n, dp = 6) => Number(n).toFixed(dp);

async function main() {
  console.log(`\nRepairing ${EXCHANGE}/${PAIR} fill-ledger`);
  console.log(`  ledger: ${LEDGER_PATH}`);

  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const engineStart = state.position?.engineStartTime;
  if (!engineStart) {
    console.error('❌ No position.engineStartTime in regime-state.json — cannot bound the trade fetch.');
    process.exit(1);
  }

  const adapter = getAdapter(EXCHANGE);
  if (!adapter.capabilities?.fillReconciliation) {
    console.error(`❌ ${EXCHANGE} adapter does not support fill reconciliation.`);
    process.exit(1);
  }

  console.log(`  loaded ${ledger.length} ledger rows; fetching exchange fills since ${new Date(engineStart).toISOString()}\n`);
  const exchangeFills = await adapter.getReconciliationFills(PAIR, engineStart);
  console.log(`  ${exchangeFills.length} fills on the exchange\n`);

  const exchangeByTradeId = new Map(exchangeFills.map(f => [f.tradeId, f]));
  const ledgerTradeIds = new Set(ledger.map(f => String(f.tradeId)));

  // ── 1. Reconcile every order the exchange knows about ───────────────────
  // For such an order the exchange is the whole truth: its fills are exactly
  // the rows that belong in the ledger. Rows carrying a tradeId the exchange
  // has never issued are pseudo fills (`synthetic-<orderId>`,
  // `consolidated-sell-<ts>`) — they stand in for a real fill the engine could
  // not fetch at the time, so they are replaced by it rather than kept
  // alongside, and their P&L annotations move to the surviving row.
  //
  // Orders the exchange does NOT know about are left completely alone: DCA
  // conversions and manual imports are real history with no exchange fill
  // behind them, and dropping them would erase it.
  const exchangeOrderIds = new Set(exchangeFills.map(f => f.orderId));
  const exchangeFillsByOrder = new Map();
  for (const f of exchangeFills) {
    const rows = exchangeFillsByOrder.get(f.orderId) || [];
    rows.push(f);
    exchangeFillsByOrder.set(f.orderId, rows);
  }

  const byOrderId = new Map();
  ledger.forEach((fill, idx) => {
    const rows = byOrderId.get(fill.orderId) || [];
    rows.push({ idx, fill });
    byOrderId.set(fill.orderId, rows);
  });

  const droppedIdx = new Set();
  const twins = [];
  /** orderId → annotations rescued from its dropped pseudo rows */
  const orphanedAnnotations = new Map();

  for (const [orderId, rows] of byOrderId) {
    if (!exchangeOrderIds.has(orderId)) continue;
    const pseudo = rows.filter(r => PSEUDO_TRADE_ID.test(String(r.fill.tradeId))
      && !exchangeByTradeId.has(String(r.fill.tradeId)));
    if (pseudo.length === 0) continue;

    // A pseudo row stands in for a real fill. Drop it ONLY when the exchange's
    // own fills for this order cover the quantity it represents — a truncated or
    // partially-paginated response would otherwise delete real size, and the net
    // check below compares against that same short response, so it would pass.
    const exchangeQty = (exchangeFillsByOrder.get(orderId) || []).reduce((sum, f) => sum + f.size, 0);
    const pseudoQty = pseudo.reduce((sum, r) => sum + r.fill.size, 0);
    if (exchangeQty + 1e-9 < pseudoQty) {
      console.warn(`  ⚠️  ${orderId}: exchange reports ${fmt(exchangeQty, 8)} ${BASE} but pseudo rows represent `
        + `${fmt(pseudoQty, 8)} — keeping them (incomplete exchange response?)`);
      continue;
    }

    // The row that will carry the annotations: the earliest real fill already
    // in the ledger, or (when every row on this order is pseudo) the earliest
    // fill recovered below.
    const real = rows
      .filter(r => exchangeByTradeId.has(String(r.fill.tradeId)))
      .sort((a, b) => a.fill.timestamp - b.fill.timestamp);

    for (const p of pseudo) {
      const moved = [];
      const rescued = {};
      for (const key of ANNOTATION_KEYS) {
        if (p.fill[key] == null) continue;
        if (real.length > 0) {
          if (real[0].fill[key] == null) { real[0].fill[key] = p.fill[key]; moved.push(key); }
        } else {
          rescued[key] = p.fill[key];
          moved.push(key);
        }
      }
      if (real.length === 0 && moved.length > 0) {
        orphanedAnnotations.set(orderId, { ...(orphanedAnnotations.get(orderId) || {}), ...rescued });
      }
      droppedIdx.add(p.idx);
      twins.push({ orderId, tradeId: p.fill.tradeId, side: p.fill.side, size: p.fill.size, moved });
    }
  }

  // ── 2. Missing exchange fills ───────────────────────────────────────────
  const missing = exchangeFills
    .filter(f => !ledgerTradeIds.has(f.tradeId))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Cycle inheritance: same order first, else nearest recorded fill in time.
  const cycleByOrderId = new Map();
  for (const f of ledger) {
    if (f.cycleId && !cycleByOrderId.has(f.orderId)) cycleByOrderId.set(f.orderId, f.cycleId);
  }
  const cycleAnchors = ledger
    .filter(f => f.cycleId)
    .map(f => ({ timestamp: f.timestamp, cycleId: f.cycleId }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const nearestCycleId = (timestamp) => {
    let best = null;
    let bestGap = Infinity;
    for (const anchor of cycleAnchors) {
      const gap = Math.abs(anchor.timestamp - timestamp);
      if (gap < bestGap) { bestGap = gap; best = anchor.cycleId; }
    }
    return best;
  };

  let inheritedFromOrder = 0;
  let inheritedFromNeighbour = 0;
  const annotationsPlaced = new Set();
  const recovered = missing.map((f) => {
    const sameOrder = cycleByOrderId.get(f.orderId);
    if (sameOrder) inheritedFromOrder++; else inheritedFromNeighbour++;
    // When every ledger row for this order was a pseudo fill, its annotations
    // have nowhere to land except the earliest fill we are recovering for it.
    // `missing` is time-sorted, so the first one seen is that row.
    let rescued = null;
    if (orphanedAnnotations.has(f.orderId) && !annotationsPlaced.has(f.orderId)) {
      rescued = orphanedAnnotations.get(f.orderId);
      annotationsPlaced.add(f.orderId);
    }
    return {
      ...(rescued || {}),
      tradeId: f.tradeId,
      orderId: f.orderId,
      side: f.side,
      price: f.price,
      size: f.size,
      quoteAmount: f.quoteAmount,
      fee: f.fee,
      feeAsset: f.feeCurrency || QUOTE,
      rebate: 0,
      netFee: f.fee,
      liquidityIndicator: f.liquidityIndicator || 'TAKER',
      timestamp: f.timestamp,
      ingestedAt: Date.now(),
      cycleId: sameOrder || nearestCycleId(f.timestamp),
      orderPlacedAt: null,
      fillTimeMs: null,
      recoveredBy: 'backfill-missing-fills',
    };
  });

  // ── 3. Build and validate the repaired ledger ───────────────────────────
  const repaired = [...ledger.filter((_, idx) => !droppedIdx.has(idx)), ...recovered]
    .sort((a, b) => a.timestamp - b.timestamp);

  const beforePnl = sumOncePerOrder(ledger, 'bodyPnl');
  const afterPnl = sumOncePerOrder(repaired, 'bodyPnl');
  const beforeHold = sumOncePerOrder(ledger, 'bodyHoldbackAsset');
  const afterHold = sumOncePerOrder(repaired, 'bodyHoldbackAsset');

  const recoveredBuys = recovered.filter(f => f.side === 'buy');
  const recoveredSells = recovered.filter(f => f.side === 'sell');

  console.log('=== Pseudo-fill twins removed ===');
  console.log(`  ${twins.length} duplicate row(s)`);
  for (const t of twins) {
    console.log(`  - ${t.side.toUpperCase()} ${t.orderId} ${t.tradeId} ${fmt(t.size, 8)} ${BASE}`
      + (t.moved.length ? ` → moved annotations onto the real fill: ${t.moved.join(', ')}` : ''));
  }

  console.log('\n=== Fills recovered from the exchange ===');
  console.log(`  ${recovered.length} fill(s): ${recoveredBuys.length} buys ${fmt(recoveredBuys.reduce((s, f) => s + f.size, 0), 6)} ${BASE} `
    + `($${fmt(recoveredBuys.reduce((s, f) => s + f.quoteAmount, 0), 2)}), `
    + `${recoveredSells.length} sells ${fmt(recoveredSells.reduce((s, f) => s + f.size, 0), 6)} ${BASE}`);
  console.log(`  cycleId inherited: ${inheritedFromOrder} from the same order, ${inheritedFromNeighbour} from the nearest fill in time`);

  console.log('\n=== Reconciliation ===');
  const exchangeNet = netAsset(exchangeFills);
  // Rows deliberately preserved in section 1 (DCA conversions, manual imports,
  // recovery fills) have no exchange fill behind them, so they must be excluded
  // before the repaired ledger is compared against the exchange — otherwise the
  // invariant can never hold on exactly the funds that carry them.
  const preserved = repaired.filter(f => !exchangeByTradeId.has(String(f.tradeId)));
  const preservedNet = netAsset(preserved);
  const repairedExchangeNet = netAsset(repaired) - preservedNet;
  console.log(`  ledger net ${BASE}:   ${fmt(netAsset(ledger))} → ${fmt(netAsset(repaired))}`);
  console.log(`  non-exchange rows: ${preserved.length} preserved, net ${fmt(preservedNet)} ${BASE} (excluded from the check below)`);
  console.log(`  exchange-backed:   ${fmt(repairedExchangeNet)} ${BASE}`);
  console.log(`  exchange net ${BASE}: ${fmt(exchangeNet)}`);
  console.log(`  ledger rows:       ${ledger.length} → ${repaired.length}`);
  console.log(`  realized bodyPnl (once per order):      $${beforePnl.total.toFixed(4)} (${beforePnl.count} sells) → $${afterPnl.total.toFixed(4)} (${afterPnl.count} sells)`);
  console.log(`  realized holdback (once per order):     ${beforeHold.total.toFixed(8)} ${BASE} → ${afterHold.total.toFixed(8)} ${BASE}`);

  let failed = false;
  const drift = Math.abs(repairedExchangeNet - exchangeNet);
  if (drift > 1e-6) {
    console.error(`\n❌ repaired ledger's exchange-backed rows still differ from the exchange by ${fmt(drift, 8)} ${BASE}`);
    failed = true;
  }
  if (Math.abs(beforePnl.total - afterPnl.total) > 0.01) {
    console.error(`\n❌ realized P&L moved by $${(afterPnl.total - beforePnl.total).toFixed(4)} — a repair must not change booked profit`);
    failed = true;
  }
  if (Math.abs(beforeHold.total - afterHold.total) > 1e-8) {
    console.error(`\n❌ realized asset holdback moved by ${(afterHold.total - beforeHold.total).toFixed(8)} ${BASE}`);
    failed = true;
  }
  if (afterPnl.count !== beforePnl.count) {
    console.error(`\n❌ sells carrying a bodyPnl annotation: ${beforePnl.count} → ${afterPnl.count} — an annotation was lost`);
    failed = true;
  }
  const duplicateIds = repaired.length - new Set(repaired.map(f => String(f.tradeId))).size;
  if (duplicateIds > 0) {
    console.error(`\n❌ ${duplicateIds} duplicate tradeId(s) in the repaired ledger`);
    failed = true;
  }
  if (failed) process.exit(1);

  console.log('\n✅ Validation passed: ledger matches the exchange, booked P&L unchanged.');

  if (!APPLY) {
    console.log('\n(Dry run — re-run with --apply to write.)');
    return;
  }

  await assertEngineStopped();

  const backupPath = `${LEDGER_PATH}.backup-backfill-${Date.now()}`;
  fs.copyFileSync(LEDGER_PATH, backupPath);
  console.log(`\nBackup: ${backupPath}`);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(repaired, null, 2));
  console.log(`Wrote ${repaired.length} fills to ${LEDGER_PATH}`);
  console.log('\nRestart the engine to pick up the repaired ledger.');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
