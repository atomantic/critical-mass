import React from 'react'
import { plural } from '../../utils/plural.mjs'

export default function SizeOptimizerPanel({ sizeOptimizer }) {
  return (
    <>
      {sizeOptimizer.enabled && (
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-gray-400">Size Auto-Management</h3>
            <span className="px-1.5 py-0.5 bg-green-900/50 text-green-400 text-[10px] rounded-sm">
              Active
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {/* Current Sizing Config */}
            <div className="p-2 bg-gray-900/50 rounded-sm">
              <div className="text-gray-400 text-[10px] mb-1">Current Size Settings</div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <span className="text-gray-400">Base:</span>{' '}
                  <span className="text-white font-mono">${sizeOptimizer.currentConfig?.baseSizeUsdc}</span>
                </div>
                <div>
                  <span className="text-gray-400">Cap:</span>{' '}
                  <span className="text-white font-mono">${sizeOptimizer.currentConfig?.maxUsdcDeployed?.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-gray-400">Max Buys:</span>{' '}
                  <span className="text-white font-mono">{sizeOptimizer.currentConfig?.maxCycleBuys}</span>
                </div>
              </div>
            </div>

            {/* Cycle Stats */}
            {sizeOptimizer.totalCycleCount >= 3 && (
              <div className="p-2 bg-purple-900/20 border border-purple-700/30 rounded-sm">
                <div className="text-purple-400/70 text-[10px] mb-1">Step Usage ({plural(sizeOptimizer.totalCycleCount, "cycle")})</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-gray-400">Avg:</span>{' '}
                    <span className="text-purple-400 font-mono">{sizeOptimizer.stats?.avgStepsUsed?.toFixed(1)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">P90:</span>{' '}
                    <span className="text-purple-400 font-mono">{sizeOptimizer.stats?.p90StepsUsed}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Balance:</span>{' '}
                    <span className="text-white font-mono">${sizeOptimizer.lastKnownBalance?.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Evaluation Status */}
            <div className="flex justify-between text-gray-400 text-[10px]">
              <span>Cycles since eval: {sizeOptimizer.cyclesSinceEval || 0}</span>
              <span>Samples: {sizeOptimizer.recentCycleCount || 0}</span>
            </div>

            {/* Recent Adjustments */}
            {sizeOptimizer.adjustmentHistory?.length > 0 && (
              <div className="pt-2 border-t border-gray-700">
                <div className="text-gray-400 text-[10px] mb-1">Recent Adjustments</div>
                <div className="space-y-0.5 max-h-16 overflow-y-auto">
                  {sizeOptimizer.adjustmentHistory.slice(-3).reverse().map((adj, idx) => (
                    <div key={idx} className="text-[10px] text-gray-400 flex justify-between">
                      <span>{new Date(adj.timestamp).toLocaleTimeString()}</span>
                      <span className="text-purple-400">{adj.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
