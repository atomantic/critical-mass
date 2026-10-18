import React from 'react'

export default function StoppedBanner({ isRunning, lastPrice, totalAsset, engineDown, stale }) {
  return (
    <>
      {!isRunning && (lastPrice > 0 || totalAsset > 0) && (
        engineDown ? (
          <div className="bg-orange-900/30 border border-orange-700/50 rounded-lg px-4 py-2 flex items-center gap-3">
            <span className="text-orange-400 text-lg">⚠</span>
            <div>
              <span className="text-orange-300 font-medium text-sm">Engine Unreachable</span>
              <span className="text-gray-400 text-xs ml-2">
                Showing last known state from disk{stale ? ' · prices may be stale' : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-2 flex items-center gap-3">
            <span className="text-red-400 text-lg">■</span>
            <div>
              <span className="text-red-300 font-medium text-sm">Engine Stopped</span>
              <span className="text-gray-400 text-xs ml-2">Live market data streaming &middot; no trading</span>
            </div>
          </div>
        )
      )}
    </>
  )
}
