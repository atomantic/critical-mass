// @ts-check
/**
 * Canonical celestial tier table (issue #869).
 *
 * Single source of truth for tier names, capital-percentage boundaries, TP/holdback
 * parameters and display identity (emoji/color/label). Consumed by the engine
 * (src/celestial-hierarchy.js, via require(esm)) and the admin client (Vite).
 * Dependency-free and ESM-only. Visual-only geometry stays client-owned.
 *
 * Tiers are classified by cost basis as a % of maxUsdcDeployed, NOT by multiples
 * of base order size.
 */

/**
 * @typedef {Object} CelestialTier
 * @property {string} name - Stable tier key
 * @property {string} label - Human display name
 * @property {string} emoji - Display emoji
 * @property {string} color - Hex color for dashboards
 * @property {number} minPct - Minimum % of maxUsdcDeployed (inclusive)
 * @property {number} maxPct - Maximum % of maxUsdcDeployed (Infinity for top tier)
 * @property {number} tpMult - TP percentage multiplier
 * @property {number} tpMaxScale - Multiplied against tpMaxPercent for wider ceiling
 * @property {number} proximity - TP price proximity % for within-tier consolidation
 * @property {number} holdbackScale - Multiplied against holdbackRatio
 */

/** @type {CelestialTier[]} */
export const TIERS = [
  { name: 'satellite',  label: 'Satellite',  emoji: '🛰️', color: '#6B7280', minPct: 0,  maxPct: 1,        tpMult: 1.0, tpMaxScale: 1.0,  proximity: 0.5, holdbackScale: 1.00 },
  { name: 'asteroid',   label: 'Asteroid',   emoji: '🪨',  color: '#92400E', minPct: 1,  maxPct: 2,        tpMult: 1.1, tpMaxScale: 1.2,  proximity: 0.6, holdbackScale: 1.02 },
  { name: 'moon',       label: 'Moon',       emoji: '🌙',  color: '#9CA3AF', minPct: 2,  maxPct: 5,        tpMult: 1.2, tpMaxScale: 1.5,  proximity: 0.8, holdbackScale: 1.05 },
  { name: 'planet',     label: 'Planet',     emoji: '🪐',  color: '#3B82F6', minPct: 5,  maxPct: 15,       tpMult: 1.5, tpMaxScale: 2.0,  proximity: 1.5, holdbackScale: 1.10 },
  { name: 'sun',        label: 'Sun',        emoji: '☀️',  color: '#F59E0B', minPct: 15, maxPct: 30,       tpMult: 2.0, tpMaxScale: 3.0,  proximity: 2.0, holdbackScale: 1.15 },
  { name: 'hypergiant', label: 'Hypergiant', emoji: '💫',  color: '#8B5CF6', minPct: 30, maxPct: 40,       tpMult: 3.0, tpMaxScale: 5.0,  proximity: 3.0, holdbackScale: 1.20 },
  { name: 'nebula',     label: 'Nebula',     emoji: '✨',  color: '#06B6D4', minPct: 40, maxPct: 50,       tpMult: 3.5, tpMaxScale: 6.0,  proximity: 3.2, holdbackScale: 1.21 },
  { name: 'galaxy',     label: 'Galaxy',     emoji: '🌌',  color: '#EC4899', minPct: 50, maxPct: 75,       tpMult: 4.0, tpMaxScale: 8.0,  proximity: 3.5, holdbackScale: 1.22 },
  { name: 'black_hole', label: 'Black Hole', emoji: '🕳️', color: '#EF4444', minPct: 75, maxPct: Infinity, tpMult: 5.0, tpMaxScale: 10.0, proximity: 4.0, holdbackScale: 1.25 },
];

/** @param {(t: CelestialTier) => any} pick */
const byName = (pick) => Object.fromEntries(TIERS.map((t) => [t.name, pick(t)]));

export const TIER_COLORS = byName((t) => t.color);
export const TIER_EMOJIS = byName((t) => t.emoji);
export const TIER_HOLDBACK_SCALE = byName((t) => t.holdbackScale);

/** Legend order, center outward (black_hole first). */
export const TIER_ORDER = TIERS.map((t) => t.name).reverse();

/**
 * "30-40%" / "75%+"
 * @param {CelestialTier} tier
 * @returns {string}
 */
export const formatTierPctRange = (tier) =>
  Number.isFinite(tier.maxPct) ? `${tier.minPct}-${tier.maxPct}%` : `${tier.minPct}%+`;

/**
 * Dollar range of a tier for a given deployment cap: "$0-$100" / "$7500+".
 * @param {CelestialTier} tier
 * @param {number} cap - maxUsdcDeployed
 * @returns {string}
 */
export const formatTierCapitalRange = (tier, cap) => {
  const lo = Math.round((cap * tier.minPct) / 100);
  if (!Number.isFinite(tier.maxPct)) return `$${lo}+`;
  return `$${lo}-$${Math.round((cap * tier.maxPct) / 100)}`;
};

/**
 * Tooltip text: "Nebula — 40-50% of max deployed capital".
 * @param {CelestialTier} tier
 * @returns {string}
 */
export const formatTierTooltip = (tier) =>
  `${tier.label} — ${formatTierPctRange(tier)} of max deployed capital`;
