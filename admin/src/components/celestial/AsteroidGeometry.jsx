import { useMemo } from 'react'
import * as THREE from 'three'
import { getRockTexture } from './rockTexture'

/**
 * Asteroid-shaped geometry: irregular rocky body using displaced icosahedron.
 * Enhanced with procedural rock texture and flat shading for a rugged look.
 */
const AsteroidGeometry = ({ size, color, emissiveInt }) => {
  const texture = useMemo(() => getRockTexture(), [])
  
  const geometry = useMemo(() => {
    // Lower detail for a more angular, low-poly rocky feel
    const geo = new THREE.IcosahedronGeometry(size, 1)
    const posAttr = geo.getAttribute('position')
    const arr = posAttr.array

    // Displace vertices randomly for irregular rocky shape
    const seed = 42
    for (let i = 0; i < arr.length; i += 3) {
      const len = Math.sqrt(arr[i] ** 2 + arr[i + 1] ** 2 + arr[i + 2] ** 2)
      if (len === 0) continue
      const hash = Math.sin((i + seed) * 127.1) * 43758.5453
      const displacement = 0.6 + (hash - Math.floor(hash)) * 0.8 // 0.6..1.4 range
      const scale = (size * displacement) / len
      arr[i] *= scale
      arr[i + 1] *= scale
      arr[i + 2] *= scale
    }
    posAttr.needsUpdate = true
    geo.computeVertexNormals()
    return geo
  }, [size])

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        map={texture}
        color={color}
        emissive={color}
        emissiveIntensity={emissiveInt * 0.4}
        roughness={0.9}
        metalness={0.05}
        flatShading
      />
    </mesh>
  )
}

export default AsteroidGeometry
