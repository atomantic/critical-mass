// @ts-check
/**
 * UpDown Service
 *
 * Top-level coordinator for the UpDown BTC Options Signal Dashboard.
 * Manages signal computation, state persistence, and Socket.IO emission.
 * Candle aggregation is delegated to the shared candle-cache.
 */

const path = require('path');
const { createSignalEngine, scoreToSignalDynamic, resolveNoTradeZoneType } = require('./signal-engine');
const { createScorecard } = require('./scorecard');
const { log } = require('../logger');

const STATE_FILE = 'updown-state.json';
const SIGNAL_INTERVAL_MS = 5_000;
const TICK_THROTTLE_MS = 1_000;
const MAX_SIGNAL_HISTORY = 100;
const SIGNAL_DEBOUNCE_MS = 5 * 60 * 1000; // 5 min minimum between same-type history entries

/**
 * Create the UpDown service
 * @param {Object} io - Socket.IO server instance
 * @param {Object} deps
 * @param {Object} deps.exchangeIPCMap - Map of exchange IPC clients
 * @param {Function} deps.readJSON - Read JSON file
 * @param {Function} deps.writeJSON - Write JSON file
 * @param {string} deps.DATA_DIR - Data directory path
 * @param {Object} deps.candleCache - Shared candle cache instance
 * @returns {Object}
 */
const createUpDownService = (io, deps) => {
  const { readJSON, writeJSON, DATA_DIR, candleCache } = deps;
  const stateFilePath = path.join(DATA_DIR, STATE_FILE);

  // Signal engine uses a thin adapter over the shared candle cache (coinbase BTC data)
  const candleAdapter = {
    getCandles: (tf) => candleCache.getCandles('coinbase', tf),
  };
  const signalEngine = createSignalEngine(candleAdapter);
  const scorecard = createScorecard({ io, lastPriceFn: () => lastPrice, contractFn: () => contract });

  const TICK_BUFFER_SIZE = 60;
  const tickBuffer = []; // { price, timestamp }

  /** @type {NodeJS.Timeout | null} */
  let signalInterval = null;
  let lastTickEmit = 0;
  let lastPrice = 0;
  let lastSignal = null;
  let lastSignalResult = null;
  let running = false;

  // State
  let contract = { expiry: null, target: null, stop: null, range: null, direction: null };
  let position = null;
  /** @type {Array<Object>} */
  const signalHistory = [];

  /**
   * Load persisted state from disk
   */
  const loadState = () => {
    const saved = readJSON(stateFilePath, null);
    if (!saved) return;
    if (saved.contract) contract = { ...contract, ...saved.contract };
    if (saved.position) position = saved.position;
    if (saved.signalHistory) {
      signalHistory.length = 0;
      // Filter out only NO_TRADE_ZONE — keep NEUTRAL and all directional signals
      for (const s of saved.signalHistory) {
        if (s.type !== 'NO_TRADE_ZONE') {
          signalHistory.push(s);
        }
      }
      // Trim to max size
      if (signalHistory.length > MAX_SIGNAL_HISTORY) {
        signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
      }
    }
    log('INFO', `📊 UpDown state loaded contract=${!!saved.contract} position=${!!saved.position}`);
  };

  // Eagerly load persisted state so signal history is available even before start()
  loadState();

  /**
   * Persist current state to disk
   */
  const persistState = () => {
    writeJSON(stateFilePath, { contract, position, signalHistory: signalHistory.slice(-MAX_SIGNAL_HISTORY) });
  };

  /**
   * Compute P&L for current position against current price
   * @returns {{pnl: number, pnlPercent: number} | null}
   */
  const computePnL = () => {
    if (!position || !lastPrice) return null;
    const entryValue = position.contracts * position.entryPrice;
    const currentValue = position.contracts * lastPrice;
    const direction = position.direction === 'up' ? 1 : -1;
    const pnl = (currentValue - entryValue) * direction;
    const pnlPercent = entryValue > 0 ? (pnl / entryValue) * 100 : 0;
    return { pnl: Math.round(pnl * 100) / 100, pnlPercent: Math.round(pnlPercent * 100) / 100 };
  };

  /**
   * Compute tick-level momentum from the raw tick ring buffer
   * @returns {{direction: string, magnitude: number, velocity: number}}
   */
  const computeTickMomentum = () => {
    if (tickBuffer.length < 3) return { direction: 'neutral', magnitude: 0, velocity: 0 };

    const shortWindow = tickBuffer.slice(-10);
    const longWindow = tickBuffer.slice(-30);

    const shortDir = shortWindow.length >= 2
      ? shortWindow[shortWindow.length - 1].price - shortWindow[0].price
      : 0;
    const longDir = longWindow.length >= 2
      ? longWindow[longWindow.length - 1].price - longWindow[0].price
      : 0;

    const magnitude = Math.abs(shortDir) / (shortWindow[0]?.price || 1) * 10000; // basis points
    const timeDelta = (shortWindow[shortWindow.length - 1]?.timestamp - shortWindow[0]?.timestamp) / 1000;
    const velocity = timeDelta > 0 ? shortDir / timeDelta : 0;

    let direction = 'neutral';
    if (shortDir > 0 && longDir > 0) direction = 'up';
    else if (shortDir < 0 && longDir < 0) direction = 'down';

    return {
      direction,
      magnitude: Math.round(magnitude * 100) / 100,
      velocity: Math.round(velocity * 100) / 100,
    };
  };

  /**
   * Handle a price tick from the exchange IPC stream
   * @param {number} price - Current BTC price
   * @param {number} timestamp - Tick timestamp (ms)
   */
  const handlePriceTick = (price, timestamp) => {
    if (!running) return;
    lastPrice = price;

    // Buffer all raw ticks for momentum computation
    tickBuffer.push({ price, timestamp });
    if (tickBuffer.length > TICK_BUFFER_SIZE) {
      tickBuffer.splice(0, tickBuffer.length - TICK_BUFFER_SIZE);
    }

    // Throttled tick emission to updown room (max 1/sec)
    const now = Date.now();
    if (now - lastTickEmit >= TICK_THROTTLE_MS) {
      lastTickEmit = now;
      const timeRemaining = contract.expiry ? Math.max(0, contract.expiry - now) : null;
      const pnl = computePnL();
      const tickMomentum = computeTickMomentum();
      io.to('updown').emit('updown:tick', {
        price,
        timestamp: now,
        timeRemaining,
        pnl,
        contract: contract.expiry ? contract : null,
        tickMomentum,
      });
    }
  };

  /**
   * Run signal computation and emit results
   */
  const runSignalCycle = () => {
    // Get scorecard metrics for adaptive weights + horizon prediction
    const metrics = scorecard.getMetrics();

    // Feature 7: Feed adaptive weights back to signal engine
    if (metrics.adaptiveWeights) {
      signalEngine.setIndicatorWeights(metrics.adaptiveWeights);
    }

    // Feature 8: Pass scorecard metrics for horizon prediction.
    // Pass the held position so NO_TRADE_ZONE surfaces exit signals (issue #108).
    const result = signalEngine.computeSignals(contract.expiry, metrics, position);

    // Tick momentum confirmation — adjust composite score post-computation
    const tickMomentum = computeTickMomentum();
    if (Math.abs(result.score) >= 5 && tickMomentum.magnitude > 0) {
      const scoreDir = result.score > 0 ? 'up' : 'down';
      if (tickMomentum.direction === scoreDir) {
        // Aligned: boost up to +25% scaled by magnitude (caps at 20 bps)
        const boostFactor = 1 + 0.25 * Math.min(1, tickMomentum.magnitude / 20);
        result.score = Math.round(result.score * boostFactor * 100) / 100;
      } else if (tickMomentum.direction !== 'neutral') {
        // Contradicting: reduce up to -15% scaled by magnitude
        const dampFactor = 1 - 0.15 * Math.min(1, tickMomentum.magnitude / 20);
        result.score = Math.round(result.score * dampFactor * 100) / 100;
      }
      // Recompute type and confidence after the tick-momentum score adjustment,
      // preserving exit-signal surfacing for a held position in the no-trade
      // zone (issue #108) — same rule as the signal engine.
      const adjustedRaw = scoreToSignalDynamic(result.score, result.volatility?.ratio ?? 1);
      result.type = resolveNoTradeZoneType(adjustedRaw, result.noTradeZone, position);
      result.confidence = Math.round(Math.min(1, Math.abs(result.score) / 60) * 100) / 100;
    }

    lastSignalResult = result;

    // Emit full indicator data every cycle (with new fields)
    io.to('updown').emit('updown:indicators', {
      timeframes: result.timeframes,
      type: result.type,
      score: result.score,
      confidence: result.confidence,
      noTradeZone: result.noTradeZone,
      warningZone: result.warningZone,
      timestamp: result.timestamp,
      tickMomentum,
      trendFilter: result.trendFilter,
      weeklyTrend: result.weeklyTrend,
      dailySMA: result.dailySMA,
      adxRegime: result.adxRegime,
      volatility: result.volatility,
      pivotPoints: result.pivotPoints,
      confluence: result.confluence,
    });

    // Emit signal change event only when signal changes
    if (result.type !== lastSignal) {
      lastSignal = result.type;
      // Record all signal changes including NEUTRAL (skip only NO_TRADE_ZONE)
      // Debounce: skip only consecutive same-type entries within SIGNAL_DEBOUNCE_MS
      // (BUY→NEUTRAL→BUY is NOT debounced — the intervening signal makes it meaningful)
      if (result.type !== 'NO_TRADE_ZONE') {
        const lastEntry = signalHistory.length > 0 ? signalHistory[signalHistory.length - 1] : null;
        const isConsecutiveDuplicate = lastEntry &&
          lastEntry.type === result.type &&
          (result.timestamp - lastEntry.timestamp) < SIGNAL_DEBOUNCE_MS;
        if (!isConsecutiveDuplicate) {
          signalHistory.push({
            type: result.type,
            score: result.score,
            confidence: result.confidence,
            timestamp: result.timestamp,
          });
          if (signalHistory.length > MAX_SIGNAL_HISTORY) {
            signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
          }
        }
      }

      // Record signal change for scorecard tracking
      scorecard.recordPrediction(result, 'signal_change');

      io.to('updown').emit('updown:signal', {
        type: result.type,
        score: result.score,
        confidence: result.confidence,
        noTradeZone: result.noTradeZone,
        warningZone: result.warningZone,
        timeframes: result.timeframes,
        timestamp: result.timestamp,
        trendFilter: result.trendFilter,
        weeklyTrend: result.weeklyTrend,
        dailySMA: result.dailySMA,
        adxRegime: result.adxRegime,
        volatility: result.volatility,
        pivotPoints: result.pivotPoints,
        horizonPrediction: result.horizonPrediction,
      });
    }
  };

  /**
   * Start the service
   */
  const start = async () => {
    if (running) return;
    loadState();

    running = true;
    // runSignalCycle is synchronous; a throw inside it would crash the process
    // from the interval callback, so guard every tick.
    signalInterval = setInterval(() => {
      try {
        runSignalCycle();
      } catch (err) {
        log('WARN', `📊 UpDown signal cycle failed err=${err.message}`);
      }
    }, SIGNAL_INTERVAL_MS);

    // Set lastPrice from most recent candle if available
    const candles1m = candleCache.getCandles('coinbase', '1m');
    if (candles1m.length > 0) {
      lastPrice = candles1m[candles1m.length - 1].close;
    }

    // Start scorecard auto-sampling (every 60s) — awaits JSONL history hydration
    await scorecard.start(() => signalEngine.computeSignals(contract.expiry, scorecard.getMetrics()));

    log('INFO', '📊 UpDown service started interval=5s');
  };

  /**
   * Stop the service
   */
  const stop = () => {
    running = false;
    if (signalInterval) {
      clearInterval(signalInterval);
      signalInterval = null;
    }
    scorecard.stop();
    persistState();
    log('INFO', '📊 UpDown service stopped');
  };

  /**
   * Get full current status
   * @returns {Object}
   */
  const getStatus = () => {
    const latestSignal = signalHistory.length > 0 ? signalHistory[signalHistory.length - 1] : null;
    return {
      running,
      contract,
      position,
      lastPrice,
      pnl: computePnL(),
      latestSignal,
      signalHistory: signalHistory.slice(-100),
      scorecard: scorecard.getMetrics(),
      candleCounts: {
        '1m': candleCache.getCandles('coinbase', '1m').length,
        '3m': candleCache.getCandles('coinbase', '3m').length,
        '5m': candleCache.getCandles('coinbase', '5m').length,
        '10m': candleCache.getCandles('coinbase', '10m').length,
        '15m': candleCache.getCandles('coinbase', '15m').length,
        '30m': candleCache.getCandles('coinbase', '30m').length,
        '1h': candleCache.getCandles('coinbase', '1h').length,
        '2h': candleCache.getCandles('coinbase', '2h').length,
        '4h': candleCache.getCandles('coinbase', '4h').length,
        '1d': candleCache.getCandles('coinbase', '1d').length,
        '1w': candleCache.getCandles('coinbase', '1w').length,
      },
    };
  };

  /**
   * Set contract configuration
   * @param {Object} config - Contract config
   * @param {number | null} config.expiry - Expiry timestamp (ms)
   * @param {number | null} config.target - Target price
   * @param {number | null} config.stop - Stop price
   * @param {number | null} config.range - Range value
   * @param {string | null} config.direction - 'up' or 'down'
   */
  const setContract = (config) => {
    contract = { ...contract, ...config };
    persistState();
    log('INFO', `📊 UpDown contract updated expiry=${contract.expiry} direction=${contract.direction}`);
  };

  /**
   * Set position (manual entry)
   * @param {Object} pos
   * @param {number} pos.entryPrice - Entry price
   * @param {number} pos.contracts - Number of contracts
   * @param {string} pos.direction - 'up' or 'down'
   * @param {number} [pos.entryTime] - Entry timestamp
   */
  const setPosition = (pos) => {
    position = { ...pos, entryTime: pos.entryTime || Date.now() };
    persistState();
    log('INFO', `📊 UpDown position set entry=$${pos.entryPrice} contracts=${pos.contracts} direction=${pos.direction}`);
  };

  /**
   * Get current trade context for enriching trade records
   * @returns {{contract: Object, position: Object|null, lastPrice: number, latestSignal: Object|null, trendFilter: Object|null, volatility: Object|null}}
   */
  const getTradeContext = () => ({
    contract: { ...contract },
    position: position ? { ...position } : null,
    lastPrice,
    latestSignal: lastSignalResult ? {
      type: lastSignalResult.type,
      score: lastSignalResult.score,
      confidence: lastSignalResult.confidence,
      timestamp: lastSignalResult.timestamp,
    } : null,
    trendFilter: lastSignalResult?.trendFilter ?? null,
    volatility: lastSignalResult?.volatility ?? null,
  });

  /**
   * Clear current position
   */
  const clearPosition = () => {
    position = null;
    persistState();
    log('INFO', '📊 UpDown position cleared');
  };

  return {
    start,
    stop,
    handlePriceTick,
    getStatus,
    getScorecard: () => scorecard.getMetrics(),
    setContract,
    setPosition,
    clearPosition,
    getTradeContext,
  };
};

module.exports = { createUpDownService };
