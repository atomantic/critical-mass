import { useMemo, useState, useCallback } from 'react'
import { Stars, OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import CelestialBody from './CelestialBody'
import BlackHole from './BlackHole'
import OrbitalRing from './OrbitalRing'
import IncomingOrder from './IncomingOrder'
import { TIER_ORDER } from './celestialConstants'

/**
 * R3F scene composition: lights, stars, orbital rings, bodies, bloom, controls
 * Inspired by bituniverse's galaxy visualization (bloom, fog, dual starfields)
 */
const CelestialScene = ({ bodies = [], buyOrders = [] }) => {
  // Separate black holes (stationary center) from orbiting bodies
  const blackHoles = useMemo(() => bodies.filter(b => b.tier === 'black_hole'), [bodies])
  const orbitingBodies = useMemo(() => bodies.filter(b => b.tier !== 'black_hole'), [bodies])

  // Count orbiting bodies per tier for angle offset distribution
  const tierCounts = useMemo(() => {
    const counts = {}
    for (const body of orbitingBodies) {
      counts[body.tier] = (counts[body.tier] || 0) + 1
    }
    return counts
  }, [orbitingBodies])

  // Track per-tier index for each orbiting body
  const bodiesWithIndex = useMemo(() => {
    const tierIdx = {}
    return orbitingBodies.map((body) => {
      tierIdx[body.tier] = (tierIdx[body.tier] || 0)
      const index = tierIdx[body.tier]
      tierIdx[body.tier] += 1
      return { body, index, totalInTier: tierCounts[body.tier] || 1 }
    })
  }, [orbitingBodies, tierCounts])

  // Determine if we have high-tier bodies for brighter central light
  const hasHighTier = bodies.some(b => ['sun', 'hypergiant', 'galaxy', 'black_hole'].includes(b.tier))
  const hasBlackHole = blackHoles.length > 0

  // Tiers that need orbital rings (everything except black_hole)
  const activeTiers = useMemo(() =>
    TIER_ORDER.filter(t => t !== 'black_hole'),
  [])

  // Pinned tooltip: stays on last-hovered body until a different one is hovered
  const [activeBodyId, setActiveBodyId] = useState(null)
  const onBodyHover = useCallback((bodyId) => setActiveBodyId(bodyId), [])

  return (
    <>
      {/* Camera controls */}
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.3}
        enablePan={false}
        minDistance={4}
        maxDistance={25}
        maxPolarAngle={Math.PI * 0.85}
        minPolarAngle={Math.PI * 0.15}
      />

      {/* Fog for depth (inspired by bituniverse) */}
      <fog attach="fog" args={['#0f0f14', 20, 60]} />

      {/* Ambient light */}
      <ambientLight intensity={hasHighTier ? 0.12 : 0.25} />

      {/* Central point light - amber glow from center */}
      <pointLight
        position={[0, 0, 0]}
        color={hasBlackHole ? '#EF4444' : '#F59E0B'}
        intensity={hasHighTier ? 3.0 : 1.0}
        distance={30}
        decay={2}
      />

      {/* Secondary fill light from above */}
      <pointLight position={[0, 8, 0]} color="#ffffff" intensity={0.15} distance={20} decay={2} />

      {/* Rim fill light */}
      <directionalLight position={[5, 3, 5]} intensity={0.15} color="#ffffff" />

      {/* Dual starfield background (like bituniverse - two layers at different speeds) */}
      <Stars radius={50} depth={40} count={1200} factor={3} saturation={0.1} fade speed={0.3} />
      <Stars radius={80} depth={60} count={800} factor={2} saturation={0.2} fade speed={0.1} />

      {/* Orbital rings */}
      {activeTiers.map((tier) => (
        <OrbitalRing key={tier} tier={tier} />
      ))}

      {/* Black holes - stationary at center */}
      {blackHoles.map((body) => (
        <BlackHole key={body.id} body={body} showTooltip={activeBodyId === body.id} onHover={onBodyHover} />
      ))}

      {/* Orbiting celestial bodies */}
      {bodiesWithIndex.map(({ body, index, totalInTier }) => (
        <CelestialBody
          key={body.id}
          body={body}
          index={index}
          totalInTier={totalInTier}
          showTooltip={activeBodyId === body.id}
          onHover={onBodyHover}
        />
      ))}

      {/* Incoming buy orders as wireframe satellites */}
      {buyOrders.map((order, i) => (
        <IncomingOrder
          key={order.orderId || i}
          order={order}
          index={i}
          total={buyOrders.length}
        />
      ))}

      {/* Bloom post-processing (inspired by bituniverse's UnrealBloomPass) */}
      <EffectComposer>
        <Bloom
          luminanceThreshold={0.3}
          luminanceSmoothing={0.8}
          intensity={0.8}
          radius={0.6}
          mipmapBlur
        />
      </EffectComposer>
    </>
  )
}

export default CelestialScene
