import { useRef, useState, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { TIER_COLORS, ORBITAL_RADII, ORBITAL_SPEEDS, GLOW_INTENSITY, EMISSIVE_INTENSITY, getBodySize } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const _lerpTarget = new THREE.Vector3()

/**
 * Individual celestial body - sphere + glow + optional merge ring + tooltip on hover
 */
const CelestialBody = memo(({ body, index, totalInTier }) => {
  const meshRef = useRef()
  const glowRef = useRef()
  const groupRef = useRef()
  const [hovered, setHovered] = useState(false)

  const color = TIER_COLORS[body.tier] || TIER_COLORS.satellite
  const targetRadius = ORBITAL_RADII[body.tier] || ORBITAL_RADII.satellite
  const speed = ORBITAL_SPEEDS[body.tier] || ORBITAL_SPEEDS.satellite
  const glowInt = GLOW_INTENSITY[body.tier] || 0.3
  const emissiveInt = EMISSIVE_INTENSITY[body.tier] || 0.2
  const size = getBodySize(body.costBasis)
  const hasTP = body.tpPrice > 0

  // Offset angle so multiple bodies in same tier don't overlap
  const angleOffset = totalInTier > 1 ? (index / totalInTier) * Math.PI * 2 : 0

  useFrame((state) => {
    if (!groupRef.current) return

    const time = state.clock.elapsedTime
    const angle = time * speed + angleOffset

    // Smoothly lerp radius for tier promotion transitions
    const currentPos = groupRef.current.position
    const currentRadius = Math.sqrt(currentPos.x * currentPos.x + currentPos.z * currentPos.z)
    const lerpedRadius = THREE.MathUtils.lerp(currentRadius || targetRadius, targetRadius, 0.02)

    _lerpTarget.set(
      Math.cos(angle) * lerpedRadius,
      0,
      Math.sin(angle) * lerpedRadius
    )
    groupRef.current.position.lerp(_lerpTarget, 0.1)

    // Pulse glow for bodies without TP
    if (glowRef.current) {
      if (!hasTP) {
        glowRef.current.material.opacity = 0.1 + Math.sin(time * 2) * 0.05
      } else {
        glowRef.current.material.opacity = glowInt * 0.3
      }
    }

    // Slow self-rotation
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.005
    }
  })

  return (
    <group ref={groupRef} position={[targetRadius, 0, 0]}>
      {/* Main body sphere */}
      <mesh
        ref={meshRef}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
        onPointerOut={() => setHovered(false)}
      >
        <sphereGeometry args={[size, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveInt}
          roughness={0.4}
          metalness={0.3}
        />
      </mesh>

      {/* Outer glow halo */}
      <mesh ref={glowRef} scale={1.4}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={glowInt * 0.3}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Saturn-like ring for merged bodies (mergeCount > 2) */}
      {body.mergeCount > 2 && (
        <mesh rotation={[Math.PI / 3, 0, 0]}>
          <ringGeometry args={[size * 1.4, size * 2.0, 32]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.25}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Hover tooltip */}
      {hovered && <CelestialTooltip body={body} position={[0, size + 0.5, 0]} />}
    </group>
  )
}, (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.tier === next.body.tier &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.index === next.index &&
  prev.totalInTier === next.totalInTier
)

CelestialBody.displayName = 'CelestialBody'

export default CelestialBody
