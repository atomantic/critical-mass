import { useMemo } from 'react'
import { getMoonTexture } from './moonTexture'

/**
 * Moon-specific mesh: sphere with procedural cratered texture.
 * Matte rocky look (high roughness, low metalness).
 */
const MoonGeometry = ({ size, color, emissiveInt }) => {
  const texture = useMemo(() => getMoonTexture(), [])

  return (
    <mesh>
      <sphereGeometry args={[size, 32, 32]} />
      <meshStandardMaterial
        map={texture}
        color={color}
        emissive={color}
        emissiveIntensity={emissiveInt}
        roughness={0.7}
        metalness={0.1}
      />
    </mesh>
  )
}

export default MoonGeometry
