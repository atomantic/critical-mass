// @ts-check
/**
 * UpDown Service
 *
 * Top-level coordinator for the UpDown BTC perp-long signal dashboard.
 * Manages signal computation, state persistence, and Socket.IO emission.
 * Candle aggregation is delegated to the shared candle-cache.
 */

const path = require('path');
const { createSignalEngine, scoreToSignalDynamic, resolveNoTradeZoneType, applyUpOnlyGate } = require('./signal-engine');
const { clampScoreToExistingType, preventTickCreatedSignal, alignJournalType } = require('./signal-stability');
const { createScorecard } = require('./scorecard');
const { createPerpBook } = require('./perp-book');
const { PERP_CONTRACT_SIZE_BTC, calculatePerpPnl } = require('./perp-contract');
const { resolveAction, labelHistoryActions } = require('./signal-actions');
const { log } = require('../logger');

const STATE_FILE = 'updown-state.json';
const SIGNAL_INTERVAL_MS = 5_000;
const TICK_THROTTLE_MS = 1_000;
const PRICE_STALE_MS = 30_000;
const MAX_SIGNAL_HISTORY = 100;
const SIGNAL_DEBOUNCE_MS = 5 * 60 * 1000; // 5 min minimum between same-type history entries

const isFreshPrice = (price, lastTickAt, now = Date.now(), maxAgeMs = PRICE_STALE_MS) =>
  Number.isFinite(price) && price > 0 && Number.isFinite(lastTickAt) &&
  lastTickAt > 0 && now - lastTickAt >= 0 && now - lastTickAt <= maxAgeMs;

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
  const signalEngineFactory = deps.createSignalEngine ?? createSignalEngine;
  const signalEngine = signalEngineFactory(candleAdapter);
  // Issue #212C: the scorecard's 60s sampler must NOT share prevIndicators with the
  // live 5s cycle — createSignalEngine mutates prevIndicators on every computeSignals
  // call for crossover detection (stoch/MACD), so two consumers sharing one engine
  // instance race: whichever fires first "consumes" the crossover and the other sees
  // stale (post-cross) state. A dedicated instance over the same read-only candle
  // adapter gives the sampler its own crossover memory without affecting the live cycle.
  const scorecardSignalEngine = signalEngineFactory(candleAdapter);
  const perpBook = createPerpBook();
  const scorecardFactory = deps.createScorecard ?? createScorecard;
  const scorecard = scorecardFactory({
    io,
    lastPriceFn: () => isFreshPrice(lastPrice, lastTickAt) ? lastPrice : null,
    contractFn: () => contract,
    perpBook,
  });

  const TICK_BUFFER_SIZE = 60;
  const tickBuffer = []; // { price, timestamp }

  /** @type {NodeJS.Timeout | null} */
  let signalInterval = null;
  let lastTickEmit = 0;
  let lastPrice = 0;
  let lastTickAt = 0;
  let lastStaleLogAt = 0;
  let lastSignal = null;
  let lastSignalResult = null;
  let running = false;
  let lifecycleGeneration = 0;
  let startPromise = null;

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
    if (saved.stability) {
      signalEngine.setStabilityState(saved.stability);
    }
    if (saved.perpBook) {
      perpBook.hydrate(saved.perpBook);
    }
    // Relabel the log for the dashboard, but do not treat historical OPEN/ADD
    // as a live position. Paper P&L starts from the persisted book only.
    if (signalHistory.length > 0) {
      const labeled = labelHistoryActions(signalHistory)
      signalHistory.length = 0
      signalHistory.push(...labeled)
    }
    log('INFO', `📊 UpDown state loaded contract=${!!saved.contract} position=${!!saved.position} stability=${saved.stability?.publishedType || 'none'} perp=${perpBook.snapshot().contracts} open=${perpBook.isLong()}`);
  };

  // Eagerly load persisted state so signal history is available even before start()
  loadState();

  /**
   * Persist current state to disk
   */
  const persistState = () => {
    writeJSON(stateFilePath, {
      contract,
      position,
      signalHistory: signalHistory.slice(-MAX_SIGNAL_HISTORY),
      stability: signalEngine.getStabilityState(),
      perpBook: perpBook.serialize(),
    });
  };

  /**
   * Compute P&L for current position against current price
   * @returns {{pnl: number, pnlPercent: number} | null}
   */
  const computePnL = () => {
    if (!position || !isFreshPrice(lastPrice, lastTickAt)) return null;
    const entryValue = position.contracts * PERP_CONTRACT_SIZE_BTC * position.entryPrice;
    const direction = position.direction === 'up' ? 1 : -1;
    const pnl = calculatePerpPnl(position.entryPrice, lastPrice, position.contracts, direction);
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
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;
    const now = Date.now();
    lastPrice = numericPrice;
    lastTickAt = now;
    const tickTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : now;

    // Buffer all raw ticks for momentum computation
    tickBuffer.push({ price: numericPrice, timestamp: tickTimestamp });
    if (tickBuffer.length > TICK_BUFFER_SIZE) {
      tickBuffer.splice(0, tickBuffer.length - TICK_BUFFER_SIZE);
    }

    // Throttled tick emission to updown room (max 1/sec)
    if (now - lastTickEmit >= TICK_THROTTLE_MS) {
      lastTickEmit = now;
      const timeRemaining = contract.expiry ? Math.max(0, contract.expiry - now) : null;
      const pnl = computePnL();
      const tickMomentum = computeTickMomentum();
      io.to('updown').emit('updown:tick', {
        price: numericPrice,
        timestamp: now,
        timeRemaining,
        pnl,
        contract: contract.expiry ? contract : null,
        tickMomentum,
        perp: perpBook.snapshot(price),
      });
    }
  };

  /**
   * Run signal computation and emit results
   */
  const runSignalCycle = () => {
    if (!isFreshPrice(lastPrice, lastTickAt)) {
      const now = Date.now();
      if (now - lastStaleLogAt >= PRICE_STALE_MS) {
        lastStaleLogAt = now;
        const age = lastTickAt > 0 ? now - lastTickAt : null;
        log('WARN', `📊 UpDown signal cycle paused — BTC price feed stale ageMs=${age ?? 'unavailable'}`);
      }
      return;
    }

    // Get scorecard metrics for adaptive weights + horizon prediction
    const metrics = scorecard.getMetrics();

    // Feature 7: Feed adaptive weights back to signal engine (both instances stay
    // in sync on weights — only crossover memory is intentionally kept separate).
    if (metrics.adaptiveWeights) {
      signalEngine.setIndicatorWeights(metrics.adaptiveWeights);
      scorecardSignalEngine.setIndicatorWeights(metrics.adaptiveWeights);
    }

    // Feature 8: Pass scorecard metrics for horizon prediction.
    // Pass the held position so NO_TRADE_ZONE surfaces exit signals (issue #108).
    const result = signalEngine.computeSignals(contract.expiry, metrics, position);

    // Tick momentum confirmation — adjust composite score post-computation.
    // Must not create or cancel a published type: 5s tick boosts were shoving
    // HOLD (14.5) across the BUY line as a fake 18.3 print.
    const tickMomentum = computeTickMomentum();
    const typeBeforeTick = result.type;
    if (Math.abs(result.score) >= 5 && tickMomentum.magnitude > 0) {
      const scoreDir = result.score > 0 ? 'up' : 'down';
      let adjusted = result.score;
      if (tickMomentum.direction === scoreDir) {
        const boostFactor = 1 + 0.25 * Math.min(1, tickMomentum.magnitude / 20);
        adjusted = Math.round(result.score * boostFactor * 100) / 100;
      } else if (tickMomentum.direction !== 'neutral') {
        const dampFactor = 1 - 0.15 * Math.min(1, tickMomentum.magnitude / 20);
        adjusted = Math.round(result.score * dampFactor * 100) / 100;
      }
      const atrRatio = result.volatility?.ratio ?? 1;
      result.score = clampScoreToExistingType(typeBeforeTick, result.score, adjusted, atrRatio);
      const adjustedRaw = scoreToSignalDynamic(result.score, atrRatio);
      const gated = applyUpOnlyGate(adjustedRaw, result.trendGate?.open !== false, position);
      const candidate = resolveNoTradeZoneType(gated, result.noTradeZone, position);
      result.type = preventTickCreatedSignal(typeBeforeTick, candidate);
      result.confidence = Math.round(Math.min(1, Math.abs(result.score) / 60) * 100) / 100;
    }

    lastSignalResult = result;

    // Paper-trade the published type against the 0.01-BTC-per-contract perp book. Same-side
    // repeats (BUY staying BUY) do not pyramid; a new BUY after HOLD adds.
    const fillResult = lastPrice > 0
      ? perpBook.applySignal(result.type, lastPrice, result.timestamp)
      : { action: resolveAction(result.type, perpBook.isLong()), fill: null, trade: null };
    const action = fillResult.action;
    const perpSnap = perpBook.snapshot(lastPrice);
    if (fillResult.fill) {
      scorecard.recordPerpFill({
        action,
        signalType: result.type,
        price: fillResult.fill.price,
        ts: fillResult.fill.ts,
        contracts: fillResult.fill.contracts,
        side: fillResult.fill.side,
        pnl: fillResult.fill.pnl,
        trade: fillResult.trade,
        book: { contracts: perpSnap.contracts, realizedPnl: perpSnap.realizedPnl },
      });
      persistState();
      io.to('updown').emit('updown:scorecard', scorecard.getMetrics());
      log('INFO', `📊 UpDown perp ${action} contracts=${fillResult.fill.contracts} price=$${fillResult.fill.price} book=${perpSnap.contracts} realized=$${perpSnap.realizedPnl}`);
    }

    // Emit full indicator data every cycle (with new fields)
    io.to('updown').emit('updown:indicators', {
      timeframes: result.timeframes,
      type: result.type,
      score: result.score,
      confidence: result.confidence,
      action,
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
      horizonPrediction: result.horizonPrediction,
      trendGate: result.trendGate,
      perp: perpSnap,
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
            action,
            score: result.score,
            confidence: result.confidence,
            timestamp: result.timestamp,
            price: lastPrice,
          });
          if (signalHistory.length > MAX_SIGNAL_HISTORY) {
            signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
          }
        }
      }

      persistState();

      // Record signal change for scorecard tracking
      scorecard.recordPrediction(result, 'signal_change');

      io.to('updown').emit('updown:signal', {
        type: result.type,
        action,
        filled: !!fillResult.fill,
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
        trendGate: result.trendGate,
        perp: perpSnap,
      });
    }
  };

  /**
   * Start the service
   */
  const start = async () => {
    if (running) return startPromise;
    const generation = ++lifecycleGeneration;
    loadState();

    running = true;
    lastTickAt = 0;
    tickBuffer.length = 0;

    // Set lastPrice from most recent candle if available
    const candles1m = candleCache.getCandles('coinbase', '1m');
    if (candles1m.length > 0) {
      lastPrice = candles1m[candles1m.length - 1].close;
    }

    // Start scorecard auto-sampling (every 60s) — awaits JSONL history hydration.
    // Uses scorecardSignalEngine (issue #212C), a dedicated instance, so the sampler's
    // reads don't advance the live cycle's crossover-detection memory.
    startPromise = Promise.resolve(scorecard.start(() => {
      const sampled = scorecardSignalEngine.computeSignals(contract.expiry, scorecard.getMetrics());
      return alignJournalType(sampled, lastSignalResult?.type);
    })).then(() => {
      if (running && generation === lifecycleGeneration) {
        // Start live cycles only after scorecard hydration completes. Otherwise
        // a 5s cycle can journal a prediction while loadHistory is replacing
        // counters/buffers, making the new sample disappear from memory.
        signalInterval = setInterval(() => {
          try {
            runSignalCycle();
          } catch (err) {
            log('WARN', `📊 UpDown signal cycle failed err=${err.message}`);
          }
        }, SIGNAL_INTERVAL_MS);
        log('INFO', '📊 UpDown service started interval=5s');
      }
    }).catch((err) => {
      if (generation === lifecycleGeneration) {
        running = false;
        if (signalInterval) {
          clearInterval(signalInterval);
          signalInterval = null;
        }
        scorecard.stop();
      }
      throw err;
    }).finally(() => {
      if (generation === lifecycleGeneration) startPromise = null;
    });
    return startPromise;
  };

  /**
   * Stop the service
   */
  const stop = () => {
    running = false;
    lifecycleGeneration++;
    startPromise = null;
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
    const now = Date.now();
    const priceFresh = isFreshPrice(lastPrice, lastTickAt, now);
    const visiblePrice = priceFresh ? lastPrice : null;
    const perpSnap = perpBook.snapshot(visiblePrice);
    return {
      running,
      contract,
      position,
      lastPrice: visiblePrice,
      lastKnownPrice: lastPrice || null,
      lastTickAt: lastTickAt || null,
      priceAgeMs: lastTickAt > 0 ? Math.max(0, now - lastTickAt) : null,
      priceFresh,
      pnl: computePnL(),
      latestSignal,
      signalHistory: signalHistory.slice(-100),
      scorecard: scorecard.getMetrics(),
      action: latestSignal?.action || resolveAction(latestSignal?.type, perpBook.isLong()),
      perp: perpSnap,
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
    lastPrice: isFreshPrice(lastPrice, lastTickAt) ? lastPrice : null,
    latestSignal: lastSignalResult ? {
      type: lastSignalResult.type,
      action: resolveAction(lastSignalResult.type, perpBook.isLong()),
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

module.exports = { createUpDownService, isFreshPrice, PRICE_STALE_MS };
