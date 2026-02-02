// @ts-check
/**
 * Tail Events Detection
 *
 * Monitors for abnormal market conditions:
 * - Spread widening beyond threshold
 * - Depth dropping below minimum
 * - Flash moves (sudden large price changes)
 *
 * Implements pause logic and cooldown periods.
 */

/**
 * @typedef {import('./types').PauseState} PauseState
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').MarketState} MarketState
 */

/**
 * Create initial pause state
 * @returns {PauseState}
 */
const createInitialPauseState = () => ({
  spreadPaused: false,
  spreadPausedUntil: 0,
  lastSpreadBps: 0,
  depthPaused: false,
  depthPausedUntil: 0,
});

/**
 * Create tail events monitor instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onSpreadPause] - Called on spread pause
 * @param {Function} [callbacks.onDepthPause] - Called on depth pause
 * @param {Function} [callbacks.onFlashMove] - Called on flash move
 * @param {Function} [callbacks.onRegimeTransition] - Called to trigger regime transition
 * @returns {Object} Tail events monitor instance
 */
const createTailEventsMonitor = (exchange, config, callbacks = {}) => {
  /** @type {PauseState} */
  let pauseState = createInitialPauseState();

  let lastPrice = 0;
  let scalingDisabled = false;
  let scalingDisabledReason = null;
  let scalingReenableTimeout = null;

  /**
   * Calculate spread in basis points
   * @param {number} bid - Best bid
   * @param {number} ask - Best ask
   * @param {number} midPrice - Mid price
   * @returns {number} Spread in bps
   */
  const calculateSpreadBps = (bid, ask, midPrice) => {
    if (midPrice <= 0) return 0;
    return ((ask - bid) / midPrice) * 10000;
  };

  /**
   * Check spread health
   * @param {number} bid - Best bid
   * @param {number} ask - Best ask
   * @param {number} midPrice - Mid price (or last price)
   * @returns {{healthy: boolean, spreadBps: number}}
   */
  const checkSpreadHealth = (bid, ask, midPrice) => {
    const spreadBps = calculateSpreadBps(bid, ask, midPrice);
    pauseState.lastSpreadBps = spreadBps;

    if (spreadBps > config.maxSpreadBps) {
      if (!pauseState.spreadPaused) {
        enterSpreadPause(spreadBps);
      }
      return { healthy: false, spreadBps };
    }

    return { healthy: true, spreadBps };
  };

  /**
   * Enter spread pause
   * @param {number} spreadBps - Current spread in bps
   */
  const enterSpreadPause = (spreadBps) => {
    pauseState.spreadPaused = true;
    pauseState.spreadPausedUntil = Date.now() + config.spreadPauseMs;
    pauseState.lastSpreadBps = spreadBps;

    console.log(`⏸️ [${exchange}] Spread pause: ${spreadBps.toFixed(1)} bps > ${config.maxSpreadBps} bps, pausing for ${config.spreadPauseMs / 1000}s`);

    if (callbacks.onSpreadPause) {
      callbacks.onSpreadPause(spreadBps);
    }
  };

  /**
   * Check depth health (if L2 data available)
   * @param {number} bidDepthUsdc - Bid depth in USDC within band
   * @returns {{healthy: boolean, depth: number}}
   */
  const checkDepthHealth = (bidDepthUsdc) => {
    if (bidDepthUsdc === undefined || bidDepthUsdc === null) {
      // No depth data available, assume healthy
      return { healthy: true, depth: 0 };
    }

    if (bidDepthUsdc < config.minDepthUsdc) {
      if (!pauseState.depthPaused) {
        enterDepthPause(bidDepthUsdc);
      }
      return { healthy: false, depth: bidDepthUsdc };
    }

    return { healthy: true, depth: bidDepthUsdc };
  };

  /**
   * Enter depth pause
   * @param {number} depth - Current depth in USDC
   */
  const enterDepthPause = (depth) => {
    pauseState.depthPaused = true;
    pauseState.depthPausedUntil = Date.now() + config.depthPauseMs;

    console.log(`⏸️ [${exchange}] Depth pause: $${depth} < $${config.minDepthUsdc} threshold, pausing for ${config.depthPauseMs / 1000}s`);

    if (callbacks.onDepthPause) {
      callbacks.onDepthPause(depth);
    }
  };

  /**
   * Check for flash move
   * @param {number} currentPrice - Current price
   * @param {number} atr - Current ATR value
   * @returns {{isFlash: boolean, multiple: number}}
   */
  const checkFlashMove = (currentPrice, atr) => {
    if (lastPrice === 0 || atr <= 0) {
      lastPrice = currentPrice;
      return { isFlash: false, multiple: 0 };
    }

    const priceDelta = Math.abs(currentPrice - lastPrice);
    const multiple = priceDelta / atr;

    if (multiple > config.flashMoveMult) {
      handleFlashMove(priceDelta, atr, multiple);
      lastPrice = currentPrice;
      return { isFlash: true, multiple };
    }

    lastPrice = currentPrice;
    return { isFlash: false, multiple };
  };

  /**
   * Handle flash move detection
   * @param {number} delta - Price delta
   * @param {number} atr - ATR value
   * @param {number} multiple - ATR multiple
   */
  const handleFlashMove = (delta, atr, multiple) => {
    console.log(`⚡ [${exchange}] Flash move detected: ${delta.toFixed(2)} = ${multiple.toFixed(1)}x ATR`);

    // Disable scaling for this cycle
    scalingDisabled = true;
    scalingDisabledReason = 'flash_move';

    // Request regime transition to CAUTION
    if (callbacks.onFlashMove) {
      callbacks.onFlashMove(delta, multiple);
    }

    if (callbacks.onRegimeTransition) {
      callbacks.onRegimeTransition('CAUTION', 'flash_move');
    }

    // Clear any existing timeout
    if (scalingReenableTimeout) {
      clearTimeout(scalingReenableTimeout);
    }

    // Re-enable scaling after cooldown
    scalingReenableTimeout = setTimeout(() => {
      scalingDisabled = false;
      scalingDisabledReason = null;
      console.log(`✅ [${exchange}] Flash move cooldown complete, scaling re-enabled`);
    }, config.flashCooldownMs);
  };

  /**
   * Update pause states based on time
   */
  const updatePauseStates = () => {
    const now = Date.now();

    if (pauseState.spreadPaused && now >= pauseState.spreadPausedUntil) {
      pauseState.spreadPaused = false;
      console.log(`✅ [${exchange}] Spread pause expired`);
    }

    if (pauseState.depthPaused && now >= pauseState.depthPausedUntil) {
      pauseState.depthPaused = false;
      console.log(`✅ [${exchange}] Depth pause expired`);
    }
  };

  /**
   * Check if entry is allowed based on all tail event conditions
   * @param {number} [ladderStep] - Current ladder step (for scaling check)
   * @returns {{allowed: boolean, reason: string|null}}
   */
  const canPlaceEntry = (ladderStep = 0) => {
    updatePauseStates();
    const now = Date.now();

    if (pauseState.spreadPaused && now < pauseState.spreadPausedUntil) {
      return { allowed: false, reason: 'spread_pause' };
    }

    if (pauseState.depthPaused && now < pauseState.depthPausedUntil) {
      return { allowed: false, reason: 'depth_pause' };
    }

    // Scaling disabled means no additional entries beyond first
    if (scalingDisabled && ladderStep > 0) {
      return { allowed: false, reason: 'scaling_disabled' };
    }

    return { allowed: true, reason: null };
  };

  /**
   * Process ticker update with all checks
   * @param {Object} tickerData - Ticker data
   * @param {number} tickerData.price - Current price
   * @param {number} tickerData.bid - Best bid
   * @param {number} tickerData.ask - Best ask
   * @param {number} atr - Current ATR value
   * @param {number} [bidDepth] - Bid depth in USDC (optional)
   * @returns {{spreadHealthy: boolean, depthHealthy: boolean, isFlashMove: boolean}}
   */
  const processTicker = (tickerData, atr, bidDepth) => {
    const { price, bid, ask } = tickerData;

    const spreadResult = checkSpreadHealth(bid, ask, price);
    const depthResult = checkDepthHealth(bidDepth);
    const flashResult = checkFlashMove(price, atr);

    return {
      spreadHealthy: spreadResult.healthy,
      depthHealthy: depthResult.healthy,
      isFlashMove: flashResult.isFlash,
    };
  };

  /**
   * Get current pause state
   * @returns {PauseState}
   */
  const getPauseState = () => pauseState;

  /**
   * Check if scaling is disabled
   * @returns {{disabled: boolean, reason: string|null}}
   */
  const isScalingDisabled = () => ({
    disabled: scalingDisabled,
    reason: scalingDisabledReason,
  });

  /**
   * Get status summary for logging
   * @returns {string}
   */
  const getSummary = () => {
    const parts = [];

    if (pauseState.spreadPaused) {
      const remaining = Math.max(0, pauseState.spreadPausedUntil - Date.now());
      parts.push(`spread_paused:${Math.round(remaining / 1000)}s`);
    }

    if (pauseState.depthPaused) {
      const remaining = Math.max(0, pauseState.depthPausedUntil - Date.now());
      parts.push(`depth_paused:${Math.round(remaining / 1000)}s`);
    }

    if (scalingDisabled) {
      parts.push(`scaling_disabled:${scalingDisabledReason}`);
    }

    if (pauseState.lastSpreadBps > 0) {
      parts.push(`spread:${pauseState.lastSpreadBps.toFixed(1)}bps`);
    }

    return parts.length > 0 ? parts.join(' ') : 'healthy';
  };

  /**
   * Reset all pause states (for testing or manual reset)
   */
  const reset = () => {
    pauseState = createInitialPauseState();
    scalingDisabled = false;
    scalingDisabledReason = null;

    if (scalingReenableTimeout) {
      clearTimeout(scalingReenableTimeout);
      scalingReenableTimeout = null;
    }
  };

  /**
   * Cleanup on shutdown
   */
  const cleanup = () => {
    if (scalingReenableTimeout) {
      clearTimeout(scalingReenableTimeout);
      scalingReenableTimeout = null;
    }
  };

  return {
    checkSpreadHealth,
    checkDepthHealth,
    checkFlashMove,
    updatePauseStates,
    canPlaceEntry,
    processTicker,
    getPauseState,
    isScalingDisabled,
    getSummary,
    reset,
    cleanup,
  };
};

module.exports = {
  createTailEventsMonitor,
  createInitialPauseState,
};
