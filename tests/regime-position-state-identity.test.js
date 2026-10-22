// Issue #1594: positionState keeps one object identity for the engine's
// lifetime (replacePositionState clears + assigns instead of rebinding), so
// extracted sub-modules can capture it once.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test1594__';
const JUNK_DIR = path.join(require('../src/paths').DATA_DIR, 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

const makeEngine = () => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  return eng;
};

describe('positionState identity (issue #1594)', () => {
  it('a captured reference observes updatePosition results', () => {
    const eng = makeEngine();
    const captured = eng._getPositionState();
    const cyclesBefore = captured.cyclesCompleted;

    eng.updatePosition({ cyclesCompleted: cyclesBefore + 7, realizedAssetPnL: 1.5 });

    assert.equal(eng._getPositionState(), captured);
    assert.equal(captured.cyclesCompleted, cyclesBefore + 7);
    assert.equal(captured.realizedAssetPnL, 1.5);
  });

  it('a captured reference observes resetDryRun and drops stale keys', () => {
    const eng = makeEngine();
    const captured = eng._getPositionState();
    captured.cyclesCompleted = 9;
    captured.someStaleExtraField = 'x';

    assert.equal(eng.resetDryRun(), true);

    assert.equal(eng._getPositionState(), captured);
    assert.equal(captured.cyclesCompleted, 0);
    assert.equal('someStaleExtraField' in captured, false);
  });
});
