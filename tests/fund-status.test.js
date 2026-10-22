// @ts-check
// buildFundStatus reads balances BEFORE the price, so a PRICE_UNAVAILABLE throw
// still leaves the balances populated and reports the failure in apiError.
const { describe, it, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');

const isolatedData = createIsolatedDataDir('cm-fund-status-test');
after(() => isolatedData.cleanup());

const adapters = require('../src/adapters');
const configUtils = require('../src/config-utils');
const { buildFundStatus } = require('../src/fund-status');
const { createPriceUnavailableError } = require('../src/adapters/base-adapter');

// A SENTINEL pair so no real fund's state is read.
const EXCHANGE = 'coinbase';
const PAIR = '__teststatus__-USDC';

afterEach(() => mock.restoreAll());

const stubAdapter = (adapter) => mock.method(adapters, 'getAdapter', () => adapter);

describe('buildFundStatus', () => {
  it('keeps quote and asset balances and sets apiError when the price is unavailable', async () => {
    // Quote balance is read first, then asset balance, whatever the resolved product is.
    const productId = configUtils.getFundConfig(EXCHANGE, PAIR).productId;
    const calls = [];
    stubAdapter({
      hasValidKeys: () => true,
      getAccountBalance: async (currency) => {
        calls.push(`balance:${currency}`);
        return calls.filter(c => c.startsWith('balance:')).length === 1 ? { available: 500, hold: 25, total: 525 } : { available: 0.5, hold: 0, total: 0.5 };
      },
      getCurrentPrice: async () => {
        calls.push('price');
        throw createPriceUnavailableError('coinbase', productId, '');
      },
    });

    const status = await buildFundStatus(EXCHANGE, PAIR, '/api/:exchange/status');

    assert.match(status.apiError, /Price temporarily unavailable from coinbase/);
    assert.equal(status.keysConfigured, true);
    assert.equal(status.currentPrice, 0);
    assert.deepEqual(status.quoteBalance, { available: 500, hold: 25, total: 525 });
    assert.deepEqual(status.assetBalance, { available: 0.5, hold: 0, total: 0.5 });
    assert.equal(calls.at(-1), 'price', 'the price is read last, after both balances');
    assert.equal(calls.filter(c => c.startsWith('balance:')).length, 2);
  });

  it('reports price and balances with no apiError on success', async () => {
    stubAdapter({
      hasValidKeys: () => true,
      getAccountBalance: async () => ({ available: 10, hold: 0, total: 10 }),
      getCurrentPrice: async () => 50000,
    });
    const status = await buildFundStatus(EXCHANGE, PAIR, '/api/:exchange/status');
    assert.equal(status.apiError, null);
    assert.equal(status.currentPrice, 50000);
    assert.deepEqual(status.quoteBalance, { available: 10, hold: 0, total: 10 });
  });

  it('does not call the exchange when keys are not configured', async () => {
    let calls = 0;
    const count = async () => { calls++; return 1; };
    stubAdapter({ hasValidKeys: () => false, getAccountBalance: count, getCurrentPrice: count });
    const status = await buildFundStatus(EXCHANGE, PAIR, '/api/:exchange/status');
    assert.equal(status.keysConfigured, false);
    assert.equal(status.apiError, null);
    assert.equal(calls, 0);
  });
});
