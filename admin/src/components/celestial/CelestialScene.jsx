import { useMemo } from 'react'
import { Stars, OrbitControls } from '@react-three/drei'
import CelestialBody from './CelestialBody'
import OrbitalRing from './OrbitalRing'
import IncomingOrder from './IncomingOrder'
import { TIER_ORDER } from './celestialConstants'

/**
 * R3F scene composition: lights, stars, orbital rings, bodies, controls
 */
const CelestialScene = ({ bodies = [], buyOrders = [] }) => {
  // Count bodies per tier for angle offset distribution
  const tierCounts = useMemo(() => {
    const counts = {}
    for (const body of bodies) {
      counts[body.tier] = (counts[body.tier] || 0) + 1
    }
    return counts
  }, [bodies])

  // Track per-tier index for each body
  const bodiesWithIndex = useMemo(() => {
    const tierIdx = {}
    return bodies.map((body) => {
      tierIdx[body.tier] = (tierIdx[body.tier] || 0)
      const index = tierIdx[body.tier]
      tierIdx[body.tier] += 1
      return { body, index, totalInTier: tierCounts[body.tier] || 1 }
    })
  }, [bodies, tierCounts])

  // Determine if we have high-tier bodies for brighter central light
  const hasHighTier = bodies.some(b => ['sun', 'hypergiant', 'black_hole'].includes(b.tier))

  // Active tiers that need orbital rings
  const activeTiers = useMemo(() =>
    TIER_ORDER.filter(t => t !== 'black_hole'),
  [])

  return (
    <>
      {/* Camera controls */}
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.3}
        enablePan={false}
        minDistance={4}
        maxDistance={20}
        maxPolarAngle={Math.PI * 0.85}
        minPolarAngle={Math.PI * 0.15}
      />

      {/* Ambient light */}
      <ambientLight intensity={hasHighTier ? 0.15 : 0.3} />

      {/* Central point light */}
      <pointLight
        position={[0, 0, 0]}
        color="#F59E0B"
        intensity={hasHighTier ? 2.5 : 0.8}
        distance={25}
        decay={2}
      />

      {/* Rim fill light */}
      <directionalLight position={[5, 3, 5]} intensity={0.2} color="#ffffff" />

      {/* Starfield background */}
      <Stars radius={50} depth={40} count={1500} factor={3} saturation={0.1} fade speed={0.5} />

      {/* Orbital rings */}
      {activeTiers.map((tier) => (
        <OrbitalRing key={tier} tier={tier} />
      ))}

      {/* Celestial bodies */}
      {bodiesWithIndex.map(({ body, index, totalInTier }) => (
        <CelestialBody
          key={body.id}
          body={body}
          index={index}
          totalInTier={totalInTier}
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
    </>
  )
}

export default CelestialScene
