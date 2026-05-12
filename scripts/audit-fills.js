#!/usr/bin/env node
/**
 * Audit Coinbase fills against the local fill-ledger for a given pair.
 *
 * Pulls all fills for the pair from Coinbase since the engine's first
 * order, compares with the fill-ledger, and reports:
 *   - Fills on exchange missing from ledger
 *   - Fills in ledger missing from exchange (stale/phantom)
 *   - Aggregate buy/sell totals from each source
 *   - State delta vs actual exchange balance (catches orphan fills)
 *
 * Usage:
 *   node scripts/audit-fills.js              # defaults to BTC-USDC
 *   node scripts/audit-fills.js ETH-USDC
 */

const fs = require('fs');
const path = require('path');
const { getAuthHeaders } = require('../src/adapters/coinbase/auth');
const { resolveFundDataDir } = require('../src/migration');
const { DATA_DIR } = require('../src/paths');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');
const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// ── Parse pair argument ────────────────────────────────────────

const PAIR = (process.argv[2] || 'BTC-USDC').toUpperCase();
// Coinbase pairs use BASE-QUOTE (dash-separated): BTC-USDC, ETH-USDC, etc.
const [BASE_CURRENCY, QUOTE_CURRENCY] = PAIR.split('-');
if (!BASE_CURRENCY || !QUOTE_CURRENCY) {
  console.error(`Invalid pair: ${PAIR} — expected BASE-QUOTE (e.g. BTC-USDC)`);
  process.exit(1);
}

const API_URL = 'https://api.coinbase.com';
const fundDir = resolveFundDataDir('coinbase', PAIR);

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
    let apiPath = `/api/v3/brokerage/orders/historical/fills?product_id=${PAIR}&start_sequence_timestamp=${startISO}&limit=500`;
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

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const statePath = path.join(fundDir, 'regime-state.json');
  const ledgerPath = path.join(fundDir, 'fill-ledger.json');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const engineStart = state.position.engineStartTime;

  console.log(`\n🔍 Auditing Coinbase ${PAIR} fills since engine start: ${new Date(engineStart).toISOString()}`);
  console.log(`  Data dir: ${fundDir}`);
  console.log(`  Pair:     ${PAIR} (base=${BASE_CURRENCY}, quote=${QUOTE_CURRENCY})\n`);

  const rawFills = await fetchAllFills(engineStart);
  console.log(`\n📊 Total fills from exchange: ${rawFills.length}\n`);

  // Parse exchange fills into a Map keyed by trade_id.
  // Coinbase's market-buy-by-quote fills set size_in_quote=true and put the
  // quote-currency amount in `size`. Convert to base size by dividing by price
  // so all downstream math is consistent.
  const exchangeFills = new Map();
  for (const f of rawFills) {
    const price = parseFloat(f.price);
    const rawSize = parseFloat(f.size);
    const sizeInQuote = f.size_in_quote === true;
    const baseSize = sizeInQuote && price > 0 ? rawSize / price : rawSize;
    const quoteSize = sizeInQuote ? rawSize : price * rawSize;
    exchangeFills.set(f.trade_id, {
      tradeId: f.trade_id,
      orderId: f.order_id,
      side: f.side.toLowerCase(),
      price,
      size: baseSize,
      sizeInQuote: quoteSize,
      fee: parseFloat(f.commission || 0),
      tradeTime: f.trade_time,
    });
  }
  console.log(`Unique exchange fills: ${exchangeFills.size}\n`);

  // Build ledger lookups
  const ledgerMap = new Map();
  for (const f of ledger) ledgerMap.set(f.tradeId, f);

  // Diff: missing from ledger / missing from exchange.
  // Tolerate legacy "fill-<orderId>" prefix on some old ledger entries.
  const missingFromLedger = [];
  const missingFromExchange = [];

  for (const [tradeId, exFill] of exchangeFills) {
    if (!ledgerMap.has(tradeId) && !ledgerMap.has(`fill-${exFill.orderId}`)) {
      missingFromLedger.push(exFill);
    }
  }
  for (const [tradeId, lFill] of ledgerMap) {
    if (tradeId.startsWith('dca-convert-')) continue;
    const rawId = tradeId.startsWith('fill-') ? tradeId.slice(5) : tradeId;
    if (!exchangeFills.has(tradeId) && !exchangeFills.has(rawId)) {
      missingFromExchange.push(lFill);
    }
  }

  // Aggregate exchange totals
  let exBuyAsset = 0, exBuyQuote = 0, exBuyFees = 0;
  let exSellAsset = 0, exSellQuote = 0, exSellFees = 0;
  const exOrderMap = new Map();

  for (const f of exchangeFills.values()) {
    if (f.side === 'buy') {
      exBuyAsset += f.size; exBuyQuote += f.sizeInQuote; exBuyFees += f.fee;
    } else {
      exSellAsset += f.size; exSellQuote += f.sizeInQuote; exSellFees += f.fee;
    }
    if (!exOrderMap.has(f.orderId)) {
      exOrderMap.set(f.orderId, { side: f.side, fills: [], totalAsset: 0, totalQuote: 0, totalFee: 0 });
    }
    const o = exOrderMap.get(f.orderId);
    o.fills.push(f); o.totalAsset += f.size; o.totalQuote += f.sizeInQuote; o.totalFee += f.fee;
  }

  // Aggregate ledger totals
  let ldBuyAsset = 0, ldBuyQuote = 0, ldBuyFees = 0;
  let ldSellAsset = 0, ldSellQuote = 0, ldSellFees = 0;

  for (const f of ledger) {
    const quote = f.quoteAmount || (f.price * f.size);
    const fee = f.netFee || f.fee || 0;
    if (f.side === 'buy') {
      ldBuyAsset += f.size; ldBuyQuote += quote; ldBuyFees += fee;
    } else {
      ldSellAsset += f.size; ldSellQuote += quote; ldSellFees += fee;
    }
  }

  // ── Report ─────────────────────────────────────────────────

  const hr = '═══════════════════════════════════════════════════';

  console.log(hr);
  console.log(`  EXCHANGE TOTALS (Coinbase ${PAIR})`);
  console.log(hr);
  console.log(`  Buys:  ${roundAsset(exBuyAsset)} ${BASE_CURRENCY} | $${roundUSDC(exBuyQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(exBuyFees)}`);
  console.log(`  Sells: ${roundAsset(exSellAsset)} ${BASE_CURRENCY} | $${roundUSDC(exSellQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(exSellFees)}`);
  console.log(`  Net ${BASE_CURRENCY}: ${roundAsset(exBuyAsset - exSellAsset)}`);
  console.log(`  Net ${QUOTE_CURRENCY} (sells - buys - fees): $${roundUSDC(exSellQuote - exBuyQuote - exBuyFees - exSellFees)}`);

  console.log(`\n${hr}\n  LEDGER TOTALS (fill-ledger.json)\n${hr}`);
  console.log(`  Buys:  ${roundAsset(ldBuyAsset)} ${BASE_CURRENCY} | $${roundUSDC(ldBuyQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(ldBuyFees)}`);
  console.log(`  Sells: ${roundAsset(ldSellAsset)} ${BASE_CURRENCY} | $${roundUSDC(ldSellQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(ldSellFees)}`);
  console.log(`  Net ${BASE_CURRENCY}: ${roundAsset(ldBuyAsset - ldSellAsset)}`);
  console.log(`  Net ${QUOTE_CURRENCY} (sells - buys - fees): $${roundUSDC(ldSellQuote - ldBuyQuote - ldBuyFees - ldSellFees)}`);

  console.log(`\n${hr}\n  DELTAS (Exchange - Ledger)\n${hr}`);
  console.log(`  Buy ${BASE_CURRENCY}:  ${roundAsset(exBuyAsset - ldBuyAsset)}`);
  console.log(`  Buy ${QUOTE_CURRENCY}:  $${roundUSDC(exBuyQuote - ldBuyQuote)}`);
  console.log(`  Sell ${BASE_CURRENCY}: ${roundAsset(exSellAsset - ldSellAsset)}`);
  console.log(`  Sell ${QUOTE_CURRENCY}: $${roundUSDC(exSellQuote - ldSellQuote)}`);

  // Missing fills
  if (missingFromLedger.length > 0) {
    console.log(`\n${hr}\n  ⚠️  FILLS ON EXCHANGE MISSING FROM LEDGER (${missingFromLedger.length})\n${hr}`);
    const byOrder = new Map();
    for (const f of missingFromLedger) {
      if (!byOrder.has(f.orderId)) byOrder.set(f.orderId, []);
      byOrder.get(f.orderId).push(f);
    }
    for (const [orderId, fills] of byOrder) {
      const totalAsset = fills.reduce((s, f) => s + f.size, 0);
      const totalQuote = fills.reduce((s, f) => s + f.sizeInQuote, 0);
      const side = fills[0].side;
      const time = fills[0].tradeTime;
      console.log(`  ${side.toUpperCase()} ${orderId.slice(0, 8)}: ${roundAsset(totalAsset)} ${BASE_CURRENCY} @ ~$${totalAsset > 0 ? roundUSDC(totalQuote / totalAsset) : 0} ($${roundUSDC(totalQuote)}) [${time}] [${fills.length} fill(s)]`);
    }
  } else {
    console.log('\n✅ No fills missing from ledger');
  }

  if (missingFromExchange.length > 0) {
    console.log(`\n${hr}\n  ⚠️  FILLS IN LEDGER MISSING FROM EXCHANGE (${missingFromExchange.length})\n${hr}`);
    for (const f of missingFromExchange.slice(0, 20)) {
      console.log(`  ${f.side.toUpperCase()} ${f.orderId.slice(0, 8)}: ${f.size} ${BASE_CURRENCY} @ $${f.price} [tradeId=${(f.tradeId || '').slice(0, 12)}]`);
    }
    if (missingFromExchange.length > 20) {
      console.log(`  ... and ${missingFromExchange.length - 20} more`);
    }
  } else {
    console.log('✅ No phantom fills in ledger');
  }

  // Position state vs exchange reality
  console.log(`\n${hr}\n  POSITION STATE vs EXCHANGE REALITY\n${hr}`);
  console.log(`  Exchange net ${BASE_CURRENCY} (buys-sells): ${roundAsset(exBuyAsset - exSellAsset)}`);
  console.log(`  State totalAsset:              ${state.position.totalAsset}`);
  console.log(`  State realizedPnL:             $${state.position.realizedPnL}`);
  console.log(`  State realizedAssetPnL:        ${state.position.realizedAssetPnL}`);
  console.log(`  State cyclesCompleted:         ${state.position.cyclesCompleted}`);
  console.log(`  State cycleBuys:               ${state.position.cycleBuys}`);

  // Live balance check (best-effort — adapter call may fail if keys lack permissions)
  try {
    const adapter = createCoinbaseAdapter();
    const assetBalance = await adapter.getAccountBalance(BASE_CURRENCY);
    const quoteBalance = await adapter.getAccountBalance(QUOTE_CURRENCY);
    console.log(`\n  Exchange ${BASE_CURRENCY} balance: ${assetBalance.total} (available: ${assetBalance.available}, hold: ${assetBalance.hold})`);
    console.log(`  Exchange ${QUOTE_CURRENCY} balance: ${quoteBalance.total} (available: ${quoteBalance.available}, hold: ${quoteBalance.hold})`);
    const trackedAsset = state.position.totalAsset + (state.position.realizedAssetPnL || 0);
    console.log(`  Tracked ${BASE_CURRENCY} vs exchange: tracked=${roundAsset(trackedAsset)} (bodies+reserves), delta=${roundAsset(trackedAsset - assetBalance.total)}`);
  } catch (e) {
    console.log(`  (Could not fetch balance: ${e.message})`);
  }

  console.log('\n✅ Audit complete\n');
}

main().catch(err => {
  console.error('❌ Audit failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
