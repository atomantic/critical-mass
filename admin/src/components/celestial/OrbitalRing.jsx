import { useMemo } from 'react'
import { ORBITAL_RADII, RING_OPACITY, TIER_COLORS } from './celestialConstants'

/**
 * Translucent ring showing orbital path for a tier
 */
const OrbitalRing = ({ tier }) => {
  const radius = ORBITAL_RADII[tier]
  const opacity = RING_OPACITY[tier]
  const color = TIER_COLORS[tier]

  // Don't render ring for black_hole (center) or if no opacity
  if (radius === 0 || !opacity) return null

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

export default OrbitalRing
