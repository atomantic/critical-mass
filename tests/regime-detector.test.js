// @ts-check
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createRegimeDetector, createInitialRegimeState } = require('../src/regime-detector');

// ============================================================================
// Helper: default config matching typical production values
// ============================================================================
const createTestConfig = (overrides = {}) => ({
  volExpansionMult: 1.5,
  volContractionMult: 1.0,
  momentumMult: 1.0,
  trendConfirmationPeriods: 3,
  harvestScale: 1.0,
  cautionScale: 0.5,
  trendScale: 0.0,
  ...overrides,
});

/**
 * Build a minimal marketState object with sensible defaults.
 * Override any field by passing it in `overrides`.
 */
const createMarketState = (overrides = {}) => ({
  realizedVol: 0.5,
  volBaseline: 0.5,
  atr1m: 100,
  vwap: 100000,
  lastPrice: 100000,
  tradeImbalance: 0,
  ...overrides,
});

// ============================================================================
// createInitialRegimeState
// ============================================================================
describe('createInitialRegimeState', () => {
  it('returns HARVEST mode by default', () => {
    const s = createInitialRegimeState();
    assert.equal(s.mode, 'HARVEST');
  });

  it('starts with zero transition count', () => {
    const s = createInitialRegimeState();
    assert.equal(s.transitionCount, 0);
  });

  it('has no trend direction initially', () => {
    const s = createInitialRegimeState();
    assert.equal(s.trendDirection, null);
  });

  it('initializes numeric fields to sensible defaults', () => {
    const s = createInitialRegimeState();
    assert.equal(s.lastVolExpansion, 1.0);
    assert.equal(s.lastMomentumMag, 0);
    assert.equal(s.trendConfirmationCount, 0);
  });
});

// ============================================================================
// Factory: createRegimeDetector basics
// ============================================================================
describe('createRegimeDetector - factory and accessors', () => {
  it('returns an object with all expected methods', () => {
    const det = createRegimeDetector('test-exchange', createTestConfig());
    const keys = Object.keys(det);
    for (const k of ['classify', 'forceTransition', 'getState', 'getMode',
      'getSummary', 'getRegimeScale', 'allowsEntries', 'reset', 'restoreState']) {
      assert.ok(keys.includes(k), `missing method: ${k}`);
    }
  });

  it('starts in HARVEST mode', () => {
    const det = createRegimeDetector('test-exchange', createTestConfig());
    assert.equal(det.getMode(), 'HARVEST');
  });

  it('getState returns full regime state object', () => {
    const det = createRegimeDetector('test-exchange', createTestConfig());
    const state = det.getState();
    assert.equal(state.mode, 'HARVEST');
    assert.equal(typeof state.since, 'number');
    assert.equal(state.transitionCount, 0);
  });
});

// ============================================================================
// HARVEST regime detection - staying in HARVEST
// ============================================================================
describe('Regime detection - HARVEST stays HARVEST', () => {
  it('remains HARVEST when volatility and momentum are low', () => {
    const det = createRegimeDetector('test', createTestConfig());
    // vol expansion = 0.5/0.5 = 1.0, below volExpansionMult=1.5
    // momentum = |100000 - 100000| = 0 < momentumMult * 100 = 100
    const mode = det.classify(createMarketState());
    assert.equal(mode, 'HARVEST');
  });

  it('remains HARVEST with zero volatility (baseline and realized both zero)', () => {
    const det = createRegimeDetector('test', createTestConfig());
    // calculateVolExpansion returns 1 when baseline <= 0
    const mode = det.classify(createMarketState({
      realizedVol: 0,
      volBaseline: 0,
      lastPrice: 100000,
      vwap: 100000,
    }));
    assert.equal(mode, 'HARVEST');
  });
});

// ============================================================================
// HARVEST -> CAUTION transition
// ============================================================================
describe('Regime transition - HARVEST to CAUTION', () => {
  it('transitions to CAUTION when vol expansion exceeds threshold', () => {
    const config = createTestConfig({ volExpansionMult: 1.5 });
    const det = createRegimeDetector('test', config);
    // realizedVol/volBaseline = 1.0/0.5 = 2.0, which > 1.5
    const mode = det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
      lastPrice: 100000,
      vwap: 100000,
    }));
    assert.equal(mode, 'CAUTION');
  });

  it('transitions to CAUTION when momentum exceeds threshold', () => {
    const config = createTestConfig({ momentumMult: 1.0 });
    const det = createRegimeDetector('test', config);
    // momentum magnitude = |lastPrice - vwap| = |100200 - 100000| = 200
    // threshold = momentumMult * 100 = 100, 200 > 100 -> CAUTION
    const mode = det.classify(createMarketState({
      realizedVol: 0.5,
      volBaseline: 0.5,
      lastPrice: 100200,
      vwap: 100000,
    }));
    assert.equal(mode, 'CAUTION');
  });

  it('increments transitionCount on HARVEST -> CAUTION', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
    }));
    assert.equal(det.getState().transitionCount, 1);
  });
});

// ============================================================================
// HARVEST -> TREND (sudden spike, bypasses CAUTION)
// ============================================================================
describe('Regime transition - HARVEST to TREND (sudden spike)', () => {
  it('transitions directly to TREND when vol expansion > 2.0 AND momentum > 2x threshold', () => {
    const config = createTestConfig({ momentumMult: 1.0 });
    const det = createRegimeDetector('test', config);
    // volExpansion = 1.5/0.5 = 3.0 > 2.0
    // momentum = |100500 - 100000| = 500, threshold = 2 * 1.0 * 100 = 200 -> 500 > 200
    const mode = det.classify(createMarketState({
      realizedVol: 1.5,
      volBaseline: 0.5,
      lastPrice: 100500,
      vwap: 100000,
    }));
    assert.equal(mode, 'TREND');
  });

  it('does NOT jump to TREND if vol expansion is high but momentum is low', () => {
    const config = createTestConfig({ momentumMult: 1.0 });
    const det = createRegimeDetector('test', config);
    // volExpansion = 1.5/0.5 = 3.0 > 2.0
    // momentum = |100050 - 100000| = 50 < 200 -> not enough for TREND jump
    // but vol expansion > volExpansionMult so -> CAUTION
    const mode = det.classify(createMarketState({
      realizedVol: 1.5,
      volBaseline: 0.5,
      lastPrice: 100050,
      vwap: 100000,
    }));
    assert.equal(mode, 'CAUTION');
  });
});

// ============================================================================
// CAUTION -> HARVEST (calming down)
// ============================================================================
describe('Regime transition - CAUTION to HARVEST', () => {
  it('returns to HARVEST when vol contracts, momentum drops, and VWAP distance < 1', () => {
    const config = createTestConfig({
      volExpansionMult: 1.5,
      volContractionMult: 1.0,
      momentumMult: 1.0,
    });
    const det = createRegimeDetector('test', config);

    // First, move to CAUTION via vol expansion
    det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
    }));
    assert.equal(det.getMode(), 'CAUTION');

    // Now calm down: volExpansion = 0.4/0.5 = 0.8 < volContractionMult=1.0
    // momentum = |100010 - 100000| = 10 < momentumMult*50 = 50
    // vwapDistance = (100010 - 100000)/100 = 0.1, abs < 1.0
    const mode = det.classify(createMarketState({
      realizedVol: 0.4,
      volBaseline: 0.5,
      lastPrice: 100010,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(mode, 'HARVEST');
  });

  it('stays in CAUTION if VWAP distance is still high', () => {
    const config = createTestConfig({
      volContractionMult: 1.0,
      momentumMult: 1.0,
    });
    const det = createRegimeDetector('test', config);

    // Move to CAUTION
    det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
    }));
    assert.equal(det.getMode(), 'CAUTION');

    // Low vol but VWAP distance > 1.0: (100200 - 100000)/100 = 2.0
    const mode = det.classify(createMarketState({
      realizedVol: 0.4,
      volBaseline: 0.5,
      lastPrice: 100200,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(mode, 'CAUTION');
  });
});

// ============================================================================
// CAUTION -> TREND (confirmed trend)
// ============================================================================
describe('Regime transition - CAUTION to TREND (confirmed)', () => {
  it('transitions to TREND after sustained directional momentum', () => {
    const config = createTestConfig({ trendConfirmationPeriods: 3 });
    const det = createRegimeDetector('test', config);

    // Move to CAUTION first
    det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
    }));
    assert.equal(det.getMode(), 'CAUTION');

    // Now push sustained momentum with VWAP distance >= 2.0
    // vwapDistance = (100300 - 100000)/100 = 3.0 > 2.0
    // Each call adds to momentum history (direction: 'up')
    // Need trendConfirmationPeriods=3 consistent readings AND trendConfirmationCount >= 3
    // We need multiple readings in momentum history + trendConfirmationCount to build up
    const trendMarket = createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
      lastPrice: 100300,
      vwap: 100000,
      atr1m: 100,
    });

    // Each classify call accumulates momentum history.
    // trendConfirmationPeriods=3 means we need at least 3 consistent readings
    // AND trendConfirmationCount >= 3.
    // Since the first call already moved us to CAUTION, we call classify
    // enough times to fill momentum history and count.
    let mode;
    for (let i = 0; i < 6; i++) {
      mode = det.classify(trendMarket);
    }
    assert.equal(mode, 'TREND');
  });
});

// ============================================================================
// TREND -> CAUTION (trend weakening)
// ============================================================================
describe('Regime transition - TREND to CAUTION', () => {
  it('falls back to CAUTION when VWAP distance drops below threshold', () => {
    const config = createTestConfig({ trendConfirmationPeriods: 3 });
    const det = createRegimeDetector('test', config);

    // Force into TREND mode
    det.forceTransition('TREND', 'test setup');
    assert.equal(det.getMode(), 'TREND');

    // VWAP distance < 1.0 triggers TREND -> CAUTION
    const mode = det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
      lastPrice: 100050,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(mode, 'CAUTION');
  });
});

// ============================================================================
// forceTransition
// ============================================================================
describe('forceTransition', () => {
  it('changes mode immediately', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.forceTransition('TREND', 'flash crash');
    assert.equal(det.getMode(), 'TREND');
  });

  it('increments transition count', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.forceTransition('CAUTION', 'external signal');
    assert.equal(det.getState().transitionCount, 1);
  });

  it('does nothing when forcing to the same mode', () => {
    const det = createRegimeDetector('test', createTestConfig());
    assert.equal(det.getMode(), 'HARVEST');
    det.forceTransition('HARVEST', 'no-op');
    assert.equal(det.getState().transitionCount, 0);
  });

  it('invokes onTransition callback', () => {
    let called = false;
    let cbArgs = {};
    const det = createRegimeDetector('test', createTestConfig(), {
      onTransition: (prev, next, reason) => {
        called = true;
        cbArgs = { prev, next, reason };
      },
    });
    det.forceTransition('CAUTION', 'external');
    assert.ok(called);
    assert.equal(cbArgs.prev, 'HARVEST');
    assert.equal(cbArgs.next, 'CAUTION');
    assert.ok(cbArgs.reason.includes('forced:external'));
  });
});

// ============================================================================
// getRegimeScale
// ============================================================================
describe('getRegimeScale', () => {
  it('returns harvestScale for HARVEST', () => {
    const det = createRegimeDetector('test', createTestConfig({ harvestScale: 1.0 }));
    assert.equal(det.getRegimeScale(), 1.0);
  });

  it('returns cautionScale for CAUTION', () => {
    const det = createRegimeDetector('test', createTestConfig({ cautionScale: 0.5 }));
    det.forceTransition('CAUTION', 'test');
    assert.equal(det.getRegimeScale(), 0.5);
  });

  it('returns trendScale for TREND', () => {
    const det = createRegimeDetector('test', createTestConfig({ trendScale: 0.0 }));
    det.forceTransition('TREND', 'test');
    assert.equal(det.getRegimeScale(), 0.0);
  });
});

// ============================================================================
// allowsEntries
// ============================================================================
describe('allowsEntries', () => {
  it('allows entries in HARVEST', () => {
    const det = createRegimeDetector('test', createTestConfig());
    assert.equal(det.allowsEntries(), true);
  });

  it('allows entries in CAUTION', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.forceTransition('CAUTION', 'test');
    assert.equal(det.allowsEntries(), true);
  });

  it('blocks entries in TREND when trendScale is 0', () => {
    const det = createRegimeDetector('test', createTestConfig({ trendScale: 0.0 }));
    det.forceTransition('TREND', 'test');
    assert.equal(det.allowsEntries(), false);
  });

  it('allows entries in TREND when trendScale > 0', () => {
    const det = createRegimeDetector('test', createTestConfig({ trendScale: 0.1 }));
    det.forceTransition('TREND', 'test');
    assert.equal(det.allowsEntries(), true);
  });
});

// ============================================================================
// reset
// ============================================================================
describe('reset', () => {
  it('returns detector to initial HARVEST state', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.forceTransition('TREND', 'test');
    assert.equal(det.getMode(), 'TREND');
    assert.equal(det.getState().transitionCount, 1);

    det.reset();
    assert.equal(det.getMode(), 'HARVEST');
    assert.equal(det.getState().transitionCount, 0);
    assert.equal(det.getState().trendDirection, null);
  });
});

// ============================================================================
// restoreState
// ============================================================================
describe('restoreState', () => {
  it('restores mode and transition count from saved data', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.restoreState({
      mode: 'CAUTION',
      transitionCount: 5,
      trendDirection: 'up',
      lastVolExpansion: 1.8,
      lastMomentumMag: 120,
      trendConfirmationCount: 2,
    });
    assert.equal(det.getMode(), 'CAUTION');
    assert.equal(det.getState().transitionCount, 5);
    assert.equal(det.getState().trendDirection, 'up');
  });

  it('resets since timestamp to current session', () => {
    const det = createRegimeDetector('test', createTestConfig());
    const before = Date.now();
    det.restoreState({
      mode: 'TREND',
      since: 1000000,
    });
    const after = Date.now();
    assert.ok(det.getState().since >= before);
    assert.ok(det.getState().since <= after);
  });

  it('does nothing when called with null/undefined', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.restoreState(null);
    assert.equal(det.getMode(), 'HARVEST');
    det.restoreState(undefined);
    assert.equal(det.getMode(), 'HARVEST');
  });
});

// ============================================================================
// getSummary
// ============================================================================
describe('getSummary', () => {
  it('includes mode and transition count', () => {
    const det = createRegimeDetector('test', createTestConfig());
    const summary = det.getSummary();
    assert.ok(summary.includes('mode=HARVEST'));
    assert.ok(summary.includes('transitions=0'));
  });

  it('includes trend direction when in TREND mode', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.restoreState({
      mode: 'TREND',
      trendDirection: 'up',
      lastVolExpansion: 2.0,
      lastMomentumMag: 300,
      transitionCount: 1,
    });
    const summary = det.getSummary();
    assert.ok(summary.includes('mode=TREND'));
    assert.ok(summary.includes('direction=up'));
  });

  it('does not include direction when in HARVEST', () => {
    const det = createRegimeDetector('test', createTestConfig());
    const summary = det.getSummary();
    assert.ok(!summary.includes('direction='));
  });
});

// ============================================================================
// Edge cases and extreme values
// ============================================================================
describe('Edge cases', () => {
  it('handles very large price divergence without error', () => {
    const det = createRegimeDetector('test', createTestConfig());
    const mode = det.classify(createMarketState({
      realizedVol: 5.0,
      volBaseline: 0.1,
      lastPrice: 200000,
      vwap: 100000,
      atr1m: 100,
    }));
    // Should be TREND (massive spike) - volExpansion=50, momentum=100000 >> 200
    assert.equal(mode, 'TREND');
  });

  it('handles zero ATR gracefully (vwapDistance returns 0)', () => {
    const det = createRegimeDetector('test', createTestConfig());
    // With atr1m=0, calculateVWAPDistance returns 0, so VWAP distance won't trigger
    const mode = det.classify(createMarketState({
      realizedVol: 0.5,
      volBaseline: 0.5,
      lastPrice: 100500,
      vwap: 100000,
      atr1m: 0,
    }));
    // momentum = |100500 - 100000| = 500 > 100 -> CAUTION
    assert.equal(mode, 'CAUTION');
  });

  it('handles negative trade imbalance amplifying downward momentum', () => {
    const config = createTestConfig({ momentumMult: 1.0 });
    const det = createRegimeDetector('test', config);
    // lastPrice < vwap -> direction down, tradeImbalance < 0 -> amplified
    // base magnitude = |99800 - 100000| = 200
    // imbalanceFactor = 1 + 0.5*0.8 = 1.4
    // adjustedMagnitude = 200 * 1.4 = 280 > 100 -> CAUTION
    const mode = det.classify(createMarketState({
      realizedVol: 0.5,
      volBaseline: 0.5,
      lastPrice: 99800,
      vwap: 100000,
      tradeImbalance: -0.8,
      atr1m: 100,
    }));
    assert.equal(mode, 'CAUTION');
  });

  it('trade imbalance does NOT amplify when direction and imbalance disagree', () => {
    const config = createTestConfig({ momentumMult: 1.0 });
    const det = createRegimeDetector('test', config);
    // lastPrice > vwap -> direction up, tradeImbalance < 0 -> no amplification
    // base magnitude = |100050 - 100000| = 50 < 100 -> stays HARVEST
    const mode = det.classify(createMarketState({
      realizedVol: 0.5,
      volBaseline: 0.5,
      lastPrice: 100050,
      vwap: 100000,
      tradeImbalance: -0.8,
      atr1m: 100,
    }));
    assert.equal(mode, 'HARVEST');
  });
});

// ============================================================================
// Hysteresis: regime stickiness and rapid oscillation prevention
// ============================================================================
describe('Hysteresis behavior', () => {
  it('CAUTION requires vol to contract BELOW volContractionMult to return to HARVEST', () => {
    const config = createTestConfig({
      volExpansionMult: 1.5,
      volContractionMult: 1.0,
    });
    const det = createRegimeDetector('test', config);

    // Move to CAUTION: volExpansion = 1.0/0.5 = 2.0 > 1.5
    det.classify(createMarketState({ realizedVol: 1.0, volBaseline: 0.5 }));
    assert.equal(det.getMode(), 'CAUTION');

    // Vol between contraction and expansion thresholds: 0.55/0.5 = 1.1
    // 1.1 > volContractionMult=1.0 so doesn't meet criteria for return to HARVEST
    // Also need momentum < 50 and vwapDistance < 1.0 to go to HARVEST
    // Even with low momentum and vwap distance, vol must be below 1.0
    const mode = det.classify(createMarketState({
      realizedVol: 0.55,
      volBaseline: 0.5,
      lastPrice: 100000,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(mode, 'CAUTION');
  });

  it('CAUTION -> HARVEST requires ALL three conditions met simultaneously', () => {
    const config = createTestConfig({
      volContractionMult: 1.0,
      momentumMult: 1.0,
    });
    const det = createRegimeDetector('test', config);

    // Move to CAUTION
    det.classify(createMarketState({ realizedVol: 1.0, volBaseline: 0.5 }));
    assert.equal(det.getMode(), 'CAUTION');

    // Vol is contracted but momentum is too high: |100060 - 100000| = 60 > 50
    const mode = det.classify(createMarketState({
      realizedVol: 0.4,
      volBaseline: 0.5,
      lastPrice: 100060,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(mode, 'CAUTION');
  });

  it('multiple transitions are properly counted', () => {
    const det = createRegimeDetector('test', createTestConfig());
    det.forceTransition('CAUTION', 'step1');
    det.forceTransition('TREND', 'step2');
    det.forceTransition('CAUTION', 'step3');
    det.forceTransition('HARVEST', 'step4');
    assert.equal(det.getState().transitionCount, 4);
  });

  it('TREND -> CAUTION resets trendConfirmationCount', () => {
    const det = createRegimeDetector('test', createTestConfig({ trendConfirmationPeriods: 3 }));

    // Force into TREND
    det.forceTransition('TREND', 'test');
    assert.equal(det.getMode(), 'TREND');

    // VWAP distance < 1.0 -> TREND weakens -> CAUTION
    det.classify(createMarketState({
      realizedVol: 0.5,
      volBaseline: 0.5,
      lastPrice: 100050,
      vwap: 100000,
      atr1m: 100,
    }));
    assert.equal(det.getMode(), 'CAUTION');
    assert.equal(det.getState().trendConfirmationCount, 0);
  });
});

// ============================================================================
// Callback behavior
// ============================================================================
describe('onTransition callback', () => {
  it('is called on classify-driven transitions', () => {
    const transitions = [];
    const det = createRegimeDetector('test', createTestConfig(), {
      onTransition: (prev, next, reason) => {
        transitions.push({ prev, next, reason });
      },
    });

    det.classify(createMarketState({
      realizedVol: 1.0,
      volBaseline: 0.5,
    }));

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].prev, 'HARVEST');
    assert.equal(transitions[0].next, 'CAUTION');
    assert.ok(transitions[0].reason.includes('vol_exp='));
  });

  it('is NOT called when regime stays the same', () => {
    let callCount = 0;
    const det = createRegimeDetector('test', createTestConfig(), {
      onTransition: () => { callCount++; },
    });

    det.classify(createMarketState());
    det.classify(createMarketState());
    det.classify(createMarketState());

    assert.equal(callCount, 0);
  });
});
