import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getSunTexture } from './sunTexture'

/**
 * Sun-specific geometry: textured sphere with corona layers.
 * Uses MeshBasicMaterial (unlit) so bloom handles the glow.
 */
const SunGeometry = ({ size }) => {
  const coronaRef1 = useRef()
  const coronaRef2 = useRef()
  const texture = useMemo(() => getSunTexture(), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (coronaRef1.current) {
      coronaRef1.current.material.opacity = 0.12 + Math.sin(time * 2) * 0.04
      coronaRef1.current.rotation.y += 0.001
    }
    if (coronaRef2.current) {
      coronaRef2.current.material.opacity = 0.06 + Math.sin(time * 1.3 + 1) * 0.03
      coronaRef2.current.rotation.y -= 0.0008
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial map={texture} />
      </mesh>

      <mesh ref={coronaRef1} scale={1.25}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color="#F59E0B" transparent opacity={0.12} side={THREE.BackSide} />
      </mesh>

      <mesh ref={coronaRef2} scale={1.5}>
        <sphereGeometry args={[size, 12, 12]} />
        <meshBasicMaterial color="#FDE68A" transparent opacity={0.06} side={THREE.BackSide} />
      </mesh>

      <mesh rotation={[Math.PI * 0.4, 0, Math.PI * 0.1]}>
        <ringGeometry args={[size * 1.02, size * 1.08, 64]} />
        <meshBasicMaterial color="#FEF3C7" transparent opacity={0.15} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

export default SunGeometry
