#!/usr/bin/env node
/**
 * Audit Coinbase fills against the local fill-ledger.
 *
 * Pulls all BTC-USDC fills from Coinbase since the engine's first order,
 * compares with the fill-ledger, and reports:
 *   - Fills on exchange missing from ledger
 *   - Fills in ledger missing from exchange (stale/phantom)
 *   - Aggregate buy/sell totals from each source
 *   - Per-sell order P&L using actual cost basis from linked buys
 *
 * Usage:  node scripts/audit-fills.js
 */

const fs = require('fs');
const path = require('path');

const { roundAsset: roundBTC, roundUSDC } = require('../src/volatility-utils');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { DATA_DIR } = require('../src/paths');

const API_URL = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-USDC';

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

// ── Fetch ALL fills with pagination ────────────────────────────

const fetchAllFills = async (startTimestamp) => {
  const allFills = [];
  let cursor = null;
  let page = 0;

  const startISO = new Date(startTimestamp).toISOString();

  do {
    page++;
    let apiPath = `/api/v3/brokerage/orders/historical/fills?product_id=${PRODUCT_ID}&start_sequence_timestamp=${startISO}&limit=500`;
    if (cursor) apiPath += `&cursor=${cursor}`;

    process.stdout.write(`📡 Fetching fills page ${page}${cursor ? ' (cursor)' : ''}...`);
    const data = await makeRequest('GET', apiPath);
    const fills = data.fills || [];
    allFills.push(...fills);
    cursor = data.cursor || null;
    console.log(` ${fills.length} fills`);
  } while (cursor);

  return allFills;
};

// ── Load local fill-ledger ─────────────────────────────────────

const loadLedger = () => {
  const ledgerPath = path.join(DATA_DIR, 'coinbase/fill-ledger.json');
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
};

// ── Main ───────────────────────────────────────────────────────

async function main() {
  // Engine start timestamp from regime-state
  const statePath = path.join(DATA_DIR, 'coinbase/regime-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const engineStart = state.position.engineStartTime;

  console.log(`\n🔍 Auditing Coinbase fills since engine start: ${new Date(engineStart).toISOString()}\n`);

  // 1. Fetch exchange fills
  const rawFills = await fetchAllFills(engineStart);
  console.log(`\n📊 Total fills from exchange: ${rawFills.length}\n`);

  // Manual order IDs to exclude (large manual trades that predate or are outside the system)
  const MANUAL_ORDER_IDS = new Set([
    'b9f57446', 'c01cd924', 'd2147728', 'ccbca736', '1d90f021', // 1+ BTC manual buys/sells
  ]);
  const isManualOrder = (orderId) => {
    for (const prefix of MANUAL_ORDER_IDS) {
      if (orderId.startsWith(prefix)) return true;
    }
    return false;
  };

  // Parse exchange fills into a Map keyed by trade_id
  const exchangeFills = new Map();
  let manualSkipped = 0;
  for (const f of rawFills) {
    if (isManualOrder(f.order_id)) { manualSkipped++; continue; }
    const price = parseFloat(f.price);
    const size = parseFloat(f.size);
    exchangeFills.set(f.trade_id, {
      tradeId: f.trade_id,
      orderId: f.order_id,
      side: f.side.toLowerCase(),
      price,
      size,
      sizeInQuote: price * size, // compute since API doesn't return it
      fee: parseFloat(f.commission || 0),
      tradeTime: f.trade_time,
      liquidityIndicator: f.liquidity_indicator,
    });
  }
  console.log(`(Excluded ${manualSkipped} fills from ${MANUAL_ORDER_IDS.size} manual orders)\n`);

  // 2. Load local ledger
  const ledger = loadLedger();
  const ledgerMap = new Map();
  for (const f of ledger) {
    ledgerMap.set(f.tradeId, f);
  }

  // 3. Diff
  const missingFromLedger = [];
  const missingFromExchange = [];

  for (const [tradeId, exFill] of exchangeFills) {
    if (!ledgerMap.has(tradeId) && !ledgerMap.has(`fill-${exFill.orderId}`)) {
      missingFromLedger.push(exFill);
    }
  }

  for (const [tradeId, lFill] of ledgerMap) {
    // Ledger tradeIds may be prefixed with "fill-" for older entries
    const rawId = tradeId.startsWith('fill-') ? tradeId.slice(5) : tradeId;
    if (!exchangeFills.has(tradeId) && !exchangeFills.has(rawId)) {
      missingFromExchange.push(lFill);
    }
  }

  // 4. Aggregate exchange totals
  let exBuyBtc = 0, exBuyUsdc = 0, exBuyFees = 0;
  let exSellBtc = 0, exSellUsdc = 0, exSellFees = 0;
  const exOrderMap = new Map(); // orderId → { side, fills[], totalBtc, totalUsdc }

  for (const f of exchangeFills.values()) {
    if (f.side === 'buy') {
      exBuyBtc += f.size;
      exBuyUsdc += f.sizeInQuote;
      exBuyFees += f.fee;
    } else {
      exSellBtc += f.size;
      exSellUsdc += f.sizeInQuote;
      exSellFees += f.fee;
    }

    if (!exOrderMap.has(f.orderId)) {
      exOrderMap.set(f.orderId, { side: f.side, fills: [], totalBtc: 0, totalUsdc: 0, totalFee: 0 });
    }
    const o = exOrderMap.get(f.orderId);
    o.fills.push(f);
    o.totalBtc += f.size;
    o.totalUsdc += f.sizeInQuote;
    o.totalFee += f.fee;
  }

  // 5. Aggregate ledger totals
  let ldBuyBtc = 0, ldBuyUsdc = 0, ldBuyFees = 0;
  let ldSellBtc = 0, ldSellUsdc = 0, ldSellFees = 0;

  for (const f of ledger) {
    const usdc = f.quoteAmount || (f.price * f.size);
    const fee = f.netFee || f.fee || 0;
    if (f.side === 'buy') {
      ldBuyBtc += f.size;
      ldBuyUsdc += usdc;
      ldBuyFees += fee;
    } else {
      ldSellBtc += f.size;
      ldSellUsdc += usdc;
      ldSellFees += fee;
    }
  }

  // ── Report ─────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════');
  console.log('  EXCHANGE TOTALS (Coinbase)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Buys:  ${roundBTC(exBuyBtc)} BTC | $${roundUSDC(exBuyUsdc)} USDC | fees $${roundUSDC(exBuyFees)}`);
  console.log(`  Sells: ${roundBTC(exSellBtc)} BTC | $${roundUSDC(exSellUsdc)} USDC | fees $${roundUSDC(exSellFees)}`);
  console.log(`  Net BTC: ${roundBTC(exBuyBtc - exSellBtc)}`);
  console.log(`  Net USDC (sells - buys - fees): $${roundUSDC(exSellUsdc - exBuyUsdc - exBuyFees - exSellFees)}`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  LEDGER TOTALS (fill-ledger.json)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Buys:  ${roundBTC(ldBuyBtc)} BTC | $${roundUSDC(ldBuyUsdc)} USDC | fees $${roundUSDC(ldBuyFees)}`);
  console.log(`  Sells: ${roundBTC(ldSellBtc)} BTC | $${roundUSDC(ldSellUsdc)} USDC | fees $${roundUSDC(ldSellFees)}`);
  console.log(`  Net BTC: ${roundBTC(ldBuyBtc - ldSellBtc)}`);
  console.log(`  Net USDC (sells - buys - fees): $${roundUSDC(ldSellUsdc - ldBuyUsdc - ldBuyFees - ldSellFees)}`);

  // ── Deltas ────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DELTAS (Exchange - Ledger)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Buy BTC:  ${roundBTC(exBuyBtc - ldBuyBtc)}`);
  console.log(`  Buy USDC: $${roundUSDC(exBuyUsdc - ldBuyUsdc)}`);
  console.log(`  Sell BTC: ${roundBTC(exSellBtc - ldSellBtc)}`);
  console.log(`  Sell USDC: $${roundUSDC(exSellUsdc - ldSellUsdc)}`);

  // ── Missing fills ─────────────────────────────────────────

  if (missingFromLedger.length > 0) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  ⚠️  FILLS ON EXCHANGE MISSING FROM LEDGER (${missingFromLedger.length})`);
    console.log('═══════════════════════════════════════════════════');
    // Group by orderId
    const byOrder = new Map();
    for (const f of missingFromLedger) {
      if (!byOrder.has(f.orderId)) byOrder.set(f.orderId, []);
      byOrder.get(f.orderId).push(f);
    }
    for (const [orderId, fills] of byOrder) {
      const totalBtc = fills.reduce((s, f) => s + f.size, 0);
      const totalUsdc = fills.reduce((s, f) => s + f.sizeInQuote, 0);
      const side = fills[0].side;
      const time = fills[0].tradeTime;
      console.log(`  ${side.toUpperCase()} ${orderId.slice(0, 8)}: ${roundBTC(totalBtc)} BTC @ ~$${totalBtc > 0 ? roundUSDC(totalUsdc / totalBtc) : 0} ($${roundUSDC(totalUsdc)}) [${time}] [${fills.length} fill(s)]`);
    }
  } else {
    console.log('\n✅ No fills missing from ledger');
  }

  if (missingFromExchange.length > 0) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  ⚠️  FILLS IN LEDGER MISSING FROM EXCHANGE (${missingFromExchange.length})`);
    console.log('═══════════════════════════════════════════════════');
    for (const f of missingFromExchange.slice(0, 20)) {
      console.log(`  ${f.side.toUpperCase()} ${f.orderId.slice(0, 8)}: ${f.size} BTC @ $${f.price} [tradeId=${f.tradeId.slice(0, 12)}]`);
    }
    if (missingFromExchange.length > 20) {
      console.log(`  ... and ${missingFromExchange.length - 20} more`);
    }
  } else {
    console.log('✅ No phantom fills in ledger');
  }

  // ── Sell order summary ────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SELL ORDERS (Exchange)');
  console.log('═══════════════════════════════════════════════════');
  const sellOrders = [...exOrderMap.entries()]
    .filter(([, o]) => o.side === 'sell')
    .sort((a, b) => new Date(a[1].fills[0].tradeTime) - new Date(b[1].fills[0].tradeTime));

  for (const [orderId, o] of sellOrders) {
    const avgPrice = o.totalBtc > 0 ? o.totalUsdc / o.totalBtc : 0;
    const time = o.fills[0].tradeTime;
    // Check if in ledger
    const inLedger = ledger.some(f => f.orderId === orderId && f.side === 'sell');
    const ledgerMark = inLedger ? '✅' : '❌';
    console.log(`  ${ledgerMark} ${orderId.slice(0, 8)}: ${roundBTC(o.totalBtc)} BTC @ $${roundUSDC(avgPrice)} = $${roundUSDC(o.totalUsdc)} (fees $${roundUSDC(o.totalFee)}) [${time}]`);
  }

  // ── ec8b7bcb annotation check ─────────────────────────────

  const ec8bAnnotated = ledger.filter(f => f.sellOrderId === 'ec8b7bcb-325a-4bad-a38e-3f76762e3494');
  if (ec8bAnnotated.length > 0) {
    console.log(`\n⚠️  ${ec8bAnnotated.length} fills still incorrectly annotated with sellOrderId=ec8b7bcb (needs cleanup)`);
  }

  // ── cycle-12 check ────────────────────────────────────────

  const cycle12Fills = ledger.filter(f => f.cycleId === 'cycle-12');
  if (cycle12Fills.length > 0) {
    console.log(`⚠️  ${cycle12Fills.length} fills with cycleId=cycle-12 (should be cycle-11)`);
  }

  // ── Current position state vs exchange ────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  POSITION STATE vs EXCHANGE REALITY');
  console.log('═══════════════════════════════════════════════════');
  const netBtcExchange = roundBTC(exBuyBtc - exSellBtc);
  const netBtcState = state.position.totalBTC;
  console.log(`  Exchange net BTC held: ${netBtcExchange}`);
  console.log(`  State totalBTC:        ${netBtcState}`);
  console.log(`  Delta:                 ${roundBTC(netBtcExchange - netBtcState)}`);

  console.log(`\n  Config maxUsdcDeployed: $${JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).exchanges.coinbase.regime.maxUsdcDeployed}`);
  console.log(`  State realizedPnL:     $${state.position.realizedPnL}`);
  console.log(`  State realizedBtcPnL:  ${state.position.realizedBtcPnL}`);
  console.log(`  State cyclesCompleted: ${state.position.cyclesCompleted}`);
  console.log(`  State cycleBuys:       ${state.position.cycleBuys}`);

  console.log('\n✅ Audit complete\n');
}

main().catch(err => {
  console.error('❌ Audit failed:', err.message);
  process.exit(1);
});
