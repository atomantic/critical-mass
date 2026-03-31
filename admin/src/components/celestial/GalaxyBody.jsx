import { useRef, useMemo, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getBodySize, bodyPropsEqual } from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'

const ARM_COUNT = 3
const POINTS_PER_ARM = 400
const CORE_POINTS = 200
const TOTAL = ARM_COUNT * POINTS_PER_ARM + CORE_POINTS

/**
 * Generate spiral galaxy particle positions and colors.
 * Returns { positions, colors } Float32Arrays.
 */
const buildGalaxyGeometry = (size) => {
  const positions = new Float32Array(TOTAL * 3)
  const colors = new Float32Array(TOTAL * 3)

  const coreColor = new THREE.Color('#FCE7F3') // pink-white core
  const armColor = new THREE.Color('#EC4899')   // pink
  const tipColor = new THREE.Color('#8B5CF6')   // purple at tips

  let idx = 0

  // Spiral arms
  for (let arm = 0; arm < ARM_COUNT; arm++) {
    const armAngle = (arm / ARM_COUNT) * Math.PI * 2
    for (let i = 0; i < POINTS_PER_ARM; i++) {
      const t = i / POINTS_PER_ARM // 0..1 along arm
      const r = t * size * 2.5 + size * 0.3
      const spiralAngle = armAngle + t * Math.PI * 2.5 // ~2.5 turns
      const spread = size * 0.15 * t // arm gets wider at tips

      const x = Math.cos(spiralAngle) * r + (Math.random() - 0.5) * spread * 2
      const z = Math.sin(spiralAngle) * r + (Math.random() - 0.5) * spread * 2
      const y = (Math.random() - 0.5) * size * 0.12 * (1 - t * 0.5) // thin disk, thinner at edge

      positions[idx * 3] = x
      positions[idx * 3 + 1] = y
      positions[idx * 3 + 2] = z

      // Color gradient: pink near center → purple at tips
      const c = new THREE.Color().lerpColors(armColor, tipColor, t)
      colors[idx * 3] = c.r
      colors[idx * 3 + 1] = c.g
      colors[idx * 3 + 2] = c.b

      idx++
    }
  }

  // Dense core cluster
  for (let i = 0; i < CORE_POINTS; i++) {
    const r = Math.random() * size * 0.5
    const angle = Math.random() * Math.PI * 2
    const x = Math.cos(angle) * r * (0.5 + Math.random() * 0.5)
    const z = Math.sin(angle) * r * (0.5 + Math.random() * 0.5)
    const y = (Math.random() - 0.5) * size * 0.08

    positions[idx * 3] = x
    positions[idx * 3 + 1] = y
    positions[idx * 3 + 2] = z

    // Core is brighter, whiter
    const t = r / (size * 0.5)
    const c = new THREE.Color().lerpColors(coreColor, armColor, t)
    colors[idx * 3] = c.r
    colors[idx * 3 + 1] = c.g
    colors[idx * 3 + 2] = c.b

    idx++
  }

  return { positions, colors }
}

/**
 * Spiral galaxy body — particle-based spiral arms + bright core.
 * Replaces the plain bright sphere for galaxy tier.
 */
const GalaxyBody = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const pointsRef = useRef()
  const coreGlowRef = useRef()
  const discGlowRef = useRef()
  const guideRingRef = useRef()
  const guideRingOuterRef = useRef()
  const discWireRef = useRef()

  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  const hasTP = body.tpPrice > 0

  const { positions, colors } = useMemo(() => buildGalaxyGeometry(size), [size])

  useFrame((state) => {
    // Slow rotation of the entire galaxy
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.003
    }
    // Pulse core glow
    const time = state.clock.elapsedTime
    if (coreGlowRef.current) {
      coreGlowRef.current.material.opacity = hasTP
        ? 0.15
        : 0.1 + Math.sin(time * 2) * 0.05
    }
    if (discGlowRef.current) {
      discGlowRef.current.rotation.z += 0.0005
      discGlowRef.current.material.opacity = 0.12 + Math.sin(time * 1.2) * 0.03
    }
    if (guideRingRef.current) {
      guideRingRef.current.rotation.z += 0.0011
      guideRingRef.current.material.opacity = 0.12 + Math.sin(time * 1.5) * 0.02
    }
    if (guideRingOuterRef.current) {
      guideRingOuterRef.current.rotation.z -= 0.0008
      guideRingOuterRef.current.material.opacity = 0.08 + Math.sin(time * 1.2 + 1.1) * 0.02
    }
    if (discWireRef.current) {
      discWireRef.current.rotation.y += 0.0013
      discWireRef.current.material.opacity = 0.045 + Math.sin(time * 1.7) * 0.015
    }
  })

  return (
    <group>
      {/* Invisible hover target sphere */}
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
      >
        <sphereGeometry args={[size * 1.5, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Bright core sphere */}
      <mesh>
        <sphereGeometry args={[size * 0.25, 16, 16]} />
        <meshBasicMaterial color="#FFF1F2" />
      </mesh>

      <mesh scale={1.2}>
        <sphereGeometry args={[size * 0.16, 12, 12]} />
        <meshBasicMaterial color="#FFFFFF" transparent opacity={0.9} />
      </mesh>

      {/* Core glow halo */}
      <mesh ref={coreGlowRef} scale={1.8}>
        <sphereGeometry args={[size * 0.3, 12, 12]} />
        <meshBasicMaterial
          color="#EC4899"
          transparent
          opacity={0.12}
          side={THREE.BackSide}
        />
      </mesh>

      <mesh ref={discGlowRef} rotation={[Math.PI / 2, 0, 0]} scale={[1.35, 1, 1.35]}>
        <circleGeometry args={[size * 1.35, 64]} />
        <meshBasicMaterial
          color="#C084FC"
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh ref={guideRingRef} rotation={[Math.PI * 0.48, 0, Math.PI * 0.1]}>
        <ringGeometry args={[size * 0.46, size * 0.58, 96]} />
        <meshBasicMaterial color="#F472B6" transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={guideRingOuterRef} rotation={[Math.PI * 0.48, 0, -Math.PI * 0.16]}>
        <ringGeometry args={[size * 0.82, size * 0.92, 96]} />
        <meshBasicMaterial color="#A78BFA" transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>

      <mesh ref={discWireRef} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[size * 0.95, size * 1.45, 48]} />
        <meshBasicMaterial
          color="#C084FC"
          wireframe
          transparent
          opacity={0.045}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Spiral arm particles */}
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
          size={0.08}
          sizeAttenuation
          transparent
          opacity={0.72}
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
