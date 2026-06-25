// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Reload the module fresh per test so its module-level `pendingStates` /
// `lastSaveTime` start clean and don't bleed across cases.
const freshModule = () => {
  const modPath = require.resolve('../src/dry-run-state');
  delete require.cache[modPath];
  return { mod: require('../src/dry-run-state'), modPath };
};

const mkState = (tag) => ({
  isDryRun: true,
  executor: {},
  position: {},
  savedAt: 0,
  tag,
});

describe('dry-run-state saveState — immediate branch preserves queued funds (#159)', () => {
  it('does not drop a debounce-queued fund when another fund saves immediately', (t) => {
    // Mock Date + setTimeout so we can drive the debounce window deterministically.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
    const { mod, modPath } = freshModule();
    const { saveState, STATE_FILE } = mod;
    t.after(() => {
      fs.rmSync(STATE_FILE, { force: true });
      delete require.cache[modPath];
    });

    // 1) Immediate save of fund A (lastSaveTime was 0, now 10s past it).
    saveState('coinbase', mkState('A'), 'BTC-USD');

    // 2) Within the debounce window, queue a newer snapshot of fund A. This
    //    schedules a debounce timer and leaves fund A sitting in pendingStates.
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('A2'), 'BTC-USD');

    // 3) Once the debounce window has elapsed (relative to lastSaveTime=10_000),
    //    fund B takes the immediate branch while fund A is still queued.
    t.mock.timers.setTime(15_000);
    saveState('kraken', mkState('B'), 'ETH-USD');

    const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.ok(onDisk.exchanges['kraken::ETH-USD'], 'fund B should be persisted');
    // The regression: fund A's queued snapshot must NOT be discarded.
    assert.ok(onDisk.exchanges['coinbase::BTC-USD'], 'fund A queued snapshot should survive');
    assert.equal(onDisk.exchanges['coinbase::BTC-USD'].tag, 'A2', 'latest queued snapshot wins');
  });

  it('cancels the pending debounce timer so it cannot later flush an empty map', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
    const { mod, modPath } = freshModule();
    const { saveState, STATE_FILE } = mod;
    t.after(() => {
      fs.rmSync(STATE_FILE, { force: true });
      delete require.cache[modPath];
    });

    saveState('coinbase', mkState('A'), 'BTC-USD');     // immediate, lastSaveTime=10_000
    t.mock.timers.setTime(11_000);
    saveState('coinbase', mkState('A2'), 'BTC-USD');    // debounced -> timer at 16_000
    t.mock.timers.setTime(15_000);
    saveState('kraken', mkState('B'), 'ETH-USD');       // immediate -> should cancel timer

    const afterImmediate = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    // Fire any timers past the original debounce deadline; nothing should change
    // because the immediate branch already flushed and cancelled the timer.
    t.mock.timers.tick(5_000);
    const afterTick = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    assert.deepEqual(afterTick.exchanges, afterImmediate.exchanges, 'no stray debounced flush');
  });
});
