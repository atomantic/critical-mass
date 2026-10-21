const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIFECYCLE, closeDrainedEmptyPosition } = require('../src/state-tracker');

describe('closeDrainedEmptyPosition (issue #1131)', () => {
  it('closes a draining position with no asset and no bodies', () => {
    const position = { lifecycle: LIFECYCLE.DRAINING, totalAsset: 0, celestialBodies: [], cyclesCompleted: 7 };
    assert.equal(closeDrainedEmptyPosition(position, 1234), true);
    assert.equal(position.lifecycle, LIFECYCLE.CLOSED);
    assert.equal(position.lifecycleChangedAt, 1234);
    assert.equal(position.lifecycleClosedCycle, 7);
  });

  it('leaves a draining position with bodies or asset untouched', () => {
    for (const extra of [{ celestialBodies: [{}] }, { totalAsset: 0.5 }]) {
      const position = { lifecycle: LIFECYCLE.DRAINING, ...extra };
      assert.equal(closeDrainedEmptyPosition(position), false);
      assert.equal(position.lifecycle, LIFECYCLE.DRAINING);
      assert.equal(position.lifecycleChangedAt, undefined);
    }
  });

  it('ignores non-draining and missing positions', () => {
    assert.equal(closeDrainedEmptyPosition(null), false);
    const active = { lifecycle: LIFECYCLE.ACTIVE, totalAsset: 0 };
    assert.equal(closeDrainedEmptyPosition(active), false);
    assert.equal(active.lifecycle, LIFECYCLE.ACTIVE);
  });
});

describe('regime:status stopped-path auto-close wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ipc/regime-ipc-handlers.js'), 'utf8');
  const handler = src.slice(src.indexOf('onRequest(IPC_CHANNELS.REGIME_STATUS'), src.indexOf('onRequest(IPC_CHANNELS.REGIME_PAUSE'));

  it('delegates to the named helper and does not assign lifecycle inline', () => {
    assert.match(handler, /autoCloseDrainedFundWhileStopped\(exchange, resolvedPair, savedState\)/);
    assert.doesNotMatch(handler, /position\.lifecycle\s*=/);
  });

  it('helper closes via the shared predicate, saves state and clears the running flag', () => {
    const helper = src.slice(src.indexOf('const autoCloseDrainedFundWhileStopped'), src.indexOf('onRequest(IPC_CHANNELS.REGIME_STATUS'));
    assert.match(helper, /closeDrainedEmptyPosition\(position\)/);
    assert.ok(helper.indexOf('saveRegimeState') < helper.indexOf('saveRegimeRunningFlag(exchange, pair, false)'));
  });
});
