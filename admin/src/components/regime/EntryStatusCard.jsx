import React from 'react'
import { ConfigTooltip, REGIME_TOOLTIPS } from './RegimeHelp'

export default function EntryStatusCard({ healthMode, regimeMode, celestial, macroEnabled, maxCelestialBodies, macro }) {
  return (
    <>
      <div className="col-span-1">
        <div className="bg-gray-900 rounded-sm p-1.5 h-full">
          <div className="text-[10px] text-gray-400 mb-0.5">
            Entry Status<ConfigTooltip tip={REGIME_TOOLTIPS.entryStatus} align="left" width="w-72" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${healthMode === 'ACTIVE' ? 'bg-green-400' : 'bg-yellow-400'}`} />
              <span className="text-xs">{healthMode === 'ACTIVE' ? 'Ready' : healthMode}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${regimeMode === 'TREND' ? 'bg-red-400' : 'bg-green-400'}`} />
              <span className="text-xs text-gray-400">
                {regimeMode === 'TREND' ? 'Blocked' : 'Allowed'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${celestial?.enabled ? 'bg-purple-400' : 'bg-gray-600'}`} />
              <span className="text-xs text-gray-400">
                {celestial?.enabled ? (celestial.tierSummary || `${celestial.bodiesActive || 0}/${maxCelestialBodies || 10}`) : 'Off'}
              </span>
            </div>
            {macroEnabled && macro && (
              <div className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  macro.mode === 'ACCUMULATION' ? 'bg-blue-400' :
                  macro.mode === 'MARKUP' ? 'bg-green-400' :
                  macro.mode === 'DECLINE' ? 'bg-red-400' : 'bg-gray-500'
                }`} />
                <span className="text-xs text-gray-400">
                  Macro {macro.mode?.slice(0, 3)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
