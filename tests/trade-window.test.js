const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTradeWindow } = require('../src/trade-window');

// Exercise the actual engine callback without creating a fund or a live engine.
const source = fs.readFileSync(require.resolve('../src/regime-engine'), 'utf8');
const start = source.indexOf('  const handleTrade = (data) => {');
const callback = source.slice(start, source.indexOf('\n  };', start) + 5);
const setupStart = source.indexOf('  const tradeWindow = createTradeWindow(');
const setupEnd = source.indexOf('\n', source.indexOf('Object.defineProperty(marketState,', setupStart));
const setup = source.slice(setupStart, setupEnd);

test('engine trade callback matches the full-window reference across shuffled trades and expiry', () => {
  let now = 1000000;
  const market = { lastPrice: 0, trades: [], tradeImbalance: 0 };
  const handleTrade = new Function('marketState', 'createTradeWindow', 'Date',
    setup + '\n' + callback + '\nreturn handleTrade;')(market, createTradeWindow, { now: () => now });
  let reference = [];
  let expected = 0;
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 12000; i++) {
    now += 40;
    const trade = { price: i + 1, size: random() / 10, side: random() > 0.4 ? 'buy' : 'sell',
      timestamp: now - Math.floor(random() * 200000) };
    reference.push(trade);
    reference = reference.filter(row => row.timestamp >= now - 180000);
    let buy = 0;
    let sell = 0;
    for (const row of reference) {
      if (row.side === 'buy') buy += row.size;
      else sell += row.size;
    }
    if (!reference.length) expected = 0;
    else if (buy + sell > 0) expected = (buy - sell) / (buy + sell);
    handleTrade(trade);
    assert.ok(Math.abs(market.tradeImbalance - expected) < 1e-12);
    assert.equal(market.lastPrice, trade.price);
    if (i % 500 === 0) assert.deepEqual(market.trades, reference);
  }
  assert.deepEqual(market.trades, reference);
  assert.deepEqual(JSON.parse(JSON.stringify(market)).trades, reference, 'status JSON retains the trade array');
});

test('inclusive boundary, duplicate rows, delayed/future trades and snapshots preserve arrival order', () => {
  const window = createTradeWindow(100);
  const trade = { timestamp: 100, side: 'buy', size: 2 };
  window.add(trade, 100);
  const first = window.getTrades();
  window.add(trade, 100);
  window.add({ timestamp: 90, side: 'sell', size: 1 }, 100);
  window.add({ timestamp: 500, side: 'sell', size: 1 }, 100);
  assert.equal(first.length, 1, 'new arrivals do not mutate an earlier snapshot');
  assert.equal(window.getTrades().length, 4, 'same object arriving twice is still two trades');
  window.add({ timestamp: NaN, size: 0 }, 200);
  assert.deepEqual(window.getTrades(), [trade, trade, { timestamp: 500, side: 'sell', size: 1 }]);
  assert.equal(window.add({ timestamp: 0, size: 0 }, 201), -1);
  assert.equal(window.add({ timestamp: 0, size: 0 }, 601), 0);
  assert.deepEqual(window.getTrades(), []);
});

test('compensated totals retain tiny residual volume and reset empty sides', () => {
  const window = createTradeWindow(100);
  window.add({ timestamp: 0, side: 'buy', size: 1e10 }, 0);
  window.add({ timestamp: 1, side: 'buy', size: 1e-8 }, 1);
  window.add({ timestamp: 1, side: 'sell', size: 1e-8 }, 1);
  assert.equal(window.add({ timestamp: 0, side: 'buy', size: 0 }, 101), 0);
  assert.equal(window.add({ timestamp: 102, side: 'sell', size: 2 }, 102), -1);
});

test('malformed size behavior recovers after expiry, and zero volume retains the prior imbalance', () => {
  const window = createTradeWindow(100);
  assert.equal(window.add({ timestamp: 0, side: 'buy', size: 1 }, 0), 1);
  assert.equal(window.add({ timestamp: 1, side: 'sell', size: NaN }, 1), 1);
  assert.equal(window.add({ timestamp: 102, side: 'sell', size: 1 }, 102), -1);
  assert.equal(window.add({ timestamp: 203, side: 'buy', size: 0 }, 203), -1);
  assert.equal(window.add({ timestamp: 0, side: 'buy', size: 0 }, 304), 0);
});

test('ordinary trade ingestion touches sizes only on arrival and expiry', () => {
  const window = createTradeWindow(1000);
  let reads = 0;
  for (let i = 0; i < 10000; i++) {
    window.add({ timestamp: i, side: i % 2 ? 'buy' : 'sell', get size() { reads++; return 1; } }, i);
  }
  assert.ok(reads < 50000, `size accesses should grow with events, not the retained window: ${reads}`);
  assert.equal(window.getTrades().length, 1001);
});
