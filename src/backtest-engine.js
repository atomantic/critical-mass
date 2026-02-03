const fs = require('fs');
const path = require('path');
const { getIntervalConfig } = require('./interval-utils');
const { getAuthHeaders } = require('./auth');
const { getExchangeDataDir } = require('./migration');
const { getAdapter } = require('./adapters');
const axios = require('axios');
const { getFibonacciBuyAmount, getAverageCostBasis, getFibonacciSellPrice, getFibonacciSellQuantity } = require('./fibonacci-utils');

const BASE_URL = 'https://api.coinbase.com';

// Granularity config used by both exchanges (Coinbase format is the canonical)
// Valid: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, TWO_HOUR, ONE_DAY
const GRANULARITY = {
  '5min': { value: 'FIVE_MINUTE', seconds: 300 },
  '10min': { value: 'FIVE_MINUTE', seconds: 300 },
  '30min': { value: 'THIRTY_MINUTE', seconds: 1800 },
  '1hour': { value: 'ONE_HOUR', seconds: 3600 },
  '4hour': { value: 'ONE_HOUR', seconds: 3600 },   // Use 1-hour candles, aggregate to 4-hour
  'daily': { value: 'ONE_DAY', seconds: 86400 }
};

// Default product IDs by exchange (used if not specified)
const DEFAULT_PRODUCT_IDS = {
  coinbase: 'BTC-USDC',
  gemini: 'BTCUSD',
  cryptocom: 'BTC_USDT'
};

/**
 * Load API credentials from keys.json
 */
const loadCredentials = () => {
  const keys = require('../keys.json');
  return {
    apiKey: keys.name || keys.apiKey,
    apiSecret: keys.privateKey || keys.apiSecret
  };
};

/**
 * Make authenticated request to Coinbase API
 */
const makeRequest = async (method, apiPath) => {
  const { apiKey, apiSecret } = loadCredentials();
  const headers = getAuthHeaders(apiKey, apiSecret, method, apiPath);

  return axios({ method, url: `${BASE_URL}${apiPath}`, headers })
    .then(response => response.data)
    .catch(err => {
      const status = err.response?.status || 'unknown';
      const message = err.response?.data?.message || err.response?.data?.error || err.message;
      const errorDetails = err.response?.data?.error_details || '';
      throw new Error(`Coinbase API error (${status}): ${message}${errorDetails ? ` - ${errorDetails}` : ''}`);
    });
};

/**
 * Fetch candles from Coinbase Advanced Trade API
 * @param {string} productId - Product ID (e.g., 'BTC-USDC')
 * @param {number} start - Start timestamp (seconds)
 * @param {number} end - End timestamp (seconds)
 * @param {string} granularity - Candle granularity (e.g., 'FIVE_MINUTE')
 * @returns {Promise<Array>} Array of candle data
 */
const fetchCoinbaseCandles = async (productId, start, end, granularity) => {
  const apiPath = `/api/v3/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`;
  const data = await makeRequest('GET', apiPath);
  return (data.candles || []).map(c => ({
    timestamp: parseInt(c.start) * 1000,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume)
  }));
};

/**
 * Fetch candles using exchange adapter
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {number} start - Start timestamp (seconds)
 * @param {number} end - End timestamp (seconds)
 * @param {string} granularity - Candle granularity (Coinbase format, e.g., 'FIVE_MINUTE')
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 * @returns {Promise<Array>} Array of candle data
 */
const fetchCandles = async (exchange, start, end, granularity, productId = null) => {
  const effectiveProductId = productId || DEFAULT_PRODUCT_IDS[exchange] || DEFAULT_PRODUCT_IDS.coinbase;

  if (exchange === 'coinbase') {
    return fetchCoinbaseCandles(effectiveProductId, start, end, granularity);
  }

  // Use adapter for other exchanges (e.g., Gemini, Crypto.com)
  const adapter = getAdapter(exchange);
  return adapter.getCandles(effectiveProductId, start, end, granularity);
};

/**
 * Aggregate candles to a larger interval
 * @param {Array} candles - Array of candle data
 * @param {number} factor - Aggregation factor (e.g., 2 for 5min -> 10min)
 * @returns {Array} Aggregated candles
 */
const aggregateCandles = (candles, factor) => {
  if (factor <= 1) return candles;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const result = [];

  for (let i = 0; i < sorted.length; i += factor) {
    const group = sorted.slice(i, i + factor);
    if (group.length === 0) continue;

    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0)
    });
  }

  return result;
};

/**
 * Fetch price data for backtesting
 * @param {number} intervals - Number of intervals to fetch
 * @param {string} intervalType - Interval type (10min, 1hour, 4hour, daily)
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 * @returns {Promise<Array>} Array of price data
 */
const fetchPriceData = async (intervals, intervalType = 'daily', exchange = 'coinbase', productId = null) => {
  const config = getIntervalConfig(intervalType);
  const granConfig = GRANULARITY[intervalType];
  const { aggregateFactor } = config;
  const effectiveProductId = productId || DEFAULT_PRODUCT_IDS[exchange] || DEFAULT_PRODUCT_IDS.coinbase;

  // Calculate raw candles needed (accounting for aggregation)
  const rawCandlesNeeded = intervals * aggregateFactor;

  // Limit candles per request (300 for Coinbase, Gemini returns less but we'll batch similarly)
  const candlesPerRequest = 300;
  const now = Math.floor(Date.now() / 1000);
  const allCandles = [];

  console.log(`Fetching ${rawCandlesNeeded} ${granConfig.value} candles for ${effectiveProductId} from ${exchange} (${intervals} ${intervalType} intervals)...`);

  let end = now;
  let remaining = rawCandlesNeeded;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, candlesPerRequest);
    const start = end - (batchSize * granConfig.seconds);

    const candles = await fetchCandles(exchange, start, end, granConfig.value, effectiveProductId)
      .catch(err => {
        console.error(`Error fetching candles from ${exchange}: ${err.message}`);
        return []; // Return empty to continue with partial data
      });

    if (candles.length === 0 && exchange !== 'coinbase') {
      // Non-Coinbase exchanges may have limited historical data
      console.warn(`No more candles available from ${exchange} (may have reached API limit)`);
      break;
    }

    allCandles.push(...candles);

    remaining -= batchSize;
    end = start;

    // Small delay to avoid rate limiting
    if (remaining > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Sort by timestamp ascending
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  // Aggregate if needed (e.g., 5min -> 10min or 1hour -> 4hour)
  const aggregated = aggregateCandles(allCandles, aggregateFactor);

  // Format for backtest
  return aggregated.slice(-intervals).map(c => ({
    date: new Date(c.timestamp).toISOString(),
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    highOfDay: c.high,
    lowOfDay: c.low
  }));
};

/**
 * Get cache file path for interval type, exchange, and product
 * @param {string} intervalType - Interval type
 * @param {string} exchange - Exchange name (default: coinbase)
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 * @returns {string} Cache file path
 */
const getCacheFile = (intervalType, exchange = 'coinbase', productId = null) => {
  const cacheDir = getExchangeDataDir(exchange);
  // Normalize productId for filename (replace special chars)
  const productSlug = (productId || DEFAULT_PRODUCT_IDS[exchange] || 'BTC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-');
  return path.join(cacheDir, `${productSlug}-price-cache-${intervalType}.json`);
};

/**
 * Load cached price data, fetching only new data since last fetch
 * Historical data never expires - we only append new intervals
 * @param {number} intervals - Number of intervals needed
 * @param {string} intervalType - Interval type
 * @param {string} exchange - Exchange name (default: coinbase)
 * @param {Object} options - Additional options
 * @param {boolean} options.preferCache - If true, use cached data without fetching new intervals (for optimizer)
 * @param {string} options.productId - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 * @returns {Promise<Array>} Price data array
 */
const getPriceData = async (intervals, intervalType = 'daily', exchange = 'coinbase', options = {}) => {
  const { preferCache = false, productId = null } = options;
  const effectiveProductId = productId || DEFAULT_PRODUCT_IDS[exchange] || DEFAULT_PRODUCT_IDS.coinbase;
  const cacheFile = getCacheFile(intervalType, exchange, effectiveProductId);
  const cacheDir = getExchangeDataDir(exchange);
  const granConfig = GRANULARITY[intervalType];
  const config = getIntervalConfig(intervalType);
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  let cache = null;
  let cachedPrices = [];

  // Load existing cache if available
  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cachedPrices = cache.prices || [];
  }

  // If preferCache is set and we have enough cached data, use it without fetching
  if (preferCache && cachedPrices.length >= intervals) {
    console.log(`Using cached ${intervalType} data for ${effectiveProductId} from ${exchange} (${cachedPrices.length} intervals, preferCache=true)`);
    return cachedPrices.slice(-intervals);
  }

  // Determine what we need to fetch
  let needsFetch = false;
  let fetchStartSeconds = null;
  let fetchReason = '';

  if (cachedPrices.length === 0) {
    // No cache - fetch everything
    needsFetch = true;
    fetchReason = 'No cached data';
  } else {
    // Check if we need more historical data (older than what we have)
    const oldestCached = cachedPrices[0].timestamp;
    const neededStart = now - (intervals * config.ms);

    if (neededStart < oldestCached) {
      // Need older data - refetch everything for simplicity
      needsFetch = true;
      fetchReason = `Need older data (have from ${new Date(oldestCached).toISOString().split('T')[0]})`;
    } else if (!preferCache) {
      // Only check for newer data if not preferring cache
      const newestCached = cachedPrices[cachedPrices.length - 1].timestamp;
      const timeSinceNewest = now - newestCached;

      // If more than one interval has passed since newest cached data, fetch new data
      if (timeSinceNewest > config.ms) {
        fetchStartSeconds = Math.floor(newestCached / 1000);
        needsFetch = true;
        fetchReason = `Fetching ${Math.floor(timeSinceNewest / config.ms)} new intervals`;
      }
    }
  }

  if (needsFetch) {
    console.log(`${intervalType} cache: ${fetchReason}`);

    if (fetchStartSeconds) {
      // Incremental fetch - only get new data
      const newCandles = [];
      let end = nowSeconds;
      const candlesPerRequest = 300;

      while (end > fetchStartSeconds) {
        const batchSize = Math.min(candlesPerRequest, Math.ceil((end - fetchStartSeconds) / granConfig.seconds));
        const start = Math.max(fetchStartSeconds, end - (batchSize * granConfig.seconds));

        const candles = await fetchCandles(exchange, start, end, granConfig.value, effectiveProductId);
        newCandles.push(...candles);

        end = start;
        if (end > fetchStartSeconds) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      // Filter out duplicates and merge
      const existingTimestamps = new Set(cachedPrices.map(p => p.timestamp));
      const uniqueNewCandles = newCandles.filter(c => !existingTimestamps.has(c.timestamp));

      if (uniqueNewCandles.length > 0) {
        console.log(`Adding ${uniqueNewCandles.length} new ${intervalType} candles for ${effectiveProductId} to ${exchange} cache`);

        // Aggregate if needed
        const aggregated = aggregateCandles(uniqueNewCandles, config.aggregateFactor);
        const formatted = aggregated.map(c => ({
          date: new Date(c.timestamp).toISOString(),
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          highOfDay: c.high,
          lowOfDay: c.low
        }));

        cachedPrices = [...cachedPrices, ...formatted].sort((a, b) => a.timestamp - b.timestamp);
      }
    } else {
      // Full fetch - pass exchange and productId to fetchPriceData
      cachedPrices = await fetchPriceData(intervals, intervalType, exchange, effectiveProductId);
    }

    // Save updated cache
    const cacheData = {
      lastFetch: new Date().toISOString(),
      intervalType,
      exchange,
      productId: effectiveProductId,
      intervals: cachedPrices.length,
      prices: cachedPrices
    };

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  } else {
    console.log(`Using cached ${intervalType} data for ${effectiveProductId} from ${exchange} (${cachedPrices.length} intervals)`);
  }

  // Return the requested number of intervals from the end
  return cachedPrices.slice(-intervals);
};

/**
 * Run backtest simulation
 * @param {Object} params - Backtest parameters
 * @param {Array} [preFetchedPrices] - Optional pre-fetched price data (from optimizer cache)
 * @returns {Object} Backtest results
 */
const runBacktest = async (params, preFetchedPrices = null) => {
  const {
    intervalBuyAmount = 500,
    sellMarkupPercent = 10,
    holdbackPercent = 5,
    feePercent = 0.125,
    rebatePercent = 0.031,
    intervals = 365,
    intervalType = 'daily',
    fundSize = 0, // 0 = unlimited funds
    exchange = 'coinbase',
    productId = null, // e.g., 'BTC-USDC', 'CRO_USD'
    dcaStrategy = 'fixed', // 'fixed' or 'fibonacci'
    fibBaseAmount = 10 // Base amount for Fibonacci multiplier
  } = params;

  const isFibonacci = dcaStrategy === 'fibonacci';

  const effectiveProductId = productId || DEFAULT_PRODUCT_IDS[exchange] || DEFAULT_PRODUCT_IDS.coinbase;

  // Use pre-fetched prices if provided (from optimizer), otherwise fetch
  const priceData = preFetchedPrices || await getPriceData(intervals, intervalType, exchange, { productId: effectiveProductId });

  if (priceData.length === 0) {
    throw new Error('No price data available');
  }

  // Simulation state
  const hasFixedFund = fundSize > 0;
  let availableFunds = hasFixedFund ? fundSize : Infinity;
  let usdcBalance = 0;
  let btcReserves = 0;
  let totalInvested = 0;
  let totalFees = 0;
  let totalRebates = 0;
  let intervalsSkipped = 0;
  const pendingOrders = [];
  const transactions = [];
  const intervalSnapshots = [];

  // Fibonacci-specific state
  let fibPosition = 0;
  let fibCumulativeCost = 0;
  let fibCumulativeBTC = 0;
  let fibActiveSellOrder = null;
  let fibCyclesCompleted = 0;
  let fibTotalBuys = 0;

  // Calculated rates
  const netFeePercent = feePercent - rebatePercent;
  const sellMultiplier = 1 + (sellMarkupPercent / 100);
  const holdbackRate = holdbackPercent / 100;

  // Get interval config for time calculations
  const intervalConfig = getIntervalConfig(intervalType);
  const intervalMs = intervalConfig.ms;

  // Process each interval
  for (let i = 0; i < priceData.length; i++) {
    const interval = priceData[i];
    const { date, high, low, close: closePrice, highOfDay: highPrice } = interval;
    const midPrice = (high + low) / 2;

    // 1. SELL CHECK PHASE - Check if any pending orders fill this interval
    const filledThisInterval = [];

    if (isFibonacci && fibActiveSellOrder) {
      // Fibonacci: check consolidated sell order
      if (highPrice >= fibActiveSellOrder.sellTargetPrice) {
        const grossProceeds = fibActiveSellOrder.sellBTC * fibActiveSellOrder.sellTargetPrice;
        const sellFee = grossProceeds * (feePercent / 100);
        const sellRebate = grossProceeds * (rebatePercent / 100);
        const netSellFee = sellFee - sellRebate;
        const netProceeds = grossProceeds - netSellFee;

        const msToFill = new Date(date) - new Date(fibActiveSellOrder.cycleStartDate);
        const intervalsToFill = Math.round(msToFill / intervalMs);
        const realizedPnL = netProceeds - (fibActiveSellOrder.sellBTC * fibActiveSellOrder.costBasisPerBTC);

        totalFees += sellFee;
        totalRebates += sellRebate;

        if (hasFixedFund) {
          availableFunds += netProceeds;
        } else {
          usdcBalance += netProceeds;
        }

        transactions.push({
          date,
          type: 'FIB_SELL_FILLED',
          price: fibActiveSellOrder.sellTargetPrice,
          btcAmount: -fibActiveSellOrder.sellBTC,
          usdcAmount: netProceeds,
          fee: sellFee,
          rebate: sellRebate,
          realizedPnL,
          intervalsToFill,
          fibPosition: fibPosition,
          fibBuysInCycle: fibActiveSellOrder.buysInCycle,
          availableFunds: hasFixedFund ? availableFunds : null
        });

        // Reset Fibonacci cycle
        fibCyclesCompleted++;
        fibPosition = 0;
        fibCumulativeCost = 0;
        fibCumulativeBTC = 0;
        fibActiveSellOrder = null;
      }
    } else if (!isFibonacci) {
      // Fixed strategy: check individual orders
      for (let j = pendingOrders.length - 1; j >= 0; j--) {
        const order = pendingOrders[j];
        if (highPrice >= order.sellTargetPrice) {
          const grossProceeds = order.sellBTC * order.sellTargetPrice;
          const sellFee = grossProceeds * (feePercent / 100);
          const sellRebate = grossProceeds * (rebatePercent / 100);
          const netSellFee = sellFee - sellRebate;
          const netProceeds = grossProceeds - netSellFee;

          // Calculate intervals to fill based on interval type
          const msToFill = new Date(date) - new Date(order.buyDate);
          const intervalsToFill = Math.round(msToFill / intervalMs);
          const realizedPnL = netProceeds - (order.sellBTC * order.costBasisPerBTC);

          totalFees += sellFee;
          totalRebates += sellRebate;

          if (hasFixedFund) {
            availableFunds += netProceeds;
          } else {
            usdcBalance += netProceeds;
          }

          transactions.push({
            date,
            type: 'SELL_FILLED',
            price: order.sellTargetPrice,
            btcAmount: -order.sellBTC,
            usdcAmount: netProceeds,
            fee: sellFee,
            rebate: sellRebate,
            realizedPnL,
            intervalsToFill,
            buyDate: order.buyDate,
            availableFunds: hasFixedFund ? availableFunds : null
          });

          filledThisInterval.push(order);
          pendingOrders.splice(j, 1);
        }
      }
    }

    // 2. BUY PHASE - Execute buy at mid price
    const buyPrice = midPrice;

    // Calculate buy amount based on strategy
    const targetBuyAmount = isFibonacci
      ? getFibonacciBuyAmount(fibPosition, fibBaseAmount)
      : intervalBuyAmount;

    if (availableFunds >= targetBuyAmount) {
      const grossBTC = targetBuyAmount / buyPrice;
      const buyFee = targetBuyAmount * (feePercent / 100);
      const buyRebate = targetBuyAmount * (rebatePercent / 100);
      const netBuyFee = buyFee - buyRebate;
      const costBasis = targetBuyAmount + netBuyFee;
      const costBasisPerBTC = costBasis / grossBTC;

      if (hasFixedFund) {
        availableFunds -= targetBuyAmount;
      }

      totalInvested += targetBuyAmount;
      totalFees += buyFee;
      totalRebates += buyRebate;

      if (isFibonacci) {
        // Fibonacci strategy: accumulate and update consolidated sell order
        fibCumulativeCost += costBasis;
        fibCumulativeBTC += grossBTC;
        fibTotalBuys++;

        // Calculate holdback and sell amounts based on cumulative position
        const cumulativeHoldback = fibCumulativeBTC * holdbackRate;
        const sellBTC = getFibonacciSellQuantity(fibCumulativeBTC, holdbackPercent);
        const avgCostBasis = getAverageCostBasis(fibCumulativeCost, fibCumulativeBTC);
        const sellTargetPrice = getFibonacciSellPrice(avgCostBasis, sellMarkupPercent);

        // Track holdback delta for this buy
        const prevHoldback = fibActiveSellOrder ? fibActiveSellOrder.cumulativeHoldback : 0;
        const holdbackDelta = cumulativeHoldback - prevHoldback;
        btcReserves += holdbackDelta;

        // Update or create consolidated sell order
        fibActiveSellOrder = {
          sellBTC,
          sellTargetPrice,
          costBasisPerBTC: avgCostBasis,
          cycleStartDate: fibActiveSellOrder ? fibActiveSellOrder.cycleStartDate : date,
          buysInCycle: (fibActiveSellOrder ? fibActiveSellOrder.buysInCycle : 0) + 1,
          cumulativeHoldback
        };

        transactions.push({
          date,
          type: 'FIB_BUY',
          price: buyPrice,
          btcAmount: grossBTC,
          usdcAmount: -targetBuyAmount,
          fee: buyFee,
          rebate: buyRebate,
          fibPosition,
          fibCumulativeBTC,
          fibCumulativeCost,
          avgCostBasis,
          sellTargetPrice,
          availableFunds: hasFixedFund ? availableFunds : null
        });

        fibPosition++;
      } else {
        // Fixed strategy: individual sell order per buy
        const holdbackBTC = grossBTC * holdbackRate;
        const sellBTC = grossBTC - holdbackBTC;
        const sellTargetPrice = buyPrice * sellMultiplier;

        btcReserves += holdbackBTC;

        pendingOrders.push({
          sellBTC,
          sellTargetPrice,
          costBasisPerBTC,
          buyDate: date,
          buyPrice
        });

        transactions.push({
          date,
          type: 'BUY',
          price: buyPrice,
          btcAmount: grossBTC,
          usdcAmount: -targetBuyAmount,
          fee: buyFee,
          rebate: buyRebate,
          holdbackBTC,
          sellTargetPrice,
          availableFunds: hasFixedFund ? availableFunds : null
        });
      }
    } else {
      intervalsSkipped++;
      transactions.push({
        date,
        type: isFibonacci ? 'FIB_SKIP_NO_FUNDS' : 'SKIP_NO_FUNDS',
        price: buyPrice,
        btcAmount: 0,
        usdcAmount: 0,
        availableFunds: availableFunds,
        requiredFunds: targetBuyAmount,
        fibPosition: isFibonacci ? fibPosition : undefined
      });
    }

    // 3. INTERVAL SNAPSHOT
    const btcOnOrders = isFibonacci
      ? (fibActiveSellOrder ? fibActiveSellOrder.sellBTC : 0)
      : pendingOrders.reduce((sum, o) => sum + o.sellBTC, 0);
    const totalBTC = btcReserves + btcOnOrders;
    const btcValue = totalBTC * closePrice;
    const cashOnHand = hasFixedFund ? availableFunds : usdcBalance;
    const totalValue = cashOnHand + btcValue;

    const snapshot = {
      date,
      btcPrice: closePrice,
      usdcBalance: cashOnHand,
      btcReserves,
      btcOnOrders,
      totalBTC,
      btcValue,
      totalValue,
      totalInvested,
      pendingOrderCount: isFibonacci ? (fibActiveSellOrder ? 1 : 0) : pendingOrders.length,
      availableFunds: hasFixedFund ? availableFunds : null,
      intervalsSkipped
    };

    // Add Fibonacci-specific snapshot data
    if (isFibonacci) {
      snapshot.fibPosition = fibPosition;
      snapshot.fibCyclesCompleted = fibCyclesCompleted;
      snapshot.fibCumulativeBTC = fibCumulativeBTC;
    }

    intervalSnapshots.push(snapshot);
  }

  // Final calculations
  const finalPrice = priceData[priceData.length - 1].close;
  const btcOnOrders = isFibonacci
    ? (fibActiveSellOrder ? fibActiveSellOrder.sellBTC : 0)
    : pendingOrders.reduce((sum, o) => sum + o.sellBTC, 0);
  const totalBTC = btcReserves + btcOnOrders;
  const btcValue = totalBTC * finalPrice;
  const finalCash = hasFixedFund ? availableFunds : usdcBalance;
  const totalValue = finalCash + btcValue;

  const roiBasis = hasFixedFund ? fundSize : totalInvested;
  const roi = ((totalValue - roiBasis) / roiBasis) * 100;

  const sellFilledType = isFibonacci ? 'FIB_SELL_FILLED' : 'SELL_FILLED';
  const buyType = isFibonacci ? 'FIB_BUY' : 'BUY';

  const sellsFilled = transactions.filter(t => t.type === sellFilledType).length;
  const totalBuys = transactions.filter(t => t.type === buyType).length;
  const fillRate = isFibonacci
    ? (fibCyclesCompleted > 0 ? 100 : 0) // Fibonacci: cycles completed
    : (totalBuys > 0 ? (sellsFilled / totalBuys) * 100 : 0);

  const fillTimes = transactions
    .filter(t => t.type === sellFilledType)
    .map(t => t.intervalsToFill);
  const avgIntervalsToFill = fillTimes.length > 0
    ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
    : null;

  const result = {
    params: {
      intervalBuyAmount: isFibonacci ? null : intervalBuyAmount,
      sellMarkupPercent,
      holdbackPercent,
      feePercent,
      rebatePercent,
      intervals: priceData.length,
      intervalType,
      fundSize: hasFixedFund ? fundSize : null,
      productId: effectiveProductId,
      dcaStrategy,
      fibBaseAmount: isFibonacci ? fibBaseAmount : null
    },
    metrics: {
      totalInvested,
      finalUSDC: finalCash,
      btcReserves,
      btcOnOrders,
      totalBTC,
      btcValue,
      totalValue,
      roi,
      roiBasis,
      sellsFilled: isFibonacci ? fibCyclesCompleted : sellsFilled,
      totalSells: isFibonacci ? fibTotalBuys : totalBuys,
      fillRate,
      avgIntervalsToFill,
      totalFees,
      totalRebates,
      netFees: totalFees - totalRebates,
      startDate: priceData[0].date,
      endDate: priceData[priceData.length - 1].date,
      startPrice: priceData[0].close,
      endPrice: finalPrice,
      fundSize: hasFixedFund ? fundSize : null,
      finalAvailableFunds: hasFixedFund ? availableFunds : null,
      intervalsSkipped,
      intervalsBought: priceData.length - intervalsSkipped
    },
    transactions,
    intervalSnapshots
  };

  // Add strategy-specific data
  if (isFibonacci) {
    result.fibonacci = {
      cyclesCompleted: fibCyclesCompleted,
      finalPosition: fibPosition,
      totalBuys: fibTotalBuys,
      activeSellOrder: fibActiveSellOrder ? {
        sellBTC: fibActiveSellOrder.sellBTC,
        sellTargetPrice: fibActiveSellOrder.sellTargetPrice,
        avgCostBasis: fibActiveSellOrder.costBasisPerBTC,
        currentValue: fibActiveSellOrder.sellBTC * finalPrice,
        unrealizedPnL: (fibActiveSellOrder.sellBTC * finalPrice) - (fibActiveSellOrder.sellBTC * fibActiveSellOrder.costBasisPerBTC)
      } : null
    };
  } else {
    result.pendingOrders = pendingOrders.map(o => ({
      ...o,
      currentValue: o.sellBTC * finalPrice,
      unrealizedPnL: (o.sellBTC * finalPrice) - (o.sellBTC * o.costBasisPerBTC)
    }));
  }

  return result;
};

module.exports = {
  runBacktest,
  getPriceData,
  fetchPriceData
};
