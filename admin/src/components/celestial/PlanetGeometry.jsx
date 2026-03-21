import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getPlanetTexture } from './planetTexture'

/**
 * Planet with atmosphere glow and improved Saturn-like rings for merged bodies.
 */
const PlanetGeometry = ({ size, color, emissiveInt, mergeCount = 0 }) => {
  const atmosphereRef = useRef()
  const texture = useMemo(() => getPlanetTexture(), [])
  const hasRings = mergeCount > 2

  useFrame((state) => {
    if (atmosphereRef.current) {
      const time = state.clock.elapsedTime
      atmosphereRef.current.material.opacity = 0.12 + Math.sin(time * 0.8) * 0.03
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshStandardMaterial
          map={texture}
          color={color}
          emissive={color}
          emissiveIntensity={emissiveInt}
          roughness={0.5}
          metalness={0.2}
        />
      </mesh>

      <mesh ref={atmosphereRef} scale={1.12}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color="#60A5FA" transparent opacity={0.12} side={THREE.BackSide} />
      </mesh>

      {hasRings && (
        <group rotation={[Math.PI / 3, 0, 0]}>
          <mesh>
            <ringGeometry args={[size * 1.3, size * 1.6, 64]} />
            <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
          </mesh>
          {/* Cassini division gap */}
          <mesh>
            <ringGeometry args={[size * 1.6, size * 1.65, 64]} />
            <meshBasicMaterial color="#000000" transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
          <mesh>
            <ringGeometry args={[size * 1.65, size * 2.0, 64]} />
            <meshBasicMaterial color={color} transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
    </group>
  )
}

export default PlanetGeometry
