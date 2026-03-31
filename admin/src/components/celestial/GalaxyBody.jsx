import { useRef, useMemo, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize, bodyPropsEqual } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const ARM_COUNT = 3
const POINTS_PER_ARM = 800
const CORE_POINTS = 500
const DUST_POINTS = 600
const TOTAL_MAIN = ARM_COUNT * POINTS_PER_ARM + CORE_POINTS

/**
 * Simple Box-Muller for Gaussian-distributed spread
 */
const gaussRandom = () => {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

/**
 * Build main spiral arms + dense core.
 * Returns { positions, colors, sizes } Float32Arrays.
 */
const buildMainGeometry = (size) => {
  const positions = new Float32Array(TOTAL_MAIN * 3)
  const colors = new Float32Array(TOTAL_MAIN * 3)
  const sizes = new Float32Array(TOTAL_MAIN)

  const coreColor = new THREE.Color('#FFF1F2')
  const armInner = new THREE.Color('#F472B6')
  const armMid = new THREE.Color('#EC4899')
  const tipColor = new THREE.Color('#8B5CF6')
  const scratch = new THREE.Color()

  let idx = 0

  // Spiral arms
  for (let arm = 0; arm < ARM_COUNT; arm++) {
    const armAngle = (arm / ARM_COUNT) * Math.PI * 2
    for (let i = 0; i < POINTS_PER_ARM; i++) {
      const t = i / POINTS_PER_ARM
      const r = t * size * 2.8 + size * 0.25
      const spiralAngle = armAngle + t * Math.PI * 2.8
      // Tight Gaussian spread — thin spine with soft fringe
      const spread = size * 0.08 * (0.1 + t * 0.9)

      const x = Math.cos(spiralAngle) * r + gaussRandom() * spread
      const z = Math.sin(spiralAngle) * r + gaussRandom() * spread
      const y = gaussRandom() * size * 0.06 * (1 - t * 0.6)

      positions[idx * 3] = x
      positions[idx * 3 + 1] = y
      positions[idx * 3 + 2] = z

      // Three-stop color gradient: pink-inner → hot-pink → purple-tip
      if (t < 0.4) {
        scratch.lerpColors(armInner, armMid, t / 0.4)
      } else {
        scratch.lerpColors(armMid, tipColor, (t - 0.4) / 0.6)
      }
      colors[idx * 3] = scratch.r
      colors[idx * 3 + 1] = scratch.g
      colors[idx * 3 + 2] = scratch.b

      // Larger near core, smaller at tips
      sizes[idx] = 1.0 - t * 0.65

      idx++
    }
  }

  // Dense core cluster
  for (let i = 0; i < CORE_POINTS; i++) {
    const r = Math.abs(gaussRandom()) * size * 0.35
    const angle = Math.random() * Math.PI * 2
    const x = Math.cos(angle) * r
    const z = Math.sin(angle) * r
    const y = gaussRandom() * size * 0.04

    positions[idx * 3] = x
    positions[idx * 3 + 1] = y
    positions[idx * 3 + 2] = z

    const t = Math.min(r / (size * 0.35), 1)
    scratch.lerpColors(coreColor, armInner, t)
    colors[idx * 3] = scratch.r
    colors[idx * 3 + 1] = scratch.g
    colors[idx * 3 + 2] = scratch.b

    sizes[idx] = 1.2 - t * 0.5

    idx++
  }

  return { positions, colors, sizes }
}

/**
 * Build diffuse background dust — fills gaps between arms.
 */
const buildDustGeometry = (size) => {
  const positions = new Float32Array(DUST_POINTS * 3)
  const colors = new Float32Array(DUST_POINTS * 3)

  const dustColor1 = new THREE.Color('#D946EF')
  const dustColor2 = new THREE.Color('#7C3AED')
  const scratch = new THREE.Color()

  for (let i = 0; i < DUST_POINTS; i++) {
    const r = Math.abs(gaussRandom()) * size * 1.4 + size * 0.3
    const angle = Math.random() * Math.PI * 2
    const x = Math.cos(angle) * r
    const z = Math.sin(angle) * r
    const y = gaussRandom() * size * 0.1

    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z

    const t = Math.min(r / (size * 2.5), 1)
    scratch.lerpColors(dustColor1, dustColor2, t)
    colors[i * 3] = scratch.r
    colors[i * 3 + 1] = scratch.g
    colors[i * 3 + 2] = scratch.b
  }

  return { positions, colors }
}

/**
 * Spiral galaxy body — particle-based spiral arms + bright core + dust layer.
 */
const GalaxyBody = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const mainRef = useRef()
  const dustRef = useRef()
  const coreGlowRef = useRef()
  const discGlow1Ref = useRef()
  const discGlow2Ref = useRef()
  const discGlow3Ref = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  const hasTP = body.tpPrice > 0

  const main = useMemo(() => buildMainGeometry(size), [size])
  const dust = useMemo(() => buildDustGeometry(size), [size])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    if (mainRef.current) mainRef.current.rotation.y += 0.0025
    if (dustRef.current) dustRef.current.rotation.y += 0.0018

    if (coreGlowRef.current) {
      coreGlowRef.current.material.opacity = hasTP
        ? 0.2
        : 0.15 + Math.sin(time * 2) * 0.05
    }
    if (discGlow1Ref.current) {
      discGlow1Ref.current.material.opacity = 0.14 + Math.sin(time * 1.1) * 0.03
    }
    if (discGlow2Ref.current) {
      discGlow2Ref.current.material.opacity = 0.08 + Math.sin(time * 0.8 + 1) * 0.02
    }
    if (discGlow3Ref.current) {
      discGlow3Ref.current.material.opacity = 0.04 + Math.sin(time * 0.6 + 2) * 0.015
    }
  })

  return (
    <group>
      {/* Invisible hover target sphere */}
      <mesh onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}>
        <sphereGeometry args={[size * 2.0, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Bright core sphere */}
      <mesh>
        <sphereGeometry args={[size * 0.22, 24, 24]} />
        <meshBasicMaterial color="#FFFFFF" />
      </mesh>

      <mesh>
        <sphereGeometry args={[size * 0.32, 20, 20]} />
        <meshBasicMaterial color="#FFF1F2" transparent opacity={0.85} />
      </mesh>

      {/* Core glow halo - tight bright bloom */}
      <mesh ref={coreGlowRef} scale={2.2}>
        <sphereGeometry args={[size * 0.3, 16, 16]} />
        <meshBasicMaterial color="#EC4899" transparent opacity={0.18} side={THREE.BackSide} />
      </mesh>

      {/* Layered disc glows — inner hot, mid warm, outer faint */}
      <mesh ref={discGlow1Ref} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[size * 1.0, 64]} />
        <meshBasicMaterial color="#F472B6" transparent opacity={0.14} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh ref={discGlow2Ref} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[size * 1.8, 64]} />
        <meshBasicMaterial color="#C084FC" transparent opacity={0.08} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh ref={discGlow3Ref} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[size * 2.6, 64]} />
        <meshBasicMaterial color="#7C3AED" transparent opacity={0.04} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* Main spiral arm + core particles */}
      <points ref={mainRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={TOTAL_MAIN} array={main.positions} itemSize={3} />
          <bufferAttribute attach="attributes-color" count={TOTAL_MAIN} array={main.colors} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          size={0.1}
          sizeAttenuation
          transparent
          opacity={0.8}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {/* Diffuse dust layer — fills gaps, softer glow */}
      <points ref={dustRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={DUST_POINTS} array={dust.positions} itemSize={3} />
          <bufferAttribute attach="attributes-color" count={DUST_POINTS} array={dust.colors} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          size={0.12}
          sizeAttenuation
          transparent
          opacity={0.15}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.8, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, bodyPropsEqual)

GalaxyBody.displayName = 'GalaxyBody'

export default GalaxyBody
