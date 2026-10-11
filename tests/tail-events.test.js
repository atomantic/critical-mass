// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createTailEventsMonitor } = require('../src/tail-events');

const cfg = (over = {}) => ({
  maxSpreadBps: 100,
  spreadPauseMs: 60000,
  minDepthUsdc: 0,
  depthPauseMs: 60000,
  flashMoveMult: 3,
  flashCooldownMs: 60000,
  ...over,
});

// ---------------------------------------------------------------------------
// Flash-move anchor reset on WS disconnect (issue #211-D)
// ---------------------------------------------------------------------------
describe('checkFlashMove anchor reset on disconnect (issue #211-D)', () => {
  it('would flag a flash move on a large jump against a stale anchor', () => {
    const mon = createTailEventsMonitor('test', cfg());
    // Seed the anchor at a pre-gap price.
    assert.equal(mon.checkFlashMove(50000, 60).isFlash, false, 'first tick just seeds the anchor');
    // A $600 jump vs ATR=60, mult=3 → 10x → flash.
    assert.equal(mon.checkFlashMove(50600, 60).isFlash, true, 'large jump against a live anchor is a flash');
    mon.cleanup(); // clear the flash-cooldown timer so the test process can exit
  });

  it('does NOT fire a flash move on the first tick after resetLastPrice (feed gap)', () => {
    const mon = createTailEventsMonitor('test', cfg());
    mon.checkFlashMove(50000, 60); // seed anchor pre-disconnect
    // WS drops; engine clears the anchor.
    mon.resetLastPrice();
    // First post-reconnect tick drifted $600 during the gap (ordinary market move).
    const result = mon.checkFlashMove(50600, 60);
    assert.equal(result.isFlash, false, 'first post-gap tick must only re-seed, not fire a flash');
    assert.equal(mon.isScalingDisabled().disabled, false, 'no scaling lockout from a gap-induced move');
  });

  it('resumes normal flash detection after the first post-gap tick re-seeds the anchor', () => {
    const mon = createTailEventsMonitor('test', cfg());
    mon.checkFlashMove(50000, 60);
    mon.resetLastPrice();
    mon.checkFlashMove(50600, 60); // re-seed at 50600, no flash
    // A genuine flash relative to the NEW anchor still fires.
    assert.equal(mon.checkFlashMove(51300, 60).isFlash, true, 'real flash vs the re-seeded anchor still fires');
    mon.cleanup(); // clear the flash-cooldown timer so the test process can exit
  });
});

// ---------------------------------------------------------------------------
// Flash-move callbacks (issue #1028): the engine hangs its reactive-entry
// cancel on onFlashMove, so it must fire once per detected flash, before the
// forced CAUTION transition, and never on a sub-threshold tick.
// ---------------------------------------------------------------------------
describe('flash-move callbacks (issue #1028)', () => {
  it('fires onFlashMove then onRegimeTransition once per flash, never for a quiet tick', () => {
    const calls = [];
    const mon = createTailEventsMonitor('test', cfg({ flashMoveMult: 2 }), {
      onFlashMove: (delta, multiple) => calls.push(['flash', delta, multiple]),
      onRegimeTransition: (mode, reason) => calls.push(['transition', mode, reason]),
    });
    mon.processTicker({ price: 100, bid: 99.99, ask: 100.01 }, 1); // seeds the anchor
    mon.processTicker({ price: 101, bid: 100.99, ask: 101.01 }, 1); // 1x ATR — quiet
    assert.deepEqual(calls, []);

    const result = mon.processTicker({ price: 90, bid: 89.99, ask: 90.01 }, 1); // 11x ATR
    assert.equal(result.isFlashMove, true);
    assert.deepEqual(calls, [['flash', 11, 11], ['transition', 'CAUTION', 'flash_move']]);
    mon.cleanup();
  });
});
