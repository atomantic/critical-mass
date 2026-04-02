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
  const innerBandRef = useRef()
  const outerBandRef = useRef()
  const flareSpokesRef = useRef()
  const texture = useMemo(() => getSunTexture(), [])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (coronaRef1.current) {
      coronaRef1.current.material.opacity = 0.1 + Math.sin(time * 2) * 0.03
      coronaRef1.current.rotation.y += 0.0012
    }
    if (coronaRef2.current) {
      coronaRef2.current.material.opacity = 0.05 + Math.sin(time * 1.3 + 1) * 0.02
      coronaRef2.current.rotation.y -= 0.001
    }
    if (innerBandRef.current) {
      innerBandRef.current.rotation.z += 0.0022
      innerBandRef.current.material.opacity = 0.22 + Math.sin(time * 2.4) * 0.04
    }
    if (outerBandRef.current) {
      outerBandRef.current.rotation.z -= 0.0014
      outerBandRef.current.material.opacity = 0.14 + Math.sin(time * 1.8 + 1.2) * 0.03
    }
    if (flareSpokesRef.current) {
      flareSpokesRef.current.rotation.z += 0.0016
      flareSpokesRef.current.children.forEach((child, i) => {
        if (!child.material) return
        const base = i % 2 === 0 ? 0.22 : 0.13
        child.material.opacity = base + Math.sin(time * 3.2 + i * (Math.PI / 4)) * 0.08
      })
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 32, 32]} />
        <meshBasicMaterial map={texture} color="#FFF7ED" />
      </mesh>

      <mesh scale={0.72}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial color="#FFFFFF" transparent opacity={0.92} />
      </mesh>

      <mesh ref={coronaRef1} scale={1.25}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color="#F59E0B" transparent opacity={0.1} side={THREE.BackSide} />
      </mesh>

      <mesh ref={coronaRef2} scale={1.5}>
        <sphereGeometry args={[size, 12, 12]} />
        <meshBasicMaterial color="#FDE68A" transparent opacity={0.05} side={THREE.BackSide} />
      </mesh>

      <mesh ref={innerBandRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.08]}>
        <ringGeometry args={[size * 1.03, size * 1.11, 96]} />
        <meshBasicMaterial color="#FEF3C7" transparent opacity={0.24} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={outerBandRef} rotation={[Math.PI * 0.22, 0, -Math.PI * 0.16]}>
        <ringGeometry args={[size * 1.18, size * 1.24, 96]} />
        <meshBasicMaterial color="#FDBA74" transparent opacity={0.14} side={THREE.DoubleSide} />
      </mesh>

      {/* Solar flare rays — 4 major + 4 minor alternating, spin slowly */}
      <group ref={flareSpokesRef} rotation={[Math.PI / 2, 0, 0]}>
        {Array.from({ length: 8 }, (_, i) => {
          const isMajor = i % 2 === 0
          const angle = (i / 8) * Math.PI * 2
          const rayLen = isMajor ? size * 0.62 : size * 0.38
          const rayWidth = isMajor ? size * 0.055 : size * 0.034
          const midR = size * (isMajor ? 1.55 : 1.42)
          return (
            <mesh
              key={i}
              position={[Math.cos(angle) * midR, Math.sin(angle) * midR, 0]}
              rotation={[0, 0, angle - Math.PI / 2]}
            >
              <planeGeometry args={[rayWidth, rayLen]} />
              <meshBasicMaterial
                color={isMajor ? '#FB923C' : '#FDE68A'}
                transparent
                opacity={isMajor ? 0.22 : 0.13}
                side={THREE.DoubleSide}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
          )
        })}
      </group>
    </group>
  )
}

export default SunGeometry
