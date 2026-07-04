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
