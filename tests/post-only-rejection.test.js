// @ts-check
// Finding: three call sites string-matched post-only rejections with
// different, case-sensitive patterns. They now share isPostOnlyRejection.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');

const isolatedData = createIsolatedDataDir('cm-post-only-rejection-test');
after(() => isolatedData.cleanup());

const { isPostOnlyRejection } = require('../src/shared-utils');
const { createOrderExecutor } = require('../src/order-executor');
const { placeSellOrderWithRetry } = require('../src/order-manager');
const { getPlacementIntentsFile } = require('../src/state-tracker');
const fs = require('fs');

const REJECTIONS = [
  'POST_ONLY_REJ',
  'INVALID_LIMIT_PRICE_POST_ONLY',
  'Order would cross the book',
  'post only order rejected',
  'Post Only mode: would immediately match',
  'price is too aggressive',
];

describe('isPostOnlyRejection', () => {
  it('recognises every adapter-style rejection text, case-insensitively', () => {
    for (const text of REJECTIONS) {
      assert.equal(isPostOnlyRejection(text), true, text);
      assert.equal(isPostOnlyRejection(text.toUpperCase()), true, text.toUpperCase());
      assert.equal(isPostOnlyRejection(new Error(text)), true, `Error(${text})`);
    }
  });

  it('rejects unrelated and empty input', () => {
    for (const v of ['insufficient funds', 'rate limited', '', null, undefined, new Error('boom')]) {
      assert.equal(isPostOnlyRejection(v), false, String(v));
    }
  });
});

describe('post-only rejection call paths', () => {
  it('TP placement retries as taker on a Gemini-style "would cross" exception', async () => {
    const calls = [];
    const adapter = {
      placeLimitSell: async (_p, _q, _px, opts) => {
        calls.push(opts);
        if (calls.length === 1) throw new Error('Order would cross the book');
        return { success: true, orderId: 'tp-taker-1' };
      },
    };
    const exec = createOrderExecutor('gemini', {
      tpUpdateThresholdPct: 0.5, orderStaleMs: 30000, cancelRateLimitMs: 0, maxOpenOrders: 20,
    }, adapter, 'BTC-USDC');
    const result = await exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { postOnly: false });
  });

  it('TP placement still rethrows a non-post-only exception', async () => {
    const adapter = { placeLimitSell: async () => { throw new Error('insufficient funds'); } };
    const exec = createOrderExecutor('gemini', {
      tpUpdateThresholdPct: 0.5, orderStaleMs: 30000, cancelRateLimitMs: 0, maxOpenOrders: 20,
    }, adapter, 'BTC-USDC');
    await assert.rejects(() => exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true }), /insufficient funds/);
  });

  const tpConfig = () => ({
    tpUpdateThresholdPct: 0.5, orderStaleMs: 30000, cancelRateLimitMs: 0, maxOpenOrders: 20,
  });

  it('TP taker retry records the take_profit_taker intent and tracks the taker order', async () => {
    const intentActions = [];
    const calls = [];
    const adapter = {
      placeLimitSell: async (_p, _q, _px, opts) => {
        calls.push(opts);
        // The placement intent is persisted before dispatch; capture which action it carries.
        const file = getPlacementIntentsFile('gemini', 'BTC-USDC');
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        intentActions.push(['take_profit_taker', 'take_profit'].find(a => raw.includes(`"${a}"`)) ?? null);
        if (calls.length === 1) throw new Error('POST_ONLY_REJ');
        return { success: true, orderId: 'tp-taker-2' };
      },
    };
    const exec = createOrderExecutor('gemini', tpConfig(), adapter, 'BTC-USDC');
    const result = await exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });
    assert.equal(result.success, true);
    assert.equal(result.orderId, 'tp-taker-2');
    assert.equal(exec._test.getActiveTpOrderId(), 'tp-taker-2');
    assert.equal(exec.isTrackedTpOrder('tp-taker-2'), true);
    assert.deepEqual(calls, [undefined, { postOnly: false }]);
    assert.deepEqual(intentActions, ['take_profit', 'take_profit_taker']);
  });

  it('TP taker retry that also fails surfaces the error with no third attempt and no active TP', async () => {
    let calls = 0;
    const adapter = {
      placeLimitSell: async () => {
        calls++;
        throw new Error(calls === 1 ? 'POST_ONLY_REJ' : 'taker rejected: insufficient funds');
      },
    };
    const exec = createOrderExecutor('gemini', tpConfig(), adapter, 'BTC-USDC');
    await assert.rejects(
      () => exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true }),
      /taker rejected: insufficient funds/,
    );
    assert.equal(calls, 2, 'exactly one maker attempt and one taker retry');
    assert.equal(exec._test.getActiveTpOrderId(), null);

    // A clean (non-thrown) taker failure is reported, not retried a third time.
    let cleanCalls = 0;
    const cleanAdapter = {
      placeLimitSell: async () => {
        cleanCalls++;
        if (cleanCalls === 1) throw new Error('POST_ONLY_REJ');
        return { success: false, errorMessage: 'taker refused' };
      },
    };
    const exec2 = createOrderExecutor('gemini', tpConfig(), cleanAdapter, 'BTC-USDC');
    const result = await exec2.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true });
    assert.equal(result.success, false);
    assert.equal(result.errorMessage, 'taker refused');
    assert.equal(cleanCalls, 2);
    assert.equal(exec2._test.getActiveTpOrderId(), null);
  });

  it('TP placement makes exactly one attempt for a non-post-only exception', async () => {
    let calls = 0;
    const adapter = { placeLimitSell: async () => { calls++; throw new Error('insufficient funds'); } };
    const exec = createOrderExecutor('gemini', tpConfig(), adapter, 'BTC-USDC');
    await assert.rejects(() => exec.placeTakeProfitOrder(0.01, 105000, { forceUpdate: true }), /insufficient funds/);
    assert.equal(calls, 1, 'no taker retry');
    assert.equal(exec._test.getActiveTpOrderId(), null);
  });

  describe('placeEntryBid post-only retry', () => {
    const entryConfig = (over = {}) => ({
      entryOffsetBps: 10, entryMaxRetries: 3, orderStaleMs: 30000, cancelRateLimitMs: 0, maxOpenOrders: 20, ...over,
    });

    it('retries after a post-only rejection with refreshed prices and succeeds on the second attempt', async () => {
      const buyPrices = [];
      let bidAskCalls = 0;
      const adapter = {
        placeLimitBuy: async (_p, _q, price, opts) => {
          buyPrices.push({ price, opts });
          return buyPrices.length === 1
            ? { success: false, errorMessage: 'POST_ONLY_REJ' }
            : { success: true, orderId: 'entry-retry-2' };
        },
        getBidAsk: async () => { bidAskCalls++; return { bid: 99000, ask: 99010 }; },
        getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      };
      const exec = createOrderExecutor('coinbase', entryConfig(), adapter, 'BTC-USDC');
      try {
        const result = await exec.placeEntryBid(1000, 100000, 100010);
        assert.equal(result.success, true);
        assert.equal(result.orderId, 'entry-retry-2');
        assert.equal(buyPrices.length, 2);
        assert.equal(bidAskCalls, 1, 'fresh prices fetched once for the retry');
        assert.ok(buyPrices[1].price < buyPrices[0].price, `retry price ${buyPrices[1].price} should derive from the refreshed bid, not ${buyPrices[0].price}`);
        assert.ok(buyPrices[1].price <= 99000, 'retry price is at or below the refreshed bid');
        assert.deepEqual(buyPrices[1].opts, { postOnly: true });
      } finally {
        exec.clearTimers();
      }
    });

    it('stops retrying after entryMaxRetries and reports the rejection', async () => {
      let buyCalls = 0;
      let bidAskCalls = 0;
      const adapter = {
        placeLimitBuy: async () => { buyCalls++; return { success: false, errorMessage: 'POST_ONLY_REJ' }; },
        getBidAsk: async () => { bidAskCalls++; return { bid: 100000, ask: 100010 }; },
      };
      const exec = createOrderExecutor('coinbase', entryConfig({ entryMaxRetries: 2 }), adapter, 'BTC-USDC');
      const result = await exec.placeEntryBid(1000, 100000, 100010);
      assert.equal(result.success, false);
      assert.equal(result.errorMessage, 'POST_ONLY_REJ');
      assert.equal(buyCalls, 3, 'initial attempt plus entryMaxRetries retries');
      assert.equal(bidAskCalls, 2);
    });

    it('does not retry a non-post-only failure', async () => {
      let buyCalls = 0;
      let bidAskCalls = 0;
      const adapter = {
        placeLimitBuy: async () => { buyCalls++; return { success: false, errorMessage: 'insufficient funds' }; },
        getBidAsk: async () => { bidAskCalls++; return { bid: 100000, ask: 100010 }; },
      };
      const exec = createOrderExecutor('coinbase', entryConfig(), adapter, 'BTC-USDC');
      const result = await exec.placeEntryBid(1000, 100000, 100010);
      assert.equal(result.success, false);
      assert.equal(result.errorMessage, 'insufficient funds');
      assert.equal(buyCalls, 1);
      assert.equal(bidAskCalls, 0);
    });
  });

  it('sell retry bumps priceMultiplier on a Coinbase POST_ONLY_REJ message', async () => {
    const prices = [];
    const adapter = {
      getCurrentPrice: async () => 50000,
      placeLimitSell: async (_p, _q, price) => {
        prices.push(price);
        return prices.length === 1
          ? { success: false, errorMessage: 'POST_ONLY_REJ' }
          : { success: true, orderId: 'sell-2' };
      },
    };
    const config = { productId: 'BTC-USDC', holdbackPercent: 10, sellMarkupPercent: 2 };
    await placeSellOrderWithRetry(config, { assetAmount: 0.01, price: 50000 }, adapter, 2);
    assert.equal(prices.length, 2);
    assert.ok(prices[1] > prices[0] * 1.005, `second price ${prices[1]} should be bumped above ${prices[0]}`);
  });

  it('sell retry skips (does not place) when the adapter price is NaN or 0', async () => {
    for (const bad of [NaN, 0]) {
      let placed = 0;
      const adapter = {
        getCurrentPrice: async () => bad,
        placeLimitSell: async () => { placed++; return { success: true, orderId: 'x' }; },
      };
      const config = { productId: 'BTC-USDC', holdbackPercent: 10, sellMarkupPercent: 2 };
      await assert.rejects(
        () => placeSellOrderWithRetry(config, { assetAmount: 0.01, price: 50000 }, adapter, 1),
        /Invalid current price/,
      );
      assert.equal(placed, 0);
    }
  });
});
