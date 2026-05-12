#!/usr/bin/env node
/**
 * Backfill positionState.realizedPnL and positionState.realizedAssetPnL for each
 * fund's regime-state.json using the same FIFO replay the engine now performs at
 * runtime via fillLedger.getDerivedRealizedPnL().
 *
 * Engines must be stopped before running (live state files mustn't be racing).
 *
 * Usage:
 *   node scripts/backfill-fifo-realized.js          # dry-run, prints proposed changes
 *   node scripts/backfill-fifo-realized.js --apply  # writes (creates timestamped backup)
 */

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const DATA_DIR = path.join(__dirname, '..', 'data');

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const round2 = (n) => Math.round(n * 100) / 100;

const computeFifoRealized = (fills) => {
  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  let realizedPnL = 0;
  const lots = [];
  for (const fill of sorted) {
    const size = Number(fill.size) || 0;
    const quote = Number(fill.quoteAmount) || 0;
    const fee = Number(fill.netFee) || 0;
    if (fill.side === 'buy') {
      const cost = quote + fee;
      lots.push({ qty: size, unitCost: size > 0 ? cost / size : 0 });
    } else if (fill.side === 'sell') {
      const proceeds = quote - fee;
      let remain = size;
      let costBasis = 0;
      while (remain > 1e-12 && lots.length > 0) {
        const lot = lots[0];
        const use = Math.min(remain, lot.qty);
        costBasis += use * lot.unitCost;
        lot.qty -= use;
        remain -= use;
        if (lot.qty <= 1e-12) lots.shift();
      }
      realizedPnL += proceeds - costBasis;
    }
  }
  const remainingAssetQty = lots.reduce((s, l) => s + l.qty, 0);
  return { realizedPnL: round2(realizedPnL), remainingAssetQty: round8(remainingAssetQty) };
};

const findFunds = () => {
  const funds = [];
  for (const exchange of fs.readdirSync(DATA_DIR)) {
    const exDir = path.join(DATA_DIR, exchange);
    if (!fs.statSync(exDir).isDirectory()) continue;
    for (const pair of fs.readdirSync(exDir)) {
      const pairDir = path.join(exDir, pair);
      if (!fs.statSync(pairDir).isDirectory()) continue;
      const regimeFile = path.join(pairDir, 'regime-state.json');
      const ledgerFile = path.join(pairDir, 'fill-ledger.json');
      if (fs.existsSync(regimeFile) && fs.existsSync(ledgerFile)) {
        funds.push({ exchange, pair, regimeFile, ledgerFile });
      }
    }
  }
  return funds;
};

const sumClosedTradesPnl = (pairDir) => {
  const ctFile = path.join(pairDir, 'closed-trades.json');
  if (!fs.existsSync(ctFile)) return { count: 0, total: 0 };
  const raw = JSON.parse(fs.readFileSync(ctFile, 'utf8'));
  const trades = Array.isArray(raw) ? raw : (raw.trades || Object.values(raw));
  let total = 0;
  for (const t of trades) total += Number(t?.pnl) || 0;
  return { count: trades.length, total: round2(total) };
};

const processFund = ({ exchange, pair, regimeFile, ledgerFile }) => {
  const ledgerRaw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const fills = Array.isArray(ledgerRaw) ? ledgerRaw : Object.values(ledgerRaw);

  const { realizedPnL: fifoUsd, remainingAssetQty } = computeFifoRealized(fills);

  const state = JSON.parse(fs.readFileSync(regimeFile, 'utf8'));
  const pos = state.position || {};
  const bodies = pos.celestialBodies || [];
  const bodyAssetSum = bodies.reduce((s, b) => s + (Number(b.assetQty) || 0), 0);
  const activeAsset = bodyAssetSum > 0 ? bodyAssetSum : (Number(pos.totalAsset) || 0);
  const reserves = round8(Math.max(0, remainingAssetQty - activeAsset));

  // Per-cycle USD profit comes from closed-trades. Always non-negative under TP.
  // Falls back to FIFO replay only if closed-trades doesn't exist for this fund.
  const pairDir = path.dirname(regimeFile);
  const { count: ctCount, total: ctTotal } = sumClosedTradesPnl(pairDir);
  const realizedPnL = ctCount > 0 ? ctTotal : fifoUsd;

  const before = {
    realizedPnL: pos.realizedPnL,
    realizedAssetPnL: pos.realizedAssetPnL,
  };
  const after = {
    realizedPnL,
    realizedAssetPnL: reserves,
  };

  console.log(`\n[${exchange}/${pair}]`);
  console.log(`  fills: ${fills.length}, bodies: ${bodies.length}, activeAsset: ${activeAsset}`);
  console.log(`  closed-trades: ${ctCount} (sum pnl: ${ctTotal})  |  FIFO USD (info): ${fifoUsd}`);
  console.log(`  FIFO remaining qty (active+reserves): ${remainingAssetQty}`);
  console.log(`  realizedPnL:      ${before.realizedPnL} -> ${after.realizedPnL}`);
  console.log(`  realizedAssetPnL: ${before.realizedAssetPnL} -> ${after.realizedAssetPnL}`);

  if (apply) {
    const backup = `${regimeFile}.backup-fifo-${Date.now()}`;
    fs.copyFileSync(regimeFile, backup);
    state.position.realizedPnL = realizedPnL;
    state.position.realizedAssetPnL = reserves;
    fs.writeFileSync(regimeFile, JSON.stringify(state, null, 2));
    console.log(`  ✓ written (backup: ${path.basename(backup)})`);
  }
};

const main = () => {
  const funds = findFunds();
  if (funds.length === 0) {
    console.log('No funds with both regime-state.json and fill-ledger.json found.');
    return;
  }
  console.log(`Found ${funds.length} fund(s). Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  for (const fund of funds) processFund(fund);
  if (!apply) console.log('\n(Dry run — re-run with --apply to write changes.)');
};

main();
