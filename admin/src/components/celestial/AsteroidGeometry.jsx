import { useMemo } from 'react'
import * as THREE from 'three'

/**
 * Asteroid-shaped geometry: irregular rocky body using displaced icosahedron.
 * Brown/gray coloring with rough surface — no glow halo (dead rocky body).
 */
const AsteroidGeometry = ({ size, color, emissiveInt }) => {
  const geometry = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(size, 1)
    const posAttr = geo.getAttribute('position')
    const arr = posAttr.array

    // Displace vertices randomly for irregular rocky shape
    const seed = 42
    for (let i = 0; i < arr.length; i += 3) {
      const len = Math.sqrt(arr[i] ** 2 + arr[i + 1] ** 2 + arr[i + 2] ** 2)
      if (len === 0) continue
      // Deterministic-ish displacement based on vertex index
      const hash = Math.sin((i + seed) * 127.1) * 43758.5453
      const displacement = 0.7 + (hash - Math.floor(hash)) * 0.6 // 0.7..1.3 range
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
        color={color}
        emissive={color}
        emissiveIntensity={emissiveInt}
        roughness={0.85}
        metalness={0.15}
        flatShading
      />
    </mesh>
  )
}

export default AsteroidGeometry
