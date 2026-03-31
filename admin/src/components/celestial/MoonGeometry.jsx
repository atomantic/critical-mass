import { useMemo } from 'react'
import * as THREE from 'three'
import { getMoonTexture } from './moonTexture'

/**
 * Moon-specific mesh: sphere with procedural cratered texture.
 * Enhanced with bump and roughness maps for a more realistic rocky surface.
 */
const MoonGeometry = ({ size, color, emissiveInt }) => {
  const textures = useMemo(() => getMoonTexture(), [])

  const outlineColor = new THREE.Color('#94A3B8').lerp(new THREE.Color('#C7D2FE'), 0.45)

  return (
    <group>
      <mesh>
        <sphereGeometry args={[size, 64, 64]} /> {/* Increased segments for better bump mapping visibility */}
        <meshStandardMaterial
          map={textures.map}
          bumpMap={textures.bumpMap}
          bumpScale={0.08}
          roughnessMap={textures.roughnessMap}
          color={color}
          emissive={outlineColor}
          emissiveIntensity={emissiveInt * 0.55}
          roughness={0.9}
          metalness={0.05}
        />
      </mesh>

      <mesh scale={1.04}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial
          color="#CBD5E1"
          transparent
          opacity={0.05}
          side={THREE.BackSide}
        />
      </mesh>

      <mesh scale={1.015}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial
          color={outlineColor}
          wireframe
          transparent
          opacity={0.12}
        />
      </mesh>
    </group>
  )
}

export default MoonGeometry
