import { Suspense, useRef, useState, useCallback, useMemo } from 'react'
import { Canvas, useThree, invalidate } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import CelestialScene from './celestial/CelestialScene'
import CelestialBody from './celestial/CelestialBody'
import BlackHole from './celestial/BlackHole'
import GalaxyBody from './celestial/GalaxyBody'
import NebulaBody from './celestial/NebulaBody'
import { TIER_COLORS, TIER_EMOJIS, TIER_DESCRIPTIONS, TIER_ORDER, STANDALONE_TIERS } from './celestial/celestialConstants'

const SHOWCASE_BODIES = [
  { id: 'showcase-black_hole', tier: 'black_hole', symbol: 'BTC', costBasis: 25000, tpPrice: 0, mergeCount: 8, assetQty: 0.5, avgPrice: 50000, currentPrice: 65000 },
  { id: 'showcase-galaxy', tier: 'galaxy', symbol: 'BTC', costBasis: 16000, tpPrice: 72000, mergeCount: 6, assetQty: 0.28, avgPrice: 57142, currentPrice: 65000 },
  { id: 'showcase-nebula', tier: 'nebula', symbol: 'BTC', costBasis: 12000, tpPrice: 70000, mergeCount: 5, assetQty: 0.2, avgPrice: 60000, currentPrice: 65000 },
  { id: 'showcase-hypergiant', tier: 'hypergiant', symbol: 'BTC', costBasis: 8500, tpPrice: 68000, mergeCount: 4, assetQty: 0.14, avgPrice: 60714, currentPrice: 65000 },
  { id: 'showcase-sun', tier: 'sun', symbol: 'BTC', costBasis: 5000, tpPrice: 66000, mergeCount: 2, assetQty: 0.08, avgPrice: 62500, currentPrice: 65000 },
  { id: 'showcase-planet', tier: 'planet', symbol: 'BTC', costBasis: 2500, tpPrice: 67000, mergeCount: 3, assetQty: 0.04, avgPrice: 62500, currentPrice: 65000 },
  { id: 'showcase-moon', tier: 'moon', symbol: 'BTC', costBasis: 800, tpPrice: 66500, mergeCount: 1, assetQty: 0.013, avgPrice: 61538, currentPrice: 65000 },
  { id: 'showcase-asteroid', tier: 'asteroid', symbol: 'BTC', costBasis: 350, tpPrice: 66200, mergeCount: 1, assetQty: 0.0056, avgPrice: 62500, currentPrice: 65000 },
  { id: 'showcase-satellite', tier: 'satellite', symbol: 'BTC', costBasis: 200, tpPrice: 66000, mergeCount: 0, assetQty: 0.0032, avgPrice: 62500, currentPrice: 65000 },
  { id: 'showcase-satellite-2', tier: 'satellite', symbol: 'BTC', costBasis: 100, tpPrice: 65500, mergeCount: 0, assetQty: 0.0016, avgPrice: 62500, currentPrice: 65000 },
]

const MOCK_BUY_ORDERS = [
  { orderId: 'incoming-1', side: 'buy', size: '0.001', price: '64000' },
  { orderId: 'incoming-2', side: 'buy', size: '0.001', price: '63500' },
]

const MAX_USDC = 25000

const TIER_RANGES = {
  satellite: '0-1%', asteroid: '1-2%', moon: '2-5%', planet: '5-15%',
  sun: '15-30%', hypergiant: '30-40%', nebula: '40-50%', galaxy: '50-75%', black_hole: '75%+',
}

const CAMERA_VIEWS = {
  perspective: { position: [0, 12, 18], name: 'Perspective' },
  top:         { position: [0, 25, 0.1], name: 'Top Down' },
  side:        { position: [25, 2, 0], name: 'Side' },
  close:       { position: [0, 6, 8], name: 'Close' },
}

const NOOP = () => {}

const CameraController = ({ targetView, controlsRef }) => {
  const { camera } = useThree()
  const prevView = useRef(null)

  if (targetView && targetView !== prevView.current) {
    prevView.current = targetView
    const view = CAMERA_VIEWS[targetView]
    if (view) {
      camera.position.set(...view.position)
      camera.lookAt(0, 0, 0)
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0)
        controlsRef.current.update()
      }
    }
  }

  return null
}

/**
 * Render the appropriate body component for a tier.
 */
const renderBody = (bodyProps) => {
  const { tier } = bodyProps.body
  if (tier === 'black_hole') return <BlackHole {...bodyProps} />
  if (tier === 'galaxy') return <GalaxyBody {...bodyProps} />
  if (tier === 'nebula') return <NebulaBody {...bodyProps} />
  return <CelestialBody {...bodyProps} />
}

/**
 * Single-body scene for tier cards. Uses frameloop="demand" + invalidate
 * to avoid running a continuous animation loop per card.
 */
const SingleBodyScene = ({ body }) => {
  const bodyProps = { body, showTooltip: false, onHover: NOOP, maxUsdcDeployed: MAX_USDC, baseCurrency: 'BTC' }
  const isParticle = STANDALONE_TIERS.has(body.tier)

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[0, 3, 3]} intensity={1.5} distance={15} decay={2} />
      <pointLight position={[0, 0, 0]} color={TIER_COLORS[body.tier]} intensity={0.8} distance={10} decay={2} />

      <OrbitControls enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={1.5} minPolarAngle={Math.PI * 0.3} maxPolarAngle={Math.PI * 0.7} />

      {renderBody(bodyProps)}

      <EffectComposer>
        <Bloom luminanceThreshold={0.3} luminanceSmoothing={0.8} intensity={isParticle ? 1.0 : 0.6} radius={0.5} mipmapBlur />
      </EffectComposer>
    </>
  )
}

const Systems = () => {
  const [activeView, setActiveView] = useState('perspective')
  const controlsRef = useRef()
  const [viewKey, setViewKey] = useState(0)

  const handleViewChange = useCallback((view) => {
    setActiveView(view)
    setViewKey(k => k + 1)
  }, [])

  const tierShowcaseBodies = useMemo(() => {
    const bodies = {}
    for (const body of SHOWCASE_BODIES) {
      if (!bodies[body.tier]) bodies[body.tier] = body
    }
    return bodies
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">Celestial Body Showcase</h2>
        <p className="text-gray-400 text-sm">
          Full hierarchical system with every body type at scale. Drag to orbit, scroll to zoom, right-click to pan.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-gray-500 text-xs uppercase tracking-wider mr-1">View:</span>
        {Object.entries(CAMERA_VIEWS).map(([key, view]) => (
          <button
            key={key}
            onClick={() => handleViewChange(key)}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              activeView === key
                ? 'bg-cyan-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {view.name}
          </button>
        ))}
      </div>

      <div className="rounded-lg overflow-hidden border border-gray-700" style={{ aspectRatio: '16/9' }}>
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [0, 12, 18], fov: 50, near: 0.1, far: 150 }}
          gl={{ antialias: true, alpha: false }}
          onCreated={({ gl }) => gl.setClearColor('#0f0f14')}
        >
          <Suspense fallback={null}>
            <CameraController key={viewKey} targetView={activeView} controlsRef={controlsRef} />
            <CelestialScene bodies={SHOWCASE_BODIES} buyOrders={MOCK_BUY_ORDERS} maxUsdcDeployed={MAX_USDC} controlsRef={controlsRef} />
          </Suspense>
        </Canvas>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2 text-sm">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: TIER_COLORS[tier] }} />
            <span className="text-gray-300 truncate">{TIER_EMOJIS[tier]} {tier.replace('_', ' ')}</span>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-white mb-3">Body Types</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {TIER_ORDER.map((tier) => {
            const body = tierShowcaseBodies[tier]
            if (!body) return null

            return (
              <div key={tier} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                <div className="h-40" style={{ background: '#0f0f14' }}>
                  <Canvas
                    dpr={[1, 1]}
                    camera={{ position: [0, 2, 4], fov: 40, near: 0.01, far: 50 }}
                    gl={{ antialias: false, alpha: false, powerPreference: 'low-power' }}
                    onCreated={({ gl }) => gl.setClearColor('#0f0f14')}
                  >
                    <Suspense fallback={null}>
                      <SingleBodyScene body={body} />
                    </Suspense>
                  </Canvas>
                </div>

                <div className="p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
                      <span className="text-white font-medium capitalize">
                        {TIER_EMOJIS[tier]} {tier.replace('_', ' ')}
                      </span>
                    </div>
                    <span className="text-gray-500 text-xs font-mono">{TIER_RANGES[tier]}</span>
                  </div>
                  <p className="text-gray-400 text-xs leading-relaxed">
                    {TIER_DESCRIPTIONS[tier]}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default Systems
