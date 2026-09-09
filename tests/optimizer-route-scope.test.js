// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SimulationRunCoordinator } = require('../src/simulation-run-coordinator');

const optimizerPath = require.resolve('../src/optimizer-engine');
const { compareOptimizerResults } = require(optimizerPath);
const pending = [];
require.cache[optimizerPath] = {
  id: optimizerPath,
  filename: optimizerPath,
  loaded: true,
  exports: {
    compareOptimizerResults,
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
    const invoke = (exchange, pair, _productId, runId) => runHandler(
      { params: { exchange }, query: { pair }, body: { forceRefresh: true, runId } },
      {
        status(code) { this.statusCode = code; return this; },
        json(body) { responses.push(body); return this; },
      },
    );
    invoke('coinbase', 'BTC-USDC', 'BTC-USDC', 'client_run_123');
    invoke('gemini', 'BTCUSD', 'BTCUSD');

    assert.equal(responses.length, 2);
    assert.equal(responses[0].runId, 'client_run_123');
    assert.notEqual(responses[0].runId, responses[1].runId);
    // The coordinator owns the promise lifecycle and schedules the expensive
    // work after the HTTP acknowledgement is sent.
    await new Promise(resolve => setImmediate(resolve));
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

  it('rejects a traversal pair before optimizer work is queued', () => {
    const pendingBefore = pending.length;
    let optimizerHandler;
    registerBacktestRoutes({
      get: () => {}, delete: () => {},
      post: (path, handler) => { if (path.endsWith('/optimizer/run')) optimizerHandler = handler; },
    }, {
      io: { emit: () => {} }, readJSON: () => null, writeJSON: () => {}, DATA_DIR: '/tmp',
    });
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    optimizerHandler({
      params: { exchange: 'coinbase' }, query: { pair: '../keys' }, body: {},
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /invalid pair/i);
    assert.equal(pending.length, pendingBefore);
  });

  it('rejects malformed and duplicate optimizer requests before another job starts', async () => {
    pending.length = 0;
    let optimizerHandler;
    const coordinator = new SimulationRunCoordinator();
    registerBacktestRoutes({
      get: () => {}, delete: () => {},
      post: (path, handler) => { if (path.endsWith('/optimizer/run')) optimizerHandler = handler; },
    }, {
      io: { emit: () => {} }, readJSON: () => null, writeJSON: () => {}, DATA_DIR: '/tmp', simulationCoordinator: coordinator,
    });
    const response = () => ({
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    });
    const request = (body) => ({ params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' }, body });

    const malformed = response();
    optimizerHandler(request({ intervals: ['daily', 'daily'] }), malformed);
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.code, 'INVALID_SIMULATION_REQUEST');
    assert.equal(pending.length, 0);

    const started = response();
    optimizerHandler(request({ intervals: ['daily'], markups: [2], periods: ['30D'] }), started);
    assert.equal(started.body.success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);

    const duplicate = response();
    optimizerHandler(request({ intervals: ['daily'], markups: [2], periods: ['30D'] }), duplicate);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.code, 'SIMULATION_ALREADY_RUNNING');
    pending[0].resolve(resultFor('BTC-USDC', 101));
    await new Promise(resolve => setImmediate(resolve));
  });

  it('reuses a legacy cache whose unused buy amounts were persisted', () => {
    pending.length = 0;
    let optimizerHandler;
    registerBacktestRoutes({
      get: () => {}, delete: () => {},
      post: (path, handler) => { if (path.endsWith('/optimizer/run')) optimizerHandler = handler; },
    }, {
      io: { emit: () => {} },
      readJSON: () => ({
        fundSize: 10000,
        productId: 'BTC-USDC',
        config: {
          intervals: ['daily'], markups: [2], periods: ['30D'],
          buyAmounts: { '5min': 1, '10min': 2, '30min': 10, '1hour': 50, '4hour': 100, daily: 500 },
        },
      }),
      writeJSON: () => {}, DATA_DIR: '/tmp',
    });
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    optimizerHandler({
      params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' },
      body: { intervals: ['daily'], markups: [2], periods: ['30D'], buyAmounts: { daily: 500 } },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cached, true);
    assert.equal(pending.length, 0);
  });
});

describe('optimizer streaming ranking matches completed ranking', () => {
  const record = (period, totalValue, underCovered) => ({
    params: { intervalType: 'daily', sellMarkupPercent: 2, period, underCovered },
    metrics: { totalValue },
  });
  const covered = record('30D', 11000, false);
  const uncovered = record('1Y', 12000, true);
  const improved = record('60D', 11500, false);
  const tied = record('90D', 11500, false);
  const uncoveredImproved = record('90D', 13000, true);
  const uncoveredTied = record('60D', 13000, true);

  for (const { name, records, promotions } of [
    { name: 'covered result arrives first', records: [covered, uncovered], promotions: [covered] },
    { name: 'covered result arrives last', records: [uncovered, covered], promotions: [uncovered, covered] },
    { name: 'same coverage improvements and ties', records: [covered, improved, tied, covered], promotions: [covered, improved] },
    { name: 'all under-covered improvements and ties', records: [uncovered, uncoveredImproved, uncoveredTied, uncovered], promotions: [uncovered, uncoveredImproved] },
  ]) {
    it(name, async () => {
      pending.length = 0;
      let runHandler;
      const events = [];
      const writes = [];
      registerBacktestRoutes({
        get: () => {}, delete: () => {},
        post: (path, handler) => { if (path.endsWith('/optimizer/run')) runHandler = handler; },
      }, {
        io: { emit: (name, payload) => events.push({ name, payload }) },
        readJSON: () => null,
        writeJSON: (path, payload) => writes.push(payload),
        DATA_DIR: '/tmp',
      });
      let acknowledgement;
      runHandler({
        params: { exchange: 'coinbase' }, query: { pair: 'BTC-USDC' },
        body: { forceRefresh: true, runId: 'ranking_run_338' },
      }, {
        json(body) { acknowledgement = body; return this; },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pending.length, 1);
      records.forEach((latestResult, index) => pending[0].options.onProgress({
        current: index + 1, total: records.length,
        percentComplete: (index + 1) / records.length * 100, latestResult,
      }));
      const sorted = [...records].sort(compareOptimizerResults);
      const result = { ...resultFor('BTC-USDC', 0), bestResult: sorted[0], results: sorted };
      pending[0].resolve(result);
      await new Promise(resolve => setImmediate(resolve));

      const winners = events.filter(event => event.name === 'optimizer:newBest');
      assert.deepEqual(winners.map(({ payload }) => ({ params: payload.params, metrics: payload.metrics })), promotions);
      const completed = events.filter(event => event.name === 'optimizer:complete');
      assert.equal(completed.length, 1);
      assert.equal(winners.at(-1).payload.params, completed[0].payload.bestResult.params);
      assert.equal(winners.at(-1).payload.metrics, completed[0].payload.bestResult.metrics);
      for (const { name, payload } of events) {
        assert.equal(payload.runId, acknowledgement.runId);
        assert.equal(payload.exchange, 'coinbase');
        assert.equal(payload.pair, 'BTC-USDC');
        if (name !== 'optimizer:complete') assert.equal(payload.requestKey, acknowledgement.requestKey);
      }
      assert.deepEqual(completed[0].payload.topResults, sorted);
      assert.deepEqual(writes, [completed[0].payload]);
    });
  }
});
