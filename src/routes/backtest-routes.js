// @ts-check
/**
 * Backtest & Optimizer API Routes
 */

const path = require('path');
const backtestEngine = require('../backtest-engine');
const optimizerEngine = require('../optimizer-engine');
const { formatInterval } = require('../interval-utils');
const { getFundConfig, getDefaultPair } = require('../config-utils');
const { log } = require('../logger');

/**
 * @param {import('express').Express} app
 * @param {{io: Object, readJSON: Function, writeJSON: Function, DATA_DIR: string}} deps
 */
module.exports = (app, deps) => {
  const { io, readJSON, writeJSON, DATA_DIR } = deps;

  const getPair = (req) => req.query?.pair || getDefaultPair(req.params.exchange);
  const getOptimizerCacheFile = (exchange, productId) => {
    const slug = (productId || 'default').toLowerCase().replace(/[^a-z0-9]/g, '-');
    return path.join(DATA_DIR, exchange, `optimizer-cache-${slug}.json`);
  };

  // Get historical price data
  app.get('/api/:exchange/backtest/prices', async (req, res) => {
    const { exchange } = req.params;
    const intervals = parseInt(req.query.intervals) || 365;
    const intervalType = req.query.intervalType || 'daily';

    const prices = await backtestEngine.getPriceData(intervals, intervalType, exchange);
    res.json({ success: true, count: prices.length, intervalType, exchange, prices });
  });

  // Run backtest
  app.post('/api/:exchange/backtest/run', async (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const fundConfig = getFundConfig(exchange, pair);
    const configProductId = fundConfig.productId || null;

    const {
      intervalBuyAmount = 500, sellMarkupPercent = 10, holdbackPercent = 5,
      feePercent = 0.125, rebatePercent = 0.031, intervals = 365,
      intervalType = 'daily', fundSize = 0, productId = configProductId,
    } = req.body;

    const fundInfo = fundSize > 0 ? `, $${fundSize} fund` : ', unlimited funds';
    const intervalLabel = formatInterval(intervalType);
    log('INFO', `[${exchange}/${pair}] Running backtest for ${productId}: ${intervals} ${intervalLabel} intervals, $${intervalBuyAmount}/interval, +${sellMarkupPercent}% markup, ${holdbackPercent}% holdback${fundInfo}`);

    const results = await backtestEngine.runBacktest({
      intervalBuyAmount, sellMarkupPercent, holdbackPercent, feePercent, rebatePercent,
      intervals, intervalType, fundSize, exchange, productId,
    });

    log('INFO', `[${exchange}/${pair}] Backtest complete: ROI ${results.metrics.roi.toFixed(2)}%, ${results.metrics.sellsFilled}/${results.metrics.totalSells} sells filled`);
    res.json({ success: true, ...results });
  });

  // Optimizer cache (per-pair)
  app.get('/api/:exchange/optimizer/cache', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const fundConfig = getFundConfig(exchange, pair);
    const cache = readJSON(getOptimizerCacheFile(exchange, fundConfig.productId), null);
    res.json(cache ? { success: true, cached: true, ...cache } : { success: true, cached: false });
  });

  app.delete('/api/:exchange/optimizer/cache', (req, res) => {
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

  // Run optimizer
  let currentBestResult = null;

  app.post('/api/:exchange/optimizer/run', (req, res) => {
    const { exchange } = req.params;
    const pair = getPair(req);
    const fundConfig = getFundConfig(exchange, pair);
    const configProductId = fundConfig.productId || null;

    const {
      fundSize = 10000, forceRefresh = false, productId = configProductId,
      intervals = null, markups = null, periods = null, buyAmounts = null,
    } = req.body;
    const cacheFile = getOptimizerCacheFile(exchange, productId);
    const configKey = JSON.stringify({ intervals, markups, periods });

    if (!forceRefresh) {
      const cache = readJSON(cacheFile, null);
      const cacheConfigKey = JSON.stringify({
        intervals: cache?.config?.intervals,
        markups: cache?.config?.markups,
        periods: cache?.config?.periods,
      });
      if (cache && cache.fundSize === fundSize && cache.productId === productId && configKey === cacheConfigKey) {
        log('INFO', `[${exchange}] Returning cached optimizer results for ${productId}, fund size: $${fundSize}`);
        return res.json({ success: true, cached: true, ...cache });
      }
    }

    const totalTests = (intervals?.length || 6) * (markups?.length || 9) * (periods?.length || 4);
    log('INFO', `[${exchange}] Running optimizer for ${productId} with fund size: $${fundSize} (${totalTests} combinations)`);
    currentBestResult = null;

    res.json({ success: true, streaming: true, message: 'Optimizer started, results will stream via WebSocket' });

    optimizerEngine.runOptimizer({
      fundSize, exchange, forceRefresh, productId, intervals, markups, periods, buyAmounts,
      onProgress: (progress) => {
        io.emit('optimizer:progress', progress);
        if (progress.latestResult) {
          if (!currentBestResult || progress.latestResult.metrics.totalValue > currentBestResult.metrics.totalValue) {
            currentBestResult = progress.latestResult;
            io.emit('optimizer:newBest', currentBestResult);
          }
        }
        if (progress.current % 20 === 0 || progress.phase === 'prefetch') {
          log('INFO', `[${exchange}] Optimizer: ${progress.message} (${progress.percentComplete}%)`);
        }
      },
    })
      .then(result => {
        log('INFO', `[${exchange}] Optimizer complete: ${result.totalCombinations} combinations in ${(result.duration / 1000).toFixed(1)}s`);
        log('INFO', `[${exchange}] Best result: ${result.bestResult.params.intervalType} ${result.bestResult.params.sellMarkupPercent}% markup -> $${result.bestResult.metrics.totalValue.toFixed(2)}`);

        const topResults = optimizerEngine.getTopResults(result.results, 20);
        const response = {
          success: true, cached: false, cachedAt: new Date().toISOString(),
          fundSize, productId: result.productId, totalCombinations: result.totalCombinations,
          duration: result.duration, bestResult: result.bestResult, topResults, config: result.config,
        };

        writeJSON(cacheFile, response);
        log('INFO', `[${exchange}] Optimizer results cached`);
        io.emit('optimizer:complete', response);
      })
      .catch(err => {
        log('ERROR', `[${exchange}] Optimizer failed: ${err.message}`);
        io.emit('optimizer:error', { error: err.message });
      });
  });
};
