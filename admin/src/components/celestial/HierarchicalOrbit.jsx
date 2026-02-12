import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import CelestialBody from './CelestialBody'
import BlackHole from './BlackHole'
import {
  getDynamicOrbitRadius, getHierarchicalRadius, getHierarchicalSpeed,
  TIER_COLORS, RING_OPACITY,
} from './celestialConstants'

/**
 * Orbital path ring rendered relative to a parent body
 */
const ChildOrbitRing = ({ radius, tier }) => {
  const color = TIER_COLORS[tier] || TIER_COLORS.satellite
  const opacity = RING_OPACITY[tier] || 0.08

  const points = useMemo(() => {
    const segments = 128
    const pts = []
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      pts.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    }
    return new Float32Array(pts)
  }, [radius])

  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={points.length / 3}
          array={points}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

/**
 * Group that orbits its parent at a given radius and speed.
 * Depth 0 (center body) stays stationary.
 */
const OrbitingGroup = ({ radius, speed, angleOffset = 0, children }) => {
  const groupRef = useRef()

  useFrame((state) => {
    if (!groupRef.current || radius === 0) return
    const angle = state.clock.elapsedTime * speed + angleOffset
    groupRef.current.position.x = Math.cos(angle) * radius
    groupRef.current.position.z = Math.sin(angle) * radius
  })

  return <group ref={groupRef}>{children}</group>
}

/**
 * Recursive hierarchical orbit system.
 * Bodies must be sorted largest-first (by tier rank, then costBasis).
 * Same-tier bodies are rendered as siblings orbiting their shared parent
 * with angular offsets, rather than chaining off each other.
 *
 *   body[0] → center (stationary)
 *   Same-tier group after body[0] → all orbit body[0] as siblings
 *   Next tier group → orbits first sibling of previous tier, etc.
 */
const HierarchicalOrbit = ({ bodies, depth = 0, activeBodyId, onBodyHover, parentOrbitRadius, maxUsdcDeployed, angleOffset = 0 }) => {
  if (bodies.length === 0) return null

  const [current, ...rest] = bodies
  // Use parent-computed dynamic radius if provided, otherwise fall back to depth-based
  const radius = parentOrbitRadius ?? getHierarchicalRadius(depth)
  const speed = getHierarchicalSpeed(depth)

  // Separate rest into siblings (same tier as first child) and deeper descendants
  const siblings = []
  const descendants = []
  if (rest.length > 0) {
    const siblingTier = rest[0].tier
    for (const body of rest) {
      if (body.tier === siblingTier) {
        siblings.push(body)
      } else {
        descendants.push(body)
      }
    }
  }

  // Shared orbit radius for siblings (use max to prevent any overlap)
  const childOrbitRadius = siblings.length > 0
    ? Math.max(...siblings.map(s => getDynamicOrbitRadius(depth + 1, current, s, maxUsdcDeployed)))
    : 0

  const bodyElement = current.tier === 'black_hole' ? (
    <BlackHole body={current} showTooltip={activeBodyId === current.id} onHover={onBodyHover} maxUsdcDeployed={maxUsdcDeployed} />
  ) : (
    <CelestialBody body={current} showTooltip={activeBodyId === current.id} onHover={onBodyHover} maxUsdcDeployed={maxUsdcDeployed} />
  )

  return (
    <OrbitingGroup radius={radius} speed={speed} angleOffset={angleOffset}>
      {bodyElement}
      {siblings.length > 0 && (
        <ChildOrbitRing radius={childOrbitRadius} tier={siblings[0].tier} />
      )}
      {siblings.map((child, i) => {
        const childAngleOffset = (i / siblings.length) * Math.PI * 2
        // First sibling carries descendants for further nesting
        const childBodies = i === 0 ? [child, ...descendants] : [child]
        return (
          <HierarchicalOrbit
            key={child.id}
            bodies={childBodies}
            depth={depth + 1}
            activeBodyId={activeBodyId}
            onBodyHover={onBodyHover}
            parentOrbitRadius={childOrbitRadius}
            maxUsdcDeployed={maxUsdcDeployed}
            angleOffset={childAngleOffset}
          />
        )
      })}
    </OrbitingGroup>
  )
}

export default HierarchicalOrbit
