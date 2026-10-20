import React, { useState } from 'react'
import { formatPriceByMagnitude } from '../charts/chartUtils'
import { formatTimestamp } from './regimeFormat'
import RegimeActionModals from './RegimeActionModals'
import { describeActionFailure } from '../../utils/actionFailure.mjs'

export default function PlacementIntentsPanel({ placementIntents, asset, exchange, pairQuery, addToast, setSocketStatus, fetchStatus, fetchFills }) {
  // { intent, action: 'adopt'|'discard' } — operator reconcile of an unresolved placement intent
  const [intentConfirm, setIntentConfirm] = useState(null)
  const [reconcilingIntent, setReconcilingIntent] = useState(false)
  // Operator: reconcile an unresolved placement intent. Until one is resolved
  // the fund refuses every new placement (and keeps refusing across restarts),
  // because an order we never got an answer for may be resting live.
  const handleReconcileIntent = async () => {
    if (!intentConfirm) return
    const { intent, action } = intentConfirm
    setReconcilingIntent(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/reconcile-placement-intent${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: intent.id, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.success) {
        addToast({
          type: 'success',
          title: action === 'adopt' ? 'Order adopted' : 'Intent discarded',
          message: data.message || 'Placements resume for this fund',
        })
        if (data.status) setSocketStatus(data.status)
        fetchStatus()
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Reconcile failed', message: describeActionFailure(res.status, data) })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Reconcile failed', message: err.message })
    } finally {
      setReconcilingIntent(false)
      setIntentConfirm(null)
    }
  }
  return (
    <>
      {placementIntents.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 border border-amber-600/60">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-amber-400">
              Unresolved Placements ({placementIntents.length})
            </h3>
            <span className="text-xs text-gray-400">New orders are blocked until these are reconciled</span>
          </div>
          <div className="space-y-2">
            {placementIntents.map(intent => (
              <div key={intent.id} className="rounded-sm bg-gray-900/60 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-mono text-gray-200">
                    <span className={intent.needsAttention ? 'text-amber-400' : 'text-gray-400'}>
                      {intent.status === 'unresolved' ? 'UNRESOLVED' : 'DISPATCHING'}
                    </span>
                    {' · '}{intent.action || 'order'}{' · '}{intent.side || '?'}
                    {intent.size ? ` ${intent.size} ${asset}` : ''}
                    {intent.price ? ` @ ${formatPriceByMagnitude(intent.price)}` : ''}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIntentConfirm({ intent, action: 'adopt' })}
                      disabled={reconcilingIntent || !intent.clientOrderId}
                      title={intent.clientOrderId ? 'Look the order up on the exchange and adopt it into tracking' : 'No client order id was recorded — check the exchange manually, then discard'}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-sm transition-colors disabled:opacity-50"
                    >
                      Adopt
                    </button>
                    <button
                      type="button"
                      onClick={() => setIntentConfirm({ intent, action: 'discard' })}
                      disabled={reconcilingIntent}
                      className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded-sm transition-colors disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
                <div className="mt-2 text-gray-400">{intent.recoveryHint}</div>
                <div className="mt-1 text-gray-400 font-mono">
                  {intent.clientOrderId ? `client order ${intent.clientOrderId} · ` : ''}
                  {formatTimestamp(intent.createdAt)}
                  {intent.reason ? ` · ${intent.reason}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <RegimeActionModals
        intentConfirm={intentConfirm}
        reconcilingIntent={reconcilingIntent}
        onDismissIntent={() => setIntentConfirm(null)}
        onExecuteIntent={handleReconcileIntent}
      />
    </>
  )
}
