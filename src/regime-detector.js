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
 * @returns {Object} Regime detector instance
 */
const createRegimeDetector = (exchange, config, callbacks = {}) => {
  /** @type {RegimeState} */
  let state = createInitialRegimeState();

  /** @type {Array<{direction: string, timestamp: number}>} */
  let momentumHistory = [];

  /**
   * Classify current regime based on market conditions
   * @param {MarketState} marketState - Current market state
   * @returns {RegimeMode} Detected regime
   */
  const classify = (marketState) => {
    const { realizedVol, volBaseline, atr1m, vwap, lastPrice } = marketState;

    // Calculate key metrics
    const volExpansion = calculateVolExpansion(realizedVol, volBaseline);
    const vwapDistance = calculateVWAPDistance(lastPrice, vwap, atr1m);
    const momentum = calculateMomentumSignal(marketState);

    state.lastVolExpansion = volExpansion;
    state.lastMomentumMag = momentum.magnitude;

    const prevMode = state.mode;
    let newMode = prevMode;

    // Transition logic based on current mode
    if (prevMode === 'HARVEST') {
      newMode = classifyFromHarvest(volExpansion, momentum, vwapDistance);
    } else if (prevMode === 'CAUTION') {
      newMode = classifyFromCaution(volExpansion, momentum, vwapDistance);
    } else if (prevMode === 'TREND') {
      newMode = classifyFromTrend(volExpansion, momentum, vwapDistance);
    }

    // Handle transition
    if (newMode !== prevMode) {
      transition(newMode, buildTransitionReason(volExpansion, momentum, vwapDistance));
    }

    return state.mode;
  };

  /**
   * Classify from HARVEST mode
   * @param {number} volExpansion - Volatility expansion ratio
   * @param {{magnitude: number, direction: string}} momentum - Momentum signal
   * @param {number} vwapDistance - VWAP distance in ATR units
   * @returns {RegimeMode}
   */
  const classifyFromHarvest = (volExpansion, momentum, vwapDistance) => {
    // Check for sudden spike (HARVEST -> TREND directly)
    if (volExpansion > 2.0 && momentum.magnitude > 2 * config.momentumMult * 100) {
      return 'TREND';
    }

    // Check for elevated conditions (HARVEST -> CAUTION)
    if (volExpansion > config.volExpansionMult ||
        momentum.magnitude > config.momentumMult * 100) {
      return 'CAUTION';
    }

    return 'HARVEST';
  };

  /**
   * Classify from CAUTION mode
   * @param {number} volExpansion - Volatility expansion ratio
   * @param {{magnitude: number, direction: string}} momentum - Momentum signal
   * @param {number} vwapDistance - VWAP distance in ATR units
   * @returns {RegimeMode}
   */
  const classifyFromCaution = (volExpansion, momentum, vwapDistance) => {
    // Check for return to calm (CAUTION -> HARVEST)
    if (volExpansion < config.volContractionMult &&
        momentum.magnitude < config.momentumMult * 50 &&
        Math.abs(vwapDistance) < 1.0) {
      state.trendConfirmationCount = 0;
      return 'HARVEST';
    }

    // Check for trend confirmation (CAUTION -> TREND)
    if (isTrendConfirmed(momentum, vwapDistance)) {
      return 'TREND';
    }

    return 'CAUTION';
  };

  /**
   * Classify from TREND mode
   * @param {number} volExpansion - Volatility expansion ratio
   * @param {{magnitude: number, direction: string}} momentum - Momentum signal
   * @param {number} vwapDistance - VWAP distance in ATR units
   * @returns {RegimeMode}
   */
  const classifyFromTrend = (volExpansion, momentum, vwapDistance) => {
    // Check for trend weakening (TREND -> CAUTION)
    if (!isTrendConfirmed(momentum, vwapDistance) || Math.abs(vwapDistance) < 1.0) {
      state.trendConfirmationCount = 0;
      return 'CAUTION';
    }

    return 'TREND';
  };

  /**
   * Calculate momentum signal from market state
   * @param {MarketState} marketState - Market state
   * @returns {{magnitude: number, direction: string}}
   */
  const calculateMomentumSignal = (marketState) => {
    const { lastPrice, vwap, tradeImbalance } = marketState;

    // Use VWAP divergence as momentum proxy
    const vwapDelta = lastPrice - vwap;
    const magnitude = Math.abs(vwapDelta);
    const direction = vwapDelta > 0 ? 'up' : vwapDelta < 0 ? 'down' : 'neutral';

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

    // Record momentum history
    momentumHistory.push({ direction, timestamp: Date.now() });

    // Keep last 10 readings
    if (momentumHistory.length > 10) {
      momentumHistory.shift();
    }

    return { magnitude: adjustedMagnitude, direction };
  };

  /**
   * Check if trend is confirmed
   * @param {{magnitude: number, direction: string}} momentum - Current momentum
   * @param {number} vwapDistance - VWAP distance
   * @returns {boolean}
   */
  const isTrendConfirmed = (momentum, vwapDistance) => {
    // Need sustained directional pressure
    if (Math.abs(vwapDistance) < 2.0) {
      state.trendConfirmationCount = 0;
      return false;
    }

    // Check momentum history for consistency
    const recentMomentum = momentumHistory.slice(-config.trendConfirmationPeriods);
    if (recentMomentum.length < config.trendConfirmationPeriods) {
      return false;
    }

    const expectedDirection = vwapDistance > 0 ? 'up' : 'down';
    const consistent = recentMomentum.every(m => m.direction === expectedDirection);

    if (consistent) {
      state.trendConfirmationCount++;
      state.trendDirection = expectedDirection;
      return state.trendConfirmationCount >= config.trendConfirmationPeriods;
    }

    state.trendConfirmationCount = 0;
    return false;
  };

  /**
   * Build transition reason string
   * @param {number} volExpansion - Vol expansion
   * @param {{magnitude: number, direction: string}} momentum - Momentum
   * @param {number} vwapDistance - VWAP distance
   * @returns {string}
   */
  const buildTransitionReason = (volExpansion, momentum, vwapDistance) => {
    return `vol_exp=${volExpansion.toFixed(2)}, momentum=${momentum.direction}:${momentum.magnitude.toFixed(0)}, vwap_dist=${vwapDistance.toFixed(2)}`;
  };

  /**
   * Transition to new regime
   * @param {RegimeMode} newMode - New regime mode
   * @param {string} reason - Transition reason
   */
  const transition = (newMode, reason) => {
    const prevMode = state.mode;
    state.mode = newMode;
    state.since = Date.now();
    state.transitionCount++;

    console.log(`📊 [${exchange}] Regime: ${prevMode} -> ${newMode} (${reason})`);

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
    summary += ` vol_exp=${lastVolExpansion.toFixed(2)} momentum=${lastMomentumMag.toFixed(0)}`;

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
    momentumHistory = [];
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

    console.log(`📂 [${exchange}] Restored regime state: mode=${state.mode}, transitions=${state.transitionCount}`);
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
