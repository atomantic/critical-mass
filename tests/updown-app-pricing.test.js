const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buyValue, sellValue, entryCost, exitProceeds, effectiveHalfSpread } = require('../src/updown/app-pricing');
const { UP_DIP_PARAMS, decideUpDip, markPosition, pickContract } = require('../src/updown/up-dip-setup');

const C1 = { floor: 60200, ceiling: 62200, maxPayout: 1000 };
const C2 = { floor: 59400, ceiling: 61400, maxPayout: 1000 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !== ${b}`);

describe('app pricing', () => {
  it('matches both screenshots', () => {
    near(buyValue(61118.69, C1, 53.31), 486);
    near(buyValue(61138.68, C2, 53.32), 896);
    near(sellValue(61118.69, C1, 44.69), 437);
  });

  it('clamps at the bounds', () => {
    assert.equal(sellValue(60230, C1, 35), 0);
    assert.equal(buyValue(62180, C1, 35), 1000);
  });

  it('adds the fee each way and scales with quantity', () => {
    near(entryCost(61118.69, C1, 53.31), 487.99);
    near(entryCost(61118.69, C1, 53.31, 2), 975.98);
    near(exitProceeds(61118.69, C1, 44.69, 2), 870.02);
  });

  it('refuses a missing or invalid spread', () => {
    for (const h of [-1, NaN, undefined, null, '35']) {
      assert.throws(() => buyValue(61000, C1, h), TypeError);
      assert.throws(() => sellValue(61000, C1, h), TypeError);
      assert.throws(() => effectiveHalfSpread({}, h), TypeError);
    }
  });

  it('uses the larger of the entry spread and the current one', () => {
    assert.equal(effectiveHalfSpread({ halfSpread: 49 }, 35), 49);
    assert.equal(effectiveHalfSpread({ halfSpread: 35 }, 49), 49);
    assert.equal(effectiveHalfSpread({}, 35), 35);
  });
});

describe('the rule with a spread', () => {
  const NOW = Date.parse('2026-11-15T18:00:00Z');
  const features = (over = {}) => ({ timestamp: NOW - 60_000, price: 64700, green1m: true, rsi1m: 45, dropPct: 0.8, vs1m: 0.05, vs5m: -0.2, vs15m: -0.3, vs1h: -0.5, vs1d: -3, ...over });
  const contract = pickContract(64700, NOW);
  const position = { contract, contracts: 1, cost: entryCost(64700, contract, 0), lastFillPrice: 64700, openedAt: NOW };
  const decide = (over) => decideUpDip({ features: features(), position: null, now: NOW, halfSpread: 0, ...over });

  it('waits for the target after the closing spread', () => {
    // +4% of 751.99 needs 64,768.1 with no spread and 64,803.1 at $35 a side.
    const at = (price) => features({ price });
    assert.equal(decide({ features: at(64780), position }).action, 'EXIT');
    assert.equal(decide({ features: at(64780), position, halfSpread: 35 }).action, 'HOLD');
    assert.equal(decide({ features: at(64804), position, halfSpread: 35 }).action, 'EXIT');
  });

  it('moves the target price out by exactly the spread', () => {
    const h0 = decide({ features: features({ price: 64710 }), position });
    const h35 = decide({ features: features({ price: 64710 }), position, halfSpread: 35 });
    assert.equal(h35.expected.targetBtc - h0.expected.targetBtc, 35);
  });

  it('targets the ceiling payout, with no spread, when the target is past the ceiling', () => {
    const tight = { contract: { ...C2, expiry: NOW + 5 * 86_400_000 }, contracts: 1, cost: 897.99, lastFillPrice: 61138, openedAt: NOW };
    const d = decide({ features: features({ price: 61100 }), position: tight, halfSpread: 49, params: { ...UP_DIP_PARAMS, minGainPct: 20 } });
    assert.equal(d.expected.targetBtc, 61400);
    assert.equal(d.expected.targetPnlUsd, 100.02);
  });

  it('marks at the entry spread when that is larger', () => {
    const entered = { ...position, halfSpread: 49 };
    near(markPosition(entered, 64800, 35).pnl, markPosition(entered, 64800, 49).pnl);
    near(markPosition(position, 64800, 35).pnl, markPosition(position, 64800, 0).pnl - 17.5);
  });

  it('charges the spread on entry', () => {
    near(decide({ halfSpread: 35 }).expected.costUsd, Math.round((decide().expected.costUsd + 17.5) * 100) / 100);
  });

  it('charges the spread on an ADD', () => {
    const params = { ...UP_DIP_PARAMS, maxContracts: 5 };
    const f = features({ price: 64400, vs1m: -0.3 });
    near(decide({ features: f, position, params, halfSpread: 35 }).expected.costUsd, Math.round((decide({ features: f, position, params }).expected.costUsd + 17.5) * 100) / 100);
  });

  it('stands aside when no listed contract is known', () => {
    const d = decide({ pick: () => null });
    assert.equal(d.action, 'STAND_ASIDE');
    assert.deepEqual(d.reasons, ['no listed contract seen this week']);
  });

  it('still reports the other reasons first when no contract is known', () => {
    assert.match(decide({ pick: () => null, features: features({ dropPct: 0.1 }) }).reasons[0], /no dip setup/);
    assert.match(decide({ pick: () => null, now: Date.parse('2026-11-20T18:00:00Z') }).reasons[0], /too late in the week/);
  });

  it('uses the picked contract', () => {
    const listed = { ...contract, floor: 63000, ceiling: 65000 };
    assert.equal(decide({ pick: () => listed }).contract, listed);
  });

  it('refuses to decide without a spread', () => {
    assert.throws(() => decideUpDip({ features: features(), position: null, now: NOW }), TypeError);
    assert.throws(() => decideUpDip({ features: null, position: null, now: NOW }), TypeError);
  });
});
