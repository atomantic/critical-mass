import { useMemo } from 'react'
import { Color, MathUtils } from 'three'

// Deterministic PRNG so a given layer always renders the same sky.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * Static starfield: `count` points distributed on a spherical shell between
 * `radius` and `radius + depth`, tinted with a light random hue (`saturation`).
 */
const Starfield = ({ radius = 100, depth = 50, count = 5000, factor = 4, saturation = 0, seed = 1 }) => {
  const { positions, colors } = useMemo(() => {
    const rand = mulberry32(seed)
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const color = new Color()
    for (let i = 0; i < count; i++) {
      const r = radius + rand() * depth
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(MathUtils.clamp(2 * rand() - 1, -1, 1))
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = r * Math.cos(phi)
      // Natural stellar magnitude distribution: mostly dim to medium stars, occasional bright ones
      const lightness = 0.4 + rand() * rand() * 0.45
      color.setHSL(rand(), saturation, lightness)
      colors.set([color.r, color.g, color.b], i * 3)
    }
    return { positions, colors }
  }, [radius, depth, count, saturation, seed])

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={factor * 0.08} sizeAttenuation vertexColors transparent depthWrite={false} fog={false} />
    </points>
  )
}

export default Starfield
