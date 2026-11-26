import Button from './ui/Button'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import useCanvasActive from '../hooks/useCanvasActive'
import useReducedMotion from '../hooks/useReducedMotion'
import BloomEffect from './celestial/BloomEffect'
import OrbitControlsLite from './celestial/OrbitControlsLite'
import CelestialScene from './celestial/CelestialScene'
import CelestialBody from './celestial/CelestialBody'
import BlackHole from './celestial/BlackHole'
import GalaxyBody from './celestial/GalaxyBody'
import NebulaBody from './celestial/NebulaBody'
import { TIERS as CELESTIAL_TIERS, formatTierPctRange } from '../../../shared/celestial-tiers.mjs'
import { TIER_COLORS, TIER_EMOJIS, TIER_DESCRIPTIONS, TIER_ORDER } from './celestial/celestialConstants'

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

const TIER_RANGES = Object.fromEntries(CELESTIAL_TIERS.map(t => [t.name, formatTierPctRange(t)]))

const CAMERA_VIEWS = {
  perspective: { position: [0, 12, 18], name: 'Perspective' },
  top:         { position: [0, 25, 0.1], name: 'Top Down' },
  side:        { position: [25, 2, 0], name: 'Side' },
  close:       { position: [0, 6, 8], name: 'Close' },
}

const NOOP = () => {}
const SHOWCASE_CAMERA = { position: CAMERA_VIEWS.perspective.position, fov: 50, near: 0.1, far: 150 }
const TIER_CAMERA = [0, 2, 4]
const TIER_BODIES = Object.fromEntries(TIER_ORDER.map(tier => [tier, SHOWCASE_BODIES.find(body => body.tier === tier)]))

const CameraController = ({ targetView, controlsRef }) => {
  const camera = useThree(state => state.camera)
  const invalidate = useThree(state => state.invalidate)

  useEffect(() => {
    camera.position.set(...(CAMERA_VIEWS[targetView]?.position ?? TIER_CAMERA))
    camera.lookAt(0, 0, 0)
    const controls = controlsRef.current
    if (controls) {
      controls.target.set(0, 0, 0)
      controls.update()
    }
    invalidate()
  }, [targetView, camera, controlsRef, invalidate])

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

const SingleBodyScene = ({ body, controlsRef, paused }) => {
  const bodyProps = { body, showTooltip: false, onHover: NOOP, maxUsdcDeployed: MAX_USDC, baseCurrency: 'BTC' }

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[0, 3, 3]} intensity={1.5} distance={15} decay={2} />
      <pointLight position={[0, 0, 0]} color={TIER_COLORS[body.tier]} intensity={0.8} distance={10} decay={2} />

      <OrbitControlsLite ref={controlsRef} enablePan={false} enableZoom={false} autoRotate={!paused} autoRotateSpeed={1.5} minPolarAngle={Math.PI * 0.3} maxPolarAngle={Math.PI * 0.7} />

      {renderBody(bodyProps)}

      <BloomEffect threshold={0.78} strength={0.22} radius={0.4} smoothWidth={0.18} />
    </>
  )
}

const Systems = () => {
  const [{ view, revision }, setSelection] = useState({ view: 'perspective', revision: 0 })
  const controlsRef = useRef(null)
  const showcaseRef = useRef(null)
  const { active, everInView } = useCanvasActive(showcaseRef)
  const reducedMotion = useReducedMotion()
  const paused = reducedMotion || !active
  const selectedBody = TIER_BODIES[view]

  const selectView = (view) => setSelection(previous => ({ view, revision: previous.revision + 1 }))
  const previewTier = (tier) => {
    selectView(tier)
    showcaseRef.current?.focus({ preventScroll: true })
    showcaseRef.current?.scrollIntoView?.({ block: 'nearest' })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">Celestial Body Showcase</h2>
        <p className="text-gray-400 text-sm">
          {selectedBody
            ? 'Drag to orbit the selected body. Choose a camera view to return to the full system.'
            : 'Full hierarchical system with every body type at scale. Drag to orbit, scroll to zoom, right-click to pan.'}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-gray-400 text-xs uppercase tracking-wider mr-1">View:</span>
        {Object.entries(CAMERA_VIEWS).map(([key, cameraView]) => (
          <Button
            key={key}
            onClick={() => selectView(key)}
            aria-pressed={view === key}
            variant={view === key ? 'accent' : 'secondary'} size="compact-xs"
          >
            {cameraView.name}
          </Button>
        ))}
      </div>

      <div ref={showcaseRef} tabIndex={-1} role="region" aria-label={selectedBody ? `${view.replace('_', ' ')} preview` : 'Celestial system preview'} className="rounded-lg overflow-hidden border border-gray-700 bg-gray-900" style={{ aspectRatio: '16/9' }}>
        {everInView && (
          <Canvas
            dpr={[1, 1.5]}
            camera={SHOWCASE_CAMERA}
            frameloop={paused ? 'demand' : 'always'}
            gl={{ antialias: true, alpha: false }}
            onCreated={({ gl }) => gl.setClearColor('#0f0f14')}
          >
            <Suspense fallback={null}>
              {selectedBody
                ? <SingleBodyScene key={view} body={selectedBody} controlsRef={controlsRef} paused={paused} />
                : <CelestialScene bodies={SHOWCASE_BODIES} buyOrders={MOCK_BUY_ORDERS} maxUsdcDeployed={MAX_USDC} controlsRef={controlsRef} reducedMotion={paused} />}
              <CameraController key={revision} targetView={view} controlsRef={controlsRef} />
            </Suspense>
          </Canvas>
        )}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2 text-sm">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded-sm">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: TIER_COLORS[tier] }} />
            <span className="text-gray-300 truncate">{TIER_EMOJIS[tier]} {tier.replace('_', ' ')}</span>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-white mb-3">Body Types</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {TIER_ORDER.map((tier) => {
            const body = TIER_BODIES[tier]
            if (!body) return null

            return (
              <div key={tier} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden" style={{ borderTop: `2px solid ${TIER_COLORS[tier]}` }}>
                <div className="p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
                      <span className="text-white font-medium capitalize">
                        {TIER_EMOJIS[tier]} {tier.replace('_', ' ')}
                      </span>
                    </div>
                    <span
                      className="text-xs font-mono font-medium px-1.5 py-0.5 rounded-sm"
                      style={{ backgroundColor: `${TIER_COLORS[tier]}22`, color: TIER_COLORS[tier], border: `1px solid ${TIER_COLORS[tier]}55` }}
                    >{TIER_RANGES[tier]}</span>
                  </div>
                  <p className="text-gray-400 text-xs leading-relaxed">
                    {TIER_DESCRIPTIONS[tier]}
                  </p>
                  <Button type="button" onClick={() => previewTier(tier)} aria-pressed={view === tier} variant="secondary" size="compact" touchTarget="always">
                    Preview {tier.replace('_', ' ')}
                  </Button>
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
