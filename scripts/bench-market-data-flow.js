#!/usr/bin/env node
// Synthetic receipt-clock benchmark: no start(), exchange calls or state writes.
// Run: node scripts/bench-market-data-flow.js
const assert = require('node:assert/strict');
const { createMarketDataService } = require('../src/market-data-service');

// Pre-cursor callback and reverse scan, retained as the differential baseline.
const createLegacy = () => {
  const rows = [];
  return {
    add(data) {
      if (!data?.price || !data?.size || !data?.side) return;
      const now = Date.now();
      rows.push({ price: data.price, size: parseFloat(data.size), side: data.side, timestamp: now });
      while (rows.length > 0 && rows[0].timestamp < now - 300_000) rows.shift();
    },
    flow(windowMs) {
      const cutoff = Date.now() - windowMs;
      let buyVolume = 0, sellVolume = 0, tradeCount = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.timestamp < cutoff) break;
        if (row.side === 'buy') buyVolume += row.size;
        else sellVolume += row.size;
        tradeCount++;
      }
      const total = buyVolume + sellVolume;
      return { buyVolume, sellVolume, tradeCount, imbalance: total > 0 ? (buyVolume - sellVolume) / total : 0 };
    },
    rows: () => rows,
  };
};

const cpuMs = (start) => {
  const elapsed = process.cpuUsage(start);
  return (elapsed.user + elapsed.system) / 1000;
};

const run = (rate, optimized) => {
  const svc = optimized ? createMarketDataService('coinbase', 'BTC-USD') : null;
  const legacy = optimized ? null : createLegacy();
  const add = svc ? svc._test.handleTrade : legacy.add;
  const flow = svc ? svc._test.computeTradeFlow : legacy.flow;
  const originalNow = Date.now;
  let now = 0;
  let callbackCpuMs = 0, statusCpuMs = 0;
  const summaries = [];
  // Build arrivals outside all measured sections; only receipt time is consumed.
  const events = Array.from({ length: rate * 360 }, (_, i) => ({
    price: 100, size: String(0.01 + (i % 7) / 100), side: i % 3 ? 'buy' : 'sell',
  }));
  try {
    Date.now = () => now;
    for (let second = 0; second < 360; second++) {
      const callbackStart = process.cpuUsage();
      for (let j = 0; j < rate; j++) {
        now = (second * rate + j) * 1000 / rate;
        add(events[second * rate + j]);
      }
      if (second >= 300) {
        callbackCpuMs += cpuMs(callbackStart);
        const statusStart = process.cpuUsage();
        summaries.push([flow(60_000), flow(300_000)]);
        statusCpuMs += cpuMs(statusStart);
      }
    }
    const storage = svc ? svc._test.getTradeFlowStorage() : { rows: legacy.rows() };
    return { callbackCpuMs, statusCpuMs, summaries, ...storage };
  } finally {
    Date.now = originalNow;
  }
};

if (require.main === module) {
  for (const rate of [100, 500]) {
    const before = run(rate, false);
    const after = run(rate, true);
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(after.summaries, before.summaries);
    console.log(JSON.stringify({ rate, warmSeconds: 300, measuredSeconds: 60, retained: after.rows.length,
      beforeCallbackCpuMs: +before.callbackCpuMs.toFixed(2), afterCallbackCpuMs: +after.callbackCpuMs.toFixed(2),
      beforeStatusCpuMs: +before.statusCpuMs.toFixed(2), afterStatusCpuMs: +after.statusCpuMs.toFixed(2),
      backingLength: after.backingLength, consumedPrefix: after.head, parity: true }));
  }
}

module.exports = { createLegacy };
