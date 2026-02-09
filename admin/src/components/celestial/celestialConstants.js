/**
 * Celestial Visualization Constants
 * Tier colors, orbital radii, sizes, speeds for the 3D scene
 */

// Colors per tier (matches TIER_COLORS from src/celestial-hierarchy.js)
export const TIER_COLORS = {
  satellite:  '#6B7280',
  moon:       '#9CA3AF',
  planet:     '#3B82F6',
  sun:        '#F59E0B',
  hypergiant: '#8B5CF6',
  galaxy:     '#EC4899',
  black_hole: '#EF4444',
}

// Hot core colors for stellar tiers (white-hot center that triggers bloom)
export const CORE_COLORS = {
  sun:        '#FEF3C7', // warm white
  hypergiant: '#E9D5FF', // lavender white
  galaxy:     '#FCE7F3', // pink white
}

// Emoji per tier
export const TIER_EMOJIS = {
  satellite:  '🛰️',
  moon:       '🌙',
  planet:     '🪐',
  sun:        '☀️',
  hypergiant: '💫',
  galaxy:     '🌌',
  black_hole: '🕳️',
}

// Orbital radius per tier (higher tiers closer to center)
// black_hole is stationary at center (radius 0), everything orbits it
export const ORBITAL_RADII = {
  black_hole: 0,
  galaxy:     1.5,
  hypergiant: 3,
  sun:        4.5,
  planet:     6,
  moon:       7.5,
  satellite:  9,
}

// Orbital speed multiplier (satellites fastest, higher tiers slower)
export const ORBITAL_SPEEDS = {
  black_hole: 0,
  galaxy:     0.015,
  hypergiant: 0.03,
  sun:        0.05,
  planet:     0.08,
  moon:       0.14,
  satellite:  0.2,
}

// Glow intensity per tier
export const GLOW_INTENSITY = {
  satellite:  0.3,
  moon:       0.4,
  planet:     0.6,
  sun:        1.0,
  hypergiant: 1.4,
  galaxy:     1.6,
  black_hole: 2.0,
}

// Emissive intensity per tier (used for rocky/cold bodies)
export const EMISSIVE_INTENSITY = {
  satellite:  0.2,
  moon:       0.3,
  planet:     0.5,
  sun:        0.8,
  hypergiant: 1.0,
  galaxy:     1.2,
  black_hole: 0.1,
}

// Ring (orbital path) opacity per tier
export const RING_OPACITY = {
  satellite:  0.08,
  moon:       0.1,
  planet:     0.12,
  sun:        0.15,
  hypergiant: 0.18,
  galaxy:     0.2,
  black_hole: 0,
}

// Tiers that render as stellar bodies (bright core + corona, triggers bloom)
export const STELLAR_TIERS = new Set(['sun', 'hypergiant', 'galaxy'])

// Base body scale, computed as: baseScale * (1 + log2(1 + costBasis/50)), capped at 2.0
export const BASE_BODY_SCALE = 0.15

/**
 * Calculate body visual size from costBasis
 * @param {number} costBasis
 * @returns {number}
 */
export const getBodySize = (costBasis) => {
  const raw = BASE_BODY_SCALE * (1 + Math.log2(1 + (costBasis || 0) / 50))
  return Math.min(raw, 2.0)
}

// Tier ordering for legend display (center outward)
export const TIER_ORDER = ['black_hole', 'galaxy', 'hypergiant', 'sun', 'planet', 'moon', 'satellite']

// Tier rank lookup (lower = higher rank = closer to center in hierarchy)
export const TIER_RANK = Object.fromEntries(TIER_ORDER.map((t, i) => [t, i]))

// Hierarchical orbital radius by depth (parent→child distance)
// Decreases with depth to keep the system compact
const HIERARCHICAL_RADII = [0, 3.0, 2.4, 2.0, 1.7, 1.5, 1.3]

export const getHierarchicalRadius = (depth) => {
  if (depth <= 0) return 0
  return HIERARCHICAL_RADII[Math.min(depth, HIERARCHICAL_RADII.length - 1)]
}

// Minimum gap between body surfaces on orbital paths
const MIN_ORBIT_GAP = 0.5

/**
 * Get the visual extent (effective radius) of a body including glow/rings.
 * Used to prevent orbit overlaps.
 */
export const getBodyVisualExtent = (body) => {
  const size = getBodySize(body.costBasis)
  // Planets with rings extend to size * 2.0
  if (body.tier === 'planet' && body.mergeCount > 2) return size * 2.0
  // Glow halo: 1.3x for stellar, 1.4x for rocky
  const glowScale = STELLAR_TIERS.has(body.tier) ? 1.3 : 1.4
  return size * glowScale
}

/**
 * Dynamic orbit radius that ensures the child body stays visually outside the parent.
 * Returns the larger of the default hierarchical radius or the minimum needed to avoid overlap.
 */
export const getDynamicOrbitRadius = (depth, parentBody, childBody) => {
  if (depth <= 0) return 0
  const baseRadius = getHierarchicalRadius(depth)
  const parentExtent = getBodyVisualExtent(parentBody)
  const childExtent = getBodyVisualExtent(childBody)
  const minRadius = parentExtent + childExtent + MIN_ORBIT_GAP
  return Math.max(baseRadius, minRadius)
}

// Hierarchical orbital speed by depth (deeper/smaller bodies orbit faster)
const HIERARCHICAL_SPEEDS = [0, 0.03, 0.05, 0.08, 0.12, 0.16, 0.20]

export const getHierarchicalSpeed = (depth) => {
  if (depth <= 0) return 0
  return HIERARCHICAL_SPEEDS[Math.min(depth, HIERARCHICAL_SPEEDS.length - 1)]
}
