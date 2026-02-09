// @ts-check
/**
 * Celestial Hierarchy
 *
 * Multi-tier position management replacing binary core+satellite model.
 * Every buy starts as a satellite. Bodies consolidate within tiers when
 * price-close, and promote to higher tiers as mass (cost basis) grows.
 *
 * Tiers: satellite < moon < planet < sun < hypergiant < black_hole
 *
 * Pure logic, no I/O.
 */

const { roundBTC, roundUSDC } = require('./volatility-utils');

/**
 * @typedef {Object} CelestialTier
 * @property {string} name - Tier name
 * @property {string} emoji - Display emoji
 * @property {number} minMass - Minimum mass multiplier (× baseSizeUsdc)
 * @property {number} maxMass - Maximum mass multiplier (Infinity for top tier)
 * @property {number} tpMult - TP percentage multiplier
 * @property {number} tpMaxScale - Multiplied against tpMaxPercent for wider ceiling
 * @property {number} proximity - TP price proximity % for within-tier consolidation
 * @property {number} holdbackScale - Multiplied against holdbackRatio
 */

/**
 * @typedef {Object} CelestialBody
 * @property {string} id - Unique ID (persists through promotions)
 * @property {string} tier - Tier name
 * @property {number} btcQty - Total BTC
 * @property {number} costBasis - Total cost basis including fees ($)
 * @property {number} avgPrice - costBasis / btcQty
 * @property {string|null} tpOrderId - Exchange sell order ID
 * @property {number} tpPrice - Current TP price
 * @property {number} btcOnOrder - BTC in sell order (after holdback)
 * @property {number} createdAt - First creation timestamp
 * @property {number} lastMergedAt - Last merge/promotion timestamp
 * @property {string[]} sourceOrderIds - All constituent buy order IDs
 * @property {number} mergeCount - Number of merges undergone
 */

/**
 * @typedef {Object} CelestialState
 * @property {number} bodiesCompleted - Total body TP fills (all time)
 * @property {number} bodiesRealizedPnL - Cumulative USD P&L
 * @property {number} bodiesRealizedBtcPnL - Cumulative BTC holdback reserves
 * @property {number} stateVersion - Schema version
 */

/** @type {CelestialTier[]} */
const TIERS = [
  { name: 'satellite',  emoji: '🛰️', minMass: 1,   maxMass: 3,       tpMult: 1.0, tpMaxScale: 1.0,  proximity: 0.5, holdbackScale: 1.00 },
  { name: 'moon',       emoji: '🌙',  minMass: 3,   maxMass: 8,       tpMult: 1.2, tpMaxScale: 1.5,  proximity: 0.8, holdbackScale: 1.05 },
  { name: 'planet',     emoji: '🪐',  minMass: 8,   maxMass: 20,      tpMult: 1.5, tpMaxScale: 2.0,  proximity: 1.2, holdbackScale: 1.10 },
  { name: 'sun',        emoji: '☀️',  minMass: 20,  maxMass: 50,      tpMult: 2.0, tpMaxScale: 3.0,  proximity: 1.5, holdbackScale: 1.15 },
  { name: 'hypergiant', emoji: '💫',  minMass: 50,  maxMass: 120,     tpMult: 3.0, tpMaxScale: 5.0,  proximity: 2.0, holdbackScale: 1.20 },
  { name: 'black_hole', emoji: '🕳️', minMass: 120, maxMass: Infinity, tpMult: 5.0, tpMaxScale: 10.0, proximity: 2.5, holdbackScale: 1.25 },
];

/**
 * Get tier config by name
 * @param {string} tierName
 * @returns {CelestialTier}
 */
const getTierConfig = (tierName) => {
  return TIERS.find(t => t.name === tierName) || TIERS[0];
};

/**
 * Classify which tier a body belongs to based on cost basis
 * @param {number} costBasis - Total cost basis in USD
 * @param {number} baseSizeUsdc - Base order size
 * @returns {CelestialTier}
 */
const classifyTier = (costBasis, baseSizeUsdc) => {
  const mass = baseSizeUsdc > 0 ? costBasis / baseSizeUsdc : 1;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (mass >= TIERS[i].minMass) return TIERS[i];
  }
  return TIERS[0];
};

/**
 * Generate a short unique body ID from a buy order ID
 * @param {string} orderId - Buy order ID
 * @returns {string}
 */
const generateBodyId = (orderId) => {
  const suffix = orderId ? orderId.slice(-8) : Math.random().toString(36).slice(2, 10);
  return `body-${suffix}-${Date.now().toString(36)}`;
};

/**
 * Create a new satellite body from a buy fill
 * @param {Object} newBuy - Buy fill summary
 * @param {number} newBuy.totalSize - BTC quantity
 * @param {number} newBuy.totalValue - USDC value
 * @param {number} newBuy.totalFees - Fees paid
 * @param {number} newBuy.avgPrice - Average fill price
 * @param {string} buyOrderId - Order ID from the buy
 * @returns {CelestialBody}
 */
const createNewBody = (newBuy, buyOrderId) => {
  const btcQty = newBuy.btcQty || newBuy.totalSize;
  const costBasis = newBuy.costBasis || (newBuy.totalValue + (newBuy.totalFees || 0));
  return {
    id: generateBodyId(buyOrderId),
    tier: 'satellite',
    btcQty,
    costBasis,
    avgPrice: newBuy.avgPrice,
    tpOrderId: null,
    tpPrice: 0,
    btcOnOrder: 0,
    createdAt: Date.now(),
    lastMergedAt: Date.now(),
    sourceOrderIds: [buyOrderId],
    mergeCount: 0,
  };
};

/**
 * Find a body to merge a new buy into, or null to create a new body
 * @param {CelestialBody[]} bodies - Existing bodies
 * @param {Object} newBuy - Buy fill summary
 * @param {number} newBuy.totalSize - BTC quantity
 * @param {number} newBuy.totalValue - USDC value
 * @param {number} newBuy.totalFees - Fees paid
 * @param {number} newBuy.avgPrice - Average fill price
 * @param {number} baseSizeUsdc - Base order size
 * @param {number} candidateTpPrice - What TP price the new buy would get
 * @param {number} maxBodies - Maximum allowed bodies
 * @returns {CelestialBody|null}
 */
const findMergeTarget = (bodies, newBuy, baseSizeUsdc, candidateTpPrice, maxBodies, pendingOrderCount, maxOpenOrders) => {
  if (bodies.length === 0) return null;

  // Forced merge when at body capacity or order slot budget is full
  const orderBudgetFull = pendingOrderCount !== undefined && maxOpenOrders !== undefined
    && (pendingOrderCount + 1 >= maxOpenOrders);
  if (bodies.length >= maxBodies || orderBudgetFull) {
    let closest = null;
    let closestDist = Infinity;
    for (const body of bodies) {
      if (body.tpPrice <= 0) continue;
      const dist = Math.abs(body.tpPrice - candidateTpPrice);
      if (dist < closestDist) {
        closestDist = dist;
        closest = body;
      }
    }
    return closest || bodies[0];
  }

  // Check each body: is new buy's candidate TP within body's tier proximity?
  let bestTarget = null;
  let bestDistance = Infinity;

  for (const body of bodies) {
    if (body.tpPrice <= 0) continue;
    const tier = getTierConfig(body.tier);
    const priceDiff = Math.abs(body.tpPrice - candidateTpPrice) / candidateTpPrice * 100;

    if (priceDiff < tier.proximity && priceDiff < bestDistance) {
      bestDistance = priceDiff;
      bestTarget = body;
    }
  }

  return bestTarget;
};

/**
 * Merge a new buy into an existing body, potentially promoting it
 * @param {CelestialBody} target - Body to merge into
 * @param {Object} newBuy - Buy fill summary
 * @param {number} newBuy.totalSize - BTC quantity
 * @param {number} newBuy.totalValue - USDC value
 * @param {number} newBuy.totalFees - Fees paid
 * @param {number} newBuy.avgPrice - Average fill price
 * @param {number} baseSizeUsdc - Base order size
 * @param {string} buyOrderId - Order ID from the buy
 * @returns {CelestialBody} Updated body (mutated in place)
 */
const mergeIntoBody = (target, newBuy, baseSizeUsdc, buyOrderId) => {
  const newBtcQty = newBuy.btcQty || newBuy.totalSize;
  const newCost = newBuy.costBasis || (newBuy.totalValue + (newBuy.totalFees || 0));

  target.btcQty = roundBTC(target.btcQty + newBtcQty);
  target.costBasis = roundUSDC(target.costBasis + newCost);
  target.avgPrice = target.btcQty > 0 ? target.costBasis / target.btcQty : 0;
  target.lastMergedAt = Date.now();
  target.sourceOrderIds.push(buyOrderId);
  target.mergeCount += 1;

  // Check promotion
  const newTier = classifyTier(target.costBasis, baseSizeUsdc);
  if (newTier.name !== target.tier) {
    const oldTier = target.tier;
    target.tier = newTier.name;
    console.log(`⬆️ Body ${target.id.slice(-8)} promoted: ${getTierConfig(oldTier).emoji} ${oldTier} → ${newTier.emoji} ${newTier.name} (mass $${target.costBasis.toFixed(0)})`);
  }

  return target;
};

/**
 * Calculate body TP percentage with tier multipliers applied
 * @param {number} baseTpPct - Base dynamic TP percentage
 * @param {string} tierName - Tier name
 * @param {number} tpMaxPercent - Config tpMaxPercent
 * @returns {{tpPercent: number, effectiveMax: number}}
 */
const calculateBodyTpPercent = (baseTpPct, tierName, tpMaxPercent) => {
  const tier = getTierConfig(tierName);
  const tpPercent = baseTpPct * tier.tpMult;
  const effectiveMax = tpMaxPercent * tier.tpMaxScale;
  return {
    tpPercent: Math.min(tpPercent, effectiveMax),
    effectiveMax,
  };
};

/**
 * Reclassify all bodies that may have crossed tier boundaries
 * @param {CelestialBody[]} bodies - All bodies
 * @param {number} baseSizeUsdc - Base order size
 * @returns {CelestialBody[]} Bodies with updated tiers
 */
const checkPromotions = (bodies, baseSizeUsdc) => {
  for (const body of bodies) {
    const correctTier = classifyTier(body.costBasis, baseSizeUsdc);
    if (correctTier.name !== body.tier) {
      const oldEmoji = getTierConfig(body.tier).emoji;
      body.tier = correctTier.name;
      console.log(`⬆️ Body ${body.id.slice(-8)} reclassified: ${oldEmoji} → ${correctTier.emoji} ${correctTier.name}`);
    }
  }
  return bodies;
};

/**
 * Update legacy aggregate fields from bodies for backward compatibility
 * @param {Object} positionState - Position state to update
 * @param {CelestialBody[]} bodies - All celestial bodies
 */
const syncPositionState = (positionState, bodies) => {
  let totalBTC = 0;
  let totalCostBasis = 0;
  let btcOnOrder = 0;

  for (const body of bodies) {
    totalBTC += body.btcQty;
    totalCostBasis += body.costBasis;
    btcOnOrder += body.btcOnOrder;
  }

  positionState.totalBTC = roundBTC(totalBTC);
  positionState.totalCostBasis = roundUSDC(totalCostBasis);
  positionState.avgCostBasis = totalBTC > 0 ? totalCostBasis / totalBTC : 0;
  positionState.btcOnOrder = roundBTC(btcOnOrder);
};

/**
 * Migrate old core+satellite state to celestial bodies
 * @param {Object} positionState - Old position state
 * @param {number} baseSizeUsdc - Base order size
 * @returns {CelestialBody[]} Migrated bodies
 */
const migrateFromLegacy = (positionState, baseSizeUsdc) => {
  const bodies = [];

  // Migrate core position if it exists
  if (positionState.totalBTC > 0 && positionState.totalCostBasis > 0) {
    const coreTier = classifyTier(positionState.totalCostBasis, baseSizeUsdc);
    bodies.push({
      id: generateBodyId('core-migration'),
      tier: coreTier.name,
      btcQty: positionState.totalBTC,
      costBasis: positionState.totalCostBasis,
      avgPrice: positionState.avgCostBasis || (positionState.totalCostBasis / positionState.totalBTC),
      tpOrderId: positionState.activeTpOrderId || null,
      tpPrice: positionState.lastTpPrice || 0,
      btcOnOrder: positionState.btcOnOrder || 0,
      createdAt: positionState.lastEntryTime || Date.now(),
      lastMergedAt: Date.now(),
      sourceOrderIds: ['core-migration'],
      mergeCount: 0,
    });
  }

  // Migrate satellites
  const satellites = positionState.satelliteTpOrders || [];
  for (const sat of satellites) {
    const satTier = classifyTier(sat.costBasis, baseSizeUsdc);
    bodies.push({
      id: generateBodyId(sat.orderId || 'sat-migration'),
      tier: satTier.name,
      btcQty: sat.btcQty,
      costBasis: sat.costBasis,
      avgPrice: sat.avgPrice,
      tpOrderId: sat.tpOrderId || null,
      tpPrice: sat.tpPrice || 0,
      btcOnOrder: sat.btcOnOrder || 0,
      createdAt: sat.placedAt || Date.now(),
      lastMergedAt: Date.now(),
      sourceOrderIds: [sat.orderId || 'sat-migration'],
      mergeCount: 0,
    });
  }

  return bodies;
};

/**
 * Create initial celestial state
 * @returns {CelestialState}
 */
const createInitialCelestialState = () => ({
  bodiesCompleted: 0,
  bodiesRealizedPnL: 0,
  bodiesRealizedBtcPnL: 0,
  stateVersion: 1,
});

/**
 * Get a compact tier summary string for logging
 * @param {CelestialBody[]} bodies - All bodies
 * @returns {string} e.g. "S:3 M:1 P:1"
 */
const getTierSummary = (bodies) => {
  const counts = {};
  for (const body of bodies) {
    const tier = getTierConfig(body.tier);
    const key = tier.name[0].toUpperCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
};

/** Tier colors for dashboard display */
const TIER_COLORS = {
  satellite: '#6B7280',   // gray
  moon: '#9CA3AF',        // light gray
  planet: '#3B82F6',      // blue
  sun: '#F59E0B',         // amber
  hypergiant: '#8B5CF6',  // purple
  black_hole: '#EF4444',  // red
};

module.exports = {
  TIERS,
  TIER_COLORS,
  getTierConfig,
  classifyTier,
  generateBodyId,
  createNewBody,
  findMergeTarget,
  mergeIntoBody,
  calculateBodyTpPercent,
  checkPromotions,
  syncPositionState,
  migrateFromLegacy,
  createInitialCelestialState,
  getTierSummary,
};
