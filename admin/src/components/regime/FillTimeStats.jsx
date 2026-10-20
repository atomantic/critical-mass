import React from 'react'
import { plural } from '../../utils/plural.mjs'

export default function FillTimeStats({ fillTimeStats, effectiveStaleMs, orderStaleMs }) {
  return (
    <>
      {fillTimeStats?.count > 0 && (
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-gray-400">Fill Time Stats (7d)</h3>
            <span className="text-[10px] text-gray-400">
              {plural(fillTimeStats.count, "fill")}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-gray-400">Avg:</span>{' '}
                <span className="text-white font-mono">{(fillTimeStats.avgMs / 1000).toFixed(1)}s</span>
              </div>
              <div>
                <span className="text-gray-400">P50:</span>{' '}
                <span className="text-white font-mono">{(fillTimeStats.p50Ms / 1000).toFixed(1)}s</span>
              </div>
              <div>
                <span className="text-gray-400">P90:</span>{' '}
                <span className="text-yellow-400 font-mono">{(fillTimeStats.p90Ms / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <div className="flex justify-between text-[10px]">
              <span className="text-gray-400">
                Range: {(fillTimeStats.minMs / 1000).toFixed(1)}s - {(fillTimeStats.maxMs / 1000).toFixed(1)}s
              </span>
              <span className={fillTimeStats.staleRate > 10 ? 'text-red-400' : 'text-gray-400'}>
                Stale: {fillTimeStats.staleRate}%
              </span>
            </div>

            {effectiveStaleMs && (
              <div className="text-[10px] text-gray-400 pt-1 border-t border-gray-700">
                Timeout: {(effectiveStaleMs / 1000).toFixed(1)}s
                {effectiveStaleMs !== orderStaleMs && (
                  <span className="text-purple-400 ml-1">(regime-adjusted)</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
