import React from 'react'
import { formatDuration } from './regimeFormat'

export default function HistoricalAnalytics({ optimalTpAnalytics, tpMinPercent, tpMaxPercent }) {
  return (
    <>
      {optimalTpAnalytics.cycleCount > 0 ? (
        <>
          <div className="space-y-1 text-2xs">
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Optimal TP</span>
              <span className="text-cyan-400 font-mono font-semibold">
                {optimalTpAnalytics.avgOptimalTpPct?.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Actual TP</span>
              <span className="text-white font-mono">
                {optimalTpAnalytics.avgActualTpPct?.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Missed Profit</span>
              <span className={`font-mono ${optimalTpAnalytics.avgMissedProfitPct > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                {optimalTpAnalytics.avgMissedProfitPct?.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Time to Peak</span>
              <span className="text-gray-300 font-mono">
                {formatDuration(optimalTpAnalytics.avgTimeToMaxMs)}
              </span>
            </div>
          </div>

          {/* Recommended Range */}
          {optimalTpAnalytics.recommendedTpRange && (
            <div className="mt-2 pt-2 border-t border-gray-700">
              <div className="text-2xs text-gray-400 mb-1">Recommended TP Range</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-gray-700 rounded-full relative overflow-hidden">
                  {/* Current config range indicator */}
                  <div
                    className="absolute h-full bg-blue-600/50"
                    style={{
                      left: `${Math.min(100, (tpMinPercent || 0) / 5 * 100)}%`,
                      width: `${Math.min(100, ((tpMaxPercent || 5) - (tpMinPercent || 0)) / 5 * 100)}%`,
                    }}
                  />
                  {/* Observed range */}
                  <div
                    className="absolute h-full bg-cyan-500/70"
                    style={{
                      left: `${Math.min(100, (optimalTpAnalytics.recommendedTpRange.min || 0) / 5 * 100)}%`,
                      width: `${Math.min(100, ((optimalTpAnalytics.recommendedTpRange.max || 0) - (optimalTpAnalytics.recommendedTpRange.min || 0)) / 5 * 100)}%`,
                    }}
                  />
                  {/* Median marker */}
                  <div
                    className="absolute w-0.5 h-full bg-white"
                    style={{
                      left: `${Math.min(100, (optimalTpAnalytics.recommendedTpRange.median || 0) / 5 * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-between text-2xs mt-1">
                <span className="text-gray-400">0%</span>
                <span className="text-cyan-400">
                  {optimalTpAnalytics.recommendedTpRange.min?.toFixed(1)}% - {optimalTpAnalytics.recommendedTpRange.max?.toFixed(1)}%
                </span>
                <span className="text-gray-400">5%</span>
              </div>
              <div className="flex justify-between text-2xs text-gray-400 mt-0.5">
                <span>Config: {tpMinPercent?.toFixed(4)}%-{tpMaxPercent?.toFixed(4)}%</span>
                <span className="text-blue-400">|</span>
                <span>Observed</span>
                <span className="text-cyan-400">|</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-400 text-2xs text-center py-2">
          Complete at least one cycle to see analytics
        </div>
      )}
    </>
  )
}
