/**
 * Pure orbit-layout helpers shared by HierarchicalOrbit (rendering) and the
 * camera framing in cameraFit.js, so the framing can never drift from the
 * radii and grouping the scene actually uses.
 */
import { TIER_RANK, getDynamicOrbitRadius, getBodyVisualExtent } from './celestialConstants.js'

/**
 * Largest-first order: tier rank ascending (higher tier = closer to center),
 * then costBasis descending.
 */
export const sortCelestialBodies = (bodies) =>
  [...bodies].sort((a, b) => {
    const rankDiff = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99)
    if (rankDiff !== 0) return rankDiff
    return b.costBasis - a.costBasis
  })

/**
 * Split a sorted chain into its head, the same-tier siblings that orbit it
 * (the first sibling's tier), and the deeper descendants those siblings pass on.
 */
export const splitOrbitChain = (bodies) => {
  const [current, ...rest] = bodies
  const siblings = []
  const descendants = []
  if (rest.length > 0) {
    const siblingTier = rest[0].tier
    for (const body of rest) {
      if (body.tier === siblingTier) siblings.push(body)
      else descendants.push(body)
    }
  }
  return { current, siblings, descendants }
}

/** Shared orbit radius for a body's siblings (the max, so none overlap). */
export const getSiblingOrbitRadius = (depth, current, siblings, maxUsdcDeployed) =>
  siblings.length > 0
    ? Math.max(...siblings.map(s => getDynamicOrbitRadius(depth + 1, current, s, maxUsdcDeployed)))
    : 0

/**
 * Worst-case distance from a chain head's center to the edge of anything
 * rendered under it. Nested groups orbit at any phase, so each level adds its
 * full orbit radius plus the child's own reach: this is the envelope the
 * system can occupy at any moment of its motion.
 */
const chainReach = (bodies, depth, maxUsdcDeployed) => {
  if (bodies.length === 0) return 0
  const { current, siblings, descendants } = splitOrbitChain(bodies)
  const ownExtent = getBodyVisualExtent(current, maxUsdcDeployed)
  if (siblings.length === 0) return ownExtent
  const childOrbitRadius = getSiblingOrbitRadius(depth, current, siblings, maxUsdcDeployed)
  const deepest = Math.max(...siblings.map((child, i) =>
    chainReach(i === 0 ? [child, ...descendants] : [child], depth + 1, maxUsdcDeployed)))
  return Math.max(ownExtent, childOrbitRadius + deepest)
}

/**
 * Bounding envelope of the whole system around the scene origin: `radius` is
 * the in-plane (XZ) reach, `height` the largest vertical half-extent.
 */
export const getSystemBounds = (bodies, maxUsdcDeployed) => {
  const sorted = sortCelestialBodies(bodies || [])
  return {
    radius: chainReach(sorted, 0, maxUsdcDeployed),
    height: sorted.reduce((max, b) => Math.max(max, getBodyVisualExtent(b, maxUsdcDeployed)), 0),
  }
}
