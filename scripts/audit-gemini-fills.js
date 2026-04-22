#!/usr/bin/env node
/**
 * Audit Gemini fills against the local fill-ledger.
 *
 * Pulls all BTC/USD trades from Gemini since the engine's first order,
 * compares with the fill-ledger, and reports:
 *   - Fills on exchange missing from ledger
 *   - Fills in ledger missing from exchange (stale/phantom)
 *   - Aggregate buy/sell totals from each source
 *
 * Usage:  node scripts/audit-gemini-fills.js
 */

const fs = require('fs');
const path = require('path');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { DATA_DIR } = require('../src/paths');

const { roundAsset: roundBTC, roundUSDC } = require('../src/volatility-utils');

const SYMBOL = 'btcusd';

const adapter = createGeminiAdapter();

// ── Load local fill-ledger ─────────────────────────────────────

const loadLedger = () => {
  const ledgerPath = path.join(DATA_DIR, 'gemini/fill-ledger.json');
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
};

// ── Main ───────────────────────────────────────────────────────

async function main() {
  // Engine start timestamp from regime-state
  const statePath = path.join(DATA_DIR, 'gemini/regime-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const engineStart = state.position.engineStartTime;

  console.log(`\nAuditing Gemini fills since engine start: ${new Date(engineStart).toISOString()}\n`);

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
  let exBuyBtc = 0, exBuyUsdc = 0, exBuyFees = 0;
  let exSellBtc = 0, exSellUsdc = 0, exSellFees = 0;
  const exOrderMap = new Map();

  for (const f of exchangeFills.values()) {
    if (f.side === 'buy') {
      exBuyBtc += f.size;
      exBuyUsdc += f.quoteAmount;
      exBuyFees += f.fee;
    } else {
      exSellBtc += f.size;
      exSellUsdc += f.quoteAmount;
      exSellFees += f.fee;
    }

    if (!exOrderMap.has(f.orderId)) {
      exOrderMap.set(f.orderId, { side: f.side, fills: [], totalBtc: 0, totalUsdc: 0, totalFee: 0 });
    }
    const o = exOrderMap.get(f.orderId);
    o.fills.push(f);
    o.totalBtc += f.size;
    o.totalUsdc += f.quoteAmount;
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

  console.log('='.repeat(55));
  console.log('  EXCHANGE TOTALS (Gemini)');
  console.log('='.repeat(55));
  console.log(`  Buys:  ${roundBTC(exBuyBtc)} BTC | $${roundUSDC(exBuyUsdc)} USD | fees $${roundUSDC(exBuyFees)}`);
  console.log(`  Sells: ${roundBTC(exSellBtc)} BTC | $${roundUSDC(exSellUsdc)} USD | fees $${roundUSDC(exSellFees)}`);
  console.log(`  Net BTC: ${roundBTC(exBuyBtc - exSellBtc)}`);
  console.log(`  Net USD (sells - buys - fees): $${roundUSDC(exSellUsdc - exBuyUsdc - exBuyFees - exSellFees)}`);

  console.log('\n' + '='.repeat(55));
  console.log('  LEDGER TOTALS (fill-ledger.json)');
  console.log('='.repeat(55));
  console.log(`  Buys:  ${roundBTC(ldBuyBtc)} BTC | $${roundUSDC(ldBuyUsdc)} USD | fees $${roundUSDC(ldBuyFees)}`);
  console.log(`  Sells: ${roundBTC(ldSellBtc)} BTC | $${roundUSDC(ldSellUsdc)} USD | fees $${roundUSDC(ldSellFees)}`);
  console.log(`  Net BTC: ${roundBTC(ldBuyBtc - ldSellBtc)}`);
  console.log(`  Net USD (sells - buys - fees): $${roundUSDC(ldSellUsdc - ldBuyUsdc - ldBuyFees - ldSellFees)}`);

  // ── Deltas ────────────────────────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log('  DELTAS (Exchange - Ledger)');
  console.log('='.repeat(55));
  console.log(`  Buy BTC:  ${roundBTC(exBuyBtc - ldBuyBtc)}`);
  console.log(`  Buy USD:  $${roundUSDC(exBuyUsdc - ldBuyUsdc)}`);
  console.log(`  Sell BTC: ${roundBTC(exSellBtc - ldSellBtc)}`);
  console.log(`  Sell USD: $${roundUSDC(exSellUsdc - ldSellUsdc)}`);

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
      const totalBtc = fills.reduce((s, f) => s + f.size, 0);
      const totalUsdc = fills.reduce((s, f) => s + f.quoteAmount, 0);
      const totalFee = fills.reduce((s, f) => s + f.fee, 0);
      const side = fills[0].side;
      const time = new Date(fills[0].timestamp).toISOString();
      console.log(`  ${side.toUpperCase()} order=${orderId}: ${roundBTC(totalBtc)} BTC @ ~$${totalBtc > 0 ? roundUSDC(totalUsdc / totalBtc) : 0} ($${roundUSDC(totalUsdc)}) fee=$${roundUSDC(totalFee)} [${time}] [${fills.length} fill(s)]`);
      for (const f of fills) {
        console.log(`    tid=${f.tradeId} ${f.size} BTC @ $${f.price} fee=$${f.fee} ${f.feeCurrency}`);
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
      console.log(`  ${f.side.toUpperCase()} order=${f.orderId}: ${f.size} BTC @ $${f.price} [tradeId=${f.tradeId}]`);
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
    const avgPrice = o.totalBtc > 0 ? o.totalUsdc / o.totalBtc : 0;
    const time = new Date(o.fills[0].timestamp).toISOString();
    const inLedger = ledger.some(f => f.orderId === orderId);
    const mark = inLedger ? 'OK' : 'MISSING';
    console.log(`  [${mark}] ${o.side.toUpperCase()} ${orderId}: ${roundBTC(o.totalBtc)} BTC @ $${roundUSDC(avgPrice)} = $${roundUSDC(o.totalUsdc)} (fee $${roundUSDC(o.totalFee)}) [${time}] [${o.fills.length} fill(s)]`);
  }

  // ── Position state vs exchange ────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log('  POSITION STATE vs EXCHANGE REALITY');
  console.log('='.repeat(55));
  const netBtcExchange = exBuyBtc - exSellBtc;
  // Add the consolidated buy from DCA migration (not on exchange as individual trades)
  const consolidatedBuys = ledger.filter(f => f.tradeId.startsWith('dca-convert-'));
  const consolidatedBtc = consolidatedBuys.reduce((s, f) => s + f.size, 0);
  const consolidatedUsdc = consolidatedBuys.reduce((s, f) => s + f.quoteAmount, 0);
  console.log(`  Consolidated (DCA migration): ${roundBTC(consolidatedBtc)} BTC / $${roundUSDC(consolidatedUsdc)}`);
  console.log(`  Exchange net BTC (buys-sells): ${roundBTC(netBtcExchange)}`);
  console.log(`  Total net BTC (exchange + consolidated): ${roundBTC(netBtcExchange + consolidatedBtc)}`);
  console.log(`  State totalAsset:              ${state.position.totalAsset}`);
  console.log(`  Delta:                         ${roundBTC(netBtcExchange + consolidatedBtc - state.position.totalAsset)}`);
  console.log(`  State realizedPnL:             $${state.position.realizedPnL}`);
  console.log(`  State realizedAssetPnL:        ${state.position.realizedAssetPnL}`);
  console.log(`  State assetOnOrder:            ${state.position.assetOnOrder}`);

  // Exchange balance check
  try {
    const btcBalance = await adapter.getAccountBalance('BTC');
    const usdBalance = await adapter.getAccountBalance('USD');
    console.log(`\n  Exchange BTC balance: ${btcBalance.total} (available: ${btcBalance.available}, hold: ${btcBalance.hold})`);
    console.log(`  Exchange USD balance: ${usdBalance.total} (available: ${usdBalance.available}, hold: ${usdBalance.hold})`);
    console.log(`  Tracked BTC vs exchange: delta=${roundBTC(state.position.totalAsset - btcBalance.total)}`);
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
