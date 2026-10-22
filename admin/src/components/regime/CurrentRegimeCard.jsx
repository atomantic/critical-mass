import React from 'react'
import { ConfigTooltip, REGIME_TOOLTIPS } from './RegimeHelp'
import { REGIME_COLORS, HEALTH_COLORS, MACRO_COLORS, SUGGESTED_LEVEL_STYLES } from './regimeStyles'

export default function CurrentRegimeCard({ regime, healthMode, macroEnabled, macro }) {
  const regimeStyle = REGIME_COLORS[regime.mode] || REGIME_COLORS.HARVEST
  const healthStyle = HEALTH_COLORS[healthMode] || HEALTH_COLORS.ACTIVE
  return (
    <>
      <div className={`col-span-1 ${regimeStyle.bg} border ${regimeStyle.border} rounded-sm p-1.5`}>
        <div className="flex items-center justify-between">
          <span className="text-2xs text-gray-400">
            Regime<ConfigTooltip tip={REGIME_TOOLTIPS.micro} align="left" width="w-80" />
          </span>
          <span className={`${healthStyle.bg} ${healthStyle.text} px-1 py-0.5 rounded-sm text-2xs`}>
            {healthMode || 'ACTIVE'}
          </span>
        </div>
        <div className={`text-xl font-bold ${regimeStyle.text}`}>
          {regime.mode || 'HARVEST'}
        </div>
        {macroEnabled && macro ? (() => {
          const macroStyle = MACRO_COLORS[macro.mode] || MACRO_COLORS.RANGING
          const lt = macro.longTermBias
          const ltStyle = lt?.ready ? SUGGESTED_LEVEL_STYLES[lt.suggestedLevel] : null
          return (
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              <span className={`px-1 py-0.5 rounded-sm text-2xs ${macroStyle.bg} border ${macroStyle.border} ${macroStyle.text}`}>
                {macroStyle.label}
              </span>
              <span className="text-2xs text-gray-400">{macro.score?.toFixed(0)}</span>
              {ltStyle && (
                <span
                  className={`px-1 py-0.5 rounded-sm text-2xs ${ltStyle.bg} border ${ltStyle.border} ${ltStyle.text}`}
                  title={`Long-term bias: ${(lt.score * 100).toFixed(0)}/100 — suggests ${ltStyle.label}`}
                >
                  🤖 {ltStyle.label}
                </span>
              )}
            </div>
          )
        })() : (
          <div className="text-2xs text-gray-400">
            Since {regime.since ? new Date(regime.since).toLocaleTimeString() : '-'}
          </div>
        )}
      </div>
    </>
  )
}
