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
const CelestialScene = ({ bodies = [], buyOrders = [], maxUsdcDeployed, baseCurrency = 'BTC', controlsRef }) => {
  // Sort bodies: tier rank ascending (higher tier = closer to center), then costBasis desc
  const sortedBodies = useMemo(() =>
    [...bodies].sort((a, b) => {
      const rankDiff = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99)
      if (rankDiff !== 0) return rankDiff
      return b.costBasis - a.costBasis
    }),
  [bodies])

  const hasHighTier = bodies.some(b => ['sun', 'hypergiant', 'nebula', 'galaxy', 'black_hole'].includes(b.tier))
  const hasBlackHole = bodies.some(b => b.tier === 'black_hole')

  // Pinned tooltip: stays on last-hovered body until a different one is hovered
  const [activeBodyId, setActiveBodyId] = useState(null)
  const onBodyHover = useCallback((bodyId) => setActiveBodyId(bodyId), [])

  return (
    <>
      {/* Camera controls — pan enabled for better navigation */}
      <OrbitControls
        ref={controlsRef}
        autoRotate
        autoRotateSpeed={0.3}
        enablePan
        panSpeed={0.8}
        minDistance={4}
        maxDistance={40}
        maxPolarAngle={Math.PI * 0.85}
        minPolarAngle={Math.PI * 0.15}
      />

      {/* Fog for depth — pushed further out for wider views */}
      <fog attach="fog" args={['#0f0f14', 30, 80]} />

      {/* Ambient and Global Depth Lighting */}
      <hemisphereLight intensity={0.2} groundColor="#000000" color="#4f46e5" />
      <ambientLight intensity={hasHighTier ? 0.2 : 0.4} />

      {/* Central point light - amber/red glow from center */}
      <pointLight
        position={[0, 0, 0]}
        color={hasBlackHole ? '#EF4444' : '#F59E0B'}
        intensity={hasHighTier ? 4.0 : 2.0}
        distance={50}
        decay={1.5}
      />

      {/* Secondary fill lights for visibility on dark sides */}
      <pointLight position={[0, 10, 0]} color="#ffffff" intensity={0.5} distance={30} decay={1.5} />
      <pointLight position={[0, -10, 0]} color="#4338ca" intensity={0.3} distance={30} decay={2} />

      {/* Rim fill light */}
      <directionalLight position={[5, 3, 5]} intensity={0.4} color="#ffffff" />

      {/* Dual starfield background */}
      <Stars radius={60} depth={50} count={1500} factor={3} saturation={0.1} fade speed={0.3} />
      <Stars radius={100} depth={80} count={1000} factor={2} saturation={0.2} fade speed={0.1} />

      {/* Hierarchical celestial bodies - largest at center, each smaller orbits the next-larger */}
      <HierarchicalOrbit
        bodies={sortedBodies}
        activeBodyId={activeBodyId}
        onBodyHover={onBodyHover}
        maxUsdcDeployed={maxUsdcDeployed}
        baseCurrency={baseCurrency}
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
