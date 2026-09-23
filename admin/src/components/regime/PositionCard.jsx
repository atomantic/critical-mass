import React, { useState } from 'react'
import { formatPriceByMagnitude, formatCurrency } from '../charts/chartUtils'
import CapitalAdjust from './CapitalAdjust'

/**
 * RegimeDashboard "Position" card — current position, unrealized/realized
 * P&L, the Recalculate-from-fills flow, and the APY/Returns section (which
 * embeds <CapitalAdjust> for the "Available capital" inline form). Owns its
 * own recalculate draft/in-flight state; the parent supplies fetched
 * status/config data and the shared refetch/toast callbacks.
 */
function PositionCard({ position, apy, market, celestial, config, asset, isDryRun, dryRunState, exchange, pairQuery, fetchConfig, fetchStatus, addToast }) {
  const [recalculating, setRecalculating] = useState(false)
  const [recalcPreview, setRecalcPreview] = useState(null)

  const handleRecalculatePreview = async () => {
    setRecalculating(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/recalculate${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: false }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success) {
        setRecalcPreview(data)
      } else {
        addToast?.({ type: 'error', title: 'Recalculate failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Recalculate failed', message: err.message })
    } finally {
      setRecalculating(false)
    }
  }

  const handleRecalculateApply = async () => {
    setRecalculating(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/recalculate${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: true }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success) {
        setRecalcPreview(null)
        await fetchStatus?.()
      } else {
        addToast?.({ type: 'error', title: 'Recalculate failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Recalculate failed', message: err.message })
    } finally {
      setRecalculating(false)
    }
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-400">Position</h3>
        <div className="flex items-center gap-2">
          {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
          <span className="text-xs text-gray-400">Buys {position.cycleBuys || position.ladderStep || 0}/{config?.maxCycleBuys || 10}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div className="min-w-0">
          <div className="text-gray-400">{asset} Held</div>
          <div className="text-orange-400 font-mono truncate">{position.totalAsset?.toFixed(8) || '0'}</div>
        </div>
        <div className="min-w-0">
          <div className="text-gray-400">On Order</div>
          <div className="text-yellow-400 font-mono truncate">{(isDryRun && dryRunState?.pnl?.assetOnOrder ? dryRunState.pnl.assetOnOrder : position.assetOnOrder || 0).toFixed(8)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-gray-400">Reserves</div>
          <div className="text-cyan-400 font-mono truncate">{(position.realizedAssetPnL || 0).toFixed(8)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-gray-400">Cost Basis</div>
          <div className="text-white font-mono truncate">${position.totalCostBasis?.toFixed(2) || '0'}</div>
        </div>
        <div className="min-w-0">
          <div className="text-gray-400">Avg Cost</div>
          <div className="text-white font-mono truncate">${formatPriceByMagnitude(position.avgCostBasis)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-gray-400">Cycle</div>
          <div className="text-white font-mono">{(position.cyclesCompleted || 0) + 1}</div>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-gray-700 grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-900/50 rounded p-2 min-w-0">
          <div className="text-gray-400">Unrealized P&L</div>
          <div className={`font-mono text-base ${position.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(position.unrealizedPnL || 0)}
          </div>
        </div>
        <div className="bg-gray-900/50 rounded p-2 min-w-0">
          {(() => {
            const usdPnL = position.realizedPnL || 0
            const assetPnL = position.realizedAssetPnL || 0
            const assetUsd = assetPnL * (market.lastPrice || 0)
            // Percent should match the displayed USD figure: realized USD over what was actually deposited.
            // Don't conflate with held-asset value at current price (volatile, grows with BTC price).
            const denom = apy.depositedCapital || apy.originalCapital || apy.initialCapital || 0
            const pct = denom > 0 ? (usdPnL / denom) * 100 : 0
            return <>
              <div className="text-gray-400 truncate">Realized P&L {pct ? `(${pct.toFixed(2)}%)` : ''}</div>
              <div className={`font-mono text-base ${usdPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {formatCurrency(usdPnL)}
              </div>
              {assetPnL > 0 && (
                <div className="text-orange-400 text-xs font-mono">
                  <div className="truncate">Holdback: +{assetPnL.toFixed(8)} {asset}</div>
                  {assetUsd > 0 && <div className="truncate">{formatCurrency(assetUsd)}</div>}
                </div>
              )}
            </>
          })()}
        </div>
      </div>

      {/* Celestial Bodies Summary */}
      {celestial?.enabled && (
        <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Celestial Bodies</span>
            <span className="text-cyan-400 font-mono">{celestial.bodiesActive || 0} active / {celestial.bodiesCompleted || 0} completed</span>
          </div>
        </div>
      )}

      {/* Recalculate Button */}
      {!recalcPreview && (
        <button
          onClick={handleRecalculatePreview}
          disabled={recalculating}
          className="mt-2 w-full text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-50 transition-colors"
        >
          {recalculating ? 'Calculating...' : 'Recalculate from Fills'}
        </button>
      )}

      {/* Recalculate Preview Modal */}
      {recalcPreview && (
        <div className="mt-3 p-3 bg-gray-900 rounded border border-yellow-600/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-yellow-400">Recalculate Preview</span>
            <button
              onClick={() => setRecalcPreview(null)}
              className="text-gray-400 hover:text-white"
            >
              ×
            </button>
          </div>

          {recalcPreview.orphansFixed > 0 && (
            <div className="text-xs text-blue-400 mb-2">
              Will fix {recalcPreview.orphansFixed} fills with missing cycle ID
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 text-xs mb-3">
            <div className="text-gray-400">Field</div>
            <div className="text-gray-400">Before</div>
            <div className="text-gray-400">After</div>

            <div className="text-gray-300">Cycles</div>
            <div className="text-gray-400">{recalcPreview.changes?.cyclesCompleted?.before}</div>
            <div className={recalcPreview.changes?.cyclesCompleted?.before !== recalcPreview.changes?.cyclesCompleted?.after ? 'text-yellow-400' : 'text-gray-400'}>
              {recalcPreview.changes?.cyclesCompleted?.after}
            </div>

            <div className="text-gray-300">P&L</div>
            <div className="text-gray-400">{formatCurrency(recalcPreview.changes?.realizedPnL?.before)}</div>
            <div className={recalcPreview.changes?.realizedPnL?.before !== recalcPreview.changes?.realizedPnL?.after ? 'text-yellow-400' : 'text-gray-400'}>
              {formatCurrency(recalcPreview.changes?.realizedPnL?.after)}
            </div>

            <div className="text-gray-300">{asset} Reserves</div>
            <div className="text-gray-400">{recalcPreview.changes?.realizedAssetPnL?.before?.toFixed(8)}</div>
            <div className={recalcPreview.changes?.realizedAssetPnL?.before !== recalcPreview.changes?.realizedAssetPnL?.after ? 'text-cyan-400' : 'text-gray-400'}>
              {recalcPreview.changes?.realizedAssetPnL?.after?.toFixed(8)}
            </div>

            <div className="text-gray-300">Cycle Buys</div>
            <div className="text-gray-400">{recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before}</div>
            <div className={(recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before) !== (recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after) ? 'text-yellow-400' : 'text-gray-400'}>
              {recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after}
            </div>
          </div>

          {recalcPreview.cycleDetails?.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-400 mb-1">Completed Cycles:</div>
              {recalcPreview.cycleDetails.map((cycle, i) => (
                <div key={i} className="text-xs text-gray-400 pl-2">
                  {cycle.cycleId?.replace('cycle-', '#')} - {cycle.buys} buys, P&L: ${cycle.pnl?.toFixed(2)}, holdback: {cycle.holdbackAsset?.toFixed(8)} {asset}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleRecalculateApply}
              disabled={recalculating}
              className="flex-1 text-xs px-3 py-1.5 rounded bg-yellow-800 hover:bg-yellow-900 text-white disabled:opacity-50"
            >
              {recalculating ? 'Applying...' : 'Apply Changes'}
            </button>
            <button
              onClick={() => setRecalcPreview(null)}
              className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* APY & Returns Section */}
      {apy.engineStartTime && (
        <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-400 mb-2">
            <span>Deposited: ${(apy.depositedCapital || apy.originalCapital || apy.initialCapital)?.toLocaleString()}</span>
            <span className="text-green-400">Max: ${(apy.maxUsdcDeployed || apy.currentCapital)?.toLocaleString()}</span>
            <CapitalAdjust apy={apy} exchange={exchange} pairQuery={pairQuery} fetchConfig={fetchConfig} fetchStatus={fetchStatus} addToast={addToast} />
            <span>Running: {apy.elapsedDays?.toFixed(1)}d</span>
            <span>{apy.cyclesPerDay?.toFixed(1)} cycles/day</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-green-900/20 border border-green-700/30 rounded p-1.5 min-w-0">
              <div className="text-green-400/70 text-[10px]">Daily ({(apy.dailyReturnPercent || 0).toFixed(2)}%)</div>
              <div className="flex flex-col font-mono text-xs min-w-0">
                <span className="text-green-400">{formatCurrency(apy.estimatedDailyUsdc || 0)} + <span className="text-orange-400">{(apy.estimatedDailyAsset || 0).toFixed(8)}</span></span>
                <span className="text-green-400">= {formatCurrency((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyAsset || 0) * (market.lastPrice || 0))}</span>
              </div>
            </div>
            <div className="bg-cyan-900/20 border border-cyan-700/30 rounded p-1.5 min-w-0">
              <div className="text-cyan-400/70 text-[10px]">Annual ({(apy.estimatedApy || 0) > 9999 ? '>9999' : (apy.estimatedApy || 0).toFixed(0)}% APY)</div>
              <div className="flex flex-col font-mono text-xs min-w-0">
                <span className="text-green-400">{formatCurrency((apy.estimatedDailyUsdc || 0) * 365)} + <span className="text-orange-400">{((apy.estimatedDailyAsset || 0) * 365).toFixed(6)} {asset}</span></span>
                <span className="text-cyan-400">= {formatCurrency(((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyAsset || 0) * (market.lastPrice || 0)) * 365)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {isDryRun && dryRunState?.pnl && (
        <div className="mt-3 pt-3 border-t border-gray-700 text-xs">
          <div className="text-purple-400 mb-1">Dry-Run Stats</div>
          <div className="grid grid-cols-2 gap-2 text-gray-400">
            <div className="min-w-0 truncate">Simulated Buys: {dryRunState.pnl.totalBought?.toFixed(8) || 0} {asset}</div>
            <div className="min-w-0 truncate">Simulated Sells: {dryRunState.pnl.totalSold?.toFixed(8) || 0} {asset}</div>
            <div className="min-w-0 truncate">{asset} on Order: <span className="text-yellow-400">{dryRunState.pnl.assetOnOrder?.toFixed(8) || 0}</span></div>
            <div className="min-w-0 truncate">{asset} Reserves: <span className="text-cyan-400">{position.realizedAssetPnL?.toFixed(8) || 0}</span></div>
            <div>Filled Orders: {dryRunState.pnl.filledOrderCount || 0}</div>
            <div>Avg Entry: ${formatPriceByMagnitude(dryRunState.pnl.avgEntryPrice)}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default PositionCard
