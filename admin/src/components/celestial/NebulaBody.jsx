import { useRef, useMemo, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize, bodyPropsEqual } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const CLOUD_LAYERS = 3
const POINTS_PER_LAYER = 800
const CORE_POINTS = 300
const TOTAL = CLOUD_LAYERS * POINTS_PER_LAYER + CORE_POINTS

const buildNebulaGeometry = (size) => {
  const positions = new Float32Array(TOTAL * 3)
  const colors = new Float32Array(TOTAL * 3)

  const cyanCore = new THREE.Color('#CFFAFE')
  const teal = new THREE.Color('#06B6D4')
  const purple = new THREE.Color('#7C3AED')
  const rose = new THREE.Color('#F43F5E')
  const scratch = new THREE.Color()

  let idx = 0

  for (let layer = 0; layer < CLOUD_LAYERS; layer++) {
    const layerAngle = (layer / CLOUD_LAYERS) * Math.PI * 2
    const offsetX = Math.cos(layerAngle) * size * 0.3
    const offsetZ = Math.sin(layerAngle) * size * 0.3
    const layerColor = layer === 0 ? teal : layer === 1 ? purple : rose

    for (let i = 0; i < POINTS_PER_LAYER; i++) {
      const r = size * 1.8 * Math.sqrt(-2 * Math.log(Math.max(Math.random(), 0.001))) * 0.4
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)

      const x = offsetX + r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta) * 0.6
      const z = offsetZ + r * Math.cos(phi)

      positions[idx * 3] = x
      positions[idx * 3 + 1] = y
      positions[idx * 3 + 2] = z

      const dist = Math.sqrt(x * x + y * y + z * z) / (size * 1.5)
      scratch.lerpColors(cyanCore, layerColor, Math.min(dist, 1))
      colors[idx * 3] = scratch.r
      colors[idx * 3 + 1] = scratch.g
      colors[idx * 3 + 2] = scratch.b

      idx++
    }
  }

  for (let i = 0; i < CORE_POINTS; i++) {
    const r = Math.random() * size * 0.4
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)

    positions[idx * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[idx * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.5
    positions[idx * 3 + 2] = r * Math.cos(phi)

    scratch.lerpColors(cyanCore, teal, r / (size * 0.4))
    colors[idx * 3] = scratch.r
    colors[idx * 3 + 1] = scratch.g
    colors[idx * 3 + 2] = scratch.b

    idx++
  }

  return { positions, colors }
}

const NebulaBody = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const pointsRef = useRef()
  const coreGlowRef = useRef()
  const cloudRef1 = useRef()
  const cloudRef2 = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  const hasTP = body.tpPrice > 0

  const { positions, colors } = useMemo(() => buildNebulaGeometry(size), [size])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.002
      pointsRef.current.rotation.x += 0.0005
    }
    if (coreGlowRef.current) {
      coreGlowRef.current.material.opacity = hasTP
        ? 0.18
        : 0.14 + Math.sin(time * 1.5) * 0.05
    }
    if (cloudRef1.current) {
      cloudRef1.current.rotation.y += 0.0008
      cloudRef1.current.material.opacity = 0.14 + Math.sin(time * 1.1) * 0.03
    }
    if (cloudRef2.current) {
      cloudRef2.current.rotation.y -= 0.0006
      cloudRef2.current.material.opacity = 0.1 + Math.sin(time * 0.9 + 1.2) * 0.025
    }
  })

  return (
    <group>
      <mesh onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}>
        <sphereGeometry args={[size * 1.5, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      <mesh>
        <sphereGeometry args={[size * 0.2, 16, 16]} />
        <meshBasicMaterial color="#CFFAFE" />
      </mesh>

      <mesh ref={coreGlowRef} scale={2.0}>
        <sphereGeometry args={[size * 0.3, 12, 12]} />
        <meshBasicMaterial color="#06B6D4" transparent opacity={0.15} side={THREE.BackSide} />
      </mesh>

      <mesh ref={cloudRef1} scale={[1.9, 1.15, 1.45]} rotation={[0.25, 0.2, 0]}>
        <sphereGeometry args={[size * 0.7, 18, 18]} />
        <meshBasicMaterial
          color="#22D3EE"
          transparent
          opacity={0.14}
          side={THREE.BackSide}
        />
      </mesh>

      <mesh ref={cloudRef2} scale={[1.7, 0.95, 1.8]} rotation={[-0.18, -0.4, 0.12]}>
        <sphereGeometry args={[size * 0.9, 18, 18]} />
        <meshBasicMaterial
          color="#A78BFA"
          transparent
          opacity={0.1}
          side={THREE.BackSide}
        />
      </mesh>

      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={TOTAL} array={positions} itemSize={3} />
          <bufferAttribute attach="attributes-color" count={TOTAL} array={colors} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial vertexColors size={0.1} sizeAttenuation transparent opacity={0.58} blending={THREE.AdditiveBlending} depthWrite={false} />
      </points>

      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, bodyPropsEqual)

NebulaBody.displayName = 'NebulaBody'

export default NebulaBody
