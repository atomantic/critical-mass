// @ts-check
/**
 * sync-fills pair-threading regression tests (issue #198)
 *
 * getUnaccountedFills/syncFills used to hardcode the BTC symbol regardless of
 * which fund's ledger was passed in, so a non-BTC fund's "unaccounted fills"
 * view fetched BTC trades and diffed them against (e.g.) an ETH ledger. These
 * tests drive getUnaccountedFills with a mock adapter and assert the fund's
 * own pair reaches the adapter reconciliation contract.
 *
 * Uses the same fake-module-via-require.cache pattern as
 * tests/gemini-l2-book.test.js / tests/ipc-client-deserialize.test.js so no
 * real credentials or network calls are needed.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/** @type {Array<{productId: string|undefined, since: number}>} */
let geminiCalls = [];

const fakeGeminiAdapter = {
  getReconciliationFills: async (productId, since) => {
    geminiCalls.push({ productId, since });
    return [];
  },
};

const fakeCoinbaseAdapter = {
  getReconciliationFills: async () => [],
};

// Inject a fake './adapters' module before loading sync-fills so it picks up
// getAdapter() returning our mock instead of a real, credential-requiring one.
const adaptersPath = require.resolve('../src/adapters');
require.cache[adaptersPath] = /** @type {any} */ ({
  id: adaptersPath,
  filename: adaptersPath,
  path: adaptersPath,
  loaded: true,
  exports: {
    getAdapter: (exchange) => (exchange === 'gemini' ? fakeGeminiAdapter : fakeCoinbaseAdapter),
  },
  children: [],
});
delete require.cache[require.resolve('../src/sync-fills')];
const { getUnaccountedFills } = require('../src/sync-fills');

const fakeFillLedger = {
  hasProcessedTrade: () => false,
  getFillCount: () => 0,
};

const fakeManualTradeStore = {
  isFillDismissed: () => false,
};

describe('getUnaccountedFills pair threading (issue #198)', () => {
  it('queries the fund\'s own symbol for a non-BTC gemini fund, not btcusd', async () => {
    geminiCalls = [];
    const result = await getUnaccountedFills('gemini', fakeFillLedger, fakeManualTradeStore, {
      startDate: '2026-01-01T00:00:00.000Z',
      pair: 'ETHUSD',
    });

    assert.equal(result.success, true);
    assert.equal(geminiCalls.length, 1);
    assert.equal(geminiCalls[0].productId, 'ETHUSD');
  });

  it('lets the adapter choose its legacy default when no pair is supplied', async () => {
    geminiCalls = [];
    const result = await getUnaccountedFills('gemini', fakeFillLedger, fakeManualTradeStore, {
      startDate: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(result.success, true);
    assert.equal(geminiCalls[0].productId, undefined);
  });
});
