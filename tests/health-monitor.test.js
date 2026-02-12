// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createHealthMonitor, createInitialHealthState } = require('../src/health-monitor');

/**
 * Build a minimal config with sensible defaults, overridable per-test
 */
const createTestConfig = (overrides = {}) => ({
  staleDataMs: 30000,
  staleOrdersMs: 60000,
  maxRestErrors: 5,
  maxRateLimits: 3,
  maxLatencyMs: 5000,
  safeRecoveryMs: 60000,
  ...overrides,
});

// ============================================================================
// createInitialHealthState
// ============================================================================
describe('createInitialHealthState', () => {
  it('returns ACTIVE mode with null reason', () => {
    const state = createInitialHealthState();
    assert.equal(state.mode, 'ACTIVE');
    assert.equal(state.reason, null);
  });

  it('initializes all healthChecks to zero/false', () => {
    const state = createInitialHealthState();
    assert.equal(state.healthChecks.wsConnected, false);
    assert.equal(state.healthChecks.lastTickerMs, 0);
    assert.equal(state.healthChecks.lastOrderUpdateMs, 0);
    assert.equal(state.healthChecks.restErrorCount, 0);
    assert.equal(state.healthChecks.rateLimitCount, 0);
    assert.equal(state.healthChecks.avgLatencyMs, 0);
  });
});

// ============================================================================
// Health state tracking
// ============================================================================
describe('Health state tracking', () => {
  let monitor;

  beforeEach(() => {
    monitor = createHealthMonitor('test-exchange', createTestConfig());
  });

  it('starts in ACTIVE mode', () => {
    const state = monitor.getState();
    assert.equal(state.mode, 'ACTIVE');
    assert.equal(state.reason, null);
  });

  it('canPlaceEntry allows entries in ACTIVE mode', () => {
    const result = monitor.canPlaceEntry();
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });

  it('canPlaceEntry blocks entries in SAFE mode', () => {
    monitor.enterSafeMode('test_reason');
    const result = monitor.canPlaceEntry();
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'system_safe');
  });

  it('canPlaceEntry blocks entries in PAUSED mode', () => {
    monitor.pause('maintenance');
    const result = monitor.canPlaceEntry();
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'system_paused');
  });
});

// ============================================================================
// SAFE mode transitions
// ============================================================================
describe('SAFE mode transitions', () => {
  let monitor;
  let safeModeReasons;
  let activeModeCount;

  beforeEach(() => {
    safeModeReasons = [];
    activeModeCount = 0;
    monitor = createHealthMonitor('test-exchange', createTestConfig(), {
      onSafeMode: (reason) => safeModeReasons.push(reason),
      onActiveMode: () => activeModeCount++,
    });
  });

  it('enterSafeMode transitions from ACTIVE to SAFE and fires callback', () => {
    monitor.enterSafeMode('test_disconnect');
    const state = monitor.getState();
    assert.equal(state.mode, 'SAFE');
    assert.equal(state.reason, 'test_disconnect');
    assert.equal(safeModeReasons.length, 1);
    assert.equal(safeModeReasons[0], 'test_disconnect');
  });

  it('enterSafeMode is idempotent when already in SAFE mode', () => {
    monitor.enterSafeMode('first_reason');
    monitor.enterSafeMode('second_reason');
    // Should still have the first reason, second call is a no-op
    assert.equal(monitor.getState().reason, 'first_reason');
    assert.equal(safeModeReasons.length, 1);
  });

  it('exitSafeMode transitions from SAFE to ACTIVE and fires callback', () => {
    monitor.enterSafeMode('temp_issue');
    monitor.exitSafeMode();
    const state = monitor.getState();
    assert.equal(state.mode, 'ACTIVE');
    assert.equal(state.reason, null);
    assert.equal(activeModeCount, 1);
  });

  it('exitSafeMode is a no-op when already ACTIVE', () => {
    monitor.exitSafeMode();
    assert.equal(monitor.getState().mode, 'ACTIVE');
    assert.equal(activeModeCount, 0);
  });

  it('pause overrides to PAUSED mode regardless of current mode', () => {
    monitor.enterSafeMode('some_issue');
    monitor.pause('manual_stop');
    const state = monitor.getState();
    assert.equal(state.mode, 'PAUSED');
    assert.equal(state.reason, 'manual_stop');
  });

  it('resume transitions from PAUSED back to ACTIVE', () => {
    monitor.pause('downtime');
    monitor.resume();
    const state = monitor.getState();
    assert.equal(state.mode, 'ACTIVE');
    assert.equal(state.reason, null);
  });

  it('resume is a no-op when already ACTIVE', () => {
    const beforeSince = monitor.getState().since;
    monitor.resume();
    // Since should not change because resume was a no-op
    assert.equal(monitor.getState().since, beforeSince);
  });
});

// ============================================================================
// WebSocket status recording
// ============================================================================
describe('WebSocket status recording', () => {
  it('recordWsStatus(true) sets wsConnected to true', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.recordWsStatus(true);
    assert.equal(monitor.getState().healthChecks.wsConnected, true);
  });

  it('recordWsStatus(false) triggers SAFE mode when ACTIVE', () => {
    let safeReason = null;
    const monitor = createHealthMonitor('test', createTestConfig(), {
      onSafeMode: (reason) => { safeReason = reason; },
    });
    monitor.recordWsStatus(true); // first connect
    monitor.recordWsStatus(false); // disconnect
    assert.equal(monitor.getState().mode, 'SAFE');
    assert.equal(monitor.getState().reason, 'websocket_disconnected');
    assert.equal(safeReason, 'websocket_disconnected');
  });

  it('recordWsStatus(false) does not re-enter SAFE when already SAFE', () => {
    let safeCount = 0;
    const monitor = createHealthMonitor('test', createTestConfig(), {
      onSafeMode: () => { safeCount++; },
    });
    monitor.enterSafeMode('other_reason');
    monitor.recordWsStatus(false);
    // Should not have called onSafeMode again (already SAFE)
    assert.equal(safeCount, 1);
    // Reason should remain the original
    assert.equal(monitor.getState().reason, 'other_reason');
  });
});

// ============================================================================
// REST error tracking
// ============================================================================
describe('REST error tracking', () => {
  it('recordRestError increments the error count', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.recordRestError();
    monitor.recordRestError();
    monitor.recordRestError();
    assert.equal(monitor.getState().healthChecks.restErrorCount, 3);
  });

  it('recordRateLimit increments the rate limit count', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.recordRateLimit();
    monitor.recordRateLimit();
    assert.equal(monitor.getState().healthChecks.rateLimitCount, 2);
  });

  it('resetErrorCounts clears both error and rate limit counts', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.recordRestError();
    monitor.recordRestError();
    monitor.recordRateLimit();
    monitor.resetErrorCounts();
    assert.equal(monitor.getState().healthChecks.restErrorCount, 0);
    assert.equal(monitor.getState().healthChecks.rateLimitCount, 0);
  });

  it('recordRestLatency computes rolling average', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.recordRestLatency(100);
    monitor.recordRestLatency(200);
    monitor.recordRestLatency(300);
    // Average of [100, 200, 300] = 200
    assert.equal(monitor.getState().healthChecks.avgLatencyMs, 200);
  });

  it('recordRestLatency caps sliding window at 20 entries', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    // Push 20 entries of 100ms
    for (let i = 0; i < 20; i++) {
      monitor.recordRestLatency(100);
    }
    assert.equal(monitor.getState().healthChecks.avgLatencyMs, 100);
    // Push 1 more at 200ms; oldest 100 is evicted, window is [100x19, 200]
    monitor.recordRestLatency(200);
    // Average = (19*100 + 200) / 20 = 2100/20 = 105
    assert.equal(monitor.getState().healthChecks.avgLatencyMs, 105);
  });
});

// ============================================================================
// Data staleness detection via checkHealth
// ============================================================================
describe('Data staleness detection (checkHealth)', () => {
  it('does not trigger SAFE mode if ticker data has never been received', () => {
    const monitor = createHealthMonitor('test', createTestConfig({ staleDataMs: 100 }));
    monitor.recordWsStatus(true);
    // lastTickerMs is 0, so staleness check should be skipped
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'ACTIVE');
  });

  it('triggers SAFE mode when ticker data exceeds staleDataMs', () => {
    const monitor = createHealthMonitor('test', createTestConfig({ staleDataMs: 1 }));
    monitor.recordWsStatus(true);
    monitor.recordTickerUpdate();
    // Make the ticker stale by waiting a tiny bit (staleDataMs=1)
    // We manipulate the state directly to simulate time passing
    monitor.getState().healthChecks.lastTickerMs = Date.now() - 5000;
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    assert.ok(state.reason.includes('stale_data'));
  });

  it('triggers SAFE mode when order updates exceed staleOrdersMs', () => {
    const monitor = createHealthMonitor('test', createTestConfig({ staleOrdersMs: 1 }));
    monitor.recordWsStatus(true);
    monitor.recordOrderUpdate();
    monitor.getState().healthChecks.lastOrderUpdateMs = Date.now() - 5000;
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    assert.ok(state.reason.includes('stale_orders'));
  });

  it('triggers SAFE mode when REST errors exceed maxRestErrors', () => {
    const config = createTestConfig({ maxRestErrors: 2 });
    const monitor = createHealthMonitor('test', config);
    monitor.recordWsStatus(true);
    monitor.recordRestError();
    monitor.recordRestError();
    monitor.recordRestError(); // 3 > 2
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    assert.ok(state.reason.includes('rest_errors'));
  });

  it('triggers SAFE mode when rate limits exceed maxRateLimits', () => {
    const config = createTestConfig({ maxRateLimits: 1 });
    const monitor = createHealthMonitor('test', config);
    monitor.recordWsStatus(true);
    monitor.recordRateLimit();
    monitor.recordRateLimit(); // 2 > 1
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    assert.ok(state.reason.includes('rate_limits'));
  });

  it('triggers SAFE mode when latency exceeds maxLatencyMs', () => {
    const config = createTestConfig({ maxLatencyMs: 100 });
    const monitor = createHealthMonitor('test', config);
    monitor.recordWsStatus(true);
    monitor.recordRestLatency(200);
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    assert.ok(state.reason.includes('high_latency'));
  });

  it('checkHealth skips auto-transitions while PAUSED', () => {
    const monitor = createHealthMonitor('test', createTestConfig({ staleDataMs: 1 }));
    monitor.recordTickerUpdate();
    monitor.getState().healthChecks.lastTickerMs = Date.now() - 5000;
    monitor.pause('admin');
    const state = monitor.checkHealth();
    // Should remain PAUSED, not transition to SAFE
    assert.equal(state.mode, 'PAUSED');
  });

  it('aggregates multiple issues into a single SAFE mode reason', () => {
    const config = createTestConfig({ maxRestErrors: 0, maxLatencyMs: 1 });
    const monitor = createHealthMonitor('test', config);
    // ws is disconnected by default (wsConnected starts false)
    monitor.recordRestError(); // 1 > 0
    monitor.recordRestLatency(100); // 100 > 1
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'SAFE');
    // Reason should contain multiple issues separated by commas
    assert.ok(state.reason.includes('rest_errors'));
    assert.ok(state.reason.includes('high_latency'));
    assert.ok(state.reason.includes('ws_disconnected'));
  });
});

// ============================================================================
// SAFE mode recovery via checkHealth
// ============================================================================
describe('SAFE mode recovery', () => {
  it('exits SAFE mode after healthy duration exceeds safeRecoveryMs', () => {
    // Use a very short recovery period for testing
    const config = createTestConfig({ safeRecoveryMs: 0 });
    let activeFired = false;
    const monitor = createHealthMonitor('test', config, {
      onActiveMode: () => { activeFired = true; },
    });
    monitor.recordWsStatus(true);

    // Enter SAFE mode manually
    monitor.enterSafeMode('temporary');
    assert.equal(monitor.getState().mode, 'SAFE');

    // checkHealth: all is healthy now (ws connected, no errors, no stale data)
    // With safeRecoveryMs=0 the first healthy check should trigger exit
    // First call sets lastHealthyTimestamp (was reset to 0 by issues)
    monitor.checkHealth();
    // Second call sees healthy duration >= 0
    const state = monitor.checkHealth();
    assert.equal(state.mode, 'ACTIVE');
    assert.equal(activeFired, true);
  });
});

// ============================================================================
// getSummary
// ============================================================================
describe('getSummary', () => {
  it('includes mode and ws status', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    const summary = monitor.getSummary();
    assert.ok(summary.includes('mode=ACTIVE'));
    assert.ok(summary.includes('ws=disconnected'));
  });

  it('includes reason, latency, errors, and rate limits when present', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.enterSafeMode('bad_things');
    monitor.recordWsStatus(true);
    monitor.recordRestLatency(150);
    monitor.recordRestError();
    monitor.recordRateLimit();
    const summary = monitor.getSummary();
    assert.ok(summary.includes('mode=SAFE'));
    assert.ok(summary.includes('reason=bad_things'));
    assert.ok(summary.includes('ws=connected'));
    assert.ok(summary.includes('latency=150ms'));
    assert.ok(summary.includes('errors=1'));
    assert.ok(summary.includes('ratelimits=1'));
  });
});

// ============================================================================
// Edge cases
// ============================================================================
describe('Edge cases', () => {
  it('recordTickerUpdate and recordOrderUpdate set timestamps to roughly now', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    const before = Date.now();
    monitor.recordTickerUpdate();
    monitor.recordOrderUpdate();
    const after = Date.now();
    const { lastTickerMs, lastOrderUpdateMs } = monitor.getState().healthChecks;
    assert.ok(lastTickerMs >= before && lastTickerMs <= after);
    assert.ok(lastOrderUpdateMs >= before && lastOrderUpdateMs <= after);
  });

  it('resume from SAFE mode resets lastHealthyTimestamp (prevents stale recovery)', () => {
    const config = createTestConfig({ safeRecoveryMs: 999999 });
    const monitor = createHealthMonitor('test', config);
    monitor.recordWsStatus(true);
    monitor.enterSafeMode('issue');

    // Manual resume should work even though safeRecoveryMs is very large
    monitor.resume();
    assert.equal(monitor.getState().mode, 'ACTIVE');
    assert.equal(monitor.getState().reason, null);
  });

  it('works without providing any callbacks', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    // These should not throw even with no callbacks
    monitor.enterSafeMode('no_callbacks');
    monitor.exitSafeMode();
    assert.equal(monitor.getState().mode, 'ACTIVE');
  });

  it('pause uses default reason when none provided', () => {
    const monitor = createHealthMonitor('test', createTestConfig());
    monitor.pause();
    assert.equal(monitor.getState().reason, 'manual_pause');
  });
});
