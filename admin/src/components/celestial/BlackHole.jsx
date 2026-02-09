import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

/**
 * Black hole - stationary at the center of the system
 * Dark core sphere with bright accretion disk and gravitational glow
 * Tooltip is pinned by parent (stays on last-hovered body)
 */
const BlackHole = memo(({ body, showTooltip, onHover, maxUsdcDeployed }) => {
  const diskRef = useRef()
  const outerGlowRef = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed) * 1.2 // Slightly larger than normal
  const hasTP = body.tpPrice > 0

  useFrame((state) => {
    const time = state.clock.elapsedTime

    // Slowly rotate accretion disk
    if (diskRef.current) {
      diskRef.current.rotation.z += 0.003
    }

    // Pulse the outer glow
    if (outerGlowRef.current) {
      const pulse = hasTP ? 0.15 : 0.08 + Math.sin(time * 1.5) * 0.04
      outerGlowRef.current.material.opacity = pulse
    }
  })

  return (
    <group position={[0, 0, 0]}>
      {/* Dark core sphere */}
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size, 32, 32]} />
        <meshStandardMaterial
          color="#0a0a0a"
          emissive="#1a0000"
          emissiveIntensity={0.1}
          roughness={1}
          metalness={0.8}
        />
      </mesh>

      {/* Inner event horizon glow - deep red ring hugging the sphere */}
      <mesh scale={1.15}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial
          color="#EF4444"
          transparent
          opacity={0.08}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Accretion disk - bright rotating ring */}
      <mesh ref={diskRef} rotation={[Math.PI / 2.5, 0, 0]}>
        <ringGeometry args={[size * 1.3, size * 2.5, 64]} />
        <meshBasicMaterial
          color="#F97316"
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Inner accretion disk - hotter/brighter band */}
      <mesh rotation={[Math.PI / 2.5, 0.1, 0]}>
        <ringGeometry args={[size * 1.2, size * 1.6, 64]} />
        <meshBasicMaterial
          color="#FBBF24"
          transparent
          opacity={0.25}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Outer gravitational glow - large diffuse sphere */}
      <mesh ref={outerGlowRef} scale={2.5}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color="#7F1D1D"
          transparent
          opacity={0.15}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Pinned tooltip - stays visible after hover until another body is hovered */}
      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} />}
    </group>
  )
}, (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.showTooltip === next.showTooltip &&
  prev.maxUsdcDeployed === next.maxUsdcDeployed
)

BlackHole.displayName = 'BlackHole'

export default BlackHole
