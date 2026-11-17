import Button from '../ui/Button'
import React, { useState } from 'react'
import { formatPriceByMagnitude } from '../charts/chartUtils'
import { formatTimestamp } from './regimeFormat'
import ConfirmDialog from '../ui/ConfirmDialog'
import { describeActionFailure } from '../../utils/actionFailure.mjs'
import { apiPost } from '../../utils/apiClient'

export default function PlacementIntentsPanel({ placementIntents, asset, exchange, pairQuery, addToast, fetchStatus, fetchFills }) {
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
      const result = await apiPost(`/api/${exchange}/regime/reconcile-placement-intent${pairQuery}`, { intentId: intent.id, action })
      if (result.status === 0) throw new Error(result.error || 'Network error')
      const data = result.data ?? {}
      if (result.ok && data.success) {
        addToast({
          type: 'success',
          title: action === 'adopt' ? 'Order adopted' : 'Intent discarded',
          message: data.message || 'Placements resume for this fund',
        })
        fetchStatus()
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Reconcile failed', message: result.error || describeActionFailure(result.status, data) })
        if (data.status) fetchStatus()
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
                    <Button
                      type="button"
                      onClick={() => setIntentConfirm({ intent, action: 'adopt' })}
                      disabled={reconcilingIntent || !intent.clientOrderId}
                      title={intent.clientOrderId ? 'Look the order up on the exchange and adopt it into tracking' : 'No client order id was recorded — check the exchange manually, then discard'}
                      variant="primary" size="xs"
                    >
                      Adopt
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setIntentConfirm({ intent, action: 'discard' })}
                      disabled={reconcilingIntent}
                      variant="caution" size="xs"
                    >
                      Discard
                    </Button>
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
      {intentConfirm && (
        <ConfirmDialog
          id="reconcile-intent"
          title={intentConfirm.action === 'adopt' ? 'Adopt the exchange order' : 'Discard the placement intent'}
          description={intentConfirm.action === 'adopt'
            ? 'Looks this placement up on the exchange by its client order id and, only if a live or filled order comes back, brings it under normal tracking. Nothing is adopted on an empty or failed lookup.'
            : 'Clears the record so this fund can place orders again. Do this only once you have checked the exchange yourself and confirmed no order from this placement is live — a duplicate would trade against the same capital twice.'}
          confirmLabel={intentConfirm.action === 'adopt' ? 'Look up & adopt' : 'Discard intent'}
          busyLabel="Working…"
          confirmVariant={intentConfirm.action === 'adopt' ? 'primary' : 'caution'}
          busy={reconcilingIntent}
          onClose={() => setIntentConfirm(null)}
          onConfirm={handleReconcileIntent}
        >
          <p className="text-gray-400 text-xs mb-4 font-mono break-all">
            {intentConfirm.intent?.action || 'order'} · {intentConfirm.intent?.side || '?'}
            {intentConfirm.intent?.clientOrderId ? ` · client order ${intentConfirm.intent.clientOrderId}` : ' · no client order id recorded'}
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
