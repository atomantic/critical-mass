/**
 * Celestial Visualization Constants
 * Tier colors, orbital radii, sizes, speeds for the 3D scene
 */

// Colors per tier (matches TIER_COLORS from src/celestial-hierarchy.js)
export const TIER_COLORS = {
  satellite:  '#6B7280',
  asteroid:   '#92400E',
  moon:       '#9CA3AF',
  planet:     '#3B82F6',
  sun:        '#F59E0B',
  hypergiant: '#8B5CF6',
  nebula:     '#06B6D4',
  galaxy:     '#EC4899',
  black_hole: '#EF4444',
}

// Hot core colors for stellar tiers (white-hot center that triggers bloom)
export const CORE_COLORS = {
  sun:        '#FEF3C7', // warm white
  hypergiant: '#E9D5FF', // lavender white
  nebula:     '#CFFAFE', // cyan white
  galaxy:     '#FCE7F3', // pink white
}

// Emoji per tier
export const TIER_EMOJIS = {
  satellite:  '🛰️',
  asteroid:   '🪨',
  moon:       '🌙',
  planet:     '🪐',
  sun:        '☀️',
  hypergiant: '💫',
  nebula:     '✨',
  galaxy:     '🌌',
  black_hole: '🕳️',
}

// Orbital radius per tier (higher tiers closer to center)
// black_hole is stationary at center (radius 0), everything orbits it
export const ORBITAL_RADII = {
  black_hole: 0,
  galaxy:     1.5,
  nebula:     2.5,
  hypergiant: 3.5,
  sun:        5,
  planet:     6.5,
  moon:       8,
  asteroid:   9.5,
  satellite:  11,
}

// Orbital speed multiplier (satellites fastest, higher tiers slower)
export const ORBITAL_SPEEDS = {
  black_hole: 0,
  galaxy:     0.015,
  nebula:     0.025,
  hypergiant: 0.035,
  sun:        0.05,
  planet:     0.08,
  moon:       0.12,
  asteroid:   0.16,
  satellite:  0.2,
}

// Glow intensity per tier
export const GLOW_INTENSITY = {
  satellite:  0.3,
  asteroid:   0.2,
  moon:       0.4,
  planet:     0.6,
  sun:        1.0,
  hypergiant: 1.4,
  nebula:     1.5,
  galaxy:     1.6,
  black_hole: 2.0,
}

// Minimum halo opacity floor so every body remains legible against the dark background
export const MIN_GLOW_OPACITY = {
  satellite:  0.08,
  asteroid:   0.1,
  moon:       0.08,
  planet:     0.1,
  sun:        0.14,
  hypergiant: 0.16,
  nebula:     0.16,
  galaxy:     0.18,
  black_hole: 0.16,
}

// Emissive intensity per tier (used for rocky/cold bodies)
export const EMISSIVE_INTENSITY = {
  satellite:  0.2,
  asteroid:   0.15,
  moon:       0.3,
  planet:     0.5,
  sun:        0.8,
  hypergiant: 1.0,
  nebula:     1.1,
  galaxy:     1.2,
  black_hole: 0.1,
}

// Ring (orbital path) opacity per tier
export const RING_OPACITY = {
  satellite:  0.08,
  asteroid:   0.08,
  moon:       0.1,
  planet:     0.12,
  sun:        0.15,
  hypergiant: 0.18,
  nebula:     0.18,
  galaxy:     0.2,
  black_hole: 0,
}

// Tiers that render as stellar bodies (bright core + corona, triggers bloom)
export const STELLAR_TIERS = new Set(['sun', 'hypergiant'])

// Base body scale — sqrt curve from percentage of max capital, range [0.15, 2.0]
export const BASE_BODY_SCALE = 0.15

/**
 * Calculate body visual size from percentage of max capital
 * @param {number} costBasis
 * @param {number} maxUsdcDeployed
 * @returns {number}
 */
export const getBodySize = (costBasis, maxUsdcDeployed) => {
  const pct = maxUsdcDeployed > 0 ? (costBasis || 0) / maxUsdcDeployed : 0
  const raw = BASE_BODY_SCALE + Math.sqrt(pct) * (2.0 - BASE_BODY_SCALE)
  return Math.min(raw, 2.0)
}

// Tier ordering for legend display (center outward)
export const TIER_ORDER = ['black_hole', 'galaxy', 'nebula', 'hypergiant', 'sun', 'planet', 'moon', 'asteroid', 'satellite']

// Tier rank lookup (lower = higher rank = closer to center in hierarchy)
export const TIER_RANK = Object.fromEntries(TIER_ORDER.map((t, i) => [t, i]))

// Hierarchical orbital radius by depth (parent→child distance)
// Decreases with depth to keep the system compact
const HIERARCHICAL_RADII = [0, 3.0, 2.4, 2.0, 1.7, 1.5, 1.3, 1.2, 1.1]

export const getHierarchicalRadius = (depth) => {
  if (depth <= 0) return 0
  return HIERARCHICAL_RADII[Math.min(depth, HIERARCHICAL_RADII.length - 1)]
}

// Minimum gap between body surfaces on orbital paths
const MIN_ORBIT_GAP = 0.8

// Visual extent multiplier per tier (accounts for glow halo + bloom bleed)
// Stellar bodies bloom heavily so they appear much larger than their geometry
const VISUAL_EXTENT_SCALE = {
  satellite:  2.0,
  asteroid:   1.3,
  moon:       1.4,
  planet:     1.5,
  sun:        2.2,
  hypergiant: 2.5,
  nebula:     3.0, // diffuse gas cloud
  galaxy:     3.5, // spiral arms extend far
  black_hole: 2.5, // tighter accretion disk
}

/**
 * Get the visual extent (effective radius) of a body including glow/rings/bloom.
 * Used to prevent orbit overlaps.
 */
export const getBodyVisualExtent = (body, maxUsdcDeployed) => {
  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  // Planets with rings extend to size * 2.0
  if (body.tier === 'planet' && body.mergeCount > 2) return size * 2.0
  const scale = VISUAL_EXTENT_SCALE[body.tier] || 1.4
  return size * scale
}

/**
 * Dynamic orbit radius that ensures the child body stays visually outside the parent.
 * Returns the larger of the default hierarchical radius or the minimum needed to avoid overlap.
 */
export const getDynamicOrbitRadius = (depth, parentBody, childBody, maxUsdcDeployed) => {
  if (depth <= 0) return 0
  const baseRadius = getHierarchicalRadius(depth)
  const parentExtent = getBodyVisualExtent(parentBody, maxUsdcDeployed)
  const childExtent = getBodyVisualExtent(childBody, maxUsdcDeployed)
  const minRadius = parentExtent + childExtent + MIN_ORBIT_GAP
  return Math.max(baseRadius, minRadius)
}

// Hierarchical orbital speed by depth (deeper/smaller bodies orbit faster)
const HIERARCHICAL_SPEEDS = [0, 0.03, 0.05, 0.08, 0.12, 0.16, 0.20, 0.23, 0.26]

export const getHierarchicalSpeed = (depth) => {
  if (depth <= 0) return 0
  return HIERARCHICAL_SPEEDS[Math.min(depth, HIERARCHICAL_SPEEDS.length - 1)]
}

// Tiers that get their own standalone body component (particle-based or complex geometry)
// Everything else routes through CelestialBody
export const STANDALONE_TIERS = new Set(['black_hole', 'galaxy', 'nebula'])

// Shared memo comparator for body components
export const bodyPropsEqual = (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.showTooltip === next.showTooltip &&
  prev.maxUsdcDeployed === next.maxUsdcDeployed &&
  prev.baseCurrency === next.baseCurrency

// Tier descriptions for the showcase page
export const TIER_DESCRIPTIONS = {
  satellite:  'Smallest positions. Man-made objects orbiting at the edge of the system.',
  asteroid:   'Small rocky bodies. Natural formations just beginning to accrete mass.',
  moon:       'Rocky natural satellites with cratered surfaces. Growing in gravitational pull.',
  planet:     'Mid-tier bodies with atmospheres. Merged planets develop Saturn-like rings.',
  sun:        'Stellar bodies with solar corona and flares. Significant capital concentration.',
  hypergiant: 'Massive stellar bodies with gas bands. Among the largest individual positions.',
  nebula:     'Vast clouds of luminous gas and dust. Transitional structures bridging stars and galaxies.',
  galaxy:     'Spiral arm particle systems. Enormous capital structures with billions of stars.',
  black_hole: 'The gravitational center of the system. Maximum capital concentration.',
}
