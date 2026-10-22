import React from 'react'
import { ConfigTooltip, REGIME_TOOLTIPS } from './RegimeHelp'
import { formatPriceByMagnitude } from '../charts/chartUtils'
import { MACRO_COLORS } from './regimeStyles'

export default function MacroRegimePanel({ config, macro }) {
  return (
    <>
      {config?.macroEnabled && macro && (() => {
        const m = macro
        const macroStyle = MACRO_COLORS[m.mode] || MACRO_COLORS.RANGING
        const mults = (() => {
          switch (m.mode) {
            case 'ACCUMULATION': return { size: config.macroAccumulationSizeMult || 1.3, tp: config.macroAccumulationTpMult || 0.85, offset: config.macroAccumulationOffsetMult || 0.8 }
            case 'MARKUP': return { size: config.macroMarkupSizeMult || 0.7, tp: config.macroMarkupTpMult || 1.3, offset: config.macroMarkupOffsetMult || 1.2 }
            case 'DECLINE': return { size: config.macroDeclineSizeMult || 0.4, tp: config.macroDeclineTpMult || 0.7, offset: config.macroDeclineOffsetMult || 1.5 }
            default: return { size: 1.0, tp: 1.0, offset: 1.0 }
          }
        })()
        return (
          <div className={`bg-gray-800 rounded-lg p-3 border ${macroStyle.border}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-gray-400">
                Macro Regime<ConfigTooltip tip={REGIME_TOOLTIPS.macro} align="left" width="w-80" />
              </h3>
              <span className={`px-1.5 py-0.5 rounded-sm text-2xs font-medium ${macroStyle.bg} ${macroStyle.text}`}>
                {macroStyle.label} ({m.score?.toFixed(0)})
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-400">21h EMA</span>
                <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h21)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">50h EMA</span>
                <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h50)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">200h EMA</span>
                <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h200)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">20d EMA</span>
                <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.d20)}</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-gray-700">
              <div className="text-center">
                <div className="text-2xs text-gray-400">Size</div>
                <div className={`text-xs font-mono ${mults.size !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.size}x</div>
              </div>
              <div className="text-center">
                <div className="text-2xs text-gray-400">TP</div>
                <div className={`text-xs font-mono ${mults.tp !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.tp}x</div>
              </div>
              <div className="text-center">
                <div className="text-2xs text-gray-400">Offset</div>
                <div className={`text-xs font-mono ${mults.offset !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.offset}x</div>
              </div>
            </div>
            <div className="text-2xs text-gray-400 mt-1">
              Updated {m.lastUpdate ? new Date(m.lastUpdate).toLocaleTimeString() : 'never'} | {m.candles?.hourly || 0}h/{m.candles?.daily || 0}d candles
            </div>
          </div>
        )
      })()}
    </>
  )
}
