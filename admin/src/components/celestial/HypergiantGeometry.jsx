import { useMemo } from 'react'
import { getHypergiantTexture } from './hypergiantTexture'

/**
 * Hypergiant-specific mesh: sphere with Jupiter-like gas band texture.
 * Uses MeshBasicMaterial (unlit) so bloom can handle the glow.
 */
const HypergiantGeometry = ({ size }) => {
  const texture = useMemo(() => getHypergiantTexture(), [])

  return (
    <mesh>
      <sphereGeometry args={[size, 32, 32]} />
      <meshBasicMaterial map={texture} />
    </mesh>
  )
}

export default HypergiantGeometry
