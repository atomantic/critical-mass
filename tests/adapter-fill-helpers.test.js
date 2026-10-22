// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectOrderFillsWithRetry,
  buildFill,
  awaitAndAccountQueuedTime,
  restQueueTiming,
} = require('../src/adapters/base-adapter');

const noSleep = () => Promise.resolve();

describe('collectOrderFillsWithRetry', () => {
  it('returns immediately, without sleeping, when the first scan accounts for the expected size', async () => {
    let scans = 0;
    let sleeps = 0;
    const rows = await collectOrderFillsWithRetry({
      expected: 1,
      label: 'X',
      orderId: 'o1',
      sumOf: (r) => r.size,
      fetchMatching: async () => { scans++; return [{ size: 0.4 }, { size: 0.6 }]; },
      sleep: () => { sleeps++; return Promise.resolve(); },
    });
    assert.equal(scans, 1);
    assert.equal(sleeps, 0);
    assert.equal(rows.length, 2);
  });

  it('tolerates the 1e-9 float epsilon', async () => {
    const rows = await collectOrderFillsWithRetry({
      expected: 1,
      label: 'X',
      orderId: 'o1',
      sumOf: (r) => r.size,
      fetchMatching: async () => [{ size: 1 - 1e-10 }],
      sleep: noSleep,
    });
    assert.equal(rows.length, 1);
  });

  it('retries a lagging index and returns once the fills catch up', async () => {
    const scans = [[{ size: 0.5 }], [{ size: 0.5 }], [{ size: 0.5 }, { size: 0.5 }]];
    let i = 0;
    const delays = [];
    const rows = await collectOrderFillsWithRetry({
      expected: 1,
      label: 'X',
      orderId: 'o1',
      sumOf: (r) => r.size,
      fetchMatching: async () => scans[i++],
      sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
    });
    assert.equal(i, 3);
    assert.deepEqual(delays, [750, 750]);
    assert.equal(rows.length, 2);
  });

  it('throws an incompleteFills error with the exchange label after the retry cap (default 2 retries = 3 scans)', async () => {
    let scans = 0;
    await assert.rejects(
      () => collectOrderFillsWithRetry({
        expected: 1,
        label: '[gemini]',
        orderId: 'ord-9',
        sumOf: (r) => r.size,
        fetchMatching: async () => { scans++; return [{ size: 0.25 }]; },
        sleep: noSleep,
      }),
      (err) => {
        assert.equal(err.incompleteFills, true);
        assert.equal(err.message, '[gemini] getOrderFills: fills incomplete for ord-9: 0.25 of 1');
        return true;
      },
    );
    assert.equal(scans, 3);
  });

  it('honors custom retries and propagates a fetch failure unchanged', async () => {
    let scans = 0;
    await assert.rejects(
      () => collectOrderFillsWithRetry({
        expected: 1, label: 'X', orderId: 'o', retries: 0, sumOf: () => 0, sleep: noSleep,
        fetchMatching: async () => { scans++; return []; },
      }),
      { incompleteFills: true },
    );
    assert.equal(scans, 1);

    const boom = new Error('scan failed');
    await assert.rejects(
      () => collectOrderFillsWithRetry({
        expected: 1, label: 'X', orderId: 'o', sumOf: () => 0, sleep: noSleep,
        fetchMatching: async () => { throw boom; },
      }),
      (err) => err === boom,
    );
  });

  it('lets fetchMatching share state (a page budget) across retries', async () => {
    const budget = { remaining: 10 };
    const seen = [];
    await assert.rejects(() => collectOrderFillsWithRetry({
      expected: 1, label: 'X', orderId: 'o', sumOf: () => 0, sleep: noSleep,
      fetchMatching: async () => { budget.remaining -= 3; seen.push(budget.remaining); return []; },
    }));
    assert.deepEqual(seen, [7, 4, 1]);
  });

  it('accounts retry sleeps into the restQueueTiming store', async () => {
    const store = { queuedMs: 0 };
    let i = 0;
    await restQueueTiming.run(store, () => collectOrderFillsWithRetry({
      expected: 1, label: 'X', orderId: 'o', sumOf: (r) => r,
      fetchMatching: async () => (i++ === 0 ? [0] : [1]),
      delayMs: 25,
    }));
    assert.ok(store.queuedMs >= 20, `queuedMs ${store.queuedMs}`);
  });
});

describe('awaitAndAccountQueuedTime', () => {
  it('is a no-op for a null wait and outside a store', async () => {
    await awaitAndAccountQueuedTime(null);
    await awaitAndAccountQueuedTime(Promise.resolve());
  });

  it('adds elapsed wait to the active store', async () => {
    const store = { queuedMs: 0 };
    await restQueueTiming.run(store, () => awaitAndAccountQueuedTime(new Promise((r) => setTimeout(r, 30))));
    assert.ok(store.queuedMs >= 25, `queuedMs ${store.queuedMs}`);
  });
});

describe('buildFill', () => {
  it('derives sizeInQuote, totalCommission, rebate and netFee defaults', () => {
    assert.deepEqual(
      buildFill({
        tradeId: 't', orderId: 'o', productId: 'BTC-USD', side: 'BUY', price: 100, size: 0.5,
        commission: 1.25, tradeTime: '2026-01-01T00:00:00.000Z', liquidityIndicator: 'MAKER',
      }),
      {
        tradeId: 't', orderId: 'o', productId: 'BTC-USD', side: 'BUY', price: 100, size: 0.5,
        sizeInQuote: 50, commission: 1.25, totalCommission: 1.25, rebate: 0, netFee: 1.25,
        tradeTime: '2026-01-01T00:00:00.000Z', liquidityIndicator: 'MAKER',
      },
    );
  });

  it('honors explicit quote size, total commission and rebate (Coinbase shape)', () => {
    const fill = buildFill({
      tradeId: 't', orderId: 'o', productId: 'p', side: 'SELL', price: 10, size: 2,
      sizeInQuote: 21, commission: 1, totalCommission: 3, rebate: 0.5,
      tradeTime: 'x', liquidityIndicator: 'TAKER',
    });
    assert.equal(fill.sizeInQuote, 21);
    assert.equal(fill.totalCommission, 3);
    assert.equal(fill.netFee, 2.5);
  });
});
