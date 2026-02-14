import { Html } from '@react-three/drei'
import { TIER_EMOJIS } from './celestialConstants'

const getPriceDecimals = (price) => {
  if (!price || price >= 100) return 2
  if (price >= 1) return 4
  return 5
}
const fmtPrice = (p) => {
  if (p == null || isNaN(p)) return '-'
  const d = getPriceDecimals(p)
  return p.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

/**
 * HTML overlay tooltip shown on hover over a celestial body
 */
const CelestialTooltip = ({ body, position, maxUsdcDeployed, baseCurrency = 'BTC' }) => {
  const emoji = TIER_EMOJIS[body.tier] || '🛰️'
  const pnlPercent = body.avgPrice > 0 && body.tpPrice > 0
    ? ((body.tpPrice - body.avgPrice) / body.avgPrice * 100).toFixed(2)
    : '—'
  const capitalPct = maxUsdcDeployed > 0
    ? ((body.costBasis / maxUsdcDeployed) * 100).toFixed(1)
    : '—'

  return (
    <Html position={position} center style={{ pointerEvents: 'none' }}>
      <div className="bg-gray-900/95 border border-gray-600 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl backdrop-blur-sm" style={{ transform: 'translateY(-60px)' }}>
        <div className="font-medium text-white mb-1">
          {emoji} {body.tier.replace('_', ' ')}
          {body.mergeCount > 0 && <span className="text-gray-400 ml-1">×{body.mergeCount + 1}</span>}
          <span className="text-cyan-400 ml-1">{capitalPct}%</span>
        </div>
        <div className="space-y-0.5 text-gray-300">
          <div>{baseCurrency}: <span className="text-orange-400 font-mono">{body.assetQty?.toFixed(6)}</span></div>
          <div>Cost: <span className="text-white font-mono">${body.costBasis?.toFixed(2)}</span></div>
          <div>Avg: <span className="text-white font-mono">${fmtPrice(body.avgPrice)}</span></div>
          {body.tpPrice > 0 && (
            <div>TP: <span className="text-purple-400 font-mono">${fmtPrice(body.tpPrice)}</span> <span className="text-green-400">+{pnlPercent}%</span></div>
          )}
        </div>
      </div>
    </Html>
  )
}

export default CelestialTooltip
