// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TIERS,
  TIER_COLORS,
  getTierConfig,
  classifyTier,
  generateBodyId,
  createNewBody,
  findMergeTarget,
  mergeIntoBody,
  mergeBodies,
  calculateBodyTpPercent,
  checkPromotions,
  syncPositionState,
  migrateFromLegacy,
  createInitialCelestialState,
  getTierSummary,
  buildBodyTpOrder,
  buildCoreTpOrder,
  buildPersistedPendingOrders,
  buildCelestialPayload,
} = require('../src/celestial-hierarchy');

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal CelestialBody for testing */
const makeBody = (overrides = {}) => ({
  id: 'body-test-001',
  tier: 'satellite',
  assetQty: 0.001,
  costBasis: 100,
  avgPrice: 100000,
  tpOrderId: null,
  tpPrice: 0,
  assetOnOrder: 0,
  createdAt: Date.now(),
  lastMergedAt: Date.now(),
  sourceOrderIds: ['order-1'],
  buyOrders: [],
  mergeCount: 0,
  ...overrides,
});

const makeNewBuy = (overrides = {}) => ({
  totalSize: 0.001,
  totalValue: 100,
  totalFees: 0.10,
  avgPrice: 100000,
  ...overrides,
});

// ============================================================================
// TIERS constant
// ============================================================================
describe('TIERS constant', () => {
  it('has exactly 9 tiers', () => {
    assert.equal(TIERS.length, 9);
  });

  it('tiers are ordered from satellite to black_hole', () => {
    const names = TIERS.map(t => t.name);
    assert.deepStrictEqual(names, [
      'satellite', 'asteroid', 'moon', 'planet', 'sun', 'hypergiant', 'nebula', 'galaxy', 'black_hole',
    ]);
  });

  it('each tier has contiguous minPct/maxPct boundaries', () => {
    for (let i = 1; i < TIERS.length; i++) {
      assert.equal(TIERS[i].minPct, TIERS[i - 1].maxPct,
        `Tier ${TIERS[i].name} minPct should equal ${TIERS[i - 1].name} maxPct`);
    }
  });

  it('satellite starts at 0% and black_hole has Infinity maxPct', () => {
    assert.equal(TIERS[0].minPct, 0);
    assert.equal(TIERS[TIERS.length - 1].maxPct, Infinity);
  });

  it('tpMult increases monotonically across tiers', () => {
    for (let i = 1; i < TIERS.length; i++) {
      assert.ok(TIERS[i].tpMult > TIERS[i - 1].tpMult,
        `${TIERS[i].name} tpMult should exceed ${TIERS[i - 1].name}`);
    }
  });
});

// ============================================================================
// getTierConfig
// ============================================================================
describe('getTierConfig', () => {
  it('returns correct config for each tier name', () => {
    for (const tier of TIERS) {
      const config = getTierConfig(tier.name);
      assert.equal(config.name, tier.name);
      assert.equal(config.emoji, tier.emoji);
    }
  });

  it('returns asteroid config for asteroid tier', () => {
    const config = getTierConfig('asteroid');
    assert.equal(config.name, 'asteroid');
    assert.equal(config.emoji, '🪨');
  });

  it('returns nebula config for nebula tier', () => {
    const config = getTierConfig('nebula');
    assert.equal(config.name, 'nebula');
    assert.equal(config.emoji, '✨');
  });

  it('falls back to satellite for unknown tier name', () => {
    const config = getTierConfig('quasar');
    assert.equal(config.name, 'satellite');
  });

  it('falls back to satellite for empty string', () => {
    const config = getTierConfig('');
    assert.equal(config.name, 'satellite');
  });
});

// ============================================================================
// classifyTier
// ============================================================================
describe('classifyTier', () => {
  const maxCapital = 10000;

  it('classifies 0% as satellite', () => {
    assert.equal(classifyTier(0, maxCapital).name, 'satellite');
  });

  it('classifies 0.5% as satellite', () => {
    assert.equal(classifyTier(50, maxCapital).name, 'satellite');
  });

  it('classifies exactly 1% as asteroid', () => {
    assert.equal(classifyTier(100, maxCapital).name, 'asteroid');
  });

  it('classifies 1.5% as asteroid', () => {
    assert.equal(classifyTier(150, maxCapital).name, 'asteroid');
  });

  it('classifies exactly 2% as moon', () => {
    assert.equal(classifyTier(200, maxCapital).name, 'moon');
  });

  it('classifies exactly 5% as planet', () => {
    assert.equal(classifyTier(500, maxCapital).name, 'planet');
  });

  it('classifies exactly 15% as sun', () => {
    assert.equal(classifyTier(1500, maxCapital).name, 'sun');
  });

  it('classifies exactly 30% as hypergiant', () => {
    assert.equal(classifyTier(3000, maxCapital).name, 'hypergiant');
  });

  it('classifies exactly 40% as nebula', () => {
    assert.equal(classifyTier(4000, maxCapital).name, 'nebula');
  });

  it('classifies exactly 50% as galaxy', () => {
    assert.equal(classifyTier(5000, maxCapital).name, 'galaxy');
  });

  it('classifies exactly 75% as black_hole', () => {
    assert.equal(classifyTier(7500, maxCapital).name, 'black_hole');
  });

  it('classifies 100% as black_hole', () => {
    assert.equal(classifyTier(10000, maxCapital).name, 'black_hole');
  });

  it('classifies above 100% as black_hole', () => {
    assert.equal(classifyTier(20000, maxCapital).name, 'black_hole');
  });

  it('returns satellite when maxUsdcDeployed is 0', () => {
    assert.equal(classifyTier(5000, 0).name, 'satellite');
  });

  it('handles boundary just below moon threshold', () => {
    // 1.99% of 10000 = 199 → asteroid (1-2%)
    assert.equal(classifyTier(199, maxCapital).name, 'asteroid');
  });

  it('handles boundary just below asteroid threshold', () => {
    // 0.99% of 10000 = 99 → satellite (0-1%)
    assert.equal(classifyTier(99, maxCapital).name, 'satellite');
  });
});

// ============================================================================
// generateBodyId
// ============================================================================
describe('generateBodyId', () => {
  it('returns a string starting with "body-"', () => {
    const id = generateBodyId('order-abcdef12');
    assert.ok(id.startsWith('body-'));
  });

  it('incorporates last 8 chars of orderId', () => {
    const orderId = 'order-XYZZY123';
    const id = generateBodyId(orderId);
    assert.ok(id.includes('XYZZY123'), `Expected ${id} to contain last 8 chars of orderId`);
  });

  it('generates unique IDs for different orderIds', () => {
    const id1 = generateBodyId('order-aaa');
    const id2 = generateBodyId('order-bbb');
    assert.notEqual(id1, id2);
  });

  it('handles empty/null orderId without throwing', () => {
    const id = generateBodyId('');
    assert.ok(id.startsWith('body-'));
  });
});

// ============================================================================
// createNewBody
// ============================================================================
describe('createNewBody', () => {
  it('creates a satellite-tier body', () => {
    const newBuy = makeNewBuy();
    const body = createNewBody(newBuy, 'buy-order-1');
    assert.equal(body.tier, 'satellite');
    assert.equal(body.mergeCount, 0);
    assert.equal(body.tpOrderId, null);
    assert.equal(body.tpPrice, 0);
    assert.equal(body.assetOnOrder, 0);
  });

  it('uses totalSize and totalValue+fees for costBasis', () => {
    const newBuy = makeNewBuy({ totalSize: 0.005, totalValue: 500, totalFees: 0.50 });
    const body = createNewBody(newBuy, 'buy-order-2');
    assert.equal(body.assetQty, 0.005);
    assert.equal(body.costBasis, 500.50);
  });

  it('prefers assetQty and costBasis fields when present', () => {
    const newBuy = { assetQty: 0.01, costBasis: 1000, avgPrice: 100000, totalSize: 0.005, totalValue: 500 };
    const body = createNewBody(newBuy, 'buy-order-3');
    assert.equal(body.assetQty, 0.01);
    assert.equal(body.costBasis, 1000);
  });

  it('stores the buyOrderId in sourceOrderIds', () => {
    const body = createNewBody(makeNewBuy(), 'buy-order-4');
    assert.deepStrictEqual(body.sourceOrderIds, ['buy-order-4']);
  });

  it('initializes buyOrders array with one entry', () => {
    const body = createNewBody(makeNewBuy(), 'buy-order-5');
    assert.equal(body.buyOrders.length, 1);
    assert.equal(body.buyOrders[0].orderId, 'buy-order-5');
  });

  it('sets avgPrice from newBuy', () => {
    const body = createNewBody(makeNewBuy({ avgPrice: 95000 }), 'buy-order-6');
    assert.equal(body.avgPrice, 95000);
  });
});

// ============================================================================
// findMergeTarget
// ============================================================================
describe('findMergeTarget', () => {
  it('returns null for empty bodies array', () => {
    const result = findMergeTarget([], makeNewBuy(), 10000, 101000, 10);
    assert.equal(result, null);
  });

  it('returns null when below capacity and no TP prices are within proximity', () => {
    const bodies = [
      makeBody({ tpPrice: 110000 }), // far from candidateTpPrice
    ];
    // candidateTpPrice = 101000, body TP at 110000 => ~8.9% away, satellite proximity is 0.5%
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, 101000, 10);
    assert.equal(result, null);
  });

  it('returns closest body when at capacity (forced merge)', () => {
    const bodies = [
      makeBody({ id: 'b1', tpPrice: 102000 }),
      makeBody({ id: 'b2', tpPrice: 108000 }),
    ];
    // maxBodies = 2, so at capacity — forced merge picks closest to candidateTpPrice=101000
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, 101000, 2);
    assert.equal(result.id, 'b1');
  });

  it('forced merge falls back to highest costBasis when no bodies have tpPrice', () => {
    const bodies = [
      makeBody({ id: 'b1', tpPrice: 0, costBasis: 50 }),
      makeBody({ id: 'b2', tpPrice: 0, costBasis: 200 }),
    ];
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, 101000, 2);
    assert.equal(result.id, 'b2');
  });

  it('returns body within proximity for voluntary merge', () => {
    // satellite proximity = 0.5%, so TP must be within 0.5% of candidateTpPrice
    const candidateTp = 100000;
    const withinProximity = candidateTp * 1.004; // 0.4% away
    const bodies = [
      makeBody({ id: 'close', tpPrice: withinProximity }),
    ];
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, candidateTp, 10);
    assert.equal(result.id, 'close');
  });

  it('skips bodies with tpPrice <= 0 in voluntary merge', () => {
    const bodies = [
      makeBody({ id: 'no-tp', tpPrice: 0 }),
      makeBody({ id: 'has-tp', tpPrice: 100100 }),
    ];
    // 100100 vs 100000 = 0.1% away, within satellite 0.5% proximity
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, 100000, 10);
    assert.equal(result.id, 'has-tp');
  });

  it('forced merge triggers when order budget is full', () => {
    const bodies = [
      makeBody({ id: 'b1', tpPrice: 102000 }),
    ];
    // bodies.length < maxBodies, but pendingOrderCount + 1 >= maxOpenOrders
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, 101000, 10, 19, 20);
    assert.equal(result.id, 'b1');
  });

  it('picks best (closest) among multiple proximity matches', () => {
    const candidateTp = 100000;
    const bodies = [
      makeBody({ id: 'far', tpPrice: candidateTp * 1.004 }),   // 0.4%
      makeBody({ id: 'near', tpPrice: candidateTp * 1.001 }),  // 0.1%
    ];
    const result = findMergeTarget(bodies, makeNewBuy(), 10000, candidateTp, 10);
    assert.equal(result.id, 'near');
  });
});

// ============================================================================
// mergeIntoBody
// ============================================================================
describe('mergeIntoBody', () => {
  it('combines BTC and cost basis', () => {
    const body = makeBody({ assetQty: 0.001, costBasis: 100 });
    const newBuy = makeNewBuy({ totalSize: 0.002, totalValue: 200, totalFees: 0.20 });
    mergeIntoBody(body, newBuy, 10000, 'order-merge-1');

    assert.ok(Math.abs(body.assetQty - 0.003) < 1e-8);
    assert.ok(Math.abs(body.costBasis - 300.20) < 0.01);
  });

  it('recalculates avgPrice after merge', () => {
    const body = makeBody({ assetQty: 0.001, costBasis: 100 });
    const newBuy = makeNewBuy({ totalSize: 0.001, totalValue: 120, totalFees: 0 });
    mergeIntoBody(body, newBuy, 10000, 'order-merge-2');

    const expectedAvg = 220 / 0.002;
    assert.ok(Math.abs(body.avgPrice - expectedAvg) < 0.01);
  });

  it('increments mergeCount', () => {
    const body = makeBody({ mergeCount: 0 });
    mergeIntoBody(body, makeNewBuy(), 10000, 'order-merge-3');
    assert.equal(body.mergeCount, 1);
  });

  it('appends buyOrderId to sourceOrderIds', () => {
    const body = makeBody({ sourceOrderIds: ['order-0'] });
    mergeIntoBody(body, makeNewBuy(), 10000, 'order-merge-4');
    assert.deepStrictEqual(body.sourceOrderIds, ['order-0', 'order-merge-4']);
  });

  it('promotes tier when cost basis crosses threshold', () => {
    // satellite maxPct is 1%, asteroid is 1-2%, moon starts at 2%
    // With maxCapital=10000, costBasis >= 200 => moon
    const body = makeBody({ assetQty: 0.001, costBasis: 150, tier: 'satellite' });
    const newBuy = makeNewBuy({ totalSize: 0.001, totalValue: 100, totalFees: 0 });
    mergeIntoBody(body, newBuy, 10000, 'order-promote');

    assert.equal(body.tier, 'moon'); // 250/10000 = 2.5%
  });

  it('initializes buyOrders array if missing on legacy body', () => {
    const body = makeBody();
    delete body.buyOrders;
    mergeIntoBody(body, makeNewBuy(), 10000, 'order-legacy');
    assert.ok(Array.isArray(body.buyOrders));
    assert.equal(body.buyOrders.length, 1);
  });
});

// ============================================================================
// mergeBodies
// ============================================================================
describe('mergeBodies', () => {
  it('combines two bodies quantities and costs', () => {
    const target = makeBody({ assetQty: 0.002, costBasis: 200 });
    const source = makeBody({ assetQty: 0.003, costBasis: 300 });
    mergeBodies(target, source, 10000);

    assert.ok(Math.abs(target.assetQty - 0.005) < 1e-8);
    assert.ok(Math.abs(target.costBasis - 500) < 0.01);
  });

  it('clears TP fields on merged body', () => {
    const target = makeBody({ tpOrderId: 'tp-1', tpPrice: 105000, assetOnOrder: 0.001 });
    const source = makeBody({ tpOrderId: 'tp-2', tpPrice: 106000, assetOnOrder: 0.002 });
    mergeBodies(target, source, 10000);

    assert.equal(target.tpOrderId, null);
    assert.equal(target.tpPrice, 0);
    assert.equal(target.assetOnOrder, 0);
  });

  it('concatenates sourceOrderIds from both bodies', () => {
    const target = makeBody({ sourceOrderIds: ['a', 'b'] });
    const source = makeBody({ sourceOrderIds: ['c', 'd'] });
    mergeBodies(target, source, 10000);

    assert.deepStrictEqual(target.sourceOrderIds, ['a', 'b', 'c', 'd']);
  });

  it('accumulates mergeCount from both bodies', () => {
    const target = makeBody({ mergeCount: 2 });
    const source = makeBody({ mergeCount: 3 });
    mergeBodies(target, source, 10000);

    // target.mergeCount += 1 + source.mergeCount => 2 + 1 + 3 = 6
    assert.equal(target.mergeCount, 6);
  });

  it('promotes tier if combined cost crosses threshold', () => {
    // planet starts at 5% of maxCapital=10000 => costBasis >= 500
    const target = makeBody({ assetQty: 0.002, costBasis: 300, tier: 'moon' });
    const source = makeBody({ assetQty: 0.003, costBasis: 300, tier: 'moon' });
    mergeBodies(target, source, 10000);

    assert.equal(target.tier, 'planet'); // 600/10000 = 6%
  });

  it('handles missing buyOrders arrays gracefully', () => {
    const target = makeBody();
    const source = makeBody();
    delete target.buyOrders;
    delete source.buyOrders;
    mergeBodies(target, source, 10000);

    assert.ok(Array.isArray(target.buyOrders));
    assert.equal(target.buyOrders.length, 0);
  });

  it('recalculates avgPrice correctly', () => {
    const target = makeBody({ assetQty: 0.01, costBasis: 1000 });
    const source = makeBody({ assetQty: 0.02, costBasis: 1800 });
    mergeBodies(target, source, 100000);

    const expectedAvg = 2800 / 0.03;
    assert.ok(Math.abs(target.avgPrice - expectedAvg) < 0.01);
  });
});

// ============================================================================
// calculateBodyTpPercent
// ============================================================================
describe('calculateBodyTpPercent', () => {
  it('applies satellite 1.0x multiplier', () => {
    const result = calculateBodyTpPercent(1.0, 'satellite', 5.0);
    assert.equal(result.tpPercent, 1.0);
    assert.equal(result.effectiveMax, 5.0);
  });

  it('applies asteroid 1.1x multiplier', () => {
    const result = calculateBodyTpPercent(1.0, 'asteroid', 5.0);
    assert.ok(Math.abs(result.tpPercent - 1.1) < 0.001);
    assert.ok(Math.abs(result.effectiveMax - 6.0) < 0.001); // 5.0 * 1.2
  });

  it('applies moon 1.2x multiplier', () => {
    const result = calculateBodyTpPercent(1.0, 'moon', 5.0);
    assert.ok(Math.abs(result.tpPercent - 1.2) < 0.001);
    assert.ok(Math.abs(result.effectiveMax - 7.5) < 0.001); // 5.0 * 1.5
  });

  it('applies sun 2.0x multiplier', () => {
    const result = calculateBodyTpPercent(2.0, 'sun', 5.0);
    assert.ok(Math.abs(result.tpPercent - 4.0) < 0.001);
    assert.ok(Math.abs(result.effectiveMax - 15.0) < 0.001); // 5.0 * 3.0
  });

  it('applies nebula 3.5x multiplier', () => {
    const result = calculateBodyTpPercent(1.0, 'nebula', 5.0);
    assert.ok(Math.abs(result.tpPercent - 3.5) < 0.001);
    assert.ok(Math.abs(result.effectiveMax - 30.0) < 0.001); // 5.0 * 6.0
  });

  it('caps tpPercent at effectiveMax', () => {
    // With a very high base TP, the result should be capped
    const result = calculateBodyTpPercent(100.0, 'satellite', 5.0);
    assert.equal(result.tpPercent, 5.0); // capped at 5.0 * 1.0
  });

  it('applies black_hole 5.0x multiplier with 10x tpMaxScale', () => {
    const result = calculateBodyTpPercent(1.0, 'black_hole', 5.0);
    assert.ok(Math.abs(result.tpPercent - 5.0) < 0.001);
    assert.ok(Math.abs(result.effectiveMax - 50.0) < 0.001);
  });

  it('falls back to satellite multipliers for unknown tier', () => {
    const result = calculateBodyTpPercent(1.0, 'unknown_tier', 5.0);
    assert.equal(result.tpPercent, 1.0);
    assert.equal(result.effectiveMax, 5.0);
  });
});

// ============================================================================
// checkPromotions
// ============================================================================
describe('checkPromotions', () => {
  it('promotes a satellite to moon when cost basis qualifies', () => {
    const bodies = [makeBody({ tier: 'satellite', costBasis: 300 })];
    checkPromotions(bodies, 10000); // 3% => moon
    assert.equal(bodies[0].tier, 'moon');
  });

  it('demotes a body if cost basis no longer qualifies (reclassify)', () => {
    const bodies = [makeBody({ tier: 'planet', costBasis: 100 })];
    checkPromotions(bodies, 10000); // 1% => asteroid
    assert.equal(bodies[0].tier, 'asteroid');
  });

  it('leaves body unchanged if tier is already correct', () => {
    const bodies = [makeBody({ tier: 'moon', costBasis: 300 })];
    checkPromotions(bodies, 10000); // 3% => moon (correct)
    assert.equal(bodies[0].tier, 'moon');
  });

  it('promotes to nebula when cost basis qualifies', () => {
    const bodies = [makeBody({ tier: 'hypergiant', costBasis: 4500 })];
    checkPromotions(bodies, 10000); // 45% => nebula
    assert.equal(bodies[0].tier, 'nebula');
  });

  it('handles empty bodies array', () => {
    const result = checkPromotions([], 10000);
    assert.deepStrictEqual(result, []);
  });

  it('returns the same bodies array reference', () => {
    const bodies = [makeBody()];
    const result = checkPromotions(bodies, 10000);
    assert.equal(result, bodies);
  });
});

// ============================================================================
// syncPositionState
// ============================================================================
describe('syncPositionState', () => {
  it('aggregates BTC and cost basis from multiple bodies', () => {
    const state = {};
    const bodies = [
      makeBody({ assetQty: 0.001, costBasis: 100, assetOnOrder: 0.0005 }),
      makeBody({ assetQty: 0.002, costBasis: 200, assetOnOrder: 0.001 }),
    ];
    syncPositionState(state, bodies);

    assert.ok(Math.abs(state.totalAsset - 0.003) < 1e-8);
    assert.ok(Math.abs(state.totalCostBasis - 300) < 0.01);
    assert.ok(Math.abs(state.assetOnOrder - 0.0015) < 1e-8);
    assert.ok(Math.abs(state.avgCostBasis - 100000) < 0.01);
  });

  it('handles empty bodies array', () => {
    const state = {};
    syncPositionState(state, []);

    assert.equal(state.totalAsset, 0);
    assert.equal(state.totalCostBasis, 0);
    assert.equal(state.avgCostBasis, 0);
    assert.equal(state.assetOnOrder, 0);
  });

  it('sets avgCostBasis to 0 when totalAsset is 0', () => {
    const state = {};
    syncPositionState(state, [makeBody({ assetQty: 0, costBasis: 0, assetOnOrder: 0 })]);
    assert.equal(state.avgCostBasis, 0);
  });
});

// ============================================================================
// getTierSummary (including TIER_ABBREV fix)
// ============================================================================
describe('getTierSummary', () => {
  it('returns empty string for empty bodies', () => {
    assert.equal(getTierSummary([]), '');
  });

  it('abbreviates satellite as "Sat" (not "S")', () => {
    const bodies = [makeBody({ tier: 'satellite' })];
    const summary = getTierSummary(bodies);
    assert.equal(summary, 'Sat:1');
  });

  it('abbreviates asteroid as "Ast"', () => {
    const bodies = [makeBody({ tier: 'asteroid' })];
    const summary = getTierSummary(bodies);
    assert.equal(summary, 'Ast:1');
  });

  it('abbreviates nebula as "Neb"', () => {
    const bodies = [makeBody({ tier: 'nebula' })];
    const summary = getTierSummary(bodies);
    assert.equal(summary, 'Neb:1');
  });

  it('abbreviates sun as "Sun" (not "S") — no collision with satellite', () => {
    const bodies = [
      makeBody({ tier: 'satellite' }),
      makeBody({ tier: 'sun' }),
    ];
    const summary = getTierSummary(bodies);
    assert.ok(summary.includes('Sat:1'), `Expected Sat:1 in "${summary}"`);
    assert.ok(summary.includes('Sun:1'), `Expected Sun:1 in "${summary}"`);
  });

  it('counts multiple bodies in same tier', () => {
    const bodies = [
      makeBody({ tier: 'moon' }),
      makeBody({ tier: 'moon' }),
      makeBody({ tier: 'moon' }),
    ];
    assert.equal(getTierSummary(bodies), 'M:3');
  });

  it('uses correct abbreviations for all tiers', () => {
    const bodies = TIERS.map(t => makeBody({ tier: t.name }));
    const summary = getTierSummary(bodies);
    assert.ok(summary.includes('Sat:1'));
    assert.ok(summary.includes('Ast:1'));
    assert.ok(summary.includes('M:1'));
    assert.ok(summary.includes('P:1'));
    assert.ok(summary.includes('Sun:1'));
    assert.ok(summary.includes('HG:1'));
    assert.ok(summary.includes('Neb:1'));
    assert.ok(summary.includes('G:1'));
    assert.ok(summary.includes('BH:1'));
  });
});

// ============================================================================
// createInitialCelestialState
// ============================================================================
describe('createInitialCelestialState', () => {
  it('returns zeroed state with version 1', () => {
    const state = createInitialCelestialState();
    assert.equal(state.bodiesCompleted, 0);
    assert.equal(state.bodiesRealizedPnL, 0);
    assert.equal(state.bodiesRealizedAssetPnL, 0);
    assert.equal(state.stateVersion, 1);
  });
});

// ============================================================================
// TIER_COLORS
// ============================================================================
describe('TIER_COLORS', () => {
  it('has a color entry for every tier', () => {
    for (const tier of TIERS) {
      assert.ok(TIER_COLORS[tier.name], `Missing color for tier ${tier.name}`);
    }
  });

  it('all colors are valid hex strings', () => {
    for (const [name, color] of Object.entries(TIER_COLORS)) {
      assert.match(color, /^#[0-9A-Fa-f]{6}$/, `Invalid hex color for ${name}: ${color}`);
    }
  });
});

// ============================================================================
// migrateFromLegacy
// ============================================================================
describe('migrateFromLegacy', () => {
  it('migrates a core position into a single body', () => {
    const positionState = {
      totalAsset: 0.1,
      totalCostBasis: 5000,
      avgCostBasis: 50000,
      assetOnOrder: 0.09,
      activeTpOrderId: 'tp-legacy',
      lastTpPrice: 55000,
      lastEntryTime: 1700000000000,
    };
    const bodies = migrateFromLegacy(positionState, 10000);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].assetQty, 0.1);
    assert.equal(bodies[0].costBasis, 5000);
    assert.equal(bodies[0].tpOrderId, 'tp-legacy');
    assert.equal(bodies[0].tpPrice, 55000);
    assert.equal(bodies[0].tier, 'galaxy'); // 50% of 10000
  });

  it('migrates legacy satellite TP orders', () => {
    const positionState = {
      totalAsset: 0,
      totalCostBasis: 0,
      satelliteTpOrders: [  // legacy field name for migration test
        { orderId: 'sat-1', assetQty: 0.001, costBasis: 100, avgPrice: 100000, tpOrderId: 'tp-sat-1', tpPrice: 102000, assetOnOrder: 0.0009, placedAt: 1700000000000 },
        { orderId: 'sat-2', assetQty: 0.002, costBasis: 200, avgPrice: 100000, tpOrderId: null, tpPrice: 0, assetOnOrder: 0 },
      ],
    };
    const bodies = migrateFromLegacy(positionState, 10000);

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].assetQty, 0.001);
    assert.equal(bodies[1].assetQty, 0.002);
  });

  it('returns empty array when no position and no bodies', () => {
    const bodies = migrateFromLegacy({ totalAsset: 0, totalCostBasis: 0 }, 10000);
    assert.equal(bodies.length, 0);
  });

  it('handles missing legacy satelliteTpOrders', () => {
    const bodies = migrateFromLegacy({ totalAsset: 0, totalCostBasis: 0 }, 10000);
    assert.equal(bodies.length, 0);
  });

  it('migrates both core and legacy satellites', () => {
    const positionState = {
      totalAsset: 0.05,
      totalCostBasis: 5000,
      avgCostBasis: 100000,
      satelliteTpOrders: [  // legacy field name for migration test
        { orderId: 'sat-1', assetQty: 0.001, costBasis: 100, avgPrice: 100000 },
      ],
    };
    const bodies = migrateFromLegacy(positionState, 10000);
    assert.equal(bodies.length, 2); // 1 core + 1 legacy satellite
  });
});

describe('buildBodyTpOrder', () => {
  const baseBody = {
    id: 'body-test-001',
    tier: 'satellite',
    tpOrderId: 'tp-abc-123',
    tpPrice: 105000,
    avgPrice: 100000,
    assetQty: 0.05,
    costBasis: 5000,
    assetOnOrder: 0.025,
    createdAt: 1700000000000,
    lastMergedAt: null,
    mergeCount: 0,
  };

  it('maps every dashboard-consumed field from a body to a pendingOrder shape', () => {
    const order = buildBodyTpOrder(baseBody);
    assert.equal(order.orderId, 'tp-abc-123');
    assert.equal(order.side, 'sell');
    assert.equal(order.type, 'body_tp');
    assert.equal(order.status, 'open');
    assert.equal(order.price, 105000);
    assert.equal(order.bodyId, 'body-test-001');
    assert.equal(order.bodyTier, 'satellite');
    assert.equal(order.bodyAvgCost, 100000);
    assert.equal(order.bodyBtcQty, 0.05);
    assert.equal(order.bodyCostBasis, 5000);
    assert.equal(order.tierEmoji, getTierConfig('satellite').emoji);
  });

  it('prefers assetOnOrder over assetQty for size (TP may be sized post-holdback)', () => {
    assert.equal(buildBodyTpOrder(baseBody).size, 0.025);
    const noOnOrder = { ...baseBody, assetOnOrder: undefined };
    assert.equal(buildBodyTpOrder(noOnOrder).size, 0.05);
    // Explicit zero is a valid sell-quantity (e.g. body fully holdback) — keep it
    const zero = { ...baseBody, assetOnOrder: 0 };
    assert.equal(buildBodyTpOrder(zero).size, 0);
  });

  it('uses lastMergedAt as placedAt when present, falls back to createdAt, then null', () => {
    assert.equal(buildBodyTpOrder({ ...baseBody, lastMergedAt: 1800000000000 }).placedAt, 1800000000000);
    assert.equal(buildBodyTpOrder(baseBody).placedAt, 1700000000000);
    assert.equal(buildBodyTpOrder({ ...baseBody, createdAt: null, lastMergedAt: null }).placedAt, null);
  });

  it('computes tpPercent from avgPrice and tpPrice', () => {
    assert.equal(buildBodyTpOrder(baseBody).tpPercent, '5.00');
    assert.equal(buildBodyTpOrder({ ...baseBody, avgPrice: 0 }).tpPercent, null);
    assert.equal(buildBodyTpOrder({ ...baseBody, tpPrice: 0 }).tpPercent, null);
  });

  it('falls back to a default emoji for an unknown tier', () => {
    assert.equal(buildBodyTpOrder({ ...baseBody, tier: 'unknown-tier' }).tierEmoji, '🛰️');
  });
});

describe('buildCoreTpOrder', () => {
  it('maps legacy core TP fields from a position', () => {
    const order = buildCoreTpOrder({
      activeTpOrderId: 'core-tp-1',
      lastTpPrice: 110000,
      assetOnOrder: 0.1,
      avgCostBasis: 100000,
    });
    assert.equal(order.orderId, 'core-tp-1');
    assert.equal(order.side, 'sell');
    assert.equal(order.type, 'take_profit');
    assert.equal(order.status, 'open');
    assert.equal(order.price, 110000);
    assert.equal(order.size, 0.1);
    assert.equal(order.tpPercent, '10.00');
    assert.equal(order.bodyId, undefined);  // core TPs aren't body-owned
  });

  it('returns null tpPercent when avgCostBasis or lastTpPrice is zero', () => {
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', avgCostBasis: 0, lastTpPrice: 110000 }).tpPercent, null);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', avgCostBasis: 100000, lastTpPrice: 0 }).tpPercent, null);
  });

  it('falls back to totalAsset when assetOnOrder is missing (legacy migrated state)', () => {
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', totalAsset: 0.5 }).size, 0.5);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', assetOnOrder: 0, totalAsset: 0.5 }).size, 0.5);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', assetOnOrder: 0.1, totalAsset: 0.5 }).size, 0.1);
  });

  it('uses lastEntryTime as placedAt, falling back to engineStartTime, then null', () => {
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', lastEntryTime: 1800000000000 }).placedAt, 1800000000000);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', engineStartTime: 1700000000000 }).placedAt, 1700000000000);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x', lastEntryTime: 1800000000000, engineStartTime: 1700000000000 }).placedAt, 1800000000000);
    assert.equal(buildCoreTpOrder({ activeTpOrderId: 'x' }).placedAt, null);
  });
});

describe('buildPersistedPendingOrders', () => {
  it('returns an empty array for null position', () => {
    assert.deepEqual(buildPersistedPendingOrders(null), []);
    assert.deepEqual(buildPersistedPendingOrders(undefined), []);
  });

  it('synthesizes only body TPs when bodies exist and no legacy core TP', () => {
    const orders = buildPersistedPendingOrders({
      celestialBodies: [
        { id: 'b1', tier: 'satellite', tpOrderId: 'tp-1', tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, assetOnOrder: 0.025, costBasis: 5000 },
        { id: 'b2', tier: 'moon', tpOrderId: null, assetQty: 0.1 },  // no TP
      ],
      activeTpOrderId: null,
    });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 'tp-1');
    assert.equal(orders[0].type, 'body_tp');
  });

  it('appends a legacy core TP when activeTpOrderId is set', () => {
    const orders = buildPersistedPendingOrders({
      celestialBodies: [],
      activeTpOrderId: 'core-tp-1',
      lastTpPrice: 110000,
      assetOnOrder: 0.1,
      avgCostBasis: 100000,
    });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 'core-tp-1');
    assert.equal(orders[0].type, 'take_profit');
  });

  it('combines body TPs and a legacy core TP when both are present', () => {
    const orders = buildPersistedPendingOrders({
      celestialBodies: [
        { id: 'b1', tier: 'satellite', tpOrderId: 'tp-1', tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, costBasis: 5000 },
      ],
      activeTpOrderId: 'core-tp-1',
      lastTpPrice: 105000,
      assetOnOrder: 0.02,
      avgCostBasis: 100000,
    });
    assert.equal(orders.length, 2);
    assert.equal(orders.find(o => o.type === 'body_tp').orderId, 'tp-1');
    assert.equal(orders.find(o => o.type === 'take_profit').orderId, 'core-tp-1');
  });

  it('dedupes the core TP when its orderId is already a body tpOrderId (migrated state)', () => {
    const sharedId = 'tp-shared';
    const orders = buildPersistedPendingOrders({
      celestialBodies: [
        { id: 'b1', tier: 'satellite', tpOrderId: sharedId, tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, costBasis: 5000 },
      ],
      activeTpOrderId: sharedId,  // same exchange order — must not be emitted twice
      lastTpPrice: 110000,
      assetOnOrder: 0.05,
      avgCostBasis: 100000,
    });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].type, 'body_tp');  // body version wins (richer metadata)
    assert.equal(orders[0].orderId, sharedId);
  });

  it('drops persisted TPs that the live tracker reports as filled or cancelled', () => {
    const position = {
      celestialBodies: [
        { id: 'b1', tier: 'satellite', tpOrderId: 'tp-open', tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, costBasis: 5000 },
        { id: 'b2', tier: 'satellite', tpOrderId: 'tp-filled', tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, costBasis: 5000 },
      ],
      activeTpOrderId: 'tp-cancelled',
      lastTpPrice: 105000,
      assetOnOrder: 0.02,
      avgCostBasis: 100000,
    };
    const liveStatus = (id) => ({ 'tp-open': 'open', 'tp-filled': 'filled', 'tp-cancelled': 'cancelled' })[id] ?? null;
    const orders = buildPersistedPendingOrders(position, liveStatus);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 'tp-open');
  });

  it('keeps TPs the live tracker doesn\'t know about (returns null)', () => {
    const position = {
      celestialBodies: [
        { id: 'b1', tier: 'satellite', tpOrderId: 'tp-untracked', tpPrice: 110000, avgPrice: 100000, assetQty: 0.05, costBasis: 5000 },
      ],
    };
    const liveStatus = () => null;  // tracker has no info — preserve persisted state
    const orders = buildPersistedPendingOrders(position, liveStatus);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 'tp-untracked');
  });
});

describe('buildCelestialPayload', () => {
  // The original bug this PR fixes was caused by 4 inline copies of this
  // shape drifting apart. Lock the contract here so a regression in any
  // single field will fail loudly rather than silently break the dashboard.
  const baseBody = {
    id: 'body-001',
    tier: 'satellite',
    assetQty: 0.05,
    costBasis: 5000,
    avgPrice: 100000,
    tpOrderId: 'tp-1',
    tpPrice: 110000,
    assetOnOrder: 0.025,
    createdAt: 1700000000000,
    lastMergedAt: 1750000000000,
    mergeCount: 1,
    buyOrders: [
      { orderId: 'buy-1', price: 99000, assetQty: 0.025, sizeUsdc: 2475, filledAt: 1700000000000 },
      { orderId: 'buy-2', price: 101000, assetQty: 0.025, sizeUsdc: 2525, filledAt: 1700000001000, internal: 'should-not-leak' },
    ],
  };

  it('returns the full status shape for a populated position', () => {
    const position = {
      celestialBodies: [baseBody],
      celestialState: { bodiesCompleted: 7, bodiesRealizedPnL: 123.45, bodiesRealizedAssetPnL: 0.01 },
    };
    const payload = buildCelestialPayload(position, { celestialEnabled: true });
    assert.equal(payload.enabled, true);
    assert.equal(payload.bodiesActive, 1);
    assert.equal(payload.bodiesCompleted, 7);
    assert.equal(payload.bodiesRealizedPnL, 123.45);
    assert.equal(payload.bodiesRealizedAssetPnL, 0.01);
    assert.ok(Array.isArray(payload.bodies));
    assert.ok(payload.tierSummary);
  });

  it('serializes each body with the dashboard-required fields', () => {
    const payload = buildCelestialPayload({ celestialBodies: [baseBody] }, {});
    const b = payload.bodies[0];
    assert.equal(b.id, 'body-001');
    assert.equal(b.tier, 'satellite');
    assert.equal(b.tpOrderId, 'tp-1');
    assert.equal(b.tpPrice, 110000);
    assert.equal(b.tpPercent, '10.00');
    assert.equal(b.avgPrice, 100000);
    assert.equal(b.assetQty, 0.05);
    assert.equal(b.costBasis, 5000);
    assert.equal(b.assetOnOrder, 0.025);
    assert.equal(b.createdAt, 1700000000000);
    assert.equal(b.lastMergedAt, 1750000000000);
    assert.equal(b.mergeCount, 1);
    assert.equal(typeof b.emoji, 'string');
  });

  it('whitelists buyOrders fields (does not leak internal annotations)', () => {
    const payload = buildCelestialPayload({ celestialBodies: [baseBody] }, {});
    const buyOrders = payload.bodies[0].buyOrders;
    assert.equal(buyOrders.length, 2);
    for (const bo of buyOrders) {
      assert.deepEqual(Object.keys(bo).sort(), ['assetQty', 'filledAt', 'orderId', 'price', 'sizeUsdc']);
    }
  });

  it('treats config.celestialEnabled !== false as enabled (matches engine semantics)', () => {
    assert.equal(buildCelestialPayload({}, { celestialEnabled: true }).enabled, true);
    assert.equal(buildCelestialPayload({}, { celestialEnabled: undefined }).enabled, true);
    assert.equal(buildCelestialPayload({}, {}).enabled, true);
    assert.equal(buildCelestialPayload({}, undefined).enabled, true);
    assert.equal(buildCelestialPayload({}, { celestialEnabled: false }).enabled, false);
  });

  it('returns sane defaults for null/empty position', () => {
    const empty = buildCelestialPayload(null, {});
    assert.equal(empty.bodiesActive, 0);
    assert.equal(empty.bodiesCompleted, 0);
    assert.equal(empty.bodiesRealizedPnL, 0);
    assert.equal(empty.bodiesRealizedAssetPnL, 0);
    assert.deepEqual(empty.bodies, []);
  });

  it('null tpPercent when avgPrice or tpPrice is zero', () => {
    const noTp = buildCelestialPayload({ celestialBodies: [{ ...baseBody, tpPrice: 0 }] }, {});
    assert.equal(noTp.bodies[0].tpPercent, null);
    const noAvg = buildCelestialPayload({ celestialBodies: [{ ...baseBody, avgPrice: 0 }] }, {});
    assert.equal(noAvg.bodies[0].tpPercent, null);
  });
});
