import Button from '../ui/Button'
import React from 'react'

export default function BuysPausedBanner({ buysPaused, cycleBuys, maxCycleBuys, isRunning, isDrainingOrClosed, setResetCycleConfirm, resettingCycle }) {
  return (
    <>
      {buysPaused && (
        <div className="bg-yellow-900/40 border border-yellow-600/60 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-yellow-400 text-xl">⚠</span>
            <div>
              <div className="text-yellow-300 font-medium text-sm">
                New buys paused — cycle buy-limit reached ({cycleBuys}/{maxCycleBuys})
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                The bot will not open new buys until a take-profit closes the cycle. Existing take-profit orders remain active.
              </div>
            </div>
          </div>
          {isRunning && !isDrainingOrClosed && (
            <Button
              onClick={() => setResetCycleConfirm(true)}
              disabled={resettingCycle}
              variant="warning" size="compact-xs" className="shrink-0 font-medium"
            >
              {resettingCycle ? 'Resetting…' : 'Reset cycle & resume buying'}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
