import React from 'react'
import { plural } from '../../utils/plural.mjs'
import { ConfigTooltip, REGIME_TOOLTIPS } from './RegimeHelp'

export default function EntryModeCard({ entryMode, ladder, autoSwitch, ladderAutoSwitch }) {
  return (
    <>
      <div className={`col-span-1 ${entryMode === 'ladder' ? 'bg-indigo-900/30 border-indigo-700/50' : 'bg-gray-800 border-gray-700'} border rounded-sm p-1.5`}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-400">
            Entry<ConfigTooltip tip={REGIME_TOOLTIPS.entryMode} align="right" width="w-72" />
          </span>
          {ladderAutoSwitch && (
            <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-[10px] rounded-sm">Auto</span>
          )}
        </div>
        <div className={`text-xl font-bold ${entryMode === 'ladder' ? 'text-indigo-400' : 'text-gray-300'}`}>
          {entryMode === 'ladder' ? 'LADDER' : 'REACTIVE'}
        </div>
        <div className="text-[10px] text-gray-400">
          {ladder?.active
            ? `${plural(ladder.pendingOrders, "order")} ($${ladder.committedUsdc?.toFixed(0) || 0})`
            : entryMode === 'ladder' ? 'Waiting for trigger' : 'Single order mode'}
        </div>
        {autoSwitch && (
          <div className="text-[10px] text-gray-400 mt-0.5">
            Vol: <span className={autoSwitch.volExpansion >= autoSwitch.threshold ? 'text-purple-400' : 'text-gray-400'}>{autoSwitch.volExpansion}x</span>
            <span className="text-gray-400"> / {autoSwitch.threshold}x</span>
          </div>
        )}
      </div>
    </>
  )
}
