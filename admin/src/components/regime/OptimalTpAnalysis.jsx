import React from 'react'
import { plural } from '../../utils/plural.mjs'
import { formatPriceByMagnitude } from '../charts/chartUtils'
import HistoricalAnalytics from './HistoricalAnalytics'

export default function OptimalTpAnalysis({ isDryRun, optimalTpAnalytics, tpMinPercent, tpMaxPercent }) {
  return (
    <>
      {isDryRun && optimalTpAnalytics && (
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-gray-400">Optimal TP Analysis</h3>
            <span className="text-[10px] text-purple-400">
              {plural(optimalTpAnalytics.cycleCount, "cycle")}
            </span>
          </div>

          {/* Current Cycle (if in position) */}
          {optimalTpAnalytics.currentCycle && (
            <div className="mb-2 p-2 bg-blue-900/30 border border-blue-700/50 rounded-sm">
              <div className="text-[10px] text-blue-400 mb-1">Current Position</div>
              <div className="grid grid-cols-2 gap-1 text-[10px]">
                <div>
                  <span className="text-gray-400">Entry:</span>{' '}
                  <span className="text-white font-mono">${formatPriceByMagnitude(optimalTpAnalytics.currentCycle.entryPrice)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Max seen:</span>{' '}
                  <span className="text-green-400 font-mono">${formatPriceByMagnitude(optimalTpAnalytics.currentCycle.currentMaxPrice)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Min seen:</span>{' '}
                  <span className="text-red-400 font-mono">${formatPriceByMagnitude(optimalTpAnalytics.currentCycle.currentMinPrice)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Optimal TP:</span>{' '}
                  <span className="text-cyan-400 font-mono">{optimalTpAnalytics.currentCycle.currentOptimalPct?.toFixed(2)}%</span>
                </div>
              </div>
            </div>
          )}

          {/* Historical Analytics */}
            <HistoricalAnalytics optimalTpAnalytics={optimalTpAnalytics} tpMinPercent={tpMinPercent} tpMaxPercent={tpMaxPercent} />
        </div>
      )}
    </>
  )
}
