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
} = require('../src/celestial-hierarchy');

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal CelestialBody for testing */
const makeBody = (overrides = {}) => ({
  id: 'body-test-001',
  tier: 'satellite',
  btcQty: 0.001,
  costBasis: 100,
  avgPrice: 100000,
  tpOrderId: null,
  tpPrice: 0,
  btcOnOrder: 0,
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
  it('has exactly 7 tiers', () => {
    assert.equal(TIERS.length, 7);
  });

  it('tiers are ordered from satellite to black_hole', () => {
    const names = TIERS.map(t => t.name);
    assert.deepStrictEqual(names, [
      'satellite', 'moon', 'planet', 'sun', 'hypergiant', 'galaxy', 'black_hole',
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

  it('falls back to satellite for unknown tier name', () => {
    const config = getTierConfig('nebula');
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

  it('classifies 1% (below moon boundary) as satellite', () => {
    assert.equal(classifyTier(100, maxCapital).name, 'satellite');
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
    // 1.99% of 10000 = 199
    assert.equal(classifyTier(199, maxCapital).name, 'satellite');
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
    assert.equal(body.btcOnOrder, 0);
  });

  it('uses totalSize and totalValue+fees for costBasis', () => {
    const newBuy = makeNewBuy({ totalSize: 0.005, totalValue: 500, totalFees: 0.50 });
    const body = createNewBody(newBuy, 'buy-order-2');
    assert.equal(body.btcQty, 0.005);
    assert.equal(body.costBasis, 500.50);
  });

  it('prefers btcQty and costBasis fields when present', () => {
    const newBuy = { btcQty: 0.01, costBasis: 1000, avgPrice: 100000, totalSize: 0.005, totalValue: 500 };
    const body = createNewBody(newBuy, 'buy-order-3');
    assert.equal(body.btcQty, 0.01);
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
    const body = makeBody({ btcQty: 0.001, costBasis: 100 });
    const newBuy = makeNewBuy({ totalSize: 0.002, totalValue: 200, totalFees: 0.20 });
    mergeIntoBody(body, newBuy, 10000, 'order-merge-1');

    assert.ok(Math.abs(body.btcQty - 0.003) < 1e-8);
    assert.ok(Math.abs(body.costBasis - 300.20) < 0.01);
  });

  it('recalculates avgPrice after merge', () => {
    const body = makeBody({ btcQty: 0.001, costBasis: 100 });
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
    // satellite maxPct is 2%, moon starts at 2%
    // With maxCapital=10000, costBasis >= 200 => moon
    const body = makeBody({ btcQty: 0.001, costBasis: 150, tier: 'satellite' });
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
    const target = makeBody({ btcQty: 0.002, costBasis: 200 });
    const source = makeBody({ btcQty: 0.003, costBasis: 300 });
    mergeBodies(target, source, 10000);

    assert.ok(Math.abs(target.btcQty - 0.005) < 1e-8);
    assert.ok(Math.abs(target.costBasis - 500) < 0.01);
  });

  it('clears TP fields on merged body', () => {
    const target = makeBody({ tpOrderId: 'tp-1', tpPrice: 105000, btcOnOrder: 0.001 });
    const source = makeBody({ tpOrderId: 'tp-2', tpPrice: 106000, btcOnOrder: 0.002 });
    mergeBodies(target, source, 10000);

    assert.equal(target.tpOrderId, null);
    assert.equal(target.tpPrice, 0);
    assert.equal(target.btcOnOrder, 0);
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
    const target = makeBody({ btcQty: 0.002, costBasis: 300, tier: 'moon' });
    const source = makeBody({ btcQty: 0.003, costBasis: 300, tier: 'moon' });
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
    const target = makeBody({ btcQty: 0.01, costBasis: 1000 });
    const source = makeBody({ btcQty: 0.02, costBasis: 1800 });
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
    checkPromotions(bodies, 10000); // 1% => satellite
    assert.equal(bodies[0].tier, 'satellite');
  });

  it('leaves body unchanged if tier is already correct', () => {
    const bodies = [makeBody({ tier: 'moon', costBasis: 300 })];
    checkPromotions(bodies, 10000); // 3% => moon (correct)
    assert.equal(bodies[0].tier, 'moon');
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
      makeBody({ btcQty: 0.001, costBasis: 100, btcOnOrder: 0.0005 }),
      makeBody({ btcQty: 0.002, costBasis: 200, btcOnOrder: 0.001 }),
    ];
    syncPositionState(state, bodies);

    assert.ok(Math.abs(state.totalBTC - 0.003) < 1e-8);
    assert.ok(Math.abs(state.totalCostBasis - 300) < 0.01);
    assert.ok(Math.abs(state.btcOnOrder - 0.0015) < 1e-8);
    assert.ok(Math.abs(state.avgCostBasis - 100000) < 0.01);
  });

  it('handles empty bodies array', () => {
    const state = {};
    syncPositionState(state, []);

    assert.equal(state.totalBTC, 0);
    assert.equal(state.totalCostBasis, 0);
    assert.equal(state.avgCostBasis, 0);
    assert.equal(state.btcOnOrder, 0);
  });

  it('sets avgCostBasis to 0 when totalBTC is 0', () => {
    const state = {};
    syncPositionState(state, [makeBody({ btcQty: 0, costBasis: 0, btcOnOrder: 0 })]);
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
    assert.ok(summary.includes('M:1'));
    assert.ok(summary.includes('P:1'));
    assert.ok(summary.includes('Sun:1'));
    assert.ok(summary.includes('HG:1'));
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
    assert.equal(state.bodiesRealizedBtcPnL, 0);
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
      totalBTC: 0.1,
      totalCostBasis: 5000,
      avgCostBasis: 50000,
      btcOnOrder: 0.09,
      activeTpOrderId: 'tp-legacy',
      lastTpPrice: 55000,
      lastEntryTime: 1700000000000,
    };
    const bodies = migrateFromLegacy(positionState, 10000);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].btcQty, 0.1);
    assert.equal(bodies[0].costBasis, 5000);
    assert.equal(bodies[0].tpOrderId, 'tp-legacy');
    assert.equal(bodies[0].tpPrice, 55000);
    assert.equal(bodies[0].tier, 'galaxy'); // 50% of 10000
  });

  it('migrates satellite TP orders', () => {
    const positionState = {
      totalBTC: 0,
      totalCostBasis: 0,
      satelliteTpOrders: [
        { orderId: 'sat-1', btcQty: 0.001, costBasis: 100, avgPrice: 100000, tpOrderId: 'tp-sat-1', tpPrice: 102000, btcOnOrder: 0.0009, placedAt: 1700000000000 },
        { orderId: 'sat-2', btcQty: 0.002, costBasis: 200, avgPrice: 100000, tpOrderId: null, tpPrice: 0, btcOnOrder: 0 },
      ],
    };
    const bodies = migrateFromLegacy(positionState, 10000);

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].btcQty, 0.001);
    assert.equal(bodies[1].btcQty, 0.002);
  });

  it('returns empty array when no position and no satellites', () => {
    const bodies = migrateFromLegacy({ totalBTC: 0, totalCostBasis: 0 }, 10000);
    assert.equal(bodies.length, 0);
  });

  it('handles missing satelliteTpOrders', () => {
    const bodies = migrateFromLegacy({ totalBTC: 0, totalCostBasis: 0 }, 10000);
    assert.equal(bodies.length, 0);
  });

  it('migrates both core and satellites', () => {
    const positionState = {
      totalBTC: 0.05,
      totalCostBasis: 5000,
      avgCostBasis: 100000,
      satelliteTpOrders: [
        { orderId: 'sat-1', btcQty: 0.001, costBasis: 100, avgPrice: 100000 },
      ],
    };
    const bodies = migrateFromLegacy(positionState, 10000);
    assert.equal(bodies.length, 2); // 1 core + 1 satellite
  });
});
