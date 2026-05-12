#!/usr/bin/env node
/**
 * Audit Gemini fills against the local fill-ledger for a given pair.
 *
 * Pulls all trades for the pair from Gemini since the engine's first order,
 * compares with the fill-ledger, and reports:
 *   - Fills on exchange missing from ledger
 *   - Fills in ledger missing from exchange (stale/phantom)
 *   - Aggregate buy/sell totals from each source
 *   - State delta vs actual exchange balance (catches orphan fills)
 *
 * Usage:
 *   node scripts/audit-gemini-fills.js              # defaults to BTCUSD
 *   node scripts/audit-gemini-fills.js ETHUSD
 */

const fs = require('fs');
const path = require('path');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { resolveFundDataDir } = require('../src/migration');
const { getBaseCurrency, getQuoteCurrency } = require('../src/config-utils');

const { roundAsset, roundUSDC } = require('../src/volatility-utils');

const PAIR = (process.argv[2] || 'BTCUSD').toUpperCase();
const SYMBOL = PAIR.toLowerCase();
const BASE_CURRENCY = getBaseCurrency(PAIR);
const QUOTE_CURRENCY = getQuoteCurrency(PAIR);

const adapter = createGeminiAdapter();

// ── Load local fill-ledger ─────────────────────────────────────

const fundDir = resolveFundDataDir('gemini', PAIR);

const loadLedger = () => {
  const ledgerPath = path.join(fundDir, 'fill-ledger.json');
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
};

// ── Main ───────────────────────────────────────────────────────

async function main() {
  // Engine start timestamp from regime-state
  const statePath = path.join(fundDir, 'regime-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const engineStart = state.position.engineStartTime;

  console.log(`\nAuditing Gemini ${PAIR} fills since engine start: ${new Date(engineStart).toISOString()}\n`);
  console.log(`  Data dir: ${fundDir}`);
  console.log(`  Symbol:   ${SYMBOL} (base=${BASE_CURRENCY}, quote=${QUOTE_CURRENCY})\n`);

  // 1. Fetch exchange trades
  const rawTrades = await adapter.getAllTrades(SYMBOL, engineStart);
  console.log(`\nTotal trades from exchange: ${rawTrades.length}\n`);

  // Deduplicate by tid (trade ID)
  const exchangeFills = new Map();
  for (const t of rawTrades) {
    const tid = (t.tid || '').toString();
    if (exchangeFills.has(tid)) continue;

    const price = parseFloat(t.price || 0);
    const amount = parseFloat(t.amount || 0);
    const feeAmount = parseFloat(t.fee_amount || 0);

    exchangeFills.set(tid, {
      tradeId: tid,
      orderId: (t.order_id || '').toString(),
      side: (t.type || '').toLowerCase(),
      price,
      size: amount,
      quoteAmount: price * amount,
      fee: feeAmount,
      feeCurrency: t.fee_currency,
      timestamp: t.timestampms || (t.timestamp * 1000),
      isMaker: t.is_maker || false,
    });
  }

  console.log(`Unique exchange fills: ${exchangeFills.size}\n`);

  // 2. Load local ledger
  const ledger = loadLedger();
  const ledgerMap = new Map();
  for (const f of ledger) {
    ledgerMap.set(f.tradeId, f);
  }

  // Also build a ledger map by orderId for cross-reference
  const ledgerByOrder = new Map();
  for (const f of ledger) {
    if (!ledgerByOrder.has(f.orderId)) ledgerByOrder.set(f.orderId, []);
    ledgerByOrder.get(f.orderId).push(f);
  }

  // 3. Diff
  const missingFromLedger = [];
  const missingFromExchange = [];

  for (const [tid, exFill] of exchangeFills) {
    if (!ledgerMap.has(tid)) {
      missingFromLedger.push(exFill);
    }
  }

  for (const [tradeId, lFill] of ledgerMap) {
    // Skip consolidated/synthetic fills - these won't exist on exchange
    if (tradeId.startsWith('dca-convert-')) continue;
    if (!exchangeFills.has(tradeId)) {
      missingFromExchange.push(lFill);
    }
  }

  // 4. Aggregate exchange totals
  let exBuyAsset = 0, exBuyQuote = 0, exBuyFees = 0;
  let exSellAsset = 0, exSellQuote = 0, exSellFees = 0;
  const exOrderMap = new Map();

  for (const f of exchangeFills.values()) {
    if (f.side === 'buy') {
      exBuyAsset += f.size;
      exBuyQuote += f.quoteAmount;
      exBuyFees += f.fee;
    } else {
      exSellAsset += f.size;
      exSellQuote += f.quoteAmount;
      exSellFees += f.fee;
    }

    if (!exOrderMap.has(f.orderId)) {
      exOrderMap.set(f.orderId, { side: f.side, fills: [], totalAsset: 0, totalQuote: 0, totalFee: 0 });
    }
    const o = exOrderMap.get(f.orderId);
    o.fills.push(f);
    o.totalAsset += f.size;
    o.totalQuote += f.quoteAmount;
    o.totalFee += f.fee;
  }

  // 5. Aggregate ledger totals
  let ldBuyAsset = 0, ldBuyQuote = 0, ldBuyFees = 0;
  let ldSellAsset = 0, ldSellQuote = 0, ldSellFees = 0;

  for (const f of ledger) {
    const quote = f.quoteAmount || (f.price * f.size);
    const fee = f.netFee || f.fee || 0;
    if (f.side === 'buy') {
      ldBuyAsset += f.size;
      ldBuyQuote += quote;
      ldBuyFees += fee;
    } else {
      ldSellAsset += f.size;
      ldSellQuote += quote;
      ldSellFees += fee;
    }
  }

  // ── Report ─────────────────────────────────────────────────

  console.log('='.repeat(55));
  console.log(`  EXCHANGE TOTALS (Gemini ${PAIR})`);
  console.log('='.repeat(55));
  console.log(`  Buys:  ${roundAsset(exBuyAsset)} ${BASE_CURRENCY} | $${roundUSDC(exBuyQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(exBuyFees)}`);
  console.log(`  Sells: ${roundAsset(exSellAsset)} ${BASE_CURRENCY} | $${roundUSDC(exSellQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(exSellFees)}`);
  console.log(`  Net ${BASE_CURRENCY}: ${roundAsset(exBuyAsset - exSellAsset)}`);
  console.log(`  Net ${QUOTE_CURRENCY} (sells - buys - fees): $${roundUSDC(exSellQuote - exBuyQuote - exBuyFees - exSellFees)}`);

  console.log('\n' + '='.repeat(55));
  console.log('  LEDGER TOTALS (fill-ledger.json)');
  console.log('='.repeat(55));
  console.log(`  Buys:  ${roundAsset(ldBuyAsset)} ${BASE_CURRENCY} | $${roundUSDC(ldBuyQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(ldBuyFees)}`);
  console.log(`  Sells: ${roundAsset(ldSellAsset)} ${BASE_CURRENCY} | $${roundUSDC(ldSellQuote)} ${QUOTE_CURRENCY} | fees $${roundUSDC(ldSellFees)}`);
  console.log(`  Net ${BASE_CURRENCY}: ${roundAsset(ldBuyAsset - ldSellAsset)}`);
  console.log(`  Net ${QUOTE_CURRENCY} (sells - buys - fees): $${roundUSDC(ldSellQuote - ldBuyQuote - ldBuyFees - ldSellFees)}`);

  // ── Deltas ────────────────────────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log('  DELTAS (Exchange - Ledger)');
  console.log('='.repeat(55));
  console.log(`  Buy ${BASE_CURRENCY}:  ${roundAsset(exBuyAsset - ldBuyAsset)}`);
  console.log(`  Buy ${QUOTE_CURRENCY}:  $${roundUSDC(exBuyQuote - ldBuyQuote)}`);
  console.log(`  Sell ${BASE_CURRENCY}: ${roundAsset(exSellAsset - ldSellAsset)}`);
  console.log(`  Sell ${QUOTE_CURRENCY}: $${roundUSDC(exSellQuote - ldSellQuote)}`);

  // ── Missing fills ─────────────────────────────────────────

  if (missingFromLedger.length > 0) {
    console.log('\n' + '='.repeat(55));
    console.log(`  FILLS ON EXCHANGE MISSING FROM LEDGER (${missingFromLedger.length})`);
    console.log('='.repeat(55));
    // Group by orderId
    const byOrder = new Map();
    for (const f of missingFromLedger) {
      if (!byOrder.has(f.orderId)) byOrder.set(f.orderId, []);
      byOrder.get(f.orderId).push(f);
    }
    for (const [orderId, fills] of byOrder) {
      const totalAsset = fills.reduce((s, f) => s + f.size, 0);
      const totalQuote = fills.reduce((s, f) => s + f.quoteAmount, 0);
      const totalFee = fills.reduce((s, f) => s + f.fee, 0);
      const side = fills[0].side;
      const time = new Date(fills[0].timestamp).toISOString();
      console.log(`  ${side.toUpperCase()} order=${orderId}: ${roundAsset(totalAsset)} ${BASE_CURRENCY} @ ~$${totalAsset > 0 ? roundUSDC(totalQuote / totalAsset) : 0} ($${roundUSDC(totalQuote)}) fee=$${roundUSDC(totalFee)} [${time}] [${fills.length} fill(s)]`);
      for (const f of fills) {
        console.log(`    tid=${f.tradeId} ${f.size} ${BASE_CURRENCY} @ $${f.price} fee=$${f.fee} ${f.feeCurrency}`);
      }
    }
  } else {
    console.log('\nNo fills missing from ledger');
  }

  if (missingFromExchange.length > 0) {
    console.log('\n' + '='.repeat(55));
    console.log(`  FILLS IN LEDGER MISSING FROM EXCHANGE (${missingFromExchange.length})`);
    console.log('='.repeat(55));
    for (const f of missingFromExchange.slice(0, 20)) {
      console.log(`  ${f.side.toUpperCase()} order=${f.orderId}: ${f.size} ${BASE_CURRENCY} @ $${f.price} [tradeId=${f.tradeId}]`);
    }
  } else {
    console.log('No phantom fills in ledger');
  }

  // ── All exchange orders summary ────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log('  ALL EXCHANGE ORDERS (by time)');
  console.log('='.repeat(55));
  const sortedOrders = [...exOrderMap.entries()]
    .sort((a, b) => a[1].fills[0].timestamp - b[1].fills[0].timestamp);

  for (const [orderId, o] of sortedOrders) {
    const avgPrice = o.totalAsset > 0 ? o.totalQuote / o.totalAsset : 0;
    const time = new Date(o.fills[0].timestamp).toISOString();
    const inLedger = ledger.some(f => f.orderId === orderId);
    const mark = inLedger ? 'OK' : 'MISSING';
    console.log(`  [${mark}] ${o.side.toUpperCase()} ${orderId}: ${roundAsset(o.totalAsset)} ${BASE_CURRENCY} @ $${roundUSDC(avgPrice)} = $${roundUSDC(o.totalQuote)} (fee $${roundUSDC(o.totalFee)}) [${time}] [${o.fills.length} fill(s)]`);
  }

  // ── Position state vs exchange ────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log('  POSITION STATE vs EXCHANGE REALITY');
  console.log('='.repeat(55));
  const netAssetExchange = exBuyAsset - exSellAsset;
  // Add the consolidated buy from DCA migration (not on exchange as individual trades)
  const consolidatedBuys = ledger.filter(f => f.tradeId.startsWith('dca-convert-'));
  const consolidatedAsset = consolidatedBuys.reduce((s, f) => s + f.size, 0);
  const consolidatedQuote = consolidatedBuys.reduce((s, f) => s + f.quoteAmount, 0);
  console.log(`  Consolidated (DCA migration): ${roundAsset(consolidatedAsset)} ${BASE_CURRENCY} / $${roundUSDC(consolidatedQuote)}`);
  console.log(`  Exchange net ${BASE_CURRENCY} (buys-sells): ${roundAsset(netAssetExchange)}`);
  console.log(`  Total net ${BASE_CURRENCY} (exchange + consolidated): ${roundAsset(netAssetExchange + consolidatedAsset)}`);
  console.log(`  State totalAsset:              ${state.position.totalAsset}`);
  console.log(`  Delta:                         ${roundAsset(netAssetExchange + consolidatedAsset - state.position.totalAsset)}`);
  console.log(`  State realizedPnL:             $${state.position.realizedPnL}`);
  console.log(`  State realizedAssetPnL:        ${state.position.realizedAssetPnL}`);
  console.log(`  State assetOnOrder:            ${state.position.assetOnOrder}`);

  // Exchange balance check
  try {
    const [assetBalance, quoteBalance] = await Promise.all([
      adapter.getAccountBalance(BASE_CURRENCY),
      adapter.getAccountBalance(QUOTE_CURRENCY),
    ]);
    console.log(`\n  Exchange ${BASE_CURRENCY} balance: ${assetBalance.total} (available: ${assetBalance.available}, hold: ${assetBalance.hold})`);
    console.log(`  Exchange ${QUOTE_CURRENCY} balance: ${quoteBalance.total} (available: ${quoteBalance.available}, hold: ${quoteBalance.hold})`);
    // Tracked includes both body assetQty and reserves (realizedAssetPnL holdback)
    const trackedAsset = state.position.totalAsset + (state.position.realizedAssetPnL || 0);
    console.log(`  Tracked ${BASE_CURRENCY} vs exchange: tracked=${roundAsset(trackedAsset)} (bodies+reserves), delta=${roundAsset(trackedAsset - assetBalance.total)}`);
  } catch (e) {
    console.log(`  (Could not fetch balance: ${e.message})`);
  }

  console.log('\nAudit complete\n');
}

main().catch(err => {
  console.error('Audit failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
