import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getPlanetTexture } from './planetTexture'
import FresnelGlow from './FresnelGlow'

/**
 * Planet with fresnel atmosphere glow and Saturn-like rings for merged bodies.
 */
const PlanetGeometry = ({ size, color, emissiveInt, mergeCount = 0 }) => {
  const atmosphereRingRef = useRef()
  const texture = useMemo(() => getPlanetTexture(), [])
  const hasRings = mergeCount > 2

  useFrame((state) => {
    if (atmosphereRingRef.current) {
      atmosphereRingRef.current.material.opacity = 0.28 + Math.sin(state.clock.elapsedTime * 1.2) * 0.05
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshStandardMaterial
          map={texture}
          color={color}
          emissive="#60A5FA"
          emissiveIntensity={emissiveInt * 0.9}
          roughness={0.5}
          metalness={0.2}
        />
      </mesh>

      {/* Atmospheric limb glow — brightest at the surface, fading outward */}
      <FresnelGlow size={size} scale={1.18} color="#60A5FA" power={2.8} intensity={0.85} pulse={0.12} pulseSpeed={0.8} />

      <mesh ref={atmosphereRingRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.08]}>
        <ringGeometry args={[size * 1.08, size * 1.16, 96]} />
        <meshBasicMaterial color="#93C5FD" transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>

      {hasRings && (
        <group rotation={[Math.PI / 3, 0, 0]}>
          <mesh>
            <ringGeometry args={[size * 1.3, size * 1.6, 64]} />
            <meshBasicMaterial color="#60A5FA" transparent opacity={0.34} side={THREE.DoubleSide} />
          </mesh>
          {/* Cassini division gap */}
          <mesh>
            <ringGeometry args={[size * 1.6, size * 1.65, 64]} />
            <meshBasicMaterial color="#000000" transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
          <mesh>
            <ringGeometry args={[size * 1.65, size * 2.0, 64]} />
            <meshBasicMaterial color="#3B82F6" transparent opacity={0.2} side={THREE.DoubleSide} />
          </mesh>
          <mesh>
            <ringGeometry args={[size * 1.28, size * 2.02, 96]} />
            <meshBasicMaterial color="#93C5FD" transparent opacity={0.16} side={THREE.DoubleSide} wireframe />
          </mesh>
        </group>
      )}
    </group>
  )
}

export default PlanetGeometry
