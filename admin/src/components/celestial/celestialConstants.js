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
  black_hole: '#EF4444',
}

// Emoji per tier
export const TIER_EMOJIS = {
  satellite:  '🛰️',
  moon:       '🌙',
  planet:     '🪐',
  sun:        '☀️',
  hypergiant: '💫',
  black_hole: '🕳️',
}

// Orbital radius per tier (higher tiers closer to center)
export const ORBITAL_RADII = {
  black_hole: 0,
  hypergiant: 1.5,
  sun:        3,
  planet:     5,
  moon:       6.5,
  satellite:  8,
}

// Orbital speed multiplier (satellites fastest, higher tiers slower)
export const ORBITAL_SPEEDS = {
  black_hole: 0,
  hypergiant: 0.05,
  sun:        0.1,
  planet:     0.2,
  moon:       0.35,
  satellite:  0.5,
}

// Glow intensity per tier
export const GLOW_INTENSITY = {
  satellite:  0.3,
  moon:       0.4,
  planet:     0.6,
  sun:        1.0,
  hypergiant: 1.2,
  black_hole: 1.5,
}

// Emissive intensity per tier
export const EMISSIVE_INTENSITY = {
  satellite:  0.2,
  moon:       0.3,
  planet:     0.5,
  sun:        0.8,
  hypergiant: 1.0,
  black_hole: 1.2,
}

// Ring (orbital path) opacity per tier
export const RING_OPACITY = {
  satellite:  0.08,
  moon:       0.1,
  planet:     0.12,
  sun:        0.15,
  hypergiant: 0.18,
  black_hole: 0,
}

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

// Tier ordering for legend display
export const TIER_ORDER = ['black_hole', 'hypergiant', 'sun', 'planet', 'moon', 'satellite']
