import Button from '../ui/Button'
import React from 'react'

export default function EmptyRegimeState({ isDryRun, dcaState, dcaStateError, retryDcaState, handlePreviewConvert }) {
  return (
    <>
      <div className="bg-gray-800 rounded-lg p-8 text-center">
        <div className="text-gray-400">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <p className="text-lg">Regime Engine is not running</p>
          <p className="text-sm text-gray-400 mt-2">
            The regime engine uses volatility-driven entries instead of fixed intervals.
            {isDryRun ? (
              <span className="block mt-1 text-purple-400">
                Dry-run mode is enabled - trades will be simulated against live data.
              </span>
            ) : (
              ' Click Start in the header to begin adaptive trading.'
            )}
          </p>
          {dcaStateError && (
            <p role="alert" className="mt-4 text-sm text-red-400">
              Could not check for DCA orders to upgrade: {dcaStateError}{' '}
              <Button type="button" onClick={retryDcaState} variant="secondary" size="xs" className="ml-1">Retry</Button>
            </p>
          )}
          {dcaState?.orders?.some(o => o.status === 'pending') && (
            <Button
              variant="primary" size="lg" className="mt-4 font-medium"
              onClick={handlePreviewConvert}
            >
              Upgrade DCA Orders to Regime Engine
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
