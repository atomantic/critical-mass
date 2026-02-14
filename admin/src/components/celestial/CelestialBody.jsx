import { useRef, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  TIER_COLORS, CORE_COLORS,
  GLOW_INTENSITY, EMISSIVE_INTENSITY, STELLAR_TIERS, getBodySize,
} from './celestialConstants'
import CelestialTooltip from './CelestialTooltip'
import MoonGeometry from './MoonGeometry'
import SatelliteGeometry from './SatelliteGeometry'
import HypergiantGeometry from './HypergiantGeometry'

/**
 * Individual celestial body (visual only — parent handles orbital positioning).
 *
 * Rocky bodies (satellite, moon, planet):
 *   MeshStandardMaterial with emissive tint + thin BackSide glow halo
 *
 * Stellar bodies (sun, hypergiant, galaxy):
 *   Bright MeshBasicMaterial (unlit, full brightness → bloom does the glow)
 *   + one thin BackSide halo for color tint. Bloom handles the rest.
 */
const CelestialBody = memo(({ body, showTooltip, onHover, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const meshRef = useRef()
  const glowRef = useRef()

  const color = TIER_COLORS[body.tier] || TIER_COLORS.satellite
  const glowInt = GLOW_INTENSITY[body.tier] || 0.3
  const emissiveInt = EMISSIVE_INTENSITY[body.tier] || 0.2
  const size = getBodySize(body.costBasis, maxUsdcDeployed)
  const hasTP = body.tpPrice > 0
  const isStellar = STELLAR_TIERS.has(body.tier)
  const coreColor = CORE_COLORS[body.tier] || '#ffffff'

  useFrame((state) => {
    const time = state.clock.elapsedTime

    // Glow animation
    if (glowRef.current) {
      if (!hasTP) {
        glowRef.current.material.opacity = 0.08 + Math.sin(time * 2) * 0.04
      } else {
        glowRef.current.material.opacity = isStellar ? 0.12 : glowInt * 0.25
      }
    }

    // Slow self-rotation
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.005
    }
  })

  const isMoon = body.tier === 'moon'
  const isSatellite = body.tier === 'satellite'
  const isHypergiant = body.tier === 'hypergiant'
  const useGroupGeometry = isMoon || isSatellite || isHypergiant

  return (
    <group>
      {/* Main body */}
      {useGroupGeometry ? (
        <group
          ref={meshRef}
          onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
        >
          {isMoon && <MoonGeometry size={size} color={color} emissiveInt={emissiveInt} />}
          {isSatellite && <SatelliteGeometry size={size} color={color} emissiveInt={emissiveInt} />}
          {isHypergiant && <HypergiantGeometry size={size} />}
        </group>
      ) : (
        <mesh
          ref={meshRef}
          onPointerOver={(e) => { e.stopPropagation(); onHover(body.id) }}
        >
          <sphereGeometry args={[size, 24, 24]} />
          {isStellar ? (
            <meshBasicMaterial color={coreColor} />
          ) : (
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={emissiveInt}
              roughness={0.4}
              metalness={0.3}
            />
          )}
        </mesh>
      )}

      {/* Glow halo — skip for moon (no atmosphere) and satellite (mechanical) */}
      {!isMoon && !isSatellite && (
        <mesh ref={glowRef} scale={isStellar ? 1.3 : 1.4}>
          <sphereGeometry args={[size, 16, 16]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.12}
            side={THREE.BackSide}
          />
        </mesh>
      )}

      {/* Saturn-like ring for merged planets (mergeCount > 2) */}
      {body.tier === 'planet' && body.mergeCount > 2 && (
        <mesh rotation={[Math.PI / 3, 0, 0]}>
          <ringGeometry args={[size * 1.4, size * 2.0, 32]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.25}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Pinned tooltip */}
      {showTooltip && <CelestialTooltip body={body} position={[0, size + 0.5, 0]} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} />}
    </group>
  )
}, (prev, next) =>
  prev.body.id === next.body.id &&
  prev.body.tier === next.body.tier &&
  prev.body.costBasis === next.body.costBasis &&
  prev.body.tpPrice === next.body.tpPrice &&
  prev.body.mergeCount === next.body.mergeCount &&
  prev.showTooltip === next.showTooltip &&
  prev.maxUsdcDeployed === next.maxUsdcDeployed &&
  prev.baseCurrency === next.baseCurrency
)

CelestialBody.displayName = 'CelestialBody'

export default CelestialBody
