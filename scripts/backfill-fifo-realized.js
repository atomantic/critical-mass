#!/usr/bin/env node
/**
 * Backfill positionState.realizedPnL and positionState.realizedAssetPnL for each
 * fund's regime-state.json using the legacy FIFO diagnostic and closed trades.
 * This repair does not change the engine's cycle-pair accounting model.
 *
 * APPLY requires a PM2-confirmed stopped gateway. Engines are stopped and held
 * in maintenance over IPC, or must be PM2-confirmed stopped. A pending journal
 * blocks process startup until explicit resume/rollback completes.
 *
 * Usage:
 *   node scripts/backfill-fifo-realized.js          # dry-run, prints proposed changes
 *   node scripts/backfill-fifo-realized.js --apply  # stages and commits a durable cohort
 *   node scripts/backfill-fifo-realized.js --resume # finish a pending cohort
 *   node scripts/backfill-fifo-realized.js --rollback # restore original bytes
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('../src/paths');

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

const findFunds = (dataDir = DATA_DIR) => {
  const funds = [];
  for (const exchange of fs.readdirSync(dataDir)) {
    const exDir = path.join(dataDir, exchange);
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

const stageFund = ({ exchange, pair, regimeFile, ledgerFile }, log = console.log) => {
  const ledgerRaw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const fills = Array.isArray(ledgerRaw) ? ledgerRaw : Object.values(ledgerRaw);

  const { realizedPnL: fifoUsd, remainingAssetQty } = computeFifoRealized(fills);

  const beforeBytes = fs.readFileSync(regimeFile, 'utf8');
  const state = JSON.parse(beforeBytes);
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.position || typeof state.position !== 'object' || Array.isArray(state.position)) {
    throw new Error(`Invalid position state for ${exchange}/${pair}`);
  }
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

  log(`\n[${exchange}/${pair}]`);
  log(`  fills: ${fills.length}, bodies: ${bodies.length}, activeAsset: ${activeAsset}`);
  log(`  closed-trades: ${ctCount} (sum pnl: ${ctTotal})  |  FIFO USD (info): ${fifoUsd}`);
  log(`  FIFO remaining qty (active+reserves): ${remainingAssetQty}`);
  log(`  realizedPnL:      ${before.realizedPnL} -> ${after.realizedPnL}`);
  log(`  realizedAssetPnL: ${before.realizedAssetPnL} -> ${after.realizedAssetPnL}`);

  state.position.realizedPnL = realizedPnL;
  state.position.realizedAssetPnL = reserves;
  if (!Number.isFinite(realizedPnL) || !Number.isFinite(reserves)) {
    throw new Error(`Non-finite backfill result for ${exchange}/${pair}`);
  }
  return { file: regimeFile, before: beforeBytes, after: JSON.stringify(state, null, 2) };
};

const main = async (args = process.argv.slice(2)) => {
  const modes = ['--apply', '--resume', '--rollback'].filter((arg) => args.includes(arg));
  if (modes.length > 1 || args.some((arg) => !modes.includes(arg))) {
    throw new Error('Usage: backfill-fifo-realized.js [--apply | --resume | --rollback]');
  }
  if (modes.length === 0) {
    const funds = findFunds();
    for (const fund of funds) stageFund(fund);
    console.log(`Dry run: ${funds.length} fund(s). Re-run with --apply to write changes.`);
    return;
  }
  const { runBackfill, withStoppedWriters } = require('../src/fifo-backfill-transaction');
  await withStoppedWriters(async (assertStopped) => {
    const result = runBackfill({ dataDir: DATA_DIR, mode: modes[0].slice(2), assertStopped, stage: () => findFunds().map((fund) => stageFund(fund)) });
    console.log(`${result.status}: verified ${result.count} fund(s). Engines remain stopped; restart manually.`);
  });
};

if (require.main === module) main().catch((error) => {
  console.error(`Backfill failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { computeFifoRealized, findFunds, stageFund, main };
