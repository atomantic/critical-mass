// @ts-check
/**
 * Health Monitor
 *
 * Monitors system health and manages SAFE mode transitions.
 * Triggers:
 * - Stale market data
 * - Stale order updates
 * - REST error bursts
 * - Rate limit events
 * - Latency spikes
 * - WebSocket disconnection
 */

/**
 * @typedef {import('./types').HealthState} HealthState
 * @typedef {import('./types').HealthMode} HealthMode
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

/**
 * Create initial health state
 * @returns {HealthState}
 */
const createInitialHealthState = () => ({
  mode: 'ACTIVE',
  since: Date.now(),
  reason: null,
  healthChecks: {
    wsConnected: false,
    lastTickerMs: 0,
    lastOrderUpdateMs: 0,
    restErrorCount: 0,
    rateLimitCount: 0,
    avgLatencyMs: 0,
  },
});

/**
 * Create health monitor instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onSafeMode] - Called when entering SAFE mode
 * @param {Function} [callbacks.onActiveMode] - Called when entering ACTIVE mode
 * @returns {Object} Health monitor instance
 */
const createHealthMonitor = (exchange, config, callbacks = {}) => {
  /** @type {HealthState} */
  let state = createInitialHealthState();

  /** @type {number[]} */
  let restLatencies = [];

  /** @type {number[]} */
  let errorTimestamps = [];

  /** @type {number[]} */
  let rateLimitTimestamps = [];

  let lastHealthyTimestamp = Date.now();

  const ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 minute window

  /**
   * Record WebSocket connection status
   * @param {boolean} connected
   */
  const recordWsStatus = (connected) => {
    state.healthChecks.wsConnected = connected;

    if (!connected && state.mode === 'ACTIVE') {
      enterSafeMode('websocket_disconnected');
    }
  };

  /**
   * Record ticker update
   */
  const recordTickerUpdate = () => {
    state.healthChecks.lastTickerMs = Date.now();
  };

  /**
   * Record order update
   */
  const recordOrderUpdate = () => {
    state.healthChecks.lastOrderUpdateMs = Date.now();
  };

  /**
   * Record REST API latency
   * @param {number} latencyMs - Latency in milliseconds
   */
  const recordRestLatency = (latencyMs) => {
    restLatencies.push(latencyMs);

    // Keep last 20 latencies
    if (restLatencies.length > 20) {
      restLatencies.shift();
    }

    // Calculate average
    const avg = restLatencies.reduce((a, b) => a + b, 0) / restLatencies.length;
    state.healthChecks.avgLatencyMs = Math.round(avg);
  };

  /**
   * Record REST API error
   */
  const recordRestError = () => {
    const now = Date.now();
    errorTimestamps.push(now);

    // Prune old timestamps
    errorTimestamps = errorTimestamps.filter(t => now - t < ERROR_WINDOW_MS);
    state.healthChecks.restErrorCount = errorTimestamps.length;
  };

  /**
   * Record rate limit response
   */
  const recordRateLimit = () => {
    const now = Date.now();
    rateLimitTimestamps.push(now);

    // Prune old timestamps
    rateLimitTimestamps = rateLimitTimestamps.filter(t => now - t < ERROR_WINDOW_MS);
    state.healthChecks.rateLimitCount = rateLimitTimestamps.length;
  };

  /**
   * Enter SAFE mode
   * @param {string} reason - Reason for entering SAFE mode
   */
  const enterSafeMode = (reason) => {
    if (state.mode === 'SAFE') return;

    state.mode = 'SAFE';
    state.since = Date.now();
    state.reason = reason;

    console.log(`⚠️ [${exchange}] Entering SAFE mode: ${reason}`);

    if (callbacks.onSafeMode) {
      callbacks.onSafeMode(reason);
    }
  };

  /**
   * Exit SAFE mode and return to ACTIVE
   */
  const exitSafeMode = () => {
    if (state.mode !== 'SAFE') return;

    state.mode = 'ACTIVE';
    state.since = Date.now();
    state.reason = null;

    console.log(`✅ [${exchange}] Exiting SAFE mode, returning to ACTIVE`);

    if (callbacks.onActiveMode) {
      callbacks.onActiveMode();
    }
  };

  /**
   * Pause system (manual)
   * @param {string} [reason] - Reason for pause
   */
  const pause = (reason = 'manual_pause') => {
    state.mode = 'PAUSED';
    state.since = Date.now();
    state.reason = reason;

    console.log(`⏸️ [${exchange}] System paused: ${reason}`);
  };

  /**
   * Resume system from pause
   */
  const resume = () => {
    if (state.mode !== 'PAUSED') return;

    state.mode = 'ACTIVE';
    state.since = Date.now();
    state.reason = null;

    console.log(`▶️ [${exchange}] System resumed`);
  };

  /**
   * Check all health conditions and update state
   * @returns {HealthState}
   */
  const checkHealth = () => {
    const now = Date.now();

    // If manually paused, don't auto-transition
    if (state.mode === 'PAUSED') {
      return state;
    }

    // Check for conditions that trigger SAFE mode
    const issues = [];

    // Stale market data
    if (state.healthChecks.lastTickerMs > 0) {
      const tickerAge = now - state.healthChecks.lastTickerMs;
      if (tickerAge > config.staleDataMs) {
        issues.push(`stale_data:${Math.round(tickerAge / 1000)}s`);
      }
    }

    // Stale order updates
    if (state.healthChecks.lastOrderUpdateMs > 0) {
      const orderAge = now - state.healthChecks.lastOrderUpdateMs;
      if (orderAge > config.staleOrdersMs) {
        issues.push(`stale_orders:${Math.round(orderAge / 1000)}s`);
      }
    }

    // REST error burst
    if (state.healthChecks.restErrorCount > config.maxRestErrors) {
      issues.push(`rest_errors:${state.healthChecks.restErrorCount}`);
    }

    // Rate limit burst
    if (state.healthChecks.rateLimitCount > config.maxRateLimits) {
      issues.push(`rate_limits:${state.healthChecks.rateLimitCount}`);
    }

    // Latency spike
    if (state.healthChecks.avgLatencyMs > config.maxLatencyMs) {
      issues.push(`high_latency:${state.healthChecks.avgLatencyMs}ms`);
    }

    // WebSocket disconnected
    if (!state.healthChecks.wsConnected) {
      issues.push('ws_disconnected');
    }

    if (issues.length > 0) {
      // Something is wrong
      if (state.mode === 'ACTIVE') {
        enterSafeMode(issues.join(', '));
      }
      lastHealthyTimestamp = 0;
    } else {
      // All healthy
      if (lastHealthyTimestamp === 0) {
        lastHealthyTimestamp = now;
      }

      // Check if healthy long enough to exit SAFE mode
      if (state.mode === 'SAFE') {
        const healthyDuration = now - lastHealthyTimestamp;
        if (healthyDuration >= config.safeRecoveryMs) {
          exitSafeMode();
        }
      }
    }

    return state;
  };

  /**
   * Check if entries are allowed
   * @returns {{allowed: boolean, reason: string|null}}
   */
  const canPlaceEntry = () => {
    if (state.mode === 'ACTIVE') {
      return { allowed: true, reason: null };
    }
    return { allowed: false, reason: `system_${state.mode.toLowerCase()}` };
  };

  /**
   * Get current health state
   * @returns {HealthState}
   */
  const getState = () => state;

  /**
   * Get health summary for logging
   * @returns {string}
   */
  const getSummary = () => {
    const { mode, reason, healthChecks } = state;
    const parts = [`mode=${mode}`];

    if (reason) parts.push(`reason=${reason}`);
    if (healthChecks.wsConnected) parts.push('ws=connected');
    else parts.push('ws=disconnected');
    if (healthChecks.avgLatencyMs > 0) parts.push(`latency=${healthChecks.avgLatencyMs}ms`);
    if (healthChecks.restErrorCount > 0) parts.push(`errors=${healthChecks.restErrorCount}`);
    if (healthChecks.rateLimitCount > 0) parts.push(`ratelimits=${healthChecks.rateLimitCount}`);

    return parts.join(' ');
  };

  /**
   * Reset error counts (for testing or manual reset)
   */
  const resetErrorCounts = () => {
    errorTimestamps = [];
    rateLimitTimestamps = [];
    state.healthChecks.restErrorCount = 0;
    state.healthChecks.rateLimitCount = 0;
  };

  return {
    recordWsStatus,
    recordTickerUpdate,
    recordOrderUpdate,
    recordRestLatency,
    recordRestError,
    recordRateLimit,
    enterSafeMode,
    exitSafeMode,
    pause,
    resume,
    checkHealth,
    canPlaceEntry,
    getState,
    getSummary,
    resetErrorCounts,
  };
};

module.exports = {
  createHealthMonitor,
  createInitialHealthState,
};
