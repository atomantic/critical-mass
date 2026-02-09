import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  TIER_COLORS, CORE_COLORS, ORBITAL_RADII, ORBITAL_SPEEDS,
  GLOW_INTENSITY, EMISSIVE_INTENSITY, STELLAR_TIERS, getBodySize,
} from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const _lerpTarget = new THREE.Vector3()

/**
 * Individual celestial body with two rendering modes:
 *
 * Rocky bodies (satellite, moon, planet):
 *   MeshStandardMaterial with emissive tint + thin BackSide glow halo
 *
 * Stellar bodies (sun, hypergiant, galaxy):
 *   Bright MeshBasicMaterial (unlit, full brightness → bloom does the glow)
 *   + one thin BackSide halo for color tint. Bloom handles the rest.
 */
const CelestialBody = memo(({ body, index, totalInTier, showTooltip, onHover }) => {
  const meshRef = useRef()
  const glowRef = useRef()
  const groupRef = useRef()

  const color = TIER_COLORS[body.tier] || TIER_COLORS.satellite
  const targetRadius = ORBITAL_RADII[body.tier] || ORBITAL_RADII.satellite
  const speed = ORBITAL_SPEEDS[body.tier] || ORBITAL_SPEEDS.satellite
  const glowInt = GLOW_INTENSITY[body.tier] || 0.3
  const emissiveInt = EMISSIVE_INTENSITY[body.tier] || 0.2
  const size = getBodySize(body.costBasis)
  const hasTP = body.tpPrice > 0
  const isStellar = STELLAR_TIERS.has(body.tier)
  const coreColor = CORE_COLORS[body.tier] || '#ffffff'

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

    // Glow animation
    if (glowRef.current) {
      if (!hasTP) {
        glowRef.current.material.opacity = 0.08 + Math.sin(time * 2) * 0.04
      } else {
        glowRef.current.material.opacity = isStellar ? 0.12 : glowInt * 0.25
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
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size, 24, 24]} />
        {isStellar ? (
          // Stellar: unlit MeshBasicMaterial at full brightness → bloom creates the glow
          <meshBasicMaterial color={coreColor} />
        ) : (
          // Rocky: standard lit material with emissive tint
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveInt}
            roughness={0.4}
            metalness={0.3}
          />
        )}
      </mesh>

      {/* Single thin BackSide glow halo — subtle color tint, bloom does the heavy lifting */}
      <mesh ref={glowRef} scale={isStellar ? 1.3 : 1.4}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.12}
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

      {/* Pinned tooltip - stays visible after hover until another body is hovered */}
      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.5, 0]} />}
    </group>
  )
}, (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.tier === next.body.tier &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.index === next.index &&
  prev.totalInTier === next.totalInTier &&
  prev.showTooltip === next.showTooltip
)

CelestialBody.displayName = 'CelestialBody'

export default CelestialBody
