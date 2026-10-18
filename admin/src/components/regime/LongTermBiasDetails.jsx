import React from 'react'

export default function LongTermBiasDetails({ c, bias, coveragePct }) {
  return (
    <>
      {/* Component breakdown */}
      <div className="space-y-1 text-[10px]">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Percentile of range ({(c.percentile?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">{((c.percentile?.score || 0) * 100).toFixed(0)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Drawdown from high ({(c.drawdown?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">
            {((c.drawdown?.score || 0) * 100).toFixed(0)}
            <span className="text-gray-400 ml-1">(-{(c.drawdown?.drawdownPct || 0).toFixed(1)}%)</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Z-score vs mean ({(c.zscore?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">
            {((c.zscore?.score || 0) * 100).toFixed(0)}
            <span className="text-gray-400 ml-1">(σ {(c.zscore?.zscore || 0).toFixed(2)})</span>
          </span>
        </div>
      </div>

      <div className="text-[10px] text-gray-400 mt-2 pt-2 border-t border-gray-700 flex items-center justify-between">
        <span>
          {bias.sampleSize || 0} / {bias.cache?.lookbackDays || 0}d
          <span className="text-gray-400 ml-1">({coveragePct.toFixed(0)}%)</span>
        </span>
        {bias.cache?.lastRefresh && (
          <span>refreshed {new Date(bias.cache.lastRefresh).toLocaleTimeString()}</span>
        )}
      </div>
    </>
  )
}
