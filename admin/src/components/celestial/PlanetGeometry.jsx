import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getPlanetTexture } from './planetTexture'

/**
 * Planet with atmosphere glow and improved Saturn-like rings for merged bodies.
 */
const PlanetGeometry = ({ size, color, emissiveInt, mergeCount = 0 }) => {
  const atmosphereRef = useRef()
  const atmosphereRingRef = useRef()
  const texture = useMemo(() => getPlanetTexture(), [])
  const hasRings = mergeCount > 2

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (atmosphereRef.current) {
      atmosphereRef.current.material.opacity = 0.12 + Math.sin(time * 0.8) * 0.03
    }
    if (atmosphereRingRef.current) {
      atmosphereRingRef.current.material.opacity = 0.28 + Math.sin(time * 1.2) * 0.05
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

      <mesh ref={atmosphereRef} scale={1.12}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color="#60A5FA" transparent opacity={0.14} side={THREE.BackSide} />
      </mesh>

      <mesh ref={atmosphereRingRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.08]}>
        <ringGeometry args={[size * 1.08, size * 1.16, 96]} />
        <meshBasicMaterial color="#93C5FD" transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>

      <mesh scale={1.018}>
        <sphereGeometry args={[size, 18, 18]} />
        <meshBasicMaterial
          color="#60A5FA"
          wireframe
          transparent
          opacity={0.08}
        />
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
