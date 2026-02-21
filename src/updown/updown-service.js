// @ts-check
/**
 * UpDown Service
 *
 * Top-level coordinator for the UpDown BTC Options Signal Dashboard.
 * Manages signal computation, state persistence, and Socket.IO emission.
 * Candle aggregation is delegated to the shared candle-cache.
 */

const path = require('path');
const { createSignalEngine } = require('./signal-engine');
const { log } = require('../logger');

const STATE_FILE = 'updown-state.json';
const SIGNAL_INTERVAL_MS = 5_000;
const TICK_THROTTLE_MS = 1_000;
const MAX_SIGNAL_HISTORY = 100;

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

  // Signal engine uses a thin adapter over the shared candle cache (cryptocom exchange)
  const candleAdapter = {
    getCandles: (tf) => candleCache.getCandles('cryptocom', tf),
  };
  const signalEngine = createSignalEngine(candleAdapter);

  /** @type {NodeJS.Timeout | null} */
  let signalInterval = null;
  let lastTickEmit = 0;
  let lastPrice = 0;
  let lastSignal = null;
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
      signalHistory.push(...saved.signalHistory.slice(-MAX_SIGNAL_HISTORY));
    }
    log('INFO', `📊 UpDown state loaded contract=${!!saved.contract} position=${!!saved.position}`);
  };

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
   * Handle a price tick from the exchange IPC stream
   * @param {number} price - Current BTC price
   * @param {number} timestamp - Tick timestamp (ms)
   */
  const handlePriceTick = (price, timestamp) => {
    if (!running) return;
    lastPrice = price;

    // Throttled tick emission to updown room (max 1/sec)
    const now = Date.now();
    if (now - lastTickEmit >= TICK_THROTTLE_MS) {
      lastTickEmit = now;
      const timeRemaining = contract.expiry ? Math.max(0, contract.expiry - now) : null;
      const pnl = computePnL();
      io.to('updown').emit('updown:tick', {
        price,
        timestamp: now,
        timeRemaining,
        pnl,
        contract: contract.expiry ? contract : null,
      });
    }
  };

  /**
   * Run signal computation and emit results
   */
  const runSignalCycle = () => {
    const result = signalEngine.computeSignals(contract.expiry);

    // Emit full indicator data every cycle
    io.to('updown').emit('updown:indicators', {
      timeframes: result.timeframes,
      score: result.score,
      noTradeZone: result.noTradeZone,
      warningZone: result.warningZone,
      timestamp: result.timestamp,
    });

    // Emit signal change event only when signal changes
    if (result.type !== lastSignal) {
      lastSignal = result.type;
      signalHistory.push({
        type: result.type,
        score: result.score,
        confidence: result.confidence,
        timestamp: result.timestamp,
      });
      if (signalHistory.length > MAX_SIGNAL_HISTORY) {
        signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
      }

      io.to('updown').emit('updown:signal', {
        type: result.type,
        score: result.score,
        confidence: result.confidence,
        noTradeZone: result.noTradeZone,
        warningZone: result.warningZone,
        timeframes: result.timeframes,
        timestamp: result.timestamp,
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
    signalInterval = setInterval(runSignalCycle, SIGNAL_INTERVAL_MS);

    // Set lastPrice from most recent candle if available
    const candles1m = candleCache.getCandles('cryptocom', '1m');
    if (candles1m.length > 0) {
      lastPrice = candles1m[candles1m.length - 1].close;
    }

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
      signalHistory: signalHistory.slice(-20),
      candleCounts: {
        '1m': candleCache.getCandles('cryptocom', '1m').length,
        '3m': candleCache.getCandles('cryptocom', '3m').length,
        '5m': candleCache.getCandles('cryptocom', '5m').length,
        '15m': candleCache.getCandles('cryptocom', '15m').length,
        '1h': candleCache.getCandles('cryptocom', '1h').length,
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
    setContract,
    setPosition,
    clearPosition,
  };
};

module.exports = { createUpDownService };
