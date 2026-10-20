import React from 'react'
import { plural } from '../../utils/plural.mjs'

export default function TpOptimizerPanel({ tpOptimizer }) {
  return (
    <>
      {tpOptimizer.enabled && (
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-gray-400">TP Auto-Management</h3>
            <span className="px-1.5 py-0.5 bg-green-900/50 text-green-400 text-[10px] rounded-sm">
              Active
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {/* Current Config */}
            <div className="p-2 bg-gray-900/50 rounded-sm">
              <div className="text-gray-400 text-[10px] mb-1">Current TP Settings</div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <span className="text-gray-400">Min:</span>{' '}
                  <span className="text-white font-mono">{tpOptimizer.currentConfig?.tpMinPercent?.toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-gray-400">Max:</span>{' '}
                  <span className="text-white font-mono">{tpOptimizer.currentConfig?.tpMaxPercent?.toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-gray-400">Holdback:</span>{' '}
                  <span className="text-white font-mono">{tpOptimizer.currentConfig?.holdbackRatio?.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Observed Percentiles */}
            {(tpOptimizer.totalCombinedSamples || tpOptimizer.sampleCount || 0) >= 3 && (
              <div className="p-2 bg-cyan-900/20 border border-cyan-700/30 rounded-sm">
                <div className="text-cyan-400/70 text-[10px] mb-1">Observed Percentiles ({plural(tpOptimizer.sampleCount || 0, "cycle")} + {tpOptimizer.volSampleCount || 0} vol)</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-gray-400">p25:</span>{' '}
                    <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p25?.toFixed(2)}%</span>
                  </div>
                  <div>
                    <span className="text-gray-400">p50:</span>{' '}
                    <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p50?.toFixed(2)}%</span>
                  </div>
                  <div>
                    <span className="text-gray-400">p75:</span>{' '}
                    <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p75?.toFixed(2)}%</span>
                  </div>
                </div>
              </div>
            )}

            {/* Evaluation Status */}
            <div className="flex justify-between text-gray-400 text-[10px]">
              <span>Last eval: {tpOptimizer.lastVolEvaluationTime
                ? `${Math.round((Date.now() - Math.max(tpOptimizer.lastEvaluationTime || 0, tpOptimizer.lastVolEvaluationTime || 0)) / 60000)}m ago`
                : `${plural(tpOptimizer.cyclesSinceEval || 0, "cycle")} ago`}</span>
              <span>{plural(tpOptimizer.sampleCount || 0, "cycle")} + {tpOptimizer.volSampleCount || 0} vol</span>
            </div>

            {/* Recent Adjustments */}
            {tpOptimizer.adjustmentHistory?.length > 0 && (
              <div className="pt-2 border-t border-gray-700">
                <div className="text-gray-400 text-[10px] mb-1">Recent Adjustments</div>
                <div className="space-y-0.5 max-h-16 overflow-y-auto">
                  {tpOptimizer.adjustmentHistory.slice(-3).reverse().map((adj, idx) => (
                    <div key={idx} className="text-[10px] text-gray-400 flex justify-between">
                      <span>{new Date(adj.timestamp).toLocaleTimeString()}</span>
                      <span className="text-cyan-400">{adj.tpMin?.toFixed(1)}%-{adj.tpMax?.toFixed(1)}%</span>
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
