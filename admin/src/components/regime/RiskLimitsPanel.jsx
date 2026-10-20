import React from 'react'

export default function RiskLimitsPanel({ quoteCurrency, risk, position, config, committedUsdc, asset, setDrawdownResumeConfirm }) {
  return (
    <>
      <div className="bg-gray-800 rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-gray-400">Risk Limits</h3>
          {risk.isDrawdownPaused && (
            <button
              onClick={() => setDrawdownResumeConfirm(true)}
              title={risk.equityDepleted ? 'Fund equity is depleted — the time-based auto-reset does not apply; resume manually once equity recovers.' : undefined}
              className="px-2 py-0.5 bg-green-800 hover:bg-green-900 text-white text-[10px] rounded-sm flex items-center gap-1"
            >
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></span>
              Resume
            </button>
          )}
        </div>
        {risk.isDrawdownPaused && risk.equityDepleted && (
          <div className="text-[9px] text-red-400 mb-2">
            Equity depleted (100% drawdown) — no auto-reset; requires manual resume once funded.
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center">
            <div className="text-[10px] text-gray-400 mb-1">{asset}</div>
            <div className="text-xs text-white font-mono">{position.totalAsset?.toFixed(4) || 0}</div>
            <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
              <div className="h-full bg-orange-500 transition-all" style={{ width: config?.maxAssetExposure ? `${Math.min(100, ((position.totalAsset || 0) / config.maxAssetExposure) * 100)}%` : '0%' }} />
            </div>
            <div className="text-[9px] text-gray-400">{config?.maxAssetExposure ? `/ ${config.maxAssetExposure}` : 'uncapped'}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-gray-400 mb-1">{quoteCurrency}</div>
            {(() => {
              const filled = position.totalCostBasis || 0
              const committed = committedUsdc || 0
              const total = filled + committed
              const max = config?.maxUsdcDeployed || 10000
              return <>
                <div className="text-xs text-white font-mono">${total.toFixed(0)}{committed > 0 && <span className="text-indigo-400 text-[9px]"> ({filled.toFixed(0)} + {committed.toFixed(0)} pending)</span>}</div>
                <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1 flex">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.min(100, (filled / max) * 100)}%` }} />
                  {committed > 0 && <div className="h-full bg-indigo-500 transition-all" style={{ width: `${Math.min(100 - (filled / max) * 100, (committed / max) * 100)}%` }} />}
                </div>
                <div className="text-[9px] text-gray-400">/ ${max}</div>
              </>
            })()}
          </div>
          {(() => {
            // Live fund drawdown from peak (risk manager); the persisted
            // worst-seen value is shown as a secondary label.
            const dd = risk.currentDrawdownPercent || 0
            const maxSeen = position.maxDrawdownSeen || 0
            const limit = config?.maxDrawdownPercent || 20
            return (
              <div className="text-center">
                <div className="text-[10px] text-gray-400 mb-1">Drawdown</div>
                <div className={`text-xs font-mono ${dd > limit * 0.8 ? 'text-yellow-400' : 'text-white'}`}>
                  {dd.toFixed(1)}%
                </div>
                <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                  <div className="h-full bg-red-500 transition-all" style={{ width: `${Math.min(100, (dd / limit) * 100)}%` }} />
                </div>
                <div className="text-[9px] text-gray-400">/ {limit}%{maxSeen > 0 ? ` · max ${maxSeen.toFixed(1)}%` : ''}</div>
              </div>
            )
          })()}
        </div>
      </div>
    </>
  )
}
