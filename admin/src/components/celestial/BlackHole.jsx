import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

/**
 * Black hole - stationary at the center of the system
 * True black void core with thin near-horizontal accretion disk,
 * photon ring, and gravitational lensing glow.
 * Tooltip is pinned by parent (stays on last-hovered body)
 */
const BlackHole = memo(({ body, showTooltip, onHover, maxUsdcDeployed }) => {
  const diskRef = useRef()
  const outerGlowRef = useRef()
  const photonRingRef = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed) * 1.2
  const hasTP = body.tpPrice > 0

  useFrame((state) => {
    const time = state.clock.elapsedTime

    // Slowly rotate accretion disk
    if (diskRef.current) {
      diskRef.current.rotation.z += 0.002
    }

    // Pulse the photon ring
    if (photonRingRef.current) {
      photonRingRef.current.material.opacity = 0.5 + Math.sin(time * 3) * 0.15
    }

    // Pulse the outer glow
    if (outerGlowRef.current) {
      const pulse = hasTP ? 0.12 : 0.06 + Math.sin(time * 1.5) * 0.03
      outerGlowRef.current.material.opacity = pulse
    }
  })

  // Disk tilt: nearly horizontal with a slight tilt for depth (80° from vertical)
  const diskTilt = Math.PI * 0.44

  return (
    <group position={[0, 0, 0]}>
      {/* Dark void core — true black, absorbs everything */}
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {/* Shadow sphere — slightly larger, ensures the core stays pitch black against bloom */}
      <mesh scale={1.08}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {/* Photon ring — bright thin ring at the event horizon edge */}
      <mesh ref={photonRingRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.08, size * 1.18, 96]} />
        <meshBasicMaterial
          color="#FDE68A"
          transparent
          opacity={0.6}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Inner accretion disk — hot bright band close to the event horizon */}
      <mesh rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.18, size * 1.6, 96]} />
        <meshBasicMaterial
          color="#FBBF24"
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Outer accretion disk — wider, cooler, rotating */}
      <mesh ref={diskRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.6, size * 2.8, 96]} />
        <meshBasicMaterial
          color="#F97316"
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Faint outermost disk halo */}
      <mesh rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 2.8, size * 3.5, 64]} />
        <meshBasicMaterial
          color="#7C2D12"
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Gravitational lensing glow — subtle red-shifted halo */}
      <mesh ref={outerGlowRef} scale={3.0}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color="#7F1D1D"
          transparent
          opacity={0.08}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Pinned tooltip */}
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
