// @ts-check
/**
 * Backtest & Optimizer API Routes
 */

const path = require('path');
const { randomUUID } = require('crypto');
const backtestEngine = require('../backtest-engine');
const optimizerEngine = require('../optimizer-engine');
const { formatInterval } = require('../interval-utils');
const { getFundConfig } = require('../config-utils');
const { log } = require('../logger');
const { withConfiguredPair } = require('./route-utils');
const {
  validatePriceQuery,
  validateBacktestInput,
  validateOptimizerInput,
  normalizeOptimizerConfig,
  optimizerRequestKey,
} = require('../simulation-policy');
const { SimulationRunCoordinator } = require('../simulation-run-coordinator');

/**
 * @param {import('express').Express} app
 * @param {{io: Object, readJSON: Function, writeJSON: Function, DATA_DIR: string}} deps
 */
module.exports = (app, deps) => {
  const { io, readJSON, writeJSON, DATA_DIR, simulationCoordinator = new SimulationRunCoordinator() } = deps;

  const getPair = (req) => req.fundPair;
  const registerPairRoute = (method) => (route, handler) => app[method](route, withConfiguredPair(handler));
  const pairGet = registerPairRoute('get');
  const pairPost = registerPairRoute('post');
  const pairDelete = registerPairRoute('delete');
  const getOptimizerCacheFile = (exchange, productId) => {
    const slug = (productId || 'default').toLowerCase().replace(/[^a-z0-9]/g, '-');
    return path.join(DATA_DIR, exchange, `optimizer-cache-${slug}.json`);
  };
  const rejectAdmission = (res, admission) => {
    res.set?.('Retry-After', String(admission.retryAfter));
    return res.status(admission.status).json({ success: false, error: admission.error, code: admission.code, retryAfter: admission.retryAfter });
  };

  // Get historical price data
  app.get('/api/:exchange/backtest/prices', async (req, res) => {
    const { exchange } = req.params;
    const validation = validatePriceQuery(req.query);
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error, code: validation.code });
    const { intervals, intervalType } = validation.value;

    const admission = simulationCoordinator.start({
      resourceKey: `prices:${exchange}`,
      requestKey: JSON.stringify({ exchange, intervals, intervalType }),
    }, () => backtestEngine.getPriceData(intervals, intervalType, exchange));
    if (!admission.accepted) return rejectAdmission(res, admission);
    const prices = await admission.promise;
    res.json({ success: true, count: prices.length, intervalType, exchange, prices });
  });

  // Run backtest
  pairPost('/api/:exchange/backtest/run', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const body = req.body || {};
    const fundConfig = getFundConfig(exchange, pair);
    const configProductId = fundConfig.productId || pair;

    if (body.productId !== undefined && body.productId !== configProductId) {
      return res.status(400).json({
        success: false,
        error: `productId must match the selected fund (${configProductId})`,
      });
    }

    const validation = validateBacktestInput(body);
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error, code: validation.code });
    const { intervalBuyAmount, sellMarkupPercent, holdbackPercent, feePercent, rebatePercent, intervals, intervalType, fundSize } = validation.value;
    const productId = configProductId;

    const fundInfo = fundSize > 0 ? `, $${fundSize} fund` : ', unlimited funds';
    const intervalLabel = formatInterval(intervalType);
    log('INFO', `[${exchange}/${pair}] Running backtest for ${productId}: ${intervals} ${intervalLabel} intervals, $${intervalBuyAmount}/interval, +${sellMarkupPercent}% markup, ${holdbackPercent}% holdback${fundInfo}`);

    const admission = simulationCoordinator.start({
      resourceKey: `fund:${exchange}:${pair}`,
      requestKey: JSON.stringify({ exchange, pair, productId, ...validation.value }),
    }, () => backtestEngine.runBacktest({
      intervalBuyAmount, sellMarkupPercent, holdbackPercent, feePercent, rebatePercent,
      intervals, intervalType, fundSize, exchange, productId,
    }));
    if (!admission.accepted) return rejectAdmission(res, admission);
    const results = await admission.promise;

    log('INFO', `[${exchange}/${pair}] Backtest complete: ROI ${results.metrics.roi.toFixed(2)}%, ${results.metrics.sellsFilled}/${results.metrics.totalSells} sells filled`);
    res.json({ success: true, ...results });
  });

  // Optimizer cache (per-pair)
  pairGet('/api/:exchange/optimizer/cache', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const fundConfig = getFundConfig(exchange, pair);
    const cache = readJSON(getOptimizerCacheFile(exchange, fundConfig.productId), null);
    res.json(cache ? { success: true, cached: true, ...cache } : { success: true, cached: false });
  });

  pairDelete('/api/:exchange/optimizer/cache', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const fundConfig = getFundConfig(exchange, pair);
    const fs = require('fs');
    const cacheFile = getOptimizerCacheFile(exchange, fundConfig.productId);
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
      log('INFO', `[${exchange}/${pair}] Optimizer cache cleared`);
    }
    res.json({ success: true, message: 'Cache cleared' });
  });

  pairPost('/api/:exchange/optimizer/run', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const body = req.body || {};
    const fundConfig = getFundConfig(exchange, pair);
    const configProductId = fundConfig.productId || pair;

    if (body.productId !== undefined && body.productId !== configProductId) {
      return res.status(400).json({
        success: false,
        error: `productId must match the selected fund (${configProductId})`,
      });
    }

    const validation = validateOptimizerInput(body);
    if (!validation.ok) return res.status(400).json({ success: false, error: validation.error, code: validation.code });
    const { fundSize, forceRefresh, intervals, markups, periods, buyAmounts, combinations } = validation.value;
    const productId = configProductId;
    const { runId: requestedRunId } = body;
    const cacheFile = getOptimizerCacheFile(exchange, productId);
    const configKey = JSON.stringify({ intervals, markups, periods, buyAmounts });
    const runId = typeof requestedRunId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(requestedRunId)
      ? requestedRunId
      : randomUUID();

    if (!forceRefresh) {
      const cache = readJSON(cacheFile, null);
      const cacheConfig = normalizeOptimizerConfig(cache?.config);
      const cacheConfigKey = cacheConfig && JSON.stringify(cacheConfig);
      if (cache && cache.fundSize === fundSize && cache.productId === productId && configKey === cacheConfigKey) {
        log('INFO', `[${exchange}] Returning cached optimizer results for ${productId}, fund size: $${fundSize}`);
        return res.json({ success: true, cached: true, ...cache });
      }
    }

    const requestKey = optimizerRequestKey({ exchange, pair, productId, ...validation.value });
    let currentBestResult = null;
    const admission = simulationCoordinator.start({
      resourceKey: `fund:${exchange}:${pair}`,
      requestKey,
      forceRefresh,
    }, () => optimizerEngine.runOptimizer({
      fundSize, exchange, forceRefresh, productId, intervals, markups, periods, buyAmounts,
      onProgress: (progress) => {
        io.emit('optimizer:progress', { ...progress, runId, exchange, pair, requestKey });
        if (progress.latestResult) {
          if (!currentBestResult || progress.latestResult.metrics.totalValue > currentBestResult.metrics.totalValue) {
            currentBestResult = progress.latestResult;
            io.emit('optimizer:newBest', { ...currentBestResult, runId, exchange, pair, requestKey });
          }
        }
        if (progress.current % 20 === 0 || progress.phase === 'prefetch') {
          log('INFO', `[${exchange}] Optimizer: ${progress.message} (${progress.percentComplete}%)`);
        }
      },
    }));
    if (!admission.accepted) return rejectAdmission(res, admission);

    log('INFO', `[${exchange}] Running optimizer for ${productId} with fund size: $${fundSize} (${combinations} combinations)`);

    res.json({ success: true, streaming: true, runId, requestKey, exchange, pair, message: 'Optimizer started, results will stream via WebSocket' });

    admission.promise
      .then(result => {
        log('INFO', `[${exchange}] Optimizer complete: ${result.totalCombinations} combinations in ${(result.duration / 1000).toFixed(1)}s`);
        log('INFO', `[${exchange}] Best result: ${result.bestResult.params.intervalType} ${result.bestResult.params.sellMarkupPercent}% markup -> $${result.bestResult.metrics.totalValue.toFixed(2)}`);

        const topResults = optimizerEngine.getTopResults(result.results, 20);
        const response = {
          success: true, cached: false, cachedAt: new Date().toISOString(),
          fundSize, productId: result.productId, totalCombinations: result.totalCombinations,
          duration: result.duration, bestResult: result.bestResult, topResults, config: result.config,
          runId, exchange, pair,
        };

        writeJSON(cacheFile, response);
        log('INFO', `[${exchange}] Optimizer results cached`);
        io.emit('optimizer:complete', response);
      })
      .catch(err => {
        log('ERROR', `[${exchange}] Optimizer failed: ${err.message}`);
        io.emit('optimizer:error', { error: err.message, runId, exchange, pair });
      });
  });
};
