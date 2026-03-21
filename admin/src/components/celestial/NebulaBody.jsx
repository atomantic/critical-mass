import { useRef, useMemo, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const CLOUD_LAYERS = 3
const POINTS_PER_LAYER = 500
const CORE_POINTS = 150
const TOTAL = CLOUD_LAYERS * POINTS_PER_LAYER + CORE_POINTS

/**
 * Generate nebula particle cloud positions and colors.
 * Pillars of Creation inspired — multi-colored gas clouds.
 */
const buildNebulaGeometry = (size) => {
  const positions = new Float32Array(TOTAL * 3)
  const colors = new Float32Array(TOTAL * 3)

  const cyanCore = new THREE.Color('#CFFAFE')
  const teal = new THREE.Color('#06B6D4')
  const purple = new THREE.Color('#7C3AED')
  const rose = new THREE.Color('#F43F5E')

  let idx = 0

  // Gas cloud layers — overlapping ellipsoidal distributions
  for (let layer = 0; layer < CLOUD_LAYERS; layer++) {
    const layerAngle = (layer / CLOUD_LAYERS) * Math.PI * 2
    const offsetX = Math.cos(layerAngle) * size * 0.3
    const offsetZ = Math.sin(layerAngle) * size * 0.3
    const layerColor = layer === 0 ? teal : layer === 1 ? purple : rose

    for (let i = 0; i < POINTS_PER_LAYER; i++) {
      const t = i / POINTS_PER_LAYER

      // Gaussian-ish distribution
      const r = size * 1.8 * Math.sqrt(-2 * Math.log(Math.max(Math.random(), 0.001))) * 0.4
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)

      const x = offsetX + r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta) * 0.6 // flatten slightly
      const z = offsetZ + r * Math.cos(phi)

      positions[idx * 3] = x
      positions[idx * 3 + 1] = y
      positions[idx * 3 + 2] = z

      // Color gradient from core color at center to layer color at edges
      const dist = Math.sqrt(x * x + y * y + z * z) / (size * 1.5)
      const c = new THREE.Color().lerpColors(cyanCore, layerColor, Math.min(dist, 1))
      colors[idx * 3] = c.r
      colors[idx * 3 + 1] = c.g
      colors[idx * 3 + 2] = c.b

      idx++
    }
  }

  // Dense bright core
  for (let i = 0; i < CORE_POINTS; i++) {
    const r = Math.random() * size * 0.4
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)

    positions[idx * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[idx * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.5
    positions[idx * 3 + 2] = r * Math.cos(phi)

    const t = r / (size * 0.4)
    const c = new THREE.Color().lerpColors(cyanCore, teal, t)
    colors[idx * 3] = c.r
    colors[idx * 3 + 1] = c.g
    colors[idx * 3 + 2] = c.b

    idx++
  }

  return { positions, colors }
}

/**
 * Nebula body — colorful gas cloud using particles with additive blending.
 * Multi-colored volumetric appearance with gentle shimmer.
 */
const NebulaBody = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const pointsRef = useRef()
  const coreGlowRef = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  const hasTP = body.tpPrice > 0

  const { positions, colors } = useMemo(() => buildNebulaGeometry(size), [size])

  useFrame((state) => {
    // Slow rotation
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.002
      pointsRef.current.rotation.x += 0.0005
    }
    // Pulse core
    if (coreGlowRef.current) {
      const time = state.clock.elapsedTime
      coreGlowRef.current.material.opacity = hasTP
        ? 0.18
        : 0.12 + Math.sin(time * 1.5) * 0.06
    }
  })

  return (
    <group>
      {/* Invisible hover target */}
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size * 1.5, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Bright core */}
      <mesh>
        <sphereGeometry args={[size * 0.2, 16, 16]} />
        <meshBasicMaterial color="#CFFAFE" />
      </mesh>

      {/* Core glow halo */}
      <mesh ref={coreGlowRef} scale={2.0}>
        <sphereGeometry args={[size * 0.3, 12, 12]} />
        <meshBasicMaterial
          color="#06B6D4"
          transparent
          opacity={0.15}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Gas cloud particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={TOTAL}
            array={positions}
            itemSize={3}
          />
          <bufferAttribute
            attach="attributes-color"
            count={TOTAL}
            array={colors}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          size={0.07}
          sizeAttenuation
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.showTooltip === next.showTooltip &&
  prev.maxUsdcDeployed === next.maxUsdcDeployed &&
  prev.baseCurrency === next.baseCurrency
)

NebulaBody.displayName = 'NebulaBody'

export default NebulaBody
