// @ts-check
/**
 * Celestial Hierarchy
 *
 * Multi-tier position management for celestial body system.
 * Every buy starts as the smallest tier (satellite). Bodies consolidate
 * within tiers when price-close, and promote to higher tiers as mass grows.
 *
 * Tiers: satellite < moon < planet < sun < hypergiant < galaxy < black_hole
 *
 * Pure logic, no I/O.
 */

const { roundBTC, roundUSDC } = require('./volatility-utils');

/**
 * @typedef {Object} CelestialTier
 * @property {string} name - Tier name
 * @property {string} emoji - Display emoji
 * @property {number} minPct - Minimum % of maxUsdcDeployed
 * @property {number} maxPct - Maximum % of maxUsdcDeployed (Infinity for top tier)
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
  { name: 'satellite',  emoji: '🛰️', minPct: 0,   maxPct: 2,        tpMult: 1.0, tpMaxScale: 1.0,  proximity: 0.5, holdbackScale: 1.00 },
  { name: 'moon',       emoji: '🌙',  minPct: 2,   maxPct: 5,        tpMult: 1.2, tpMaxScale: 1.5,  proximity: 0.8, holdbackScale: 1.05 },
  { name: 'planet',     emoji: '🪐',  minPct: 5,   maxPct: 15,       tpMult: 1.5, tpMaxScale: 2.0,  proximity: 1.5, holdbackScale: 1.10 },
  { name: 'sun',        emoji: '☀️',  minPct: 15,  maxPct: 30,       tpMult: 2.0, tpMaxScale: 3.0,  proximity: 2.0, holdbackScale: 1.15 },
  { name: 'hypergiant', emoji: '💫',  minPct: 30,  maxPct: 50,       tpMult: 3.0, tpMaxScale: 5.0,  proximity: 3.0, holdbackScale: 1.20 },
  { name: 'galaxy',     emoji: '🌌',  minPct: 50,  maxPct: 75,       tpMult: 4.0, tpMaxScale: 8.0,  proximity: 3.5, holdbackScale: 1.22 },
  { name: 'black_hole', emoji: '🕳️', minPct: 75,  maxPct: Infinity,  tpMult: 5.0, tpMaxScale: 10.0, proximity: 4.0, holdbackScale: 1.25 },
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
 * Classify which tier a body belongs to based on % of max capital
 * @param {number} costBasis - Total cost basis in USD
 * @param {number} maxUsdcDeployed - Maximum capital deployed
 * @returns {CelestialTier}
 */
const classifyTier = (costBasis, maxUsdcDeployed) => {
  const pct = maxUsdcDeployed > 0 ? (costBasis / maxUsdcDeployed) * 100 : 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (pct >= TIERS[i].minPct) return TIERS[i];
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
 * Create a new celestial body from a buy fill (starts at satellite tier)
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
    buyOrders: [{
      orderId: buyOrderId,
      price: newBuy.avgPrice,
      btcQty,
      sizeUsdc: costBasis,
      filledAt: Date.now(),
    }],
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
 * @param {number} maxUsdcDeployed - Maximum capital deployed (unused, kept for call-site consistency)
 * @param {number} candidateTpPrice - What TP price the new buy would get
 * @param {number} maxBodies - Maximum allowed bodies
 * @returns {CelestialBody|null}
 */
const findMergeTarget = (bodies, newBuy, maxUsdcDeployed, candidateTpPrice, maxBodies, pendingOrderCount, maxOpenOrders) => {
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
    // No body has a TP — pick the one with highest cost basis as merge target
    return closest || bodies.reduce((best, b) => b.costBasis > best.costBasis ? b : best, bodies[0]);
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
 * @param {number} maxUsdcDeployed - Maximum capital deployed
 * @param {string} buyOrderId - Order ID from the buy
 * @returns {CelestialBody} Updated body (mutated in place)
 */
const mergeIntoBody = (target, newBuy, maxUsdcDeployed, buyOrderId) => {
  const newBtcQty = newBuy.btcQty || newBuy.totalSize;
  const newCost = newBuy.costBasis || (newBuy.totalValue + (newBuy.totalFees || 0));
  const orderId = buyOrderId || newBuy.buyOrderId;

  target.btcQty = roundBTC(target.btcQty + newBtcQty);
  target.costBasis = roundUSDC(target.costBasis + newCost);
  target.avgPrice = target.btcQty > 0 ? target.costBasis / target.btcQty : 0;
  target.lastMergedAt = Date.now();
  if (orderId) target.sourceOrderIds.push(orderId);
  if (!target.buyOrders) target.buyOrders = [];
  if (orderId) {
    target.buyOrders.push({
      orderId,
      price: newBuy.avgPrice,
      btcQty: newBtcQty,
      sizeUsdc: newCost,
      filledAt: Date.now(),
    });
  }
  target.mergeCount += 1;

  // Check promotion
  const newTier = classifyTier(target.costBasis, maxUsdcDeployed);
  if (newTier.name !== target.tier) {
    const oldTier = target.tier;
    target.tier = newTier.name;
    const pct = maxUsdcDeployed > 0 ? ((target.costBasis / maxUsdcDeployed) * 100).toFixed(1) : '0';
    console.log(`⬆️ Body ${target.id.slice(-8)} promoted: ${getTierConfig(oldTier).emoji} ${oldTier} → ${newTier.emoji} ${newTier.name} (${pct}% of capital, $${target.costBasis.toFixed(0)})`);
  }

  return target;
};

/**
 * Merge two existing bodies (manual roll-up). Pure data, no I/O.
 * Combines quantities, costs, orders; clears TP fields (caller re-places).
 * Preserves target's id and createdAt.
 * @param {CelestialBody} target - Body to merge INTO (higher TP)
 * @param {CelestialBody} source - Body being absorbed (lower TP)
 * @param {number} maxUsdcDeployed - For tier reclassification
 * @returns {CelestialBody} Mutated target
 */
const mergeBodies = (target, source, maxUsdcDeployed) => {
  target.btcQty = roundBTC(target.btcQty + source.btcQty);
  target.costBasis = roundUSDC(target.costBasis + source.costBasis);
  target.avgPrice = target.btcQty > 0 ? target.costBasis / target.btcQty : 0;
  target.lastMergedAt = Date.now();
  target.sourceOrderIds = [...target.sourceOrderIds, ...source.sourceOrderIds];
  target.buyOrders = [...(target.buyOrders || []), ...(source.buyOrders || [])];
  target.mergeCount += 1 + (source.mergeCount || 0);

  // Clear TP fields — caller cancels both TPs and re-places via placeBodyTp
  target.tpOrderId = null;
  target.tpPrice = 0;
  target.btcOnOrder = 0;

  // Check tier promotion
  const newTier = classifyTier(target.costBasis, maxUsdcDeployed);
  if (newTier.name !== target.tier) {
    const oldTier = target.tier;
    target.tier = newTier.name;
    const pct = maxUsdcDeployed > 0 ? ((target.costBasis / maxUsdcDeployed) * 100).toFixed(1) : '0';
    console.log(`⬆️ Body ${target.id.slice(-8)} promoted: ${getTierConfig(oldTier).emoji} ${oldTier} → ${newTier.emoji} ${newTier.name} (${pct}% of capital, $${target.costBasis.toFixed(0)})`);
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
 * @param {number} maxUsdcDeployed - Maximum capital deployed
 * @returns {CelestialBody[]} Bodies with updated tiers
 */
const checkPromotions = (bodies, maxUsdcDeployed) => {
  for (const body of bodies) {
    const correctTier = classifyTier(body.costBasis, maxUsdcDeployed);
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
 * @param {number} maxUsdcDeployed - Maximum capital deployed
 * @returns {CelestialBody[]} Migrated bodies
 */
const migrateFromLegacy = (positionState, maxUsdcDeployed) => {
  const bodies = [];

  // Migrate core position if it exists
  if (positionState.totalBTC > 0 && positionState.totalCostBasis > 0) {
    const coreTier = classifyTier(positionState.totalCostBasis, maxUsdcDeployed);
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
      buyOrders: [],
      mergeCount: 0,
    });
  }

  // Migrate satellites
  const satellites = positionState.satelliteTpOrders || [];
  for (const sat of satellites) {
    const satTier = classifyTier(sat.costBasis, maxUsdcDeployed);
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
      buyOrders: [{
        orderId: sat.orderId || 'sat-migration',
        price: sat.avgPrice,
        btcQty: sat.btcQty,
        sizeUsdc: sat.costBasis,
        filledAt: sat.placedAt || Date.now(),
      }],
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
const TIER_ABBREV = { satellite: 'Sat', moon: 'M', planet: 'P', sun: 'Sun', hypergiant: 'HG', galaxy: 'G', black_hole: 'BH' };

const getTierSummary = (bodies) => {
  const counts = {};
  for (const body of bodies) {
    const key = TIER_ABBREV[body.tier] || body.tier[0].toUpperCase();
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
  galaxy: '#EC4899',      // pink
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
  mergeBodies,
  calculateBodyTpPercent,
  checkPromotions,
  syncPositionState,
  migrateFromLegacy,
  createInitialCelestialState,
  getTierSummary,
};
