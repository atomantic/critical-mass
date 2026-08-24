// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createStabilityState,
  stabilizeSignal,
  preventTickCreatedSignal,
  clampScoreToExistingType,
  alignJournalType,
  MIN_ENTER_MS,
  MIN_EXIT_MS,
  EXIT_BUY_SCORE,
  EXIT_SELL_SCORE,
} = require('../src/updown/signal-stability');
const { computeTrendFilter, scoreToSignalDynamic } = require('../src/updown/signal-engine');

const T0 = 1_000_000;

const step = (rawType, score, state, now, extra = {}) =>
  stabilizeSignal({ rawType, score, now, heldPosition: extra.heldPosition ?? null }, state);

describe('stabilizeSignal — 5s BUY chatter does not publish', () => {
  it('stays HOLD while score kisses 15 every 5 seconds', () => {
    let state = createStabilityState();
    // Today's live pattern: 14.6 HOLD / 15.3 BUY / 14.6 HOLD / 15.1 BUY …
    const ticks = [
      ['NEUTRAL', 14.6],
      ['BUY', 15.3],
      ['NEUTRAL', 14.6],
      ['BUY', 15.1],
      ['NEUTRAL', 14.9],
      ['BUY', 15.8],
      ['NEUTRAL', 14.7],
    ];
    ticks.forEach(([raw, score], i) => {
      const out = step(raw, score, state, T0 + i * 5_000);
      state = out.state;
      assert.equal(out.type, 'NEUTRAL', `tick ${i} (${raw} ${score}) must stay HOLD`);
    });
  });

  it('publishes BUY only after raw BUY persists for MIN_ENTER_MS', () => {
    let state = createStabilityState();
    const first = step('BUY', 16.5, state, T0);
    state = first.state;
    assert.equal(first.type, 'NEUTRAL', 'first 5s BUY is pending, not published');

    const tooSoon = step('BUY', 16.8, state, T0 + MIN_ENTER_MS - 1);
    state = tooSoon.state;
    assert.equal(tooSoon.type, 'NEUTRAL');

    const confirmed = step('BUY', 17.2, state, T0 + MIN_ENTER_MS);
    assert.equal(confirmed.type, 'BUY');
  });

  it('resets the pending BUY timer if a NEUTRAL tick interrupts', () => {
    let state = createStabilityState();
    state = step('BUY', 16.5, state, T0).state;
    state = step('NEUTRAL', 14.9, state, T0 + 10_000).state;
    const again = step('BUY', 16.4, state, T0 + 15_000);
    assert.equal(again.type, 'NEUTRAL', 'timer must restart after the interrupt');
    const stillPending = step('BUY', 16.6, again.state, T0 + 15_000 + MIN_ENTER_MS - 1);
    assert.equal(stillPending.type, 'NEUTRAL');
    const confirmed = step('BUY', 16.7, stillPending.state, T0 + 15_000 + MIN_ENTER_MS);
    assert.equal(confirmed.type, 'BUY');
  });
});

describe('stabilizeSignal — hysteresis keeps a real BUY clip', () => {
  it('stays BUY through 14.x fade until score drops below EXIT_BUY_SCORE or NEUTRAL persists', () => {
    let state = createStabilityState();
    // Confirm the clip
    state = step('BUY', 16.5, state, T0).state;
    const live = step('BUY', 18.0, state, T0 + MIN_ENTER_MS);
    state = live.state;
    assert.equal(live.type, 'BUY');

    // 5s kisses back through 15 — must NOT drop to HOLD
    for (let i = 1; i <= 4; i++) {
      const raw = i % 2 === 0 ? 'NEUTRAL' : 'BUY';
      const score = raw === 'BUY' ? 15.2 : 14.7;
      const out = step(raw, score, state, T0 + MIN_ENTER_MS + i * 5_000);
      state = out.state;
      assert.equal(out.type, 'BUY', `fade tick ${i} must keep BUY`);
    }
  });

  it('drops to HOLD immediately when score collapses below EXIT_BUY_SCORE', () => {
    let state = createStabilityState();
    state = step('BUY', 18, state, T0).state;
    state = step('BUY', 20, state, T0 + MIN_ENTER_MS).state;
    const dumped = step('NEUTRAL', EXIT_BUY_SCORE - 0.5, state, T0 + MIN_ENTER_MS + 5_000);
    assert.equal(dumped.type, 'NEUTRAL');
  });

  it('drops to HOLD after NEUTRAL persists for MIN_ENTER_MS even if score is still 13–14', () => {
    let state = createStabilityState();
    state = step('BUY', 18, state, T0).state;
    state = step('BUY', 19, state, T0 + MIN_ENTER_MS).state;
    const t = T0 + MIN_ENTER_MS + 5_000;
    state = step('NEUTRAL', 13.5, state, t).state;
    const still = step('NEUTRAL', 13.2, state, t + MIN_ENTER_MS - 1);
    assert.equal(still.type, 'BUY');
    const gone = step('NEUTRAL', 13.1, still.state, t + MIN_ENTER_MS);
    assert.equal(gone.type, 'NEUTRAL');
  });
});

describe('stabilizeSignal — SELL/EXIT persistence (not 5s flicker)', () => {
  it('does not publish a 5s SELL at -20', () => {
    let state = createStabilityState();
    const flash = step('SELL', -20, state, T0);
    assert.equal(flash.type, 'NEUTRAL');
    const back = step('NEUTRAL', -10, flash.state, T0 + 5_000);
    assert.equal(back.type, 'NEUTRAL');
  });

  it('publishes SELL after raw SELL persists for MIN_EXIT_MS (faster than BUY confirm)', () => {
    let state = createStabilityState();
    state = step('SELL', -18, state, T0).state;
    const tooSoon = step('SELL', -19, state, T0 + MIN_EXIT_MS - 1);
    assert.equal(tooSoon.type, 'NEUTRAL');
    const confirmed = step('SELL', -19, tooSoon.state, T0 + MIN_EXIT_MS);
    assert.equal(confirmed.type, 'SELL');
  });

  it('publishes STRONG_BUY and STRONG_SELL immediately', () => {
    const buy = step('STRONG_BUY', 32, createStabilityState(), T0);
    assert.equal(buy.type, 'STRONG_BUY');
    const sell = step('STRONG_SELL', -35, createStabilityState(), T0);
    assert.equal(sell.type, 'STRONG_SELL');
  });

  it('from a held BUY, a persisted SELL becomes EXIT-eligible SELL', () => {
    let state = createStabilityState();
    state = step('BUY', 18, state, T0).state;
    state = step('BUY', 18, state, T0 + MIN_ENTER_MS).state;
    const t = T0 + MIN_ENTER_MS + 5_000;
    state = step('SELL', -16.5, state, t).state;
    const out = step('SELL', -17, state, t + MIN_EXIT_MS);
    assert.equal(out.type, 'SELL');
  });
});

describe('stabilizeSignal — NO_TRADE_ZONE passes through', () => {
  it('publishes NO_TRADE_ZONE immediately', () => {
    const out = step('NO_TRADE_ZONE', 20, createStabilityState(), T0);
    assert.equal(out.type, 'NO_TRADE_ZONE');
  });
});

describe('preventTickCreatedSignal', () => {
  it('does not let tick-momentum promote NEUTRAL to BUY or SELL', () => {
    assert.equal(preventTickCreatedSignal('NEUTRAL', 'BUY'), 'NEUTRAL');
    assert.equal(preventTickCreatedSignal('NEUTRAL', 'STRONG_BUY'), 'NEUTRAL');
    assert.equal(preventTickCreatedSignal('NEUTRAL', 'SELL'), 'NEUTRAL');
    assert.equal(preventTickCreatedSignal('NEUTRAL', 'STRONG_SELL'), 'NEUTRAL');
  });

  it('allows tick-momentum to amplify an already-directional type', () => {
    assert.equal(preventTickCreatedSignal('BUY', 'STRONG_BUY'), 'STRONG_BUY');
    assert.equal(preventTickCreatedSignal('SELL', 'STRONG_SELL'), 'STRONG_SELL');
    assert.equal(preventTickCreatedSignal('BUY', 'BUY'), 'BUY');
  });

  it('does not let tick-momentum cancel a published BUY into HOLD', () => {
    // Type changes from stability, not from a 1s tick boost/damp.
    assert.equal(preventTickCreatedSignal('BUY', 'NEUTRAL'), 'BUY');
    assert.equal(preventTickCreatedSignal('SELL', 'NEUTRAL'), 'SELL');
  });

  it('still allows an EXIT: BUY → SELL is a real engine decision, not tick-created', () => {
    // This helper only blocks NEUTRAL↔directional created by ticks.
    // Engine hysteresis handles BUY→SELL.
    assert.equal(preventTickCreatedSignal('BUY', 'SELL'), 'SELL');
  });
});

describe('clampScoreToExistingType', () => {
  it('caps a boosted NEUTRAL score so it cannot cross the BUY threshold', () => {
    const atrRatio = 1;
    const raw = 14.5;
    const boosted = 16.2;
    const clamped = clampScoreToExistingType('NEUTRAL', raw, boosted, atrRatio);
    const stillNeutral = scoreToSignalDynamic(clamped, atrRatio);
    assert.equal(stillNeutral, 'NEUTRAL');
    assert.ok(clamped <= 15, `clamped ${clamped} must stay at or under the BUY line`);
  });

  it('does not cap a score that was already BUY', () => {
    assert.equal(clampScoreToExistingType('BUY', 16, 20, 1), 20);
  });
});

describe('alignJournalType — scorecard must not print a BUY the banner never showed', () => {
  it('overrides a sampler-confirmed BUY with live HOLD', () => {
    const sampled = { type: 'BUY', score: 15.08 };
    const out = alignJournalType(sampled, 'NEUTRAL');
    assert.equal(out.type, 'NEUTRAL');
    assert.equal(out.score, 15.08, 'score snapshot stays; only the published type is aligned');
  });

  it('keeps a live BUY so the journal scores the clip the operator saw', () => {
    const sampled = { type: 'NEUTRAL', score: 14.2 };
    assert.equal(alignJournalType(sampled, 'BUY').type, 'BUY');
  });

  it('leaves the sampler type alone before the live cycle has published', () => {
    const sampled = { type: 'BUY', score: 18 };
    assert.equal(alignJournalType(sampled, null).type, 'BUY');
    assert.equal(alignJournalType(sampled, undefined).type, 'BUY');
  });
});

describe('createSignalEngine stability snapshot survives a restart', () => {
  it('restores a published BUY so a score-14 tick does not drop to HOLD', () => {
    const { createSignalEngine } = require('../src/updown/signal-engine');
    const engine = createSignalEngine({ getCandles: () => [] });
    engine.setStabilityState({
      publishedType: 'BUY',
      publishedAt: 1,
      pendingType: null,
      pendingSince: 0,
    });
    const snap = engine.getStabilityState();
    assert.equal(snap.publishedType, 'BUY');
    // Direct stabilize: restored BUY + raw NEUTRAL at 14 stays BUY (above 12, pending HOLD).
    const out = stabilizeSignal(
      { rawType: 'NEUTRAL', score: 14, now: 1 + 5_000 },
      engine.getStabilityState(),
    );
    assert.equal(out.type, 'BUY');
  });
});

describe('computeTrendFilter with 199 1h candles (in-progress hour missing)', () => {
  const makeHourly = (n, start, step) => {
    const out = [];
    let p = start;
    for (let i = 0; i < n; i++) {
      p += step;
      out.push({ open: p, high: p + 1, low: p - 1, close: p, volume: 10, timestamp: i * 3_600_000 });
    }
    return out;
  };

  it('does not return FLAT/ema=0 on 199 steadily-rising 1h candles', () => {
    const candles = makeHourly(199, 50_000, 80);
    const trend = computeTrendFilter(candles);
    assert.notEqual(trend.ema50, 0);
    assert.notEqual(trend.ema200, 0);
    assert.equal(trend.trendBias, 'bullish');
  });

  it('still returns FLAT when there is nowhere near enough history', () => {
    const trend = computeTrendFilter(makeHourly(50, 50_000, 80));
    assert.equal(trend.trendBias, 'neutral');
    assert.equal(trend.ema50, 0);
    assert.equal(trend.ema200, 0);
  });
});
