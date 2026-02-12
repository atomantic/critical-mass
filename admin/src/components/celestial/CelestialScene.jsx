import { useMemo, useState, useCallback } from 'react'
import { Stars, OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import HierarchicalOrbit from './HierarchicalOrbit'
import IncomingOrder from './IncomingOrder'
import { TIER_RANK } from './celestialConstants'

/**
 * R3F scene composition: lights, stars, hierarchical orbits, bloom, controls.
 * Bodies are sorted largest-first; the largest sits at center and each
 * subsequent body orbits the next-larger one in a nested chain.
 */
const CelestialScene = ({ bodies = [], buyOrders = [], maxUsdcDeployed }) => {
  // Sort bodies: tier rank ascending (higher tier = closer to center), then costBasis desc
  const sortedBodies = useMemo(() =>
    [...bodies].sort((a, b) => {
      const rankDiff = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99)
      if (rankDiff !== 0) return rankDiff
      return b.costBasis - a.costBasis
    }),
  [bodies])

  const hasHighTier = bodies.some(b => ['sun', 'hypergiant', 'galaxy', 'black_hole'].includes(b.tier))
  const hasBlackHole = bodies.some(b => b.tier === 'black_hole')

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

      {/* Fog for depth */}
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

      {/* Dual starfield background */}
      <Stars radius={50} depth={40} count={1200} factor={3} saturation={0.1} fade speed={0.3} />
      <Stars radius={80} depth={60} count={800} factor={2} saturation={0.2} fade speed={0.1} />

      {/* Hierarchical celestial bodies - largest at center, each smaller orbits the next-larger */}
      <HierarchicalOrbit
        bodies={sortedBodies}
        activeBodyId={activeBodyId}
        onBodyHover={onBodyHover}
        maxUsdcDeployed={maxUsdcDeployed}
      />

      {/* Incoming buy orders as wireframe satellites */}
      {buyOrders.map((order, i) => (
        <IncomingOrder
          key={order.orderId || i}
          order={order}
          index={i}
          total={buyOrders.length}
        />
      ))}

      {/* Bloom post-processing */}
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
