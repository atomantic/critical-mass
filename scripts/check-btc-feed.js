#!/usr/bin/env node
// @ts-check
/**
 * Run the BTC 1s feed against live public data for 90 seconds and print one JSON
 * summary. Opens no listener, reads no config or keys, writes only to a temp
 * directory it removes.
 *
 *   node scripts/check-btc-feed.js [seconds]
 *
 * `signAgreement` is the share of moving bars whose buy/sell balance matches their
 * direction. Aggressive buying lifts price, so below 0.5 means the sides are reversed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-btc-feed-'));
// Set before any module that resolves the data directory is loaded.
process.env.CRITICAL_MASS_DATA_DIR = root;
const { createBtcFeedService } = require('../src/btc-feed/btc-feed-service');

const runSeconds = Number(process.argv[2]) || 90;
let emits = 0;
const maxAgeMs = { coinbase: 0, index: 0 };
const service = createBtcFeedService({ to: () => ({ emit: () => { emits++; } }) }, { DATA_DIR: root });

const sampleAges = () => {
  const status = service.getStatus();
  for (const source of /** @type {const} */ (['coinbase', 'index'])) {
    const at = status[source].lastEventAt;
    if (at !== null) maxAgeMs[source] = Math.max(maxAgeMs[source], status.now - at);
  }
};

const finish = async () => {
  clearInterval(sampler);
  const { bars, index } = service.getWindow(runSeconds);
  await service.pauseHistory();
  service.stop();
  const dir = path.join(root, 'btc-feed');
  const indexHistoryLines = fs.existsSync(dir)
    ? fs.readdirSync(dir).reduce((n, file) => n + fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').length, 0)
    : 0;
  const spanSeconds = bars.length ? (bars[bars.length - 1].t - bars[0].t) / 1000 + 1 : 0;
  const moving = bars.filter((b) => b.close !== b.open && b.buyVolume !== b.sellVolume);
  const agree = moving.filter((b) => Math.sign(b.buyVolume - b.sellVolume) === Math.sign(b.close - b.open));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    runSeconds, bars: bars.length, tradedBars: bars.filter((b) => b.trades > 0).length, gapSeconds: spanSeconds - bars.length,
    trades: bars.reduce((n, b) => n + b.trades, 0), indexValues: index.length, indexHistoryLines, emits, maxAgeMs,
    movingBars: moving.length, signAgreement: moving.length ? Math.round((agree.length / moving.length) * 1000) / 1000 : null,
  }));
};

service.start();
const sampler = setInterval(sampleAges, 100);
setTimeout(() => {
  finish().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  }).finally(() => process.exit());
}, runSeconds * 1000);
