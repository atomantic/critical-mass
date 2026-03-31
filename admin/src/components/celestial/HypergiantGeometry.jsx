import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getHypergiantTexture } from './hypergiantTexture'

/**
 * Hypergiant-specific mesh: sphere with Jupiter-like gas band texture.
 * Uses MeshBasicMaterial (unlit) so bloom can handle the glow.
 */
const HypergiantGeometry = ({ size }) => {
  const bandRef = useRef()
  const outerBandRef = useRef()
  const shellRef = useRef()
  const texture = useMemo(() => getHypergiantTexture(), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (bandRef.current) {
      bandRef.current.rotation.z += 0.0012
      bandRef.current.material.opacity = 0.26 + Math.sin(time * 1.9) * 0.04
    }
    if (outerBandRef.current) {
      outerBandRef.current.rotation.z -= 0.0009
      outerBandRef.current.material.opacity = 0.16 + Math.sin(time * 1.4 + 0.8) * 0.03
    }
    if (shellRef.current) {
      shellRef.current.rotation.y += 0.0007
      shellRef.current.material.opacity = 0.08 + Math.sin(time * 1.1) * 0.02
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial map={texture} color="#F5D0FE" />
      </mesh>

      <mesh scale={0.82}>
        <sphereGeometry args={[size, 20, 20]} />
        <meshBasicMaterial color="#FAE8FF" transparent opacity={0.42} />
      </mesh>

      <mesh ref={shellRef} scale={1.02}>
        <sphereGeometry args={[size, 18, 18]} />
        <meshBasicMaterial
          color="#C084FC"
          wireframe
          transparent
          opacity={0.08}
        />
      </mesh>

      <mesh ref={bandRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.12]}>
        <ringGeometry args={[size * 1.02, size * 1.12, 96]} />
        <meshBasicMaterial color="#E879F9" transparent opacity={0.26} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={outerBandRef} rotation={[Math.PI * 0.24, 0, -Math.PI * 0.16]}>
        <ringGeometry args={[size * 1.16, size * 1.28, 96]} />
        <meshBasicMaterial color="#A78BFA" transparent opacity={0.16} side={THREE.DoubleSide} />
      </mesh>

      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[size * 1.3, size * 1.62, 14, 1]} />
        <meshBasicMaterial color="#C084FC" transparent opacity={0.12} side={THREE.DoubleSide} wireframe />
      </mesh>
    </group>
  )
}

export default HypergiantGeometry
