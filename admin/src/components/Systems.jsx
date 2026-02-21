import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import CelestialScene from './celestial/CelestialScene'
import { TIER_COLORS, TIER_EMOJIS } from './celestial/celestialConstants'

/**
 * Debug/showcase page: renders a full hierarchical system with one of every
 * body type orbiting at proper scale, exactly like the real trading view.
 * Hover any body to see its tooltip.
 */

// Realistic mock bodies — cost basis descending so hierarchy sorts correctly.
// Each tier gets proportional capital to show relative sizing.
const SHOWCASE_BODIES = [
  {
    id: 'showcase-black_hole',
    tier: 'black_hole',
    symbol: 'BTC',
    costBasis: 25000,
    tpPrice: 0,
    mergeCount: 8,
    assetQty: 0.5,
    avgPrice: 50000,
    currentPrice: 65000,
  },
  {
    id: 'showcase-galaxy',
    tier: 'galaxy',
    symbol: 'BTC',
    costBasis: 12000,
    tpPrice: 72000,
    mergeCount: 6,
    assetQty: 0.22,
    avgPrice: 54545,
    currentPrice: 65000,
  },
  {
    id: 'showcase-hypergiant',
    tier: 'hypergiant',
    symbol: 'BTC',
    costBasis: 6000,
    tpPrice: 68000,
    mergeCount: 4,
    assetQty: 0.1,
    avgPrice: 60000,
    currentPrice: 65000,
  },
  {
    id: 'showcase-sun',
    tier: 'sun',
    symbol: 'BTC',
    costBasis: 3000,
    tpPrice: 66000,
    mergeCount: 2,
    assetQty: 0.05,
    avgPrice: 60000,
    currentPrice: 65000,
  },
  {
    id: 'showcase-planet',
    tier: 'planet',
    symbol: 'BTC',
    costBasis: 1500,
    tpPrice: 67000,
    mergeCount: 3, // triggers Saturn rings
    assetQty: 0.025,
    avgPrice: 60000,
    currentPrice: 65000,
  },
  {
    id: 'showcase-moon',
    tier: 'moon',
    symbol: 'BTC',
    costBasis: 500,
    tpPrice: 66500,
    mergeCount: 1,
    assetQty: 0.008,
    avgPrice: 62500,
    currentPrice: 65000,
  },
  {
    id: 'showcase-satellite',
    tier: 'satellite',
    symbol: 'BTC',
    costBasis: 150,
    tpPrice: 66000,
    mergeCount: 0,
    assetQty: 0.0024,
    avgPrice: 62500,
    currentPrice: 65000,
  },
  {
    id: 'showcase-satellite-2',
    tier: 'satellite',
    symbol: 'BTC',
    costBasis: 100,
    tpPrice: 65500,
    mergeCount: 0,
    assetQty: 0.0016,
    avgPrice: 62500,
    currentPrice: 65000,
  },
]

const MOCK_BUY_ORDERS = [
  { orderId: 'incoming-1', side: 'buy', size: '0.001', price: '64000' },
  { orderId: 'incoming-2', side: 'buy', size: '0.001', price: '63500' },
]

const MAX_USDC = 25000

const TIER_ORDER = ['black_hole', 'galaxy', 'hypergiant', 'sun', 'planet', 'moon', 'satellite']

const Systems = () => (
  <div>
    <h2 className="text-xl font-bold text-white mb-4">Systems — Celestial Body Showcase</h2>
    <p className="text-gray-400 text-sm mb-4">
      Full hierarchical system with every body type at scale. Hover any body for details. Drag to orbit, scroll to zoom.
    </p>
    <div className="rounded-lg overflow-hidden border border-gray-700" style={{ aspectRatio: '16/10' }}>
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 8, 12], fov: 45, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: false }}
        onCreated={({ gl }) => gl.setClearColor('#0f0f14')}
      >
        <Suspense fallback={null}>
          <CelestialScene
            bodies={SHOWCASE_BODIES}
            buyOrders={MOCK_BUY_ORDERS}
            maxUsdcDeployed={MAX_USDC}
          />
        </Suspense>
      </Canvas>
    </div>
    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      {TIER_ORDER.map((tier) => (
        <div key={tier} className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: TIER_COLORS[tier] }}
          />
          <span className="text-gray-300">{TIER_EMOJIS[tier]} {tier.replace('_', ' ')}</span>
        </div>
      ))}
    </div>
  </div>
)

export default Systems
