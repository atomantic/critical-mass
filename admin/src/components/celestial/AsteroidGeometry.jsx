import { useMemo } from 'react'
import * as THREE from 'three'
import { getRockTexture } from './rockTexture'

/**
 * Asteroid "Field" component: Renders a primary chunky rock surrounded by smaller boulders.
 * Inspired by No Man's Sky: faceted geometry, high-contrast lighting, and glowing ore veins.
 */
const AsteroidGeometry = ({ size, color, emissiveInt }) => {
  const textures = useMemo(() => getRockTexture(), [])
  
  // Create 3-4 distinct rock chunks for a "field" look
  const chunks = useMemo(() => {
    return [
      { pos: [0, 0, 0], scale: 1.0, seed: 123 }, // Main rock
      { pos: [size * 0.8, size * 0.4, -size * 0.3], scale: 0.4, seed: 456 },
      { pos: [-size * 0.6, -size * 0.7, size * 0.5], scale: 0.3, seed: 789 },
      { pos: [size * 0.2, -size * 0.9, -size * 0.6], scale: 0.25, seed: 321 },
    ].map(chunk => {
      // Create chunky geometry for each piece
      const geo = new THREE.IcosahedronGeometry(size * chunk.scale, 1)
      const posAttr = geo.getAttribute('position')
      const arr = posAttr.array

      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i+1], z = arr[i+2]
        const len = Math.sqrt(x*x + y*y + z*z)
        if (len === 0) continue

        // Plateau noise: use sin/cos to create "steps" in displacement
        const noise = Math.sin(x * 2.5 + chunk.seed) * Math.cos(y * 2.5 + chunk.seed) * Math.sin(z * 2.5)
        const displacement = 0.8 + (noise > 0 ? 0.4 : 0) // Harsh binary step for "flat" facets
        
        const s = (size * chunk.scale * displacement) / len
        arr[i] *= s
        arr[i+1] *= s
        arr[i+2] *= s
      }
      
      posAttr.needsUpdate = true
      geo.computeVertexNormals()
      const edges = new THREE.EdgesGeometry(geo, 22)
      return { ...chunk, geo, edges }
    })
  }, [size])

  return (
    <group>
      {chunks.map((chunk, i) => (
        <group
          key={i}
          position={chunk.pos}
          rotation={[i, i * 2, 0]}
        >
          <pointLight
            color="#F97316"
            intensity={0.35 * chunk.scale}
            distance={size * 3.2}
            decay={2}
          />
          <mesh geometry={chunk.geo}>
            <meshStandardMaterial
              map={textures.map}
              bumpMap={textures.bumpMap}
              bumpScale={0.15}
              emissiveMap={textures.emissiveMap}
              color={new THREE.Color(color).lerp(new THREE.Color('#8A5530'), 0.65)}
              emissiveIntensity={Math.max(emissiveInt * 7, 0.9)}
              emissive={new THREE.Color('#7C2D12')}
              roughness={0.78}
              metalness={0.18}
              flatShading
            />
          </mesh>
          <mesh geometry={chunk.geo} scale={0.995}>
            <meshBasicMaterial
              color="#F59E0B"
              transparent
              opacity={0.035}
            />
          </mesh>
          <mesh geometry={chunk.geo} scale={1.02}>
            <meshBasicMaterial
              color="#EA580C"
              transparent
              opacity={0.07}
              side={THREE.BackSide}
            />
          </mesh>
          <lineSegments geometry={chunk.edges} scale={1.025}>
            <lineBasicMaterial
              color="#FB923C"
              transparent
              opacity={0.4}
            />
          </lineSegments>
        </group>
      ))}
    </group>
  )
}

export default AsteroidGeometry
