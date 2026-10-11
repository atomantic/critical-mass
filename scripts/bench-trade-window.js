#!/usr/bin/env node
// Synthetic CPU benchmark only; no exchange, fund state or network access.
// node scripts/bench-trade-window.js
// Add --stress for a 500 trades/second burst fixture (the baseline takes longer).
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { createTradeWindow } = require('../src/trade-window');

const legacyWindow = (retentionMs) => {
  let trades = [];
  let imbalance = 0;
  return {
    add(trade, now) {
      trades.push(trade);
      trades = trades.filter(row => row.timestamp >= now - retentionMs);
      let buy = 0;
      let sell = 0;
      for (const row of trades) {
        if (row.side === 'buy') buy += row.size;
        else sell += row.size;
      }
      if (!trades.length) imbalance = 0;
      else if (buy + sell > 0) imbalance = (buy - sell) / (buy + sell);
      return imbalance;
    },
    getTrades: () => trades,
  };
};

const run = (create, events, rate) => {
  const window = create(180000);
  let imbalance;
  const start = performance.now();
  for (let i = 0; i < events.length; i++) {
    imbalance = window.add(events[i], events[i].timestamp);
    // Include materialization at the engine's maximum status cadence (1 Hz).
    if (i % rate === 0) window.getTrades();
  }
  return { ms: performance.now() - start, imbalance, rows: window.getTrades().length };
};

const rates = process.argv.includes('--stress') ? [20, 100, 500] : [20, 100];
for (const rate of rates) {
  const events = Array.from({ length: rate * 240 }, (_, i) => ({
    timestamp: i * 1000 / rate, price: 100,
    size: 0.001 + (i % 7) * 0.0001, side: i % 3 ? 'buy' : 'sell',
  }));
  // Warm both implementations outside the measured run.
  run(legacyWindow, events.slice(0, 1000), rate);
  run(createTradeWindow, events.slice(0, 1000), rate);
  const before = run(legacyWindow, events, rate);
  const after = run(createTradeWindow, events, rate);
  assert.equal(after.rows, before.rows);
  assert.ok(Math.abs(after.imbalance - before.imbalance) < 1e-12);
  console.log(JSON.stringify({ rate, seconds: 240, events: events.length, retained: after.rows,
    beforeMs: +before.ms.toFixed(2), afterMs: +after.ms.toFixed(2), speedup: +(before.ms / after.ms).toFixed(1) }));
}
