// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const optimizerPath = require.resolve('../src/optimizer-engine');
const pending = [];
require.cache[optimizerPath] = {
  id: optimizerPath,
  filename: optimizerPath,
  loaded: true,
  exports: {
    runOptimizer: (options) => new Promise((resolve, reject) => pending.push({ options, resolve, reject })),
    getTopResults: (results) => results,
  },
};
delete require.cache[require.resolve('../src/routes/backtest-routes')];
const registerBacktestRoutes = require('../src/routes/backtest-routes');

const resultFor = (productId, totalValue) => ({
  productId,
  totalCombinations: 1,
  duration: 10,
  bestResult: { params: { intervalType: 'daily', sellMarkupPercent: 2 }, metrics: { totalValue } },
  results: [],
  config: {},
});

describe('optimizer route event scoping', () => {
  it('isolates concurrent runs by runId, exchange, and pair', async () => {
    pending.length = 0;
    let runHandler;
    const events = [];
    registerBacktestRoutes({
      get: () => {},
      delete: () => {},
      post: (path, handler) => { if (path.endsWith('/optimizer/run')) runHandler = handler; },
    }, {
      io: { emit: (name, payload) => events.push({ name, payload }) },
      readJSON: () => null,
      writeJSON: () => {},
      DATA_DIR: '/tmp',
    });

    const responses = [];
    const invoke = (exchange, pair, productId, runId) => runHandler(
      { params: { exchange }, query: { pair }, body: { forceRefresh: true, productId, runId } },
      { json: (body) => responses.push(body) },
    );
    invoke('coinbase', 'BTC-USDC', 'BTC-USDC', 'client_run_123');
    invoke('gemini', 'BTCUSD', 'BTCUSD');

    assert.equal(responses.length, 2);
    assert.equal(responses[0].runId, 'client_run_123');
    assert.notEqual(responses[0].runId, responses[1].runId);
    pending[0].options.onProgress({ current: 1, total: 1, percentComplete: 100, latestResult: resultFor('BTC-USDC', 101).bestResult });
    pending[1].options.onProgress({ current: 1, total: 1, percentComplete: 100, latestResult: resultFor('BTCUSD', 202).bestResult });
    pending[0].resolve(resultFor('BTC-USDC', 101));
    pending[1].resolve(resultFor('BTCUSD', 202));
    await new Promise(resolve => setImmediate(resolve));

    for (const event of events) {
      assert.ok(event.payload.runId, `${event.name} must include a run identity`);
      assert.ok(event.payload.exchange, `${event.name} must include an exchange`);
      assert.ok(event.payload.pair, `${event.name} must include a pair`);
    }
    const completed = events.filter(event => event.name === 'optimizer:complete');
    assert.deepStrictEqual(completed.map(event => event.payload.pair).sort(), ['BTC-USDC', 'BTCUSD']);
    assert.deepStrictEqual(completed.map(event => event.payload.bestResult.metrics.totalValue).sort(), [101, 202]);
  });

  it('rejects a body productId that disagrees with the pair-scoped fund', async () => {
    let optimizerHandler;
    let backtestHandler;
    registerBacktestRoutes({
      get: () => {},
      delete: () => {},
      post: (path, handler) => {
        if (path.endsWith('/optimizer/run')) optimizerHandler = handler;
        if (path.endsWith('/backtest/run')) backtestHandler = handler;
      },
    }, {
      io: { emit: () => {} }, readJSON: () => null, writeJSON: () => {}, DATA_DIR: '/tmp',
    });
    const response = () => ({
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    });
    const request = {
      params: { exchange: 'coinbase' },
      query: { pair: 'BTC-USDC' },
      body: { productId: 'ETH-USD', forceRefresh: true },
    };

    const optimizerRes = response();
    optimizerHandler(request, optimizerRes);
    assert.equal(optimizerRes.statusCode, 400);
    assert.match(optimizerRes.body.error, /selected fund/);

    const backtestRes = response();
    await backtestHandler(request, backtestRes);
    assert.equal(backtestRes.statusCode, 400);
    assert.match(backtestRes.body.error, /selected fund/);
  });
});
