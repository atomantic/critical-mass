#!/usr/bin/env node
/**
 * Reconcile cryptocom/CRO_USD against exchange truth.
 *
 * The fill ledger has accumulated three sources of drift:
 *   (a) WS dropouts left 418 exchange fills un-ingested (sells dominate, in
 *       particular 102 partial-fills of the black_hole TP 6142909974300226432
 *       on 2026-05-10 which sold ~$32K of CRO outside our visibility).
 *   (b) DCA→regime migration emitted 26 synthetic `dca-convert-*` buy fills
 *       to seed position state — but the real underlying exchange fills are
 *       also present, so these double-count ~68k CRO of buys.
 *   (c) Body consolidation rolled holdback CRO into `body.assetQty` without
 *       matching buy fills, inflating reported position.
 *
 * Fix: rebuild fill-ledger from exchange truth (all real fills, 0 synthetic),
 *      drain the black_hole body (its TP filled fully), recompute remaining
 *      bodies' qty/cost from the corrected ledger, clear closed-trades so the
 *      engine derives realizedPnL via FIFO replay.
 *
 * Inputs (run scripts/fetch-cryptocom-trades.js first):
 *   data/cryptocom/CRO_USD/exchange-trades.json
 *
 * Engine MUST be stopped: pm2 stop critical-mass-cryptocom
 *
 * Usage:
 *   node scripts/cryptocom-rectify-from-exchange.js           # dry-run
 *   node scripts/cryptocom-rectify-from-exchange.js --apply   # writes
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD');
const LEDGER_PATH = path.join(DIR, 'fill-ledger.json');
const STATE_PATH = path.join(DIR, 'regime-state.json');
const CLOSED_PATH = path.join(DIR, 'closed-trades.json');
const EXCHANGE_PATH = path.join(DIR, 'exchange-trades.json');
const APPLY = process.argv.includes('--apply');

const DUST_THRESHOLD = 100; // CRO

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const round2 = (n) => Math.round(n * 100) / 100;

const backup = (p) => {
  const bp = `${p}.backup-rectify-${Date.now()}`;
  fs.copyFileSync(p, bp);
  console.log(`💾 Backup: ${path.basename(bp)}`);
};

// ── Load inputs ─────────────────────────────────────────────────────────────
const oldLedger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
const exchange = JSON.parse(fs.readFileSync(EXCHANGE_PATH, 'utf8'));

console.log('Loaded:');
console.log(`  exchange trades:    ${exchange.length}`);
console.log(`  old ledger fills:   ${oldLedger.length}`);
console.log(`  closed trades:      ${closed.length}`);
console.log(`  active bodies:      ${state.position.celestialBodies?.length || 0}`);
console.log();

// ── Build annotation maps from old ledger (preserve metadata where matched) ─
const oldByTradeId = new Map();   // tradeId → fill
for (const f of oldLedger) oldByTradeId.set(String(f.tradeId), f);

// buy orderId → bodyId (and sibling sellOrderId), from existing annotations
const buyOidToBody = new Map();
const buyOidToSellOid = new Map();
for (const f of oldLedger) {
  if (f.side === 'buy' && f.bodyId) buyOidToBody.set(String(f.orderId), f.bodyId);
  if (f.side === 'buy' && f.sellOrderId) buyOidToSellOid.set(String(f.orderId), String(f.sellOrderId));
}

// sell orderId → bodyId, from existing annotations + closed-trades + body tps
const sellOidToBody = new Map();
for (const f of oldLedger) {
  if (f.side === 'sell' && f.bodyId) sellOidToBody.set(String(f.orderId), f.bodyId);
}
for (const t of closed) {
  if (t.bodyId && t.sellOrderId) sellOidToBody.set(String(t.sellOrderId), t.bodyId);
}
for (const b of state.position.celestialBodies || []) {
  if (b.tpOrderId) sellOidToBody.set(String(b.tpOrderId), b.id);
}
// Historic black_hole TP (state cleared it after the partial fills it observed;
// state.json.backup-fifo-* preserves it as the body's previous TP).
sellOidToBody.set('6142909974300226432', 'body-85084389-mmtxp76q');

// Also derive bodyId from buy→sell linkage: if buy has bodyId+sellOrderId, that sell
// belongs to the same body.
for (const f of oldLedger) {
  if (f.side === 'buy' && f.bodyId && f.sellOrderId) {
    sellOidToBody.set(String(f.sellOrderId), f.bodyId);
  }
}

console.log(`Annotation maps: ${buyOidToBody.size} buy oids → bodyId, ${sellOidToBody.size} sell oids → bodyId\n`);

// ── Transform exchange trades into ledger format ────────────────────────────
const newLedger = [];
for (const t of exchange) {
  const tid = String(t.trade_id);
  const orderId = String(t.order_id);
  const side = t.side.toLowerCase();
  const price = Number(t.traded_price);
  const size = Number(t.traded_quantity);
  const fee = Number(t.fees) || 0;
  const timestamp = Number(t.create_time);

  const fill = {
    tradeId: tid,
    orderId,
    side,
    price,
    size,
    quoteAmount: round8(price * size),
    fee,
    feeAsset: t.fee_instrument_name || 'USDC',
    rebate: 0,
    netFee: fee,
    liquidityIndicator: t.taker_side === 'MAKER' ? 'MAKER' : 'TAKER',
    timestamp,
    ingestedAt: Date.now(),
    cycleId: null, // recalculateCycles will reassign on engine startup
    orderPlacedAt: null,
    fillTimeMs: null,
  };

  // Carry forward old annotations when the same tradeId existed (preserves
  // orderPlacedAt, fillTimeMs, ingestedAt where the engine had them).
  const prior = oldByTradeId.get(tid);
  if (prior) {
    if (prior.orderPlacedAt) fill.orderPlacedAt = prior.orderPlacedAt;
    if (prior.fillTimeMs != null) fill.fillTimeMs = prior.fillTimeMs;
    if (prior.ingestedAt) fill.ingestedAt = prior.ingestedAt;
    if (prior.isBodyOwned) fill.isBodyOwned = prior.isBodyOwned;
    if (prior.bodyId) fill.bodyId = prior.bodyId;
    if (prior.bodyTier) fill.bodyTier = prior.bodyTier;
    if (prior.sellOrderId) fill.sellOrderId = prior.sellOrderId;
    if (prior.cycleId) fill.cycleId = prior.cycleId;
    if (prior.bodyCostBasis != null) fill.bodyCostBasis = prior.bodyCostBasis;
    if (prior.bodyAvgPrice != null) fill.bodyAvgPrice = prior.bodyAvgPrice;
    if (prior.bodyBtcQty != null) fill.bodyBtcQty = prior.bodyBtcQty;
    if (prior.bodyHoldbackAsset != null) fill.bodyHoldbackAsset = prior.bodyHoldbackAsset;
    if (prior.bodyPnl != null) fill.bodyPnl = prior.bodyPnl;
  }

  // Fill in annotations for fresh entries by looking up via maps
  if (!fill.bodyId) {
    const bid = side === 'buy' ? buyOidToBody.get(orderId) : sellOidToBody.get(orderId);
    if (bid) {
      fill.isBodyOwned = true;
      fill.bodyId = bid;
    }
    if (side === 'buy') {
      const sid = buyOidToSellOid.get(orderId);
      if (sid) fill.sellOrderId = sid;
    }
  }

  newLedger.push(fill);
}

newLedger.sort((a, b) => a.timestamp - b.timestamp);

// ── FIFO realized over the corrected ledger ─────────────────────────────────
const computeFifo = (fills) => {
  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  let realizedPnL = 0;
  const lots = [];
  for (const f of sorted) {
    const cost = (f.quoteAmount || 0) + (f.netFee || 0);
    if (f.side === 'buy') {
      lots.push({ qty: f.size, unitCost: f.size > 0 ? cost / f.size : 0 });
    } else if (f.side === 'sell') {
      const proceeds = (f.quoteAmount || 0) - (f.netFee || 0);
      let remain = f.size;
      let cb = 0;
      while (remain > 1e-12 && lots.length > 0) {
        const lot = lots[0];
        const use = Math.min(remain, lot.qty);
        cb += use * lot.unitCost;
        lot.qty -= use;
        remain -= use;
        if (lot.qty <= 1e-12) lots.shift();
      }
      realizedPnL += proceeds - cb;
    }
  }
  return {
    realizedPnL: round2(realizedPnL),
    remainingAssetQty: round8(lots.reduce((s, l) => s + l.qty, 0)),
  };
};
const fifo = computeFifo(newLedger);

// ── Recompute body asset quantities from corrected ledger ───────────────────
const bodies = state.position.celestialBodies || [];
const updatedBodies = [];
const drainedBodies = [];

for (const body of bodies) {
  const sourceOrderIds = new Set([
    ...(body.sourceOrderIds || []).map(String),
    ...((body.buyOrders || []).map(b => String(b.orderId))),
  ]);
  const bodyBuys = newLedger.filter(f => f.side === 'buy' && (f.bodyId === body.id || sourceOrderIds.has(String(f.orderId))));
  // For sells, match by bodyId OR by orderId == body.tpOrderId OR == historical TP
  const bodySells = newLedger.filter(f =>
    f.side === 'sell' && (
      f.bodyId === body.id ||
      (body.tpOrderId && String(f.orderId) === String(body.tpOrderId)) ||
      (body.id === 'body-85084389-mmtxp76q' && String(f.orderId) === '6142909974300226432')
    )
  );
  const buyQty = bodyBuys.reduce((s, f) => s + f.size, 0);
  const sellQty = bodySells.reduce((s, f) => s + f.size, 0);
  // Clamp negative qty to 0 — over-sell against this body just means the TP
  // consumed asset from prior cycle reserves (FIFO will allocate cost correctly).
  const newQty = Math.max(0, round8(buyQty - sellQty));

  console.log(`body ${body.id.slice(-12)} ${body.tier}: was ${body.assetQty.toFixed(2)} → ${newQty.toFixed(2)} CRO (buys ${buyQty.toFixed(0)} − sells ${sellQty.toFixed(0)}) → ${newQty < DUST_THRESHOLD ? 'DRAIN' : 'keep'}`);

  if (newQty < DUST_THRESHOLD) {
    drainedBodies.push(body);
    continue;
  }

  // Recompute costBasis from remaining FIFO lots within the body
  const lots = bodyBuys.sort((a,b)=>a.timestamp-b.timestamp)
    .map(f => ({ qty: f.size, cost: (f.quoteAmount || 0) + (f.netFee || 0) }));
  let remainSell = sellQty;
  for (const lot of lots) {
    if (remainSell <= 0) break;
    const use = Math.min(remainSell, lot.qty);
    const ratio = lot.qty > 0 ? use / lot.qty : 0;
    lot.cost -= lot.cost * ratio;
    lot.qty -= use;
    remainSell -= use;
  }
  const remainingCost = lots.reduce((s,l)=>s+l.cost,0);
  const remainingQty = lots.reduce((s,l)=>s+l.qty,0);
  const avgPrice = remainingQty > 0 ? remainingCost / remainingQty : 0;

  updatedBodies.push({
    ...body,
    assetQty: round8(remainingQty),
    costBasis: round2(remainingCost),
    avgPrice: round8(avgPrice),
  });
}

const newTotalAsset = round8(updatedBodies.reduce((s,b)=>s+b.assetQty, 0));
const newTotalCostBasis = round2(updatedBodies.reduce((s,b)=>s+b.costBasis, 0));
const newAvgCostBasis = newTotalAsset > 0 ? round8(newTotalCostBasis / newTotalAsset) : 0;
const newAssetOnOrder = updatedBodies.reduce((s,b)=>s+(b.assetOnOrder||0),0);
const newRealizedAssetPnL = round8(Math.max(0, fifo.remainingAssetQty - newTotalAsset));

console.log(`\n=== Ledger ===`);
console.log(`  fills: ${oldLedger.length} → ${newLedger.length} (drops 26 dca-convert + 1 dry-run + 1 consolidated synthetics; adds 418 missing exchange fills)`);
console.log(`  ledger net qty: ${(oldLedger.filter(f=>f.side==='buy').reduce((s,f)=>s+f.size,0) - oldLedger.filter(f=>f.side==='sell').reduce((s,f)=>s+f.size,0)).toFixed(2)} → ${(newLedger.filter(f=>f.side==='buy').reduce((s,f)=>s+f.size,0) - newLedger.filter(f=>f.side==='sell').reduce((s,f)=>s+f.size,0)).toFixed(2)} CRO`);

console.log(`\n=== Position state ===`);
console.log(`  totalAsset:       ${state.position.totalAsset.toFixed(2)} → ${newTotalAsset.toFixed(2)} CRO`);
console.log(`  totalCostBasis:   $${state.position.totalCostBasis.toFixed(2)} → $${newTotalCostBasis.toFixed(2)}`);
console.log(`  avgCostBasis:     $${state.position.avgCostBasis.toFixed(6)} → $${newAvgCostBasis.toFixed(6)}`);
console.log(`  realizedPnL:      $${state.position.realizedPnL.toFixed(2)} → $${fifo.realizedPnL.toFixed(2)}`);
console.log(`  realizedAssetPnL: ${state.position.realizedAssetPnL.toFixed(2)} → ${newRealizedAssetPnL.toFixed(2)} CRO`);
console.log(`  active bodies:    ${bodies.length} → ${updatedBodies.length}`);
console.log(`  drained bodies:   ${drainedBodies.map(b=>b.id.slice(-12)).join(', ') || '(none)'}`);

console.log(`\n=== Reality check vs exchange ===`);
console.log(`  exchange total CRO: 38,383.73 (30,760.73 free + 7,623 on orders)`);
console.log(`  reconciled state:   ${newTotalAsset.toFixed(2)} bodies + ${newRealizedAssetPnL.toFixed(2)} reserves = ${(newTotalAsset + newRealizedAssetPnL).toFixed(2)} CRO`);

if (!APPLY) {
  console.log(`\nDry-run — pass --apply to write.`);
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
console.log(`\n📝 Applying...`);
backup(LEDGER_PATH);
backup(STATE_PATH);
backup(CLOSED_PATH);

fs.writeFileSync(LEDGER_PATH, JSON.stringify(newLedger, null, 2));
console.log(`✅ Wrote ${newLedger.length} fills to ${path.basename(LEDGER_PATH)}`);

fs.writeFileSync(CLOSED_PATH, '[]');
console.log(`✅ Cleared ${path.basename(CLOSED_PATH)} (FIFO will drive realizedPnL)`);

state.position.celestialBodies = updatedBodies;
state.position.totalAsset = newTotalAsset;
state.position.totalCostBasis = newTotalCostBasis;
state.position.avgCostBasis = newAvgCostBasis;
state.position.assetOnOrder = newAssetOnOrder;
state.position.realizedPnL = fifo.realizedPnL;
state.position.realizedAssetPnL = newRealizedAssetPnL;
if (state.position.celestialState) {
  state.position.celestialState.bodiesRealizedPnL = fifo.realizedPnL;
  state.position.celestialState.bodiesRealizedAssetPnL = newRealizedAssetPnL;
  state.position.celestialState.totalBodiesCompleted =
    (state.position.celestialState.totalBodiesCompleted || 0) + drainedBodies.length;
  state.position.celestialState.totalBodiesActive = updatedBodies.length;
}
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log(`✅ Updated ${path.basename(STATE_PATH)}`);

console.log(`\nDone. Restart engine: pm2 restart critical-mass-cryptocom`);
