import { useMemo, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import CelestialScene from './CelestialScene'
import { TIER_COLORS, TIER_EMOJIS, TIER_ORDER } from './celestialConstants'

/**
 * Card wrapper: header, 3D canvas container, and legend
 */
const CelestialVisualization = ({ celestial, pendingOrders = [], currentPrice, maxUsdcDeployed }) => {
  const bodies = celestial?.bodies || []
  const enabled = celestial?.enabled

  // Filter open buy orders
  const buyOrders = useMemo(() =>
    (pendingOrders || []).filter(o => o.side === 'buy' && o.status === 'open'),
  [pendingOrders])

  // Count bodies per tier for legend
  const tierSummary = useMemo(() => {
    const counts = {}
    for (const body of bodies) {
      counts[body.tier] = (counts[body.tier] || 0) + 1
    }
    return counts
  }, [bodies])

  if (!enabled) return null

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-400">Celestial System</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-cyan-400 font-mono">{bodies.length} bodies</span>
          {buyOrders.length > 0 && (
            <span className="text-gray-500 font-mono">+{buyOrders.length} incoming</span>
          )}
        </div>
      </div>

      {/* 3D Canvas container - 16:10 aspect ratio */}
      <div className="relative w-full rounded-lg overflow-hidden" style={{ aspectRatio: '16/10', background: '#0f0f14' }}>
        {bodies.length === 0 && buyOrders.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs">
            No celestial bodies yet
          </div>
        ) : (
          <Suspense fallback={
            <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs">
              Loading 3D scene...
            </div>
          }>
            <Canvas
              dpr={[1, 1.5]}
              camera={{ position: [0, 8, 12], fov: 45, near: 0.1, far: 100 }}
              gl={{ antialias: true, alpha: false }}
              onCreated={({ gl }) => { gl.setClearColor('#0f0f14') }}
            >
              <CelestialScene bodies={bodies} buyOrders={buyOrders} maxUsdcDeployed={maxUsdcDeployed} />
            </Canvas>
          </Suspense>
        )}
      </div>

      {/* Tier legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px]">
        {TIER_ORDER.map((tier) => {
          const count = tierSummary[tier]
          if (!count) return null
          return (
            <div key={tier} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
              <span className="text-gray-400">
                {TIER_EMOJIS[tier]} {tier.replace('_', ' ')} <span className="text-gray-500">×{count}</span>
              </span>
            </div>
          )
        })}
        {buyOrders.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full border border-gray-500" style={{ background: 'transparent' }} />
            <span className="text-gray-500">incoming ×{buyOrders.length}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default CelestialVisualization
