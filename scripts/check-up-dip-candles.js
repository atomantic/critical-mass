#!/usr/bin/env node
// @ts-check
/**
 * Run the Up dip candle source against live public data for five minutes and print
 * one JSON summary. Opens no listener, reads no config or keys, writes only to a temp
 * directory it removes.
 *
 *   node scripts/check-up-dip-candles.js [seconds]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-up-dip-'));
// Set before any module that resolves the data directory is loaded.
process.env.CRITICAL_MASS_DATA_DIR = root;
const { createBtcFeedService } = require('../src/btc-feed/btc-feed-service');
const { createUpDipCandles, fetchBtcUsd } = require('../src/updown/up-dip-candles');

const runSeconds = Number(process.argv[2]) || 300;
const TFS = ['1m', '5m', '15m', '1h', '1d'];
const feed = createBtcFeedService({ to: () => ({ emit: () => {} }) }, { DATA_DIR: root });
const candles = createUpDipCandles({ subscribeIndex: feed.subscribeIndex, DATA_DIR: root, logger: console });
const startedAt = Date.now();
let seeded = null;

const finish = async () => {
  clearInterval(watcher);
  const live = candles.getCandles('1m').filter((c) => c.timestamp >= startedAt - 60_000);
  const index = live.filter((c) => !c.substitute);
  const exchange = new Map((await fetchBtcUsd('1m', 20)).map((c) => [c.timestamp, c.close]));
  const gaps = index.filter((c) => exchange.has(c.timestamp)).map((c) => Math.abs(c.close - exchange.get(c.timestamp))).sort((a, b) => a - b);
  const status = candles.getStatus();
  candles.stop();
  feed.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ runSeconds, seeded, indexBars: index.length, substituteBars: live.length - index.length, gaps: status.gaps,
    medianCloseDifference: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 100) / 100 : null }));
};

feed.start();
candles.start();
const watcher = setInterval(() => {
  if (seeded || !candles.isReady()) return;
  seeded = { afterSeconds: Math.round((Date.now() - startedAt) / 1000), ...Object.fromEntries(TFS.map((tf) => [tf, candles.getCandles(tf).length])) };
}, 200);
setTimeout(() => {
  finish().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  }).finally(() => process.exit());
}, runSeconds * 1000);
