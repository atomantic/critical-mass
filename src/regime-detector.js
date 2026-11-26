// @ts-check
/**
 * Regime Detector
 *
 * Classifies market conditions into three regimes:
 * - HARVEST: Mean-reverting conditions, full inventory cycling
 * - CAUTION: Elevated volatility, reduced position sizing
 * - TREND: Strong directional momentum, exit/manage only
 *
 * Uses volatility expansion, momentum, and VWAP distance for classification.
 */

const { calculateVolExpansion, calculateVWAPDistance } = require('./volatility-utils');
const { createContextLogger } = require('./logger');

/**
 * @typedef {import('./types').RegimeMode} RegimeMode
 * @typedef {import('./types').RegimeState} RegimeState
 * @typedef {import('./types').MarketState} MarketState
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

/**
 * Create initial regime state
 * @returns {RegimeState}
 */
const createInitialRegimeState = () => ({
  mode: 'HARVEST',
  since: Date.now(),
  transitionCount: 0,
  trendDirection: null,
  lastVolExpansion: 1.0,
  lastMomentumMag: 0,
  trendConfirmationCount: 0,
});

/**
 * Create regime detector instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onTransition] - Called on regime transition
 * @param {string} [productId] - Trading pair ID
 * @returns {Object} Regime detector instance
 */
const createRegimeDetector = (exchange, config, callbacks = {}, productId) => {
  const logger = createContextLogger({ exchange, pair: productId });
  /** @type {RegimeState} */
  let state = createInitialRegimeState();

  let warmupReadingsRemaining = 0;

  /**
   * Classify current regime based on market conditions
   * @param {MarketState} marketState - Current market state
   * @returns {RegimeMode} Detected regime
   */
  const classify = (marketState) => {
    const { realizedVol, volBaseline, atr1m, vwap, lastPrice } = marketState;

    // Startup metrics can arrive before a live ticker or usable indicators.
    if (![lastPrice, vwap, atr1m].every(value => Number.isFinite(value) && value > 0)) {
      return state.mode;
    }

    // Calculate key metrics
    const volExpansion = calculateVolExpansion(realizedVol, volBaseline);
    const vwapDistance = calculateVWAPDistance(lastPrice, vwap, atr1m);
    const momentum = calculateMomentumSignal(marketState);

    state.lastVolExpansion = volExpansion;
    state.lastMomentumMag = momentum.magnitude;

    const prevMode = state.mode;
    const trendConfirmed = updateTrendConfirmation(momentum.direction, vwapDistance);
    let newMode = prevMode;

    // Transition logic based on current mode
    if (prevMode === 'HARVEST') {
      newMode = classifyFromHarvest(volExpansion, momentum);
    } else if (prevMode === 'CAUTION') {
      newMode = classifyFromCaution(volExpansion, momentum, vwapDistance, trendConfirmed);
    } else if (prevMode === 'TREND') {
      newMode = trendConfirmed ? 'TREND' : 'CAUTION';
    }

    // Fresh readings may tighten protection immediately; relaxing a restored
    // regime must wait for a complete post-restore confirmation window.
    if (warmupReadingsRemaining > 0) {
      warmupReadingsRemaining--;
      if (warmupReadingsRemaining > 0) {
        if (prevMode === 'TREND' || (prevMode === 'CAUTION' && newMode === 'HARVEST')) {
          newMode = prevMode;
        }
      }
    }

    // Handle transition
    if (newMode !== prevMode) {
      transition(newMode, buildTransitionReason(volExpansion, momentum, vwapDistance), momentum.direction);
    }

    return state.mode;
  };

  /**
   * Classify from HARVEST mode
   * @param {number} volExpansion - Volatility expansion ratio
   * @param {{magnitude: number, direction: string}} momentum - Momentum signal
   * @returns {RegimeMode}
   */
  const classifyFromHarvest = (volExpansion, momentum) => {
    // Check for sudden spike (HARVEST -> TREND directly)
    if (volExpansion > 2.0 && momentum.magnitude > 2 * config.momentumMult * 10) {
      return 'TREND';
    }

    // Check for elevated conditions (HARVEST -> CAUTION)
    if (volExpansion > config.volExpansionMult ||
        momentum.magnitude > config.momentumMult * 10) {
      return 'CAUTION';
    }

    return 'HARVEST';
  };

  /**
   * Classify from CAUTION mode
   * @param {number} volExpansion - Volatility expansion ratio
   * @param {{magnitude: number, direction: string}} momentum - Momentum signal
   * @param {number} vwapDistance - VWAP distance in ATR units
   * @param {boolean} trendConfirmed - Whether directional pressure persisted
   * @returns {RegimeMode}
   */
  const classifyFromCaution = (volExpansion, momentum, vwapDistance, trendConfirmed) => {
    // Check for return to calm (CAUTION -> HARVEST)
    if (volExpansion < config.volContractionMult &&
        momentum.magnitude < config.momentumMult * 5 &&
        Math.abs(vwapDistance) < 1.0) {
      return 'HARVEST';
    }

    // Check for trend confirmation (CAUTION -> TREND)
    if (trendConfirmed) {
      return 'TREND';
    }

    return 'CAUTION';
  };

  /**
   * Calculate momentum signal from market state
   * @param {MarketState} marketState - Market state
   * @returns {{magnitude: number, direction: string}} magnitude is in basis points of lastPrice
   */
  const calculateMomentumSignal = (marketState) => {
    const { lastPrice, vwap, momentum, tradeImbalance } = marketState;
    // Older callers may only supply price and VWAP. Candle momentum, when
    // present, is already in price units and uses the same basis-point scale.
    const delta = lastPrice - vwap;
    const magnitude = (momentum?.magnitude ?? Math.abs(delta)) / lastPrice * 10000;
    const direction = momentum?.direction ?? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral');

    // Factor in trade imbalance if available
    let adjustedMagnitude = magnitude;
    if (tradeImbalance !== undefined) {
      // Trade imbalance amplifies momentum signal
      const imbalanceFactor = 1 + Math.abs(tradeImbalance) * 0.5;
      if ((direction === 'up' && tradeImbalance > 0) ||
          (direction === 'down' && tradeImbalance < 0)) {
        adjustedMagnitude *= imbalanceFactor;
      }
    }

    return { magnitude: adjustedMagnitude, direction };
  };

  /**
   * Track consecutive readings with directional pressure and VWAP displacement.
   * @param {string} direction - Current momentum direction
   * @param {number} vwapDistance - VWAP distance
   * @returns {boolean}
   */
  const updateTrendConfirmation = (direction, vwapDistance) => {
    const expectedDirection = vwapDistance > 0 ? 'up' : 'down';
    if (Math.abs(vwapDistance) < 2.0 || direction !== expectedDirection) {
      state.trendConfirmationCount = 0;
      state.trendDirection = null;
      return false;
    }

    if (state.trendDirection && state.trendDirection !== direction) {
      state.trendConfirmationCount = 0;
    }
    state.trendDirection = expectedDirection;
    state.trendConfirmationCount = Math.min(state.trendConfirmationCount + 1, config.trendConfirmationPeriods);
    return state.trendConfirmationCount >= config.trendConfirmationPeriods;
  };

  /**
   * Build transition reason string
   * @param {number} volExpansion - Vol expansion
   * @param {{magnitude: number, direction: string}} momentum - Momentum
   * @param {number} vwapDistance - VWAP distance
   * @returns {string}
   */
  const buildTransitionReason = (volExpansion, momentum, vwapDistance) => {
    return `vol_exp=${volExpansion.toFixed(2)}, momentum=${momentum.direction}:${momentum.magnitude.toFixed(1)}bps, vwap_dist=${vwapDistance.toFixed(2)}`;
  };

  /**
   * Transition to new regime
   * @param {RegimeMode} newMode - New regime mode
   * @param {string} reason - Transition reason
   * @param {string} [direction] - Direction at the transition, if known
   */
  const transition = (newMode, reason, direction) => {
    const prevMode = state.mode;
    state.mode = newMode;
    if (newMode === 'TREND') {
      state.trendConfirmationCount = config.trendConfirmationPeriods;
      state.trendDirection = direction === 'up' || direction === 'down' ? direction : null;
    } else if (newMode === 'HARVEST' || prevMode === 'TREND') {
      state.trendConfirmationCount = 0;
      state.trendDirection = null;
    }
    state.since = Date.now();
    state.transitionCount++;

    logger.info(`📊 [${exchange}] Regime: ${prevMode} -> ${newMode} (${reason})`, {
      previousMode: prevMode, mode: newMode, reason,
    });

    if (callbacks.onTransition) {
      callbacks.onTransition(prevMode, newMode, reason);
    }
  };

  /**
   * Force regime transition (for external triggers like flash moves)
   * @param {RegimeMode} newMode - New regime mode
   * @param {string} reason - Reason for forced transition
   */
  const forceTransition = (newMode, reason) => {
    if (state.mode !== newMode) {
      transition(newMode, `forced:${reason}`);
    }
  };

  /**
   * Get current regime state
   * @returns {RegimeState}
   */
  const getState = () => state;

  /**
   * Get current regime mode
   * @returns {RegimeMode}
   */
  const getMode = () => state.mode;

  /**
   * Get regime summary for logging
   * @returns {string}
   */
  const getSummary = () => {
    const { mode, transitionCount, lastVolExpansion, lastMomentumMag, trendDirection } = state;
    const duration = Math.round((Date.now() - state.since) / 1000);

    let summary = `mode=${mode} duration=${duration}s transitions=${transitionCount}`;
    summary += ` vol_exp=${lastVolExpansion.toFixed(2)} momentum=${lastMomentumMag.toFixed(1)}bps`;

    if (mode === 'TREND' && trendDirection) {
      summary += ` direction=${trendDirection}`;
    }

    return summary;
  };

  /**
   * Get scale factor for current regime
   * @returns {number}
   */
  const getRegimeScale = () => {
    switch (state.mode) {
      case 'HARVEST':
        return config.harvestScale;
      case 'CAUTION':
        return config.cautionScale;
      case 'TREND':
        return config.trendScale;
      default:
        return 1.0;
    }
  };

  /**
   * Check if entries are allowed in current regime
   * @returns {boolean}
   */
  const allowsEntries = () => {
    return state.mode !== 'TREND' || config.trendScale > 0;
  };

  /**
   * Reset to initial state
   */
  const reset = () => {
    state = createInitialRegimeState();
    warmupReadingsRemaining = 0;
  };

  /**
   * Restore state from saved data (for restart recovery)
   * @param {RegimeState} savedState - Saved regime state
   */
  const restoreState = (savedState) => {
    if (!savedState) return;

    state = {
      ...createInitialRegimeState(),
      ...savedState,
      // Reset 'since' timestamp to current session start
      since: Date.now(),
    };

    warmupReadingsRemaining = config.trendConfirmationPeriods;
    state.trendConfirmationCount = 0;

    logger.info(`📂 [${exchange}] Restored regime state: mode=${state.mode}, transitions=${state.transitionCount}`, {
      mode: state.mode, transitionCount: state.transitionCount,
    });
  };

  return {
    classify,
    forceTransition,
    getState,
    getMode,
    getSummary,
    getRegimeScale,
    allowsEntries,
    reset,
    restoreState,
  };
};

module.exports = {
  createRegimeDetector,
  createInitialRegimeState,
};
