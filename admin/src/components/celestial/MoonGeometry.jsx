import { useMemo } from 'react'
import * as THREE from 'three'
import { getMoonTexture } from './moonTexture'
import FresnelGlow from './FresnelGlow'

/**
 * Moon-specific mesh: sphere with procedural cratered texture.
 * Bump and roughness maps give a realistic rocky surface; a faint fresnel
 * rim keeps the silhouette legible against the dark background.
 */
const MoonGeometry = ({ size, color, emissiveInt }) => {
  const textures = useMemo(() => getMoonTexture(), [])
  const outlineColor = useMemo(
    () => new THREE.Color('#94A3B8').lerp(new THREE.Color('#C7D2FE'), 0.45),
    []
  )

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
          emissiveIntensity={emissiveInt * 0.75}
          roughness={0.9}
          metalness={0.05}
        />
      </mesh>

      <FresnelGlow size={size} scale={1.12} color="#CBD5E1" power={3.0} intensity={0.35} segments={16} />
    </group>
  )
}

export default MoonGeometry
