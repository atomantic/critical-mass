import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import CelestialBody from './CelestialBody'
import BlackHole from './BlackHole'
import {
  getHierarchicalRadius, getHierarchicalSpeed,
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
const OrbitingGroup = ({ radius, speed, children }) => {
  const groupRef = useRef()

  useFrame((state) => {
    if (!groupRef.current || radius === 0) return
    const angle = state.clock.elapsedTime * speed
    groupRef.current.position.x = Math.cos(angle) * radius
    groupRef.current.position.z = Math.sin(angle) * radius
  })

  return <group ref={groupRef}>{children}</group>
}

/**
 * Recursive hierarchical orbit system.
 * Bodies must be sorted largest-first. Each body orbits the next-larger body:
 *   body[0] → center (stationary)
 *   body[1] → orbits body[0]
 *   body[2] → orbits body[1]
 *   ...
 * Three.js nested groups handle the compound orbital motion automatically.
 */
const HierarchicalOrbit = ({ bodies, depth = 0, activeBodyId, onBodyHover }) => {
  if (bodies.length === 0) return null

  const [current, ...rest] = bodies
  const radius = getHierarchicalRadius(depth)
  const speed = getHierarchicalSpeed(depth)

  const bodyElement = current.tier === 'black_hole' ? (
    <BlackHole body={current} showTooltip={activeBodyId === current.id} onHover={onBodyHover} />
  ) : (
    <CelestialBody body={current} showTooltip={activeBodyId === current.id} onHover={onBodyHover} />
  )

  return (
    <OrbitingGroup radius={radius} speed={speed}>
      {bodyElement}
      {rest.length > 0 && (
        <ChildOrbitRing radius={getHierarchicalRadius(depth + 1)} tier={rest[0].tier} />
      )}
      {rest.length > 0 && (
        <HierarchicalOrbit
          bodies={rest}
          depth={depth + 1}
          activeBodyId={activeBodyId}
          onBodyHover={onBodyHover}
        />
      )}
    </OrbitingGroup>
  )
}

export default HierarchicalOrbit
