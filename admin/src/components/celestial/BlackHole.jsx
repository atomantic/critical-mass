import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize, bodyPropsEqual } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

/**
 * Black hole - stationary at the center of the system
 * True black void core with thin near-horizontal accretion disk,
 * photon ring, and gravitational lensing glow.
 * Tooltip is pinned by parent (stays on last-hovered body)
 */
const BlackHole = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const diskRef = useRef()
  const outerGlowRef = useRef()
  const photonRingRef = useRef()
  const photonRingOuterRef = useRef()
  const lensRingRef = useRef()
  const diskWireRef = useRef()

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
      photonRingRef.current.material.opacity = 0.6 + Math.sin(time * 3) * 0.12
    }
    if (photonRingOuterRef.current) {
      photonRingOuterRef.current.material.opacity = 0.32 + Math.sin(time * 2.2 + 0.8) * 0.08
    }

    // Pulse the outer glow
    if (outerGlowRef.current) {
      const pulse = hasTP ? 0.1 : 0.045 + Math.sin(time * 1.5) * 0.02
      outerGlowRef.current.material.opacity = pulse
    }
    if (lensRingRef.current) {
      lensRingRef.current.rotation.z -= 0.0012
      lensRingRef.current.material.opacity = 0.18 + Math.sin(time * 1.8) * 0.04
    }
    if (diskWireRef.current) {
      diskWireRef.current.rotation.z += 0.0015
      diskWireRef.current.material.opacity = 0.16 + Math.sin(time * 1.4 + 1) * 0.03
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

      {/* Photon ring — bright thin ring hugging the event horizon */}
      <mesh ref={photonRingRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.04, size * 1.1, 128]} />
        <meshBasicMaterial
          color="#FFF7ED"
          transparent
          opacity={0.72}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh ref={photonRingOuterRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.11, size * 1.18, 128]} />
        <meshBasicMaterial
          color="#FDE68A"
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Inner accretion disk — hot bright band just outside photon ring */}
      <mesh rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.12, size * 1.35, 96]} />
        <meshBasicMaterial
          color="#FBBF24"
          transparent
          opacity={0.28}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Outer accretion disk — rotating, tighter */}
      <mesh ref={diskRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.35, size * 1.72, 96]} />
        <meshBasicMaterial
          color="#F97316"
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh ref={diskWireRef} rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.38, size * 1.74, 24, 1]} />
        <meshBasicMaterial
          color="#FB923C"
          transparent
          opacity={0.16}
          side={THREE.DoubleSide}
          wireframe
        />
      </mesh>

      {/* Faint outermost disk edge */}
      <mesh rotation={[diskTilt, 0, 0]}>
        <ringGeometry args={[size * 1.8, size * 2.2, 64]} />
        <meshBasicMaterial
          color="#7C2D12"
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh ref={lensRingRef} rotation={[Math.PI * 0.56, 0, Math.PI * 0.12]}>
        <ringGeometry args={[size * 1.95, size * 2.08, 96]} />
        <meshBasicMaterial
          color="#FCA5A5"
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Gravitational lensing glow — tight around event horizon */}
      <mesh ref={outerGlowRef} scale={1.6}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color="#991B1B"
          transparent
          opacity={0.08}
          side={THREE.BackSide}
        />
      </mesh>

      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, bodyPropsEqual)

BlackHole.displayName = 'BlackHole'

export default BlackHole
