import { useMemo, useState, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Pause, Play } from 'lucide-react'
import CelestialScene from './CelestialScene'
import { TIER_COLORS, TIER_EMOJIS, TIER_ORDER } from './celestialConstants'
import useReducedMotion from '../../hooks/useReducedMotion'

const MOTION_PAUSED_STORAGE_KEY = 'celestial-motion-paused'

// Explicit operator choice wins over the OS preference; null means "follow
// the media query" (the default until the operator touches the toggle).
function readStoredMotionPreference() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(MOTION_PAUSED_STORAGE_KEY)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

/**
 * Card wrapper: header, 3D canvas container, and legend
 */
const CelestialVisualization = ({ celestial, pendingOrders = [], currentPrice, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const bodies = celestial?.bodies || []
  const enabled = celestial?.enabled

  const prefersReducedMotion = useReducedMotion()
  const [explicitMotionPaused, setExplicitMotionPaused] = useState(readStoredMotionPreference)
  const motionPaused = explicitMotionPaused ?? prefersReducedMotion

  const toggleMotionPaused = () => {
    const next = !motionPaused
    setExplicitMotionPaused(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MOTION_PAUSED_STORAGE_KEY, String(next))
    }
  }

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

  // Accessible name for the canvas, since a 3D scene has no text content of
  // its own — mirrors the tier legend below it.
  const canvasLabel = useMemo(() => {
    const tierParts = TIER_ORDER
      .filter(tier => tierSummary[tier])
      .map(tier => `${tierSummary[tier]} ${tier.replace('_', ' ')}`)
    const parts = [...tierParts]
    if (buyOrders.length > 0) parts.push(`${buyOrders.length} incoming buy order${buyOrders.length === 1 ? '' : 's'}`)
    return parts.length > 0 ? `Celestial system: ${parts.join(', ')}` : 'Celestial system: no bodies yet'
  }, [tierSummary, buyOrders.length])

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
          <button
            type="button"
            onClick={toggleMotionPaused}
            aria-pressed={motionPaused}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500"
            title={motionPaused ? 'Resume motion' : 'Pause motion'}
          >
            {motionPaused ? <Play size={12} /> : <Pause size={12} />}
            <span>{motionPaused ? 'Paused' : 'Pause motion'}</span>
          </button>
        </div>
      </div>

      {/* 3D Canvas container - 16:10 aspect ratio */}
      <div
        className="relative w-full rounded-lg overflow-hidden"
        style={{ aspectRatio: '16/10', background: '#0f0f14' }}
        role="img"
        aria-label={canvasLabel}
      >
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
              frameloop={motionPaused ? 'demand' : 'always'}
              onCreated={({ gl }) => { gl.setClearColor('#0f0f14') }}
            >
              <CelestialScene bodies={bodies} buyOrders={buyOrders} maxUsdcDeployed={maxUsdcDeployed} baseCurrency={baseCurrency} reducedMotion={motionPaused} />
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
