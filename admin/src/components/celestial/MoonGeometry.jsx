import { useMemo } from 'react'
import { getMoonTexture } from './moonTexture'

/**
 * Moon-specific mesh: sphere with procedural cratered texture.
 * Enhanced with bump and roughness maps for a more realistic rocky surface.
 */
const MoonGeometry = ({ size, color, emissiveInt }) => {
  const textures = useMemo(() => getMoonTexture(), [])

  return (
    <mesh>
      <sphereGeometry args={[size, 64, 64]} /> {/* Increased segments for better bump mapping visibility */}
      <meshStandardMaterial
        map={textures.map}
        bumpMap={textures.bumpMap}
        bumpScale={0.08}
        roughnessMap={textures.roughnessMap}
        color={color}
        emissive={color}
        emissiveIntensity={emissiveInt * 0.5} // Lower emissive so texture details aren't washed out
        roughness={0.9}
        metalness={0.05}
      />
    </mesh>
  )
}

export default MoonGeometry
